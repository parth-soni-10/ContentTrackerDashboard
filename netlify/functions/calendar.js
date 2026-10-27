// Release Calendar data service.
//
// Two structured APIs — nothing is scraped out of HTML, and no new credentials
// are needed: the films come from TMDB through the same TMDB_API_KEY
// tmdb-search.js already uses, and the episodes come from TVmaze, which is a
// free public API with no key at all.
//
// Why two sources instead of the one we already had:
//   * Movies — TMDB /discover/movie, filtered to a release-date window in a
//     single region. TMDB is the only one of our sources that knows about a
//     film before it comes out, and its discover endpoint is the only free,
//     filterable release calendar of its kind.
//   * Episodes — TMDB cannot serve a calendar of episodes: /discover/tv's
//     air_date filter answers with SHOWS that have an episode in the window,
//     and getting the actual dates would mean one request per show (hundreds).
//     TVmaze's /schedule/full returns the last couple of days and every future
//     episode it knows about in a single 3.3 MB response. Note it must be that
//     endpoint: the plain /schedule one "will only return episodes that are tied
//     to a specific country… Episodes from global Web Channels like Netflix are
//     not included", which is exactly the half a release calendar is for. The
//     one thing /schedule/full cannot do is reach back to the start of the
//     current month, so the days it misses are fetched a day at a time — the
//     same two halves — which is what makes a month that is already running
//     open on its whole self (see backfillDays).
//
// Both halves fail independently: if one source is down the other still
// renders and the response carries a warning the page shows.
//
// Third rule, and the one that decides what the page contains: a film or an
// episode is fetched only if it is on one of the platforms the Sheet logs
// against (see PLATFORMS) — or, for a film, released in a cinema, which the
// watchlist calls "Theater". The filter lives here at the fetch boundary, so the
// rest of the app never sees a title that is not watchable on those services.
//
// The key is read per request and the warning names the environment it was
// missing from, because "already configured" and "configured here" are
// different statements: a key scoped to production is absent from a deploy
// preview, and a local function runner (netlify dev, or a static server with
// its own function host) has no Netlify environment at all.
const { TMDB_BASE: TMDB_API_BASE, pickMatch } = require('./lib/tmdb');
const { createWatchmode, releaseFilm, serviceFilms } = require('./lib/watchmode');
const db = require('./lib/db');

const TMDB_BASE = TMDB_API_BASE;
const TVMAZE_BASE = 'https://api.tvmaze.com';
const IMG_BASE = 'https://image.tmdb.org/t/p/w185';
const TIMEOUT_MS = 6500; // per upstream request
const MAX_DAYS = 400; // a whole year of window, plus slack for a 366-day one
const DATED_DAYS = 100; // windows up to this long are fetched to the day
const MAX_DATED_PAGES = 25; // 20 a page → 500 theatrical releases, the hard cap
const YEAR_PAGES = 3; // 60 by popularity: a year at a glance, not a full dump
const BATCH = 5; // concurrent TMDB requests
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// ISO 3166-1 alpha-2, officially assigned codes. Two letters is not a region:
// ZZ, XX and QQ all satisfied the old /^[A-Z]{2}$/ test, and each one bought a
// full cinema sweep of a country that does not exist — plus a CDN cache entry —
// instead of the documented fallback to US. This is the standard's own list, not
// a copy of the page's picker (that one is the page's to define, and it is what a
// union is asked for); a caller may legitimately name a region the dropdown does
// not offer.
const ISO_REGIONS = new Set((
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ ' +
  'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG EH ER ES ET ' +
  'FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY ' +
  'HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY ' +
  'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
  'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY ' +
  'QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ ' +
  'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ ' +
  'VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' '));
const isRegion = code => ISO_REGIONS.has(code);

// ── THE STREAMING HALF ────────────────────────────────────────────────────
// Watchmode owns the one class of release nothing else here can see: a film
// that arrives on a service with no cinema run *and* with no TMDB
// watch-provider tag. "YOU ME US" (Netflix, 29 Oct 2026) is the measured
// case — TMDB has it as a type-4 digital release and lists no watch provider
// for it in any region, so no provider-filtered query can return it, and
// TVmaze is episodes-only. What Watchmode has is the *feed* the calendar was
// missing: what landed on a service, on which service, and on what date.
//
// What it costs: one credit a request (2,500 a month on the free plan, 120
// requests a minute), so the budget below is what one invocation may spend,
// and the answers that do not change are cached in D1 (see lib/db.js) — which
// is what makes the second load of a month free.
//
// The feed's dates are US-first — the endpoint documents them as "primarily US
// release dates, though most major services release globally on the same day"
// — so it dates the US. Another region gets its platforms from TMDB's own
// provider sweeps, which are region-aware.
const WM_CALL_BUDGET = 8; // Watchmode requests — one credit each
const WM_DETAIL_BUDGET = 10; // TMDB records fetched for the films only the feed knows
const WM_BUDGET_MS = 6000; // the wall clock the feed and the records share
// How many pages one platform's sweep may walk. A window that is short
// enough to be listed to the day is walked in release-date order, which is
// what makes it complete; a popularity page is a ranking, not an index, and
// it loses films (measured on the US October 2026 window: 28 of the 34 films
// on the watchlist's platforms arrived, 6 did not).
const MAX_SWEEP_PAGES = 6;

// ── ONE REGION, OR ALL OF THEM ───────────────────────────────────────────
// `region=all` is the union of the regions the page's picker offers, which the
// page names in `regions` — that dropdown is the one place the list is defined,
// so the function unions exactly what it was asked for rather than keeping a
// second copy that could drift from it. TMDB has no all-regions query (region is
// one ISO country per request), so a union is one pass per region merged here.
const ALL_REGIONS = 'all';
const MAX_UNION_REGIONS = 30;
// What one invocation may spend. A single region never comes close (a busy month
// is ~23 upstream calls); a union of every region is ~250, so it is the one
// shape that needs a budget, and past it the regions that did not get their turn
// are named in a warning instead of the request being killed with nothing to
// show. Concurrency stays under TMDB's documented ~40 requests/second ceiling.
//
// The second budget is a count, and on the free plan it is the binding one: one
// invocation may only make 50 external subrequests and the limit cannot be
// raised there. The page fans its union out itself now — one movies request per
// region plus an episodes request — so a single region's films must stay well
// under 50 on their own. Past TMDB_CALL_BUDGET no new TMDB work starts and the
// region lands in the partial/cut report below, instead of the tail of the
// request arriving as a per-provider "Too many subrequests" warning.
//
// 30, not 40: a movies request also carries the release feed (up to WM_CALL_BUDGET
// credits) and the TMDB records the films it found need (WM_DETAIL_BUDGET), and
// those are subrequests of the *same* invocation. Spending 40 on sweeps left the
// tail of the feed at the platform's ceiling — measured on the live October
// window, three provider sweeps and the feed's own releases call came back "Too
// many subrequests", so the streaming half of the calendar arrived empty. The
// feed is the half nothing else can replace, so the sweeps give it the room.
const REGION_BUDGET_MS = 20000;
const UNION_BUDGET_MS = 9000;
const TMDB_CALL_BUDGET = 30;
// The platform's own ceiling on one invocation's external subrequests, counted
// across every source in it — TMDB, the release feed, and the records the
// feed's own films need. Past it the request is killed with nothing to show,
// so each source stops before it rather than being cut off in it.
const SUBREQUEST_CAP = 50;
// What the release feed leaves for the rest of the invocation: the TMDB
// records the films it found need, and the episode half that runs beside it.
const WM_SUBREQUEST_RESERVE = 14;
// How many regions are worked on at once. The ceiling that matters is the total
// in-flight upstream requests — this times BATCH, the fan-out inside one region —
// because TMDB's documented upper limit is "somewhere in the 40 requests per
// second range" and at these latencies three regions is already ~15 requests at
// a time. Asking for more only buys 429s, which arrive as missing platform lists.
const UNION_BATCH = 3;
function requestedRegions(params) {
  const raw = String(params.region || '').trim().toUpperCase();
  if (raw !== ALL_REGIONS.toUpperCase()) return [isRegion(raw) ? raw : 'US'];
  const list = String(params.regions || '').split(',')
    .map(code => code.trim().toUpperCase())
    .filter((code, index, all) => isRegion(code) && all.indexOf(code) === index)
    .slice(0, MAX_UNION_REGIONS);
  return list.length ? list : ['US'];
}

// ── THE PLATFORMS THIS CALENDAR IS FOR ───────────────────────────────────
// The calendar fetches from these platforms and nothing else — the list is the
// watchlist's own platform vocabulary, which is what makes the page agree with
// what gets logged. It is applied at the fetch boundary rather than in the page,
// so the data that is dropped is never sent, never counted and never selectable:
// a month here is what can actually be watched, not what exists.
//
// YouTube is deliberately absent: nothing in the store logs it, so its shows are
// web-channel content rather than anything watchable here, and it was the single
// biggest source of episodes that were never going to be watched (86 of a
// month's 675, from 36 channels like Hot Ones and Talk Ville). Dropping the name
// is the whole change — it is matched at the fetch boundary like any other
// platform, so those episodes and any film only on YouTube stop arriving.
//
// "Other" is not a service: it is how the watchlist logs a title that had no
// platform, and it is also what the episode source reports when a show has no
// network at all — so it is matched like any other spelling. "Theater" is not a
// service either, so it is deliberately absent here: a cinema release is a
// property of the film (its theatrical release date), and it is added to the
// film's platforms below as that label.
const PLATFORMS = [
  'Amazon Prime Video',
  'Angel Studios',
  'Apple TV+',
  'CBS',
  'CineMember',
  'Disney+',
  'Eurosport',
  'HBO Max',
  'Hulu',
  'JioCinema',
  'Lionsgate+ Amazon Channels',
  'Netflix',
  'OSN+',
  'Other',
  'Paramount+',
  'Peacock',
  'Sony Liv',
  'Universal+ Amazon Channel',
];
// The other spellings the two APIs use for the same platform. Comparing names
// with their punctuation and casing removed ('Apple TV+' and 'Apple TV Plus' are
// one string without it) leaves only the genuine rewordings to list here: TMDB
// says "Prime Video" where the Sheet says "Amazon Prime Video", and "Max" where
// the Sheet still says "HBO Max".
const PLATFORM_SPELLINGS = {
  'Amazon Prime Video': ['Prime Video'],
  // CBS is the one platform here that is a *network* the watchlist logs and also a
  // regional service the API lists, so it is the one name TMDB may qualify by
  // country — paired rather than left to look like a second service, which would
  // drop every film on it at the fetch boundary. Comparing without punctuation
  // means this one spelling covers both "CBS US" and "CBS (US)".
  'CBS': ['CBS US'],
  'Apple TV+': ['Apple TV Plus', 'Apple TV'],
  'Disney+': ['Disney Plus'],
  'Eurosport': ['Eurosport 1', 'Eurosport 2'],
  'HBO Max': ['Max', 'HBO'],
  'JioCinema': ['JioHotstar', 'Jio Hotstar', 'Hotstar'],
  'Lionsgate+ Amazon Channels': ['Lionsgate+', 'Lionsgate Plus', 'Lionsgate Play'],
  'Paramount+': ['Paramount Plus'],
  'Peacock': ['Peacock Premium', 'Peacock Plus'],
  'Universal+ Amazon Channel': ['Universal+', 'Universal Plus', 'Universal+ Amazon Channel'],
};
const IMDB_TITLE = 'https://www.imdb.com/title/';
// The episode source writes the id with its own "tt" prefix ("tt35826715"), and a
// bare number is accepted too because that is how the same id is spelled
// elsewhere — prefixing one that already carries it builds "tttt…", which is a
// 404 on IMDb rather than a link.
const imdbIdOf = value => {
  const text = String(value || '').trim().replace(/^tt/i, '');
  return /^\d+$/.test(text) ? 'tt' + text : '';
};
const imdbUrl = value => {
  const id = imdbIdOf(value);
  return id ? IMDB_TITLE + id + '/' : null;
};
const platformKey = name => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const PLATFORM_INDEX = (() => {
  const index = new Map();
  PLATFORMS.forEach(name => index.set(platformKey(name), name));
  Object.keys(PLATFORM_SPELLINGS).forEach(name =>
    PLATFORM_SPELLINGS[name].forEach(spelling => {
      const key = platformKey(spelling);
      if (key && !index.has(key)) index.set(key, name);
    })
  );
  return index;
})();
// The Sheet's spelling of a platform the APIs named differently, or '' for a
// platform that is not on the list — which is the whole filter.
const platformFor = name => PLATFORM_INDEX.get(platformKey(name)) || '';
const THEATER = 'Theater';

// ── TITLES THIS CALENDAR DOES NOT CARRY ───────────────────────────────────
// League and promotion entries — a wrestling card, a basketball or football
// game — are the one thing here that is not a *release* to plan around: they air
// several nights a week all year, they run for hours, and nobody picks them off
// a calendar. They are matched on the show's name, at the fetch boundary like
// the platform filter, so an excluded title is never sent, never counted and
// never offered in a filter.
//
// Deliberately a list of names and not a "sports" rule: the episode source's own
// genre for this is unusable — it tags quiz and game shows as Sports, so a rule
// on it would swallow "Alle mot alle" and "The Traitors Telugu" along with the
// league. A sports *documentary* is a real release too, which is the second
// reason this is a short explicit list. Word boundaries, so a title that merely
// contains the letters is untouched.
//
// The four below are the leagues in this watchlist's own calendar today. A fifth
// (NHL, MLB, UFC, WNBA, Formula 1 …) is one line here, and an entry can be any
// pattern when a name does not fit the acronym — "Thursday Night Football on
// Prime Video" and "All Elite Wrestling PPV" are league property under a name
// no acronym catches.
const EXCLUDED_TITLES = [
  /\bWWE\b/i,   // wrestling: Raw, SmackDown, NXT, the premium live events
  /\bNBA\b/i,   // basketball: games and the studio shows
  /\bNFL\b/i,   // football: the Sunday and Monday packages
  /\bAEW\b/i,   // wrestling: Dynamite, Collision, the pay-per-views
];
const isExcludedTitle = title => EXCLUDED_TITLES.some(pattern => pattern.test(String(title || '')));

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

// Where this invocation actually ran. Netlify set CONTEXT for every deploy
// (production / deploy-preview / branch-deploy / dev); Cloudflare Pages, where
// this runs now, sets CF_PAGES_BRANCH instead and never CONTEXT — so reading
// only the Netlify name made this say "local run" on every deployed invocation,
// which is what the warning below quotes back to the page. Both names are read,
// the richer one first; a bare local runner sets neither, and that absence is
// itself the diagnosis.
function runContext() {
  const context = String(process.env.CONTEXT || '').trim();
  const branch = String(process.env.BRANCH || process.env.CF_PAGES_BRANCH || '').trim().slice(0, 60);
  if (context) return context === 'branch-deploy' && branch ? context + ' on ' + branch : context;
  if (process.env.CF_PAGES) return branch ? 'Cloudflare Pages on ' + branch : 'Cloudflare Pages';
  return 'no deploy context — local run';
}

// How much of TMDB to ask for, decided by the window itself. The theatre half is
// one query — 2|3 — and a month of it is a small, finite list that can be walked
// in release-date order until the window runs out. A year cannot be listed to the
// day at all (date-ordered pages of a year only reach its first weeks), so a long
// window takes the same release types ordered by popularity instead: the cinema
// releases anyone will hear about, in three requests. That is what the page's
// year-at-a-glance view is for. The streaming half is not a query shape at all
// any more: it is one sweep per platform on the list (see loadMovies), so a film
// arrives here because it is on a service the Sheet uses, not because it is
// digital.
function moviePlan(days) {
  if (days <= DATED_DAYS) {
    return { theater: { sort: 'release_date.asc', types: THEATRICAL_TYPES, pages: MAX_DATED_PAGES } };
  }
  return { theater: { sort: 'popularity.desc', types: THEATRICAL_TYPES, pages: YEAR_PAGES } };
}

function spanDays(from, to) {
  return Math.max(1, Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1);
}

function addDays(iso, days) {
  const date = new Date(iso + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// One line per problem. A failing key or an unreachable source fails every
// request in the batch, and the page joins its warnings into a single banner —
// eight copies of "HTTP 401" is noise, not information.
function warn(warnings, text) {
  if (!warnings.includes(text)) warnings.push(text);
}

// A bounded fetch: every upstream call gets its own deadline so one slow source
// can't push the whole function past the platform's request timeout. A 429 or a
// 5xx is retried once after a short pause — both sources shed load that way —
// but a call that failed for lack of subrequests never is: another call only
// spends more of what ran out. TMDB 404s are expected (a title not in TMDB)
// and are not warnings — they are silently dropped so they don't surface as
// "Partially loaded" noise to the user.
async function fetchJSON(url, warnings, label) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok && attempt === 0 && (response.status === 429 || response.status === 502 || response.status === 503)) {
        clearTimeout(timer);
        await new Promise(resolve => setTimeout(resolve, 350));
        continue;
      }
      if (!response.ok) {
        // TMDB 404 is normal (title not found) — don't warn, just return null.
        if (response.status === 404) return null;
        throw new Error('HTTP ' + response.status);
      }
      return await response.json();
    } catch (error) {
      warn(warnings, label + ' · ' + (error && error.message ? error.message : 'request failed'));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

// One TMDB call outside a region's own budget: counted against the same
// invocation-wide total, and refused outright once the wall clock has run out
// of the time the platform allows.
async function tmdbJSON(url, warnings, label, usage, deadline) {
  if (usage) {
    // The shared subrequest count: past the platform's cap the invocation is
    // killed, so the work stops before it instead of being lost with it.
    if (usage.limit && (usage.total || 0) >= usage.limit) {
      warn(warnings, label + ' · the request budget was spent');
      return null;
    }
    usage.tmdb++;
    usage.total = (usage.total || 0) + 1;
  }
  if (deadline && Date.now() > deadline) return null;
  return fetchJSON(url, warnings, label);
}

const round1 = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0;
};

// ── MOVIES ────────────────────────────────────────────────────────────────
// Release types: 2 (limited theatrical), 3 (theatrical), 4 (digital), 6 (TV).
// Leaving out 4 would hide every straight-to-streaming release, which is most of
// what arrives on a service without a cinema run — so they are all here, just
// asked for in two passes (see moviePlan). The order inside each pair decides
// which date TMDB reports back for a title that has both, and earliest-first is
// what a calendar means by "when it arrives".
const RELEASE_TYPES = '2|3|4|6';
const THEATRICAL_TYPES = '2|3';

function tmdbUrl(path, params) {
  const url = new URL(TMDB_BASE + path);
  url.search = new URLSearchParams({ api_key: process.env.TMDB_API_KEY, ...params });
  return url;
}

// One entry per film, whichever pass found it: a theatrical pass outranks a
// service one (a calendar means the date a film arrives, and a cinema release is
// the earliest of them), and between two passes of the same rank the earlier date
// wins. Stated once, so the result cannot depend on which region's sweep happened
// to land last.
function mergeFilm(movies, item, theater, provider) {
  const existing = movies.get(item.id);
  if (!existing) {
    movies.set(item.id, {
      id: item.id,
      title: item.title,
      date: item.release_date,
      poster: item.poster_path ? IMG_BASE + item.poster_path : null,
      rating: round1(item.vote_average),
      popularity: Math.round(Number(item.popularity) || 0),
      providers: provider ? [provider] : [],
      theater: Boolean(theater),
    });
    return;
  }
  if (theater) {
    if (!existing.theater || item.release_date < existing.date) {
      existing.date = item.release_date;
      existing.theater = true;
    }
  } else if (!existing.theater && item.release_date < existing.date) {
    existing.date = item.release_date;
  }
  if (provider && existing.providers.length < 3 && !existing.providers.includes(provider)) existing.providers.push(provider);
}

// One region's films, merged into the window's map. `report` is how the union
// says what it could not reach instead of looking complete: `cut` = the budget
// was gone before its turn, `partial` = it got its cinema releases but not all of
// its platform sweeps, `noPlatforms` = TMDB lists none of the watchlist's
// platforms there.
async function regionMovies(from, to, region, deadline, warnings, movies, report, usage) {
  // Recorded at most once per region, whichever step runs out of time: the
  // warning names a region that did not finish, not every piece it missed.
  const stop = kind => {
    if (!report.cut.includes(region) && !report.partial.includes(region)) report[kind].push(region);
  };
  // Every TMDB call in this invocation is counted here, and past the budget no
  // new work starts — the guard lives beside the time deadline because on the
  // free plan the count is what runs out first.
  const spent = () => (usage ? usage.tmdb >= TMDB_CALL_BUDGET || (usage.limit && (usage.total || 0) >= usage.limit) : false);
  const tmdbGet = (url, label) => {
    if (usage) {
      usage.tmdb++;
      usage.total = (usage.total || 0) + 1;
    }
    return fetchJSON(url, warnings, label);
  };
  if (Date.now() > deadline || spent()) { stop('cut'); return; }
  // The regional window. `release_date.gte/lte` — not `primary_release_date.*` —
  // is the pair TMDB documents as the region-aware one: with region and
  // with_release_type the date it returns is the film's own date for those
  // release types in that region. Pairing a region with primary_release_date.*
  // is the trap this shipped with: the filter stays global (every region gets an
  // identical list), while the date reported back is the regional one, which for
  // a window starting today came back as the window's own first day — a month of
  // real releases replaced by 80 undated titles, none of them the films actually
  // opening. The re-check below is what keeps that class of surprise visible.
  const windowParams = {
    region,
    'release_date.gte': from,
    'release_date.lte': to,
    include_adult: 'false',
  };
  const page = (pass, number) =>
    tmdbGet(tmdbUrl('/discover/movie', { ...windowParams, with_release_type: pass.types, sort_by: pass.sort, page: String(number) }), 'TMDB films');

  // The dated walk (see moviePlan): pages come in release-date order, so the
  // window is finished once a page's own last entry is already past `to` — or
  // once a page comes back short, which is TMDB's last one. Walking in chunks of
  // BATCH and stopping there is what keeps the crowded opening days of a month
  // from eating the whole budget before the rest of it is reached. A popularity-
  // ordered walk (the year window) has no such stop: it is a fixed few pages.
  const plan = moviePlan(spanDays(from, to));
  const dateOrdered = plan.theater.sort === 'release_date.asc';
  for (let start = 1; start <= plan.theater.pages; start += BATCH) {
    if (Date.now() > deadline) { stop(start === 1 ? 'cut' : 'partial'); break; }
    if (spent()) { stop(start === 1 ? 'cut' : 'partial'); break; }
    const chunk = [];
    for (let number = start; number < Math.min(start + BATCH, plan.theater.pages + 1); number++) chunk.push(number);
    const payloads = await mapLimit(chunk, BATCH, number => page(plan.theater, number));
    for (const payload of payloads) {
      for (const item of (payload && payload.results) || []) {
        // The last word on membership, whichever pass found the film: a film is in
        // this calendar only if the date TMDB reports for it falls inside the
        // window, so a popularity-ordered page cannot drag next spring into
        // October.
        if (!item.release_date || item.release_date < from || item.release_date > to) continue;
        // Everything this pass returns has a theatrical release in the window,
        // which is what the Sheet calls "Theater".
        mergeFilm(movies, item, true, '');
      }
    }
    const last = payloads[payloads.length - 1];
    const items = (last && last.results) || [];
    if (items.length < 20 || (dateOrdered && items[items.length - 1].release_date > to)) break;
  }

  // Out of time, and nothing of it worth asking for: the cinema pages that did
  // land are already in the map, and the sweeps would only make the request
  // overrun worse.
  if (Date.now() > deadline || spent()) { stop('partial'); return; }

  // One sweep per platform on the list that this region actually carries. The
  // discover response has no provider field, so the only way to know a film is
  // on a service is to ask that service for its window; the answers are what
  // make this half a list of what is watchable rather than of what is digital.
  const providerList = await tmdbGet(tmdbUrl('/watch/providers/movie', { watch_region: region }), 'TMDB providers');
  const seen = new Set();
  const wanted = ((providerList && providerList.results) || [])
    .map(provider => ({
      label: platformFor(provider.provider_name),
      id: provider.provider_id,
      rank: Number((provider.display_priorities || {})[region]) || 999,
    }))
    // A platform can be listed twice ("Netflix" and "Netflix with ads" are two
    // providers with one name here), so the first of them by regional prominence
    // is the one swept.
    .filter(provider => provider.label && provider.label !== THEATER && provider.id)
    .sort((a, b) => a.rank - b.rank)
    .filter(provider => {
      if (seen.has(provider.label)) return false;
      seen.add(provider.label);
      return true;
    });
  if (!wanted.length) report.noPlatforms.push(region);

  if (Date.now() > deadline || spent()) { stop('partial'); return; }
  // The sweep is walked in release-date order, not read off the first page of a
  // popularity ranking. That is the whole difference between a list of the
  // films that arrived on a service and a list of the most popular ones that
  // did: a ranking has no tail, and the films it drops are exactly the ones
  // nobody is searching for. Measured on the US October 2026 window, 6 of the
  // 34 films on the watchlist's platforms were missing from the first page of
  // every sweep, and a busier month loses more. A window too long to be
  // listed to the day keeps the popularity page, because that view is a
  // glance and says so.
  //
  // One round of pages at a time, so the concurrency stays at BATCH however
  // many pages a platform needs.
  const sweepPages = spanDays(from, to) <= DATED_DAYS ? MAX_SWEEP_PAGES : 1;
  const sweepSort = sweepPages > 1 ? 'release_date.asc' : 'popularity.desc';
  const perPlatform = wanted.map(provider => ({ provider, items: [], done: false }));
  let sweepCut = false;
  for (let number = 1; number <= sweepPages; number++) {
    const live = perPlatform.filter(entry => !entry.done);
    if (!live.length) break;
    if (Date.now() > deadline || spent()) { sweepCut = true; break; }
    const round = await mapLimit(live, BATCH, entry =>
      tmdbGet(
        tmdbUrl('/discover/movie', {
          ...windowParams,
          with_release_type: RELEASE_TYPES,
          with_watch_providers: String(entry.provider.id),
          with_watch_monetization_types: 'flatrate|free|ads',
          watch_region: region,
          sort_by: sweepSort,
          page: String(number),
        }),
        'TMDB films on ' + entry.provider.label
      ).then(payload => ({ entry, payload }))
    );
    for (const { entry, payload } of round) {
      const items = (payload && payload.results) || [];
      for (const item of items) {
        if (!item.release_date || item.release_date < from || item.release_date > to) continue;
        // A film only on a service is a real entry here — that is the
        // service's own list — so it is merged in, not merely labelled.
        mergeFilm(movies, item, false, entry.provider.label);
      }
      // A short page is TMDB's last one for this query.
      if (items.length < 20) entry.done = true;
    }
  }
  if (sweepCut) stop('partial');
}

// The TMDB record of a film the feed named, folded into the entry the calendar
// shows: the poster, the rating, the popularity, and the canonical title. A
// title can be listed under its original name — "YOU ME US" is "Noi un po'
// meglio" in Watchmode — so the title the page shows is TMDB's, not the
// feed's, wherever the two disagree.
function applyLookup(film, record) {
  if (!film || !record) return;
  if (record.title) film.title = record.title;
  if (record.poster) film.poster = record.poster;
  if (record.rating) film.rating = record.rating;
  if (record.popularity) film.popularity = record.popularity;
}

// One TMDB record, by id, for a film the release feed named — the poster, the
// rating and TMDB's own title.
//
// A 404 here is an ordinary answer, not a failure: the feed's id can name a
// record TMDB does not have as a film, and the feed's own row still carries a
// title, a date and the service the film arrived on, which is everything a
// calendar needs. So the miss is written down as an empty record — one ask, then
// never again — and nothing about it reaches the page: a reader cannot act on
// "TMDB film · HTTP 404", and a title shown without a poster is the fallback
// working rather than a fault to report.
async function filmRecord(id, usage, deadline) {
  if (usage) {
    if (usage.limit && (usage.total || 0) >= usage.limit) return null;
    usage.tmdb++;
    usage.total = (usage.total || 0) + 1;
  }
  if (deadline && Date.now() > deadline) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(tmdbUrl('/movie/' + id, {}).toString(), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) {
      return { tmdbId: Number(id) || 0, title: '', poster: '', rating: 0, popularity: 0 };
    }
    if (!response.ok) return null;
    const details = await response.json();
    return {
      tmdbId: Number(id) || 0,
      title: details.title || '',
      poster: details.poster_path ? IMG_BASE + details.poster_path : '',
      rating: round1(details.vote_average),
      popularity: Math.round(Number(details.popularity) || 0),
    };
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The cache the Watchmode client reads and writes. The answers are keyed by
// the request that produced them, so a window that is asked for twice costs
// one credit the second time and none at all once the D1 migration has been
// applied.
const wmCache = {
  get: (key, maxAge) => db.readWmCache(key, maxAge),
  set: (key, value) => db.writeWmCache(key, value),
};

// The services carrying a title, in the watchlist's own spelling, for the
// region asked about — and for another region, whatever Watchmode knows.
function servicesForRegion(rows, region) {
  const wanted = String(region || '').toUpperCase();
  const mine = (rows || []).filter(row => String(row.region || '').toUpperCase() === wanted);
  return serviceFilms(mine.length ? mine : rows || [], platformFor);
}

// ── THE RELEASE FEED ──────────────────────────────────────────────────────
// The streaming half of the calendar, and the one source that can see a title
// no provider filter can reach: what landed on a service, on which service,
// and on what date.
//
// The join is by id and never by name. A title can be listed under its
// original name, so a name join fails on exactly the films this step exists to
// find — and it is also why the TMDB record is fetched by id afterwards: the
// feed's name for a film is not always the name the page should show.
//
// The feed's dates are the service's own, and the service's own dates are
// US-first — the endpoint documents them as "primarily US release dates, though
// most major services release globally on the same day". So it dates the US.
// Another region gets its platforms from TMDB's provider sweeps, which are
// region-aware, and the feed is not asked for it.
async function loadWatchmode(from, to, regions, warnings, usage, deadline, movies, coverage, today) {
  // The feed's own budget is a count of credits (one a request, 2,500 a month
  // on the free plan), and the platform's cap on the invocation's subrequests
  // is a separate thing it leaves room in: the reserve is what the films the
  // feed found and the episode half running beside it need.
  const client = createWatchmode({
    warnings,
    deadline,
    maxCalls: WM_CALL_BUDGET,
    usage,
    today,
    cache: wmCache,
    reserve: WM_SUBREQUEST_RESERVE,
  });
  const report = {
    enabled: client.enabled,
    arrivals: 0,
    added: 0,
    resolved: 0,
    pending: 0,
    other: 0,
    series: 0,
    noId: 0,
    window: null,
    truncated: false,
    cut: false,
    calls: 0,
    cached: 0,
  };
  coverage.watchmode = report;
  if (!client.enabled) return report;
  if (regions.indexOf('US') === -1) {
    report.skipped = 'the feed dates the US';
    return report;
  }

  const { rows, truncated, from: feedFrom, to: feedTo, beyond } = await client.releases(from, to);
  report.truncated = truncated;
  report.window = { from: feedFrom, to: feedTo };
  // A window the feed does not reach — next year, seen from this year — is
  // answered for the close weeks instead. The page says which weeks those
  // were, rather than claiming a coverage of a year it does not have.
  report.beyond = Boolean(beyond);

  const arrivals = [];
  const seen = new Set();
  for (const row of rows) {
    const arrival = releaseFilm(row);
    // A season drop is a series premiere, and the episode half is TVmaze's:
    // one the episode source does not carry is counted, not faked.
    if (arrival.series) { report.series++; continue; }
    // A film the feed names with no TMDB id cannot be joined to anything: the
    // poster, the rating and the IMDb link all come from TMDB. It is counted
    // rather than dropped in silence, so the gap is a number and not a hole.
    if (!arrival.id) { report.noId++; continue; }
    if (!arrival.date || arrival.date < from || arrival.date > to) continue;
    // A service this calendar is not for is dropped at the fetch boundary,
    // like every other source's.
    const platform = platformFor(arrival.platform);
    if (!platform) { report.other++; continue; }
    if (isExcludedTitle(arrival.title)) continue;
    const key = arrival.id + '|' + platform;
    if (seen.has(key)) continue;
    seen.add(key);
    arrivals.push({ ...arrival, platform });
  }
  report.arrivals = arrivals.length;

  const pending = [];
  for (const arrival of arrivals) {
    const existing = movies.get(arrival.id);
    if (existing) {
      // The label is the win here: TMDB may know the film and not the service
      // it is on.
      if (existing.providers.length < 3 && !existing.providers.includes(arrival.platform)) {
        existing.providers.push(arrival.platform);
      }
      // A cinema release outranks a service one — a calendar means the date a
      // film arrives, and a cinema release is the earliest of them.
      if (!existing.theater && arrival.date < existing.date) existing.date = arrival.date;
      continue;
    }
    // A film TMDB's own passes never returned: it carries no watch provider,
    // so no provider-filtered query can reach it. It goes in with the feed's
    // own date and service, and TMDB's record is fetched by id below.
    movies.set(arrival.id, {
      id: arrival.id,
      title: arrival.title,
      date: arrival.date,
      poster: null,
      rating: 0,
      popularity: 0,
      providers: [arrival.platform],
      theater: false,
    });
    report.added++;
    pending.push(arrival);
  }

  // The films only the feed knows need TMDB's own record: the poster, the
  // rating, and the canonical title. Each record is fetched once and kept, so
  // the second load of a month costs nothing, and the films still waiting are
  // counted rather than left to look like films with no poster at all.
  let budget = WM_DETAIL_BUDGET;
  for (const arrival of pending) {
    const film = movies.get(arrival.id);
    if (!film) continue;
    const cached = await db.readWmLookup(arrival.id);
    if (cached) {
      applyLookup(film, cached);
      report.resolved++;
      continue;
    }
    if (budget <= 0) break;
    budget--;
    const record = await filmRecord(arrival.id, usage, deadline);
    // No record to be had, or no budget left to ask: the feed's own title, date
    // and service are already on the entry, so the calendar has a release to
    // show either way — a missing poster is a smaller loss than a page that
    // says something went wrong.
    if (!record) continue;
    await db.writeWmLookup(record);
    applyLookup(film, record);
    report.resolved++;
  }
  report.pending = pending.length - report.resolved;
  report.calls = client.calls.calls;
  report.cached = client.calls.cached;
  report.cut = client.calls.cut;
  return report;
}

// The film half of one window: one region, or every region the picker offers
// when `region=all`. The union is a merge, not a stack — a film on a service in
// six countries is one entry carrying six labels (capped, as ever, at three) and
// one date — so the day a film appears never depends on which region's sweep
// reached it first, and the list stays a list of films rather than of releases.
// One budget covers the whole union (see UNION_BUDGET_MS), and the page usually
// fans the union out itself — one movies request per region — so that each
// invocation stays inside the platform's subrequest cap; several regions in one
// call still works, bounded the same way.
async function loadMovies(from, to, regions, warnings, state, usage, coverage, today) {
  const union = regions.length > 1;
  if (state) state.complete = true;
  const started = Date.now();
  const deadline = started + (union ? UNION_BUDGET_MS : REGION_BUDGET_MS);
  const movies = new Map();
  const report = { cut: [], partial: [], noPlatforms: [] };
  await mapLimit(regions, union ? UNION_BATCH : BATCH, region =>
    regionMovies(from, to, region, deadline, warnings, movies, report, usage)
  );
  if (report.noPlatforms.length) {
    warn(warnings, 'TMDB films · none of your platforms (' + PLATFORMS.length + ' of them) are listed for ' + report.noPlatforms.join(', ') + ' — cinema releases only there');
  }
  if (report.partial.length) {
    warn(warnings, 'TMDB films · ' + report.partial.length + ' of ' + regions.length + ' regions came back without their platform lists (' + report.partial.join(', ') + ') — Refresh tries again');
  }
  if (report.cut.length) {
    warn(warnings, 'TMDB films · no time left for ' + report.cut.length + ' of ' + regions.length + ' regions (' + report.cut.join(', ') + ') — Refresh tries again');
  }
  if (state) state.complete = !report.cut.length && !report.partial.length;

  // The streaming half, and the source that can see what the sweeps cannot.
  // It runs inside the same wall-clock budget as the rest of the window, so
  // the invocation cannot overrun the platform's limit by adding to it.
  const wmDeadline = Math.min(Date.now() + WM_BUDGET_MS, started + (union ? UNION_BUDGET_MS : REGION_BUDGET_MS));
  const wm = await loadWatchmode(from, to, regions, warnings, usage, wmDeadline, movies, coverage, today);
  if (wm.enabled && (wm.cut || wm.truncated)) {
    if (state) state.complete = false;
    warn(warnings, 'Watchmode · the release feed was cut short (' + wm.calls + ' requests) — some arrivals are missing until the next load');
  }

  // Nothing gets in that is neither in cinemas nor on one of the platforms: a
  // film with no provider label that no theatre pass found is a title on some
  // service this calendar is not for. Cinema releases are labelled, so the
  // platform filter can ask for them (and the badge says how it arrives).
  const list = [...movies.values()]
    .filter(movie => (movie.theater || movie.providers.length) && !isExcludedTitle(movie.title))
    .map(movie => (movie.theater ? { ...movie, providers: movie.providers.concat(THEATER) } : movie))
    .sort((a, b) => a.date.localeCompare(b.date) || b.popularity - a.popularity);
  if (coverage) {
    coverage.films = list.length;
    coverage.tmdb = list.length - (coverage.watchmode ? coverage.watchmode.added : 0);
  }
  return list;
}

// ── EPISODES ──────────────────────────────────────────────────────────────
// "series" and "season" mark the two things a viewer actually plans around —
// the rest of the schedule is the weekly run of shows already on.
function episodeRow(entry) {
  // Two shapes for the same thing: the schedule endpoints embed the show under
  // `_embedded`, the per-day network one puts it at the top level.
  const show = (entry._embedded && entry._embedded.show) || entry.show || {};
  const streaming = Boolean(show.webChannel && show.webChannel.name);
  const channel = (streaming ? show.webChannel.name : (show.network && show.network.name) || '') || 'Other';
  // The Sheet's spelling of the platform, or '' when the show airs somewhere
  // this calendar is not for — which is how the episode half is filtered.
  const platform = platformFor(channel);
  return {
    id: entry.id,
    title: show.name || entry.name || '',
    episode: entry.name || '',
    date: entry.airdate,
    time: entry.airtime || '',
    season: Number(entry.season) || 0,
    number: Number(entry.number) || 0,
    platform,
    streaming,
    kind: show.type || '',
    poster: (show.image && show.image.medium) || null,
    rating: round1(show.rating && show.rating.average),
    weight: Math.round(Number(show.weight) || 0),
    genres: Array.isArray(show.genres) ? show.genres.slice(0, 2) : [],
    premiere: entry.season === 1 && entry.number === 1 ? 'series' : entry.number === 1 ? 'season' : '',
    url: entry.url || show.url || '',
    // A release links to the title's own IMDb page rather than to the API it came
    // from. For an episode it costs nothing: the show's IMDb id is already in the
    // payload this function fetches, so no extra upstream call is made. A show
    // the source has no id for (a fifth of them — news, talk, the web channels)
    // is null here and the page falls back to an IMDb search for the name.
    imdb: imdbUrl(show.externals && show.externals.imdb),
  };
}

// ── THE DAYS THE BIG RESPONSE DOES NOT REACH ──────────────────────────────
// /schedule/full is complete for today onwards and only rolling while it starts,
// which serves a month that is ahead but not the one we are in: on 10 October its
// own earliest day held three entries. So every day of the window that is already
// behind us is asked for on its own — the network half for one country plus the
// web half without one, which is exactly the pair the big response merges — and
// the month reads as a month instead of as a wall of empty past days.
//
// The boundary is today, deliberately not the big response's earliest day: that
// edge is the rolling part, and a day taken from it arrives half-filled — Oct 8
// carried three entries (CNN, NBC, ABC, none of them on the platform list, so an
// empty day) where the day's own list has dozens.
//
// It costs two upstream calls a day, which is why it is bounded twice: a batch
// size and a wall-clock budget, so a page load on the 30th does not turn into
// sixty requests. The source's own courtesy limit is ~20 requests per 10 seconds
// (measured: it absorbs bursts well past that, but the ceiling is not ours to
// spend), and whatever the budget cannot reach is named in a warning rather than
// quietly missing.
const BACKFILL_MAX_DAYS = 31; // a month is the longest past a window can be
const BACKFILL_BATCH = 3; // days at a time — two requests each. TVmaze's courtesy
// limit is ~20 requests per 10 seconds, so a whole month goes out in small
// waves rather than one burst.
const BACKFILL_BUDGET_MS = 7000; // for the whole backfill, not per day
// The longest past range one invocation backfills on an explicit ask: 12 days is
// 24 subrequests, inside the free plan's 50 with room for the schedule call
// beside it. Longer pasts are asked for in several such ranges (see backfillParam),
// because past days never change and each range caches for a day.
const BACKFILL_CHUNK_DAYS = 12;

// One past day, both halves. null when either half failed: half a day is worse
// than a day that is visibly missing, and the failure is reported once as a count.
async function daySchedule(date) {
  const swallowed = []; // per-day failures are counted, not warned about one by one
  const [network, web] = await Promise.all([
    fetchJSON(TVMAZE_BASE + '/schedule?date=' + date + '&country=US', swallowed, 'schedule'),
    fetchJSON(TVMAZE_BASE + '/schedule/web?date=' + date, swallowed, 'web schedule'),
  ]);
  if (!network || !web) return null;
  return (Array.isArray(network) ? network : []).concat(Array.isArray(web) ? web : []);
}

async function backfillRange(days, collect) {
  const deadline = Date.now() + BACKFILL_BUDGET_MS;
  const state = new Array(days.length).fill('done');
  await mapLimit(days, BACKFILL_BATCH, async (date, index) => {
    if (Date.now() > deadline) {
      state[index] = 'late';
      return;
    }
    const entries = await daySchedule(date);
    if (!entries) {
      state[index] = 'failed';
      return;
    }
    entries.forEach(collect);
  });
  // A day that failed probably met a shed-load 429 rather than an empty
  // schedule, so the failures get one more pass on their own while the budget
  // lasts instead of reading as a quiet gap.
  const retry = days.map((date, index) => ({ date, index })).filter(row => state[row.index] === 'failed');
  if (retry.length && Date.now() < deadline) {
    await mapLimit(retry, 2, async ({ date, index }) => {
      if (Date.now() > deadline) return;
      const entries = await daySchedule(date);
      if (!entries) return;
      entries.forEach(collect);
      state[index] = 'done';
    });
  }
  return { late: days.filter((date, index) => state[index] === 'late'), failed: state.filter(value => value === 'failed').length };
}

function warnBackfill(warnings, late, failed) {
  if (late.length) {
    warn(
      warnings,
      'TVmaze episodes · no time left for ' + late.length + (late.length === 1 ? ' day' : ' days') + ' before today (' +
        late[0] + ' to ' + late[late.length - 1] + ') — Refresh tries again'
    );
  }
  if (failed) {
    warn(warnings, 'TVmaze episodes · ' + failed + (failed === 1 ? ' day' : ' days') + ' before today could not be fetched');
  }
}

async function backfillDays(from, to, today, collect, warnings) {
  const days = [];
  for (let date = from; date <= to && date < today && days.length < BACKFILL_MAX_DAYS; date = addDays(date, 1)) days.push(date);
  if (!days.length) return;
  const { late, failed } = await backfillRange(days, collect);
  warnBackfill(warnings, late, failed);
}

// Which past days this invocation backfills. `backfill=none` fetches the big
// response only; `backfill=YYYY-MM-DD,YYYY-MM-DD` backfills exactly that range
// (clamped to the window and to BACKFILL_CHUNK_DAYS) and skips the big response
// — that is how the page fetches a long past without putting 60 subrequests in
// one invocation. Anything else is the automatic behaviour: the whole past of
// the window, up to BACKFILL_MAX_DAYS.
function backfillParam(params, from, to) {
  const raw = String(params.backfill || '').trim();
  if (raw.toLowerCase() === 'none') return { mode: 'none', days: [] };
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})$/);
  if (match) {
    const days = [];
    const start = match[1] < from ? from : match[1];
    const end = match[2] > to ? to : match[2];
    for (let date = start; date <= end && days.length < BACKFILL_CHUNK_DAYS; date = addDays(date, 1)) days.push(date);
    if (days.length) return { mode: 'range', days };
  }
  return { mode: 'auto', days: [] };
}

async function loadEpisodes(from, to, today, warnings, backfill) {
  const mode = (backfill && backfill.mode) || 'auto';
  const seen = new Set();
  const rows = [];
  // One filter and one dedupe for everything, whoever it came from: the day
  // endpoints re-serve episodes the big response already carried on its own
  // border days, and an episode counts once.
  const collect = entry => {
    if (!entry || !entry.airdate || entry.airdate < from || entry.airdate > to) return;
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    const row = episodeRow(entry);
    // A show on a network or service that is not on the list is not part of this
    // calendar — that is the whole point of fetching from a fixed set.
    if (!row.platform) return;
    if (isExcludedTitle(row.title)) return;
    rows.push(row);
  };
  if (mode === 'range') {
    const { late, failed } = await backfillRange(backfill.days, collect);
    warnBackfill(warnings, late, failed);
  } else {
    const schedule = await fetchJSON(TVMAZE_BASE + '/schedule/full', warnings, 'TVmaze schedule');
    if (!Array.isArray(schedule)) return [];
    schedule.forEach(collect);
    if (mode === 'auto') await backfillDays(from, to, today, collect, warnings);
  }
  // Most notable first within a day, so the calendar's per-day preview can just
  // take the head of the list: a series premiere outranks a weekly episode.
  return rows.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    b.weight - a.weight ||
    String(a.title).localeCompare(String(b.title))
  );
}

// ── A TITLE, LOOKED UP BY NAME ────────────────────────────────────────────
// The calendar above is built from TMDB's *discover* index: the theatrical
// list and the per-service lists. A title can exist in TMDB and still be in
// neither — a streaming release whose provider TMDB has not attached yet (a
// Netflix film days before its date, say) is in TMDB's search index but in no
// discover list, so the calendar could not show it at all. This asks for the
// record directly, which is the only way a title TMDB knows about can be
// found by name.
//
// It answers with the same movie shape the calendar uses, so the page can
// render it and add it like any other listing. The platform is the watchlist's
// own spelling of whatever TMDB lists, and 'Other' — the watchlist's word for
// "no platform recorded" — when TMDB lists none.
async function searchTitle(title, warnings, region, usage) {
  const text = String(title || '').trim();
  if (!text) return null;
  const key = String(process.env.TMDB_API_KEY || '').trim();
  if (!key) {
    warn(warnings, 'TMDB films · no TMDB_API_KEY where this function ran (' + runContext() + ') — the key is set per environment, so this one needs a value too');
    return null;
  }
  const searchUrl = new URL(TMDB_BASE + '/search/multi');
  searchUrl.search = new URLSearchParams({ api_key: key, query: text, include_adult: 'false', page: '1' });
  const search = await fetchJSON(searchUrl.toString(), warnings, 'TMDB search');
  const candidates = ((search && search.results) || []).filter(item => item.media_type === 'movie' || item.media_type === 'tv');
  const match = pickMatch(candidates, text, '');
  if (!match) return null;
  const isMovie = match.media_type === 'movie';
  let date = match.release_date || match.first_air_date || '';
  // A record without a date cannot be placed on a calendar, so it is not a
  // listing. The details call is the second chance for one.
  if (!date) {
    const detailsUrl = new URL(TMDB_BASE + (isMovie ? '/movie/' : '/tv/') + match.id);
    detailsUrl.search = new URLSearchParams({ api_key: key });
    const details = await fetchJSON(detailsUrl.toString(), warnings, 'TMDB details');
    if (details) date = details.release_date || details.first_air_date || '';
  }
  if (!date) return null;
  // The platform, in the watchlist's spelling. The names come from every
  // region TMDB knows, and only the ones the watchlist logs are kept.
  const providersUrl = new URL(TMDB_BASE + (isMovie ? '/movie/' : '/tv/') + match.id + '/watch/providers');
  providersUrl.search = new URLSearchParams({ api_key: key });
  const prov = await fetchJSON(providersUrl.toString(), warnings, 'TMDB providers');
  const names = [];
  Object.values((prov && prov.results) || {}).forEach(byRegion => {
    ['flatrate', 'free', 'ads'].forEach(group => (byRegion[group] || []).forEach(entry => {
      const label = platformFor(entry.provider_name);
      if (label && !names.includes(label)) names.push(label);
    }));
  });
  // TMDB lists no service for some titles — the measured case being a film
  // whose provider it has not attached, which is why it is invisible in the
  // calendar at all. Watchmode indexes by service, so it is the one source
  // that can say where such a title is watchable; without it the answer would
  // be "Other", which is a guess dressed as a fact.
  if (!names.length) {
    const client = createWatchmode({ warnings, maxCalls: 2, usage, cache: wmCache });
    if (client.enabled) {
      const sources = await client.titleSources(match.id, 0, isMovie ? 'movie' : 'tv');
      const labels = servicesForRegion(sources, region);
      labels.forEach(label => {
        if (!names.includes(label)) names.push(label);
      });
    }
  }
  // The record this search already holds is kept: a film the release feed names
  // later is the same film, and the poster, the rating and the popularity have
  // not changed in between. The table is what makes the second load of a
  // month cost nothing.
  await db.writeWmLookup({
    tmdbId: match.id,
    title: match.title || match.name || text,
    poster: match.poster_path ? IMG_BASE + match.poster_path : '',
    rating: round1(match.vote_average),
    popularity: Math.round(Number(match.popularity) || 0),
  });
  return {
    id: match.id,
    title: match.title || match.name || text,
    date,
    poster: match.poster_path ? IMG_BASE + match.poster_path : null,
    rating: round1(match.vote_average),
    popularity: Math.round(Number(match.popularity) || 0),
    providers: names.length ? names.slice(0, 3) : ['Other'],
    theater: false,
    // Marked so the page can say where this came from: it is a title asked for
    // by name, not a release the month's list carried.
    direct: true,
  };
}

exports.handler = async event => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const params = event.queryStringParameters || {};
  const today = new Date().toISOString().slice(0, 10);
  const from = DATE_RE.test(params.from || '') ? params.from : today;
  let to = DATE_RE.test(params.to || '') ? params.to : addDays(from, 61);
  // Bound the window: /schedule/full is the whole future and the page only ever
  // asks for two months, so anything wider is a request that costs time and
  // gains nothing.
  if (to < from) to = from;
  if (to > addDays(from, MAX_DAYS)) to = addDays(from, MAX_DAYS);
  const regions = requestedRegions(params);
  const region = regions.length > 1 ? ALL_REGIONS : regions[0];

  // What this invocation builds. The page asks for the halves separately — one
  // movies request per region plus an episodes request — so that no single
  // invocation carries the union's old ~250 subrequests on the free plan's 50.
  // `backfill=none` fetches the big schedule response only, and
  // `backfill=FROM,TO` backfills exactly that past range without it. Absent
  // both, one request still builds the whole window as before.
  const include = String(params.include || '').trim().toLowerCase();
  const wantMovies = include !== 'episodes';
  const wantEpisodes = include !== 'movies';
  const backfill = wantEpisodes ? backfillParam(params, from, to) : { mode: 'none', days: [] };

  const warnings = [];
  const films = { complete: true };
  const usage = { tmdb: 0, calls: 0, total: 0, limit: SUBREQUEST_CAP };
  const coverage = { films: 0, tmdb: 0, watchmode: null };
  const tmdbKey = String(process.env.TMDB_API_KEY || '').trim();

  // A title asked for by name: one lookup, no window, no episodes. This is the
  // way past TMDB's discover index (see searchTitle).
  if (include === 'search') {
    const found = await searchTitle(params.title, warnings, region, usage);
    return json(200, {
      range: { from, to, region, regions: regions.length > 1 ? regions : undefined },
      generatedAt: new Date().toISOString(),
      movies: found ? [found] : [],
      episodes: [],
      coverage,
      warnings,
    }, { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' });
  }

  try {
    const [movies, episodes] = await Promise.all([
      wantMovies && tmdbKey ? loadMovies(from, to, regions, warnings, films, usage, coverage, today) : Promise.resolve([]),
      wantEpisodes ? loadEpisodes(from, to, today, warnings, backfill) : Promise.resolve([]),
    ]);
    if (wantMovies && !tmdbKey) {
      warn(
        warnings,
        'TMDB films · no TMDB_API_KEY where this function ran (' + runContext() + ') — the key is set per environment, so this one needs a value too'
      );
    }

    // A past range never changes — the episodes that aired, aired — so an
    // explicit backfill caches for a day and the page's later months never
    // refetch it. Everything else keeps the short cache, and an incomplete
    // union keeps the minute one so the missing regions are retried, not pinned.
    const rangeIsPast = backfill.mode === 'range' && backfill.days.length > 0 && backfill.days.every(day => day < today);
    const cacheable = !wantMovies && rangeIsPast
      ? 'public, max-age=86400, stale-while-revalidate=86400'
      : films.complete
        ? 'public, max-age=900, stale-while-revalidate=3600'
        : 'public, max-age=60, stale-while-revalidate=3600';
    return json(
      200,
      {
        range: { from, to, region, regions: regions.length > 1 ? regions : undefined },
        generatedAt: new Date().toISOString(),
        movies,
        episodes,
        // Where the films came from, and what is still to come. The page shows
        // it under the summary: a month that is short because a source was cut
        // has to say so rather than looking like a month with nothing in it.
        coverage,
        warnings,
      },
      // The window's contents change slowly (TVmaze's own copy of the schedule
      // is cached for 24 hours upstream), so a short CDN cache is free; the
      // page's Refresh button passes ?fresh= for a distinct URL that misses it.
      // A union that ran out of budget is cached for a minute instead, because
      // pinning an incomplete answer for fifteen would make the missing regions
      // look like the calendar's actual contents.
      { 'Cache-Control': cacheable }
    );
  } catch (error) {
    console.error('Calendar aggregation failed:', error);
    return json(502, { error: 'Unable to build the release calendar right now.' });
  }
};

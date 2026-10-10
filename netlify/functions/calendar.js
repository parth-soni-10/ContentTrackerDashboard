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
//     TVmaze's /schedule/full returns every future episode it knows about in a
//     single 3.3 MB response. Note it must be that endpoint: the plain
//     /schedule one "will only return episodes that are tied to a specific
//     country… Episodes from global Web Channels like Netflix are not
//     included", which is exactly the half a release calendar is for.
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
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TVMAZE_BASE = 'https://api.tvmaze.com';
const IMG_BASE = 'https://image.tmdb.org/t/p/w185';

const TIMEOUT_MS = 6500; // per upstream request
const MAX_DAYS = 400; // a whole year of window, plus slack for a 366-day one
const DATED_DAYS = 100; // windows up to this long are fetched to the day
const MAX_DATED_PAGES = 25; // 20 a page → 500 theatrical releases, the hard cap
const YEAR_PAGES = 3; // 60 by popularity: a year at a glance, not a full dump
const BATCH = 5; // concurrent TMDB requests
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REGION_RE = /^[A-Z]{2}$/;

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
const REGION_BUDGET_MS = 20000;
const UNION_BUDGET_MS = 9000;
// How many regions are worked on at once. The ceiling that matters is the total
// in-flight upstream requests — this times BATCH, the fan-out inside one region —
// because TMDB's documented upper limit is "somewhere in the 40 requests per
// second range" and at these latencies three regions is already ~15 requests at
// a time. Asking for more only buys 429s, which arrive as missing platform lists.
const UNION_BATCH = 3;
function requestedRegions(params) {
  const raw = String(params.region || '').trim().toUpperCase();
  if (raw !== ALL_REGIONS.toUpperCase()) return [REGION_RE.test(raw) ? raw : 'US'];
  const list = String(params.regions || '').split(',')
    .map(code => code.trim().toUpperCase())
    .filter((code, index, all) => REGION_RE.test(code) && all.indexOf(code) === index)
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

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

// Where this invocation actually ran. Netlify sets CONTEXT for every deploy
// (production / deploy-preview / branch-deploy / dev); a bare local runner sets
// nothing, which is itself the diagnosis.
function runContext() {
  const context = String(process.env.CONTEXT || '').trim();
  const branch = String(process.env.BRANCH || '').trim().slice(0, 60);
  if (!context) return 'no Netlify context — local run';
  return context === 'branch-deploy' && branch ? context + ' on ' + branch : context;
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
// can't push the whole function past the platform's request timeout.
async function fetchJSON(url, warnings, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } catch (error) {
    warn(warnings, label + ' · ' + (error && error.message ? error.message : 'request failed'));
    return null;
  } finally {
    clearTimeout(timer);
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
async function regionMovies(from, to, region, deadline, warnings, movies, report) {
  // Recorded at most once per region, whichever step runs out of time: the
  // warning names a region that did not finish, not every piece it missed.
  const stop = kind => {
    if (!report.cut.includes(region) && !report.partial.includes(region)) report[kind].push(region);
  };
  if (Date.now() > deadline) { stop('cut'); return; }
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
    fetchJSON(tmdbUrl('/discover/movie', { ...windowParams, with_release_type: pass.types, sort_by: pass.sort, page: String(number) }), warnings, 'TMDB films');

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
  if (Date.now() > deadline) { stop('partial'); return; }

  // One sweep per platform on the list that this region actually carries. The
  // discover response has no provider field, so the only way to know a film is
  // on a service is to ask that service for its window; the answers are what
  // make this half a list of what is watchable rather than of what is digital.
  const providerList = await fetchJSON(tmdbUrl('/watch/providers/movie', { watch_region: region }), warnings, 'TMDB providers');
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

  if (Date.now() > deadline) { stop('partial'); return; }
  const sweeps = await mapLimit(wanted, BATCH, provider =>
    fetchJSON(
      tmdbUrl('/discover/movie', {
        ...windowParams,
        with_release_type: RELEASE_TYPES,
        with_watch_providers: String(provider.id),
        with_watch_monetization_types: 'flatrate|free|ads',
        watch_region: region,
        sort_by: 'popularity.desc',
        page: '1',
      }),
      warnings,
      'TMDB films on ' + provider.label
    ).then(payload => ({ provider: provider.label, payload }))
  );

  for (const sweep of sweeps) {
    if (!sweep || !sweep.payload) continue;
    for (const item of sweep.payload.results || []) {
      if (!item.release_date || item.release_date < from || item.release_date > to) continue;
      // A film only on a service is a real entry here — that is the service's
      // own list — so it is merged in, not merely labelled.
      mergeFilm(movies, item, false, sweep.provider);
    }
  }
}

// The film half of one window: one region, or every region the picker offers
// when `region=all`. The union is a merge, not a stack — a film on a service in
// six countries is one entry carrying six labels (capped, as ever, at three) and
// one date — so the day a film appears never depends on which region's sweep
// reached it first, and the list stays a list of films rather than of releases.
// One budget covers the whole union (see UNION_BUDGET_MS).
async function loadMovies(from, to, regions, warnings, state) {
  const union = regions.length > 1;
  if (state) state.complete = true;
  const deadline = Date.now() + (union ? UNION_BUDGET_MS : REGION_BUDGET_MS);
  const movies = new Map();
  const report = { cut: [], partial: [], noPlatforms: [] };
  await mapLimit(regions, union ? UNION_BATCH : BATCH, region =>
    regionMovies(from, to, region, deadline, warnings, movies, report)
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

  // Nothing gets in that is neither in cinemas nor on one of the platforms: a
  // film with no provider label that no theatre pass found is a title on some
  // service this calendar is not for. Cinema releases are labelled, so the
  // platform filter can ask for them (and the badge says how it arrives).
  return [...movies.values()]
    .filter(movie => movie.theater || movie.providers.length)
    .map(movie => (movie.theater ? { ...movie, providers: movie.providers.concat(THEATER) } : movie))
    .sort((a, b) => a.date.localeCompare(b.date) || b.popularity - a.popularity);
}

// ── EPISODES ──────────────────────────────────────────────────────────────
// "series" and "season" mark the two things a viewer actually plans around —
// the rest of the schedule is the weekly run of shows already on.
function episodeRow(entry) {
  const show = (entry._embedded && entry._embedded.show) || {};
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
  };
}

async function loadEpisodes(from, to, warnings) {
  const schedule = await fetchJSON(TVMAZE_BASE + '/schedule/full', warnings, 'TVmaze schedule');
  if (!Array.isArray(schedule)) return [];
  const seen = new Set();
  const rows = [];
  for (const entry of schedule) {
    if (!entry || !entry.airdate || entry.airdate < from || entry.airdate > to) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const row = episodeRow(entry);
    // A show on a network or service that is not on the list is not part of this
    // calendar — that is the whole point of fetching from a fixed set.
    if (!row.platform) continue;
    rows.push(row);
  }
  // Most notable first within a day, so the calendar's per-day preview can just
  // take the head of the list: a series premiere outranks a weekly episode.
  return rows.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    b.weight - a.weight ||
    String(a.title).localeCompare(String(b.title))
  );
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

  const warnings = [];
  const films = { complete: true };
  const tmdbKey = String(process.env.TMDB_API_KEY || '').trim();
  try {
    const [movies, episodes] = await Promise.all([
      tmdbKey ? loadMovies(from, to, regions, warnings, films) : Promise.resolve([]),
      loadEpisodes(from, to, warnings),
    ]);
    if (!tmdbKey) {
      warn(
        warnings,
        'TMDB films · no TMDB_API_KEY where this function ran (' + runContext() + ') — the key is set per environment, so this one needs a value too'
      );
    }

    return json(
      200,
      {
        range: { from, to, region, regions: regions.length > 1 ? regions : undefined },
        generatedAt: new Date().toISOString(),
        movies,
        episodes,
        warnings,
      },
      // The window's contents change slowly (TVmaze's own copy of the schedule
      // is cached for 24 hours upstream), so a short CDN cache is free; the
      // page's Refresh button passes ?fresh= for a distinct URL that misses it.
      // A union that ran out of budget is cached for a minute instead, because
      // pinning an incomplete answer for fifteen would make the missing regions
      // look like the calendar's actual contents.
      { 'Cache-Control': films.complete ? 'public, max-age=900, stale-while-revalidate=3600' : 'public, max-age=60, stale-while-revalidate=3600' }
    );
  } catch (error) {
    console.error('Calendar aggregation failed:', error);
    return json(502, { error: 'Unable to build the release calendar right now.' });
  }
};

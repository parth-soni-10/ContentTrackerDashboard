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
const MOVIE_PAGES = 8; // 20 films a page → 160 by regional release date
const MARQUEE_PAGES = 3; // and 60 by popularity on top of them (see moviePlan)
const YEAR_PAGES = 3; // 60 by popularity: a year at a glance, not a full dump
const PROVIDER_PAGES = 1; // the provider sweep only labels, it isn't the source of truth
const PROVIDER_LIMIT = 12; // streaming services swept for platform labels
const BATCH = 5; // concurrent TMDB requests
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REGION_RE = /^[A-Z]{2}$/;

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

// How much of TMDB to ask for, decided by the window itself. A short window is
// fetched in regional release-date order — a calendar has to be complete — plus
// a popularity-ordered sweep on top, because a busy month has far more releases
// than any sane number of date-ordered pages reaches (a US October is hundreds)
// and the films anyone has actually heard of are exactly the ones at the end of
// that list. A long window cannot be listed to the day at all: eight
// date-ordered pages only reach a year's first weeks, so a year is fetched by
// popularity alone — the films anyone will hear about, in a third of the
// requests. That is what the page's year-at-a-glance view is for.
function moviePlan(days) {
  if (days <= DATED_DAYS) {
    return {
      sort: 'release_date.asc',
      pages: Math.max(3, Math.min(MOVIE_PAGES, Math.ceil(days / 5))),
      marquee: MARQUEE_PAGES,
    };
  }
  return { sort: 'popularity.desc', pages: YEAR_PAGES };
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
// Release types 2 (limited theatrical), 3 (theatrical), 4 (digital) and 6 (TV):
// leaving out 4 would hide every straight-to-streaming release, which is most of
// what arrives on a service without a cinema run.
const RELEASE_TYPES = '2|3|4|6';

function tmdbUrl(path, params) {
  const url = new URL(TMDB_BASE + path);
  url.search = new URLSearchParams({ api_key: process.env.TMDB_API_KEY, ...params });
  return url;
}

async function loadMovies(from, to, region, warnings) {
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
    with_release_type: RELEASE_TYPES,
    include_adult: 'false',
  };

  // Pass 1 — the calendar itself: the window in regional release-date order,
  // sized by what kind of window it is (see moviePlan). Pass 2 — the same window
  // by popularity, for the marquee titles the date-ordered pages could not
  // reach. Both are best-effort: a pass that fails only adds a warning.
  const plan = moviePlan(spanDays(from, to));
  const pages = Array.from({ length: plan.pages }, (unused, i) => i + 1);
  const [datePages, marqueePages] = await Promise.all([
    mapLimit(pages, BATCH, page =>
      fetchJSON(tmdbUrl('/discover/movie', { ...windowParams, sort_by: plan.sort, page: String(page) }), warnings, 'TMDB films')
    ),
    plan.marquee
      ? mapLimit(Array.from({ length: plan.marquee }, (unused, i) => i + 1), BATCH, page =>
          fetchJSON(tmdbUrl('/discover/movie', { ...windowParams, sort_by: 'popularity.desc', page: String(page) }), warnings, 'TMDB films')
        )
      : Promise.resolve([]),
  ]);

  const movies = new Map();
  for (const payload of datePages.concat(marqueePages)) {
    for (const item of (payload && payload.results) || []) {
      // The last word on membership, whichever pass found the film: a film is in
      // this calendar only if the date TMDB reports for it falls inside the
      // window, so a popularity-ordered page cannot drag next spring into
      // October.
      if (!item.release_date || item.release_date < from || item.release_date > to) continue;
      movies.set(item.id, {
        id: item.id,
        title: item.title,
        date: item.release_date,
        poster: item.poster_path ? IMG_BASE + item.poster_path : null,
        rating: round1(item.vote_average),
        popularity: Math.round(Number(item.popularity) || 0),
        providers: [],
      });
    }
  }

  // Pass 2 — platform labels. The discover response has no provider field, so
  // each of the region's most visible streaming services is asked once for the
  // films it carries in the same window. This only labels films pass 1 already
  // found: the window query stays the single source of truth for what is in
  // the calendar, so a provider that answers with an odd extra row can't
  // reshape the month.
  if (movies.size) {
    const providerList = await fetchJSON(tmdbUrl('/watch/providers/movie', { watch_region: region }), warnings, 'TMDB providers');
    const wanted = ((providerList && providerList.results) || [])
      .map(provider => ({
        name: provider.provider_name,
        id: provider.provider_id,
        rank: Number((provider.display_priorities || {})[region]) || 999,
      }))
      .filter(provider => provider.name && provider.id)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, PROVIDER_LIMIT);

    const sweeps = await mapLimit(wanted, BATCH, provider =>
      fetchJSON(
        tmdbUrl('/discover/movie', {
          ...windowParams,
          with_watch_providers: String(provider.id),
          with_watch_monetization_types: 'flatrate|free|ads',
          watch_region: region,
          sort_by: 'popularity.desc',
          page: '1',
        }),
        warnings,
        'TMDB films on ' + provider.name
      ).then(payload => ({ provider: provider.name, payload }))
    );

    for (const sweep of sweeps) {
      if (!sweep || !sweep.payload) continue;
      for (const item of sweep.payload.results || []) {
        const movie = movies.get(item.id);
        if (movie && movie.providers.length < 3 && !movie.providers.includes(sweep.provider)) {
          movie.providers.push(sweep.provider);
        }
      }
    }
  }

  return [...movies.values()].sort((a, b) => a.date.localeCompare(b.date) || b.popularity - a.popularity);
}

// ── EPISODES ──────────────────────────────────────────────────────────────
// "series" and "season" mark the two things a viewer actually plans around —
// the rest of the schedule is the weekly run of shows already on.
function episodeRow(entry) {
  const show = (entry._embedded && entry._embedded.show) || {};
  const streaming = Boolean(show.webChannel && show.webChannel.name);
  const platform = (streaming ? show.webChannel.name : (show.network && show.network.name) || '') || 'Other';
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
    rows.push(episodeRow(entry));
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
  const region = REGION_RE.test(params.region || '') ? params.region : 'US';

  const warnings = [];
  const tmdbKey = String(process.env.TMDB_API_KEY || '').trim();
  try {
    const [movies, episodes] = await Promise.all([
      tmdbKey ? loadMovies(from, to, region, warnings) : Promise.resolve([]),
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
        range: { from, to, region },
        generatedAt: new Date().toISOString(),
        movies,
        episodes,
        warnings,
      },
      // The window's contents change slowly (TVmaze's own copy of the schedule
      // is cached for 24 hours upstream), so a short CDN cache is free; the
      // page's Refresh button passes ?fresh= for a distinct URL that misses it.
      { 'Cache-Control': 'public, max-age=900, stale-while-revalidate=3600' }
    );
  } catch (error) {
    console.error('Calendar aggregation failed:', error);
    return json(502, { error: 'Unable to build the release calendar right now.' });
  }
};

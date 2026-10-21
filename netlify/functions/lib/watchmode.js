// The Watchmode client — the one place the streaming-availability API is
// asked "which service is this title on, and when did it land there?".
//
// It exists because of a class of release nothing else in this calendar can
// see: a film that arrives on a service without a cinema run *and* without
// TMDB's watch-provider tag. "YOU ME US" (Netflix, 29 Oct 2026) is the one
// that was measured against a live October window: TMDB has it as a type-4
// digital release and lists **no watch provider for it in any region**, so no
// provider-filtered query can return it, and TVmaze is episodes-only. A
// source that indexes by *service* — the thing a streaming calendar is
// actually about — is the only shape that reaches it.
//
// Three calls, and what each one is for:
//
//   /releases            The per-service release feed: a title, the service it
//                        landed on, and that service's own release date. This
//                        is the catch-all the calendar was missing, and it
//                        carries the platform with it, so a film arrives here
//                        *because* it is on a service the watchlist logs — not
//                        because a popularity page happened to list it.
//
//   /title/{id}/sources  Which services carry a title now, per region, with
//                        the service's type: 'sub' (subscription), 'free',
//                        'tve' (a channel app) and 'purchase' (rental). The
//                        fallback for a title no service list could attribute,
//                        and the only place a rental row can be told apart
//                        from a subscription one.
//
//   /search              TMDB id to Watchmode id, so the two catalogues join
//                        by id instead of by name. A title can be listed under
//                        its original name — "YOU ME US" is "Noi un po'
//                        meglio" here — so a name join fails on exactly the
//                        titles this file exists to find. The id is looked up
//                        by the kind of TMDB id it has (a film's and a show's
//                        are different fields in that index).
//
// The key is read from WATCHMODE_API_KEY per request and sent as X-API-Key
// rather than as a query parameter, so it never lands in a log line, a
// referrer or a browser history.
//
// Every call costs a credit — one per request, 2,500 a month on the free plan
// — so the client counts what it spends and stops at the budget it is given.
// Past that budget the caller is told what did not make it, instead of the
// request being killed half way: a missing service is a gap the page can name,
// and a killed request is nothing at all.
//
// The feed has no pagination and no source filter, so a window is asked for in
// slices of a week, and a slice that comes back full (the endpoint's own
// ceiling is 250 rows) is split and asked for again rather than being taken
// at face value. That is what keeps a busy week from being half a week.
//
// The slices sit on a fixed weekly grid — every one runs from a Monday to the
// Sunday after it — so the same week is always the same slice, two windows
// that overlap share one credit, and an answer can be written down and read
// back. How long a written-down answer stays good depends on what it is
// about: a week that has been and gone cannot change, the week in play is
// re-read often, and a week still to come settles in a day.

const WM_BASE = 'https://api.watchmode.com/v1';
const WM_TIMEOUT_MS = 6000;
// The feed's own ceiling: one call answers with at most 250 releases.
const WM_PAGE_LIMIT = 250;
// A window is asked for in slices of this many days. There is no pagination
// and no way to ask for one service at a time, so slicing is the only way to
// stay under the ceiling — and a week is comfortably inside it.
const WM_SLICE_DAYS = 7;
// How deep a full slice may be split before it is taken at face value: 7 days
// → 3 → 1, which is the finest a day can get.
const WM_MAX_SPLIT = 3;
// How many weeks the feed is asked for at most. A service's own release dates
// run a few weeks out, so a window further ahead than this is answered for
// the close weeks instead — and the answer says that it did not cover the
// window it was given.
const WM_HORIZON_WEEKS = 7;
// The source types that are a service the watchlist logs. 'purchase' is a
// rental or a purchase (iTunes, Vudu), which is not "released on a platform"
// the way a subscription is, so those rows are left out.
const WM_SOURCE_TYPES = ['sub', 'free', 'tve'];

const dayParam = iso => String(iso || '').replace(/-/g, '').slice(0, 8);
const addDays = (iso, days) => {
  const date = new Date(iso + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const spanDays = (from, to) =>
  Math.max(1, Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1);
// The Monday of the week a day falls in. Every slice of the feed runs from a
// Monday to the Sunday after it, so a window that starts mid-week is covered
// from that week's Monday and the same week is the same week every time.
const mondayOf = iso => {
  const date = new Date(iso + 'T00:00:00Z');
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
};
const sundayOf = iso => addDays(mondayOf(iso), WM_SLICE_DAYS - 1);
const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * One client for one invocation.
 *
 * @param {object}   options
 * @param {string[]} options.warnings   where a problem is reported, in the page's words
 * @param {number}   options.deadline   the invocation's wall-clock deadline (ms epoch), 0 for none
 * @param {number}   options.maxCalls   how many calls this client may spend
 * @param {object}   options.usage      the caller's shared counter, so the platform's
 *                                      subrequest cap is counted across every source
 * @param {number}   options.reserve    subrequests the feed leaves for the rest of the
 *                                      invocation (the films it found, the episode half)
 * @param {object}   options.cache      a { get, set } pair to read and write answers with
 * @param {string}   options.today      the day this invocation is happening
 * @param {Function} options.fetchImpl  a stand-in for fetch (the tests)
 * @param {string}   options.key        a key to use instead of the environment's
 */
function createWatchmode({
  warnings = [],
  deadline = 0,
  maxCalls = 12,
  usage = null,
  reserve = 0,
  cache = null,
  today = null,
  fetchImpl = null,
  key = null,
} = {}) {
  const apiKey = key === null ? String(process.env.WATCHMODE_API_KEY || '').trim() : String(key || '').trim();
  const now = today || todayISO();
  const state = { calls: 0, cached: 0, cut: false };

  const note = text => {
    if (Array.isArray(warnings) && !warnings.includes(text)) warnings.push(text);
  };

  // How long a written-down answer about this slice stays good. A week that
  // has been and gone cannot change; the week in play is the one that is
  // still filling up, so it is re-read often; a week still to come settles in
  // a day.
  const cacheAge = (from, to) => {
    if (to < now) return 60 * 24 * 30;
    if (from <= now) return 60 * 6;
    return 60 * 24;
  };

  // One request, counted before it goes out (a call that fails still spent a
  // credit) and bounded by the credit budget, the platform's shared subrequest
  // cap and the wall clock.
  async function get(path, label) {
    if (!apiKey) return null;
    if (state.calls >= maxCalls) {
      state.cut = true;
      return null;
    }
    // The platform allows a fixed number of external subrequests in one
    // invocation and the count is shared with the other sources, so the feed
    // leaves the reserve alone and stops before the cap rather than being
    // killed with nothing to show.
    if (usage && usage.limit && (usage.total || 0) + reserve >= usage.limit) {
      state.cut = true;
      return null;
    }
    if (deadline && Date.now() > deadline) {
      state.cut = true;
      return null;
    }
    const url = new URL(WM_BASE + path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WM_TIMEOUT_MS);
    state.calls += 1;
    if (usage) {
      usage.total = (usage.total || 0) + 1;
      usage.calls = (usage.calls || 0) + 1;
    }
    try {
      const response = await (fetchImpl || fetch)(url.toString(), {
        signal: controller.signal,
        headers: { accept: 'application/json', 'X-API-Key': apiKey },
      });
      if (response.status === 401 || response.status === 403) {
        note(label + ' · the API key was rejected — check WATCHMODE_API_KEY');
        return null;
      }
      if (response.status === 429) {
        note(label + ' · rate limited (Watchmode allows 120 requests a minute)');
        return null;
      }
      if (!response.ok) {
        note(label + ' · HTTP ' + response.status);
        return null;
      }
      return await response.json();
    } catch (error) {
      note(label + ' · ' + (error && error.message ? error.message : 'request failed'));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // One slice of the feed: read from the cache when it is there, and split
  // further when it comes back full.
  async function slice(from, to, depth) {
    const key = 'wm:/releases?start_date=' + dayParam(from) + '&end_date=' + dayParam(to);
    if (cache) {
      const hit = await cache.get(key, cacheAge(from, to));
      if (hit) {
        state.cached += 1;
        const parsed = readCache(hit);
        return { rows: parsed.rows, truncated: Boolean(parsed.truncated) };
      }
    }
    const query = new URLSearchParams({
      start_date: dayParam(from),
      end_date: dayParam(to),
      limit: String(WM_PAGE_LIMIT),
    });
    const data = await get('/releases?' + query.toString(), 'Watchmode releases');
    if (!data || !Array.isArray(data.releases)) return { rows: [], truncated: false };
    const rows = data.releases;
    if (rows.length >= WM_PAGE_LIMIT && depth < WM_MAX_SPLIT) {
      const middle = addDays(from, Math.floor(spanDays(from, to) / 2) - 1);
      if (middle >= from && middle < to) {
        const first = await slice(from, middle, depth + 1);
        const second = await slice(addDays(middle, 1), to, depth + 1);
        const truncated = first.truncated || second.truncated;
        // The two halves cover the same days as the whole, so the whole's own
        // rows are dropped rather than counted twice.
        const combined = first.rows.concat(second.rows);
        if (cache) await cache.set(key, JSON.stringify({ rows: combined, truncated }));
        return { rows: combined, truncated };
      }
    }
    // A single day that still fills the ceiling is beyond splitting: it is
    // reported rather than silently taken as the whole day.
    const truncated = rows.length >= WM_PAGE_LIMIT;
    if (cache) await cache.set(key, JSON.stringify({ rows, truncated }));
    return { rows, truncated };
  }

  /**
   * The per-service release feed for a window.
   *
   * @returns {{rows: object[], truncated: boolean, from: string, to: string, beyond: boolean}}
   */
  async function releases(from, to) {
    const rows = [];
    let truncated = false;
    // How far the feed reaches: the last day of the weeks it can answer for.
    const reach = addDays(mondayOf(now), WM_HORIZON_WEEKS * WM_SLICE_DAYS - 1);
    // A window that starts beyond that is answered for the close weeks
    // instead: a service cannot date a release a year out, and the answer
    // says that it did not cover the window it was given.
    const beyond = from > reach;
    const start = beyond ? mondayOf(now) : mondayOf(from);
    const needed = Math.ceil(spanDays(start, sundayOf(to)) / WM_SLICE_DAYS);
    const count = Math.max(1, Math.min(needed, WM_HORIZON_WEEKS));
    const slices = [];
    for (let index = 0; index < count; index += 1) {
      const sliceFrom = addDays(start, index * WM_SLICE_DAYS);
      slices.push([sliceFrom, addDays(sliceFrom, WM_SLICE_DAYS - 1)]);
    }
    for (const [sliceFrom, sliceTo] of slices) {
      const got = await slice(sliceFrom, sliceTo, 0);
      rows.push(...got.rows);
      if (got.truncated) truncated = true;
    }
    const lastEnd = slices.length ? slices[slices.length - 1][1] : start;
    return { rows, truncated, from: start, to: lastEnd, beyond };
  }

  /**
   * The Watchmode id for a TMDB id.
   *
   * @param {number} tmdbId
   * @param {string} kind  'movie' or 'tv' — the index has a field for each
   * @returns {{ id: number, imdb: string, title: string }|null}
   */
  async function titleId(tmdbId, kind) {
    const show = kind === 'tv';
    const query = new URLSearchParams({
      search_field: show ? 'tmdb_tv_id' : 'tmdb_movie_id',
      search_value: String(tmdbId),
      types: show ? 'tv' : 'movie',
    });
    const data = await get('/search?' + query.toString(), 'Watchmode search');
    const results = (data && data.title_results) || [];
    const match = results.find(item => Number(item.tmdb_id) === Number(tmdbId)) || results[0];
    return match ? { id: match.id, imdb: match.imdb_id || '', title: match.name || '' } : null;
  }

  /**
   * The services carrying a title now.
   *
   * `wmId` skips the id lookup when the caller already has it — which is the
   * whole point of the cache: a title's Watchmode id never changes.
   *
   * @returns {object[]} the raw source rows
   */
  async function titleSources(tmdbId, wmId, kind) {
    const id = wmId || (await titleId(tmdbId, kind));
    if (!id) return [];
    const data = await get('/title/' + id.id + '/sources', 'Watchmode sources');
    return Array.isArray(data) ? data : [];
  }

  /** The source directory: every service Watchmode knows, with its type. */
  async function sources() {
    const data = await get('/sources', 'Watchmode source list');
    return Array.isArray(data) ? data : [];
  }

  return {
    enabled: Boolean(apiKey),
    calls: state,
    releases,
    titleId,
    titleSources,
    sources,
    WM_SOURCE_TYPES,
  };
}

// A written-down answer, read back. The cache holds JSON, but a caller may
// hold anything at all, so both shapes are read.
function readCache(value) {
  if (!value) return { rows: [], truncated: false };
  if (typeof value === 'object') return { rows: value.rows || [], truncated: Boolean(value.truncated) };
  try {
    const parsed = JSON.parse(value);
    return { rows: (parsed && parsed.rows) || [], truncated: Boolean(parsed && parsed.truncated) };
  } catch (error) {
    return { rows: [], truncated: false };
  }
}

// A release row, read the way the calendar needs it. The service name is the
// platform, and the service's own date is the date the calendar shows: it is
// the day the title arrived there, which is what a release calendar is about.
function releaseFilm(row) {
  const tmdbId = Number(row && row.tmdb_id) || 0;
  return {
    id: tmdbId,
    title: String((row && row.title) || '').trim(),
    date: String((row && row.source_release_date) || '').slice(0, 10),
    platform: String((row && row.source_name) || '').trim(),
    // A season drop rather than a film: the calendar's episode half is
    // TVmaze's, and a series premiere it does not carry is counted, not faked.
    series: String((row && row.type) || '') === 'tv_series',
    season: Number(row && row.season_number) || 0,
    imdb: String((row && row.imdb_id) || ''),
  };
}

// The service rows of one title, reduced to the services that are on the
// watchlist's platform list. The type is the filter: a rental or a purchase
// is not a release on a platform, and the calendar's platforms are the
// subscription services the watchlist logs.
function serviceFilms(rows, platformFor) {
  const names = [];
  rows.forEach(row => {
    const type = String((row && row.type) || '').toLowerCase();
    if (type && WM_SOURCE_TYPES.indexOf(type) === -1) return;
    const label = platformFor((row && row.name) || '');
    if (label && names.indexOf(label) === -1) names.push(label);
  });
  return names;
}

module.exports = {
  createWatchmode,
  releaseFilm,
  serviceFilms,
  WM_BASE,
  WM_PAGE_LIMIT,
  WM_SLICE_DAYS,
  WM_HORIZON_WEEKS,
  WM_SOURCE_TYPES,
};

// The Watchmode source layer: the client, the D1 cache and the calendar's film
// path that uses them.
//
// Every test here runs against a stubbed fetch — no network, no credits, no
// API key. The shapes the stubs answer with are the ones the API documents:
// a release row carries the service it landed on and that service's own date,
// a title's sources carry the service and its type ('sub', 'free', 'tve' and
// the rentals 'rent' and 'buy'), and a search is asked for by the kind of TMDB
// id it has ('tmdb_movie_id' for a film, 'tmdb_tv_id' for a show).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const watchmode = require("../netlify/functions/lib/watchmode.js");
const calendar = require("../netlify/functions/calendar.js");
const db = require("../netlify/functions/lib/db.js");

const { createWatchmode, releaseFilm, serviceFilms } = watchmode;

/** A fetch that answers from a handler and records what it was asked. */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const answer = (await handler(String(url), options)) || {};
    const status = answer.status === undefined ? 200 : answer.status;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return answer.body === undefined ? {} : answer.body;
      },
    };
  };
  return { impl, calls };
}

/** The D1 binding, as small as the cache accessors need: two tables. */
function fakeD1() {
  const cache = new Map();
  const lookups = new Map();
  const statements = [];
  const binding = {
    prepare(sql) {
      statements.push(sql);
      const text = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...params) {
          return {
            async all() {
              if (/SELECT 1 FROM wm_cache/.test(text)) return { results: [{ "1": 1 }] };
              if (/FROM wm_cache/.test(text)) {
                const row = cache.get(String(params[0]));
                return { results: row ? [row] : [] };
              }
              if (/FROM wm_lookups/.test(text)) {
                const row = lookups.get(Number(params[0]));
                return { results: row ? [row] : [] };
              }
              return { results: [] };
            },
            async run() {
              if (/INTO wm_cache/.test(text)) {
                cache.set(String(params[0]), {
                  key: String(params[0]),
                  value: String(params[1]),
                  updated_at: String(params[2]),
                });
                return { meta: { changes: 1 } };
              }
              if (/INTO wm_lookups/.test(text)) {
                lookups.set(Number(params[0]), {
                  tmdb_id: Number(params[0]),
                  title: String(params[1]),
                  poster: String(params[2]),
                  rating: Number(params[3]),
                  popularity: Number(params[4]),
                  updated_at: String(params[5]),
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  return { binding, cache, lookups, statements };
}

/** A D1 whose tables do not exist — a site whose migration has not been run. */
const missingTablesD1 = {
  prepare() {
    return {
      bind() {
        return {
          async all() {
            throw new Error("no such table: wm_cache");
          },
          async run() {
            throw new Error("no such table: wm_cache");
          },
        };
      },
    };
  },
};

// ── THE CLIENT ────────────────────────────────────────────────────────────

test("the release feed is asked for in week slices, with the key in a header", async () => {
  const { impl, calls } = stubFetch(() => ({ body: { releases: [] } }));
  const client = createWatchmode({ key: "wm-test", fetchImpl: impl, today: "2026-10-01" });
  await client.releases("2026-10-01", "2026-10-16");
  assert.equal(calls.length, 3, "16 days is three whole weeks");
  assert.match(calls[0].url, /\/v1\/releases\?/);
  // The slices sit on a fixed weekly grid, so a window that starts mid-week
  // is covered from the Monday of that week and the same week is the same
  // week every time it is asked for.
  assert.match(calls[0].url, /start_date=20260928/);
  assert.match(calls[0].url, /end_date=20261004/);
  assert.match(calls[1].url, /start_date=20261005/);
  assert.match(calls[1].url, /end_date=20261011/);
  assert.match(calls[2].url, /start_date=20261012/);
  assert.match(calls[2].url, /end_date=20261018/);
  assert.equal(calls[0].options.headers["X-API-Key"], "wm-test");
  assert.ok(!calls[0].url.includes("wm-test"), "the key is not in the URL");
});

test("a slice that comes back full is split rather than taken at face value", async () => {
  // A busy week answers with the endpoint's own ceiling of 250 rows, so the
  // slice is halved and asked for again.
  const { impl, calls } = stubFetch(url => {
    const params = new URL(url).searchParams;
    const from = params.get("start_date");
    const to = params.get("end_date");
    const days =
      (Date.parse(to.slice(0, 4) + "-" + to.slice(4, 6) + "-" + to.slice(6, 8)) -
        Date.parse(from.slice(0, 4) + "-" + from.slice(4, 6) + "-" + from.slice(6, 8))) /
        86400000 +
      1;
    const count = Math.min(250, days * 40);
    return {
      body: {
        releases: Array.from({ length: count }, (_, index) => ({
          id: index,
          title: "Film " + index,
          source_name: "Netflix",
          source_release_date: "2026-10-01",
        })),
      },
    };
  });
  const client = createWatchmode({ key: "k", fetchImpl: impl, today: "2026-10-01" });
  const { rows, truncated } = await client.releases("2026-10-01", "2026-10-07");
  // The window touches two whole weeks on the grid, and each of them came
  // back full, so each was asked for again in two pieces.
  assert.equal(calls.length, 6, "two full weeks, each asked for again in two");
  assert.equal(rows.length, 560, "every day's rows came back");
  assert.equal(truncated, false);
});

test("a day that fills the ceiling on its own is reported, not hidden", async () => {
  const { impl } = stubFetch(() => ({
    body: { releases: Array.from({ length: 250 }, (_, index) => ({ id: index, title: "F" + index })) },
  }));
  const client = createWatchmode({ key: "k", fetchImpl: impl, today: "2026-10-01" });
  const { truncated } = await client.releases("2026-10-01", "2026-10-02");
  assert.equal(truncated, true);
});

test("the feed is asked for at most six weeks ahead", async () => {
  const { impl, calls } = stubFetch(() => ({ body: { releases: [] } }));
  const client = createWatchmode({ key: "k", fetchImpl: impl, today: "2026-10-01" });
  const { from, to, beyond } = await client.releases("2026-10-01", "2027-06-30");
  assert.equal(beyond, false, "this window starts inside the feed's reach");
  assert.equal(from, "2026-09-28", "the first whole week the window touches");
  assert.equal(to, "2026-11-15", "45 days ahead, and no further");
  assert.equal(calls.length, 7, "six weeks and a bit is seven slices");
  const last = new URL(calls[calls.length - 1].url).searchParams.get("end_date");
  assert.equal(last, "20261115");
});

test("a window inside six weeks is asked for whole", async () => {
  const { impl, calls } = stubFetch(() => ({ body: { releases: [] } }));
  const client = createWatchmode({ key: "k", fetchImpl: impl, today: "2026-10-01" });
  const { to } = await client.releases("2026-10-01", "2026-10-31");
  assert.equal(to, "2026-11-01", "the last week the month touches, whole");
  assert.equal(calls.length, 5, "a month is five weeks");
});

test("a window beyond the feed's reach is answered for the close weeks", async () => {
  // Next year, seen from this year: a service cannot date a release a year
  // out, so the feed is asked for the weeks that are close instead, and the
  // answer says that it did not cover the window it was given.
  const { impl, calls } = stubFetch(() => ({ body: { releases: [] } }));
  const client = createWatchmode({ key: "k", fetchImpl: impl, today: "2026-10-21" });
  const { from, to, beyond } = await client.releases("2027-01-01", "2027-12-31");
  assert.equal(beyond, true);
  assert.equal(from, "2026-10-19", "the close weeks, not the ones asked for");
  assert.equal(to, "2026-12-06");
  assert.equal(calls.length, 7);
  const first = new URL(calls[0].url).searchParams.get("start_date");
  assert.equal(first, "20261019");
});

test("two windows that overlap share the week between them", async () => {
  const store = new Map();
  const cache = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
  const { impl, calls } = stubFetch(() => ({ body: { releases: [] } }));
  const client = createWatchmode({ key: "k", fetchImpl: impl, cache, today: "2026-10-01" });
  await client.releases("2026-10-01", "2026-10-31");
  const october = calls.length;
  await client.releases("2026-11-01", "2026-11-30");
  assert.equal(october, 5, "October is five weeks");
  assert.equal(calls.length - october, 5, "November is six weeks, and the one they share was already paid for");
  assert.equal(client.calls.cached, 1, "the shared week came from the cache");
});

test("a week that has been and gone is cached for a month, one in play for hours", async () => {
  const ages = [];
  const cache = {
    async get(key, maxAge) {
      ages.push({ key, maxAge });
      return null;
    },
    async set() {},
  };
  const { impl } = stubFetch(() => ({ body: { releases: [] } }));
  const client = createWatchmode({ key: "k", fetchImpl: impl, cache, today: "2026-10-21" });
  await client.releases("2026-10-05", "2026-10-11");
  await client.releases("2026-10-19", "2026-10-25");
  await client.releases("2026-11-16", "2026-11-22");
  const ageFor = fragment => ages.find(entry => entry.key.includes(fragment)).maxAge;
  assert.equal(ageFor("start_date=20261005"), 60 * 24 * 30, "a week that has been cannot change");
  assert.equal(ageFor("start_date=20261019"), 60 * 6, "the week in play is re-read often");
  assert.equal(ageFor("start_date=20261116"), 60 * 24, "a week still to come settles");
});

test("a cached answer costs no credit", async () => {
  const store = new Map();
  const cache = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
  const { impl, calls } = stubFetch(() => ({ body: { releases: [{ id: 1, title: "One" }] } }));
  const client = createWatchmode({ key: "k", fetchImpl: impl, cache, today: "2026-10-01" });
  const first = await client.releases("2026-10-01", "2026-10-07");
  const second = await client.releases("2026-10-01", "2026-10-07");
  assert.equal(calls.length, 2, "the window touches two weeks, and the second read came from the cache");
  assert.deepEqual(second.rows, first.rows);
  assert.equal(client.calls.cached, 2);
});

test("the feed stops at the credit budget and says it was cut", async () => {
  const { impl, calls } = stubFetch(() => ({ body: { releases: [] } }));
  const client = createWatchmode({ key: "k", fetchImpl: impl, maxCalls: 1, today: "2026-10-01" });
  const { rows } = await client.releases("2026-10-01", "2026-10-30");
  assert.equal(calls.length, 1, "one credit spent, then the budget said stop");
  assert.equal(client.calls.cut, true);
  assert.equal(rows.length, 0);
});

test("the feed stops before the platform's subrequest cap", async () => {
  // The platform allows a fixed number of external subrequests in one
  // invocation and the count is shared with the other sources: past it the
  // request is killed with nothing to show, so the feed stops before it.
  const usage = { total: 50, limit: 50 };
  const { impl, calls } = stubFetch(() => ({ body: { releases: [] } }));
  const client = createWatchmode({ key: "k", fetchImpl: impl, usage, today: "2026-10-01" });
  const { rows } = await client.releases("2026-10-01", "2026-10-07");
  assert.equal(calls.length, 0, "the invocation had no subrequest left and the feed did not take one");
  assert.equal(client.calls.cut, true);
  assert.equal(usage.total, 50, "nothing was spent");
  assert.equal(rows.length, 0);
});

test("the feed leaves the reserve for the films it found", async () => {
  // The last few subrequests of an invocation belong to the records the feed's
  // own films need and to the episode half running beside it.
  const usage = { total: 38, limit: 50 };
  const { impl, calls } = stubFetch(() => ({ body: { releases: [] } }));
  const client = createWatchmode({ key: "k", fetchImpl: impl, usage, reserve: 12, today: "2026-10-01" });
  await client.releases("2026-10-01", "2026-10-07");
  assert.equal(calls.length, 0, "the reserve was not spent on the feed");
  assert.equal(client.calls.cut, true);
});

test("a rejected key is a warning, not a crash", async () => {
  const warnings = [];
  const { impl } = stubFetch(() => ({ status: 401, body: { error: "nope" } }));
  const client = createWatchmode({ key: "bad", fetchImpl: impl, warnings, today: "2026-10-01" });
  const { rows } = await client.releases("2026-10-01", "2026-10-07");
  assert.equal(rows.length, 0);
  assert.ok(warnings.some(text => /key was rejected/i.test(text)), warnings.join(" | "));
});

test("a title's services are found by the kind of TMDB id it has", async () => {
  const { impl, calls } = stubFetch(url => {
    if (url.includes("/v1/search")) {
      return {
        body: {
          title_results: [{ id: 4242, name: "Noi un po' meglio", tmdb_id: 1541477, imdb_id: "tt1234567" }],
        },
      };
    }
    return {
      body: [
        { source_id: 203, name: "Netflix", type: "sub", region: "US" },
        { source_id: 8, name: "Amazon Prime Video", type: "rent", region: "US" },
        { source_id: 9, name: "Max", type: "sub", region: "US" },
        { source_id: 10, name: "Tubi", type: "free", region: "US" },
        { source_id: 11, name: "DirecTV", type: "tve", region: "US" },
      ],
    };
  });
  const client = createWatchmode({ key: "k", fetchImpl: impl });
  const rows = await client.titleSources(1541477, 0, "movie");
  assert.match(calls[0].url, /search_field=tmdb_movie_id/);
  assert.match(calls[0].url, /search_value=1541477/);
  assert.match(calls[0].url, /types=movie/);
  assert.match(calls[1].url, /\/v1\/title\/4242\/sources/);

  const platforms = {
    Netflix: "Netflix",
    "Amazon Prime Video": "Amazon Prime Video",
    Max: "HBO Max",
    Tubi: "",
    DirecTV: "",
  };
  const names = serviceFilms(rows, name => platforms[name] || "");
  assert.deepEqual(names, ["Netflix", "HBO Max"], "a rental is not a release on a platform");
});

test("a show is searched for by its TV id, not its movie id", async () => {
  const { impl, calls } = stubFetch(() => ({ body: { title_results: [] } }));
  const client = createWatchmode({ key: "k", fetchImpl: impl });
  await client.titleSources(1396, 0, "tv");
  assert.match(calls[0].url, /search_field=tmdb_tv_id/);
  assert.match(calls[0].url, /search_value=1396/);
});

// ── THE RELEASE ROW ───────────────────────────────────────────────────────

test("a TV movie is a film and a series with a season is a season drop", () => {
  const film = releaseFilm({
    tmdb_id: 1541477,
    tmdb_type: "movie",
    type: "movie",
    title: "YOU ME US",
    source_name: "Netflix",
    source_release_date: "2026-10-29",
  });
  assert.equal(film.series, false);
  assert.equal(film.platform, "Netflix");
  assert.equal(film.date, "2026-10-29");
  assert.equal(film.id, 1541477);

  const tvMovie = releaseFilm({
    tmdb_id: 5,
    tmdb_type: "movie",
    type: "tv_movie",
    title: "A TV movie",
    source_name: "Hulu",
    source_release_date: "2026-10-01",
  });
  assert.equal(tvMovie.series, false, "a TV movie is still a film");

  const series = releaseFilm({
    tmdb_id: 9,
    tmdb_type: "tv",
    type: "tv_series",
    title: "A series",
    source_name: "Netflix",
    source_release_date: "2026-10-01",
    season_number: 2,
  });
  assert.equal(series.series, true);
  assert.equal(series.season, 2);
});

// ── THE D1 CACHE ───────────────────────────────────────────────────────────

test("a cached answer is written and read back", async () => {
  const d1 = fakeD1();
  db.setDatabase(d1.binding);
  assert.equal(await db.writeWmCache("wm:/releases?start_date=20261001", '{"releases":[]}'), true);
  assert.equal(await db.readWmCache("wm:/releases?start_date=20261001", 60), '{"releases":[]}');
  assert.equal(await db.readWmCache("wm:/releases?start_date=20261001", 60 * 24 * 7), '{"releases":[]}');
  db.setDatabase(null);
});

test("an answer older than it is worth is not used", async () => {
  const d1 = fakeD1();
  db.setDatabase(d1.binding);
  await db.writeWmCache("wm:old", "value");
  const row = d1.cache.get("wm:old");
  row.updated_at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  assert.equal(await db.readWmCache("wm:old", 60), null, "an hour-old answer is stale");
  assert.equal(await db.readWmCache("wm:old", 60 * 24), "value", "a day-old answer is still worth something");
  db.setDatabase(null);
});

test("a film record is written once and read back", async () => {
  const d1 = fakeD1();
  db.setDatabase(d1.binding);
  await db.writeWmLookup({
    tmdbId: 1541477,
    title: "YOU ME US",
    poster: "https://image.tmdb.org/t/p/w185/you.jpg",
    rating: 7.4,
    popularity: 12,
  });
  const record = await db.readWmLookup(1541477);
  assert.equal(record.title, "YOU ME US");
  assert.equal(record.rating, 7.4);
  assert.equal(record.popularity, 12);
  assert.equal(await db.readWmLookup(999), null);
  db.setDatabase(null);
});

test("a site whose migration has not been applied still answers", async () => {
  // A fresh module, so the "the tables are not there" answer is not remembered
  // from an earlier test.
  const path = require.resolve("../netlify/functions/lib/db.js");
  delete require.cache[path];
  const fresh = require(path);
  fresh.setDatabase(missingTablesD1);
  assert.equal(await fresh.readWmCache("wm:anything", 60), null);
  assert.equal(await fresh.writeWmCache("wm:anything", "value"), false);
  assert.equal(await fresh.readWmLookup(1541477), null);
  assert.equal(await fresh.writeWmLookup({ tmdbId: 1541477, title: "x" }), false);
  fresh.setDatabase(null);
});

// ── THE CALENDAR'S FILM PATH ──────────────────────────────────────────────

/** '20261001' as '2026-10-01'. */
const day = value => (String(value || "").length === 8 ? value.slice(0, 4) + "-" + value.slice(4, 6) + "-" + value.slice(6, 8) : value);

/** The upstream answers a calendar request gets, with the feed's rows. */
function calendarUpstream(releases, tmdbFilms = []) {
  const calls = [];
  const impl = async url => {
    const text = String(url);
    calls.push(text);
    let body = {};
    if (text.includes("api.watchmode.com")) {
      if (text.includes("/v1/releases")) {
        // The feed is asked for in slices, and a slice answers with the rows
        // in its own days only.
        const params = new URL(text).searchParams;
        const from = day(params.get("start_date"));
        const to = day(params.get("end_date"));
        body = {
          releases: releases.filter(
            row => !row.source_release_date || (row.source_release_date >= from && row.source_release_date <= to),
          ),
        };
      } else if (text.includes("/v1/search")) {
        body = { title_results: [{ id: 4242, name: "Noi un po' meglio", tmdb_id: 1541477, imdb_id: "tt1234567" }] };
      } else if (text.includes("/v1/title/")) {
        body = [{ source_id: 203, name: "Netflix", type: "sub", region: "US" }];
      }
    } else if (text.includes("/search/multi")) {
      body = {
        results: [
          {
            id: 1541477,
            media_type: "movie",
            title: "YOU ME US",
            release_date: "2026-10-29",
            poster_path: "/youmeus.jpg",
            vote_average: 7.4,
            popularity: 12.34,
          },
        ],
      };
    } else if (text.includes("/watch/providers/movie")) {
      body = { results: [{ provider_name: "Netflix", provider_id: 8, display_priorities: { US: 1 } }] };
    } else if (text.includes("/watch/providers")) {
      // No service at all: this is the case the service feed is there for.
      body = { results: {} };
    } else if (text.includes("/discover/movie")) {
      body = { results: tmdbFilms };
    } else if (/\/movie\/\d+\?/.test(text)) {
      body = {
        id: 1541477,
        title: "YOU ME US",
        poster_path: "/youmeus.jpg",
        vote_average: 7.4,
        popularity: 12.34,
      };
    }
    return { ok: true, status: 200, async json() { return body; } };
  };
  return { impl, calls };
}

const withEnv = async (vars, run) => {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const calendarRequest = (query = {}) => ({
  httpMethod: "GET",
  headers: {},
  queryStringParameters: {
    from: "2026-10-01",
    to: "2026-10-30",
    region: "US",
    include: "movies",
    ...query,
  },
});

test("a film no provider filter can reach arrives through the service feed", async () => {
  // The measured case: TMDB lists no watch provider for this film in any
  // region, so no provider-filtered query returns it — and the service feed
  // carries it anyway.
  const { impl, calls } = calendarUpstream([
    {
      id: 1,
      title: "Noi un po' meglio",
      type: "movie",
      tmdb_id: 1541477,
      tmdb_type: "movie",
      imdb_id: "tt1234567",
      season_number: null,
      poster_url: null,
      source_release_date: "2026-10-29",
      source_id: 203,
      source_name: "Netflix",
      is_original: 1,
    },
  ]);
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const response = await withEnv(
      { TMDB_API_KEY: "tmdb-test", WATCHMODE_API_KEY: "wm-test" },
      () => calendar.handler(calendarRequest()),
    );
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);

    const film = body.movies.find(item => item.id === 1541477);
    assert.ok(film, "the film the feed named is in the month");
    assert.deepEqual(film.providers, ["Netflix"]);
    assert.equal(film.date, "2026-10-29");
    assert.equal(film.title, "YOU ME US", "the title is TMDB's, not the feed's");
    assert.equal(film.poster, "https://image.tmdb.org/t/p/w185/youmeus.jpg");
    assert.equal(film.rating, 7.4);

    assert.ok(body.coverage.watchmode, "the coverage says where the films came from");
    assert.equal(body.coverage.watchmode.enabled, true);
    assert.equal(body.coverage.watchmode.added, 1);
    assert.equal(body.coverage.watchmode.arrivals, 1);
    assert.equal(body.coverage.tmdb, body.movies.length - 1);
    assert.ok(calls.some(url => url.includes("api.watchmode.com/v1/releases")));
  } finally {
    globalThis.fetch = original;
  }
});

test("a service the calendar is not for is dropped at the fetch boundary", async () => {
  const { impl } = calendarUpstream([
    {
      id: 2,
      title: "Something on a service nobody logs",
      type: "movie",
      tmdb_id: 4242,
      tmdb_type: "movie",
      source_release_date: "2026-10-10",
      source_name: "SomeStreamingService",
      is_original: 0,
    },
  ]);
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const body = JSON.parse(
      (
        await withEnv({ TMDB_API_KEY: "tmdb-test", WATCHMODE_API_KEY: "wm-test" }, () =>
          calendar.handler(calendarRequest()),
        )
      ).body,
    );
    assert.equal(body.movies.find(item => item.id === 4242), undefined);
    assert.equal(body.coverage.watchmode.other, 1, "the arrival is counted, not silently dropped");
    assert.equal(body.coverage.watchmode.added, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("one film on two services is one entry with two labels", async () => {
  const { impl } = calendarUpstream([
    {
      id: 3,
      title: "YOU ME US",
      type: "movie",
      tmdb_id: 1541477,
      tmdb_type: "movie",
      source_release_date: "2026-10-29",
      source_name: "Netflix",
      is_original: 1,
    },
    {
      id: 4,
      title: "YOU ME US",
      type: "movie",
      tmdb_id: 1541477,
      tmdb_type: "movie",
      source_release_date: "2026-10-30",
      source_name: "Prime Video",
      is_original: 0,
    },
  ]);
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const body = JSON.parse(
      (
        await withEnv({ TMDB_API_KEY: "tmdb-test", WATCHMODE_API_KEY: "wm-test" }, () =>
          calendar.handler(calendarRequest()),
        )
      ).body,
    );
    const films = body.movies.filter(item => item.id === 1541477);
    assert.equal(films.length, 1, "one film, one entry");
    assert.deepEqual(films[0].providers, ["Netflix", "Amazon Prime Video"], "the service names are the watchlist's own");
    assert.equal(films[0].date, "2026-10-29", "the earliest arrival is the film's date");
  } finally {
    globalThis.fetch = original;
  }
});

test("the calendar is the same without a service-feed key", async () => {
  const { impl, calls } = calendarUpstream([
    {
      id: 5,
      title: "YOU ME US",
      type: "movie",
      tmdb_id: 1541477,
      tmdb_type: "movie",
      source_release_date: "2026-10-29",
      source_name: "Netflix",
      is_original: 1,
    },
  ]);
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const response = await withEnv({ TMDB_API_KEY: "tmdb-test", WATCHMODE_API_KEY: undefined }, () =>
      calendar.handler(calendarRequest()),
    );
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.coverage.watchmode.enabled, false, "the coverage says the source is off");
    assert.equal(body.movies.find(item => item.id === 1541477), undefined);
    assert.ok(!calls.some(url => url.includes("api.watchmode.com")), "no credit was spent");
  } finally {
    globalThis.fetch = original;
  }
});

test("a title asked for by name is attributed when TMDB lists no service", async () => {
  const { impl, calls } = calendarUpstream([], []);
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const response = await withEnv({ TMDB_API_KEY: "tmdb-test", WATCHMODE_API_KEY: "wm-test" }, () =>
      calendar.handler({
        httpMethod: "GET",
        headers: {},
        queryStringParameters: { title: "YOU ME US", region: "US", include: "search" },
      }),
    );
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.movies.length, 1);
    assert.deepEqual(body.movies[0].providers, ["Netflix"], "the service feed named the service");
    // The title was looked up in the feed by the kind of TMDB id it has.
    const searched = calls.find(url => url.includes("/v1/search"));
    assert.ok(searched, "the title was looked up in the service feed");
    assert.match(searched, /search_field=tmdb_movie_id/);
    assert.match(searched, /search_value=1541477/);
  } finally {
    globalThis.fetch = original;
  }
});

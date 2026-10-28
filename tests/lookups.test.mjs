// The two public endpoints that spend a third party's quota: tmdb-search and
// imdb-id. Both are world-callable with no session, and neither was limited -
// while a single INSERT on the same origin was. The ceiling is per tier because
// the page legitimately asks for one lookup per title it shows.
//
// The limiter is in-memory and per instance, so each test claims its own client
// IP: the window is keyed by IP, and sharing one across tests would make their
// order matter.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const search = require("../netlify/functions/tmdb-search.js");
const imdb = require("../netlify/functions/imdb-id.js");
const { MAX_FULL_LOOKUPS, MAX_LIGHT_LOOKUPS } = require("../netlify/functions/lib/throttle.js");

const answer = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() {
    return body;
  },
});

/** One TMDB (and OMDb-free) upstream, answering by URL. */
function upstream() {
  const calls = [];
  const impl = async url => {
    const text = String(url);
    calls.push(text);
    if (text.includes("/search/multi")) {
      return answer({
        results: [
          { id: 438631, media_type: "movie", title: "Dune", vote_average: 7.8, poster_path: "/dune.jpg" },
        ],
      });
    }
    if (text.includes("/external_ids")) return answer({ imdb_id: "tt1160419" });
    if (text.includes("/watch/providers")) return answer({ results: { US: { flatrate: [{ provider_id: 8, provider_name: "Netflix" }] } } });
    if (/\/movie\/\d+\?/.test(text)) {
      return answer({ id: 438631, title: "Dune", runtime: 155, genres: [{ name: "Science Fiction" }] });
    }
    return answer({});
  };
  return { impl, calls };
}

const request = (query, ip) => ({
  httpMethod: "GET",
  headers: { "x-nf-client-connection-ip": ip },
  queryStringParameters: query,
});

async function withUpstream(run) {
  const { impl, calls } = upstream();
  const original = globalThis.fetch;
  const saved = process.env.TMDB_API_KEY;
  globalThis.fetch = impl;
  process.env.TMDB_API_KEY = "tmdb-test";
  delete process.env.OMDB_API_KEY;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
    if (saved === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = saved;
  }
}

test("the full lookup path is bounded per client", async () => {
  await withUpstream(async calls => {
    const ip = "203.0.113.10";
    for (let i = 0; i < MAX_FULL_LOOKUPS; i++) {
      const response = await search.handler(request({ title: "Dune", type: "movie" }, ip));
      assert.equal(response.statusCode, 200, "the page's own autofill still works");
    }
    const spent = calls.length;
    const refused = await search.handler(request({ title: "Dune", type: "movie" }, ip));
    assert.equal(refused.statusCode, 429, "the ceiling is the ceiling");
    assert.ok(Number(refused.headers["Retry-After"]) > 0);
    assert.equal(calls.length, spent, "and a refused call costs no upstream request");

    // A different client is unaffected: this bounds a caller, not the service.
    const other = await search.handler(request({ title: "Dune", type: "movie" }, "203.0.113.11"));
    assert.equal(other.statusCode, 200);
  });
});

test("a light lookup is cached at the edge and has its own ceiling", async () => {
  await withUpstream(async () => {
    const ip = "203.0.113.20";
    for (let i = 0; i < MAX_FULL_LOOKUPS + 1; i++) {
      await search.handler(request({ title: "Dune", type: "movie" }, ip));
    }
    // The exclusive tier must not close the poster/rating path: one full pass of
    // budgets is not what "Load all ratings" spends.
    const light = await search.handler(request({ light: "1", title: "Dune", type: "movie" }, ip));
    assert.equal(light.statusCode, 200);
    assert.equal(light.headers["Cache-Control"], "public, max-age=86400", "a poster and an id do not change");

    // ...but the light path has a ceiling of its own.
    const rest = "203.0.113.21";
    for (let i = 0; i < MAX_LIGHT_LOOKUPS; i++) {
      const response = await search.handler(request({ light: "1", title: "Dune", type: "movie" }, rest));
      assert.equal(response.statusCode, 200);
    }
    const refused = await search.handler(request({ light: "1", title: "Dune", type: "movie" }, rest));
    assert.equal(refused.statusCode, 429);
  });
});

test("the IMDb id lookup is bounded too", async () => {
  await withUpstream(async calls => {
    const ip = "203.0.113.30";
    for (let i = 0; i < MAX_LIGHT_LOOKUPS; i++) {
      const response = await imdb.handler(request({ id: "438631" }, ip));
      assert.equal(response.statusCode, 200);
    }
    const spent = calls.length;
    const refused = await imdb.handler(request({ id: "438631" }, ip));
    assert.equal(refused.statusCode, 429, "a script varying the id cannot spend TMDB without limit");
    assert.equal(refused.headers["Cache-Control"], "no-store", "a refusal is never cached");
    assert.equal(calls.length, spent);
  });
});

test("a call that names no title is refused before it costs anything", async () => {
  await withUpstream(async calls => {
    const ip = "203.0.113.40";
    for (let i = 0; i < MAX_FULL_LOOKUPS + 5; i++) {
      const response = await search.handler(request({}, ip));
      assert.equal(response.statusCode, 400);
    }
    assert.equal(calls.length, 0, "a malformed request does not spend the allowance");
    const still = await search.handler(request({ title: "Dune", type: "movie" }, ip));
    assert.equal(still.statusCode, 200, "and does not use it up either");
  });
});

/**
 * Content Tracker — Cloudflare Worker.
 *
 * This file only adapts how the functions under netlify/functions/ are hosted. Wrangler bundles those files into this Worker, so the data layer, the
 * admin session, the throttles, the TMDB/OMDb lookups and the release calendar
 * all keep exactly one implementation — the one the site ran on.
 *
 * What the Netlify runtime used to provide, and what replaces it here:
 *
 *   storage     Netlify Database injected a Postgres connection string
 *               (NETLIFY_DB_URL, via @netlify/database) and lib/db.js ran `pg`.
 *               Here the Worker hands lib/db.js the D1 binding through
 *               setDatabase(), and that file — the only one that has ever known
 *               the schema — is written against D1 instead.
 *
 *   config      Netlify put the project's environment variables and secrets in
 *               process.env; Workers hand them over as bindings. They are copied
 *               onto process.env before any handler runs (nodejs_compat supplies
 *               the object), so the functions still read process.env.TMDB_API_KEY
 *               and the rest exactly as they always did.
 *
 *   routing     The paths the frontend already calls, /.netlify/functions/*, are
 *               served from here. `run_worker_first` in wrangler.toml is scoped
 *               to that prefix, so asset requests never invoke this Worker and
 *               are served straight from the assets layer.
 *
 *   client IP   The throttle damper keys its buckets on the caller's address. It
 *               looks for Netlify's header first and x-forwarded-for second, so
 *               Cloudflare's own CF-Connecting-IP is copied onto Netlify's name
 *               below. Without that every visitor would land in one bucket and
 *               the suggestion limiter would throttle the whole site at once.
 *
 * The handlers are called with the same event shape the Netlify functions
 * declare ({ httpMethod, headers, queryStringParameters, body }), and their
 * { statusCode, headers, body } result is turned straight back into a Response.
 */

import watchlistModule from "./netlify/functions/watchlist.js";
import goalModule from "./netlify/functions/goal.js";
import suggestionsModule from "./netlify/functions/suggestions.js";
import adminLoginModule from "./netlify/functions/admin-login.js";
import adminEntryModule from "./netlify/functions/admin-entry.js";
import adminImportModule from "./netlify/functions/admin-import.js";
import tmdbSearchModule from "./netlify/functions/tmdb-search.js";
import imdbIdModule from "./netlify/functions/imdb-id.js";
import calendarModule from "./netlify/functions/calendar.js";
import db from "./netlify/functions/lib/db.js";

const ROUTES = {
  "/.netlify/functions/watchlist": watchlistModule,
  "/.netlify/functions/goal": goalModule,
  "/.netlify/functions/suggestions": suggestionsModule,
  "/.netlify/functions/admin-login": adminLoginModule,
  "/.netlify/functions/admin-entry": adminEntryModule,
  "/.netlify/functions/admin-import": adminImportModule,
  "/.netlify/functions/tmdb-search": tmdbSearchModule,
  "/.netlify/functions/imdb-id": imdbIdModule,
  "/.netlify/functions/calendar": calendarModule,
};

/** Hand this request's bindings to the code that expects Netlify's shape. */
function wireBindings(env) {
  if (typeof process !== "undefined" && process.env) {
    for (const [key, value] of Object.entries(env)) {
      // Bindings that are not plain strings (D1, assets) have no environment
      // variable equivalent and are wired deliberately below.
      if (typeof value === "string") process.env[key] = value;
    }
  }
  if (env.DB) db.setDatabase(env.DB);
}

/** Build the event the functions are written against out of this request. */
async function toEvent(request, url) {
  const headers = {};
  for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
  if (!headers["x-nf-client-connection-ip"] && headers["cf-connecting-ip"]) {
    headers["x-nf-client-connection-ip"] = headers["cf-connecting-ip"];
  }
  const method = request.method;
  const event = {
    httpMethod: method,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
  };
  if (method !== "GET" && method !== "HEAD") event.body = await request.text();
  return event;
}

const jsonError = (status, message) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const mod = ROUTES[url.pathname];
    if (!mod) return env.ASSETS.fetch(request);

    wireBindings(env);

    try {
      const result = await mod.handler(await toEvent(request, url));
      return new Response(result.body, {
        status: result.statusCode || 200,
        headers: result.headers || {},
      });
    } catch (error) {
      console.error(`${url.pathname} failed:`, (error && error.stack) || error);
      return jsonError(500, String((error && error.message) || error));
    }
  },
};

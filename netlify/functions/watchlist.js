const db = require('./lib/db');

/* ── CORS: the one cross-origin read this endpoint allows ────────────────────
 * The portfolio shows a slice of this dashboard and reads this endpoint for it.
 * It is served from one host — https://parth-portfolio-wb.pages.dev, which every
 * link and self-reference in that repository uses. Its workers.dev address used
 * to be named here as a second origin; that deployment is gone, so the allowance
 * names the one host the site is actually served from.
 *
 * Reading the store this app itself renders is what stops the two disagreeing:
 * the portfolio used to read the Google Sheet, which stopped being the store
 * when the watchlist moved to D1, and its totals drifted from this page's as a
 * result.
 *
 * It has to be a browser read. The dashboard portal can do the read
 * server-side (see its watchlist-count function), but the portfolio is a static
 * site with no server to run a proxy on, so the allowance lives here, on the
 * response.
 *
 * Scoped to named origins, never `*`. These rows are public either way (this
 * page renders them), so this is hygiene rather than secrecy — but a wildcard
 * would cover every future caller, and the rule is easier to audit when it says
 * who it is for. localhost is allowed on any port because that is how the
 * portfolio is developed (a throwaway static server) and such an origin only
 * exists on the developer's own machine.
 */
const PORTFOLIO_ORIGINS = [
  'https://parth-portfolio-wb.pages.dev'
];
const ALLOWED_ORIGINS = [...PORTFOLIO_ORIGINS, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

function allowedOrigin(event) {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  if (!origin) return '';
  return ALLOWED_ORIGINS.some(allowed =>
    (allowed instanceof RegExp ? allowed.test(origin) : allowed === origin)) ? origin : '';
}

/* The echo travels with Vary: Origin. The rows are identical for every caller,
 * but a response that says "you, specifically, may read this" must not be
 * handed to the next caller by a shared cache. */
const cors = origin => (origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});

const json = (statusCode, body, extraHeaders) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=300',
    ...extraHeaders
  },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  const origin = allowedOrigin(event);

  /* Preflight. This endpoint is a plain GET and the portfolio sends no headers
     that would trigger one, but answering keeps the allowance honest for any
     caller that does — and the 405 this used to return is exactly what made a
     browser read of this endpoint look impossible. */
  if (event.httpMethod === 'OPTIONS') {
    if (!origin) return json(405, { error: 'Method not allowed' });
    return {
      statusCode: 204,
      headers: {
        ...cors(origin),
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '86400',
        'Cache-Control': 'no-store'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' }, cors(origin));

  /* The allowance goes on failures too, so a caller that is allowed to read this
     endpoint can read its error rather than seeing an opaque CORS rejection. */
  if (!db.dbEnabled()) return json(500, { error: 'Data service is not configured' }, cors(origin));

  const wants = event.queryStringParameters || {};
  const isGoalRead = wants.goal === '1';

  /* Rows and goal in one read. The dashboard's first load used to ask for these
     separately — `?goal=1` and then the list — which the 15 Oct 2026 sweep
     measured as two reads of the same store on one page load: 384 ms for the
     goal, 396 ms for the rows. The goal is one row of the settings table, so
     there was never a reason for the second round trip.

     The combined shape is opt-in (`rows=1&goal=1`) rather than the default,
     because the rows alone are what other callers read: the portfolio renders a
     slice of this store cross-origin from this endpoint and expects the array,
     so `?goal=1`, `?sheet=Suggestions` and a bare request keep answering exactly
     as they did. What changes for the combined read is only that the browser
     gets one response instead of two.

     The response carries the endpoint's usual five-minute cache. A goal set
     through /goal is reflected in the page immediately (setSharedGoal returns
     what it wrote) and across devices within that window, which is the same
     window the rows already had. */
  const isCombinedRead = isGoalRead && wants.rows === '1';

  try {
    if (isCombinedRead) {
      const [rows, goal] = await Promise.all([db.listEntries(), db.readGoal()]);
      return json(200, { rows, goal }, cors(origin));
    }
    if (isGoalRead) {
      const goal = await db.readGoal();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
        body: JSON.stringify(goal)
      };
    }
    const wantsSuggestions = event.queryStringParameters?.sheet === 'Suggestions';
    const rows = wantsSuggestions ? await db.listSuggestions() : await db.listEntries();
    return json(200, rows, cors(origin));
  } catch (error) {
    console.error('Watchlist read failed:', error);
    return json(502, { error: error.message || 'Unable to load data' }, cors(origin));
  }
};

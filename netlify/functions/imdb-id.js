// Resolves one title's IMDb page, for the calendar's links.
//
// The calendar links every release to IMDb rather than to the API the row came
// from. The episode half needs no help — TVmaze lists the show's IMDb id in the
// same payload the calendar already fetches, so `calendar.js` carries it for
// free. A film is the opposite case: TMDB's list endpoints (`/discover/movie`,
// the provider sweeps) carry no `imdb_id` at all, and only `/movie/{id}/`.
// external_ids has it. Asking for every film at calendar time would be one extra
// request per release — hundreds in a single month view — so a film's id is
// resolved the moment its title is clicked instead: one lookup, cached at the
// CDN for a day and in the browser beyond that, and the page falls back to an
// IMDb search when there is no id to be had.
//
// GET /.netlify/functions/imdb-id?id=<tmdb id>[&type=tv]
//   → { imdb: "https://www.imdb.com/title/tt0137523/" } or { imdb: null }
const TMDB = 'https://api.themoviedb.org/3';

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' }, { 'Cache-Control': 'no-store' });

  const params = event.queryStringParameters || {};
  const id = Number(params.id);
  // 'tv' exists for completeness — the calendar has no TMDB show ids today (its
  // episodes come from TVmaze), but the lookup is the same shape either way.
  const type = params.type === 'tv' ? 'tv' : 'movie';
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { error: 'A positive numeric id is required' }, { 'Cache-Control': 'no-store' });
  }

  const key = String(process.env.TMDB_API_KEY || '').trim();
  if (!key) return json(500, { error: 'TMDB is not configured in this environment' }, { 'Cache-Control': 'no-store' });

  try {
    const res = await fetch(`${TMDB}/${type}/${id}/external_ids?api_key=${encodeURIComponent(key)}`);
    if (!res.ok) {
      console.error('IMDb id lookup failed:', res.status, type, id);
      return json(502, { error: 'Could not look this title up', imdb: null }, { 'Cache-Control': 'no-store' });
    }
    const data = await res.json().catch(() => ({}));
    const imdb = String((data && data.imdb_id) || '').trim();
    // A null answer is a real answer (the film has no IMDb page on TMDB) — and it
    // is cached, so a title without one is not looked up on every click.
    return json(200, { imdb: /^tt\d+$/.test(imdb) ? 'https://www.imdb.com/title/' + imdb + '/' : null }, {
      'Cache-Control': 'public, max-age=86400'
    });
  } catch (error) {
    console.error('IMDb id lookup error:', error.message);
    return json(502, { error: 'Could not look this title up', imdb: null }, { 'Cache-Control': 'no-store' });
  }
};

const { pickMatch } = require('./lib/tmdb');
const { clientIp, lookupState, recordLookup } = require('./lib/throttle');

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body)
});

const clean = (value, max) => String(value || '').trim().slice(0, max);

// Which of TMDB's results is the title the caller meant? The rule lives in
// lib/tmdb.js because the calendar's own searches ask it too: an exact name
// outranks a popular near-miss ("You" must not match "Because I Want You"),
// and a known kind outranks a popular wrong one. Only when neither says
// anything does popularity decide.

async function omdbLookup(title, type) {
  if (!process.env.OMDB_API_KEY) return null;
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('apikey', process.env.OMDB_API_KEY);
  url.searchParams.set('t', title);
  url.searchParams.set('type', type === 'Movie' ? 'movie' : 'series');
  const response = await fetch(url);
  if (!response.ok) return null;
  const data = await response.json();
  return data.Response === 'True' ? data : null;
}

exports.handler = async event => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  if (!process.env.TMDB_API_KEY) return json(500, { error: 'TMDB is not configured' });

  const params = event.queryStringParameters || {};
  const title = clean(params.title, 160);
  const season = clean(params.season, 10);
  const type = clean(params.type, 20);
  if (!title) return json(400, { error: 'Title is required' });

  // This endpoint is world-callable and spends other people's quota — a TMDB
  // search plus external_ids here, and up to details, providers and an OMDb call
  // on the full path — while the one thing it does that anyone can reach is a
  // single INSERT, and that one is limited. So is this: the light tier allows a
  // whole ratings pass, the full tier (five upstream calls a request) is tighter.
  // Checked after validation, so a malformed call costs nothing.
  const light = params.light === '1';
  const tier = light ? 'light' : 'full';
  const ip = clientIp(event);
  const limit = lookupState(ip, tier);
  if (limit.limited) {
    return json(429, {
      error: `Too many lookups from this connection. Try again in ${limit.retryAfter} seconds.`
    }, { 'Retry-After': String(limit.retryAfter) });
  }
  recordLookup(ip, tier);

  // Lightweight poster + rating lookup — one TMDB search, no details/providers.
  if (light) {
    try {
      const searchUrl = new URL('https://api.themoviedb.org/3/search/multi');
      searchUrl.search = new URLSearchParams({ api_key: process.env.TMDB_API_KEY, query: title, include_adult: 'false', page: '1' });
      const searchResponse = await fetch(searchUrl);
      if (!searchResponse.ok) return json(502, { error: 'TMDB search failed' });
      const search = await searchResponse.json();
      const match = pickMatch(
        (search.results || []).filter(item => item.media_type === 'movie' || item.media_type === 'tv'),
        title,
        type
      );
      // OMDB (IMDb stars) first; fall back to the TMDB score if it's missing.
      // Both are 0-10, so clamp to that scale so the star display is consistent.
      // The IMDb id comes from the SAME TMDB match that produced the poster
      // (external_ids), so the Data-table link always lands on the exact title
      // page for what's shown; OMDB's imdbID is the backup when TMDB has none.
      let rating = null;
      let imdbId = null;
      if (match) {
        try {
          const extUrl = new URL('https://api.themoviedb.org/3/' + (match.media_type === 'movie' ? 'movie' : 'tv') + '/' + match.id + '/external_ids');
          extUrl.searchParams.set('api_key', process.env.TMDB_API_KEY);
          const extResponse = await fetch(extUrl);
          if (extResponse.ok) imdbId = (await extResponse.json()).imdb_id || null;
        } catch (e) { /* non-fatal — fall back to OMDB below */ }
        if (process.env.OMDB_API_KEY) {
          const omdb = await omdbLookup(match.name || match.title, match.media_type === 'movie' ? 'Movie' : 'Series');
          const imdb = Number(omdb?.imdbRating);
          if (Number.isFinite(imdb) && imdb > 0) rating = imdb;
          if (!imdbId && omdb?.imdbID) imdbId = omdb.imdbID;
        }
        if (rating == null) {
          const tmdbScore = Number(match.vote_average);
          if (Number.isFinite(tmdbScore) && tmdbScore > 0) rating = tmdbScore;
        }
        if (rating != null) rating = Math.max(0, Math.min(10, rating));
      }
      // A poster and an IMDb id never change, and a rating changes by a tenth at
      // most — so the answer is cacheable for a day, which is what makes the
      // ceiling above about *distinct titles* rather than about clicks.
      return json(200, {
        poster: match && match.poster_path ? 'https://image.tmdb.org/t/p/w185' + match.poster_path : null,
        rating,
        imdbId
      }, { 'Cache-Control': 'public, max-age=86400' });
    } catch (error) {
      return json(502, { error: 'Unable to reach the autofill service. Please try again.' });
    }
  }

  try {
    const searchUrl = new URL('https://api.themoviedb.org/3/search/multi');
    searchUrl.search = new URLSearchParams({ api_key: process.env.TMDB_API_KEY, query: title, include_adult: 'false', page: '1' });
    const searchResponse = await fetch(searchUrl);
    if (!searchResponse.ok) return json(502, { error: 'TMDB search failed' });

    const search = await searchResponse.json();
    const candidates = (search.results || []).filter(item => item.media_type === 'movie' || item.media_type === 'tv');
    const match = pickMatch(candidates, title, type);
    if (!match) return json(404, { error: 'No matching title found' });

    const isMovie = match.media_type === 'movie';
    const detailsUrl = new URL(`https://api.themoviedb.org/3/${isMovie ? 'movie' : 'tv'}/${match.id}`);
    detailsUrl.searchParams.set('api_key', process.env.TMDB_API_KEY);
    const detailsResponse = await fetch(detailsUrl);
    if (!detailsResponse.ok) return json(502, { error: 'TMDB details lookup failed' });
    const details = await detailsResponse.json();
    let providers = null;

    const providersUrl = new URL(`https://api.themoviedb.org/3/${isMovie ? 'movie' : 'tv'}/${match.id}/watch/providers`);
    providersUrl.searchParams.set('api_key', process.env.TMDB_API_KEY);
    const providersResponse = await fetch(providersUrl);
    if (providersResponse.ok) providers = await providersResponse.json();
    const regions = Object.values(providers?.results || {});
    const providerGroups = ['flatrate', 'free', 'ads', 'rent', 'buy'];
    const availableProviders = regions.flatMap(region => providerGroups.flatMap(group => region[group] || []));
    const uniqueProviders = [...new Map(availableProviders.map(provider => [provider.provider_id, provider])).values()];
    const platform = uniqueProviders[0]?.provider_name || details.networks?.[0]?.name || 'Unknown platform';
    const genre = details.genres?.[0]?.name || 'Uncategorized';
    const omdb = await omdbLookup(isMovie ? details.title : details.name, isMovie ? 'Movie' : 'Series');
    const omdbGenre = omdb?.Genre && omdb.Genre !== 'N/A' ? omdb.Genre : '';
    const omdbRuntime = parseInt(String(omdb?.Runtime || '').replace(/[^0-9]/g, ''), 10) || 0;
    const mergedGenre = genre !== 'Uncategorized' ? genre : omdbGenre || genre;

    // Series default to season 1 when the caller didn't name one, so the episode
    // count / runtime describe ONE season (what an entry means), not the whole
    // series across every season.
    let seasonDetails = null;
    let usedSeason = '';
    if (!isMovie) {
      const wantedSeason = /^\d{1,2}$/.test(season) ? Number(season) : 1;
      const seasonUrl = new URL(`https://api.themoviedb.org/3/tv/${match.id}/season/${wantedSeason}`);
      seasonUrl.searchParams.set('api_key', process.env.TMDB_API_KEY);
      const seasonResponse = await fetch(seasonUrl);
      if (seasonResponse.ok) {
        seasonDetails = await seasonResponse.json();
        usedSeason = String(wantedSeason);
      }
    }

    const runtime = isMovie
      ? details.runtime
      : seasonDetails?.episodes?.reduce((total, episode) => total + (episode.runtime || details.episode_run_time?.[0] || 0), 0) || 0;
    const mergedRuntime = runtime || omdbRuntime;
    const episodeCount = isMovie
      ? 0
      : seasonDetails?.episodes?.length || details.number_of_episodes || parseInt(omdb?.totalSeasons, 10) || 1;

    return json(200, {
      name: isMovie ? details.title : details.name,
      type: isMovie ? 'Movie' : 'Series/Show',
      genre: mergedGenre,
      platform,
      season: isMovie ? '' : usedSeason || season,
      // Whether the numbers below describe the asked-for season: without the
      // season payload the episode count falls back to the whole series, which
      // must never be written into a season row.
      seasonOk: isMovie ? true : Boolean(seasonDetails),
      episodes: episodeCount,
      screentime: mergedRuntime || (isMovie ? details.runtime || 0 : (details.episode_run_time?.[0] || omdbRuntime || 0) * episodeCount),
      source: 'TMDB'
    });
  } catch (error) {
    console.error('Autofill lookup failed:', error);
    return json(502, { error: 'Unable to reach the autofill service. Please try again.' });
  }
};

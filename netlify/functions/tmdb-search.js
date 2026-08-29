const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

const clean = (value, max) => String(value || '').trim().slice(0, max);

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

  const title = clean(event.queryStringParameters?.title, 160);
  const season = clean(event.queryStringParameters?.season, 10);
  if (!title) return json(400, { error: 'Title is required' });

  // Lightweight poster + rating lookup — one TMDB search, no details/providers.
  if (event.queryStringParameters?.light === '1') {
    try {
      const searchUrl = new URL('https://api.themoviedb.org/3/search/multi');
      searchUrl.search = new URLSearchParams({ api_key: process.env.TMDB_API_KEY, query: title, include_adult: 'false', page: '1' });
      const searchResponse = await fetch(searchUrl);
      if (!searchResponse.ok) return json(502, { error: 'TMDB search failed' });
      const search = await searchResponse.json();
      const match = (search.results || [])
        .filter(item => item.media_type === 'movie' || item.media_type === 'tv')
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
      // OMDB (IMDb stars) first; fall back to the TMDB score if it's missing.
      // Both are 0-10, so clamp to that scale so the star display is consistent.
      let rating = null;
      if (match) {
        if (process.env.OMDB_API_KEY) {
          const omdb = await omdbLookup(match.name || match.title, match.media_type === 'movie' ? 'Movie' : 'Series');
          const imdb = Number(omdb?.imdbRating);
          if (Number.isFinite(imdb) && imdb > 0) rating = imdb;
        }
        if (rating == null) {
          const tmdbScore = Number(match.vote_average);
          if (Number.isFinite(tmdbScore) && tmdbScore > 0) rating = tmdbScore;
        }
        if (rating != null) rating = Math.max(0, Math.min(10, rating));
      }
      return json(200, {
        poster: match && match.poster_path ? 'https://image.tmdb.org/t/p/w185' + match.poster_path : null,
        rating
      });
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
    const match = candidates.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
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

    let seasonDetails = null;
    if (!isMovie && season && /^\d{1,2}$/.test(season)) {
      const seasonUrl = new URL(`https://api.themoviedb.org/3/tv/${match.id}/season/${Number(season)}`);
      seasonUrl.searchParams.set('api_key', process.env.TMDB_API_KEY);
      const seasonResponse = await fetch(seasonUrl);
      if (seasonResponse.ok) seasonDetails = await seasonResponse.json();
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
      season: isMovie ? '' : season,
      episodes: episodeCount,
      screentime: mergedRuntime || (isMovie ? details.runtime || 0 : (details.episode_run_time?.[0] || omdbRuntime || 0) * episodeCount),
      source: 'TMDB'
    });
  } catch (error) {
    console.error('Autofill lookup failed:', error);
    return json(502, { error: 'Unable to reach the autofill service. Please try again.' });
  }
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

const clean = (value, max) => String(value || '').trim().slice(0, max);

exports.handler = async event => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  if (!process.env.TMDB_API_KEY) return json(500, { error: 'TMDB is not configured' });

  const title = clean(event.queryStringParameters?.title, 160);
  const season = clean(event.queryStringParameters?.season, 10);
  if (!title) return json(400, { error: 'Title is required' });

  try {
    const searchUrl = new URL('https://api.themoviedb.org/3/search/multi');
    searchUrl.search = new URLSearchParams({ api_key: process.env.TMDB_API_KEY, query: title, include_adult: 'false', page: '1' });
    const searchResponse = await fetch(searchUrl);
    if (!searchResponse.ok) return json(502, { error: 'TMDB search failed' });

    const search = await searchResponse.json();
    const match = (search.results || []).find(item => item.media_type === 'movie' || item.media_type === 'tv');
    if (!match) return json(404, { error: 'No matching title found' });

    const isMovie = match.media_type === 'movie';
    const detailsUrl = new URL(`https://api.themoviedb.org/3/${isMovie ? 'movie' : 'tv'}/${match.id}`);
    detailsUrl.searchParams.set('api_key', process.env.TMDB_API_KEY);
    const detailsResponse = await fetch(detailsUrl);
    if (!detailsResponse.ok) return json(502, { error: 'TMDB details lookup failed' });
    const details = await detailsResponse.json();

    let seasonDetails = null;
    if (!isMovie && season && /^\d{1,2}$/.test(season)) {
      const seasonUrl = new URL(`https://api.themoviedb.org/3/tv/${match.id}/season/${Number(season)}`);
      seasonUrl.searchParams.set('api_key', process.env.TMDB_API_KEY);
      const seasonResponse = await fetch(seasonUrl);
      if (seasonResponse.ok) seasonDetails = await seasonResponse.json();
    }

    const runtime = isMovie
      ? details.runtime
      : seasonDetails?.episodes?.reduce((total, episode) => total + (episode.runtime || details.episode_run_time?.[0] || 0), 0);

    return json(200, {
      name: isMovie ? details.title : details.name,
      type: isMovie ? 'Movie' : 'Series/Show',
      genre: details.genres?.[0]?.name || '',
      platform: details.networks?.[0]?.name || '',
      season: isMovie ? '' : season,
      episodes: isMovie ? 0 : seasonDetails?.episodes?.length || 0,
      screentime: runtime || 0,
      source: 'TMDB'
    });
  } catch {
    return json(502, { error: 'Unable to reach TMDB' });
  }
};

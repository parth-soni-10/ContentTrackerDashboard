const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const scriptUrl = process.env.SCRIPT_URL;
  if (!scriptUrl) return json(500, { error: 'Watchlist service is not configured' });

  const target = new URL(scriptUrl);
  if (event.queryStringParameters?.sheet === 'Suggestions') target.searchParams.set('sheet', 'Suggestions');

  try {
    const upstream = await fetch(target);
    const body = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body
    };
  } catch {
    return json(502, { error: 'Unable to load watchlist data' });
  }
};

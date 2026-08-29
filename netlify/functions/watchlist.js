const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const scriptUrl = process.env.SCRIPT_URL;
  if (!scriptUrl) return json(500, { error: 'Data service is not configured' });

  let target;
  try {
    target = new URL(scriptUrl);
    if (event.queryStringParameters?.sheet === 'Suggestions') {
      target.searchParams.set('sheet', 'Suggestions');
    }
  } catch {
    return json(500, { error: 'Data service URL is invalid' });
  }

  try {
    const upstream = await fetch(target, { redirect: 'follow' });
    const body = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' },
      body
    };
  } catch {
    return json(502, { error: 'Unable to load data' });
  }
};

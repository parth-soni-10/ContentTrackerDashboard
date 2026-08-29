const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const scriptUrl = process.env.SCRIPT_URL;
  if (!scriptUrl) return json(500, { error: 'Suggestion service is not configured' });
  try {
    const upstream = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: event.body || '{}'
    });
    const body = await upstream.text();
    return { statusCode: upstream.status, headers: { 'Content-Type': 'application/json' }, body };
  } catch {
    return json(502, { error: 'Unable to submit suggestion' });
  }
};

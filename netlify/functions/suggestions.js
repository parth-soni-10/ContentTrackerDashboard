const sheets = require('./lib/sheets');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

const clean = (value, max) => String(value || '').trim().slice(0, max);

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

  // Direct Sheets API mode — same fixed layout the old Apps Script appended.
  if (sheets.sheetsEnabled()) {
    const title = clean(body.Title || body.title, 160);
    if (!title) return json(400, { error: 'Title is required' });
    try {
      await sheets.appendPlainRow('Suggestions', [
        title,
        clean(body.Type || body.type, 30),
        clean(body.Genre || body.genre, 80),
        clean(body.Platform || body.platform, 80),
        clean(body.Note || body.note, 200),
        clean(body.Date || body.date, 40)
      ]);
      return json(200, { status: 'ok' });
    } catch (error) {
      console.error('Sheets API suggestion failed:', error);
      return json(502, { error: error.message || 'Unable to submit suggestion' });
    }
  }

  const scriptUrl = process.env.SCRIPT_URL;
  if (!scriptUrl) return json(500, { error: 'Suggestion service is not configured' });
  try {
    const upstream = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await upstream.text();
    return { statusCode: upstream.status, headers: { 'Content-Type': 'application/json' }, body: text };
  } catch {
    return json(502, { error: 'Unable to submit suggestion' });
  }
};

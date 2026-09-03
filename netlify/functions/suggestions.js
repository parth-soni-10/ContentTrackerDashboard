const sheets = require('./lib/sheets');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

const clean = (value, max) => String(value || '').trim().slice(0, max);

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!sheets.sheetsEnabled()) return json(500, { error: 'Suggestion service is not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

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
};

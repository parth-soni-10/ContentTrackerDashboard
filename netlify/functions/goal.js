const sheets = require('./lib/sheets');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!sheets.sheetsEnabled()) return json(500, { error: 'Goal service is not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

  const hrs = Number(body.hrs);
  const year = String(body.year || '').trim();
  if (!Number.isFinite(hrs) || hrs < 0 || hrs > 99999) return json(400, { error: 'A valid goal is required' });
  if (hrs > 0 && !/^\d{4}$/.test(year)) return json(400, { error: 'A valid year is required' });

  try {
    const result = await sheets.setGoal(hrs, year);
    return result.status === 'ok'
      ? json(200, { status: 'ok', goal: result.goal })
      : json(200, { status: 'error', message: result.message });
  } catch (error) {
    console.error('Sheets API goal write failed:', error);
    return json(502, { error: error.message || 'Unable to save the goal' });
  }
};

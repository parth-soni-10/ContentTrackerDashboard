const db = require('./lib/db');
const { clientIp, writeState, recordWrite } = require('./lib/throttle');

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body)
});

const clean = (value, max) => String(value || '').trim().slice(0, max);

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!db.dbEnabled()) return json(500, { error: 'Suggestion service is not configured' });

  // This endpoint is world-writable by design — it is how a visitor asks for a
  // title — so the limit is on volume per client, not on access. Throttling only
  // failures here would be useless: a script whose writes succeed would never be
  // slowed down, and the suggestions table is the thing being polluted.
  const ip = clientIp(event);
  const limit = writeState(ip);
  if (limit.limited) {
    return json(
      429,
      { error: `Too many suggestions from this connection. Try again in ${limit.retryAfter} seconds.` },
      { 'Retry-After': String(limit.retryAfter) }
    );
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

  const title = clean(body.Title || body.title, 160);
  if (!title) return json(400, { error: 'Title is required' });

  try {
    await db.appendSuggestion([
      title,
      clean(body.Type || body.type, 30),
      clean(body.Genre || body.genre, 80),
      clean(body.Platform || body.platform, 80),
      clean(body.Note || body.note, 200),
      clean(body.Date || body.date, 40)
    ]);
    // Counted only after the database accepted it: a transient write failure
    // should not push an honest visitor toward the limit.
    recordWrite(ip);
    return json(200, { status: 'ok' });
  } catch (error) {
    console.error('Suggestion write failed:', error);
    return json(502, { error: error.message || 'Unable to submit suggestion' });
  }
};

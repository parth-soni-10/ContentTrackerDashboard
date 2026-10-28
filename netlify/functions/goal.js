// The shared yearly watch goal. Reading it is public - the goal is drawn on the
// README card the site shows everyone (the read is `watchlist?goal=1`, in
// lib/db.js) - but writing it is an admin act, gated here exactly as
// admin-entry.js and admin-import.js gate their writes.
//
// Why it is not open, which is what it was: `setGoal` in lib/db.js refuses to
// change a goal once the year's is set, so a single unauthenticated write is not
// a transient annoyance - it pins the target for the rest of the year, and every
// card that reads it (progress, pace, the lock note) is then wrong with nothing
// the owner can do about it until 1 January. The write is one row of shared
// state, and its cost is permanent; the read stays open because it carries
// nothing and the card is part of the public page.
//
// The page follows the same rule: app.js sends its own session cookie with the
// Set button's POST, and tells the reader to sign in on the Admin page when the
// answer is 401 rather than reporting the save as a network failure.
const db = require('./lib/db');
const { validSession } = require('./lib/session');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!validSession(event)) return json(401, { error: 'Admin session required', code: 'SESSION_INVALID' });
  if (!db.dbEnabled()) return json(500, { error: 'Goal service is not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

  const hrs = Number(body.hrs);
  const year = String(body.year || '').trim();
  if (!Number.isFinite(hrs) || hrs < 0 || hrs > 99999) return json(400, { error: 'A valid goal is required' });
  if (hrs > 0 && !/^\d{4}$/.test(year)) return json(400, { error: 'A valid year is required' });

  try {
    const result = await db.setGoal(hrs, year);
    return result.status === 'ok'
      ? json(200, { status: 'ok', goal: result.goal })
      : json(200, { status: 'error', message: result.message });
  } catch (error) {
    console.error('Goal write failed:', error);
    return json(502, { error: error.message || 'Unable to save the goal' });
  }
};

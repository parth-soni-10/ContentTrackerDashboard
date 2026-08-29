const crypto = require('crypto');

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify(body)
});

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const clean = (value, max) => String(value || '').trim().slice(0, max);

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  const password = process.env.ADMIN_PASSWORD;
  if (!password || !safeEqual(body.password, password)) {
    return json(401, { error: 'Incorrect password' });
  }

  const entry = {
    Name: clean(body.name, 160),
    Season: clean(body.season, 20),
    Type: clean(body.type, 30),
    Genre: clean(body.genre, 80),
    Platform: clean(body.platform, 80),
    Episodes: Number.isFinite(Number(body.episodes)) ? Math.max(0, Math.min(9999, Number(body.episodes))) : 0,
    Screentime: Number.isFinite(Number(body.screentime)) ? Math.max(0, Math.min(100000, Number(body.screentime))) : 0,
    WatchDate: clean(body.watchDate, 40)
  };

  if (!entry.Name || !['Movie', 'Show', 'Series'].includes(entry.Type)) {
    return json(400, { error: 'Name and a valid type are required' });
  }

  const scriptUrl = process.env.SCRIPT_URL;
  const scriptSecret = process.env.SCRIPT_WRITE_SECRET;
  if (!scriptUrl || !scriptSecret) return json(500, { error: 'Admin service is not configured' });

  const upstream = await fetch(scriptUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Tracker-Secret': scriptSecret
    },
    body: JSON.stringify({ action: 'admin-entry', ...entry })
  });

  if (!upstream.ok) return json(502, { error: 'The sheet service rejected the entry' });
  const result = await upstream.json().catch(() => ({}));
  if (result.status !== 'ok') return json(502, { error: 'The sheet service could not save the entry' });

  return json(200, { ok: true });
};

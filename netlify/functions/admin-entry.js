const crypto = require('crypto');

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body)
});

const clean = (value, max) => String(value || '').trim().slice(0, max);
const sign = value => crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(value).digest('base64url');

function validSession(event) {
  const cookies = event.headers?.cookie || event.headers?.Cookie || '';
  const token = cookies.split(';').map(value => value.trim()).find(value => value.startsWith('ct_admin='))?.slice(9);
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !process.env.ADMIN_SESSION_SECRET) return false;
  const expected = sign(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.sub === 'admin' && data.exp > Date.now();
  } catch { return false; }
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!validSession(event)) return json(401, { error: 'Admin session required' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

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

  if (!entry.Name || !['Movie', 'Series/Show'].includes(entry.Type)) return json(400, { error: 'Name and a valid type are required' });

  const scriptUrl = process.env.SCRIPT_URL;
  const scriptSecret = String(process.env.SCRIPT_WRITE_SECRET || '').trim();
  if (!scriptUrl || !scriptSecret) return json(500, { error: 'Admin service is not configured' });

  let upstream;
  try {
    upstream = await fetch(scriptUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'admin-entry', writeSecret: scriptSecret, ...entry })
    });
  } catch (error) {
    console.error('Sheet service request failed:', error);
    return json(502, { error: 'Unable to reach the sheet service' });
  }

  const responseText = await upstream.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    return json(502, { error: 'The sheet service returned an invalid response' });
  }
  if (!upstream.ok || result.status !== 'ok') {
    console.error('Sheet service rejected entry:', result);
    return json(502, { error: result.message || 'The sheet service could not save the entry' });
  }
  return json(200, { ok: true });
};

const crypto = require('crypto');

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body)
});

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const sign = value => crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(value).digest('base64url');

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_SESSION_SECRET || !safeEqual(body.password, process.env.ADMIN_PASSWORD)) {
    return json(401, { error: 'Incorrect password' });
  }

  const payload = Buffer.from(JSON.stringify({ sub: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  const token = `${payload}.${sign(payload)}`;

  return json(200, { ok: true }, {
    'Set-Cookie': `ct_admin=${token}; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Strict`
  });
};

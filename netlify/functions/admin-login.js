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

  const configuredPassword = String(process.env.ADMIN_PASSWORD || '').trim();
  if (!configuredPassword || !process.env.ADMIN_SESSION_SECRET || !safeEqual(body.password, configuredPassword)) {
    return json(401, { error: 'Incorrect password' });
  }

  // Session cookie: no Max-Age/Expires, so the browser keeps it across page
  // refreshes and only clears it when the browsing session ends. The 30-day
  // token cap is just a safety net never reached in practice.
  const payload = Buffer.from(JSON.stringify({ sub: 'admin', exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const token = `${payload}.${sign(payload)}`;

  return json(200, { ok: true }, {
    'Set-Cookie': `ct_admin=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`
  });
};

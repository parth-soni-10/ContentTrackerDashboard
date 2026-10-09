// The admin session cookie: signed once here, validated wherever an admin
// endpoint is called. It was duplicated inside admin-login.js and admin-entry.js
// until the one-off data importer needed the same check — three copies of a
// signature check is how they drift apart.
//
// The token is `base64url(payload).base64url(hmacSHA256(payload))`, signed with
// ADMIN_SESSION_SECRET; the payload carries { sub: 'admin', exp }. It is a
// session cookie (no Max-Age), HttpOnly and SameSite=Strict, so it is not
// readable from script and not sent cross-site.
const crypto = require('crypto');

function sign(value) {
  return crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(value).digest('base64url');
}

function validSession(event) {
  const cookies = event.headers?.cookie || event.headers?.Cookie || '';
  const token = cookies.split(';').map(value => value.trim()).find(value => value.startsWith('ct_admin='))?.slice(9);
  if (!token || !process.env.ADMIN_SESSION_SECRET) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.sub === 'admin' && data.exp > Date.now();
  } catch {
    return false;
  }
}

module.exports = { sign, validSession };

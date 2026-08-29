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
  if (!validSession(event)) return json(401, { error: 'Admin session required', code: 'SESSION_INVALID' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

  // The same endpoint serves creating, updating and deleting entries; the Apps
  // Script dispatches on the action, and update/delete also carry a row number.
  const action = body.action === 'delete' ? 'delete' : (body.action === 'update' ? 'update' : (body.action === 'rate' ? 'rate' : 'create'));
  const rowNumber = Number(body.row);

  const scriptUrl = String(process.env.SCRIPT_URL || '').trim();
  const scriptSecret = String(process.env.SCRIPT_WRITE_SECRET || '').trim();
  if (!scriptUrl || !scriptSecret) return json(500, { error: 'Admin service is not configured', code: 'CONFIG_MISSING', diagnostics: { scriptUrlConfigured: Boolean(scriptUrl), writeSecretConfigured: Boolean(scriptSecret) } });

  let scriptAction;
  let forward = { writeSecret: scriptSecret, scriptWriteSecret: scriptSecret };
  let entryMeta = null;

  if (action === 'delete') {
    if (!Number.isInteger(rowNumber)) return json(400, { error: 'A valid row number is required' });
    scriptAction = 'admin-delete';
    forward.Row = String(rowNumber);
  } else if (action === 'rate') {
    if (!Number.isInteger(rowNumber)) return json(400, { error: 'A valid row number is required' });
    const rating = Math.round(Number(body.rating));
    if (![1, 2, 3, 4, 5].includes(rating)) return json(400, { error: 'A valid rating (1-5) is required' });
    scriptAction = 'admin-rate';
    forward.Row = String(rowNumber);
    forward.Rating = String(rating);
  } else {
    const isUpdate = action === 'update';
    if (isUpdate && !Number.isInteger(rowNumber)) return json(400, { error: 'A valid row number is required' });
    const entry = {
      Name: clean(body.name, 160),
      Season: clean(body.season, 20),
      Type: clean(body.type, 30),
      Genre: clean(body.genre, 80),
      Platform: clean(body.platform, 80),
      Episodes: Number.isFinite(Number(body.episodes)) ? Math.max(0, Math.min(9999, Number(body.episodes))) : 0,
      Screentime: Number.isFinite(Number(body.screentime)) ? Math.max(0, Math.min(100000, Number(body.screentime))) : 0,
      WatchDate: clean(body.watchDate, 40),
      Rating: clean(body.rating, 10),
      ...(isUpdate ? { Row: String(rowNumber) } : {})
    };
    if (!entry.Name || !['Movie', 'Series/Show'].includes(entry.Type)) return json(400, { error: 'Name and a valid type are required' });
    scriptAction = isUpdate ? 'admin-update' : 'admin-entry';
    entryMeta = { name: entry.Name, type: entry.Type, season: entry.Season };
    Object.assign(forward, entry);
  }

  let upstream;
  try {
    upstream = await fetch(scriptUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: scriptAction, ...forward })
    });
  } catch (error) {
    console.error('Sheet service request failed:', error);
    return json(502, { error: 'Unable to reach the sheet service', code: 'UPSTREAM_NETWORK_ERROR', diagnostics: { message: error.message } });
  }

  const responseText = await upstream.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    console.error('Sheet service returned non-JSON response:', { status: upstream.status, body: responseText.slice(0, 1000) });
    return json(502, { error: 'The sheet service returned an invalid response', code: 'UPSTREAM_INVALID_JSON', diagnostics: { httpStatus: upstream.status, responsePreview: responseText.slice(0, 300) } });
  }
  if (!upstream.ok || result.status !== 'ok') {
    console.error('Sheet service rejected entry:', { httpStatus: upstream.status, result });
    return json(502, { error: result.message || 'The sheet service could not save the entry', code: result.message && result.message.startsWith('Unauthorized:') ? 'SHEET_UNAUTHORIZED' : 'SHEET_REJECTED', diagnostics: { httpStatus: upstream.status, upstreamStatus: result.status || null, upstreamMessage: result.message || null } });
  }
  return json(200, { ok: true, saved: action !== 'delete', deleted: action === 'delete', sheetName: result.sheetName || null, rowNumber: result.rowNumber || null, entry: entryMeta });
};

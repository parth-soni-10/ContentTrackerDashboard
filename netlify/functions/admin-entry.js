const crypto = require('crypto');
const sheets = require('./lib/sheets');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
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

async function handleDirect(body, action, rowNumber) {
  try {
    if (action === 'delete') {
      if (!Number.isInteger(rowNumber)) return json(400, { error: 'A valid row number is required' });
      await sheets.deleteRowNumber('Data', rowNumber);
      return json(200, { ok: true, saved: false, deleted: true, duplicate: false, sheetName: 'Data', rowNumber, entry: null });
    }
    const entry = {
      name: clean(body.name, 160),
      season: clean(body.season, 20),
      type: clean(body.type, 30),
      genre: clean(body.genre, 80),
      platform: clean(body.platform, 80),
      episodes: Number.isFinite(Number(body.episodes)) ? Math.max(0, Math.min(9999, Number(body.episodes))) : 0,
      screentime: Number.isFinite(Number(body.screentime)) ? Math.max(0, Math.min(100000, Number(body.screentime))) : 0,
      watchDate: clean(body.watchDate, 40)
    };
    if (!entry.name || !['Movie', 'Series/Show'].includes(entry.type)) {
      return json(400, { error: 'Name and a valid type are required' });
    }
    const isUpdate = action === 'update';
    if (isUpdate && !Number.isInteger(rowNumber)) return json(400, { error: 'A valid row number is required' });

    const { rows } = await sheets.readSheet('Data');
    if (isUpdate) {
      await sheets.updateEntryRow('Data', rowNumber, entry);
    } else {
      // An exact duplicate (name, season, watch date, screentime) is reported
      // instead of written a second time.
      const existing = sheets.findDuplicateRow(rows, entry);
      if (existing) {
        return json(200, { ok: true, saved: true, duplicate: true, sheetName: 'Data', rowNumber: existing, entry: { name: entry.name, type: entry.type, season: entry.season } });
      }
      rowNumber = await sheets.appendEntryRow('Data', entry);
    }
    return json(200, { ok: true, saved: true, deleted: false, duplicate: false, sheetName: 'Data', rowNumber, entry: { name: entry.name, type: entry.type, season: entry.season } });
  } catch (error) {
    console.error('Sheets API write failed:', error);
    return json(502, { error: error.message || 'Unable to save entry', code: 'SHEETS_API_ERROR', diagnostics: { message: error.message } });
  }
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!validSession(event)) return json(401, { error: 'Admin session required', code: 'SESSION_INVALID' });
  if (!sheets.sheetsEnabled()) return json(500, { error: 'Admin service is not configured', code: 'CONFIG_MISSING' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

  // The same endpoint serves creating, updating and deleting entries; update
  // and delete also carry a row number.
  const action = body.action === 'delete' ? 'delete' : (body.action === 'update' ? 'update' : 'create');
  return handleDirect(body, action, Number(body.row));
};

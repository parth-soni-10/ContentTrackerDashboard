const crypto = require('crypto');

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body)
});

const clean = (value, max) => String(value || '').trim().slice(0, max);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sign = value => crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(value).digest('base64url');

// Calls the Apps Script web app, retrying once on transient failures. Google's
// content CDN occasionally 404s (or drops the JSON body) right after a
// redeploy or on a cold start; one retry clears that. Non-JSON responses are
// only retried for idempotent actions (update/delete), so a create can't be
// double-written by retrying after an ambiguous success.
async function callUpstream(scriptUrl, payload, isIdempotent) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let response;
    let responseText = '';
    try {
      response = await fetch(scriptUrl, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      responseText = await response.text();
    } catch (error) {
      if (attempt === 1) { await sleep(1000); continue; }
      return { error };
    }
    let result = null;
    try { result = JSON.parse(responseText); } catch { /* handled as non-JSON below */ }
    const transient = response.status === 404 || response.status === 429 || response.status >= 500 || (!result && isIdempotent);
    if (transient && attempt === 1) {
      console.warn('Sheet service returned a transient response, retrying:', { status: response.status, attempt });
      await sleep(1000);
      continue;
    }
    return { response, responseText, result };
  }
}

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
  const action = body.action === 'delete' ? 'delete' : (body.action === 'update' ? 'update' : 'create');
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
      ...(isUpdate ? { Row: String(rowNumber) } : {})
    };
    if (!entry.Name || !['Movie', 'Series/Show'].includes(entry.Type)) return json(400, { error: 'Name and a valid type are required' });
    scriptAction = isUpdate ? 'admin-update' : 'admin-entry';
    entryMeta = { name: entry.Name, type: entry.Type, season: entry.Season };
    Object.assign(forward, entry);
  }

  const call = await callUpstream(scriptUrl, { action: scriptAction, ...forward }, action !== 'create');
  if (call.error) {
    console.error('Sheet service request failed:', call.error);
    return json(502, { error: 'Unable to reach the sheet service', code: 'UPSTREAM_NETWORK_ERROR', diagnostics: { message: call.error.message } });
  }

  const { response, responseText, result } = call;
  if (!result) {
    console.error('Sheet service returned non-JSON response:', { status: response.status, body: responseText.slice(0, 1000) });
    return json(502, { error: 'The sheet service returned an invalid response', code: 'UPSTREAM_INVALID_JSON', diagnostics: { httpStatus: response.status, responsePreview: responseText.slice(0, 300) } });
  }
  if (!response.ok || result.status !== 'ok') {
    console.error('Sheet service rejected entry:', { httpStatus: response.status, result });
    return json(502, { error: result.message || 'The sheet service could not save the entry', code: result.message && result.message.startsWith('Unauthorized:') ? 'SHEET_UNAUTHORIZED' : 'SHEET_REJECTED', diagnostics: { httpStatus: response.status, upstreamStatus: result.status || null, upstreamMessage: result.message || null } });
  }
  return json(200, { ok: true, saved: action !== 'delete', deleted: action === 'delete', sheetName: result.sheetName || null, rowNumber: result.rowNumber || null, entry: entryMeta });
};

// Direct Google Sheets API access for Netlify functions — the replacement for
// google-apps-script.gs. Authenticates as a service account (no Apps Script,
// no manual deploys) and mirrors the old script's data shape exactly, so the
// frontend and the existing row-number based features keep working unchanged.
//
// The service account needs Editor access to the spreadsheet; credentials come
// from the GOOGLE_SERVICE_ACCOUNT_JSON env var (the full service-account key
// file) and the spreadsheet id from SPREADSHEET_ID.
const crypto = require('crypto');

const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEET_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = MONTHS.map(name => name.slice(0, 3));
// Matches the date display format the sheet's Watch Date column already uses
// (e.g. "3-Sep-26"), applied explicitly so appended rows render identically
// to rows written through the old Apps Script path.
const DATE_PATTERN = 'd-mmm-yy';

// Is the direct Sheets API path configured and usable?
function sheetsEnabled() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.SPREADSHEET_ID);
}

let tokenCache = null;
async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;
  let cred;
  try {
    cred = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '');
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  const { client_email: clientEmail, private_key: privateKey } = cred;
  const tokenUri = cred.token_uri || 'https://oauth2.googleapis.com/token';
  if (!clientEmail || !privateKey) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key');

  const now = Math.floor(Date.now() / 1000);
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const claims = b64({ iss: clientEmail, scope: SHEET_SCOPE, aud: tokenUri, iat: now, exp: now + 3600 });
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), crypto.createPrivateKey(privateKey)).toString('base64url');
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('OAuth token exchange failed: ' + (data.error_description || data.error || `HTTP ${res.status}`));
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

// Calls the Sheets API. `path` starts with "/" after the spreadsheet id and may
// carry a query string (e.g. "/values/Data:append?valueInputOption=...").
async function sheetsFetch(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(API_BASE + '/' + encodeURIComponent(spreadsheetId()) + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const detail = data && data.error && (data.error.message || data.error.status);
    throw new Error(detail || `Sheets API returned HTTP ${res.status}`);
  }
  return data;
}

function spreadsheetId() {
  return String(process.env.SPREADSHEET_ID || '').trim();
}

// The sheet's tab id (gid) is required for structural calls (delete row).
let sheetsCache = null;
async function listSheets() {
  if (!sheetsCache) {
    const data = await sheetsFetch('?fields=sheets.properties(sheetId,title)');
    sheetsCache = (data.sheets || []).map(sheet => ({ sheetId: sheet.properties.sheetId, title: sheet.properties.title }));
  }
  return sheetsCache;
}

function sheetById(title) {
  const wanted = String(title).toLowerCase();
  return listSheets().then(list => {
    const found = list.find(sheet => sheet.title.toLowerCase() === wanted);
    if (!found) throw new Error('Sheet not found: ' + title);
    return found;
  });
}

async function addSheet(title) {
  const sheet = await sheetById(title).catch(() => null);
  if (sheet) return sheet;
  const data = await sheetsFetch(':batchUpdate', { method: 'POST', body: { requests: [{ addSheet: { properties: { title } } }] } });
  const props = data.replies[0].addSheet.properties;
  sheetsCache = null;
  return { sheetId: props.sheetId, title: props.title };
}

async function readValues(range) {
  const data = await sheetsFetch(`/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
  return data.values || [];
}

// ── Row model ─────────────────────────────────────────────────────────────
// Mirrors the old Apps Script readSheet(): values come back exactly as
// displayed (dates like "3-Sep-26"), the header row is located by scanning
// for a cell with the value "name" (a title block above the table is fine),
// and every row is returned as { _row: <physical sheet row>, ...headers }.
// `headers` are also returned so writers can align new rows to the columns
// that actually exist in the sheet.
async function readSheet(title, fixedHeader = false) {
  const values = await readValues(title);
  const empty = { headers: [], rows: [] };
  if (!values.length) return empty;
  // The Data sheet can have a title block above its table, so its header row
  // is located by scanning for a cell with the value "name". Other sheets
  // (Suggestions, …) have their header in row 1.
  let headerOffset = fixedHeader ? 0 : values.findIndex(row => row.some(cell => String(cell).trim().toLowerCase() === 'name'));
  if (headerOffset < 0) return empty;
  const headers = values[headerOffset].map((header, index) => {
    const name = String(header).trim();
    return name || 'Column ' + (index + 1);
  });
  const rows = [];
  for (let i = headerOffset + 1; i < values.length; i++) {
    const row = values[i];
    if (!String(row[0] || '').trim()) continue;
    const item = { _row: i + 1 };
    headers.forEach((header, index) => {
      item[header] = String(row[index] == null ? '' : row[index]).trim();
    });
    rows.push(item);
  }
  return { headers, rows };
}

// ── Dates ──────────────────────────────────────────────────────────────────
function parseDateParts(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
  m = text.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ](\d{2,4})$/);
  if (m) {
    const mo = MONTH_SHORT.indexOf(m[2].slice(0, 1).toUpperCase() + m[2].slice(1, 3).toLowerCase());
    if (mo < 0) return null;
    let y = Number(m[3]);
    if (y < 100) y += y > 50 ? 1900 : 2000;
    return { y, mo: mo + 1, d: Number(m[1]) };
  }
  return null;
}

function dateSerial(date) {
  return Math.round((Date.UTC(date.y, date.mo - 1, date.d) - Date.UTC(1899, 11, 30)) / 86400000);
}

function formatDateLikeSheet(date) {
  return `${date.d}-${MONTH_SHORT[date.mo - 1]}-${String(date.y).slice(2)}`;
}

function monthNameOf(date) {
  return MONTHS[date.mo - 1];
}

// Normalizes a season value so 'S1', 'Season 01' and '1' compare equal.
function seasonKey(value) {
  let text = String(value || '').trim().toLowerCase()
    .replace(/^season\s*/, '')
    .replace(/^series\s*/, '')
    .replace(/^#\s*/, '');
  if (/^s\s*\d/.test(text)) text = text.slice(1).trim();
  const number = Number(text);
  return text && Number.isInteger(number) ? '#' + number : text;
}

// Normalizes a watch date (ISO or displayed) to a comparable yyyymmdd string.
function dateKey(value) {
  const parts = parseDateParts(value);
  if (!parts) return String(value || '').trim().toLowerCase();
  return `${parts.y}-${String(parts.mo).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
}

// ── Writes ────────────────────────────────────────────────────────────────
// Builds a row aligned to the sheet's actual headers (by lowercased header
// name), so extra/missing columns never shift data — the same alignment the
// old Apps Script buildEntryRow() did.
function buildRowForHeaders(headers, entry) {
  const date = parseDateParts(entry.watchDate);
  const valuesByHeader = {
    name: entry.name,
    season: entry.season,
    type: entry.type,
    'details/genre': entry.genre,
    genre: entry.genre,
    platform: entry.platform,
    'episode count': entry.episodes,
    'per epsiode': '', // historical typo column in the sheet — keep it empty
    'per episode': '',
    screentime: entry.screentime,
    'watch date': date ? formatDateLikeSheet(date) : '',
    month: date ? monthNameOf(date) : '',
    year: date ? date.y : ''
  };
  return headers.map(header => {
    const key = String(header).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(valuesByHeader, key) ? valuesByHeader[key] : '';
  });
}

async function appendEntryRow(title, entry) {
  const sheet = await addSheet(title);
  const { headers } = await readSheet(title);
  const row = buildRowForHeaders(headers, entry);
  const data = await sheetsFetch(
    `/values/${encodeURIComponent(title)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: { values: [row] } }
  );
  const updated = data.updates && data.updates.updatedRange || '';
  const rowNumber = Number((updated.match(/:?[A-Z]+(\d+)$/) || [])[1] || 0);
  // A user-entered date parses into a real date value; pin the cell's number
  // format to the column's existing display style so the row renders exactly
  // like every other date row.
  const dateIndex = headers.map(h => String(h).trim().toLowerCase()).indexOf('watch date');
  if (dateIndex >= 0 && rowNumber) {
    await sheetsFetch(':batchUpdate', {
      method: 'POST',
      body: {
        requests: [{
          updateCells: {
            range: { sheetId: sheet.sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: dateIndex, endColumnIndex: dateIndex + 1 },
            fields: 'userEnteredFormat.numberFormat',
            rows: [{ values: [{ userEnteredFormat: { numberFormat: { type: 'DATE', pattern: DATE_PATTERN } } }] }]
          }
        }]
      }
    });
  }
  return rowNumber;
}

async function updateEntryRow(title, rowNumber, entry) {
  const sheet = await addSheet(title);
  const { headers } = await readSheet(title);
  const row = buildRowForHeaders(headers, entry);
  await sheetsFetch(
    `/values/${encodeURIComponent(title)}!A${rowNumber}:${String.fromCharCode(64 + headers.length)}${rowNumber}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: { values: [row] } }
  );
  const dateIndex = headers.map(h => String(h).trim().toLowerCase()).indexOf('watch date');
  if (dateIndex >= 0) {
    await sheetsFetch(':batchUpdate', {
      method: 'POST',
      body: {
        requests: [{
          updateCells: {
            range: { sheetId: sheet.sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: dateIndex, endColumnIndex: dateIndex + 1 },
            fields: 'userEnteredFormat.numberFormat',
            rows: [{ values: [{ userEnteredFormat: { numberFormat: { type: 'DATE', pattern: DATE_PATTERN } } }] }]
          }
        }]
      }
    });
  }
}

async function deleteRowNumber(title, rowNumber) {
  const sheet = await addSheet(title);
  await sheetsFetch(':batchUpdate', {
    method: 'POST',
    body: {
      requests: [{
        deleteDimension: {
          range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber }
        }
      }]
    }
  });
}

// Plain append for the Suggestions sheet (fixed six-column layout, matching
// the old script's appendRow).
async function appendPlainRow(title, values) {
  await addSheet(title);
  await sheetsFetch(
    `/values/${encodeURIComponent(title)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: { values: [values] } }
  );
}

// Returns the physical row number of the first existing entry matching an
// add payload (name, season, watch date and screentime), or 0 — the same
// duplicate scan the old Apps Script ran before every insert.
function findDuplicateRow(rows, entry) {
  const wanted = {
    name: String(entry.name || '').trim().toLowerCase(),
    season: seasonKey(entry.season),
    dateKey: dateKey(entry.watchDate),
    screentime: Number(entry.screentime) || 0
  };
  for (const item of rows) {
    if (String(item.Name || item.name || '').trim().toLowerCase() !== wanted.name) continue;
    if (seasonKey(item.Season || item.season) !== wanted.season) continue;
    if (dateKey(item['Watch Date'] || item.watchDate) !== wanted.dateKey) continue;
    if ((Number(item.Screentime || item.screentime) || 0) !== wanted.screentime) continue;
    return item._row;
  }
  return 0;
}

// ── Yearly goal (Settings sheet) ───────────────────────────────────────────
// The goal used to live in Apps Script Script Properties; it now lives in a
// small key/value "Settings" tab of the same spreadsheet so it still syncs
// across devices and stays with the data.
const GOAL_PROPERTY = 'watch-goal';

async function readGoal() {
  try {
    const values = await readValues('Settings!A1:B5');
    for (const row of values) {
      if (String(row[0] || '').trim() === GOAL_PROPERTY) {
        const parsed = JSON.parse(String(row[1] || '').trim());
        return { hrs: Math.max(0, Number(parsed.hrs) || 0), year: String(parsed.year || '') };
      }
    }
  } catch (e) { /* Settings tab missing — no goal set yet */ }
  return { hrs: 0, year: '' };
}

// Returns { status: 'ok', goal } or { status: 'error', message }.
async function setGoal(hrs, year) {
  const current = await readGoal();
  // A set goal for a year stays locked until 1 January — enforced server-side
  // so no device can change it mid-year (identical re-sets are a no-op).
  if (current.hrs > 0 && current.year === year) {
    if (hrs !== current.hrs) {
      return { status: 'error', message: `The goal for ${year} is already set and locked until 1 January` };
    }
    return { status: 'ok', goal: current };
  }
  const sheet = await addSheet('Settings');
  const goal = hrs > 0 ? { hrs: Math.round(hrs * 100) / 100, year } : null;
  const values = await readValues('Settings!A1:B5');
  let goalRow = -1;
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === GOAL_PROPERTY) { goalRow = i + 1; break; }
  }
  const cell = rowNumber => `Settings!A${rowNumber}:B${rowNumber}`;
  if (goalRow > 0) {
    await sheetsFetch(`/values/${encodeURIComponent(cell(goalRow))}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body: { values: [[GOAL_PROPERTY, goal ? JSON.stringify(goal) : '']] }
    });
  } else {
    const data = await sheetsFetch(
      `/values/${encodeURIComponent('Settings!A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: { values: [[GOAL_PROPERTY, goal ? JSON.stringify(goal) : '']] } }
    );
    const updated = data.updates && data.updates.updatedRange || '';
    goalRow = Number((updated.match(/:?[A-Z]+(\d+)$/) || [])[1] || 0);
  }
  if (!sheet || goalRow <= 0) return { status: 'error', message: 'Could not save the goal' };
  return { status: 'ok', goal: goal ? { hrs: goal.hrs, year: goal.year } : { hrs: 0, year: '' } };
}

module.exports = {
  sheetsEnabled,
  readSheet,
  appendEntryRow,
  updateEntryRow,
  deleteRowNumber,
  appendPlainRow,
  findDuplicateRow,
  readGoal,
  setGoal,
  seasonKey,
  dateKey,
  buildRowForHeaders,
  parseDateParts
};

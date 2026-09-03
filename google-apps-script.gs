const DATA_SHEET = 'Data';
const SUGGESTIONS_SHEET = 'Suggestions';
const WRITE_SECRET_PROPERTY = 'SCRIPT_WRITE_SECRET';
const GOAL_PROPERTY = 'watch-goal';
const DATA_CACHE_SECONDS = 600;

// The yearly watch goal lives in Script Properties so every device sees the
// same value. It deliberately avoids the spreadsheet (and its slow cold reads).
function readGoal() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(GOAL_PROPERTY);
    if (!raw) return { hrs: 0, year: '' };
    const parsed = JSON.parse(raw);
    return {
      hrs: Math.max(0, Number(parsed.hrs) || 0),
      year: String(parsed.year || '')
    };
  } catch (e) {
    return { hrs: 0, year: '' };
  }
}

function handleSetGoal(payload) {
  const hrs = Number(payload.hrs);
  if (!Number.isFinite(hrs) || hrs < 0 || hrs > 99999) {
    return { status: 'error', message: 'A valid goal is required' };
  }
  const year = clean(payload.year || payload.Year, 10);
  if (hrs > 0 && !/^\d{4}$/.test(year)) {
    return { status: 'error', message: 'A valid year is required' };
  }

  // Once a goal is set for a year it stays locked until 1 January — enforced
  // here (not just in the UI) so no device can quietly change or clear it
  // mid-year. An identical re-set is allowed as a harmless no-op.
  const current = readGoal();
  if (current.hrs > 0 && current.year === year && hrs !== current.hrs) {
    return {
      status: 'error',
      message: 'The goal for ' + year + ' is already set and locked until 1 January'
    };
  }
  if (current.hrs > 0 && current.year === year) {
    return { status: 'ok', goal: current };
  }

  if (hrs > 0) {
    const goal = { hrs: Math.round(hrs * 100) / 100, year: year };
    PropertiesService.getScriptProperties().setProperty(GOAL_PROPERTY, JSON.stringify(goal));
  } else {
    PropertiesService.getScriptProperties().deleteProperty(GOAL_PROPERTY);
  }

  return { status: 'ok', goal: readGoal() };
}

function doGet(e) {
  if (e && e.parameter && e.parameter.goal === '1') {
    return response(JSON.stringify(readGoal()));
  }

  const sheetName = e && e.parameter && e.parameter.sheet === SUGGESTIONS_SHEET
    ? SUGGESTIONS_SHEET
    : DATA_SHEET;

  const cache = CacheService.getScriptCache();
  const cacheKey = 'sheet-json-' + sheetName;
  const cached = cache.get(cacheKey);

  if (cached) {
    // Sliding TTL: refresh the entry on every hit so the cache stays warm
    // while the dashboard is actively used (writes patch it, reads extend it).
    cache.put(cacheKey, cached, DATA_CACHE_SECONDS);
    return response(cached);
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(sheetName);

  if (!sheet) {
    return response(JSON.stringify({
      status: 'error',
      message: 'Sheet not found: ' + sheetName
    }));
  }

  const result = JSON.stringify(readSheet(sheet, sheetName === DATA_SHEET));

  if (result.length < 95000) {
    cache.put(cacheKey, result, DATA_CACHE_SECONDS);
  }

  return response(result);
}

function doPost(e) {
  let payload;

  try {
    payload = JSON.parse(
      e && e.postData && e.postData.contents
        ? e.postData.contents
        : '{}'
    );
  } catch (error) {
    return response(JSON.stringify({
      status: 'error',
      message: 'Invalid JSON'
    }));
  }

  let result;

  if (payload.action === 'admin-entry') {
    result = handleAdminEntry(payload);
  } else if (payload.action === 'admin-update') {
    result = handleAdminUpdate(payload);
  } else if (payload.action === 'admin-delete') {
    result = handleAdminDelete(payload);
  } else if (payload.action === 'set-goal') {
    result = handleSetGoal(payload);
  } else if (payload.action === 'suggest') {
    result = handleSuggestion(payload);
  } else {
    result = {
      status: 'error',
      message: 'Unknown action'
    };
  }

  return response(JSON.stringify(result));
}

function authorizeWrite(payload) {
  const properties = PropertiesService.getScriptProperties();
  const expectedSecret = String(properties.getProperty(WRITE_SECRET_PROPERTY) || '').trim();
  const suppliedSecret = String(
    payload.writeSecret ||
    payload.scriptWriteSecret ||
    payload.SCRIPT_WRITE_SECRET ||
    payload.script_write_secret ||
    ''
  ).trim();

  if (!expectedSecret) {
    console.error('Admin write rejected: missing SCRIPT_WRITE_SECRET script property');
    return {
      status: 'error',
      message: 'Unauthorized: SCRIPT_WRITE_SECRET is not configured'
    };
  }

  if (!suppliedSecret || !constantTimeEqual(suppliedSecret, expectedSecret)) {
    console.error('Admin write rejected: write secret mismatch', {
      supplied: Boolean(suppliedSecret),
      suppliedLength: suppliedSecret.length,
      expectedLength: expectedSecret.length
    });
    return {
      status: 'error',
      message: 'Unauthorized: write secret mismatch'
    };
  }

  return null;
}

function getDataSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_SHEET);
}

// Builds a row aligned to the Data sheet's actual header row — located the
// same way readSheet() finds it, so a title block above the headers is fine.
function buildEntryRow(sheet, payload, name, type) {
  const watchDateText = clean(payload.WatchDate || payload.watchDate, 40);
  const parsedDate = parseDate(watchDateText);

  const headerRowNumber = findHeaderRow(sheet);
  const headers = sheet.getRange(headerRowNumber, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function(header) {
    return String(header).trim().toLowerCase();
  });
  const valuesByHeader = {
    name: name,
    season: clean(payload.Season || payload.season, 20),
    type: type,
    'details/genre': clean(payload.Genre || payload.genre || payload['Details/Genre'], 80),
    genre: clean(payload.Genre || payload.genre || payload['Details/Genre'], 80),
    platform: clean(payload.Platform || payload.platform, 80),
    'episode count': toNumber(payload.Episodes || payload.episodes, 9999),
    'per epsiode': '',
    'per episode': '',
    screentime: toNumber(payload.Screentime || payload.screentime, 100000),
    'watch date': parsedDate || '',
    month: parsedDate ? monthName(parsedDate) : '',
    year: parsedDate ? parsedDate.getFullYear() : ''
  };
  return headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(valuesByHeader, header) ? valuesByHeader[header] : '';
  });
}

function handleAdminEntry(payload) {
  const unauthorized = authorizeWrite(payload);
  if (unauthorized) return unauthorized;

  const name = clean(payload.Name || payload.name, 160);
  const type = clean(payload.Type || payload.type, 30);

  if (!name || !['Movie', 'Series/Show'].includes(type)) {
    return {
      status: 'error',
      message: 'Name and valid type are required'
    };
  }

  const sheet = getDataSheet();
  if (!sheet) {
    return {
      status: 'error',
      message: 'Data sheet not found'
    };
  }

  // Apps Script web-app executions run in parallel, so two submissions can
  // compute the same "last row + 1" and overwrite each other (or land as
  // duplicates). The script lock serializes writes so the target row and the
  // duplicate scan below are computed against a stable sheet.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return {
      status: 'error',
      message: 'The tracker is busy saving another entry — please try again in a few seconds'
    };
  }

  try {
    const headerRowNumber = findHeaderRow(sheet);

    // A retried submission (network blip, double click, timeout) carries the
    // exact same row content. Detect it and report the existing row instead of
    // writing a second copy — this makes creates idempotent end to end.
    const existingRow = findDuplicateRow(sheet, headerRowNumber, payload, name);
    if (existingRow) {
      return {
        status: 'ok',
        saved: true,
        duplicate: true,
        spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
        sheetName: sheet.getName(),
        rowNumber: existingRow,
        name: name
      };
    }

    const row = buildEntryRow(sheet, payload, name, type);
    const targetRow = sheet.getLastRow() + 1;
    sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush();

    // Keep the cached JSON warm instead of clearing it — the next read then
    // answers from cache (~1-2s) instead of re-reading the whole sheet (~20-40s
    // when cold). Falls back to clearing when there's no cache to patch.
    if (!patchCacheAppend('sheet-json-' + DATA_SHEET, sheet, targetRow)) {
      clearSheetCache();
    }

    return {
      status: 'ok',
      saved: true,
      duplicate: false,
      spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
      sheetName: sheet.getName(),
      rowNumber: targetRow,
      name: name
    };
  } finally {
    lock.releaseLock();
  }
}

// Returns the physical row number of an existing entry that exactly matches
// the submitted one (name, season, watch date and screentime), or null.
function findDuplicateRow(sheet, headerRowNumber, payload, name) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow <= headerRowNumber || lastColumn < 1) return null;

  const headers = sheet.getRange(headerRowNumber, 1, 1, lastColumn).getDisplayValues()[0]
    .map(function (header) { return String(header).trim().toLowerCase(); });
  const colOf = function (label) {
    const index = headers.indexOf(label);
    return index < 0 ? null : index + 1;
  };
  const nameCol = colOf('name');
  const seasonCol = colOf('season');
  const dateCol = colOf('watch date');
  const screentimeCol = colOf('screentime');

  // Movies logged without a season vs shows: a season mismatch means a
  // different entry (e.g. a movie never has S1). Treat blank as matching
  // blank, and '1' as matching '1'.
  const newName = String(name || '').trim().toLowerCase();
  const newSeason = seasonKey(payload.Season || payload.season);
  const newDateKey = dateKey(payload.WatchDate || payload.watchDate);
  const newScreentime = toNumber(payload.Screentime || payload.screentime, 100000);

  const rows = sheet.getRange(headerRowNumber + 1, 1, lastRow - headerRowNumber, lastColumn).getValues();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (nameCol && String(row[nameCol - 1] || '').trim().toLowerCase() !== newName) continue;
    if (seasonCol && seasonKey(row[seasonCol - 1]) !== newSeason) continue;
    if (dateCol && dateKey(row[dateCol - 1]) !== newDateKey) continue;
    if (screentimeCol && toNumber(row[screentimeCol - 1], 100000) !== newScreentime) continue;
    return headerRowNumber + 1 + i;
  }

  return null;
}

// Normalizes a season value so '1' and '01' compare equal (blanks stay blank).
function seasonKey(value) {
  const text = String(value || '').trim().toLowerCase();
  const number = Number(text);
  return text && Number.isInteger(number) ? '#' + number : text;
}

// Reduces a date (Date object, ISO text, or display text like '10-Aug-26') to
// a yyyymmdd key so differently formatted representations compare equal.
function dateKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = value instanceof Date ? value : parseDate(text);
  if (!date || isNaN(date.getTime())) return text.toLowerCase();
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyyMMdd');
}

function handleAdminUpdate(payload) {
  const unauthorized = authorizeWrite(payload);
  if (unauthorized) return unauthorized;

  const name = clean(payload.Name || payload.name, 160);
  const type = clean(payload.Type || payload.type, 30);

  if (!name || !['Movie', 'Series/Show'].includes(type)) {
    return {
      status: 'error',
      message: 'Name and valid type are required'
    };
  }

  const rowNumber = Number(payload.Row || payload.row);
  if (!Number.isInteger(rowNumber)) {
    return {
      status: 'error',
      message: 'A valid row number is required'
    };
  }

  const sheet = getDataSheet();
  if (!sheet) {
    return {
      status: 'error',
      message: 'Data sheet not found'
    };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return {
      status: 'error',
      message: 'The tracker is busy — please try again in a few seconds'
    };
  }

  try {
    if (rowNumber <= findHeaderRow(sheet) || rowNumber > sheet.getLastRow()) {
      return {
        status: 'error',
        message: 'Row ' + rowNumber + ' is not a data row'
      };
    }

    const row = buildEntryRow(sheet, payload, name, type);
    sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush();

    if (!patchCacheUpdate('sheet-json-' + DATA_SHEET, sheet, rowNumber)) {
      clearSheetCache();
    }

    return {
      status: 'ok',
      saved: true,
      spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
      sheetName: sheet.getName(),
      rowNumber: rowNumber,
      name: name
    };
  } finally {
    lock.releaseLock();
  }
}

function handleAdminDelete(payload) {
  const unauthorized = authorizeWrite(payload);
  if (unauthorized) return unauthorized;

  const rowNumber = Number(payload.Row || payload.row);
  if (!Number.isInteger(rowNumber)) {
    return {
      status: 'error',
      message: 'A valid row number is required'
    };
  }

  const sheet = getDataSheet();
  if (!sheet) {
    return {
      status: 'error',
      message: 'Data sheet not found'
    };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return {
      status: 'error',
      message: 'The tracker is busy — please try again in a few seconds'
    };
  }

  try {
    const headerRow = findHeaderRow(sheet);
    if (rowNumber <= headerRow || rowNumber > sheet.getLastRow()) {
      return {
        status: 'error',
        message: 'Row ' + rowNumber + ' is not a data row'
      };
    }

    sheet.deleteRow(rowNumber);
    SpreadsheetApp.flush();

    if (!patchCacheDelete('sheet-json-' + DATA_SHEET, sheet, rowNumber)) {
      clearSheetCache();
    }

    return {
      status: 'ok',
      deleted: true,
      spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
      sheetName: sheet.getName(),
      rowNumber: rowNumber
    };
  } finally {
    lock.releaseLock();
  }
}

function handleSuggestion(payload) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(SUGGESTIONS_SHEET);

  if (!sheet) {
    return {
      status: 'error',
      message: 'Suggestions sheet not found'
    };
  }

  const title = clean(payload.Title, 160);

  if (!title) {
    return {
      status: 'error',
      message: 'Title is required'
    };
  }

  sheet.appendRow([
    title,
    clean(payload.Type, 30),
    clean(payload.Genre, 80),
    clean(payload.Platform, 80),
    clean(payload.Note, 200),
    clean(payload.Date, 40)
  ]);

  if (!patchCacheAppend('sheet-json-' + SUGGESTIONS_SHEET, sheet, sheet.getLastRow())) {
    clearSheetCache();
  }

  return { status: 'ok' };
}

// Returns the 0-based offset (into a values grid) of the Data sheet's header
// row — the first row containing a cell with the value 'name'.
function findHeaderOffset(values) {
  const index = values.findIndex(function (row) {
    return row.some(function (cell) {
      return String(cell).trim().toLowerCase() === 'name';
    });
  });
  return index < 0 ? 0 : index;
}

// Returns the 1-based row number of the Data sheet's header row, falling back
// to row 1. Used by the write handlers where a single targeted read is cheap.
function findHeaderRow(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (!lastRow || !lastColumn) return 1;

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues();
  return findHeaderOffset(values) + 1;
}

function readSheet(sheet, isDataSheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (!lastRow || !lastColumn) return [];
  // Single read: the header row is located inside the values already fetched,
  // so the sheet is only read once per request.
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues();

  if (!values.length) {
    return [];
  }

  let headerOffset = isDataSheet ? findHeaderOffset(values) : 0;

  if (headerOffset < 0 || values.length <= headerOffset + 1) {
    return [];
  }

  const headers = values[headerOffset].map(function(header, index) {
    const name = String(header).trim();
    return name || 'Column ' + (index + 1);
  });

  return values
    .slice(headerOffset + 1)
    .map(function(row, index) {
      // Track the physical sheet row so the admin dashboard can edit entries.
      return { row: row, sheetRow: headerOffset + index + 2 };
    })
    .filter(function(entry) {
      return String(entry.row[0] || '').trim() !== '';
    })
    .map(function(entry) {
      const item = { _row: entry.sheetRow };

      headers.forEach(function(header, index) {
        item[header] = String(entry.row[index] || '').trim();
      });

      return item;
    });
}

function clearSheetCache() {
  const cache = CacheService.getScriptCache();
  cache.remove('sheet-json-' + DATA_SHEET);
  cache.remove('sheet-json-' + SUGGESTIONS_SHEET);
}

// ── Write-through cache patch ─────────────────────────────────────────────
// Reads of the Data/Suggestions JSON are cached (600s, sliding). Instead of
// clearing that cache after every admin write — which makes the very next read
// do a full cold sheet read (~20-40s, often timing out the Netlify function) —
// these helpers update the cached JSON in place using the cheap display values
// of the single row that changed. If there's nothing cached to patch (first
// read of the day, unparsable cache), they return false and the caller falls
// back to clearing so the next read rebuilds fresh and correct.

function loadCachedRows(cacheKey) {
  const raw = CacheService.getScriptCache().get(cacheKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function storeCachedRows(cacheKey, rows) {
  const json = JSON.stringify(rows);
  if (!json || json.length >= 95000) return false; // same cap as doGet
  CacheService.getScriptCache().put(cacheKey, json, DATA_CACHE_SECONDS);
  return true;
}

// Builds a cached item for a physical row from its display values, aligning
// columns by the header order captured in an existing cached item.
function rowToCachedItem(sheet, rowNumber, headers) {
  const values = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const item = { _row: rowNumber };
  headers.forEach(function (header, index) {
    item[header] = String(values[index] == null ? '' : values[index]).trim();
  });
  return item;
}

// Appends the row that was just written at targetRow (add entry / suggestion).
function patchCacheAppend(cacheKey, sheet, targetRow) {
  const rows = loadCachedRows(cacheKey);
  if (!rows || !rows.length) return false;
  const headers = Object.keys(rows[0]).filter(function (key) { return key !== '_row'; });
  if (!headers.length) return false;
  rows.push(rowToCachedItem(sheet, targetRow, headers));
  return storeCachedRows(cacheKey, rows);
}

// Replaces the cached item for an edited row.
function patchCacheUpdate(cacheKey, sheet, rowNumber) {
  const rows = loadCachedRows(cacheKey);
  if (!rows || !rows.length) return false;
  const index = rows.findIndex(function (row) { return Number(row._row) === rowNumber; });
  if (index < 0) return false;
  const headers = Object.keys(rows[index]).filter(function (key) { return key !== '_row'; });
  if (!headers.length) return false;
  rows[index] = rowToCachedItem(sheet, rowNumber, headers);
  return storeCachedRows(cacheKey, rows);
}

// Removes the cached item for a deleted row and shifts the rows below it up
// (deleting a sheet row renumbers every row beneath it).
function patchCacheDelete(cacheKey, sheet, rowNumber) {
  const rows = loadCachedRows(cacheKey);
  if (!rows || !rows.length) return false;
  const index = rows.findIndex(function (row) { return Number(row._row) === rowNumber; });
  if (index < 0) return false;
  rows.splice(index, 1);
  for (let i = index; i < rows.length; i++) {
    rows[i]._row = Number(rows[i]._row) - 1;
  }
  return storeCachedRows(cacheKey, rows);
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value + 'T00:00:00');

  return isNaN(date.getTime()) ? null : date;
}

function clean(value, maxLength) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function toNumber(value, max) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(0, Math.min(max, number))
    : 0;
}

function monthName(date) {
  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    'MMMM'
  );
}

function constantTimeEqual(left, right) {
  left = String(left || '');
  right = String(right || '');

  if (left.length !== right.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }

  return result === 0;
}

function response(jsonText) {
  return ContentService
    .createTextOutput(jsonText)
    .setMimeType(ContentService.MimeType.JSON);
}

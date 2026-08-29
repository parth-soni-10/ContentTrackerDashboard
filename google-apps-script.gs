const DATA_SHEET = 'Data';
const SUGGESTIONS_SHEET = 'Suggestions';
const WRITE_SECRET_PROPERTY = 'SCRIPT_WRITE_SECRET';

function doGet(e) {
  const sheetName = e && e.parameter && e.parameter.sheet === SUGGESTIONS_SHEET
    ? SUGGESTIONS_SHEET
    : DATA_SHEET;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);

  if (!sheet) {
    return response({ status: 'error', message: 'Sheet not found: ' + sheetName });
  }

  return response(readSheet(sheet));
}

function doPost(e) {
  let payload;

  try {
    payload = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}');
  } catch (error) {
    return response({ status: 'error', message: 'Invalid JSON' });
  }

  if (payload.action === 'admin-entry') return handleAdminEntry(payload);
  if (payload.action === 'suggest') return handleSuggestion(payload);

  return response({ status: 'error', message: 'Unknown action' });
}

function handleAdminEntry(payload) {
  const expectedSecret = PropertiesService.getScriptProperties().getProperty(WRITE_SECRET_PROPERTY);

  if (!expectedSecret || !constantTimeEqual(payload.writeSecret, expectedSecret)) {
    return response({ status: 'error', message: 'Unauthorized' });
  }

  const type = clean(payload.Type, 30);
  const name = clean(payload.Name, 160);

  if (!name || !['Movie', 'Series/Show'].includes(type)) {
    return response({ status: 'error', message: 'Name and valid type are required' });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DATA_SHEET);
  if (!sheet) return response({ status: 'error', message: 'Data sheet not found' });

  const watchDate = clean(payload.WatchDate, 40);
  const parsedDate = watchDate ? new Date(watchDate + 'T00:00:00') : '';

  sheet.appendRow([
    name,
    clean(payload.Season, 20),
    type,
    clean(payload.Genre, 80),
    clean(payload.Platform, 80),
    toNumber(payload.Episodes, 9999),
    '',
    toNumber(payload.Screentime, 100000),
    parsedDate,
    watchDate ? monthName(parsedDate) : '',
    watchDate ? parsedDate.getFullYear() : ''
  ]);

  return response({ status: 'ok' });
}

function handleSuggestion(payload) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SUGGESTIONS_SHEET);
  if (!sheet) return response({ status: 'error', message: 'Suggestions sheet not found' });

  const title = clean(payload.Title, 160);
  if (!title) return response({ status: 'error', message: 'Title is required' });

  sheet.appendRow([
    title,
    clean(payload.Type, 30),
    clean(payload.Genre, 80),
    clean(payload.Platform, 80),
    clean(payload.Note, 200),
    clean(payload.Date, 40)
  ]);

  return response({ status: 'ok' });
}

function readSheet(sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const firstRow = values[0];
  const headerOffset = firstRow.some(function(header) { return String(header).trim() === 'Name'; }) ? 0 : 1;
  if (values.length <= headerOffset) return [];
  const headers = values[headerOffset].map(function(header, index) {
    const name = String(header).trim();
    return name || 'Column ' + (index + 1);
  });

  return values.slice(headerOffset + 1).map(function(row) {
    const item = {};
    headers.forEach(function(header, index) {
      item[header] = row[index] || '';
    });
    return item;
  });
}

function clean(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function toNumber(value, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(max, number)) : 0;
}

function monthName(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMMM');
}

function constantTimeEqual(left, right) {
  left = String(left || '');
  right = String(right || '');
  if (left.length !== right.length) return false;

  let result = 0;
  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

function response(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

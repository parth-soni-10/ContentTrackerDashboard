const DATA_SHEET = 'Data';
const SUGGESTIONS_SHEET = 'Suggestions';
const WRITE_SECRET_PROPERTY = 'SCRIPT_WRITE_SECRET';
const DATA_CACHE_SECONDS = 600;

function doGet(e) {
  const sheetName = e && e.parameter && e.parameter.sheet === SUGGESTIONS_SHEET
    ? SUGGESTIONS_SHEET
    : DATA_SHEET;

  const cache = CacheService.getScriptCache();
  const cacheKey = 'sheet-json-' + sheetName;
  const cached = cache.get(cacheKey);

  if (cached) {
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

function handleAdminEntry(payload) {
  const expectedSecret = String(PropertiesService
    .getScriptProperties()
    .getProperty(WRITE_SECRET_PROPERTY) || '').trim();
  const suppliedSecret = String(
    payload.writeSecret ||
    payload.scriptWriteSecret ||
    payload.SCRIPT_WRITE_SECRET ||
    payload.script_write_secret ||
    ''
  ).trim();

  if (!expectedSecret || !constantTimeEqual(suppliedSecret, expectedSecret)) {
    return {
      status: 'error',
      message: 'Unauthorized'
    };
  }

  const name = clean(payload.Name || payload.name, 160);
  const type = clean(payload.Type || payload.type, 30);

  if (!name || !['Movie', 'Series/Show'].includes(type)) {
    return {
      status: 'error',
      message: 'Name and valid type are required'
    };
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(DATA_SHEET);

  if (!sheet) {
    return {
      status: 'error',
      message: 'Data sheet not found'
    };
  }

  const watchDateText = clean(payload.WatchDate || payload.watchDate, 40);
  const parsedDate = parseDate(watchDateText);

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function(header) {
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
  const row = headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(valuesByHeader, header) ? valuesByHeader[header] : '';
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);

  clearSheetCache();

  return { status: 'ok' };
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

  clearSheetCache();

  return { status: 'ok' };
}

function readSheet(sheet, isDataSheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (!lastRow || !lastColumn) return [];
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues();

  if (!values.length) {
    return [];
  }

  let headerOffset = 0;

  if (isDataSheet) {
    headerOffset = values.findIndex(function(row) {
      return row.some(function(cell) {
        return String(cell).trim().toLowerCase() === 'name';
      });
    });
  }

  if (headerOffset < 0 || values.length <= headerOffset + 1) {
    return [];
  }

  const headers = values[headerOffset].map(function(header, index) {
    const name = String(header).trim();
    return name || 'Column ' + (index + 1);
  });

  return values
    .slice(headerOffset + 1)
    .filter(function(row) {
      return String(row[0] || '').trim() !== '';
    })
    .map(function(row) {
      const item = {};

      headers.forEach(function(header, index) {
        item[header] = String(row[index] || '').trim();
      });

      return item;
    });
}

function clearSheetCache() {
  const cache = CacheService.getScriptCache();
  cache.remove('sheet-json-' + DATA_SHEET);
  cache.remove('sheet-json-' + SUGGESTIONS_SHEET);
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

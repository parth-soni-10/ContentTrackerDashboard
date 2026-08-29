const DATA_SHEET = 'Data';
const SUGGESTIONS_SHEET = 'Suggestions';
const WRITE_SECRET_PROPERTY = 'SCRIPT_WRITE_SECRET';
const WRITE_SECRET_FALLBACK = ''; // Optional: set the same secret here only if Script Properties are unavailable.
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
  } else if (payload.action === 'admin-update') {
    result = handleAdminUpdate(payload);
  } else if (payload.action === 'admin-delete') {
    result = handleAdminDelete(payload);
  } else if (payload.action === 'admin-rate') {
    result = handleAdminRate(payload);
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
  const expectedSecret = String(
    properties.getProperty(WRITE_SECRET_PROPERTY) || WRITE_SECRET_FALLBACK
  ).trim();
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
    year: parsedDate ? parsedDate.getFullYear() : '',
    rating: clean(payload.Rating || payload.rating, 10)
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

  const row = buildEntryRow(sheet, payload, name, type);
  const targetRow = sheet.getLastRow() + 1;
  sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
  SpreadsheetApp.flush();

  clearSheetCache();

  return {
    status: 'ok',
    saved: true,
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: sheet.getName(),
    rowNumber: targetRow,
    name: name
  };
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

  if (rowNumber <= findHeaderRow(sheet) || rowNumber > sheet.getLastRow()) {
    return {
      status: 'error',
      message: 'Row ' + rowNumber + ' is not a data row'
    };
  }

  const row = buildEntryRow(sheet, payload, name, type);
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  SpreadsheetApp.flush();

  clearSheetCache();

  return {
    status: 'ok',
    saved: true,
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: sheet.getName(),
    rowNumber: rowNumber,
    name: name
  };
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

  const headerRow = findHeaderRow(sheet);
  if (rowNumber <= headerRow || rowNumber > sheet.getLastRow()) {
    return {
      status: 'error',
      message: 'Row ' + rowNumber + ' is not a data row'
    };
  }

  sheet.deleteRow(rowNumber);
  SpreadsheetApp.flush();

  clearSheetCache();

  return {
    status: 'ok',
    deleted: true,
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: sheet.getName(),
    rowNumber: rowNumber
  };
}

function handleAdminRate(payload) {
  const unauthorized = authorizeWrite(payload);
  if (unauthorized) return unauthorized;

  const rowNumber = Number(payload.Row || payload.row);
  const rating = Number(payload.Rating || payload.rating);
  if (!Number.isInteger(rowNumber) || ![1, 2, 3, 4, 5].includes(rating)) {
    return {
      status: 'error',
      message: 'A valid row number and rating are required'
    };
  }

  const sheet = getDataSheet();
  if (!sheet) {
    return {
      status: 'error',
      message: 'Data sheet not found'
    };
  }

  const headerRow = findHeaderRow(sheet);
  if (rowNumber <= headerRow || rowNumber > sheet.getLastRow()) {
    return {
      status: 'error',
      message: 'Row ' + rowNumber + ' is not a data row'
    };
  }

  // Find the Rating column, creating it on the header row if missing so a
  // first rating can be set without a manual sheet edit.
  const headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function(header) {
    return String(header).trim().toLowerCase();
  });
  let column = headers.indexOf('rating');
  if (column < 0) {
    column = headers.length;
    sheet.getRange(headerRow, column + 1).setValue('Rating');
  }

  sheet.getRange(rowNumber, column + 1).setValue(String(rating));
  SpreadsheetApp.flush();
  clearSheetCache();

  return {
    status: 'ok',
    saved: true,
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: sheet.getName(),
    rowNumber: rowNumber,
    rating: rating
  };
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

// Returns the 1-based row number of the Data sheet's header row (the first row
// containing a cell with the value 'name'), falling back to row 1.
function findHeaderRow(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (!lastRow || !lastColumn) return 1;

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues();
  const index = values.findIndex(function(row) {
    return row.some(function(cell) {
      return String(cell).trim().toLowerCase() === 'name';
    });
  });

  return index < 0 ? 1 : index + 1;
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
    headerOffset = findHeaderRow(sheet) - 1;
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

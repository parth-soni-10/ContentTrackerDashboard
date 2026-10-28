// Import rows into the watchlist store.
//
// This is the recovery path for the Postgres → D1 move: the rows were held in
// Netlify Database, whose Neon endpoint came back disabled once the Netlify site
// was deleted, so there was no connection string left to dump. Everything the
// store holds can still arrive from the exporting side - the Google Sheet the
// rows originally came from, or any CSV/JSON export of them - and this endpoint
// is what puts them in D1.
//
// It is the same shape as the one-shot importer that moved the Sheet into
// Postgres (since deleted, along with lib/sheets.js): admin-session gated because
// it is a write endpoint, and *additive* - it never deletes and never updates a
// row that is already there. Running it twice is safe and is in fact the check:
// a row whose duplicate key (the same name/season/watch-date/screentime rule the
// admin form uses, implemented once in lib/db.js) already exists is counted as a
// duplicate, not inserted again. So a second run over the same file reporting
// `inserted: 0` is the proof that every row in it is now in the store.
//
// Rows arrive in the body, in the wire shape the page and the Sheet share:
//   { Name, Season, Type, "Details/Genre", Platform, "Episode Count",
//     Screentime, "Watch Date" }
// Key matching ignores case and spacing, so a CSV export whose columns are
// "episode count" or "EpisodeCount" lands in the right field too.
const db = require('./lib/db');
const { validSession } = require('./lib/session');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

// One request cannot be unbounded: the table is a personal watch list, and a
// body that claims to be an import is not a reason to accept an arbitrary one.
const MAX_ROWS = 2000;

// Reads the first key that matches, ignoring case and spacing - the same
// tolerance the deleted importer had for the Sheet's header row.
const text = (row, ...names) => {
  for (const name of names) {
    for (const key of Object.keys(row)) {
      if (key.trim().toLowerCase().replace(/[\s_/]+/g, '') === name) {
        return String(row[key] == null ? '' : row[key]).trim();
      }
    }
  }
  return '';
};

const number = (row, ...names) => {
  const raw = text(row, ...names);
  return Number(raw.replace(/[^0-9.-]/g, '')) || 0;
};

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!validSession(event)) return json(401, { error: 'Admin session required', code: 'SESSION_INVALID' });
  if (!db.dbEnabled()) return json(500, { error: 'Import service is not configured', code: 'CONFIG_MISSING' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }

  const incoming = Array.isArray(body.rows) ? body.rows : null;
  if (!incoming) return json(400, { error: 'A rows array is required' });
  if (incoming.length > MAX_ROWS) {
    return json(413, { error: `A single import carries at most ${MAX_ROWS} rows`, code: 'TOO_MANY_ROWS' });
  }

  const report = { received: incoming.length, inserted: 0, duplicates: 0, skipped: 0, skippedRows: [] };
  try {
    for (const row of incoming) {
      if (!row || typeof row !== 'object') { report.skipped++; continue; }
      const entry = {
        name: text(row, 'name'),
        season: text(row, 'season'),
        type: text(row, 'type'),
        genre: text(row, 'detailsgenre', 'genre', 'details'),
        platform: text(row, 'platform'),
        episodes: number(row, 'episodecount', 'episodes'),
        screentime: number(row, 'screentime'),
        watchDate: text(row, 'watchdate', 'date')
      };
      // A row with no title is not a watch, it is a blank line in a spreadsheet.
      if (!entry.name) {
        report.skipped++;
        if (report.skippedRows.length < 25) report.skippedRows.push({ name: entry.name, watchDate: entry.watchDate });
        continue;
      }
      const result = await db.createEntry(entry);
      if (result.duplicate) report.duplicates++;
      else report.inserted++;
    }
  } catch (error) {
    // Rows already written stay written - the import is additive and idempotent,
    // so answering with what did land and re-running is safe.
    console.error('Import failed part-way:', error);
    return json(502, { ...report, error: error.message || 'Import failed', code: 'DB_ERROR' });
  }

  // The store's own figures, so the run can be judged without a second request.
  let stored = null;
  try {
    const rows = await db.listEntries();
    const years = rows.map(r => r.Year).filter(Boolean).sort();
    stored = { entries: rows.length, earliestYear: years[0] || null, latestYear: years[years.length - 1] || null };
  } catch (error) {
    console.error('Reading the store after the import failed:', error.message);
  }

  return json(200, { status: 'ok', ...report, stored });
};

exports.MAX_ROWS = MAX_ROWS;

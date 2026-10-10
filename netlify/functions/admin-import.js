// One-shot importer: copies the Google Sheet's rows into the database.
//
// The Sheet stays the working copy until the new store has proved itself, so
// this reads it and *adds* to Postgres — it never writes back to the Sheet and
// never deletes a database row. Running it twice is safe: a row whose duplicate
// key (the same name/season/watch-date/screentime rule the admin form uses)
// already exists is skipped, not inserted a second time. That also means it
// copies; it does not sync — a later edit in the Sheet needs the row removed
// from the database first, and after the cutover this file and lib/sheets.js go
// away together.
//
// Admin-session gated because it is a write endpoint, and because it needs the
// Sheet credentials: the whole point is that the spreadsheet key never leaves
// the deployment, so the import is driven by a signed-in request against the
// site itself (see the README's one-time import section), not from a laptop
// holding a copy of the key.
const db = require('./lib/db');
const sheets = require('./lib/sheets');
const { validSession } = require('./lib/session');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

const text = (row, ...names) => {
  for (const name of names) {
    for (const key of Object.keys(row)) {
      if (key.trim().toLowerCase() === name) return String(row[key] == null ? '' : row[key]).trim();
    }
  }
  return '';
};

// The database's duplicate key, computed the same way createEntry computes it:
// title case-folded, season normalised, date at day precision, screentime as a
// number. Two rows that differ only in how the Sheet spells them collide here
// on purpose — that is what makes a second run a no-op.
function entryKey(name, season, watchDate, screentime) {
  return [
    String(name || '').trim().toLowerCase(),
    db.seasonKey(season),
    db.isoOf(db.parseDateParts(watchDate)) || '',
    Number(screentime) || 0
  ].join('\u0001');
}

function suggestionKey(title, date, note) {
  return [
    String(title || '').trim().toLowerCase(),
    db.isoOf(db.parseDateParts(date)) || '',
    String(note || '').trim().toLowerCase()
  ].join('\u0001');
}

// ── THE TWO STORES, ROW BY ROW ────────────────────────────────────────────
// `{ verify: true }` answers "did the data actually move?" with a comparison
// rather than a count: both sides are read, aligned on what identifies a watch
// (title, season, date) and every other field is compared. Rows that exist on
// only one side, fields that disagree and the undated rows are reported by name,
// so the claim can be checked. It writes nothing.
const LIST_CAP = 25;
const foldText = value => String(value == null ? '' : value).trim();
const foldKey = value => foldText(value).toLowerCase();
const foldNum = value => Number(String(value == null ? '' : value).replace(/[^0-9.-]/g, '')) || 0;
const FIELD_FOLD = { type: foldKey, genre: foldKey, platform: foldKey, note: foldKey, episodes: foldNum, screentime: foldNum };
const ENTRY_FIELDS = ['type', 'genre', 'platform', 'episodes', 'screentime'];
const SUGGESTION_FIELDS = ['type', 'genre', 'platform', 'note'];

// Aligned on title + season + date and deliberately *not* on screentime: a row
// whose screentime differs is one row that disagrees, not a missing row plus an
// extra one.
const alignKey = side => [foldKey(side.name), db.seasonKey(side.season), side.date || ''].join('\u0001');

function compareRows(sheetRows, sheetSide, dbRows, dbSide, fields, label) {
  const index = (rows, toSide) => {
    const seen = new Map();
    const repeated = [];
    for (const row of rows) {
      const side = toSide(row);
      if (!side.name) continue;
      const key = alignKey(side);
      if (seen.has(key)) repeated.push(side.label);
      seen.set(key, side);
    }
    return { seen, repeated };
  };
  const sheet = index(sheetRows, sheetSide);
  const stored = index(dbRows, dbSide);
  const missing = [];
  const mismatched = [];
  sheet.seen.forEach((a, key) => {
    const b = stored.seen.get(key);
    if (!b) { missing.push(a.label); return; }
    const differences = {};
    for (const field of fields) {
      if (FIELD_FOLD[field](a[field]) !== FIELD_FOLD[field](b[field])) {
        differences[field] = { sheet: a[field], database: b[field] };
      }
    }
    if (Object.keys(differences).length) mismatched.push({ row: a.label, differences });
  });
  const extra = [];
  stored.seen.forEach((side, key) => { if (!sheet.seen.has(key)) extra.push(side.label); });
  return {
    rows: label,
    sheet: sheet.seen.size,
    database: stored.seen.size,
    missing: missing.slice(0, LIST_CAP),
    extra: extra.slice(0, LIST_CAP),
    mismatched: mismatched.slice(0, LIST_CAP),
    repeatedInSheet: sheet.repeated.slice(0, LIST_CAP),
    truncated: { missing: Math.max(0, missing.length - LIST_CAP), extra: Math.max(0, extra.length - LIST_CAP), mismatched: Math.max(0, mismatched.length - LIST_CAP) },
    undated: { sheet: sheetRows.filter(row => !sheetSide(row).date).length, database: dbRows.filter(row => !dbSide(row).date).length }
  };
}

async function integrityReport(data, suggestions, goal) {
  const { rows: entries } = await db.query(
    "SELECT name, season, type, genre, platform, episodes, screentime, to_char(watch_date, 'YYYY-MM-DD') AS watch_date FROM entries"
  );
  const { rows: storedSuggestions } = await db.query(
    "SELECT title, type, genre, platform, note, to_char(submitted_date, 'YYYY-MM-DD') AS submitted_date FROM suggestions"
  );
  const storedGoal = await db.readGoal();
  const entryLabel = (name, season, date) => foldText(name) + (foldText(season) ? ' S' + foldText(season) : '') + ' · ' + (date || 'no date');

  const sheetEntry = row => {
    const date = db.isoOf(db.parseDateParts(text(row, 'watch date'))) || '';
    const name = text(row, 'name');
    return {
      name, season: text(row, 'season'), date,
      type: text(row, 'type'), genre: text(row, 'details/genre', 'genre'), platform: text(row, 'platform'),
      episodes: text(row, 'episode count'), screentime: text(row, 'screentime'),
      label: entryLabel(name, text(row, 'season'), date)
    };
  };
  const dbEntry = row => ({
    name: row.name, season: row.season, date: row.watch_date || '',
    type: row.type, genre: row.genre, platform: row.platform,
    episodes: row.episodes, screentime: row.screentime,
    label: entryLabel(row.name, row.season, row.watch_date || '')
  });
  const sheetSuggestion = row => {
    const date = db.isoOf(db.parseDateParts(text(row, 'date'))) || '';
    const name = text(row, 'title');
    return {
      name, season: '', date,
      type: text(row, 'type'), genre: text(row, 'genre'), platform: text(row, 'platform'), note: text(row, 'note'),
      label: name + ' · ' + (date || 'no date')
    };
  };
  const dbSuggestion = row => ({
    name: row.title, season: '', date: row.submitted_date || '',
    type: row.type, genre: row.genre, platform: row.platform, note: row.note,
    label: foldText(row.title) + ' · ' + (row.submitted_date || 'no date')
  });

  return {
    mode: 'verify',
    entries: compareRows(data.rows, sheetEntry, entries, dbEntry, ENTRY_FIELDS, 'entries'),
    suggestions: compareRows(suggestions.rows, sheetSuggestion, storedSuggestions, dbSuggestion, SUGGESTION_FIELDS, 'suggestions'),
    goal: {
      sheet: goal.hrs > 0 ? { hrs: goal.hrs, year: goal.year } : null,
      database: storedGoal.hrs > 0 ? { hrs: storedGoal.hrs, year: storedGoal.year } : null,
      match: Boolean(goal.hrs) === Boolean(storedGoal.hrs) && Number(goal.hrs || 0) === Number(storedGoal.hrs || 0)
    }
  };
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!validSession(event)) return json(401, { error: 'Admin session required', code: 'SESSION_INVALID' });
  if (!db.dbEnabled()) return json(500, { error: 'The database is not configured for this deploy', code: 'CONFIG_MISSING' });
  if (!sheets.sheetsEnabled()) return json(500, { error: 'The Sheet credentials are not configured for this deploy', code: 'SHEETS_MISSING' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }
  const verify = body.verify === true; // compare the two stores; never writes
  const dryRun = body.dryRun !== false; // dry run unless explicitly asked to write

  try {
    const [data, suggestions, goal] = await Promise.all([
      sheets.readSheet('Data'),
      sheets.readSheet('Suggestions', true),
      sheets.readGoal()
    ]);

    const summary = {
      dryRun,
      entries: { read: data.rows.length, imported: 0, skipped: 0, undated: 0 },
      suggestions: { read: suggestions.rows.length, imported: 0, skipped: 0 },
      goal: { read: goal.hrs > 0 ? goal : null, imported: false }
    };

    if (verify) return json(200, await integrityReport(data, suggestions, goal));

    if (dryRun) {
      const { rows } = await db.query("SELECT id, name, season, to_char(watch_date, 'YYYY-MM-DD') AS watch_date, screentime FROM entries");
      const existing = new Set(rows.map(row => entryKey(row.name, row.season, row.watch_date, row.screentime)));
      for (const row of data.rows) {
        const key = entryKey(text(row, 'name'), text(row, 'season'), text(row, 'watch date'), text(row, 'screentime'));
        if (existing.has(key)) summary.entries.skipped++; else summary.entries.imported++;
      }
      const { rows: existingSuggestions } = await db.query("SELECT title, to_char(submitted_date, 'YYYY-MM-DD') AS submitted_date, note FROM suggestions");
      const known = new Set(existingSuggestions.map(row => suggestionKey(row.title, row.submitted_date, row.note)));
      for (const row of suggestions.rows) {
        const key = suggestionKey(text(row, 'title'), text(row, 'date'), text(row, 'note'));
        if (known.has(key)) summary.suggestions.skipped++; else summary.suggestions.imported++;
      }
      summary.goal.imported = goal.hrs > 0 && !(await db.readGoal()).hrs;
      return json(200, summary);
    }

    // One transaction for the whole copy, under an advisory lock: a retry that
    // lands while the first attempt is still running waits rather than
    // duplicating half the sheet.
    await db.withClient(async client => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('watchlist-import'))");

        const { rows: existingEntries } = await client.query(
          "SELECT name, season, to_char(watch_date, 'YYYY-MM-DD') AS watch_date, screentime FROM entries"
        );
        const seen = new Set(existingEntries.map(row => entryKey(row.name, row.season, row.watch_date, row.screentime)));

        for (const row of data.rows) {
          const name = text(row, 'name');
          if (!name) continue;
          const season = text(row, 'season');
          const watchDate = text(row, 'watch date');
          const screentime = text(row, 'screentime');
          const key = entryKey(name, season, watchDate, screentime);
          if (seen.has(key)) { summary.entries.skipped++; continue; }
          seen.add(key);
          await client.query(
            'INSERT INTO entries (name, season, type, genre, platform, episodes, screentime, watch_date)' +
            ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              name.slice(0, 160), season.slice(0, 20), text(row, 'type').slice(0, 30),
              text(row, 'details/genre', 'genre').slice(0, 80), text(row, 'platform').slice(0, 80),
              Number(text(row, 'episode count')) || 0, Number(screentime) || 0,
              db.isoOf(db.parseDateParts(watchDate))
            ]
          );
          summary.entries.imported++;
          if (!db.parseDateParts(watchDate)) summary.entries.undated++;
        }

        const { rows: existingSuggestions } = await client.query("SELECT title, to_char(submitted_date, 'YYYY-MM-DD') AS submitted_date, note FROM suggestions");
        const known = new Set(existingSuggestions.map(row => suggestionKey(row.title, row.submitted_date, row.note)));
        for (const row of suggestions.rows) {
          const title = text(row, 'title');
          if (!title) continue;
          const date = text(row, 'date');
          const note = text(row, 'note');
          const key = suggestionKey(title, date, note);
          if (known.has(key)) { summary.suggestions.skipped++; continue; }
          known.add(key);
          await client.query(
            'INSERT INTO suggestions (title, type, genre, platform, note, submitted_date) VALUES ($1, $2, $3, $4, $5, $6)',
            [
              title.slice(0, 160), text(row, 'type').slice(0, 30), text(row, 'genre').slice(0, 80),
              text(row, 'platform').slice(0, 80), note.slice(0, 200), db.isoOf(db.parseDateParts(date))
            ]
          );
          summary.suggestions.imported++;
        }

        // The year's goal is copied only when the database has none of its own,
        // so a re-run can never overwrite a goal set on the site afterwards.
        // Read through this transaction's client, not the pool: the pool holds a
        // single connection and this code already has it.
        const { rows: goalRows } = await client.query('SELECT value FROM settings WHERE key = $1', ['watch-goal']);
        const currentGoal = goalRows.length ? JSON.parse(String(goalRows[0].value || '').trim() || '{}') : null;
        if (goal.hrs > 0 && !(currentGoal && Number(currentGoal.hrs) > 0)) {
          await client.query(
            'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
            ['watch-goal', JSON.stringify({ hrs: goal.hrs, year: goal.year })]
          );
          summary.goal.imported = true;
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });

    return json(200, summary);
  } catch (error) {
    console.error('Sheet import failed:', error);
    return json(502, { error: error.message || 'Import failed' });
  }
};

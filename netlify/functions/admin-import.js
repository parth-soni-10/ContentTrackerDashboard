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

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!validSession(event)) return json(401, { error: 'Admin session required', code: 'SESSION_INVALID' });
  if (!db.dbEnabled()) return json(500, { error: 'The database is not configured for this deploy', code: 'CONFIG_MISSING' });
  if (!sheets.sheetsEnabled()) return json(500, { error: 'The Sheet credentials are not configured for this deploy', code: 'SHEETS_MISSING' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }
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

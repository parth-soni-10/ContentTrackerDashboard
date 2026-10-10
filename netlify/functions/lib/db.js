// Postgres access for the Netlify functions — the watchlist's own store.
//
// This replaces lib/sheets.js, which read and wrote a Google Sheet through a
// service account. The database is Netlify's managed Postgres: @netlify/database
// hands out the connection string for whichever database this deploy is attached
// to — production's database for a production deploy, a throwaway branch forked
// from it for a deploy preview — and pg runs the queries. NETLIFY_DB_URL is the
// same string as an environment variable, used first when it is set so the
// functions never depend on the module being importable at runtime (it only has
// to be *installed*, which is also what tells Netlify to provision the database).
//
// Two things are deliberately unchanged from the Sheet era, because the page
// consumes them:
//   * the wire shape. A row still goes out as { _row, Name, Season, …, 'Watch
//     Date' } with a display date like "3-Sep-26" and a Month/Year pair, which
//     is what app.js has always mapped — so the frontend needed no change to
//     read a different store.
//   * the duplicate rule: name (case-insensitive), season ('S2' = 'Season 2' =
//     '2'), watch date and screentime all equal is the same watch logged twice.
//     It is implemented here in JS against the rows that share a name, the way
//     it was against the sheet, because that normalisation exists in exactly one
//     place — seasonKey below. Concurrent adds of the same title are serialised
//     with an advisory lock so two requests cannot both pass the check.
const { Pool } = require('pg');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = MONTHS.map(name => name.slice(0, 3));
const GOAL_PROPERTY = 'watch-goal';

// ── Connection ─────────────────────────────────────────────────────────────
function connectionString() {
  const explicit = String(process.env.NETLIFY_DB_URL || '').trim();
  if (explicit) return explicit;
  try {
    const { getConnectionString } = require('@netlify/database');
    return String(getConnectionString() || '').trim();
  } catch (error) {
    // No database attached to this deploy (or running outside Netlify): the
    // callers answer "service is not configured", which is the honest state.
    return '';
  }
}

function dbEnabled() {
  return Boolean(connectionString());
}

let pool = null;
function getPool() {
  const url = connectionString();
  if (!url) throw new Error('No database connection string for this deploy');
  if (!pool) {
    // One connection per function instance: Netlify Database's string already
    // points at a pooler, and a serverless instance that opens more than one is
    // how a database runs out of connections under load.
    pool = new Pool({ connectionString: url, max: 1, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
    // A pool error is emitted on the pool, not on the query that caused it; an
    // unhandled 'error' event would take the process down.
    pool.on('error', error => console.error('Postgres pool error:', error.message));
  }
  return pool;
}

const query = (text, params) => getPool().query(text, params);

async function withClient(work) {
  const client = await getPool().connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

// ── Dates ──────────────────────────────────────────────────────────────────
// Two shapes are accepted wherever a date comes in: ISO (what an <input
// type="date"> sends) and the sheet's display format (what old rows and the
// import carry). Everything is stored as a real DATE and read back as ISO text,
// so no timezone can move a watch date by a day.
function parseDateParts(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
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

const pad = value => String(value).padStart(2, '0');
const isoOf = parts => parts ? `${parts.y}-${pad(parts.mo)}-${pad(parts.d)}` : null;
const displayOf = parts => parts ? `${parts.d}-${MONTH_SHORT[parts.mo - 1]}-${String(parts.y).slice(2)}` : '';

// Normalizes a season so 'S1', 'Season 01' and '1' compare equal — the single
// definition the duplicate rule rests on.
function seasonKey(value) {
  let text = String(value || '').trim().toLowerCase()
    .replace(/^season\s*/, '')
    .replace(/^series\s*/, '')
    .replace(/^#\s*/, '');
  if (/^s\s*\d/.test(text)) text = text.slice(1).trim();
  const number = Number(text);
  return text && Number.isInteger(number) ? '#' + number : text;
}

// ── Read ───────────────────────────────────────────────────────────────────
// The page's row shape: header-style keys, `_row` for the record's id (it was
// the sheet's row number, and the page only ever hands it back), and the date in
// the display format the sheet used.
function toWireRow(row) {
  const parts = parseDateParts(row.watch_date);
  return {
    _row: Number(row.id),
    Name: row.name,
    Season: row.season || '',
    Type: row.type || '',
    'Details/Genre': row.genre || '',
    Platform: row.platform || '',
    'Episode Count': String(row.episodes || 0),
    Screentime: String(Number(row.screentime) || 0),
    'Watch Date': displayOf(parts),
    Month: parts ? MONTHS[parts.mo - 1] : '',
    Year: parts ? String(parts.y) : ''
  };
}

// `to_char` rather than a `::text` cast: a cast formats the date according to the
// connection's DateStyle, so a session that is not on ISO could hand back
// "09/03/2026" and read back as a different day. This spelling is fixed.
const ENTRY_COLUMNS = 'id, name, season, type, genre, platform, episodes, screentime, '
  + "to_char(watch_date, 'YYYY-MM-DD') AS watch_date";

async function listEntries() {
  const { rows } = await query('SELECT ' + ENTRY_COLUMNS + ' FROM entries ORDER BY watch_date ASC NULLS LAST, id ASC');
  return rows.map(toWireRow);
}

async function listSuggestions() {
  const { rows } = await query(
    "SELECT id, title, type, genre, platform, note, to_char(submitted_date, 'YYYY-MM-DD') AS submitted_date FROM suggestions ORDER BY id ASC"
  );
  return rows.map(row => ({
    _row: Number(row.id),
    Title: row.title,
    Type: row.type || '',
    Genre: row.genre || '',
    Platform: row.platform || '',
    Note: row.note || '',
    Date: displayOf(parseDateParts(row.submitted_date))
  }));
}

// Rows the watchlist itself can never show: the page's `mapRows` drops every
// row whose year reads as 0, so a stored row with no watch date and no watch
// time is invisible in every list, chart and search on the site. This is the
// one read that exposes them — the admin cleanup card lists them as the raw
// rows (ids and timestamps included) so they can be deleted deliberately.
async function listInvalidEntries() {
  const { rows } = await query(
    'SELECT id, name, season, type, genre, platform, episodes, screentime,' +
    " to_char(watch_date, 'YYYY-MM-DD') AS watch_date, created_at, updated_at" +
    ' FROM entries WHERE watch_date IS NULL AND screentime <= 0 ORDER BY id ASC'
  );
  return rows.map(row => ({
    id: Number(row.id),
    name: row.name,
    season: row.season || '',
    type: row.type || '',
    genre: row.genre || '',
    platform: row.platform || '',
    episodes: Number(row.episodes) || 0,
    screentime: Number(row.screentime) || 0,
    watchDate: row.watch_date || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  }));
}

// The Sheet-era duplicate check, on the wire rows: an exact repeat of the same
// title, season, watch date and screentime. Returns the id it found, or 0.
function findDuplicateRow(rows, entry) {
  const wanted = {
    name: String(entry.name || '').trim().toLowerCase(),
    season: seasonKey(entry.season),
    date: isoOf(parseDateParts(entry.watchDate)) || '',
    screentime: Number(entry.screentime) || 0
  };
  for (const row of rows) {
    if (String(row.Name || '').trim().toLowerCase() !== wanted.name) continue;
    if (seasonKey(row.Season) !== wanted.season) continue;
    if ((isoOf(parseDateParts(row['Watch Date'])) || '') !== wanted.date) continue;
    if ((Number(row.Screentime) || 0) !== wanted.screentime) continue;
    return Number(row._row);
  }
  return 0;
}

// ── Write ──────────────────────────────────────────────────────────────────
const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
const intOr = (value, max) => (Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Math.round(Number(value)))) : 0);

// Returns { id } for a new row, or { duplicate: id } when the same watch is
// already logged. The advisory lock is taken on the title, so two requests that
// add the same show at the same time are serialised rather than both inserted.
async function createEntry(entry) {
  const name = clean(entry.name, 160);
  const watchDate = isoOf(parseDateParts(entry.watchDate));
  return withClient(async client => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [name.toLowerCase()]);
      const { rows } = await client.query(
        'SELECT ' + ENTRY_COLUMNS + " FROM entries WHERE lower(name) = lower($1)",
        [name]
      );
      const existing = findDuplicateRow(rows.map(toWireRow), entry);
      if (existing) {
        await client.query('ROLLBACK');
        return { duplicate: existing };
      }
      const inserted = await client.query(
        'INSERT INTO entries (name, season, type, genre, platform, episodes, screentime, watch_date)' +
        ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
        [name, clean(entry.season, 20), clean(entry.type, 30), clean(entry.genre, 80), clean(entry.platform, 80),
          intOr(entry.episodes, 9999), intOr(entry.screentime, 100000), watchDate]
      );
      await client.query('COMMIT');
      return { id: Number(inserted.rows[0].id) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

async function updateEntry(id, entry) {
  const { rows } = await query(
    'UPDATE entries SET name = $2, season = $3, type = $4, genre = $5, platform = $6, episodes = $7,' +
    ' screentime = $8, watch_date = $9, updated_at = now() WHERE id = $1 RETURNING id',
    [id, clean(entry.name, 160), clean(entry.season, 20), clean(entry.type, 30), clean(entry.genre, 80),
      clean(entry.platform, 80), intOr(entry.episodes, 9999), intOr(entry.screentime, 100000),
      isoOf(parseDateParts(entry.watchDate))]
  );
  return rows.length ? Number(rows[0].id) : 0;
}

async function deleteEntry(id) {
  const { rows } = await query('DELETE FROM entries WHERE id = $1 RETURNING id', [id]);
  return rows.length ? Number(rows[0].id) : 0;
}

async function appendSuggestion(values) {
  // The sheet's Suggestions layout is fixed: title, type, genre, platform, note,
  // date.
  const [title, type, genre, platform, note, date] = values;
  await query(
    'INSERT INTO suggestions (title, type, genre, platform, note, submitted_date) VALUES ($1, $2, $3, $4, $5, $6)',
    [clean(title, 160), clean(type, 30), clean(genre, 80), clean(platform, 80), clean(note, 200),
      isoOf(parseDateParts(date))]
  );
}

// ── Yearly goal ────────────────────────────────────────────────────────────
// The goal lives in the settings table so it syncs across devices and stays with
// the data, exactly as it did in the sheet's Settings tab.
async function readGoal() {
  try {
    const { rows } = await query('SELECT value FROM settings WHERE key = $1', [GOAL_PROPERTY]);
    if (!rows.length) return { hrs: 0, year: '' };
    const parsed = JSON.parse(String(rows[0].value || '').trim() || '{}');
    return { hrs: Math.max(0, Number(parsed.hrs) || 0), year: String(parsed.year || '') };
  } catch (error) {
    console.error('Reading the goal failed:', error.message);
    return { hrs: 0, year: '' };
  }
}

// Returns { status: 'ok', goal } or { status: 'error', message }. A set goal for
// a year stays locked until 1 January — enforced here so no device can change it
// mid-year (an identical re-set is a no-op).
async function setGoal(hrs, year) {
  const current = await readGoal();
  if (current.hrs > 0 && current.year === year) {
    if (hrs !== current.hrs) {
      return { status: 'error', message: `The goal for ${year} is already set and locked until 1 January` };
    }
    return { status: 'ok', goal: current };
  }
  const goal = hrs > 0 ? { hrs: Math.round(hrs * 100) / 100, year } : null;
  await query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [GOAL_PROPERTY, goal ? JSON.stringify(goal) : '']
  );
  return { status: 'ok', goal: goal ? { hrs: goal.hrs, year: goal.year } : { hrs: 0, year: '' } };
}

module.exports = {
  dbEnabled,
  query,
  withClient,
  listEntries,
  listSuggestions,
  listInvalidEntries,
  findDuplicateRow,
  createEntry,
  updateEntry,
  deleteEntry,
  appendSuggestion,
  readGoal,
  setGoal,
  // Exported for the importer and for the duplicate rule's own tests.
  seasonKey,
  parseDateParts,
  isoOf,
  displayOf
};

// D1 access for the Worker — the watchlist's own store.
//
// The history, because it explains the shape of this file: the watchlist lived
// in a Google Sheet, then in Netlify Database (managed Postgres, queried with
// `pg`), and now in D1. The Sheet is retired and unread — lib/sheets.js and the
// one-shot importer that copied its rows across were deleted once the importer's
// verify pass showed the two stores matching row for row (380 entries, none
// missing, none extra, no disagreement). Nothing here can reach it.
//
// What did *not* change in the move to D1, and must not:
//   * the wire shape. A row still goes out as { _row, Name, Season, …, 'Watch
//     Date' } with a display date like "3-Sep-26" and a Month/Year pair, which
//     is what app.js has always mapped — so the frontend needed no change to
//     read a third store either.
//   * the duplicate rule: name (case-insensitive), season ('S2' = 'Season 2' =
//     '2'), watch date and screentime all equal is the same watch logged twice.
//     It is implemented here in JS against the rows that share a name, the way
//     it was against the sheet, because that normalisation exists in exactly one
//     place — seasonKey below.
//
// What did change: how a concurrent double submit is stopped. Postgres was given
// an advisory lock on the title and the check ran inside that transaction. D1
// has no session locks (and no interactive transactions), so the rule's key is
// computed once, here, into `dup_key`, and the insert carries
// `WHERE NOT EXISTS (… dup_key = ?)` — one atomic statement, which is a stronger
// guarantee than the lock was: two adds arriving together cannot both write,
// whether they reach the same instance or not.
//
// The connection is injected: worker.js calls setDatabase(env.DB) per request.
// The Netlify build used to get its connection string from NETLIFY_DB_URL (or
// @netlify/database) — there is no equivalent now, because there is nothing to
// connect to: D1 is a binding.

let database = null;

function setDatabase(binding) {
  database = binding || null;
}

function dbEnabled() {
  return Boolean(database);
}

function requireDb() {
  if (!database) throw new Error('No database is bound to this Worker');
  return database;
}

/** A SELECT: returns its rows, so callers read `rows[0]` as they did with pg. */
async function rows(sql, params = []) {
  const result = await requireDb().prepare(sql).bind(...params).all();
  return result.results || [];
}

/** A write: returns D1's meta, whose `changes` says whether anything matched. */
async function write(sql, params = []) {
  const result = await requireDb().prepare(sql).bind(...params).run();
  return result.meta || {};
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = MONTHS.map(name => name.slice(0, 3));
const GOAL_PROPERTY = 'watch-goal';

// ── Dates ──────────────────────────────────────────────────────────────────
// Two shapes are accepted wherever a date comes in: ISO (what an <input
// type="date"> sends) and the sheet's display format (what old rows and the
// import carry). Everything is stored as 'YYYY-MM-DD' — a plain string, so no
// timezone and no session DateStyle can move a watch date by a day — and read
// back as that same ISO text.
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
const nowIso = () => new Date().toISOString();

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

// The columns every entry read wants. Postgres spelled the date
// `to_char(watch_date, 'YYYY-MM-DD')` because a ::text cast formats by session
// DateStyle; the column is already ISO text here, so there is nothing to format.
const ENTRY_COLUMNS = 'id, name, season, type, genre, platform, episodes, screentime, watch_date';

async function listEntries() {
  // `watch_date IS NULL` sorts as 0/1 ahead of the date, which is SQLite's
  // spelling of Postgres's `NULLS LAST` and keeps undated rows at the bottom.
  const result = await rows(
    'SELECT ' + ENTRY_COLUMNS + ' FROM entries ORDER BY (watch_date IS NULL) ASC, watch_date ASC, id ASC'
  );
  return result.map(toWireRow);
}

async function listSuggestions() {
  const result = await rows(
    'SELECT id, title, type, genre, platform, note, submitted_date FROM suggestions ORDER BY id ASC'
  );
  return result.map(row => ({
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
  const result = await rows(
    'SELECT id, name, season, type, genre, platform, episodes, screentime, watch_date, created_at, updated_at' +
    ' FROM entries WHERE watch_date IS NULL AND screentime <= 0 ORDER BY id ASC'
  );
  return result.map(row => ({
    id: Number(row.id),
    name: row.name,
    season: row.season || '',
    type: row.type || '',
    genre: row.genre || '',
    platform: row.platform || '',
    episodes: Number(row.episodes) || 0,
    screentime: Number(row.screentime) || 0,
    watchDate: row.watch_date || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
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

// The duplicate rule's key, computed in exactly one place. A NUL joins the parts
// because it cannot occur in a title, so 'A' + '1' can never collide with 'A1'.
function duplicateKey(values) {
  return [
    String(values.name || '').trim().toLowerCase(),
    seasonKey(values.season),
    isoOf(parseDateParts(values.watchDate)) || '',
    Number(values.screentime) || 0
  ].join('\u0000');
}

// Normalizes an incoming entry once, so the insert and the key cannot disagree.
function normalizeEntry(entry) {
  return {
    name: clean(entry.name, 160),
    season: clean(entry.season, 20),
    type: clean(entry.type, 30),
    genre: clean(entry.genre, 80),
    platform: clean(entry.platform, 80),
    episodes: intOr(entry.episodes, 9999),
    screentime: intOr(entry.screentime, 100000),
    watchDate: isoOf(parseDateParts(entry.watchDate))
  };
}

// Returns { id } for a new row, or { duplicate: id } when the same watch is
// already logged. The insert and its duplicate guard are one statement, so two
// requests that add the same show at the same moment cannot both write.
async function createEntry(entry) {
  const values = normalizeEntry(entry);
  const key = duplicateKey({ name: values.name, season: values.season, watchDate: values.watchDate, screentime: values.screentime });
  const now = nowIso();
  const meta = await write(
    'INSERT INTO entries (name, season, type, genre, platform, episodes, screentime, watch_date, dup_key, created_at, updated_at)' +
    ' SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?' +
    ' WHERE NOT EXISTS (SELECT 1 FROM entries WHERE dup_key = ?)',
    [values.name, values.season, values.type, values.genre, values.platform, values.episodes, values.screentime,
      values.watchDate, key, now, now, key]
  );
  if (meta.changes) return { id: Number(meta.last_row_id) };
  const existing = await rows('SELECT id FROM entries WHERE dup_key = ? LIMIT 1', [key]);
  return { duplicate: existing.length ? Number(existing[0].id) : 0 };
}

// Returns the entry's id, or 0 when the id matches no row — the callers answer
// 404 ENTRY_MISSING for that rather than reporting a write that did not happen.
async function updateEntry(id, entry) {
  const values = normalizeEntry(entry);
  const key = duplicateKey({ name: values.name, season: values.season, watchDate: values.watchDate, screentime: values.screentime });
  const meta = await write(
    'UPDATE entries SET name = ?, season = ?, type = ?, genre = ?, platform = ?, episodes = ?,' +
    ' screentime = ?, watch_date = ?, dup_key = ?, updated_at = ? WHERE id = ?',
    [values.name, values.season, values.type, values.genre, values.platform, values.episodes, values.screentime,
      values.watchDate, key, nowIso(), id]
  );
  return meta.changes ? Number(id) : 0;
}

async function deleteEntry(id) {
  const meta = await write('DELETE FROM entries WHERE id = ?', [id]);
  return meta.changes ? Number(id) : 0;
}

async function appendSuggestion(values) {
  // The sheet's Suggestions layout is fixed: title, type, genre, platform, note,
  // date.
  const [title, type, genre, platform, note, date] = values;
  await write(
    'INSERT INTO suggestions (title, type, genre, platform, note, submitted_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [clean(title, 160), clean(type, 30), clean(genre, 80), clean(platform, 80), clean(note, 200),
      isoOf(parseDateParts(date)), nowIso()]
  );
}

// ── Yearly goal ────────────────────────────────────────────────────────────
// The goal lives in the settings table so it syncs across devices and stays with
// the data, exactly as it did in the sheet's Settings tab.
async function readGoal() {
  try {
    const result = await rows('SELECT value FROM settings WHERE key = ?', [GOAL_PROPERTY]);
    if (!result.length) return { hrs: 0, year: '' };
    const parsed = JSON.parse(String(result[0].value || '').trim() || '{}');
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
  await write(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [GOAL_PROPERTY, goal ? JSON.stringify(goal) : '']
  );
  return { status: 'ok', goal: goal ? { hrs: goal.hrs, year: goal.year } : { hrs: 0, year: '' } };
}

module.exports = {
  setDatabase,
  dbEnabled,
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
  duplicateKey,
  seasonKey,
  parseDateParts,
  isoOf,
  displayOf
};

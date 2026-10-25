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
//     '2'), watch date and screentime all equal is the same watch logged twice,
//     and the guard additionally requires the same stored type — a film and a
//     same-named series are different watches even on the same day. It is
//     implemented here in JS against the rows that share a name, the way
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
// The connection is injected: functions/_router.js calls setDatabase(env.DB)
// per request.
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
// back as that same ISO text. Parts outside the calendar (month 13, 30
// February) are rejected rather than stored: without that a "date" of 2026-13-99
// sorted oddly and rendered as "99-undefined-26".
function parseDateParts(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const daysIn = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const valid = parts => {
    if (!parts) return null;
    if (parts.mo < 1 || parts.mo > 12 || parts.d < 1 || parts.d > daysIn(parts.y, parts.mo)) return null;
    return parts;
  };
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid({ y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) });
  m = text.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ](\d{2,4})$/);
  if (m) {
    const mo = MONTH_SHORT.indexOf(m[2].slice(0, 1).toUpperCase() + m[2].slice(1, 3).toLowerCase());
    if (mo < 0) return null;
    let y = Number(m[3]);
    if (y < 100) y += y > 50 ? 1900 : 2000;
    return valid({ y, mo: mo + 1, d: Number(m[1]) });
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
// row whose year reads as 0, so a stored row without a *usable* watch date is
// invisible in every list, chart and search on the site, whatever its
// screentime says. This is the one read that exposes them — the admin cleanup
// card lists them as the raw rows (ids and timestamps included) so they can be
// deleted deliberately.
//
// The filter is applied here in JS, against the same `parseDateParts` the wire
// row is built from, rather than as `watch_date IS NULL AND screentime <= 0` in
// SQL. That predicate was narrower than the reason this read exists: a row with
// no date but a real screentime (id 352, "down cemetry", 508 minutes, on the
// live store) reads as year 0 too, is shown nowhere, and the scan skipped it —
// so the card answered "the database is clean" without having looked. Reading
// the table and asking the date parser is the only way the scan and `mapRows`
// cannot disagree about which rows are reachable.
async function listInvalidEntries() {
  const result = await rows(
    'SELECT id, name, season, type, genre, platform, episodes, screentime, watch_date, created_at, updated_at' +
    ' FROM entries ORDER BY id ASC'
  );
  return result.filter(row => !String(row.name || '').trim() || !parseDateParts(row.watch_date)).map(row => ({
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

// ── Write ──────────────────────────────────────────────────────────────────
const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
const intOr = (value, max) => (Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Math.round(Number(value)))) : 0);

// The duplicate rule's key, computed in exactly one place. A NUL joins the parts
// because it cannot occur in a title, so 'A' + '1' can never collide with 'A1'.
//
// The title part is read the way the page reads it (AdminWrite.dupNormTitle):
// trimmed, lower-cased, and with runs of spaces collapsed — "The   Bear" and
// "The Bear" are one title, and the page's gate treats them as one, so a guard
// that read them as two would be the looser half of a rule the page already
// applies. Rows written before this collapse still carry their original spacing
// in dup_key, so a repeat of one of those is caught by the page (every edit in
// the admin page goes through it) rather than by the insert guard.
function duplicateKey(values) {
  return [
    String(values.name || '').trim().toLowerCase().replace(/\s+/g, ' '),
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
// requests that add the same show at the same moment cannot both write. The
// guard also requires the same type: without that a film and a same-named
// series released the same day (both at 0 screentime, as quick-adds arrive)
// would block each other as "duplicates".
async function createEntry(entry) {
  const values = normalizeEntry(entry);
  const key = duplicateKey({ name: values.name, season: values.season, watchDate: values.watchDate, screentime: values.screentime });
  const now = nowIso();
  const meta = await write(
    'INSERT INTO entries (name, season, type, genre, platform, episodes, screentime, watch_date, dup_key, created_at, updated_at)' +
    ' SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?' +
    ' WHERE NOT EXISTS (SELECT 1 FROM entries WHERE dup_key = ? AND type = ?)',
    [values.name, values.season, values.type, values.genre, values.platform, values.episodes, values.screentime,
      values.watchDate, key, now, now, key, values.type]
  );
  if (meta.changes) return { id: Number(meta.last_row_id) };
  const existing = await rows('SELECT id FROM entries WHERE dup_key = ? AND type = ? LIMIT 1', [key, values.type]);
  if (existing.length) return { duplicate: Number(existing[0].id) };
  // The statement changed nothing and no row claims the key: the write did not
  // happen, and there is no id to report. Saying so is the only honest answer —
  // a caller that reads a 200 out of this would tell the page an entry exists
  // that is nowhere in the store.
  throw new Error('The entry was not written');
}

// Returns { id } for a saved edit, { duplicate: id } when the edit would produce
// a second row the add path refuses, or 0 when the id matches no row — the
// callers answer 404 ENTRY_MISSING for that rather than reporting a write that
// did not happen.
//
// The duplicate rule applies to an edit for the same reason it applies to an
// add: an update recomputes `dup_key`, and without this guard it would write a
// pair the insert path refuses — then `createEntry()` for that key would report
// an arbitrary one of the two. `id <> ?` is what makes it a guard on *other*
// rows; the row being edited is never its own duplicate.
async function updateEntry(id, entry) {
  const values = normalizeEntry(entry);
  const key = duplicateKey({ name: values.name, season: values.season, watchDate: values.watchDate, screentime: values.screentime });
  const meta = await write(
    'UPDATE entries SET name = ?, season = ?, type = ?, genre = ?, platform = ?, episodes = ?,' +
    ' screentime = ?, watch_date = ?, dup_key = ?, updated_at = ?' +
    ' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM entries WHERE dup_key = ? AND type = ? AND id <> ?)',
    [values.name, values.season, values.type, values.genre, values.platform, values.episodes, values.screentime,
      values.watchDate, key, nowIso(), id, key, values.type, id]
  );
  if (meta.changes) return { id: Number(id) };
  // Nothing was written: either the row is gone, or the guard refused it.
  const exists = await rows('SELECT id FROM entries WHERE id = ? LIMIT 1', [id]);
  if (!exists.length) return 0;
  const clash = await rows('SELECT id FROM entries WHERE dup_key = ? AND type = ? AND id <> ? LIMIT 1', [key, values.type, id]);
  if (clash.length) return { duplicate: Number(clash[0].id) };
  // The row exists, no other row claims the key, and the update still changed
  // nothing: the write did not happen and there is no id to report.
  throw new Error('The entry was not updated');
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
//
// Returns { hrs: 0, year: '' } only when the store genuinely holds no goal, and
// **null when the read failed**. The two used to be the same value, and `setGoal`
// decides whether the year is locked from this return value — so one transient
// D1 error during a Set read as "no goal set" and replaced a goal the docs call
// locked for the year. A failure has to be distinguishable to be refusable.
async function readGoal() {
  try {
    const result = await rows('SELECT value FROM settings WHERE key = ?', [GOAL_PROPERTY]);
    if (!result.length) return { hrs: 0, year: '' };
    const raw = String(result[0].value || '').trim();
    if (!raw) return { hrs: 0, year: '' };
    const parsed = JSON.parse(raw);
    return { hrs: Math.max(0, Number(parsed.hrs) || 0), year: String(parsed.year || '') };
  } catch (error) {
    console.error('Reading the goal failed:', error.message);
    return null;
  }
}

// Returns { status: 'ok', goal } or { status: 'error', message }. A set goal for
// a year stays locked until 1 January — enforced here so no device can change it
// mid-year (an identical re-set is a no-op).
async function setGoal(hrs, year) {
  const current = await readGoal();
  // A read that failed is not "no goal set": refusing the write is what keeps
  // the year's lock meaningful when the store hiccups.
  if (!current) {
    return { status: 'error', message: 'Could not read the current goal, so nothing was changed. Try again.' };
  }
  const locked = (goal, wanted) => goal.hrs > 0 && goal.year === wanted;
  const refuse = { status: 'error', message: `The goal for ${year} is already set and locked until 1 January` };
  if (locked(current, year)) {
    if (hrs !== current.hrs) return refuse;
    return { status: 'ok', goal: current };
  }
  const goal = hrs > 0 ? { hrs: Math.round(hrs * 100) / 100, year } : null;
  await write(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [GOAL_PROPERTY, goal ? JSON.stringify(goal) : '']
  );
  // The check above and the write are two statements, so two clicks on 1 January
  // can both pass it. Report what the store actually holds rather than what this
  // call intended: the caller that lost the race gets the lock, not a success
  // for a value that is not there.
  const stored = await readGoal();
  if (!stored) {
    return { status: 'error', message: 'The goal was saved but could not be read back. Reload to check it.' };
  }
  if (locked(stored, year) && (!goal || stored.hrs !== goal.hrs)) return refuse;
  return { status: 'ok', goal: stored };
}

// ── The Watchmode cache ────────────────────────────────────────────────────
// Watchmode is the one source that answers "which service is this title on,
// and when did it land there", and every call to it costs a credit. So the
// answers that do not change are written down here and read back instead of
// being asked for again.
//
// Every one of these fails soft, and that is the point: a migration is not
// run by a deploy, so a site whose 0002_watchmode.sql has not been applied
// yet must still answer a calendar request. The first failure remembers that
// the tables are not there and stops trying, so a missing migration costs one
// failed statement rather than one per request.
let wmTables = null;

async function wmReady() {
  if (wmTables !== null) return wmTables;
  if (!dbEnabled()) {
    wmTables = false;
    return wmTables;
  }
  try {
    await rows('SELECT 1 FROM wm_cache LIMIT 1');
    wmTables = true;
  } catch (error) {
    wmTables = false;
  }
  return wmTables;
}

/**
 * A cached Watchmode answer, or null when there is none (or no table to keep
 * it in). `maxAgeMinutes` is how old the answer is allowed to be: a release
 * window that has been and gone is worth a week, one that is still running an
 * hour, a title's id a month.
 */
async function readWmCache(key, maxAgeMinutes) {
  if (!(await wmReady())) return null;
  try {
    const result = await rows('SELECT value, updated_at FROM wm_cache WHERE key = ?', [key]);
    if (!result.length) return null;
    const age = (Date.now() - Date.parse(String(result[0].updated_at || ''))) / 60000;
    if (!Number.isFinite(age) || age > maxAgeMinutes) return null;
    return String(result[0].value || '');
  } catch (error) {
    return null;
  }
}

async function writeWmCache(key, value) {
  if (!(await wmReady())) return false;
  try {
    await write(
      'INSERT INTO wm_cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, String(value == null ? '' : value), nowIso()]
    );
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * The TMDB record of a film the release feed named: its canonical title, its
 * poster, its rating and its popularity. A poster and an id never change, so
 * a row here is written once and read forever — the second load of a month
 * costs no credits at all.
 */
async function readWmLookup(tmdbId) {
  if (!(await wmReady())) return null;
  try {
    const result = await rows(
      'SELECT tmdb_id, title, poster, rating, popularity, updated_at FROM wm_lookups WHERE tmdb_id = ?',
      [Number(tmdbId) || 0]
    );
    if (!result.length) return null;
    const row = result[0];
    return {
      tmdbId: Number(row.tmdb_id) || 0,
      title: String(row.title || ''),
      poster: String(row.poster || ''),
      rating: Number(row.rating) || 0,
      popularity: Number(row.popularity) || 0,
      updatedAt: String(row.updated_at || ''),
    };
  } catch (error) {
    return null;
  }
}

async function writeWmLookup(entry) {
  if (!(await wmReady())) return false;
  const tmdbId = Number(entry && entry.tmdbId) || 0;
  if (!tmdbId) return false;
  try {
    await write(
      'INSERT INTO wm_lookups (tmdb_id, title, poster, rating, popularity, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (tmdb_id) DO UPDATE SET title = excluded.title, poster = excluded.poster, ' +
        'rating = excluded.rating, popularity = excluded.popularity, updated_at = excluded.updated_at',
      [
        tmdbId,
        String(entry.title || ''),
        String(entry.poster || ''),
        Number(entry.rating) || 0,
        Number(entry.popularity) || 0,
        nowIso(),
      ]
    );
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  setDatabase,
  dbEnabled,
  listEntries,
  listSuggestions,
  listInvalidEntries,
  createEntry,
  updateEntry,
  deleteEntry,
  appendSuggestion,
  readGoal,
  setGoal,
  // The Watchmode cache. Exported so the calendar can read and write it
  // without knowing the schema.
  readWmCache,
  writeWmCache,
  readWmLookup,
  writeWmLookup,
  // Exported for the importer and for the duplicate rule's own tests.
  duplicateKey,
  seasonKey,
  parseDateParts,
  isoOf,
  displayOf
};

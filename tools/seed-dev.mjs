/**
 * Local development seed for the D1 watchlist.
 *
 *   node tools/seed-dev.mjs            # apply to the local D1 (wrangler --local)
 *   node tools/seed-dev.mjs --dry-run  # print the SQL instead
 *
 * The production store is the real thing; this is the *local* one, and two rows
 * in it is why the Timeline route rendered empty and why a coverage pass could
 * not prove the calendar-ish components on it. The rows below are deterministic
 * (fixed titles, fixed dates, fixed ratings), so a verification run sees the same
 * page every time, and every row is stamped `created_at = 'dev-seed'` so the seed
 * can be re-applied without duplicating anything:
 *
 *   DELETE FROM entries WHERE created_at = 'dev-seed';   then re-insert
 *
 * Nothing here is imported by the app and nothing writes to `--remote`.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const DATABASE = 'content-tracker-watchlist';
const MARK = 'dev-seed';
const dryRun = process.argv.includes('--dry-run');

const shows = [
  ['Severance', 'S2', 'Series', 'Sci-Fi', 'Apple TV+', 10, 9.0],
  ['The Bear', 'S3', 'Series', 'Drama', 'Disney+', 10, 8.6],
  ['Shogun', 'S1', 'Series', 'Drama', 'Disney+', 10, 8.9],
  ['Slow Horses', 'S4', 'Series', 'Thriller', 'Apple TV+', 6, 8.5],
  ['Andor', 'S2', 'Series', 'Sci-Fi', 'Disney+', 12, 9.1],
  ['Dark', 'S3', 'Series', 'Sci-Fi', 'Netflix', 8, 8.8],
  ['Chernobyl', 'S1', 'Series', 'Drama', 'HBO Max', 5, 9.4],
  ['Succession', 'S4', 'Series', 'Drama', 'HBO Max', 10, 8.9],
  ['The Last of Us', 'S2', 'Series', 'Drama', 'HBO Max', 7, 8.7],
  ['Fleabag', 'S2', 'Series', 'Comedy', 'Prime Video', 6, 8.7],
  ['Peaky Blinders', 'S6', 'Series', 'Crime', 'Netflix', 6, 8.8],
  ['Arcane', 'S2', 'Series', 'Animation', 'Netflix', 9, 9.0],
  ['Blue Lights', 'S2', 'Series', 'Crime', 'BBC iPlayer', 6, 8.2],
  ['Normal People', 'S1', 'Series', 'Romance', 'Hulu', 12, 8.4],
  ['The Diplomat', 'S2', 'Series', 'Thriller', 'Netflix', 6, 8.0],
  ['Bad Sisters', 'S2', 'Series', 'Comedy', 'Apple TV+', 8, 8.3],
  ['Derry Girls', 'S3', 'Series', 'Comedy', 'Channel 4', 7, 8.5],
  ['Industry', 'S3', 'Series', 'Drama', 'HBO Max', 8, 8.1],
  ['Silo', 'S2', 'Series', 'Sci-Fi', 'Apple TV+', 10, 8.2],
  ['The Traitors', 'S3', 'Series', 'Reality', 'BBC iPlayer', 12, 7.6],
];

const movies = [
  ['Oppenheimer', '', 'Film', 'Drama', 'Prime Video', 0, 8.3],
  ['Poor Things', '', 'Film', 'Comedy', 'Disney+', 0, 7.8],
  ['Dune: Part Two', '', 'Film', 'Sci-Fi', 'Prime Video', 0, 8.5],
  ['The Zone of Interest', '', 'Film', 'Drama', 'Prime Video', 0, 7.4],
  ['Past Lives', '', 'Film', 'Romance', 'Netflix', 0, 7.8],
  ['Anatomy of a Fall', '', 'Film', 'Drama', 'Prime Video', 0, 7.7],
  ['Killers of the Flower Moon', '', 'Film', 'Crime', 'Apple TV+', 0, 7.6],
  ['The Holdovers', '', 'Film', 'Comedy', 'Prime Video', 0, 7.9],
  ['Civil War', '', 'Film', 'Thriller', 'Prime Video', 0, 7.0],
  ['All of Us Strangers', '', 'Film', 'Romance', 'Disney+', 0, 7.6],
  ['Perfect Days', '', 'Film', 'Drama', 'Mubi', 0, 7.9],
  ['Challengers', '', 'Film', 'Drama', 'Prime Video', 0, 7.1],
];

/** Dates run backwards from a fixed anchor so the Timeline has months to show. */
const anchor = new Date(Date.UTC(2026, 9, 12));
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

const rows = [];
const push = (record, index, step) => {
  const watch_date = iso(anchor.getTime() - index * step * day);
  const [name, season, type, genre, platform, episodes, rating] = record;
  rows.push({ ...{ name, season, type, genre, platform, episodes, watch_date }, rating, screentime: episodes ? episodes * 48 : 118 });
};

// 20 shows + 12 films spread over ~8 months, interleaved so no month is a single type.
for (let i = 0; i < Math.max(shows.length, movies.length); i++) {
  if (shows[i]) push(shows[i], i * 2, 9);
  if (movies[i]) push(movies[i], i * 2 + 1, 9);
}

const q = (value) => (value === null || value === undefined ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`);
const inserts = rows
  .map((r) => `INSERT INTO entries (name, season, type, genre, platform, episodes, screentime, watch_date, dup_key, created_at, updated_at) VALUES (${[
    q(r.name), q(r.season), q(r.type), q(r.genre), q(r.platform), r.episodes, r.screentime, q(r.watch_date), q(`${MARK}:${r.name}:${r.season}:${r.watch_date}`), q(MARK), q(MARK),
  ].join(', ')});`.replace(/;$/, ''))
  .join('\n');

const suggestions = [
  ['The Studio', 'Series', 'Comedy', 'Apple TV+'],
  ['Sinners', 'Film', 'Horror', 'Cinema'],
  ['A Knight of the Seven Kingdoms', 'Series', 'Fantasy', 'HBO Max'],
]
  .map(([title, type, genre, platform]) => `INSERT INTO suggestions (title, type, genre, platform, note, submitted_date, created_at) VALUES (${[
    q(title), q(type), q(genre), q(platform), "''", q(iso(anchor.getTime())), q(MARK),
  ].join(', ')});`.replace(/;$/, ''))
  .join('\n');

const statements = [
  `DELETE FROM entries WHERE created_at = ${q(MARK)}`,
  ...inserts.split('\n').filter(Boolean),
  `DELETE FROM suggestions WHERE created_at = ${q(MARK)}`,
  ...suggestions.split('\n').filter(Boolean),
  `INSERT OR REPLACE INTO settings (key, value) VALUES ('watch-goal', '{"hrs":120,"year":"2026"}')`,
];

if (dryRun) {
  console.log(statements.join(';\n') + ';');
  process.exit(0);
}

// A file, not --command: cmd.exe breaks a long or multi-line argument apart, and
// the seed is ~40 statements. The file lives under .wrangler/ (ignored, and
// already this tool's own state directory) and is removed afterwards, so a
// failed run does not leave SQL lying around in the repository.
const sqlFile = resolve('.wrangler', 'dev-seed.sql');
writeFileSync(sqlFile, statements.join(';\n') + ';\n');
let status = 0;
try {
  // One command string rather than an argv array: with `shell: true` on Windows
  // Node warns that an array is only concatenated, not escaped (DEP0190). The
  // file path is generated below, so quoting it is enough.
  const run = spawnSync(
    `npx wrangler d1 execute ${DATABASE} --local --file="${sqlFile}"`,
    { stdio: 'inherit', shell: true },
  );
  status = run.status ?? 1;
} finally {
  try { unlinkSync(sqlFile); } catch { /* already gone */ }
}

if (status !== 0) {
  console.error(`\nSeed failed (exit ${status}). The delete ran first, so re-running resets the seeded rows.`);
  process.exit(status);
}
console.log(`\nSeeded ${rows.length} entries and ${suggestions.split('\n').length} suggestions into the local ${DATABASE}.`);

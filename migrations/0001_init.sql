-- The watchlist's own store. This is the SQLite twin of the migration that
-- built the same three tables in Netlify Database (managed Postgres); that file
-- lived under netlify/database/migrations/ and was deleted with the rest of the
-- Netlify configuration, so git history is where its exact shape lives. This
-- file is what D1 is created from, and it has to leave an empty database in
-- exactly the shape netlify/functions/lib/db.js expects.
--
-- Applied by:
--   npx wrangler d1 migrations apply content-tracker-watchlist --remote   (production)
--   npx wrangler d1 migrations apply content-tracker-watchlist --local    (local dev)
--
-- Three tables, mirroring the three things the Sheet held: the Data rows, the
-- Suggestions inbox, and the Settings key/value tab behind the yearly goal.
--
-- What changed from Postgres, and why:
--   * BIGSERIAL → INTEGER PRIMARY KEY AUTOINCREMENT. Still an identity that does
--     not shift when a row above it is deleted, and AUTOINCREMENT (rather than a
--     bare INTEGER PRIMARY KEY) keeps ids from being reused after a delete — the
--     page holds ids between requests, so a reused one would name the wrong row.
--   * DATE/TIMESTAMPTZ → TEXT. Dates are stored as 'YYYY-MM-DD' and timestamps as
--     ISO 8601, written by the data layer, so there is no timezone between the
--     store and the page and no per-session date formatting to get wrong. The
--     `to_char(...)` casts the Postgres version needed are gone with them.
--   * NUMERIC(10,2) → REAL, which is how SQLite stores a screentime; the wire
--     shape sends it as a string either way.
--   * a `dup_key` column. Postgres serialised concurrent adds with an advisory
--     lock on the title; D1 has no session locks, so the duplicate rule's key is
--     computed in the data layer and the insert itself carries
--     `WHERE NOT EXISTS (… dup_key = ?)` — one atomic statement instead of a lock
--     plus a check.
--
-- `season` stays free text because that is what gets typed ("S2", "Season 2",
-- "2"): the rule that treats those three as one watch lives in the data layer,
-- which is the only place that normalisation is implemented.

CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  season      TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  genre       TEXT NOT NULL DEFAULT '',
  platform    TEXT NOT NULL DEFAULT '',
  episodes    INTEGER NOT NULL DEFAULT 0,
  screentime  REAL NOT NULL DEFAULT 0,
  -- A watch date is optional here for the same reason it was optional in the
  -- sheet: the page reads a row's year off it and hides a row without one.
  watch_date  TEXT,
  -- The duplicate rule's key: name (case-folded), normalised season, watch date
  -- and screentime, joined with a NUL. Computed by duplicateKey() in lib/db.js.
  dup_key     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- The page sorts and groups by date constantly (timeline, current year, the
-- monthly breakdown); the duplicate check looks a title up by name; and the
-- create's own guard looks a watch up by its key.
CREATE INDEX IF NOT EXISTS entries_watch_date_idx ON entries (watch_date DESC);
CREATE INDEX IF NOT EXISTS entries_name_idx ON entries (lower(name));
CREATE INDEX IF NOT EXISTS entries_dup_idx ON entries (dup_key);

-- The public inbox: anyone can ask for a title, nobody can read it from the
-- page. Append-only, like the sheet it replaced.
CREATE TABLE IF NOT EXISTS suggestions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT '',
  genre           TEXT NOT NULL DEFAULT '',
  platform        TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  submitted_date  TEXT,
  created_at      TEXT NOT NULL
);

-- Small key/value store, kept for the one thing that used it: the yearly watch
-- goal ("watch-goal" → {"hrs":120,"year":"2026"}). A table rather than a column
-- so a second setting never needs a migration.
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL DEFAULT ''
);

-- The watchlist's own store, replacing the Google Sheet.
--
-- Applied automatically by Netlify Database immediately before a production
-- deploy is published, and on every deploy preview (which gets its own branch of
-- this database first). A migration that fails blocks the deploy, so this file
-- has to leave an empty database in exactly the shape the code expects.
--
-- The three tables mirror the three things the Sheet held: the Data rows, the
-- Suggestions inbox, and the Settings key/value tab that stores the yearly goal.

-- One row per logged watch. `id` replaces the sheet's row number as a record's
-- identity: it is what the page carries in data-row, what the admin endpoints
-- take back, and — unlike a row number — it never shifts when a row above it is
-- deleted. `season` stays free text because that is what gets typed ("S2",
-- "Season 2", "2"): the duplicate rule that treats those three as one lives in
-- the data layer, which is the only place that normalisation is implemented.
CREATE TABLE IF NOT EXISTS entries (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  season      TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  genre       TEXT NOT NULL DEFAULT '',
  platform    TEXT NOT NULL DEFAULT '',
  episodes    INTEGER NOT NULL DEFAULT 0,
  screentime  NUMERIC(10, 2) NOT NULL DEFAULT 0,
  -- A watch date is optional here for the same reason it was optional in the
  -- sheet: the page reads a row's year off it and hides a row without one, which
  -- is exactly the behaviour the sheet had.
  watch_date  DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The page sorts and groups by date constantly (timeline, current year, the
-- monthly breakdown), and the duplicate check looks a title up by name.
CREATE INDEX IF NOT EXISTS entries_watch_date_idx ON entries (watch_date DESC);
CREATE INDEX IF NOT EXISTS entries_name_idx ON entries (lower(name));

-- The public inbox: anyone can ask for a title, nobody can read it from the
-- page. Append-only, like the sheet it replaces.
CREATE TABLE IF NOT EXISTS suggestions (
  id              BIGSERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT '',
  genre           TEXT NOT NULL DEFAULT '',
  platform        TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  submitted_date  DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Small key/value store, kept for the one thing that used it: the yearly watch
-- goal ("watch-goal" → {"hrs":120,"year":"2026"}). A table rather than a column
-- so a second setting never needs a migration.
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL DEFAULT ''
);

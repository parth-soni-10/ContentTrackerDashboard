-- The Watchmode cache.
--
-- Watchmode is the one source in this calendar that answers "which service is
-- this title on, and when did it land there" — the question the calendar is
-- actually about, and the one TMDB's provider filters cannot answer for a
-- film it lists with no provider attached (the measured case: "YOU ME US",
-- a Netflix film TMDB has as a type-4 digital release with no watch provider
-- in any region, so no provider-filtered query can return it).
--
-- Every call to it costs a credit, so the answers that do not change are
-- written down here and read back instead of being asked for again. Two
-- tables, one per kind of answer:
--
--   wm_cache    Every Watchmode answer, keyed by the request that produced it:
--               the release feed for a window, a title's services, an id
--               lookup. A month of releases is one call a week, so without
--               this the credits would go on the page being opened rather than
--               on the data being found. The reader decides how old an answer
--               may be: a window that is entirely in the past never changes,
--               a window that is still running does, and a title's id does not
--               change at all.
--
--   wm_lookups  The TMDB record of a film the release feed named and nothing
--               else had: the poster, the rating, the popularity and the
--               canonical title (a title can be listed under its original name
--               — "YOU ME US" is "Noi un po' meglio" in Watchmode — so the
--               title the page shows is TMDB's). A poster never changes and an
--               id never changes, so this row is written once and read
--               forever: the second load of a month costs no credits at all.
--
-- Applied by:
--   npx wrangler d1 migrations apply content-tracker-watchlist --remote   (production)
--   npx wrangler d1 migrations apply content-tracker-watchlist --local    (local dev)
--
-- As with 0001_init.sql, a migration is not run by a deploy: it is a separate
-- command, and a schema change is not live until it has been run. The code
-- that reads these tables treats their absence as "no cache" and carries on,
-- so the site works before the migration has been applied — it just spends
-- the credits again.

-- The cached Watchmode answers, keyed by the request that produced them.
CREATE TABLE IF NOT EXISTS wm_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The TMDB record of a film the feed named. `title` is TMDB's own name for it,
-- which is not always the name the feed uses.
CREATE TABLE IF NOT EXISTS wm_lookups (
  tmdb_id    INTEGER PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  poster     TEXT NOT NULL DEFAULT '',
  rating     REAL NOT NULL DEFAULT 0,
  popularity INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

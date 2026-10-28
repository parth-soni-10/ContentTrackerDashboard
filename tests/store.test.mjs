// The D1 store and the reads/writes that sit on it: the cleanup scan, the
// duplicate rule on an edit, and the yearly goal.
//
// These run against a real in-memory SQLite (node:sqlite) built from the
// committed migration, so the SQL under test is the SQL that runs in D1 - a
// hand-written fake would only ever agree with itself. node:sqlite arrived in
// Node 22.5; on Node 20 (the engine floor in package.json) the suite skips
// these rather than failing on a missing module.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const db = require("../netlify/functions/lib/db.js");
const watchlist = require("../netlify/functions/watchlist.js");

let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch {
  sqlite = null;
}
const NO_SQLITE = sqlite ? false : "node:sqlite needs Node 22.5 or newer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = readFileSync(join(root, "migrations", "0001_init.sql"), "utf8");

/** The D1 binding, backed by a real in-memory SQLite built from the migration. */
function realD1() {
  const file = new sqlite.DatabaseSync(":memory:");
  file.exec(SCHEMA);
  const statements = [];
  const binding = {
    prepare(sql) {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return {
        bind(...params) {
          return {
            async all() {
              return { results: file.prepare(sql).all(...params) };
            },
            async run() {
              const info = file.prepare(sql).run(...params);
              return {
                meta: {
                  changes: Number(info.changes) || 0,
                  last_row_id: Number(info.lastInsertRowid) || 0,
                },
              };
            },
          };
        },
      };
    },
  };
  return { binding, file, statements };
}

/** Runs a body with the store bound, then unbinds it. */
async function withStore(run) {
  const store = realD1();
  db.setDatabase(store.binding);
  try {
    await run(store);
  } finally {
    db.setDatabase(null);
  }
}

const isoRow = (store, id) => store.file.prepare("SELECT * FROM entries WHERE id = ?").get(id);

// ── THE CLEANUP SCAN ──────────────────────────────────────────────────────

test("the cleanup scan finds every row the page cannot show", { skip: NO_SQLITE }, async () => {
  await withStore(async () => {
    // The measured row: no watch date, but a real screentime. `mapRows` drops it
    // (year 0), so it is in no list, chart or search - and the old predicate
    // (`watch_date IS NULL AND screentime <= 0`) skipped it, which let the card
    // answer "the database is clean" without having looked at it.
    await db.createEntry({ name: "down cemetry", type: "Movie", screentime: 508 });
    // The blank import row the card was built for.
    await db.createEntry({ name: "abandoned add", type: "Movie" });
    // A real entry: reachable, and it must stay out of the scan.
    await db.createEntry({ name: "Dune", type: "Movie", watchDate: "2026-10-29", screentime: 155 });

    const invalid = await db.listInvalidEntries();
    const names = invalid.map(row => row.name);
    assert.deepEqual(names, ["down cemetry", "abandoned add"], "both undated rows, and only those");
    assert.equal(invalid[0].screentime, 508, "the row's own numbers are reported, not filtered away");
    assert.equal(invalid[0].watchDate, null);
  });
});

test("a row whose date is stored but unreadable is unreachable too", { skip: NO_SQLITE }, async () => {
  await withStore(async store => {
    // Nothing the write paths produce any more (parseDateParts rejects it), but
    // an import or a hand-edited row can still hold one - and `toWireRow` reads
    // it as no year at all, so the site cannot show it either.
    store.file.prepare(
      "INSERT INTO entries (name, type, screentime, watch_date, dup_key, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("bad date row", "Movie", 0, "2026-13-99", "", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const invalid = await db.listInvalidEntries();
    assert.deepEqual(invalid.map(row => row.name), ["bad date row"]);
    assert.equal(invalid[0].watchDate, "2026-13-99", "the raw stored value is shown so it can be judged");
  });
});

// ── THE DUPLICATE RULE ON AN EDIT ─────────────────────────────────────────

test("an edit cannot create a duplicate the add path refuses", { skip: NO_SQLITE }, async () => {
  await withStore(async store => {
    const first = await db.createEntry({ name: "You, Me, Us", type: "Movie", watchDate: "2026-10-29", screentime: 100 });
    const second = await db.createEntry({ name: "You, Me, Us", type: "Movie", watchDate: "2026-10-30", screentime: 100 });
    assert.ok(first.id && second.id, "two separate watches are two rows");

    // Move the second onto the first's date and screentime: the pair the insert
    // path refuses, so the update must refuse it too.
    const refused = await db.updateEntry(second.id, {
      name: "You, Me, Us",
      type: "Movie",
      watchDate: "2026-10-29",
      screentime: 100,
    });
    assert.deepEqual(refused, { duplicate: first.id }, "the edit names the row it collided with");
    assert.equal(isoRow(store, second.id).watch_date, "2026-10-30", "and changed nothing");

    // An edit that does not collide still saves - including one that changes a
    // field the duplicate key ignores.
    const saved = await db.updateEntry(second.id, {
      name: "You, Me, Us",
      type: "Movie",
      watchDate: "2026-10-30",
      screentime: 100,
      genre: "Drama",
      platform: "Netflix",
    });
    assert.deepEqual(saved, { id: second.id });
    assert.equal(isoRow(store, second.id).genre, "Drama");

    // The same title as a different *kind* is not a duplicate, exactly as the
    // insert path decides: a film and a same-named series are different watches.
    const movie = await db.createEntry({ name: "Fargo", type: "Movie", watchDate: "2026-10-29", screentime: 98 });
    const series = await db.createEntry({ name: "Fargo", type: "Series/Show", watchDate: "2026-10-29", screentime: 98 });
    const movedSeries = await db.updateEntry(series.id, {
      name: "Fargo",
      type: "Series/Show",
      watchDate: "2026-10-29",
      screentime: 98,
    });
    assert.deepEqual(movedSeries, { id: series.id }, "a film does not block a same-named series");
    assert.ok(movie.id);
  });
});

test("editing a row that is gone says so instead of reporting a save", { skip: NO_SQLITE }, async () => {
  await withStore(async () => {
    const updated = await db.updateEntry(999, { name: "Ghost", type: "Movie", watchDate: "2026-10-29" });
    assert.equal(updated, 0, "no row, no id - the endpoint answers 404 for this");
  });
});

// ── THE YEARLY GOAL ───────────────────────────────────────────────────────

test("a goal that could not be read is not a goal that was never set", { skip: NO_SQLITE }, async () => {
  // A store that answers nothing: the shape of one transient D1 failure.
  const broken = {
    prepare() {
      throw new Error("D1 unavailable");
    },
  };
  db.setDatabase(broken);
  try {
    assert.equal(await db.readGoal(), null, "a failed read is reported as a failure");
    const result = await db.setGoal(120, "2026");
    assert.equal(result.status, "error", "and the write is refused rather than bypassing the lock");
    assert.match(result.message, /could not read|nothing was changed/i);
  } finally {
    db.setDatabase(null);
  }
});

test("the goal read on the public endpoint fails loudly", { skip: NO_SQLITE }, async () => {
  db.setDatabase({
    prepare() {
      throw new Error("D1 unavailable");
    },
  });
  try {
    const response = await watchlist.handler({ httpMethod: "GET", headers: {}, queryStringParameters: { goal: "1" } });
    assert.equal(response.statusCode, 502, "not a 200 carrying {hrs: 0}");
    assert.match(JSON.parse(response.body).error, /goal/i);
  } finally {
    db.setDatabase(null);
  }
});

test("a set goal stays locked for its year, and the answer is what was stored", { skip: NO_SQLITE }, async () => {
  await withStore(async () => {
    const first = await db.setGoal(1000, "2026");
    assert.equal(first.status, "ok");
    assert.deepEqual(first.goal, { hrs: 1000, year: "2026" });

    const changed = await db.setGoal(1200, "2026");
    assert.equal(changed.status, "error", "the year is locked once set");

    const same = await db.setGoal(1000, "2026");
    assert.equal(same.status, "ok", "re-setting the same value is a no-op, not an error");

    const nextYear = await db.setGoal(300, "2027");
    assert.equal(nextYear.status, "ok", "1 January unlocks it");
    assert.deepEqual(nextYear.goal, { hrs: 300, year: "2027" });
  });
});

test("a store with no goal row says so without inventing one", { skip: NO_SQLITE }, async () => {
  await withStore(async () => {
    assert.deepEqual(await db.readGoal(), { hrs: 0, year: "" });
  });
});

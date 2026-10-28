// One rule, two runtimes: the page refuses a write it knows is a repeat, and
// the D1 guard refuses one that slipped past it. Both are the same rule, so
// both are pinned against the same fixtures here - the page must never let
// through an edit the store then refuses, and must never refuse one the store
// would have taken.
//
// They are not the same *code*: admin-write.js keys a season as "2" and
// db.duplicateKey() as "#2", because each compares its own strings and neither
// ever shows them. What has to match is the classification, not the byte. That
// is what this file checks, pair by pair, from the spellings a reader actually
// types.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AdminWrite = require("../admin-write.js");
const db = require("../netlify/functions/lib/db.js");

const BASE = {
  name: "The Bear",
  season: "S2",
  type: "Series/Show",
  watchDate: "2026-10-12",
  screentime: 480,
};

// The store's side: dup_key covers name, season, date and screentime, and the
// guard adds the stored type (`dup_key = ? AND type = ?`), so both parts are
// asked here in the same breath. The type is compared as the string the row
// carries, which is why a pair that spells the same kind two ways ('Film' and
// 'Movie') is only ever a duplicate on the page - see the last test.
function gateSaysRepeat(a, b) {
  return db.duplicateKey(a) === db.duplicateKey(b) && String(a.type || "") === String(b.type || "");
}

// The page's side: one row in the list, the payload an edit would send, and no
// exclusion - the row being edited is a separate case, already covered in
// admin-write.test.mjs.
function pageSaysRepeat(a, b) {
  const rows = [{ row: 1, ...b }];
  return AdminWrite.findDuplicates(rows, a, 0).exact.length > 0;
}

const PAIRS = [
  ["the same watch typed twice", { ...BASE }, { ...BASE }, true],
  ["a title's case and spacing", { ...BASE, name: "the   bear" }, { ...BASE, name: "The Bear" }, true],
  ["a title padded with spaces", { ...BASE, name: "  The Bear  " }, { ...BASE }, true],
  ["a season written three ways", { ...BASE, season: "Season 02" }, { ...BASE, season: "S2" }, true],
  ["a season as a bare number", { ...BASE, season: "2" }, { ...BASE, season: "s 2" }, true],
  ["a season written with a hash", { ...BASE, season: "#2" }, { ...BASE, season: "2" }, true],
  ["a date in the sheet's display format", { ...BASE, watchDate: "12-Oct-26" }, { ...BASE }, true],
  ["a screentime as a string", { ...BASE, screentime: "480" }, { ...BASE }, true],
  ["a different season of the same show", { ...BASE, season: "S3" }, { ...BASE }, false],
  ["the same show on another date", { ...BASE, watchDate: "2026-10-13" }, { ...BASE }, false],
  ["the same show with another running time", { ...BASE, screentime: 481 }, { ...BASE }, false],
  ["a film beside a same-named series", { ...BASE, type: "Movie", season: "" }, { ...BASE, type: "Series/Show" }, false],
  ["a film and the same film", { ...BASE, type: "Movie", season: "" }, { ...BASE, type: "Movie", season: "" }, true],
  ["a one-off film and a two-part series", { ...BASE, type: "Movie", season: "" }, { ...BASE, type: "Series/Show", season: "" }, false],
  // The vocabulary the store was actually filled with, which the page reads the
  // same way as the form's.
  ["a film filed the sheet's way", { ...BASE, type: "Film", season: "" }, { ...BASE, type: "Film", season: "" }, true],
  ["a series filed the sheet's way", { ...BASE, type: "Series" }, { ...BASE, type: "Series" }, true],
  ["a sheet film beside a sheet series", { ...BASE, type: "Film", season: "" }, { ...BASE, type: "Series", season: "" }, false],
  ["a sheet series on another date", { ...BASE, type: "Series", watchDate: "2026-10-13" }, { ...BASE, type: "Series" }, false],
];

for (const [what, a, b, repeat] of PAIRS) {
  test(`both gates agree: ${what}${repeat ? "" : " is not"} a repeat`, () => {
    assert.equal(pageSaysRepeat(a, b), repeat, `page: ${what}`);
    assert.equal(gateSaysRepeat(a, b), repeat, `store: ${what}`);
  });
}

// The season spelling is the one place the two keys deliberately disagree on
// shape, so it is asserted rather than left to a comment: if either side ever
// changes how it names a season, this fails before a pair can be misjudged.
test("the two season keys differ in prefix and agree in grouping", () => {
  const spellings = ["S2", "Season 2", "2", "02", "s 02", "#2", "series 2"];
  const pageKeys = new Set(spellings.map(value => AdminWrite.dupSeasonKey(value)));
  const storeKeys = new Set(spellings.map(value => db.seasonKey(value)));
  assert.deepEqual([...pageKeys], ["2"]);
  assert.deepEqual([...storeKeys], ["#2"]);
  // A season nobody normalised is still one bucket on both sides: both strip
  // the word, so "Season One" and "season one " meet as "one".
  assert.deepEqual([...new Set(["Season One", "season one "].map(value => AdminWrite.dupSeasonKey(value)))], ["one"]);
  assert.deepEqual([...new Set(["Season One", "season one "].map(value => db.seasonKey(value)))], ["one"]);
});

// The type is the third thing the two sides read differently: the page asks
// whether two rows are the same *kind*, the store asks whether they carry the
// same *word*. The store is therefore the looser half - and that direction is
// the safe one: anything it would refuse, the page refuses first, with a
// message naming the row. The reverse (the page refusing where the store would
// have written) can only happen between two spellings of one kind, which is a
// duplicate a reader wants stopped anyway.
test("the store never refuses a write the page let through", () => {
  const types = ["Movie", "Film", "Series", "Series/Show"];
  const isFilm = type => AdminWrite.dupKind(type) === "movie";
  const dates = ["2026-10-12", "12-Oct-26", "2026-10-13"];
  for (const typeA of types) {
    for (const typeB of types) {
      for (const dateB of dates) {
        const a = { ...BASE, type: typeA, season: isFilm(typeA) ? "" : "S2" };
        const b = { ...BASE, type: typeB, season: isFilm(typeB) ? "" : "S2", watchDate: dateB };
        if (gateSaysRepeat(a, b)) {
          assert.equal(pageSaysRepeat(a, b), true, `page must also refuse: ${typeA} against ${typeB} on ${dateB}`);
        }
      }
    }
  }
});

// The write module's vocabulary is what the service checks a payload against,
// so the words the store and the form use both have to be in it.
test("every type an entry can carry is a word the write accepts", () => {
  for (const type of ["Movie", "Film", "Series", "Series/Show"]) {
    assert.ok(AdminWrite.ENTRY_TYPES.includes(type), `${type} is a type an entry can carry`);
  }
  assert.equal(AdminWrite.dupKind("Film"), "movie");
  assert.equal(AdminWrite.dupKind("Series"), "show");
  assert.equal(AdminWrite.dupKind("Series/Show"), "show");
});
// toISODate(), the store parses both through parseDateParts(), and the two have
// to land on the same day for the pair check to mean anything.
test("both gates read both stored date shapes as the same day", () => {
  assert.equal(AdminWrite.dupDateKey("12-Oct-26"), AdminWrite.dupDateKey("2026-10-12"));
  assert.equal(db.isoOf(db.parseDateParts("12-Oct-26")), db.isoOf(db.parseDateParts("2026-10-12")));
  assert.equal(db.isoOf(db.parseDateParts("12-Oct-26")), "2026-10-12");
});

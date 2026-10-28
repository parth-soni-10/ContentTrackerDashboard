// The admin write, pinned: what a partial edit carries, what the duplicate gate
// calls a duplicate, and what the one POST treats as a save.
//
// The first test is the one the review asked for. The service builds a complete
// entry out of the body and writes every column - a rename that sent only a name
// would blank the genre, the platform, the season, the date and the screentime -
// so "rename only, every other column unchanged" is the failure a reader could
// never see in the UI, and the reason `stored` exists beside the display row.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AdminWrite = require("../admin-write.js");

// A wire row the way db.toWireRow() hands it over: the store's own strings, all
// of which the page then tidies for display (smartCaseName, normalizeType,
// normalizeGenre, normalizePlatform).
const STORED = {
  name: "the bear",
  season: "S2",
  type: "series",
  genre: "sci fi",
  platform: "netflix",
  episodes: "8",
  screentime: "480",
  watchDate: "12-Oct-26",
};

test("a rename carries every other column exactly as the store holds it", () => {
  const payload = AdminWrite.mergeStored(STORED, { name: "The Bear" });
  assert.equal(payload.name, "The Bear");
  // The four display-normalised columns are the ones a merge from the rendered
  // row would quietly rewrite: title case, "Series/Show", "Sci-Fi", "Netflix".
  assert.equal(payload.genre, "sci fi");
  assert.equal(payload.platform, "netflix");
  assert.equal(payload.type, "series");
  assert.equal(payload.season, "S2");
  assert.equal(payload.episodes, "8");
  assert.equal(payload.screentime, "480");
  assert.equal(payload.watchDate, "12-Oct-26");
  assert.deepEqual(Object.keys(payload).sort(), AdminWrite.ENTRY_FIELDS.slice().sort());
});

test("an untouched payload is the stored row itself", () => {
  assert.deepEqual(AdminWrite.mergeStored(STORED, {}), STORED);
});

// The store was filled from a sheet, so its type column holds 'Film' and
// 'Series' while the form offers 'Movie' and 'Series/Show'. A rename carries
// back whichever one the row has - the service checks the payload against
// ENTRY_TYPES, so a list that only knew the form's words refused every legacy
// row with "Name and a valid type are required".
test("a rename of a row stored the sheet's way is a payload the service accepts", () => {
  for (const type of ["Film", "Series", "Movie", "Series/Show"]) {
    const payload = AdminWrite.mergeStored({ ...STORED, type }, { name: "The Bear (2019)" });
    assert.equal(payload.type, type, "the type goes back exactly as stored");
    assert.ok(AdminWrite.ENTRY_TYPES.includes(payload.type), `${type} is accepted by the service`);
  }
});

test("a field cleared on purpose stays cleared", () => {
  const payload = AdminWrite.mergeStored(STORED, { genre: "" });
  assert.equal(payload.genre, "");
  assert.equal(payload.name, "the bear");
});

test("unknown keys cannot ride along in the changes", () => {
  const payload = AdminWrite.mergeStored(STORED, { row: 3, action: "delete", name: "The Bear" });
  assert.equal(payload.row, undefined);
  assert.equal(payload.action, undefined);
  assert.equal(payload.name, "The Bear");
});

test("a column the store is missing is still sent, blank", () => {
  const payload = AdminWrite.mergeStored({ name: "Heat", type: "Movie" }, { name: "Heat (1995)" });
  AdminWrite.ENTRY_FIELDS.forEach(field => assert.ok(field in payload, `${field} is in the payload`));
  assert.equal(payload.genre, "");
  assert.equal(payload.watchDate, "");
});

test("the gate: the row being edited is never its own duplicate", () => {
  const rows = [{ row: 4, name: "The Bear", type: "Series/Show", season: "2", watchDate: "2026-10-12", screentime: 480 }];
  const payload = AdminWrite.mergeStored({ ...STORED, name: "the bear" }, { name: "The Bear" });
  const found = AdminWrite.findDuplicates(rows, payload, 4);
  assert.equal(found.exact.length, 0);
  assert.equal(found.exists.length, 0);
});

test("the gate: same title, kind, season, date and time is an exact repeat whatever the spelling", () => {
  const rows = [{ row: 9, name: "The Bear", type: "Series/Show", season: "Season 02", watchDate: "12-Oct-26", screentime: "480" }];
  const payload = AdminWrite.mergeStored(STORED, { name: "the   bear", type: "series", season: "S2" });
  const found = AdminWrite.findDuplicates(rows, payload, 4);
  assert.equal(found.exact.length, 1);
  assert.equal(found.exists.length, 0);
});

test("the gate: a different date is a rewatch, not an exact repeat", () => {
  const rows = [{ row: 9, name: "The Bear", type: "Series/Show", season: "2", watchDate: "2026-10-13", screentime: 480 }];
  const found = AdminWrite.findDuplicates(rows, { ...STORED, name: "The Bear" }, 4);
  assert.equal(found.exact.length, 0);
  assert.equal(found.exists.length, 1);
});

test("the gate: a film and a series with the same name are different things", () => {
  const rows = [
    { row: 9, name: "Heat", type: "Movie", season: "", watchDate: "2026-10-12", screentime: 170 },
    { row: 10, name: "Heat", type: "Series/Show", season: "1", watchDate: "2026-10-12", screentime: 170 },
  ];
  const found = AdminWrite.findDuplicates(rows, { name: "Heat", type: "Series/Show", season: "1", watchDate: "2026-10-12", screentime: 170 }, 4);
  assert.deepEqual(found.exact.map(item => item.row), [10]);
});

function response({ status = 200, json = null, type = "application/json" } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => (String(name).toLowerCase() === "content-type" ? type : null) },
    json: () => (json === null ? Promise.reject(new Error("not json")) : Promise.resolve(json)),
  };
}

test("send: a saved entry comes back as the row number", async () => {
  let seen = null;
  const outcome = await AdminWrite.send({ action: "update", row: 4 }, {
    fetch: (url, init) => { seen = { url, init }; return Promise.resolve(response({ json: { rowNumber: 4 } })); },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.rowNumber, 4);
  assert.equal(outcome.duplicate, false);
  assert.equal(seen.url, AdminWrite.ENDPOINT);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(seen.init.body), { action: "update", row: 4 });
});

test("send: the server's duplicate rule is a done state, not a failure", async () => {
  const outcome = await AdminWrite.send({ action: "update", row: 4 }, {
    fetch: () => Promise.resolve(response({ json: { duplicate: true, rowNumber: 12 } })),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.duplicate, true);
  assert.equal(outcome.rowNumber, 12);
});

test("send: a dead session is its own answer", async () => {
  const outcome = await AdminWrite.send({ action: "delete", row: 4 }, {
    fetch: () => Promise.resolve(response({ status: 401, json: { error: "Admin session required", code: "SESSION_INVALID" } })),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.expired, true);
});

test("send: a 200 that is not the endpoint's JSON is not a save", async () => {
  const outcome = await AdminWrite.send({ action: "update", row: 4 }, {
    fetch: () => Promise.resolve(response({ json: null, type: "text/html" })),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.expired, false);
  assert.match(outcome.error, /nothing was saved/i);
});

test("send: a failed write carries the service's own words and code", async () => {
  const outcome = await AdminWrite.send({ action: "update", row: 4 }, {
    fetch: () => Promise.resolve(response({ status: 404, json: { error: "That entry no longer exists", code: "ENTRY_MISSING" } })),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 404);
  assert.equal(outcome.error, "That entry no longer exists [ENTRY_MISSING]");
});

test("send: a network failure is reported, never thrown", async () => {
  const outcome = await AdminWrite.send({ action: "update", row: 4 }, {
    fetch: () => Promise.reject(new Error("offline")),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "offline");
});

test("send: a timeout says so in the reader's words", async () => {
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  const outcome = await AdminWrite.send({ action: "update", row: 4 }, {
    fetch: () => Promise.reject(aborted),
    timeoutMs: 5,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /took too long/i);
});

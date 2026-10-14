#!/usr/bin/env node
// One-shot watchlist importer — the local half of netlify/functions/admin-import.
//
// Feed it a CSV or JSON export of the rows and it loads them into the deployed
// store. It signs in with the admin password, so nothing here needs database
// credentials (and the store's own duplicate rule does the de-duplicating).
//
//   node tools/import-watchlist.mjs export.csv            # dry run: says what it would send
//   node tools/import-watchlist.mjs export.csv --apply    # actually imports
//   node tools/import-watchlist.mjs export.csv --apply --url http://127.0.0.1:8788
//
// The password comes from .dev.vars (or ADMIN_PASSWORD in the environment).
// Expected columns, in the wire shape the page and the Sheet share:
//   Name, Season, Type, Details/Genre, Platform, Episode Count, Screentime,
//   Watch Date
// Column names are matched ignoring case and spacing, so a Sheet export works
// as-is. Rows with no Name are skipped. Running it twice is safe: the second run
// reports every row as a duplicate and inserts none — that is the verification
// that the store has all of them.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_URL = "https://contenttrackerdashboard.pages.dev";
const CHUNK = 200;

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--"));
const apply = args.includes("--apply");
const urlIndex = args.indexOf("--url");
const base = (urlIndex >= 0 ? args[urlIndex + 1] : DEFAULT_URL).replace(/\/$/, "");
if (!file) {
  console.error("usage: node tools/import-watchlist.mjs <file.csv|file.json> [--apply] [--url <base>]");
  process.exit(2);
}

// ── reading the export ─────────────────────────────────────────────────────
/** RFC 4180-ish CSV: quoted fields, doubled quotes inside them, CRLF or LF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (ch === "\r") continue;
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => String(cell).trim() !== ""));
}

function rowsFromCsv(text) {
  const table = parseCsv(text);
  if (!table.length) return [];
  const headers = table[0].map(h => String(h).trim());
  return table.slice(1).map(cells => {
    const row = {};
    headers.forEach((header, i) => { row[header] = cells[i] === undefined ? "" : cells[i]; });
    return row;
  });
}

const raw = fs.readFileSync(file, "utf8");
let rows;
if (path.extname(file).toLowerCase() === ".json") {
  const parsed = JSON.parse(raw);
  rows = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed.rows) ? parsed.rows
    : Array.isArray(parsed.entries) ? parsed.entries
    : (() => { throw new Error("JSON must be an array of rows, or an object with a rows array"); })();
} else {
  rows = rowsFromCsv(raw);
}

const pick = (row, ...names) => {
  for (const name of names) {
    for (const key of Object.keys(row)) {
      if (key.trim().toLowerCase().replace(/[\s_/]+/g, "") === name) return String(row[key] ?? "").trim();
    }
  }
  return "";
};
const wire = rows.map(row => ({
  Name: pick(row, "name", "title"),
  Season: pick(row, "season"),
  Type: pick(row, "type"),
  "Details/Genre": pick(row, "detailsgenre", "genre", "details"),
  Platform: pick(row, "platform"),
  "Episode Count": pick(row, "episodecount", "episodes"),
  Screentime: pick(row, "screentime"),
  "Watch Date": pick(row, "watchdate", "date")
})).filter(row => row.Name);

// The two date shapes the data layer accepts: ISO, and the sheet's "3-Sep-26".
const hasDate = value => /^\d{4}-\d{1,2}-\d{1,2}/.test(value) || /^\d{1,2}[-/ ][A-Za-z]{3}[a-z]*[-/ ]\d{2,4}$/.test(value);
const dated = wire.filter(r => hasDate(r["Watch Date"]));
console.log(`file: ${file}`);
console.log(`parsed ${rows.length} row(s), ${wire.length} with a name (${rows.length - wire.length} blank row(s) skipped)`);
console.log(`dated rows: ${dated.length}; undated: ${wire.length - dated.length}`);
const titles = new Set(wire.map(r => r.Name.toLowerCase()));
console.log(`distinct titles: ${titles.size}`);
console.log("first rows:");
for (const row of wire.slice(0, 3)) console.log("  ", JSON.stringify(row));

if (!apply) {
  console.log(`\nDry run — nothing sent. Re-run with --apply to import into ${base}`);
  process.exit(0);
}

// ── sending it ─────────────────────────────────────────────────────────────
function password() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD.trim();
  const file = path.join(process.cwd(), ".dev.vars");
  if (fs.existsSync(file)) {
    const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find(l => l.startsWith("ADMIN_PASSWORD="));
    if (line) return line.slice("ADMIN_PASSWORD=".length).trim();
  }
  throw new Error("No admin password: set ADMIN_PASSWORD or put it in .dev.vars");
}

const login = await fetch(`${base}/.netlify/functions/admin-login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: password() })
});
if (login.status !== 200) {
  console.error(`admin-login failed (${login.status}) — is the password in .dev.vars the deployed one?`);
  process.exit(1);
}
const cookie = (login.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
console.log(`signed in to ${base}\n`);

const total = { received: 0, inserted: 0, duplicates: 0, skipped: 0 };
for (let i = 0; i < wire.length; i += CHUNK) {
  const chunk = wire.slice(i, i + CHUNK);
  const res = await fetch(`${base}/.netlify/functions/admin-import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ rows: chunk })
  });
  const text = await res.text();
  let report = {};
  try { report = JSON.parse(text); } catch { /* non-JSON body */ }
  if (res.status !== 200) {
    console.error(`chunk ${i / CHUNK + 1} failed (${res.status}): ${text.slice(0, 300)}`);
    process.exit(1);
  }
  for (const key of Object.keys(total)) total[key] += report[key] || 0;
  console.log(`  chunk ${Math.floor(i / CHUNK) + 1}: +${report.inserted} inserted, ${report.duplicates} duplicate, ${report.skipped} skipped`);
  if (report.stored) console.log(`    store now: ${report.stored.entries} entries`);
}

console.log(`\nreceived ${total.received}, inserted ${total.inserted}, duplicates ${total.duplicates}, skipped ${total.skipped}`);
console.log("Run it again to verify: a complete store answers with inserted 0 and everything counted as a duplicate.");

# Deep dive: the same class of flaw, everywhere else

**Date:** 22 October 2026 · **Store at the time of audit:** 392 rows, goal 1000 h / 2026

> **Status: every finding below is fixed** (22 Oct 2026, later the same day). The
> descriptions are kept as the record of what was wrong and why; the code is the
> authority on what it does now. Tests: `tests/store.test.mjs` (the cleanup scan
> against real SQLite, the edit guard, the goal read), `tests/lookups.test.mjs` (the
> lookup ceilings), and the region cases in `tests/watchmode.test.mjs`.



The flaw fixed last round was one shape of mistake: **a claim the store cannot back.**
The calendar painted a ✓ without a confirmed write, and `createEntry()` answered
`{ duplicate: 0 }` for an insert that changed nothing. Both read as success while
nothing had happened.

That shape is not local to the calendar. Below is every other place the site does it,
plus the neighbouring family — **a failed read presented as real content** — and the
data-integrity gaps that let one surface disagree with another. Each entry names the
mechanism, the evidence, what the user sees, and the one-line fix.

Nothing here is a style opinion. Every finding was verified against the code and, where
it could be, against the live deployment.

---

## P1 — Visible now, on the public or admin page

### 1. The cleanup card says the database is clean while an unreachable row exists

**Where:** `listInvalidEntries()` — [db.js:170-173](../netlify/functions/lib/db.js#L170-L173);
the card — [app.js:1151-1215](../app.js#L1151-L1215).

```sql
FROM entries WHERE watch_date IS NULL AND screentime <= 0
```

**Mechanism.** The card exists for exactly one reason, stated in its own comment: `mapRows`
drops every row whose year reads as 0, so such a row is in no list, chart or search and the
edit search cannot reach it. That predicate is *narrower than the reason*. A row with **no
watch date but a real screentime** also reads as year 0, is also invisible everywhere, and
is excluded by `AND screentime <= 0`.

**Evidence (live, today).** The public read returns 392 rows, of which exactly one has no
usable year:

```
hidden by mapRows: 1 -> [352, "down cemetry", watchDate: "", screentime: 508]
```

That row is not in the timeline, not in the Data table, not in any chart, not findable by
the edit search — and not in the cleanup scan either, because 508 > 0. Press Scan and the
card answers **"✓ No invalid rows found. The database is clean."**

**What the reader sees:** a clean bill of health for a store that holds a row no surface
can reach. This is the ✓-without-a-write bug wearing the cleanup card's clothes.

**Fix:** make the scan's predicate match its purpose — `WHERE watch_date IS NULL OR Year-of-watch_date
IS NULL` (i.e. `watch_date IS NULL OR watch_date = ''`), and keep screentime only as a
column, not a filter. The card's own subtitle ("no watch date and 0 minutes") changes with it.

---

### 2. Submit a suggestion, then read a five-minute-old list

**Where:** `submitSuggestion()` — [app.js:4665-4712](../app.js#L4665-L4712);
`loadSuggestions()` — [app.js:4536-4546](../app.js#L4536-L4546);
the cache header — [watchlist.js:48](../netlify/functions/watchlist.js#L48).

**Mechanism.** The POST goes to `suggestions`, the list is re-read from
`watchlist?sheet=Suggestions`, and that endpoint answers
`Cache-Control: public, max-age=300, stale-while-revalidate=300`. `loadSuggestions()` sends
no cache-busting marker, so the re-read is satisfied by the browser's (or the edge's) copy
from **before** the write.

**Evidence (live).** Measured on the deployed endpoint:

```
GET /.netlify/functions/watchlist?sheet=Suggestions
Cache-Control: public, max-age=300, stale-while-revalidate=300
```

**What the reader sees:** "✓ Suggestion submitted! It's now in the suggestions list." — and a
sidebar whose "Recent Suggestions" does not contain it and whose "Total suggestions" did not
move. For five minutes. The store has it; the page denies it.

**Fix:** the pattern already exists in this codebase — `reloadFresh()` and the calendar's
post-write re-read both use a one-shot `?fresh=<stamp>`. `loadSuggestions(bust)` should do
the same, and the success line should wait for the re-read to show the row (as `calRowSaved()`
does) instead of asserting it.

---

### 3. A failed suggestions read renders as a joke about having no suggestions

**Where:** `loadSuggestions()` — [app.js:4536-4546](../app.js#L4536-L4546).

```js
} catch (e) {
  suggData = [];
}
```

**Mechanism.** A network error, a 502 from the store path, a non-JSON body — every failure
becomes the same value as "the store is legitimately empty". `renderSubmitSidebar()` then
prints the designed empty state: *"😶 Apparently nobody wants me to watch anything. Rude."*
and "Total suggestions 0". A reader cannot tell a full inbox behind a broken read from an
empty one.

**What the reader sees:** content where the truth is a failure — the mirror image of the
calendar's ✓.

**Fix:** keep `null` for "could not read" and render a distinct line ("Couldn't load
suggestions just now") with a retry, the way `loadData` distinguishes `loadFailed` from
`rawData.length === 0`.

---

### 4. A page load writes to the shared store

**Where:** `loadGoal()` — [app.js:405-433](../app.js#L405-L433).

```js
if (!goalState.hrs && localHrs > 0) {
  if (serverReachable) {
    const saved = await setSharedGoal(localHrs, localYear || String(new Date().getFullYear()), { quiet: true });
```

**Mechanism.** The read path *writes*. If the store reports no goal and this device remembers
one in `localStorage` (`ct-goal`), the page silently POSTs it back to the shared settings
row — every visit, from any browser, with no click and no message. The comment reasons about
the 401 case (an ordinary visitor), but the dangerous case is precisely the other one: the
owner's browser holds a 30-day session cookie, so the write **lands**.

**Why it matters even though the current year is set.** `setGoal()` only locks a year once
that year's goal exists ([db.js:315-320](../netlify/functions/lib/db.js#L315-L320)). Today the store
holds `{ hrs: 1000, year: "2026" }`, so a stale local value cannot overwrite it — but on
**1 January 2027** the lock is against `2026`, the new year is unlocked, and the first visit
from any device carrying an old `ct-goal` defines the 2027 goal by itself. The page then shows
that number as the shared goal on every device.

**What the reader sees:** a goal they never set for a year they never chose.

**Fix:** the boot path should never write. Read the store; if it has no goal, show "no goal
set" and let the Set button (a real click, behind the session gate) publish the local value,
offering it prefilled. Prefill is honest; a silent publish is not.

---

### 5. Editing can create the exact duplicate the add form refuses

**Where:** `updateEntry()` — [db.js:269-280](../netlify/functions/lib/db.js#L269-L280);
the update path skipping the gate — [app.js:1516-1534](../app.js#L1516-L1534);
the schema — [0001_init.sql](../migrations/0001_init.sql) (`CREATE INDEX entries_dup_idx`, not UNIQUE).

**Mechanism.** Three surfaces hold the same rule and one of them drops it:

* the add form refuses an exact repeat before any request (`adminDuplicateCheck`, tier "exact");
* `createEntry()` re-checks it atomically inside the insert (`WHERE NOT EXISTS … dup_key = ?`);
* `updateEntry()` recomputes the key and writes it **with no guard at all**, and the client
  skips `adminDuplicateCheck` entirely when `adminEditRow !== null`.

So: open an existing row, change its watch date (or screentime) to match another row, save.
The store now holds two rows with the same `dup_key` and type. The add path would have
refused that pair; the edit path accepted it. From then on `createEntry()` for that key
answers `{ duplicate: <an arbitrary one of the two> }`, so the reported id can point at
either.

**Evidence.** `CREATE INDEX IF NOT EXISTS entries_dup_idx ON entries (dup_key)` — an index,
not a constraint, so nothing in the database refuses the second copy either.

**Fix:** run the same `WHERE NOT EXISTS (… dup_key = ? AND type = ? AND id <> ?)` guard on
update and answer `{ duplicate: id }` exactly as create does; and gate the client's update
through the same `adminDuplicateCheck` (excluding the row being edited).

---

## P2 — Data integrity: one surface disagrees with another

### 6. A failed goal read dissolves the year's lock

**Where:** `readGoal()` — [db.js:301-310](../netlify/functions/lib/db.js#L301-L310);
`setGoal()` — [db.js:315-333](../netlify/functions/lib/db.js#L315-L333).

`readGoal()` catches every error and returns `{ hrs: 0, year: '' }`. `setGoal()` decides whether
the year is locked from that return value:

```js
if (current.hrs > 0 && current.year === year) { /* locked */ }
```

**Mechanism.** "No goal set" and "the read failed" are the same value. One transient D1 error
during a Set lands in the second branch: the lock is bypassed, and a goal documented as
*permanent for the year* is replaced. The `no-store` read on the page has the same shape
(a transient failure renders as "no goal"), so the two failures conspire.

Also: the lock is a read followed by a write in two statements — two clicks on 1 January
can both pass the check.

**Fix:** make the failure distinguishable (`readGoal` returns `null` on error, `{hrs:0}` only
when the row genuinely says so) and refuse the write when the current value could not be
read; do the check inside the `INSERT … ON CONFLICT DO UPDATE` (`WHERE value IS …`).

---

### 7. Autofill writes numbers of the wrong granularity — the guard exists one function away

**Where:** `autofillAdminEntry()` — [app.js:1276-1325](../app.js#L1276-L1325);
`tmdb-search.js` — [netlify/functions/tmdb-search.js:130-157](../netlify/functions/tmdb-search.js#L130-L157);
`lookupZeroEntry()` — [app.js:1394-1403](../app.js#L1394-L1403).

`fillZeroEntries()` was built to refuse two things, and says why:

* a season TMDB does not list (`seasonOk: false`) — "without that signal the count would fall
  back to the whole series and land in a season row";
* the platform — "the lookup's first-provider-anywhere pick is the wrong region as often as
  not".

**The Autofill button next to the add form does neither:**

```js
'admin-platform': String(data.platform || 'Unknown platform')…
'admin-episodes': data.episodes || (data.type === 'Movie' ? 0 : 1),
'admin-screentime': data.screentime || 0
```

`data.seasonOk` is returned by the function and read by **nobody** on this path. When the
season payload is missing, the function's fallbacks are:

* `episodeCount = seasonDetails?.episodes?.length || details.number_of_episodes || parseInt(omdb?.totalSeasons, 10) || 1`
  — whole-series episodes, or **a season count used as an episode count**;
* `mergedRuntime = runtime || omdbRuntime` — for a series with no season payload, `runtime`
  is 0, so the series' screentime becomes **one episode's runtime**.

So a series row can be saved as "S3, 5 eps, 46 mins" for a 40-episode, 26-minute show, and the
platform is the first provider found in any country. The page shows the filled values as
"Details filled from TMDB. Review them before saving." — which puts the check on the reader
for numbers they have no way to verify.

**Fix:** in `autofillAdminEntry`, when `data.seasonOk === false`, fill the title/type/genre but
leave episodes/screentime blank and say why; drop the platform from the autofilled set (or
only set it when it matches a platform the watchlist already uses, which the select offers).

---

### 8. The silent refresh cannot see an edit that changed only genre, platform or episodes

**Where:** `dataSignature()` — [app.js:462-471](../app.js#L462-L471).

```js
hash = ((hash * 33) ^ (r.row * 131 + (r.name || '').length + (r.watchDate || '').length + (Number(r.screentime) || 0))) >>> 0;
```

**Mechanism.** The signature is the trigger for repainting after a background refresh
(`repaintIfChanged`). A row whose **genre, platform, type or episode count** changed keeps the
same signature, so `bootData()` fetches the new rows, decides nothing changed, and leaves the
old paint on screen. Screentime and date are in the hash, so the fill-in-zeros write does
repaint — which is what makes this look fine in testing.

**What the reader sees:** an edit that appears to have been ignored until the next navigation.

**Fix:** hash the fields the pages render (`name`, `type`, `genre`, `platform`, `episodes`,
`screentime`, `watchDate`, `season`) — or just `JSON.stringify(rows).length` + a cheap
per-row string hash.

---

## P3 — Cost and abuse: the throttled endpoint is the cheap one

### 9. `tmdb-search` and `imdb-id` are world-callable with no limit

**Where:** [tmdb-search.js](../netlify/functions/tmdb-search.js) and
[imdb-id.js](../netlify/functions/imdb-id.js) — neither imports `lib/throttle.js`;
compare [suggestions.js:19-27](../netlify/functions/suggestions.js#L19-L27), which does.

**Mechanism.** `suggestions` is one INSERT and it is rate-limited to 8 per IP per 10 minutes,
because "the suggestions table is the thing being polluted". `tmdb-search` is *more* expensive
per call — one TMDB search, one `external_ids`, one OMDb lookup in light mode; four or five
upstream calls plus OMDb in full mode — and it has no limit at all, on the same public origin.

```console
$ for i in 1 2 3; do curl -o /dev/null -w '%{http_code}\n' "$S/.netlify/functions/tmdb-search?light=1&title=Dune&type=movie"; done
200
200
200
```

**What it costs.** OMDb's free tier is 1,000 requests/day: a modest loop exhausts it, and every
rating in the app then silently degrades to TMDB's score (`tmdb-search.js:74-79`) — a wrong
number presented as a rating, with nothing on screen to say the source changed. The same loop
shares TMDB's per-second allowance with the calendar, which is the one caller that cannot
degrade gracefully.

**Fix:** the existing `writeState`/`recordWrite` limiter, applied to both endpoints (a higher
ceiling than suggestions — the poster path calls them on scroll). Cache `light=1` answers at
the edge for a day, as `imdb-id` already does.

---

### 10. `region` is validated as "two letters", not as a region

**Where:** [calendar.js:54](../netlify/functions/calendar.js#L54), used at 130-140.

```js
const REGION_RE = /^[A-Z]{2}$/;
```

`ZZ`, `XX`, `QQ` all pass, so "a missing or unusable value falls back to `US`" holds only for
values that are not two letters.

**Evidence (live):**

```
GET /.netlify/functions/calendar?from=2026-10-01&to=2026-10-31&include=movies&region=ZZ
→ 200, 0 films, 1 warning, range.region: "ZZ"
```

Each one is a full cinema sweep spent on a country that does not exist, plus its own CDN cache
entry. The page never sends such a value (it only offers its own list), so this is an API-surface
gap rather than a page bug — but it is the same "validated" claim as the duplicate rule once was.

**Fix:** intersect against a small allow-list of ISO-3166 codes (the page's own list is the
natural source) and fall back to `US` for anything else.

---

## P4 — Smaller, same family

| # | Where | What | Fix |
|---|-------|------|-----|
| 11 | `buildDataCSV()` [app.js:2328](../app.js#L2328) | `r.episodes \|\| ''` and `r.screentime \|\| ''` export a **legitimate 0 as a blank cell** — the same "a numeric 0 is not empty" mistake `dataVal()` was fixed for. Also no `= + - @` escaping, so a title beginning with `=` is a live formula when the CSV is opened. | `String(n ?? '')` and prefix `'` for formula-leading cells. |
| 12 | `applyDataFilters()` [app.js:2364-2385](../app.js#L2364-L2385) | Applies the URL **on top of** whatever is in memory instead of resetting first. Pasting a shared `?year=2026#data` link into a tab that already filtered to `platform=Netflix` gives Netflix∩2026 while the URL says only `year` — the empty-table-reads-as-missing-data failure the function's own comment sets out to prevent. | Reset every key to `all` before reading the URL. |
| 13 | `admin-login.js:25` vs `lib/session.js:12` | Two copies of `sign()`. `session.js` exists because "three copies of a signature check is how they drift apart" — there are still two, and the payload/encoding is the thing that must match. | `const { sign } = require('./lib/session')`. |
| 14 | `findDuplicateRow()` [db.js:192-211](../netlify/functions/lib/db.js#L192-L211) | A **second implementation of the duplicate rule**, exported and called by nothing (the live bundles only contain it because the module exports it). It compares wire rows and will drift from `duplicateKey()` the moment either changes. | Delete it and its export. |
| 15 | `deleteInvalidRow()` [app.js:1194-1215](../app.js#L1194-L1215) | After the last row it prints "The database is clean" — the same overclaim as #1, now made by a click. | Say "No invalid rows left in this scan." |

---

## What is *not* wrong (checked, so it does not get re-audited)

* **Auth gates hold.** `admin-entry`, `goal`, `admin-import` all answer `401 SESSION_INVALID`
  without a session (live). The cookie is `HttpOnly; Secure; SameSite=Strict`, the signature is
  compared with `timingSafeEqual`, and the payload's `sub`/`exp` are both checked.
* **CORS is exactly the named allowance.** `Access-Control-Allow-Origin` appears for
  `https://parth-portfolio-wb.pages.dev` with `Vary: Origin`, preflight answers
  `204` + `GET, OPTIONS`, and a foreign origin gets the 200 body with **no** ACAO header.
* **Negotiation follows RFC 9110.** `text/html`→HTML, `text/markdown`→Markdown, `q` values
  honoured, `text/markdown;q=0` and `application/json`→`406`, `*/*`→HTML, `Vary: Accept` on
  every answer including the 404 and 406, `/index.md` always Markdown, and a 404 stays a 404
  with an HTML or Markdown body as asked.
* **The calendar's own ✓ is now backed.** `calEntrySaved()` requires a `rowNumber`/`duplicate`,
  the repaint verifies the row, and `createEntry()` throws instead of answering
  `{ duplicate: 0 }`.
* **`/tmp`-class date bugs.** `mapRows` normalises to ISO, `parseDateParts` rejects month 13 and
  30 February, `dataVal()` returns `''` (not 0) for a missing value, and the sort sinks empties.

---

## Ranked shortlist

1. **#1** — the cleanup card's false "clean", with a live unreachable row behind it.
2. **#5** — edits create duplicates the add path refuses (two surfaces disagree; the DB does not object).
3. **#2** — a suggestion is reported as listed while the list is five minutes stale.
4. **#6** — a failed read silently unlocks the year's goal.
5. **#7** — Autofill writes wrong-granularity numbers, while the sibling path refuses to.
6. **#9** — the expensive, OMDb-spending endpoints are the unthrottled ones.
7. **#3 / #8 / #10** — failure rendered as content; a signature that cannot see an edit; a two-letter "region".
8. **#4** — a page load that writes the shared goal (harmless in 2026, live again on 1 Jan 2027).

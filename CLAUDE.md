# Content Tracking Dashboard — Project Instructions

## Overview
Personal media analytics dashboard: analyzes ~370 titles (movies/series) logged in a Google Sheet. Frontend is a vanilla JS SPA; Netlify functions talk straight to the Google Sheets API with a service-account key. There is **no Apps Script** anywhere — nothing to redeploy by hand.

## Tech Stack
- Frontend: `index.html` (static shell + nav) + `app.js` (SPA that renders every page from the Sheet API) + `styles.css`
- Charts: Chart.js 4.4.1 (CDN, loaded on every page even though only Current Year / All Time use it)
- Backend: `netlify/functions/` — `watchlist.js` (data + goal read), `goal.js`, `suggestions.js`, `admin-login.js`, `admin-entry.js` (create/update/delete), `tmdb-search.js` (TMDB search + OMDb rating/imdbId), shared code in `netlify/functions/lib/` (`sheets.js`, `throttle.js`)
- Hosting: Netlify; dark mode persisted in `localStorage` (`ct-theme`)

## Files
```
index.html   → static shell: loading screen, nav tabs (Readme/Current Year/All Time/Data/Timeline/Random Pick/Submit), theme toggle
app.js       → SPA: data fetch + all page/template rendering (uses many emojis as decorative icons)
styles.css   → design tokens in :root + html.dark; responsive blocks at ≤900px and ≤600px
netlify/functions/    → the API listed above
```

## Code Style / Conventions
- Nav tabs carry inline 13px SVGs declared in `index.html`; the brand mark is an inline TV SVG. On ≤900px the tab icons are hidden and `.nav-tabs` becomes a scrolling strip with a mask fade — the single-row nav is wider than the viewport between 601px and ~850px otherwise.
- `--nav-h` must match the **measured** nav height at each breakpoint (60px desktop, 73px mobile) — the sticky table header, timeline jump bar and month headers all offset from it.
- The theme toggle shows two SVGs (`.icon-sun`/`.icon-moon`) toggled by `app.js`; **do not** switch it back to `textContent = '🌙'/'☀️'`.
- The app body uses many emojis as icons (media-type emojis, insight rows, poster placeholders). Standardizing onto a real icon library is a known, feasible refactor — be careful: `app.js` frequently rewrites these nodes.
- "Recently Watched" cards, the Data table and the Random Pick result all pull real posters through the shared `MEDIA_CACHE` / `loadPoster` / `loadVisiblePosters` path; the emoji fallback is only for titles the media API can't resolve, and it swaps the `<img>` for a `<span class="… placeholder">`.
- **Display-level normalization only** — the Sheet keeps whatever was typed. `GENRE_MAP`/`TYPE_MAP`/`smartCaseName` in `app.js` merge near-duplicate labels ("Science Fiction" → "Sci-Fi", "Series/Show" → "Series") and capitalise all-lowercase titles at render time.
- Year-over-year figures compare **the same months** on both sides (`Jan–Sep 2026` vs `Jan–Sep 2025`), skipping a month that is still running; the full previous year appears as context only. Don't reintroduce year-to-date vs full-year comparisons.
- Ratings come from the on-demand media lookup and are cached per device: the Data page shows coverage and offers "Load all ratings" (concurrency 3), and `buildDataCSV` falls back to `cachedRating()` so the export isn't limited to rows on screen.
- `ct-media-cache` stores `{ items, miss }`. A title the media API answers **without a rating** is recorded in `miss` (7-day TTL, `MEDIA_MISS_TTL`), because such a title never gains an `imdbId` and would otherwise be re-queried — TMDB *and* OMDb — on every single re-render. `ratingCoverage().dead` counts those as "unavailable" so the coverage readout and the "Load all ratings" button can actually finish; a later success clears the marker.
- The Data table's `<th>`s are keyboard-sortable (`tabindex`/`aria-sort`/`title`); sort state lives in `sortDataBy()`, which also restores focus to the same header (the re-render throws the element away). `dataVal()` must return `''` for a missing value — `compareData()` sinks empty values to the bottom, but a numeric `0` is not empty, so returning 0 for a missing episode count / rating buried the 92 movies (or every unrated row) at the top of an ascending sort.
- `#dat-table` owns the horizontal scrollport at ≤900px too, not just ≤600px: the 9-column table is ~915px wide, so between 601px and ~950px the body's `overflow-x: hidden` used to clip the Rating / Watch Date columns with no way to reach them. The sticky header therefore only sticks where the table fits without scrolling (≥951px).
- Every `history.replaceState` writes `location.pathname` before the query. A **fragment-only** URL (`'#data'`) keeps the *current* query string, which left cleared filters in the address bar and let `applyDataFilters()` resurrect them on the next render — and left a one-shot `?fresh=` marker behind.
- **Never put `overflow: hidden` back on `table`** — it traps the sticky header/name cells in a box that never scrolls. The rounded corners are painted per-cell instead (thead th first/last, last row's first/last td).
- Timeline: `bindTimelineNav()` wires the year jump bar and the per-month expanders; long months render collapsed after 5 items.
- Data loads from the deployed functions at runtime, so a bare static server serves the shell but returns 404 for data — expected without the backend.

## Build & Run
- No build step and no `package.json`: the repo root is the publish directory.
- Serve the folder statically for shell-only work; to exercise real data locally, use a tiny static server that proxies `/.netlify/functions/*` to the deployed site (and delete it afterwards — it is not part of the project).
- Deploys are Netlify; the functions and the static shell ship together from `main`.

## Git
- Work on `main`; imperative one-line commit messages.  Be careful to stage only intended files — this repo has had unrelated in-progress working-tree edits.

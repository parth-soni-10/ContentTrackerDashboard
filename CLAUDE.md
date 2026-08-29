# Content Tracking Dashboard — Project Instructions

## Overview
Personal media analytics dashboard: analyzes 342+ titles (movies/series) logged in a Google Sheet. Frontend is a vanilla JS SPA rendered from a Google Apps Script web app (+ OMDB/TMDB lookups); a Google Apps Script backend wraps the Sheet as the database. Served from Netlify.

## Tech Stack
- Frontend: `index.html` (static shell + nav) + `app.js` (SPA that renders every page from the Sheet API) + `styles.css`
- Charts: Chart.js 4.4.1 (CDN)
- Backend: `google-apps-script.gs` — Sheet-backed Apps Script web app; `netlify/functions/` (admin-entry.js, tmdb-search.js) for admin edits + TMDB enrichment
- Hosting: Netlify; dark mode persisted in `localStorage` (`ct-theme`)

## Files
```
index.html   → static shell: loading screen, nav tabs (Readme/Current Year/All Time/Data/Timeline/Suggestions/Submit), theme toggle
app.js       → SPA: data fetch + all page/template rendering (uses many emojis as decorative icons)
google-apps-script.gs → Sheet-backed API + admin functions
netlify/functions/    → admin-entry.js, tmdb-search.js
```

## Code Style / Conventions
- Nav tabs carry inline 13px SVGs declared in `index.html`; the brand mark is an inline TV SVG (the 📺 emoji was replaced).
- The theme-toggle button's content is controlled by `app.js` (`btn.textContent = '🌙'/'☀️'`) — do not put a static SVG inside that button; it gets overwritten.
- The app body uses many emojis as icons (media-type emojis, insight rows, `RW_ICONS`). Standardizing onto a real icon library is a known, feasible refactor — be careful: `app.js` frequently rewrites these nodes.
- Data loads from the deployed Apps Script web app URL at runtime, so local `python -m http.server` serves the shell but returns 404 for data — expected without the backend.

## Build & Run
- Serve the folder with any static server; only the shell+nav render without the Apps Script backend.
- Deploys are Netlify; Apps Script (`google-apps-script.gs`) and Netlify functions are separate deploy targets.

## Git
- Work on `main`; imperative one-line commit messages. Be careful to stage only intended files — this repo has had unrelated in-progress working-tree edits.
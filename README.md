# 📺 Content Tracker

A personal dashboard that turns my watchlist into pictures and numbers — what I watch, which platforms, which genres, and how it changes year to year.

It reads live from **its own database**, so whenever I log a new title it shows up here by itself.

## What you can see

- **Home / Readme** — headline stats at a glance, plus what I watched most recently
- **Current Year** — this year's shows, movies, and screen time, compared with last year
- **All Time** — my full history, with charts you can filter year by year
- **Data** — the whole watchlist as a searchable table (filter by year, platform, genre, and more)
- **Suggestion Generator** — can't decide what to watch? Pick a genre, hit **Spin**, and it lands on a random pick from the list
- **Timeline** — everything laid out in date order
- **Calendar** — a rolling release calendar: this year month by month, next year as a whole, showing only the platforms you track — cinema releases and the films that land on your services, plus every episode of the shows on them. League and promotion entries — a WWE card, an NBA or NFL game — are left out, since those air every week all year and are not releases you plan around. The month you are in is shown **whole**, the days that have already passed included — the function fetches those days itself, so a day that has been and gone carries the releases that were on it rather than sitting empty. It filters by platform, region and type, and **Episode releases** turns the month into the episode schedule itself — each show's episodes on the day they land, films and the daily news/talk strips left out. Clicking a release's title opens its own IMDb page — never the API it came from — while the poster and badges around it open that day's complete list, your filters are remembered on the device so the page opens the way you left it, and it refreshes itself — new months and new years appear on their own
- **Suggestions & Submit** — easy ways to request or add a new title
- **Admin** — a password-protected area for managing the watchlist, where a title you already logged is caught before it is added twice, and a cleanup scan that lists stored rows with no watch date and 0 minutes — invisible everywhere else — so they can be deleted

## How it works

The watchlist lives in **D1**, Cloudflare's SQLite — one row per title, with its type, dates, genres, and more. The functions under `netlify/functions/` query that store directly (through `lib/db.js`, the one file that knows the schema), compiled by Cloudflare Pages as the site's own function; the paths keep their `/.netlify/functions/*` shape because the page has always called those. There is no spreadsheet, no Apps Script and nothing to redeploy by hand. Add a title (in the admin panel or through the API) and the change shows up on the site.

The schema is a committed migration in [`migrations/`](migrations/0001_init.sql), applied with `npx wrangler d1 migrations apply content-tracker-watchlist --remote`. D1 does not run migrations on deploy, so that command is part of releasing a schema change. The Postgres schema it replaced lived under `netlify/database/migrations/` and went with the rest of the Netlify-era configuration — git history has it, and the migration's own header says what it was.

## Setup (one-time)

Everything the deployment needs:

- **The store.** One D1 database, bound as `DB` on the deployment (`wrangler.toml` in the repo, the project settings on Cloudflare) — the name and id are in that file, so there is nothing to provision and no connection string to keep (D1 is a binding, not an endpoint). It holds a few hundred rows, so there is nothing here to size, scale or keep alive.
- `ADMIN_PASSWORD` — the password for the Admin page.
- `ADMIN_SESSION_SECRET` — a long random string that signs the admin session cookie.
- `TMDB_API_KEY` — a free [TMDB](https://developer.themoviedb.org/docs/getting-started) API key, used for poster art in the admin lookup and for the **film** half of the Calendar page.
- `OMDB_API_KEY` — optional, and worth having: IMDb star ratings in the admin lookup. Without it the rating falls back to TMDB's own score.

The secrets are set on the Pages project (Settings → Variables and Secrets) and survive deploys; for local runs the same names go in a gitignored `.dev.vars`. There is one deployment and no preview environment, so nothing here needs a second set of values.

## Run it locally

For shell-only work — layout, styling, copy — any static server is enough:

```
python -m http.server
```

A bare static server serves the page shell and nothing else: the data comes from the functions, so it will report that the watchlist service did not respond. To run the real thing locally you need Node 20 or newer and `wrangler` (this repo installs nothing — `npx wrangler` is enough):

```
npx wrangler d1 migrations apply content-tracker-watchlist --local   # once
npx wrangler pages dev .                                             # http://localhost:8788
```

The local run gets its own D1 database on disk, which starts empty — `tools/import-watchlist.mjs` is the documented way to load rows into it, or just add one through the admin panel. The four secrets come from `.dev.vars`, and `--persist-to <dir>` keeps that local state outside the repo.

## Built with

Plain **HTML / CSS / JavaScript**, **serverless functions** talking straight to **SQLite on D1** (the store the managed Postgres database was migrated into, row for row), and **Chart.js** for the charts. Served — and compiled — by **Cloudflare Pages**, with the schema in `migrations/`.

---

*A personal project for media nerds who love their stats.*

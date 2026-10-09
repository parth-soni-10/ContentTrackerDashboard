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
- **Calendar** — a rolling release calendar: this year month by month, next year as a whole, showing only the platforms you track — cinema releases and the films that land on your services, plus every episode of the shows on them. It filters by platform, region and type, and **Episode releases** turns the month into the episode schedule itself — each show's episodes on the day they land, films and the daily news/talk strips left out. Any day opens for the complete list, your filters are remembered on the device so the page opens the way you left it, and it refreshes itself — new months and new years appear on their own
- **Suggestions & Submit** — easy ways to request or add a new title
- **Admin** — a password-protected area for managing the watchlist, where a title you already logged is caught before it is added twice

## How it works

The watchlist lives in **Postgres**, managed by Netlify as **Netlify Database** — one row per title, with its type, dates, genres, and more. **Netlify functions** query that database directly with `pg`; there is no spreadsheet, no Apps Script and nothing to redeploy by hand. Add a title (in the admin panel or through the API) and the change shows up on the site.

The schema is a committed migration in [`netlify/database/migrations/`](netlify/database/migrations/0001_init.sql), applied by the deploy itself: immediately before a production publish, and on every deploy preview — which gets its **own branch of the database, seeded from production**, so a schema change is rehearsed against real data before it touches production.

## Setup (one-time)

Everything the deployment needs:

- **The database.** It comes from the [`@netlify/database`](https://docs.netlify.com/build/data-and-storage/netlify-database/) dependency in `package.json` — Netlify provisions managed Postgres the first time it builds a deploy that has it installed. The connection string is injected as `NETLIFY_DB_URL` for every deploy context, so nothing has to be copied into environment variables. (`netlify database init` does the same thing from the CLI, if you would rather set it up before pushing.)
- `ADMIN_PASSWORD` — the password for the Admin page.
- `ADMIN_SESSION_SECRET` — a long random string that signs the admin session cookie.
- `TMDB_API_KEY` — a free [TMDB](https://developer.themoviedb.org/docs/getting-started) API key, used for poster art and ratings in the admin lookup and for the **film** half of the Calendar page. Give it a value for **every deploy context** (production, branch deploys, deploy previews) — a value set for production only leaves a preview film-less and poster-less, with the Calendar saying so. When you run the functions locally, it needs a value there too (a `.env` file with `TMDB_API_KEY=…` is what `netlify dev` reads).

Netlify Database is available on credit-based plans and an active database consumes credits for compute and bandwidth — that is the one recurring cost of this setup.

### One-time import (only if you are coming from the Google Sheet)

The Sheet's rows were copied into the database by a one-shot importer before the Sheet was retired. It is kept in the repo as `netlify/functions/admin-import.js` so the import can be repeated on a preview, and it is **idempotent** — a row whose duplicate key already exists is skipped rather than inserted twice — and **read-only towards the Sheet**: it never writes back to it and never deletes a database row.

It needs `SPREADSHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON` set for the deploy doing the import (see the service-account steps below), and it is driven by a signed-in request:

```
# 1. Sign in once and keep the session cookie
curl -c /tmp/ct-cookies -X POST https://YOUR-SITE.netlify.app/.netlify/functions/admin-login \
  -H 'Content-Type: application/json' -d '{"password":"YOUR_PASSWORD"}'

# 2. Dry run — counts what would be imported, writes nothing (the default)
curl -b /tmp/ct-cookies -X POST https://YOUR-SITE.netlify.app/.netlify/functions/admin-import \
  -H 'Content-Type: application/json' -d '{}'

# 3. The real import
curl -b /tmp/ct-cookies -X POST https://YOUR-SITE.netlify.app/.netlify/functions/admin-import \
  -H 'Content-Type: application/json' -d '{"dryRun":false}'
```

When the counts look right and the site reads the new store, remove `SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `admin-import.js` and `lib/sheets.js` — at that point the Sheet is no longer read anywhere.

The service account (needed only for that import):

1. In the **Google Cloud Console**, create a project and enable the **Google Sheets API**.
2. Create a **service account** under APIs & Services → Credentials, then add a JSON key and download it.
3. In the spreadsheet, click **Share** and add the service account's email address as an **Editor**.
4. In **Netlify** → Site settings → Environment variables, add `SPREADSHEET_ID` (the long string between `/d/` and `/edit` in the spreadsheet's URL) and `GOOGLE_SERVICE_ACCOUNT_JSON` (the entire contents of the key file, braces included).

## Run it locally

For shell-only work — layout, styling, copy — any static server is enough:

```
python -m http.server
```

A bare static server serves the page shell and nothing else: the data comes from the functions, so it will report that the watchlist service did not respond. To run the real thing locally you need the Netlify CLI (26.0.0 or newer) and Node 20.12.2 or newer:

```
netlify link        # once, to attach this checkout to the site
netlify database migrations apply   # locally, migrations are not automatic
netlify dev
```

`netlify dev` starts a local Postgres for the database and injects `NETLIFY_DB_URL`, so the functions talk to a real database on your machine; `TMDB_API_KEY` and the admin variables come from the `.env` file it reads.

## Built with

Plain **HTML / CSS / JavaScript**, **Netlify functions** talking straight to **Postgres** (Netlify Database, installed as `@netlify/database` + `pg`), and **Chart.js** for the charts. Hosted on **Netlify**.

---

*A personal project for media nerds who love their stats.*

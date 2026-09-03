# 📺 Content Tracker

A personal dashboard that turns my watchlist into pictures and numbers — what I watch, which platforms, which genres, and how it changes year to year.

It reads **live from a Google Sheet**, so whenever I log a new title it shows up here by itself.

## What you can see

- **Home / Readme** — headline stats at a glance, plus what I watched most recently
- **Current Year** — this year's shows, movies, and screen time, compared with last year
- **All Time** — my full history, with charts you can filter year by year
- **Data** — the whole watchlist as a searchable table (filter by year, platform, genre, and more)
- **Suggestion Generator** — can't decide what to watch? Pick a genre, hit **Spin**, and it lands on a random pick from the list
- **Timeline** — everything laid out in date order
- **Suggestions & Submit** — easy ways to request or add a new title
- **Admin** — a password-protected area for managing the watchlist

## How it works

The watchlist lives in a **Google Sheet** — one row per title, with its type, dates, ratings, and more. **Netlify functions** talk to that sheet directly through the **Google Sheets API**, authenticated as a service account — no Apps Script in the middle, nothing to redeploy by hand. Edit the sheet (or the admin panel) and the change shows up on the site automatically.

## Setup (one-time)

The site reaches the spreadsheet through two environment variables on Netlify:

- `SPREADSHEET_ID` — the long string between `/d/` and `/edit` in the spreadsheet's URL
- `GOOGLE_SERVICE_ACCOUNT_JSON` — the entire contents of a Google service-account key file (the whole JSON blob, braces included)

Creating the service account takes about ten minutes, once:

1. In the **Google Cloud Console**, create a project and enable the **Google Sheets API**.
2. Create a **service account** under APIs & Services → Credentials, then add a JSON key and download it.
3. In the spreadsheet, click **Share** and add the service account's email address as an **Editor**.
4. In **Netlify** → Site settings → Environment variables, add the two variables above, then redeploy (or just push).

That is the whole setup. After it's done the code talks to the sheet directly — **no Apps Script is used, so nothing ever needs a manual redeploy again** (the old Apps Script deployment, if present, can be deleted: spreadsheet → Extensions → Apps Script → Deploy → Manage deployments → ⋮ → Delete).

## Run it locally

No setup needed. Serve this folder with any simple static server and open it in a browser:

```
python -m http.server
```

The live data comes from the sheet, so it needs an internet connection.

## Built with

Plain **HTML / CSS / JavaScript**, **Netlify functions** talking straight to the **Google Sheets API** (service-account auth), and **Chart.js** for the charts. Hosted on **Netlify**.

---

*A personal project for media nerds who love their stats.*
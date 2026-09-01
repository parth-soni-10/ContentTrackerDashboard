# 📺 Content Tracker

A personal dashboard that turns my watchlist into pictures and numbers — what I watch, which platforms, which genres, and how it changes year to year.

It reads **live from a Google Sheet**, so whenever I log a new title it shows up here by itself.

## Watch it

A 30-second trailer:

<video src="brag-output/brag.mp4" controls poster="brag-output/brag.jpg" width="360"></video>

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

My watchlist lives in a **Google Sheet** — one row per title, with its type, dates, ratings, and more. A lightweight **Google Apps Script** serves that data, and the dashboard reads it live. No database, no subscription, no sign-up.

## Run it locally

No setup needed. Serve this folder with any simple static server and open it in a browser:

```
python -m http.server
```

The live data comes from the sheet, so it needs an internet connection.

## Built with

Plain **HTML / CSS / JavaScript**, the **Google Sheets API** via **Apps Script**, and **Chart.js** for the charts. Hosted on **Netlify**.

---

*A personal project for media nerds who love their stats.*
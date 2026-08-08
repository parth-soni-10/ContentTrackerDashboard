# 📺 Content Tracker

> A personal media tracking dashboard built with vanilla HTML, CSS, and JavaScript — powered by Google Sheets as a live database.

No frameworks. No backend. No subscription. Just a clean, fast, beautiful dashboard that reads your watchlist in real time and turns it into insights.

---

## ✨ What It Does

You log what you watch in a Google Sheet. This dashboard reads that sheet live and gives you a fully interactive analytics site — 5 pages, charts, filters, stats, and a random suggestion generator.

```
Google Sheet  →  Apps Script API  →  Content Tracker Dashboard
```

---

## 🗂 Pages

### 🏠 Readme
The homepage. Shows your all-time headline stats at a glance — total titles, screentime, this year's count, and top platform. Below that, a **Recently Watched** strip pulls your last 6 titles live so the page always feels current. A sidebar shows quick facts, a year-on-year screentime comparison, and a note on how the difference metric works.

### 📅 Current Year Numbers
Everything about the current year. Filter by **platform** or **genre** using the header dropdowns. KPI cards show shows watched, movies watched, total screentime, and the difference versus last year (green if up, red if down). A horizontal platform bar chart, a monthly line chart, a genre treemap, and a stats sidebar fill out the rest.

### 📈 All Time Numbers
Same layout as Current Year but across your entire history. Adds a **year filter** so you can isolate any individual year. Useful for spotting long-term trends — which platforms you've used most, which genres dominate, and how your viewing volume has changed year on year.

### 🗃 Data
Your full watchlist in a paginated, searchable, filterable table — 25 rows per page, sorted newest first. Six filters: year, platform, type, genre, month, and a live name search. The header shows a live count of shows / movies / total matching your current filters.

### 🎲 Suggestion Generator
Can't decide what to watch? Filter by genre and type, hit **Spin**, and the slot-machine animation lands on a random pick from your watchlist. Confetti burst included. A "try another" button cycles to a different title without re-spinning.

---

## 📊 Data Source

All data lives in a **Google Sheet** with the following columns:

| Column | Description |
|---|---|
| `Name` | Title of the show or movie |
| `Type` | `Show` or `Movie` |
| `Details/Genre` | Genre (e.g. Drama, Thriller, Comedy) |
| `Platform` | Streaming service (Netflix, Apple TV+, etc.) |
| `Screentime` | Runtime in minutes |
| `Watch Date` | Date watched (DD/MM/YYYY) |
| `Month` | Month name (e.g. January) |
| `Year` | Year as a number (e.g. 2025) |

The sheet is exposed via a **Google Apps Script** web app that returns the data as JSON. The dashboard fetches this on every page load — no caching, always fresh.

---

## 🏗 Architecture

```
content-tracker/
├── index.html      # Shell — nav, loading screen, app mount point
├── styles.css      # All styling — design system, components, responsive
└── app.js          # All logic — data fetching, routing, rendering, charts
```

**Deliberately simple:**
- Pure vanilla JS — no React, no Vue, no build step
- Single-page app with hash-free routing via a `navigateTo()` function
- Chart.js 4.4.1 (loaded from CDN) for line charts
- Google Fonts (Inter) for typography
- No local storage, no cookies, no tracking

---

## 📦 Platform Emoji Map

The dashboard auto-maps platform names to emojis. Supported out of the box:

| Platform | Emoji |
|---|---|
| Netflix | 🔴 |
| Amazon Prime Video | 🔵 |
| Apple TV+ | ⚫ |
| HBO Max | 🟣 |
| Disney+ | 🔷 |
| Peacock | 🦚 |
| Hulu | 🟢 |
| Theater | 🎬 |
| Paramount+ | ⭐ |
| MUBI | 🎞️ |

Any unlisted platform falls back to 📺. To add more, edit the `PEMOJI` object in `app.js`.

## 📋 Tech Stack

| Tool | Purpose |
|---|---|
| HTML / CSS / JS | Everything |
| [Chart.js 4.4.1](https://www.chartjs.org/) | Line charts |
| [Google Sheets](https://sheets.google.com) | Data storage |
| [Google Apps Script](https://script.google.com) | JSON API |
| [Netlify](https://netlify.com) | Hosting |
| [Google Fonts](https://fonts.google.com) | Inter |

---

## 🔗 Live Dashboard

**[contenttrackerdashboard.netlify.app](https://contenttrackerdashboard.netlify.app/)**

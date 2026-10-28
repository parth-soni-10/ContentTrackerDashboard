# 📺 Content Tracker

A personal dashboard that turns a watchlist into pictures and numbers - what I watch, which platforms, which genres, and how it changes year to year.

**Live:** https://contenttrackerdashboard.pages.dev

## What you can see

- **Home** - headline stats at a glance, plus what was watched most recently
- **Current Year** - this year's shows, films and screen time against last year
- **All Time** - the full history, with charts you can filter by year
- **Data** - the whole watchlist as a searchable table
- **Calendar** - a rolling release calendar for the platforms you track: cinema releases, new films, what lands on a streaming service and every episode drop, filtered by platform, region and type
- **Suggestion Generator** - pick a genre, hit **Spin**, get a random pick from the list
- **Timeline** - everything laid out in date order
- **Admin** - password-protected watchlist management, with duplicate catching and a cleanup scan for rows nothing else shows

## How it works

The watchlist lives in **D1**, Cloudflare's SQLite - one row per title with its type, dates, genres and more. The site's own functions query it through the one module that knows the schema, so a title added anywhere shows up on the site by itself: no spreadsheet, no manual redeploy.

The release calendar's data comes from three public sources - **TMDB** for films, **TVmaze** for episode drops and a per-service **release feed** for what lands on a streaming service. Each is best-effort: if one is slow or down, the rest of the page still renders and says what is missing.

## For agents and crawlers

The pages are readable without JavaScript, and every page also has a Markdown representation: send `Accept: text/markdown` to the same URL (or read `/index.md`, `/about.md`, `/contact.md`, `/privacy.md`). The public watchlist is a JSON read at `/.netlify/functions/watchlist`. [`llms.txt`](https://contenttrackerdashboard.pages.dev/llms.txt) explains when the site is worth using and how to call it; `/about`, `/contact` and `/privacy` cover who runs it and what it stores.

## Built with

Plain **HTML / CSS / JavaScript**, **Chart.js** for the charts, and **Cloudflare Pages** with a **D1** database behind its functions.

## Streaming data powered by [Watchmode.com](https://watchmode.com)

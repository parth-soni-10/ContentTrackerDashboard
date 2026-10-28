/**
 * The agent-facing representations of this site's pages.
 *
 * The dashboard is a JavaScript app: the watchlist is fetched and every page is
 * painted by app.js. That is fine for a browser and useless to an AI agent or a
 * crawler that asks for the text, so this module carries a Markdown rendering of
 * the pages that have one, and the router beside it (`_router.js`) chooses
 * between the HTML asset and the Markdown here with ordinary HTTP content
 * negotiation (RFC 9110) - the same POST-less, auth-less URL, two
 * representations:
 *
 *   Accept: text/markdown  →  text/markdown; charset=utf-8 + Vary: Accept
 *   Accept: text/html      →  the HTML asset, also with Vary: Accept
 *   no Accept / wildcard     →  the HTML asset (the default)
 *
 * `Vary: Accept` is the part that is easy to forget: without it a shared cache
 * is free to hand a browser the Markdown blob (or an agent the HTML) because it
 * keyed the entry on the URL alone.
 *
 * Markdown is also served at a real URL per page - /index.md, /about.md,
 * /contact.md, /privacy.md - because the llms.txt proposal (v2) asks for the
 * Markdown version to exist at a URL a linker can point at, not only behind a
 * header a simple fetcher may not send:
 *   <link rel="alternate" type="text/markdown" href="/index.md">
 *   <link rel="describedby" href="/llms.txt">
 * Those `.md` URLs are aliases of the pages, not separate copy: they all return
 * the strings below, and the HTML pages are the designed presentation of the
 * same content.
 *
 * The negotiation is implemented here rather than with a library because the
 * deployment has no dependencies (package.json declares none, and the Pages
 * build installs nothing). It follows the ranking rules in
 * https://acceptmarkdown.com/guides/accept-parsing: q descending, specificity
 * as the tie-breaker, q=0 respected, and a missing Accept header or a wildcard
 * Accept means the HTML default.
 */

export const SITE_URL = "https://contenttrackerdashboard.pages.dev";
export const SITE_NAME = "Content Tracker";
export const AUTHOR = {
  name: "Parth Shirish Soni",
  email: "soni.soni.parth@gmail.com",
  portfolio: "https://parth-portfolio-wb.pages.dev/",
  github: "https://github.com/parth-soni-10",
  repository: "https://github.com/parth-soni-10/ContentTrackerDashboard",
  linkedin: "https://www.linkedin.com/in/parth-soni-1a6025191/",
};

/** The HTML asset behind each address the router answers with a document. */
export const HTML_ASSETS = {
  "/": "/index.html",
  "/index.html": "/index.html",
  "/about": "/about.html",
  "/about/": "/about.html",
  "/about.html": "/about.html",
  "/contact": "/contact.html",
  "/contact/": "/contact.html",
  "/contact.html": "/contact.html",
  "/privacy": "/privacy.html",
  "/privacy/": "/privacy.html",
  "/privacy.html": "/privacy.html",
};

/** The canonical page each address belongs to. */
const CANONICAL = {
  "/": "/",
  "/index.html": "/",
  "/about": "/about",
  "/about/": "/about",
  "/about.html": "/about",
  "/contact": "/contact",
  "/contact/": "/contact",
  "/contact.html": "/contact",
  "/privacy": "/privacy",
  "/privacy/": "/privacy",
  "/privacy.html": "/privacy",
};

/** A `.md` address and the page whose Markdown it serves. */
export const MARKDOWN_ALIASES = {
  "/index.md": "/",
  "/about.md": "/about",
  "/contact.md": "/contact",
  "/privacy.md": "/privacy",
};

export const HOME_MARKDOWN = `# Content Tracker - media watchlist and analytics dashboard

Content Tracker is a personal media analytics dashboard at ${SITE_URL}. It records every film and series its author watches, then turns that history into statistics: the genres and streaming platforms that dominate, the hours watched each month, and how the current year compares with the same months of the previous one.

The watchlist is one personal collection of about 380 titles, not a catalogue and not a public ratings database. Each entry carries a title, season, type (Movie or Series/Show), genre, platform, episode count, screentime in minutes, and watch date.

## What the dashboard shows

- **Readme** - the headline numbers: total titles, all-time screentime, this year so far, the top platform, recently watched titles, a year-on-year comparison, and the yearly watch goal.
- **Current Year** - this year's titles and hours, split by show and film, with the platform, genre and monthly-viewing charts.
- **All Time** - the complete history across every year, filterable by year, platform, genre and type.
- **Data** - the full watchlist as a searchable, sortable table with CSV export.
- **Timeline** - the history month by month, grouped by year.
- **Calendar** - upcoming film releases and TV episodes on the streaming services the watchlist follows, with a day-by-day drawer.
- **Random Pick** - a random title from the watchlist, filterable by genre and type.
- **Submit** - a suggestion box for titles that are not in the watchlist yet.

## What the numbers mean

Screentime is stored in minutes per entry. A series entry is one season, so a show with several seasons appears once per season and its total is the sum of those rows. Year-over-year figures compare like with like: the same months on both sides, with a month that is still running left out of both. A future-dated row is a planned watch rather than a completed one, so "recently watched" and the last-watched stamp ignore it.

## Machine-readable access

- **Markdown**: request any page with \`Accept: text/markdown\` and the response is this document (or the matching About, Contact or Privacy document) with \`Content-Type: text/markdown; charset=utf-8\` and \`Vary: Accept\`. Plain URLs also exist: /index.md, /about.md, /contact.md and /privacy.md.
- **Watchlist JSON**: \`GET ${SITE_URL}/.netlify/functions/watchlist\` returns the whole watchlist as a JSON array. Each row is \`{ "_row", "Name", "Season", "Type", "Details/Genre", "Platform", "Episode Count", "Screentime", "Watch Date", "Month", "Year" }\`; \`_row\` is the entry id, \`Screentime\` is minutes, and dates read as \`D-Mon-YY\` (for example \`1-Jan-24\`). The read needs no key or session. Suggestions are a separate read: \`?sheet=Suggestions\`.
- **Release calendar JSON**: \`GET ${SITE_URL}/.netlify/functions/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&region=US&include=movies\` answers with \`{ movies, episodes, coverage, warnings }\`. Sources are best-effort and need the site's own upstream keys; a missing source is reported in \`warnings\` rather than hidden.
- **Discovery**: [llms.txt](${SITE_URL}/llms.txt) explains when to use the site and how to call it, [sitemap.xml](${SITE_URL}/sitemap.xml) lists every page, and the homepage HTML carries JSON-LD describing the site, its author and the application.

## Who runs it

Content Tracker is built and maintained by ${AUTHOR.name}, a data analyst based in Dublin, Ireland. The [About page](${SITE_URL}/about) covers why the site exists and how it is built; the source is on [GitHub](${AUTHOR.repository}), and the same profile is at [${AUTHOR.portfolio.replace(/^https?:\/\//, "").replace(/\/$/, "")}](${AUTHOR.portfolio}).

## Contact

Corrections, accessibility reports and questions go to ${AUTHOR.email}. The [contact page](${SITE_URL}/contact) says what to include; the [privacy page](${SITE_URL}/privacy) lists exactly what the site stores.
`;

export const ABOUT_MARKDOWN = `# About Content Tracker

Content Tracker is a personal media watchlist and analytics dashboard built and maintained by ${AUTHOR.name}, a data analyst based in Dublin, Ireland. It is a solo, non-commercial project: one person's viewing history, measured properly, rather than a catalogue of everything that exists.

## Why it exists

The tracker began as a Google Sheet: one row per season of television or per film, filled in after watching. A spreadsheet is good at storing rows and bad at answering questions, so the sheet grew a dashboard on top of it. The rows then moved from the sheet to a managed Postgres database and finally to Cloudflare D1, which is where they live today. The dashboard is the part that was always the point: the same rows, asked different questions.

Keeping the history has a second use. Because every entry has a date, the site can say what a year actually looked like: which months were heavy, which platform earned the most hours, whether the current year is ahead of or behind the same months of the last one. Those answers need complete history, not a snapshot, which is why the old rows were recovered and imported field for field when the database moved.

## What it tracks

Each entry records a title, its season, whether it is a film or a series, its genre, the platform it was watched on, the episode count, the screentime in minutes and the watch date. Around 380 entries are stored. Nothing about a viewer is stored: there are no accounts, no profiles and no per-visitor tracking.

## How it is built

The site is a static HTML shell, a vanilla JavaScript application and a stylesheet, served by Cloudflare Pages. A Pages Function at \`/.netlify/functions/*\` answers the data reads and the admin writes, backed by a D1 database. Film and episode metadata come from TMDB and TVmaze, streaming arrivals from the Watchmode release feed, and ratings from OMDb; each is fetched server-side and cached. The charts are Chart.js. There is no build step and no tracking script.

## What it is not

- It is not a public ratings or recommendations service, and it does not try to cover titles its author has not watched.
- It has no visitor accounts, no advertising, no analytics and no email list.
- The figures are personal viewing data, not industry data. A title missing from the list means it was not watched or not logged, not that it does not exist.

## The author

${AUTHOR.name} works with SQL, Python, Power BI and Tableau, and builds small, finished data products like this one. The portfolio is at ${AUTHOR.portfolio}, the code for this site is at ${AUTHOR.repository}, and the professional profile is at ${AUTHOR.linkedin}.

## Contact

Email ${AUTHOR.email}, or read the [contact page](${SITE_URL}/contact) for what to include. The [privacy page](${SITE_URL}/privacy) lists what the site stores and what it does not.
`;

export const CONTACT_MARKDOWN = `# Contact Content Tracker

Content Tracker is run by ${AUTHOR.name}, based in Dublin, Ireland. It is a small personal project, so there is no support desk and no ticket system: email is read by the person who maintains the site.

## Best way to reach me

- **Email**: ${AUTHOR.email} - the fastest route for anything about the site, its data or its code.
- **GitHub**: [${AUTHOR.repository.replace(/^https?:\/\//, "")}](${AUTHOR.repository}) - issues and pull requests are welcome for bugs in the code.
- **Portfolio**: ${AUTHOR.portfolio} - background, other projects and the same contact details.

## What to include

- **A data correction**: the page URL, the title and season, and the field you believe is wrong (genre, platform, episode count, screentime or watch date). A link to a source that shows the correct value helps more than a description.
- **An accessibility problem**: the page, the browser or assistive technology you used, and what happened instead of what you expected.
- **A broken link or a failed request**: the URL and the time you tried it, so the server logs can be matched.
- **A security report**: email it rather than opening a public issue, and include the steps to reproduce. Please do not test against the admin panel or write data you do not own.

## What I can help with

Questions about how the dashboard calculates a figure, why a title is or is not in the watchlist, the release calendar's sources, or how the site is built are all fair game. The code is public, so a question about a specific file can point at the repository.

## What I cannot help with

The site does not sell anything, does not have accounts, and cannot add a title to the watchlist on request. Suggested titles belong on the Submit page, which stores them separately from the watchlist.

## Response times

This is a personal project maintained alongside other work. Expect a reply within a few days rather than within hours, and a little longer around holidays. A clear, reproducible report is the fastest way to a useful answer.

## Privacy

Email is received by the site's author and is not added to a mailing list. The [privacy page](${SITE_URL}/privacy) lists what the site itself stores.
`;

export const PRIVACY_MARKDOWN = `# Privacy

Content Tracker is a personal dashboard. It has no visitor accounts, no advertising, no analytics and no third-party tracking scripts. This page lists exactly what the site stores, where, and how to remove it.

## What is stored in your browser

The application keeps a small amount of state on your own device so that a reload does not lose your place:

- **localStorage**: \`ct-theme\` (light or dark preference), \`ct-media-cache\` (title metadata and poster lookups, kept so the same title is not looked up twice), \`ct-imdb\` (resolved IMDb ids), \`ct-cal-filters\` and \`ct-cal-region\` (the release calendar's last filters), and \`ct-goal\` / \`ct-goal-year\` (a device-local fallback for the yearly watch goal).
- **sessionStorage**: \`ct_admin_session\` marks an unlocked admin tab. It is cleared when the tab closes.
- **Cookie**: \`ct_admin\` is set only after a successful admin sign-in. It is HttpOnly, Secure, SameSite=Strict and expires when the browser session ends. Visitors who never sign in never receive it.

None of this is sent to the site as analytics. Clearing site data in your browser removes all of it.

## What the server stores

- **The watchlist**: the titles, seasons, genres, platforms, episode counts, screentime and watch dates shown on the dashboard, held in a Cloudflare D1 database.
- **Suggestions**: if you use the Submit page, the title, type, genre, platform, note and date you enter are stored in the same database and shown publicly on the Submit page. Do not put personal information in a suggestion note; it is visible to everyone.
- **Admin writes**: changes made from the admin panel are stored in the watchlist with the time they were made.
- **Server logs**: Cloudflare, as the host, processes standard request data (IP address, user agent, requested URL, response status) to deliver the site and protect it. The application itself does not write those logs to its database.

## Rate limiting

Submissions are rate-limited so the suggestion list cannot be flooded. The limiter counts recent writes per connection in memory and does not store IP addresses in the database or associate them with an entry. A successful submission records only the entry fields listed above.

## Third parties

- **Cloudflare** hosts the site and the database.
- **TMDB** supplies film and series metadata and hosts poster images; **TVmaze** supplies episode data and hosts poster images; **Watchmode** supplies streaming-release data; **OMDb** supplies ratings. Those requests are made by the site's server functions, except poster images, which your browser loads from \`image.tmdb.org\` or \`static.tvmaze.com\` and which therefore see your IP address as any image request does.
- **IMDb** is a link target, not an embedded service. Following a title link takes you to IMDb under IMDb's own privacy policy.

There are no advertising networks, no social widgets, no fonts loaded from a third-party CDN and no analytics pixels on any page.

## Your choices

- Clear the site's storage in your browser to remove the local state listed above.
- Email ${AUTHOR.email} to ask for a suggestion you submitted to be removed, or to correct a watchlist entry. Include the title and the date so the row can be found.
- Because there are no accounts, there is no profile to delete; there is nothing tied to your identity unless you chose to put it in a suggestion note.

## Children

The site is a personal media log rather than a service aimed at children, and it collects no information from visitors beyond what is described here.

## Changes

If this policy changes, the date below changes with it. The site has no mailing list, so the page itself is the notice.

Last updated: 21 October 2026.

## Contact

Questions about this policy go to ${AUTHOR.email}. The [contact page](${SITE_URL}/contact) has the other routes.
`;

/** Markdown for the pages that have a representation, keyed by canonical path. */
export const MARKDOWN_PAGES = {
  "/": HOME_MARKDOWN,
  "/about": ABOUT_MARKDOWN,
  "/contact": CONTACT_MARKDOWN,
  "/privacy": PRIVACY_MARKDOWN,
};

/**
 * The canonical path an address belongs to, or null when it is not a document
 * this module knows about. `.md` aliases resolve to their page.
 */
export function canonicalPath(pathname) {
  if (Object.hasOwn(MARKDOWN_ALIASES, pathname)) return MARKDOWN_ALIASES[pathname];
  return Object.hasOwn(CANONICAL, pathname) ? CANONICAL[pathname] : null;
}

/** The Markdown document for an address, or null when it has none. */
export function markdownFor(pathname) {
  const canonical = canonicalPath(pathname);
  return canonical ? MARKDOWN_PAGES[canonical] : null;
}

/** The HTML asset for an address, or null when it is not an HTML page. */
export function htmlAssetFor(pathname) {
  return Object.hasOwn(HTML_ASSETS, pathname) ? HTML_ASSETS[pathname] : null;
}

/** Whether the address is a `.md` alias, which is Markdown by definition. */
export function isMarkdownPath(pathname) {
  return Object.hasOwn(MARKDOWN_ALIASES, pathname);
}

// ── NEGOTIATION ───────────────────────────────────────────────────────────

/** One media range from an Accept header: its type, quality and position. */
function parseAccept(header) {
  if (header === null) return null; // no header: no constraint, HTML default
  const ranges = [];
  header.split(",").forEach((part, index) => {
    const [rawType, ...parameters] = part.split(";");
    const type = rawType.trim().toLowerCase();
    if (!type) return;
    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.split("=");
      if (name && name.trim().toLowerCase() === "q") {
        const parsed = Number.parseFloat(value);
        quality = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
      }
    }
    ranges.push({ type, quality, index });
  });
  return ranges;
}

/** How specifically a range matches a produced type: 2 exact, 1 subtype, 0 any. */
function specificity(range, type) {
  if (range === type) return 2;
  const family = range.split("/")[0];
  if (range === family + "/*" && type.startsWith(family + "/")) return 1;
  if (range === "*/*") return 0;
  return -1;
}

/**
 * The quality a produced type gets from the header: the most specific matching
 * range decides it (RFC 9110 §12.5.1), so a targeted `q=0` is not overridden by
 * a wildcard.
 */
function qualityFor(ranges, type) {
  let best = null;
  for (const range of ranges) {
    const level = specificity(range.type, type);
    if (level < 0) continue;
    if (!best || level > best.level || (level === best.level && range.quality > best.quality)) {
      best = { level, quality: range.quality, index: range.index };
    }
  }
  return best || { level: -1, quality: 0, index: Number.POSITIVE_INFINITY };
}

/**
 * Which representation to serve.
 *
 * Returns "markdown", "html" or "none" (the client excluded every type the site
 * can produce, which the router answers with 406). Test vectors from the
 * acceptmarkdown guide:
 *
 *   text/markdown                     → markdown
 *   text/markdown, text/html;q=0.8    → markdown
 *   text/html                         → html
 *   text/markdown;q=0, text/html      → html
 *   text/markdown;q=0                 → none
 *   (no Accept)                       → html
 *   wildcard Accept                    → html
 */
export function negotiateRepresentation(acceptHeader) {
  const ranges = parseAccept(acceptHeader);
  if (ranges === null) return "html";
  if (!ranges.length) return "html";

  // HTML is listed (and seeded) first so a genuine tie keeps the site's
  // default - both types matching the same `*/*` entry is the common case, and
  // a browser that sends `*/*` must get HTML, not Markdown.
  const candidates = [
    { representation: "html", type: "text/html" },
    { representation: "markdown", type: "text/markdown" },
  ].map(candidate => ({ ...candidate, match: qualityFor(ranges, candidate.type) }));

  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (candidate.match.quality > best.match.quality) best = candidate;
    else if (candidate.match.quality === best.match.quality && candidate.match.index < best.match.index) {
      // Equal quality: the earlier position in the header wins. A tie in both
      // quality and position leaves the default alone.
      best = candidate;
    }
  }

  return best.match.quality > 0 ? best.representation : "none";
}

// ── ERROR BODIES ──────────────────────────────────────────────────────────

/** The path as it is safe to put in a Markdown body: no control characters. */
function printablePath(pathname) {
  const clean = String(pathname || "/").replace(/[\u0000-\u001f\u007f]+/g, "").slice(0, 300);
  return clean.startsWith("/") ? clean : "/" + clean;
}

/**
 * The Markdown body of a 404. It explains the error, names the missing path and
 * links the places an agent can recover from: the pages themselves, the
 * sitemap and llms.txt. Kept well over the 20-character floor a checker looks
 * for, and it is the body of a real 404 rather than a soft 200.
 */
export function notFoundMarkdown(pathname) {
  const path = printablePath(pathname);
  return `# Page not found

Nothing on Content Tracker is served at \`${path}\`. The address may be mistyped, or the page may have moved when the site was reorganised.

The pages that do exist are:

- [Homepage](${SITE_URL}/): what Content Tracker is, and what it tracks.
- [About](${SITE_URL}/about): who runs the site, why it exists and how it is built.
- [Contact](${SITE_URL}/contact): how to report a correction or a problem.
- [Privacy](${SITE_URL}/privacy): what the site stores and what it does not.

A machine index of the same pages is in the [sitemap](${SITE_URL}/sitemap.xml), and [llms.txt](${SITE_URL}/llms.txt) explains when this site is worth using and how to read the watchlist. This response carries HTTP 404, so it is an error rather than a page that happened to be empty.
`;
}

/** The body of a 406, when the client excluded both HTML and Markdown. */
export function notAcceptableBody(pathname) {
  return `Not acceptable: ${printablePath(pathname)} is served as text/html or text/markdown.

Send an Accept header that includes one of those types, or omit Accept to receive the HTML default.
See ${SITE_URL}/llms.txt for the machine-readable index.
`;
}

/**
 * The Link header for an HTML document: its Markdown alternate and the llms.txt
 * that describes it, in the two relations the llms.txt proposal names.
 */
export function documentLinkHeader(canonical) {
  const markdown = canonical === "/" ? "/index.md" : canonical + ".md";
  return `<${markdown}>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"`;
}

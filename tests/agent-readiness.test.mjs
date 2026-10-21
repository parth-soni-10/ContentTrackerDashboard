// Agent readiness: the two representations of each page, the 404 contract, and
// the files an agent or a crawler reads before it trusts a site.
//
// The router tests drive `functions/_router.js` directly with a stubbed
// `env.ASSETS`, because the behaviour being checked is the router's: which
// representation each Accept header selects, what the 404 body is, and that
// Vary: Accept rides on every answer that can differ. Nothing here needs a
// network, a database or a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOME_MARKDOWN,
  MARKDOWN_ALIASES,
  MARKDOWN_PAGES,
  SITE_URL,
  markdownFor,
  negotiateRepresentation,
  notFoundMarkdown,
} from "../functions/_documents.js";
import router from "../functions/_router.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = name => readFile(join(root, name), "utf8");

// ── THE ROUTER, WITH A STUBBED ASSET LAYER ────────────────────────────────

/** The published files, as the asset layer would serve them. */
async function publishedAssets() {
  const pages = {
    "/index.html": "index.html",
    "/about.html": "about.html",
    "/contact.html": "contact.html",
    "/privacy.html": "privacy.html",
    "/404.html": "404.html",
  };
  const files = {};
  for (const [pathname, name] of Object.entries(pages)) {
    files[pathname] = { body: await read(name), type: "text/html; charset=utf-8" };
  }
  files["/styles.css"] = { body: await read("styles.css"), type: "text/css; charset=utf-8" };
  files["/llms.txt"] = { body: await read("llms.txt"), type: "text/plain; charset=utf-8" };
  return files;
}

/** The Pages bindings this router needs for a document request. */
function envWith(files) {
  return {
    ASSETS: {
      async fetch(request) {
        const { pathname } = new URL(request.url);
        const file = files[pathname];
        if (!file) {
          return new Response(await read("404.html"), {
            status: 404,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response(file.body, {
          status: 200,
          headers: { "Content-Type": file.type },
        });
      },
    },
  };
}

let assets;
let env;
test.before(async () => {
  assets = await publishedAssets();
  env = envWith(assets);
});

function request(pathname, accept) {
  const headers = {};
  if (accept !== undefined) headers.Accept = accept;
  return new Request(SITE_URL + pathname, { headers });
}

const fetchPath = (pathname, accept) => router.fetch(request(pathname, accept), env);

/** Case-insensitive header read; Headers.get already is, kept explicit. */
const header = (response, name) => response.headers.get(name) || "";

// ── NEGOTIATION ───────────────────────────────────────────────────────────

test("the Accept header decides the representation, with HTML as the default", () => {
  // The vectors published by acceptmarkdown.com's parsing guide.
  const vectors = [
    [null, "html"],
    ["text/markdown", "markdown"],
    ["text/markdown, text/html;q=0.8", "markdown"],
    ["text/html", "html"],
    ["text/markdown;q=0, text/html", "html"],
    ["text/markdown;q=0", "none"],
    ["*/*", "html"],
    [
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "html",
    ],
  ];
  for (const [accept, expected] of vectors) {
    assert.equal(negotiateRepresentation(accept), expected, `Accept: ${accept}`);
  }
});

test("a targeted q=0 is not overridden by a wildcard", () => {
  assert.equal(negotiateRepresentation("text/markdown;q=0, */*"), "html");
  assert.equal(negotiateRepresentation("text/html;q=0, */*"), "markdown");
});

test("the homepage is Markdown for an agent that asks for it", async () => {
  const response = await fetchPath("/", "text/markdown");
  assert.equal(response.status, 200);
  assert.match(header(response, "content-type"), /^text\/markdown;\s*charset=utf-8/i);
  assert.match(header(response, "vary"), /\baccept\b/i);
  const body = await response.text();
  assert.equal(body, HOME_MARKDOWN);
  assert.ok(body.length > 500, `the Markdown homepage is ${body.length} characters`);
  assert.match(body, /^# Content Tracker/);
  assert.ok(body.includes(SITE_URL + "/about"), "it links the About page");
});

test("the homepage is HTML for a browser, and still says it varies by Accept", async () => {
  const response = await fetchPath("/", "text/html");
  assert.equal(response.status, 200);
  assert.match(header(response, "content-type"), /^text\/html/);
  assert.match(header(response, "vary"), /\baccept\b/i);
  const body = await response.text();
  assert.match(body, /<h1[^>]*>/);
  assert.ok(body.length > 1000, "the raw document carries the static content");
});

test("no Accept header and */* both get the HTML default", async () => {
  for (const accept of [undefined, "*/*"]) {
    const response = await fetchPath("/", accept);
    assert.equal(response.status, 200);
    assert.match(header(response, "content-type"), /^text\/html/);
  }
});

test("an HTML page advertises its Markdown alternate and llms.txt", async () => {
  const response = await fetchPath("/about", "text/html");
  const link = header(response, "link");
  assert.match(link, /<\/about\.md>;\s*rel="alternate";\s*type="text\/markdown"/);
  assert.match(link, /<\/llms\.txt>;\s*rel="describedby"/);
});

test("existing Vary values are kept when Accept is added", async () => {
  const files = { ...assets, "/index.html": { ...assets["/index.html"], vary: "Origin" } };
  const envWithOrigin = {
    ASSETS: {
      async fetch(request) {
        const { pathname } = new URL(request.url);
        const file = files[pathname];
        if (!file) return new Response("missing", { status: 404 });
        const headers = { "Content-Type": file.type };
        if (file.vary) headers.Vary = file.vary;
        return new Response(file.body, { status: 200, headers });
      },
    },
  };
  const response = await router.fetch(request("/", "text/html"), envWithOrigin);
  assert.equal(header(response, "vary"), "Origin, Accept");
});

test("the Markdown addresses serve Markdown without negotiation", async () => {
  for (const [pathname, canonical] of Object.entries(MARKDOWN_ALIASES)) {
    for (const accept of [undefined, "text/html"]) {
      const response = await fetchPath(pathname, accept);
      assert.equal(response.status, 200, `${pathname} should exist`);
      assert.match(header(response, "content-type"), /^text\/markdown/, `${pathname} ${accept}`);
      assert.equal(await response.text(), markdownFor(canonical));
    }
  }
});

test("every written page negotiates both ways", async () => {
  for (const path of ["/about", "/contact", "/privacy"]) {
    const html = await fetchPath(path, "text/html");
    assert.equal(html.status, 200, `${path} HTML`);
    assert.match(header(html, "content-type"), /^text\/html/);
    assert.match(header(html, "vary"), /\baccept\b/i);

    const markdown = await fetchPath(path, "text/markdown");
    assert.equal(markdown.status, 200, `${path} Markdown`);
    assert.match(header(markdown, "content-type"), /^text\/markdown/);
    assert.equal(await markdown.text(), MARKDOWN_PAGES[path]);
  }
});

test("a HEAD request gets the headers and no body", async () => {
  const response = await router.fetch(
    new Request(SITE_URL + "/", { method: "HEAD", headers: { Accept: "text/markdown" } }),
    env,
  );
  assert.equal(response.status, 200);
  assert.match(header(response, "content-type"), /^text\/markdown/);
  assert.equal(await response.text(), "");
});

test("a client that excludes both representations is told 406", async () => {
  const response = await fetchPath("/", "text/markdown;q=0");
  assert.equal(response.status, 406);
  assert.match(header(response, "vary"), /\baccept\b/i);
  assert.match(await response.text(), /Not acceptable/);
});

// ── 404 ───────────────────────────────────────────────────────────────────

test("an unknown path is a 404 in Markdown for an agent", async () => {
  const response = await fetchPath("/__ora-404-probe-3ew20eot", "text/markdown");
  assert.equal(response.status, 404, "the status stays 404, not a soft 200");
  assert.match(header(response, "content-type"), /^text\/markdown/);
  assert.match(header(response, "vary"), /\baccept\b/i);
  const body = await response.text();
  assert.ok(body.length >= 20, "the body explains the error");
  assert.match(body, /^# Page not found/);
  assert.ok(body.includes("__ora-404-probe-3ew20eot"), "it names the missing path");
  assert.ok(body.includes(SITE_URL + "/llms.txt"), "it links llms.txt");
  assert.ok(body.includes(SITE_URL + "/sitemap.xml"), "it links the sitemap");
  assert.ok(body.includes(SITE_URL + "/"), "it links the homepage");
});

test("an unknown path stays HTML for a browser, still with Vary: Accept", async () => {
  const response = await fetchPath("/nope");
  assert.equal(response.status, 404);
  assert.match(header(response, "content-type"), /^text\/html/);
  assert.match(header(response, "vary"), /\baccept\b/i);
});

test("an unknown .md address is a Markdown 404 even without an Accept header", async () => {
  const response = await fetchPath("/nope.md");
  assert.equal(response.status, 404);
  assert.match(header(response, "content-type"), /^text\/markdown/);
});

test("the 404 body cannot be injected into by a crafted path", () => {
  const body = notFoundMarkdown("/x\n\n# Injected\u0000");
  assert.ok(!body.includes("\n# Injected"), "newlines are stripped from the path");
  assert.ok(body.includes("x# Injected"), "the path is still named");
});

// ── UNTOUCHED ASSETS ──────────────────────────────────────────────────────

test("a stylesheet is passed through untouched", async () => {
  const response = await fetchPath("/styles.css", "text/markdown");
  assert.equal(response.status, 200);
  assert.match(header(response, "content-type"), /^text\/css/);
  assert.equal(header(response, "vary"), "", "resources that do not vary are not tagged");
});

// ── THE HTML THE CRAWLER READS ────────────────────────────────────────────

const entities = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};

function decode(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => entities[name] ?? match);
}

function textOf(html) {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** The text a reader sees, with scripts, styles and the document head removed. */
function visibleText(html) {
  const body = html.replace(/<head[\s\S]*?<\/head>/gi, " ");
  const withoutCode = body.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, " ");
  return textOf(withoutCode);
}

function headingsOf(html) {
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(match => ({
    level: Number(match[1]),
    text: textOf(match[2]),
  }));
}

function jsonLdOf(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
  return blocks.map(block => JSON.parse(block[1]));
}

test("the homepage serves real content in raw HTML, under one H1", async () => {
  const html = await read("index.html");
  const main = html.match(/<main id="app"[\s\S]*?<\/main>/i);
  assert.ok(main, "there is a <main id=\"app\">");
  const content = visibleText(main[0]);
  assert.ok(content.length >= 500, `the raw homepage carries ${content.length} characters of text`);

  assert.ok(headingsOf(main[0]).length >= 4, "the static introduction has its own headings");
  const all = headingsOf(html);
  assert.equal(all.filter(h => h.level === 1).length, 1, "exactly one H1");
  assert.equal(all[0].level, 1, "the H1 comes first");
  assert.match(all[0].text, /Content Tracker/);
  for (let index = 1; index < all.length; index += 1) {
    assert.ok(
      all[index].level <= all[index - 1].level + 1,
      `heading ${all[index].level} follows ${all[index - 1].level}: ${all[index].text}`,
    );
  }
});

test("the homepage carries Organization, WebSite, Person and SoftwareApplication JSON-LD", async () => {
  const html = await read("index.html");
  const blocks = jsonLdOf(html);
  assert.ok(blocks.length >= 1, "the homepage has JSON-LD");
  const graph = blocks.flatMap(block => block["@graph"] || [block]);
  const ofType = type => graph.filter(node => node["@type"] === type);

  const [organization] = ofType("Organization");
  assert.ok(organization, "Organization is present");
  assert.equal(organization.name, "Content Tracker");
  assert.equal(organization.url, SITE_URL + "/");
  assert.ok(organization.description, "Organization has a description");

  const points = [].concat(organization.contactPoint || []);
  assert.ok(points.length >= 1, "Organization has a contactPoint");
  assert.ok(points.some(point => point.email && point.contactType), "with an email and a contactType");
  assert.equal(organization.address["@type"], "PostalAddress");
  assert.equal(organization.address.addressCountry, "IE");

  assert.ok(ofType("WebSite").length, "WebSite is present");
  assert.ok(ofType("Person").length, "the author is present");
  const [application] = ofType("SoftwareApplication");
  assert.ok(application, "SoftwareApplication is present");
  assert.ok(application.offers && application.offers.price === "0");
  assert.ok(application.featureList.length >= 3);
});

test("the homepage advertises the Markdown alternate and llms.txt", async () => {
  const html = await read("index.html");
  assert.match(html, /<link rel="alternate" type="text\/markdown" href="\/index\.md"/);
  assert.match(html, /<link rel="describedby" href="\/llms\.txt"/);
});

test("the homepage hands over from the static introduction, not from an empty main", async () => {
  const html = await read("index.html");
  assert.match(html, /<html lang="en" class="no-js">/);
  assert.match(await read("theme-init.js"), /classList\.remove\('no-js'\)/);
  assert.match(await read("doc-page.css"), /\.no-js #loading\s*\{\s*display:\s*none/);
});

test("every written page has one H1 and at least 500 characters of content", async () => {
  for (const name of ["about.html", "contact.html", "privacy.html", "404.html"]) {
    const html = await read(name);
    const headings = headingsOf(html);
    assert.equal(headings.filter(h => h.level === 1).length, 1, `${name}: one H1`);
    assert.equal(headings[0].level, 1, `${name}: the H1 comes first`);
    for (let index = 1; index < headings.length; index += 1) {
      assert.ok(
        headings[index].level <= headings[index - 1].level + 1,
        `${name}: heading ${headings[index].level} follows ${headings[index - 1].level}`,
      );
    }
    const content = visibleText(html);
    assert.ok(content.length >= 500, `${name}: ${content.length} characters of content`);
  }
});

test("the 404 page gives a reader a way back", async () => {
  const html = await read("404.html");
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /Page not found/);
  assert.match(html, /href="\/"/);
  assert.match(html, /href="\/llms\.txt"/);
  assert.match(html, /href="\/sitemap\.xml"/);
});

// ── llms.txt, SITEMAP, ROBOTS ─────────────────────────────────────────────

test("llms.txt follows the format and tells an agent when to use the site", async () => {
  const text = await read("llms.txt");
  assert.match(text, /^# Content Tracker\n/);
  assert.match(text, /\n> .+\n/, "a blockquote summary follows the H1");
  assert.match(text, /^## When to use this$/m, "the when-to-use section is an H2");
  assert.match(text, /Do not use Content Tracker/, "it says where the site is the wrong tool");
  for (const path of ["/about", "/contact", "/privacy", "/index.md"]) {
    assert.ok(text.includes(SITE_URL + path), `it links ${path}`);
  }
  assert.ok(text.includes(SITE_URL + "/.netlify/functions/watchlist"), "it names the watchlist endpoint");
  assert.ok(text.includes(SITE_URL + "/.netlify/functions/calendar"), "it names the calendar endpoint");
  assert.ok(text.length > 1000);
});

test("the sitemap lists every page an agent should trust", async () => {
  const xml = await read("sitemap.xml");
  for (const path of ["/", "/about", "/contact", "/privacy"]) {
    assert.ok(xml.includes(`<loc>${SITE_URL}${path}</loc>`), `the sitemap lists ${path}`);
  }
});

test("robots.txt points at the sitemap", async () => {
  const text = await read("robots.txt");
  assert.match(text, /^User-agent: \*$/m);
  assert.match(text, /^Allow: \/$/m);
  assert.ok(text.includes(`Sitemap: ${SITE_URL}/sitemap.xml`));
});

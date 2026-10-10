// ── CONFIG ────────────────────────────────────────────────────────────────
const WATCHLIST_URL = '/.netlify/functions/watchlist';
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const PEMOJI = {
  'Netflix': '🔴',
  'Amazon Prime Video': '🔵',
  'Apple TV+': '⚫',
  'HBO Max': '🟣',
  'Disney+': '🔷',
  'Peacock': '🦚',
  'Hulu': '🟢',
  'Theater': '🎬',
  'Paramount+': '⭐',
  'MUBI': '🎞️'
};

// ── STATE ─────────────────────────────────────────────────────────────────
let rawData = [];
let charts = {};
let curFilters = { platform: 'all', genre: 'all' };
let allFilters = { year: 'all', platform: 'all', genre: 'all' };
let datFilters = { year: 'all', platform: 'all', type: 'all', genre: 'all', month: 'all', search: '' };
let dataSort = { key: 'watchDate', dir: 'desc' };
let dataFiltered = [];
let dataPageNum = 1;
const PER_PAGE = 25;
let dataPerPage = PER_PAGE;   // user-selectable rows per page (25 / 50 / 100 / all)
let suggLastPick = null;
let adminAuthenticated = false;
let adminEditRow = null;
let adminForceAdd = false;   // set by the duplicate warning's "Add anyway"
let adminCleanupRows = [];   // last Database Cleanup scan (rows with no date and no watch time)
let reloading = false;
let loadFailed = false;
let loadRetried = false;
// Shared yearly watch goal (stored server-side so every device sees the same
// target and lock state). goalError carries a transient save-failure message.
let goalState = { hrs: 0, year: '' };
let goalError = '';
let goalReady = Promise.resolve();

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Converts a sheet display date like "29-Aug-26" into the yyyy-mm-dd format
// expected by <input type="date">.
function toISOFromDisplay(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ](\d{2,4})$/);
  if (match) {
    const day = String(Number(match[1])).padStart(2, '0');
    const month = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }[match[2].slice(0, 3)];
    let year = match[3];
    if (year.length === 2) year = (Number(year) > 50 ? '19' : '20') + year;
    return month && year.length === 4 ? `${year}-${month}-${day}` : '';
  }
  const date = new Date(text);
  return isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

// Parses a watch date as a LOCAL midnight Date. Date-only strings ("2026-08-29")
// parsed via new Date() are treated as UTC, which shifts the calendar day for
// anyone outside UTC — the old +1-day display hacks only patched that for
// negative-offset timezones. Parsing the parts directly is correct everywhere.
function parseLocalDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = iso
    ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    : new Date(text);
  return isNaN(date.getTime()) ? null : date;
}

// Returns a sortable timestamp for a sheet watch date, handling the display
// formats the sheet produces ("29-Aug-26", "29 Aug 2026", ISO "2026-08-29",
// etc). Missing/undatable entries return 0 so they sort to the bottom.
function watchDateTimestamp(value) {
  const date = parseLocalDate(value);
  return date ? date.getTime() : 0;
}

// Canonical platform labels so duplicate spellings merge into one bar/group.
const PLATFORM_MAP = {
  'apple tv': 'Apple TV+',
  'apple tv+': 'Apple TV+',
  'amazon prime': 'Amazon Prime Video',
  'amazon prime video': 'Amazon Prime Video',
  'disney plus': 'Disney+',
  'disney+': 'Disney+'
};
function normalizePlatform(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return PLATFORM_MAP[text.toLowerCase()] || text;
}

// Display-level cleanup only — the store keeps whatever was typed. These maps
// merge near-duplicate labels that had crept into the Genre/Type columns (e.g.
// "Sci-Fi" vs "Science Fiction" vs "Sci-Fi & Fantasy"), so the filters, the
// genre treemap and "top genre" finally agree with each other.
const GENRE_MAP = {
  'science fiction':   'Sci-Fi',
  'sci-fi & fantasy':  'Sci-Fi',
  'sitcom':            'Comedy',
  'action/horror':     'Action'
};
function normalizeGenre(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return GENRE_MAP[text.toLowerCase()] || text;
}
const TYPE_MAP = { 'series/show': 'Series', 'series': 'Series', 'show': 'Series', 'shows': 'Series', 'movie': 'Movie' };
function normalizeType(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return TYPE_MAP[text.toLowerCase()] || text;
}
// A few titles were typed entirely in lowercase ("nobod", "challengers"), which
// reads as a typo in a list of Film names. Capitalise those for display without
// rewriting the stored value; anything already carrying a capital is left untouched.
const SMALL_WORDS = new Set(['a','an','and','as','at','but','by','for','from','in','nor','of','on','or','the','to','vs','with']);
function smartCaseName(value) {
  const text = String(value || '');
  if (!text || /[A-Z]/.test(text)) return text;
  return text.split(' ').map((word, i) => {
    if (!word || (i > 0 && SMALL_WORDS.has(word))) return word;
    return word.replace(/[a-z]/, ch => ch.toUpperCase());
  }).join(' ');
}

function initTheme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const apply = () => {
    const dark = document.documentElement.classList.contains('dark');
    btn.setAttribute('aria-pressed', String(dark));
    btn.querySelector('.icon-sun')?.classList.toggle('show', dark);
    btn.querySelector('.icon-moon')?.classList.toggle('show', !dark);
  };
  btn.addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('ct-theme', dark ? 'dark' : 'light'); } catch (e) {}
    apply();
    // Charts resolve their colours from the theme at init and Chart.js can't
    // re-read CSS variables, so rebuild the two pages that own a chart. Form
    // pages are left alone so nothing typed is lost to a surprise re-render.
    const page = window.location.hash.slice(1) || 'readme';
    if (page === 'current' || page === 'alltime') navigateTo(page);
  });
  apply();
}

// Poster + public rating + IMDb id — cached per title to avoid hammering TMDB/OMDB.
// Versioned so a schema change (adding imdbId) triggers one refetch pass, then caches forever.
// `miss` remembers titles the lookup came back without a rating for: those
// never get an imdbId, so without it every re-render re-queried TMDB *and*
// OMDb for the same handful of titles.
const MEDIA_STORE = (() => {
  try {
    const c = JSON.parse(localStorage.getItem('ct-media-cache') || '{}');
    if (c && c.v === 2) return { v: 2, items: c.items || {}, miss: c.miss || {} };
  } catch (e) { /* unreadable or corrupt storage — start from empty */ }
  return { v: 2, items: {}, miss: {} };
})();
const MEDIA_CACHE = MEDIA_STORE.items;
const MEDIA_MISS  = MEDIA_STORE.miss;
function saveMediaCache() { try { localStorage.setItem('ct-media-cache', JSON.stringify({ v: 2, items: MEDIA_CACHE, miss: MEDIA_MISS })); } catch (e) {} }
// Give a title the media API couldn't find a week off before trying again; the
// key is the sheet spelling, so fixing a typo looks the new spelling up at once.
const MEDIA_MISS_TTL = 7 * 24 * 60 * 60 * 1000;
function mediaMissed(key) {
  const at = MEDIA_MISS[key];
  if (!at) return false;
  if (Date.now() - at > MEDIA_MISS_TTL) { delete MEDIA_MISS[key]; saveMediaCache(); return false; }
  return true;
}
function noteMedia(key, meta) {
  // The API's answer for a given title is stable, so a successful lookup that
  // brought no rating means there is nothing more to learn — remember that
  // (poster or not) instead of asking again on every re-render. A later success
  // clears the marker, so a title that gains a rating stops being a miss.
  const rated = Number(meta.rating) > 0;
  if (!rated && !MEDIA_MISS[key]) { MEDIA_MISS[key] = Date.now(); saveMediaCache(); }
  else if (rated && MEDIA_MISS[key]) { delete MEDIA_MISS[key]; saveMediaCache(); }
}
// A broken or missing image can't render the 🎬 itself, so swap it for a span
// that keeps the same box and classes but can.
function posterFallback(el) {
  if (!el) return;
  if (el.tagName === 'IMG') {
    const box = document.createElement('span');
    box.className = el.className + ' placeholder';
    box.textContent = '🎬';
    el.replaceWith(box);
    return;
  }
  el.classList.add('placeholder');
  el.textContent = '🎬';
}
// Read-only star display for a 0-10 rating (IMDb/TMDB scale), plus the number.
function ratingStars(value) {
  const v = Number(value);
  if (!isFinite(v) || v <= 0) return '<span class="rt-na">-</span>';
  const filled = Math.max(0, Math.min(5, Math.round(v / 2)));
  let stars = '';
  for (let i = 1; i <= 5; i++) stars += '<span class="rt-star' + (i <= filled ? ' on' : '') + '">★</span>';
  return '<span class="rt-stars">' + stars + '</span><span class="rt-num">' + (Math.round(v * 10) / 10) + '</span>';
}
function applyRating(key, rating) {
  const nodes = document.querySelectorAll('[data-rk="' + key + '"]');
  for (const el of nodes) el.innerHTML = ratingStars(rating);
  rawData.forEach(r => { if (String(r.name || '').trim().toLowerCase() === key) r.rating = rating; });
}
// Swap a whole name cell (poster + title) from plain text to a link to its
// EXACT IMDb page. No generic search pages — the link only appears once a
// real imdbID arrives.
function applyImdbLink(key, imdbId) {
  if (!imdbId) return;
  const nodes = document.querySelectorAll('[data-tk="' + key + '"]');
  for (const el of nodes) {
    if (el.tagName === 'SPAN') {
      const a = document.createElement('a');
      a.className = 'name-link';
      a.target = '_blank';
      a.rel = 'noopener';
      a.href = 'https://www.imdb.com/title/' + imdbId + '/';
      a.dataset.tk = el.dataset.tk;
      // MOVE the existing children (poster <img> + title text) into the link
      // rather than cloning them, so lookups still in flight for other rows
      // of the same title update the same live img element.
      while (el.firstChild) a.appendChild(el.firstChild);
      el.replaceWith(a);
    } else {
      el.href = 'https://www.imdb.com/title/' + imdbId + '/';
    }
  }
}
// One in-flight lookup per title, shared by every row of that title on the
// page (e.g. Daredevil S1-S3), so a season set costs one API call, not three.
const mediaLookups = {};
async function lookupMedia(key, title) {
  const cached = MEDIA_CACHE[key];
  if (cached && cached.imdbId) return cached;
  // No rating came back for this title before: reuse whatever is cached (the
  // poster, if any) instead of spending another TMDB + OMDb call on it. Without
  // this, every re-render of the table fired those lookups off again.
  if (mediaMissed(key)) return cached || { poster: null, rating: null, imdbId: null };
  if (!mediaLookups[key]) {
    mediaLookups[key] = (async () => {
      try {
        const res = await fetch('/.netlify/functions/tmdb-search?' + new URLSearchParams({ title, light: '1' }), { credentials: 'same-origin' });
        // A 200 with nothing in it is a real "no such title"; a failed request
        // isn't, so only the former is remembered as a miss.
        const data = res.ok ? (await res.json()) : null;
        const meta = { poster: data?.poster || null, rating: Number(data?.rating) || null, imdbId: data?.imdbId || null };
        if (res.ok) noteMedia(key, meta);
        MEDIA_CACHE[key] = meta;
        saveMediaCache();
        return meta;
      } finally {
        delete mediaLookups[key];
      }
    })();
  }
  return mediaLookups[key];
}
async function loadPoster(title, imgEl) {
  const key = String(title || '').trim().toLowerCase();
  if (!key || !imgEl) { posterFallback(imgEl); return; }
  const cached = MEDIA_CACHE[key];
  if (cached && cached.imdbId) {
    applyPoster(imgEl, cached.poster);
    applyRating(key, cached.rating);
    applyImdbLink(key, cached.imdbId);
    return;
  }
  try {
    const meta = await lookupMedia(key, title);
    applyPoster(imgEl, meta.poster);
    applyRating(key, meta.rating);
    applyImdbLink(key, meta.imdbId);
  } catch (e) { posterFallback(imgEl); }
}
function applyPoster(el, url) {
  if (!el) return;
  el.textContent = '';
  if (url) { el.onerror = () => posterFallback(el); el.src = url; }
  else posterFallback(el);
}
// Loads the visible posters with a small concurrency pool — a full page
// (~25 titles) resolves in a few waves instead of one long serial chain,
// while staying gentle on the media APIs.
async function loadVisiblePosters(container) {
  const imgs = container ? Array.from(container.querySelectorAll('img[data-poster]')) : [];
  const CONCURRENCY = 6;
  let next = 0;
  const worker = async () => {
    while (next < imgs.length) {
      const img = imgs[next++];
      await loadPoster(img.dataset.poster, img);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, imgs.length) }, () => worker()));
  // Those lookups also bring ratings in, so keep the coverage readout honest.
  updateRatingStatus();
}

function bindNavigation() {
  document.querySelectorAll('.nav-tab, .nav-brand').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      const page = link.dataset.page || 'readme';
      // Changing the hash lets the single hashchange listener do the render,
      // so a navigation renders exactly once (setting the hash here used to
      // fire hashchange as well and render a second time). Clicking the tab
      // you're already on never fires that event, so render directly.
      if (window.location.hash.slice(1) === page) navigateTo(page);
      else window.location.hash = page;
    });
  });
}

// ── DATA LOADING ──────────────────────────────────────────────────────────
// loadData(skipRerender): normally it re-renders the current page after a
// data refresh. Pass true when you're on a stateful page (the admin form)
// and want to refresh rawData WITHOUT tearing down the DOM and losing form
// state / messages.
// Painted when the very first data fetch fails, so a transient upstream hiccup
// (the data service can be slow to wake) doesn't masquerade as an empty
// dashboard. Retry button + one automatic retry attempt.
function renderDataError() {
  document.getElementById('app').innerHTML =
    '<div class="page-header"><div class="ph-left"><h1>Couldn\'t load your watchlist</h1><p>The watchlist service didn\'t respond.</p></div></div>' +
    '<div class="note-card note-card-wide"><div class="note-icon" aria-hidden="true">⚠️</div><div class="note-body"><strong>The data service is unreachable right now.</strong> This is usually temporary. Give it a moment and try again.</div></div>' +
    '<div class="submit-page"><button class="try-btn btn-wide" id="data-retry" type="button">↻ Retry</button></div>';
  const btn = document.getElementById('data-retry');
  if (btn) {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      loadData();
    });
  }
}

// POST the yearly goal to the shared store; returns the server-confirmed
// { hrs, year } or null on failure.
async function setSharedGoal(hrs, year) {
  try {
    const res = await fetch('/.netlify/functions/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hrs, year })
    });
    const data = res.ok ? await res.json().catch(() => ({})) : null;
    if (data && data.status === 'ok' && data.goal) {
      return { hrs: Number(data.goal.hrs) || 0, year: String(data.goal.year || '') };
    }
  } catch (e) { /* fall through */ }
  return null;
}

// Fetch the shared goal. If the server has none yet but this browser has an
// old local goal, migrate it up once so it starts syncing to other devices.
// If the server can't answer (offline / not configured), fall back to
// whatever this browser last saved locally so the card still works.
async function loadGoal() {
  let serverReachable = false;
  try {
    const res = await fetch(WATCHLIST_URL + '?goal=1', { redirect: 'follow', mode: 'cors', cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.hrs !== 'undefined') {
        goalState = { hrs: Number(data.hrs) || 0, year: String(data.year || '') };
        serverReachable = true;
      }
    }
  } catch (e) { /* fall through to the local fallback */ }
  let localHrs = 0, localYear = '';
  try {
    localHrs = parseFloat(localStorage.getItem('ct-goal') || '0') || 0;
    localYear = String(localStorage.getItem('ct-goal-year') || '');
  } catch (e) {}
  if (!goalState.hrs && localHrs > 0) {
    if (serverReachable) {
      const saved = await setSharedGoal(localHrs, localYear || String(new Date().getFullYear()));
      if (saved) goalState = saved;
    } else {
      goalState = { hrs: localHrs, year: localYear };
    }
  }
}

// ── FAST FIRST PAINT ────────────────────────────────────────────────────
// The last successfully fetched sheet JSON (plus the shared goal) is kept in
// localStorage, so a repeat visit can paint the dashboard instantly from the
// snapshot while the network copy is fetched underneath — the page feels
// immediate even when the backend is cold, then silently corrects itself if
// the data actually changed.
const SNAP_KEY = 'ct-data-snap-v1';

function mapRows(json) {
  return (json || []).map(r => ({
    name:       smartCaseName(r.Name || r.name || ''),
    season:     r.Season     || r.season     || '',
    type:       normalizeType(r.Type || r.type || ''),
    genre:      normalizeGenre(r['Details/Genre'] || r.Genre || r.genre || ''),
    platform:   normalizePlatform(r.Platform   || r.platform   || ''),
    episodes:   parseInt(r['Episode Count'] || r['Episode Count '] || r.episodes || 0) || 0,
    screentime: parseFloat(r.Screentime || r.screentime || 0) || 0,
    // Unify stored date formats into ISO (dd-MMM-yy stays as-is when unparsable).
    watchDate:  toISOFromDisplay(r['Watch Date'] || r.watchDate || '') || (r['Watch Date'] || r.watchDate || ''),
    month:      r.Month      || r.month      || '',
    row:        Number(r._row || r.row || 0),
    year:       parseInt(r.Year || r.year || 0) || 0
  })).filter(r => r.name && r.year > 0);
}

// Cheap signature of the current dataset (rows + goal) used to tell whether a
// network refresh actually changed anything worth repainting.
function dataSignature(rows, goal) {
  goal = goal || goalState;
  let hash = 5381;
  rows.forEach(r => {
    hash = ((hash * 33) ^ (r.row * 131 + (r.name || '').length + (r.watchDate || '').length + (Number(r.screentime) || 0))) >>> 0;
  });
  return hash + ':' + rows.length + ':' + goal.hrs + ':' + goal.year;
}

function saveDataSnapshot(json) {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify({ ts: Date.now(), rows: json, goal: goalState }));
  } catch (e) { /* full/unavailable storage — the snapshot is an optimization only */ }
}

function readDataSnapshot() {
  try {
    const snap = JSON.parse(localStorage.getItem(SNAP_KEY));
    return (snap && Array.isArray(snap.rows) && snap.rows.length) ? snap : null;
  } catch (e) { return null; }
}

// Boot: when a snapshot exists (and this isn't a post-write ?fresh= reload),
// paint it immediately, then refresh from the network underneath — repainting
// only when the data actually changed, and never on stateful pages (admin /
// submit forms) where a surprise re-render would lose what you typed.
async function bootData() {
  const snap = readDataSnapshot();
  if (new URLSearchParams(location.search).get('fresh') || !snap) {
    await loadData(false);
    return;
  }
  const before = mapRows(snap.rows);
  rawData = before;
  if (snap.goal && snap.goal.year) goalState = { hrs: Number(snap.goal.hrs) || 0, year: String(snap.goal.year || '') };
  const beforeSig = dataSignature(before, goalState);
  loadFailed = false;
  document.getElementById('loading').classList.add('hide');
  const page = () => window.location.hash.slice(1) || 'readme';
  const repaintIfChanged = () => {
    if (!loadFailed && dataSignature(rawData) !== beforeSig && page() !== 'admin' && page() !== 'submit') {
      navigateTo(page());
    }
  };
  navigateTo(page()); // instant first paint from the snapshot
  await loadData(true);      // silent refresh underneath
  if (loadFailed) {
    if (!loadRetried) {
      loadRetried = true;
      setTimeout(async () => { await loadData(true); repaintIfChanged(); }, 3500);
    }
    return;
  }
  repaintIfChanged();
}

async function loadData(skipRerender) {
  try {
    goalReady = loadGoal();
    const controller = new AbortController();
    // The CDN normally answers in a blink; give a slow upstream room to
    // finish rather than aborting early, so the fetch surfaces the
    // function's own timeout error instead of a misleading client-side abort.
    const timeout = setTimeout(() => controller.abort(), 45000);
    // A one-shot ?fresh= marker (set by reloadFresh after an admin write)
    // bypasses the CDN cache so the reload shows the write immediately.
    const fresh = new URLSearchParams(location.search).get('fresh');
    const url = fresh ? WATCHLIST_URL + '?fresh=' + encodeURIComponent(fresh) : WATCHLIST_URL;
    const res = await fetch(url, { redirect: 'follow', mode: 'cors', signal: controller.signal, cache: 'default' });
    clearTimeout(timeout);
    if (fresh) {
      try {
        const qs = new URLSearchParams(location.search);
        qs.delete('fresh');
        // location.pathname keeps the marker from lingering when it was the
        // only query param (a fragment-only URL keeps the old query string).
        history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs.toString() : '') + location.hash);
      } catch (e) {}
    }
    if (!res.ok) throw new Error('Data service returned ' + res.status);
    const json = await res.json();
    rawData = mapRows(json);
    loadFailed = false;
    // The goal read is fast (Script Properties, no sheet), so waiting for it
    // here means the readme renders with the synced goal on the first paint.
    await goalReady;
    // Keep a snapshot so the next visit can paint instantly from cache while
    // this fetch refreshes underneath (see bootData).
    saveDataSnapshot(json);
  } catch (e) {
    console.warn('Data load failed:', e);
    // Keep the rows already loaded (the snapshot painted on this visit, or an
    // earlier successful fetch) — a failed background refresh must not blank
    // the dashboard. Only loadFailed flips; that's what the retry logic uses.
    loadFailed = true;
  }
  document.getElementById('loading').classList.add('hide');
  if (skipRerender) return;
  if (loadFailed && !rawData.length) {
    renderDataError();
    if (!loadRetried) {
      loadRetried = true;
      setTimeout(() => { if (loadFailed) loadData(); }, 3500);
    }
    return;
  }
  navigateTo(window.location.hash.slice(1) || 'readme');
}

// ── UTILS ─────────────────────────────────────────────────────────────────
// The real calendar year. Future-dated entries never rebrand it (the This
// Year filters compare against this value), and after 1 January the dashboard
// — and the yearly goal lock — roll over even before the first new entry.
const maxYear = () => new Date().getFullYear();
const fmtHrs   = m  => (m / 60).toFixed(1).replace(/\.0$/, '') + ' hrs';
const fmtK     = n  => n.toLocaleString('en-GB');
const pe       = p  => PEMOJI[p] || '📺';

function uniqueVals(key) {
  return [...new Set(rawData.map(r => r[key]).filter(Boolean))].sort();
}

function filterData(d, f) {
  return d.filter(r =>
    (!f.year     || f.year     === 'all' || r.year     == f.year) &&
    (!f.platform || f.platform === 'all' || r.platform === f.platform) &&
    (!f.genre    || f.genre    === 'all' || r.genre    === f.genre) &&
    (!f.type     || f.type     === 'all' || r.type     === f.type) &&
    (!f.month    || f.month    === 'all' || r.month    === f.month) &&
    (!f.search   || r.name.toLowerCase().includes(f.search.toLowerCase()))
  );
}

function countBy(arr, key) {
  const m = {};
  arr.forEach(r => { const v = r[key] || 'Unknown'; m[v] = (m[v] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function countByMonth(arr) {
  const m = {};
  MONTHS.forEach(mo => m[mo] = 0);
  arr.forEach(r => { if (m[r.month] !== undefined) m[r.month]++; });
  return m;
}

function destroyCharts() {
  Object.values(charts).forEach(c => { try { c.destroy(); } catch (e) {} });
  charts = {};
}

function navigateTo(page) {
  destroyCharts();
  // The calendar keeps work outside the page container: its day drawer lives on
  // <body>, and its auto-update timers would otherwise keep polling from a page
  // nobody is looking at.
  if (page !== 'calendar') { calDropDrawer(); calStopAuto(); }
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  document.getElementById('app').innerHTML = '';
  const pages = { readme: renderReadme, current: renderCurrentYear, alltime: renderAllTime, data: renderData, timeline: renderTimeline, calendar: renderCalendar, suggestions: renderSuggestions, submit: renderSubmit, admin: renderAdmin };
  (pages[page] || renderReadme)();
  document.getElementById('app').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── ADMIN ─────────────────────────────────────────────────────────────────
function renderAdmin() {
  // Keep the admin session across page refreshes (sessionStorage is per-tab,
  // so it survives reloads but is cleared when the tab closes).
  if (!adminAuthenticated && sessionStorage.getItem('ct_admin_session') === '1') adminAuthenticated = true;
  if (!adminAuthenticated) {
    document.getElementById('app').innerHTML = `
      <div class="page-header"><div class="ph-left"><h1>Admin</h1><p>Sign in to add a title directly to the tracker</p></div></div>
      <div class="admin-page"><div class="admin-card">
        <div class="admin-icon" aria-hidden="true">🔒</div>
        <h2>Admin access</h2><p class="submit-sub">Enter the admin password to continue.</p>
        <form id="admin-login-form">
          <div class="sf-field"><label class="sf-lbl" for="admin-password">Password</label><input id="admin-password" name="password" class="sf-input" type="password" autocomplete="current-password" required></div>
          <div id="admin-login-msg" aria-live="polite"></div>
          <button class="sf-submit-btn" type="submit">Unlock Admin</button>
        </form>
      </div></div>`;
    document.getElementById('admin-login-form').addEventListener('submit', async event => {
      event.preventDefault();
      const password = document.getElementById('admin-password').value;
      const message = document.getElementById('admin-login-msg');
      const button = event.currentTarget.querySelector('button[type="submit"]');
      if (!password) return;
      button.disabled = true;
      button.textContent = 'Unlocking…';
      message.textContent = '';
      try {
        const response = await fetch('/.netlify/functions/admin-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ password }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to sign in');
        adminAuthenticated = true;
        sessionStorage.setItem('ct_admin_session', '1');
        renderAdminForm();
      } catch (error) {
        message.innerHTML = `<div class="sf-error">${escapeHTML(error.message)}</div>`;
      } finally {
        button.disabled = false;
        button.textContent = 'Unlock Admin';
      }
    });
    return;
  }
  renderAdminForm();
}

function renderAdminForm() {
  // A fresh form is always create mode: without this, starting an edit,
  // navigating away and coming back would leave adminEditRow set while the
  // form reads "New Watchlist Entry" — the next submit would silently
  // overwrite the old row instead of adding an entry.
  adminEditRow = null;
  const genres = [...new Set(rawData.map(row => row.genre).filter(Boolean))].sort();
  const platforms = [...new Set(rawData.map(row => row.platform).filter(Boolean))].sort();
  const genreOpts = genres.map(genre => `<option value="${escapeHTML(genre)}">${escapeHTML(genre)}</option>`).join('');
  const platOpts = platforms.map(platform => `<option value="${escapeHTML(platform)}">${escapeHTML(platform)}</option>`).join('');

  document.getElementById('app').innerHTML = `
    <div class="page-header"><div class="ph-left"><h1>Admin</h1><p>Add a title directly to the live watchlist</p></div></div>
    <div class="submit-page"><div class="submit-left"><div class="submit-form-card">
      <h2 class="submit-heading" id="admin-form-heading">New Watchlist Entry</h2><p class="submit-sub" id="admin-form-sub">Saved through the protected admin service.</p>
      <form id="admin-entry-form">
        <div class="sf-field"><label class="sf-lbl" for="admin-name">Name <span class="sf-req">*</span></label><div class="admin-name-row"><input id="admin-name" name="name" class="sf-input" maxlength="160" required><button id="admin-check-name" class="try-btn admin-check-btn" type="button">Check watchlist</button><button id="admin-autofill" class="try-btn admin-autofill-btn" type="button">Autofill</button></div><div id="admin-name-result" class="admin-name-result" aria-live="polite"></div></div>
        <div class="sf-row"><div class="sf-field"><label class="sf-lbl" for="admin-type">Type <span class="sf-req">*</span></label><select id="admin-type" name="type" class="sf-input"><option>Movie</option><option>Series/Show</option></select></div><div class="sf-field"><label class="sf-lbl" for="admin-season">Season</label><input id="admin-season" name="season" class="sf-input" maxlength="20"></div></div>
        <div class="sf-row"><div class="sf-field"><label class="sf-lbl" for="admin-genre">Genre</label><select id="admin-genre" name="genre" class="sf-input"><option value="">Select genre</option>${genreOpts}<option value="Other">Other</option></select><input id="admin-genre-custom" class="sf-input sf-custom-value" type="text" maxlength="80" placeholder="Enter a genre" aria-label="Custom genre" hidden></div><div class="sf-field"><label class="sf-lbl" for="admin-platform">Platform</label><select id="admin-platform" name="platform" class="sf-input"><option value="">Select platform</option>${platOpts}<option value="Other">Other</option></select><input id="admin-platform-custom" class="sf-input sf-custom-value" type="text" maxlength="160" placeholder="Enter a platform" aria-label="Custom platform" hidden></div></div>
        <div class="sf-row"><div class="sf-field"><label class="sf-lbl" for="admin-episodes">Episodes</label><input id="admin-episodes" name="episodes" class="sf-input" type="number" min="0" max="9999" inputmode="numeric"></div><div class="sf-field"><label class="sf-lbl" for="admin-screentime">Screentime (mins)</label><input id="admin-screentime" name="screentime" class="sf-input" type="number" min="0" max="100000" inputmode="numeric"></div></div>
        <div class="sf-field"><label class="sf-lbl" for="admin-date">Watch Date</label><input id="admin-date" name="watchDate" class="sf-input" type="date"></div>
        <div id="admin-edit-bar" class="admin-edit-bar" hidden><span>Editing entry <strong id="admin-edit-row"></strong></span><button class="try-btn admin-edit-cancel" id="admin-cancel-edit" type="button">Cancel edit</button></div>
        <div id="admin-entry-msg" aria-live="polite"></div><button class="sf-submit-btn" type="submit" id="admin-submit-btn">Add to Watchlist</button>
      </form>
    </div>
    <div class="submit-form-card">
      <h2 class="submit-heading">Edit Existing Entry</h2>
      <p class="submit-sub">Search the tracker, then click <strong>Edit</strong> to load a title into the form above.</p>
      <input id="admin-edit-search" class="sf-input" type="text" aria-label="Search by title" placeholder="Search by title…" autocomplete="off">
      <div id="admin-edit-results" class="admin-edit-results" aria-live="polite"></div>
    </div>
    <div class="submit-form-card">
      <h2 class="submit-heading">Duplicate Checker</h2>
      <p class="submit-sub">Automatically scans the tracker for entries that look like the same thing was logged twice. Runs every time this page opens.</p>
      <div id="admin-dup-results" class="admin-dup-results" aria-live="polite"></div>
    </div>
    <div class="submit-form-card">
      <h2 class="submit-heading">Database Cleanup</h2>
      <p class="submit-sub">Finds stored rows with no watch date and 0 minutes — rows the rest of the site never shows. Delete them to keep the database clean.</p>
      <button class="try-btn admin-clean-btn" id="admin-clean-scan" type="button">Scan for invalid rows</button>
      <div id="admin-clean-msg" aria-live="polite"></div>
      <div id="admin-clean-results" class="admin-clean-results" aria-live="polite"></div>
    </div></div><div class="submit-right"><div class="note-card"><div class="note-icon" aria-hidden="true">💡</div><div class="note-body"><strong>Protected entry</strong>The password is checked server-side and never leaves this site.</div></div><button class="try-btn" id="admin-lock" type="button">Lock Admin</button></div></div>`;
  document.getElementById('admin-entry-form').addEventListener('submit', submitAdminEntry);
  ['genre', 'platform'].forEach(key => {
    const select = document.getElementById('admin-' + key);
    const custom = document.getElementById('admin-' + key + '-custom');
    select.addEventListener('change', () => {
      custom.hidden = select.value !== 'Other';
      if (select.value === 'Other') custom.focus();
    });
  });
  document.getElementById('admin-check-name').addEventListener('click', checkAdminName);
  document.getElementById('admin-autofill').addEventListener('click', autofillAdminEntry);
  document.getElementById('admin-lock').addEventListener('click', () => { adminAuthenticated = false; sessionStorage.removeItem('ct_admin_session'); renderAdmin(); });
  document.getElementById('admin-edit-search').addEventListener('input', event => renderAdminEditResults(event.target.value));
  document.getElementById('admin-edit-results').addEventListener('click', event => {
    const del = event.target.closest('.admin-del-btn');
    if (del) { deleteAdminEntry(Number(del.dataset.row), del); return; }
    const button = event.target.closest('.admin-edit-btn');
    if (button) startAdminEdit(Number(button.dataset.row));
  });
  document.getElementById('admin-cancel-edit').addEventListener('click', cancelAdminEdit);
  document.getElementById('admin-clean-scan').addEventListener('click', scanInvalidRows);
  document.getElementById('admin-clean-results').addEventListener('click', event => {
    const del = event.target.closest('.admin-clean-del');
    if (del) deleteInvalidRow(Number(del.dataset.row), del);
  });
  const dupResults = document.getElementById('admin-dup-results');
  dupResults.addEventListener('click', event => {
    const del = event.target.closest('.dup-del-btn');
    if (del) { deleteAdminEntry(Number(del.dataset.row), del); return; }
    const groupBtn = event.target.closest('.dup-group-btn');
    if (groupBtn) removeDupCopies(Number(groupBtn.dataset.group), groupBtn);
  });
  renderDuplicateScan();
}

function renderAdminEditResults(query) {
  const container = document.getElementById('admin-edit-results');
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    container.innerHTML = '<div class="admin-edit-empty">Type to search your tracker…</div>';
    return;
  }
  const matches = rawData
    .filter(item => item.name.toLowerCase().includes(q))
    .slice(0, 10);
  if (!matches.length) {
    container.innerHTML = '<div class="admin-edit-empty">No titles match "' + escapeHTML(query.trim()) + '".</div>';
    return;
  }
  container.innerHTML = matches.map(item => {
    const meta = [escapeHTML(item.type), item.season ? 'S' + escapeHTML(item.season) : '', item.year].filter(Boolean).join(' · ');
    return '<div class="admin-edit-item">' +
      '<div class="admin-edit-info"><div class="admin-edit-name">' + escapeHTML(item.name) + '</div>' +
      (meta ? '<div class="admin-edit-meta">' + meta + '</div>' : '') + '</div>' +
      '<div class="admin-edit-actions">' +
        '<button class="try-btn admin-edit-btn" type="button" data-row="' + item.row + '">Edit</button>' +
        '<button class="try-btn admin-del-btn" type="button" data-row="' + item.row + '">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function startAdminEdit(rowNumber) {
  const item = rawData.find(item => item.row === rowNumber);
  if (!item) return;
  adminEditRow = rowNumber;

  const setSelect = (selectId, value) => {
    const select = document.getElementById(selectId);
    if (!value) { select.value = ''; return; }
    if (!Array.from(select.options).some(option => option.value === String(value))) {
      select.add(new Option(String(value), String(value)));
    }
    select.value = String(value);
  };

  document.getElementById('admin-name').value = item.name;
  setSelect('admin-type', item.type);
  document.getElementById('admin-season').value = item.season || '';
  setSelect('admin-genre', item.genre);
  setSelect('admin-platform', item.platform);
  document.getElementById('admin-episodes').value = item.episodes || 0;
  document.getElementById('admin-screentime').value = item.screentime || 0;
  document.getElementById('admin-date').value = toISOFromDisplay(item.watchDate);

  document.getElementById('admin-form-heading').textContent = 'Edit Entry';
  document.getElementById('admin-form-sub').textContent = 'Editing entry #' + rowNumber + '. Changes are saved to the watchlist.';
  document.getElementById('admin-edit-row').textContent = rowNumber;
  document.getElementById('admin-edit-bar').hidden = false;
  document.getElementById('admin-submit-btn').textContent = 'Update Entry';
  document.getElementById('admin-entry-msg').textContent = '';
  document.getElementById('admin-entry-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelAdminEdit() {
  adminEditRow = null;
  document.getElementById('admin-entry-form').reset();
  document.getElementById('admin-form-heading').textContent = 'New Watchlist Entry';
  document.getElementById('admin-form-sub').textContent = 'Saved through the protected admin service.';
  document.getElementById('admin-edit-bar').hidden = true;
  document.getElementById('admin-submit-btn').textContent = 'Add to Watchlist';
  document.getElementById('admin-entry-msg').textContent = '';
}

async function deleteAdminEntry(rowNumber, button) {
  const item = rawData.find(r => r.row === rowNumber);
  const label = item ? item.name : 'this entry';
  if (!window.confirm('Delete "' + label + '" from the watchlist? This cannot be undone.')) return;
  if (button) { button.disabled = true; button.textContent = 'Deleting…'; }
  // The element disappears if the user navigates mid-request; writing to a
  // stand-in object is then a harmless no-op instead of a TypeError.
  const msg = () => document.getElementById('admin-entry-msg') || { innerHTML: '' };
  try {
    const result = await requestAdminDelete(rowNumber);
    if (result === null) return; // session expired — the login screen is already up
    // Reload the whole page so the deletion is reflected everywhere.
    msg().innerHTML = `<div class="sf-success">Entry deleted${result.rowNumber ? ' (#' + escapeHTML(result.rowNumber) + ')' : ''}. Reloading…</div>`;
    reloading = true;
    setTimeout(() => reloadFresh(), 900);
  } catch (error) {
    msg().innerHTML = `<div class="sf-error">${escapeHTML(error.message)}</div>`;
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Delete'; }
  }
}

// Posts a single-row delete to the admin service. Resolves with the parsed
// result, throws an Error on a failed request, and returns null when the admin
// session has expired (the login screen is already up — stop and wait).
async function requestAdminDelete(rowNumber) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch('/.netlify/functions/admin-entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'delete', row: rowNumber }), signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401 && result.code === 'SESSION_INVALID') {
      expireAdminSession('Your admin session has ended.');
      return null;
    }
    if (!response.ok) {
      throw new Error((result.error || 'Unable to delete entry') + (result.code ? ` [${result.code}]` : ''));
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// Server-side sessions can end (cookie cleared, secret rotated, 30-day cap), so
// an admin write may come back 401 even though sessionStorage still says
// "logged in". Drop the flag and put the login form back up instead of leaving
// the user stuck behind a dead session.
// After an admin write the reload must skip the Netlify CDN copy so it hits
// the store directly and shows the write immediately.
// The ?fresh= marker is one-shot: loadData strips it after fetching.
function reloadFresh() {
  try {
    const qs = new URLSearchParams(location.search);
    qs.set('fresh', String(Date.now()));
    history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs.toString() : '') + location.hash);
  } catch (e) {}
  window.location.reload();
}

function expireAdminSession(reason) {
  adminAuthenticated = false;
  adminEditRow = null;
  reloading = false;
  try { sessionStorage.removeItem('ct_admin_session'); } catch (e) {}
  renderAdmin();
  const box = document.getElementById('admin-login-msg');
  if (box && reason) box.innerHTML = `<div class="sf-error">${escapeHTML(reason)} Please sign in again.</div>`;
}

// ── ADD-TIME DUPLICATE CHECK ──────────────────────────────────────────────
// The gate every create passes through before it is allowed anywhere near the
// network. Two tiers, because the tracker deliberately allows a rewatch:
//   * exact  — same title, kind, season, watch date AND screentime: certainly
//              the same row logged twice, so the add is refused outright and no
//              override is offered.
//   * exists — same title, kind and season but not an exact repeat (another
//              date, or the same date saved with different details): the title
//              is already in the list, so the add stops and says so either way;
//              "Add anyway" is the deliberate override for the genuine rewatch
//              that the Duplicate Checker below also declines to call an error.
// Title, season and date all go through the same keys the checker uses
// (dupNormTitle/dupSeasonKey/dupDateKey), so "S2", "Season 2" and "2" agree and
// casing or spacing can never hide a match. The check this replaced demanded an
// identical screentime, compared seasons as raw text and ignored the media
// type: it missed "S2" vs "2", let a same-named movie and series collide, and
// waved through a rewatch without a word.
function adminDuplicateCheck(payload) {
  const found = { exact: [], exists: [] };
  const name = dupNormTitle(payload.name);
  if (!name) return found;
  const kind = dupKind(payload.type);
  const season = dupSeasonKey(payload.season);
  const date = dupDateKey(payload.watchDate);
  const screentime = Number(payload.screentime) || 0;
  rawData.forEach(item => {
    if (dupNormTitle(item.name) !== name) return;
    if (dupKind(item.type) !== kind) return;
    if (dupSeasonKey(item.season) !== season) return;
    if (dupDateKey(item.watchDate) === date && (Number(item.screentime) || 0) === screentime) found.exact.push(item);
    else found.exists.push(item);
  });
  return found;
}

function adminDuplicateRow(item) {
  const bits = [];
  if (item.watchDate) bits.push('watched ' + dupFmtDate(item.watchDate));
  if (item.episodes) bits.push(item.episodes + ' eps');
  if (item.screentime) bits.push(item.screentime + ' mins');
  if (item.platform) bits.push(item.platform);
  return '<div class="admin-dup-line"><strong>Row ' + escapeHTML(String(item.row)) + '</strong>' +
    '<span>' + escapeHTML(bits.join(' · ') || 'existing entry') + '</span></div>';
}

// The warning that stands in for the save: what already exists, and — only when
// the match is a same-title-different-date one — the deliberate override.
function renderAdminDuplicateWarning(payload, found) {
  const msg = document.getElementById('admin-entry-msg');
  if (!msg) return;
  const season = dupSeasonKey(payload.season);
  const kind = dupKind(payload.type) === 'movie' ? 'Movie' : 'Series/Show';
  const what = escapeHTML(String(payload.name || '').trim()) +
    ' <span class="admin-dup-kind">(' + escapeHTML(kind) + (season ? ' · Season ' + escapeHTML(season) : '') + ')</span>';
  const rows = found.exact.concat(found.exists).map(adminDuplicateRow).join('');
  // The "exists" tier is everything that is not an exact repeat, so name the two
  // cases it can be: a different date (a rewatch) or the same date saved with
  // different details (a second viewing) — never claim a date difference that
  // isn't there.
  const sameDate = !found.exact.length && dupDateKey(payload.watchDate) &&
    found.exists.every(item => dupDateKey(item.watchDate) === dupDateKey(payload.watchDate));
  const tail = found.exact.length
    ? 'This exact entry — same watch date and screentime — is already saved. Find it in the search below to edit or delete it.'
    : (sameDate
      ? 'Already saved on this date with different details, so this may be a second viewing. Add it anyway to log it again.'
      : 'Logged on a different date, so this may be a rewatch. Add it anyway to log it again.');
  msg.innerHTML = '<div class="sf-error admin-dup-stop"><strong>Already in your watchlist — nothing was added.</strong>' +
    '<div class="admin-dup-what">' + what + '</div>' + rows +
    '<div class="admin-dup-tail">' + tail + '</div>' +
    (found.exact.length ? '' : '<button class="try-btn admin-dup-force" id="admin-dup-force" type="button">Add anyway</button>') +
    '</div>';
  const force = document.getElementById('admin-dup-force');
  if (force) force.addEventListener('click', () => {
    adminForceAdd = true;
    const form = document.getElementById('admin-entry-form');
    if (form) form.requestSubmit();
  });
}

// ── DUPLICATE CHECKER ────────────────────────────────────────────────────
// Entries are "the same thing" when their title (case/space insensitive), kind
// (movie vs show) and season agree. Within such a group, rows sharing the same
// watch date are near-certain double-logs; rows on different dates are only
// surfaced for review, because a genuine rewatch looks identical.
let dupScanGroups = [];

function dupNormTitle(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function dupKind(value) {
  return String(value || '').toLowerCase().includes('movie') ? 'movie' : 'show';
}

// 'S1', 's 01', 'Season 1' and '01' all describe season one.
function dupSeasonKey(value) {
  let text = String(value || '').trim().toLowerCase()
    .replace(/^season\s*/, '')
    .replace(/^series\s*/, '')
    .replace(/^#\s*/, '');
  if (/^s\s*\d/.test(text)) text = text.slice(1).trim();
  const number = Number(text);
  return text && Number.isInteger(number) ? String(number) : text;
}

// Canonical yyyy-mm-dd so differently formatted representations compare equal.
function dupDateKey(value) {
  return toISOFromDisplay(value) || String(value || '').trim().toLowerCase();
}

function dupFmtDate(value) {
  const dt = parseLocalDate(value);
  return dt ? dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : String(value || '-');
}

// Groups rows by name+kind+season, flags later rows that repeat an earlier
// row's watch date as duplicate copies, and returns the suspicious groups
// (those with more than one member), ordered by title.
function scanDuplicates(rows) {
  const byKey = new Map();
  rows.forEach(item => {
    const key = dupKind(item.type) + '|' + dupSeasonKey(item.season) + '|' + dupNormTitle(item.name);
    if (!byKey.has(key)) byKey.set(key, { name: item.name, seasonLabel: item.season || '', rows: [] });
    byKey.get(key).rows.push(item);
  });
  const groups = [];
  byKey.forEach(group => {
    if (group.rows.length < 2) return;
    group.rows.sort((a, b) => a.row - b.row);
    const firstRowOfDate = new Map();
    group.rows.forEach(item => {
      const dateKey = dupDateKey(item.watchDate);
      item._dupCopy = Boolean(dateKey) && firstRowOfDate.has(dateKey);
      item._dupOf = item._dupCopy ? firstRowOfDate.get(dateKey) : 0;
      if (dateKey && !firstRowOfDate.has(dateKey)) firstRowOfDate.set(dateKey, item.row);
    });
    groups.push(group);
  });
  return groups.sort((a, b) => dupNormTitle(a.name).localeCompare(dupNormTitle(b.name)));
}

function renderDuplicateScan() {
  const container = document.getElementById('admin-dup-results');
  if (!container) return;
  dupScanGroups = scanDuplicates(rawData);

  const renderGroup = (group, index) => {
    const hasCopies = group.rows.some(r => r._dupCopy);
    const copyCount = hasCopies ? group.rows.filter(r => r._dupCopy).length : 0;
    const season = group.seasonLabel ? ' · ' + escapeHTML(group.seasonLabel) : '';
    const head = '<div class="dup-group-head"><span class="dup-group-title">' + escapeHTML(group.name) + season + '</span>' +
      '<span class="dup-group-meta">' + escapeHTML(String(group.rows[0].type)) + ' · ' + group.rows.length + ' entries</span>' +
      (copyCount ? '<button class="try-btn dup-group-btn" type="button" data-group="' + index + '">Remove ' + copyCount + ' duplicate cop' + (copyCount > 1 ? 'ies' : 'y') + '</button>' : '') +
      '</div>';
    const rowHTML = group.rows.map(row => {
      const desc = dupFmtDate(row.watchDate) + ' · ' + (Number(row.screentime) || 0) + ' min · #' + row.row;
      const tag = row._dupCopy
        ? '<span class="dup-tag copy">duplicate of #' + row._dupOf + '</span>'
        : (hasCopies ? '<span class="dup-tag keep">keep</span>' : '');
      const del = row._dupCopy
        ? '<button class="try-btn admin-del-btn dup-del-btn" type="button" data-row="' + row.row + '">Remove</button>'
        : '';
      return '<div class="dup-row">' + tag + '<span>' + escapeHTML(desc) + '</span>' + del + '</div>';
    }).join('');
    return '<div class="dup-group">' + head + rowHTML + '</div>';
  };

  // Split the groups by whether they contain flagged copies, keeping the real
  // dupScanGroups index on each group's button for removeDupCopies.
  const hard = [], review = [];
  dupScanGroups.forEach((group, index) => {
    const html = renderGroup(group, index);
    (group.rows.some(r => r._dupCopy) ? hard : review).push(html);
  });

  if (!hard.length && !review.length) {
    container.innerHTML = '<div class="dup-clear">✓ No duplicates found. ' + rawData.length + ' entries scanned.</div>';
    return;
  }

  container.innerHTML =
    (hard.length ? '<div class="dup-sub">' + hard.length + ' group' + (hard.length > 1 ? 's' : '') + ' with duplicate copies</div>' : '') +
    hard.join('') +
    (review.length ? '<div class="dup-sub">Review: same title logged on different dates (a rewatch, or a wrong date)</div>' : '') +
    review.join('');
}

// Removes every flagged copy of one group, top row first so the row numbers of
// the remaining copies stay valid, then reloads so the watchlist is rescanned.
async function removeDupCopies(groupIndex, button) {
  const group = dupScanGroups[groupIndex];
  if (!group) return;
  const copies = group.rows.filter(row => row._dupCopy);
  if (!copies.length) return;
  const label = group.name + (group.seasonLabel ? ' · ' + group.seasonLabel : '');
  if (!window.confirm('Remove ' + copies.length + ' duplicate cop' + (copies.length > 1 ? 'ies' : 'y') + ' of "' + label + '"? The first entry is kept. This cannot be undone.')) return;
  const originalLabel = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = 'Removing…'; }
  // The element disappears if the user navigates mid-request; writing to a
  // stand-in object is then a harmless no-op instead of a TypeError.
  const msg = () => document.getElementById('admin-entry-msg') || { innerHTML: '' };
  try {
    for (const copy of copies.slice().sort((a, b) => b.row - a.row)) {
      const result = await requestAdminDelete(copy.row);
      if (result === null) return; // session expired — the login screen is already up
    }
    msg().innerHTML = '<div class="sf-success">Removed ' + copies.length + ' duplicate cop' + (copies.length > 1 ? 'ies' : 'y') + ' of "' + escapeHTML(label) + '". Reloading…</div>';
    reloading = true;
    setTimeout(() => reloadFresh(), 900);
  } catch (error) {
    msg().innerHTML = '<div class="sf-error">' + escapeHTML(error.message) + '. Some copies may already be removed. Reload the page to rescan.</div>';
  } finally {
    if (button) { button.disabled = false; button.textContent = originalLabel; }
  }
}

// ── DATABASE CLEANUP ──────────────────────────────────────────────────────
// The stored rows this page cannot otherwise reach: mapRows drops every row
// whose year reads as 0, so a row with no watch date and no watch time exists
// in the database but in no list, chart or search on the site. The scan reads
// the table itself (ids and timestamps included) and deleting here uses the
// same verified single-row delete as everywhere else. The row leaves the
// rendered list in place — nothing else on the page ever showed it, so no
// reload is needed.
async function scanInvalidRows() {
  const container = document.getElementById('admin-clean-results');
  const message = document.getElementById('admin-clean-msg');
  const button = document.getElementById('admin-clean-scan');
  if (!container || !button) return;
  button.disabled = true;
  button.textContent = 'Scanning…';
  message.textContent = '';
  try {
    const response = await fetch('/.netlify/functions/admin-entry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ action: 'invalid' })
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401 && result.code === 'SESSION_INVALID') {
      expireAdminSession('Your admin session has ended.');
      return;
    }
    if (!response.ok) throw new Error(result.error || 'Unable to scan for invalid rows');
    adminCleanupRows = Array.isArray(result.rows) ? result.rows : [];
    renderInvalidRows();
  } catch (error) {
    message.innerHTML = '<div class="sf-error">' + escapeHTML(error.message) + '</div>';
    container.innerHTML = '';
  } finally {
    // Re-read: the session-expired path replaces the whole page.
    const stale = document.getElementById('admin-clean-scan');
    if (stale) { stale.disabled = false; stale.textContent = 'Scan for invalid rows'; }
  }
}

function renderInvalidRows() {
  const container = document.getElementById('admin-clean-results');
  if (!container) return;
  if (!adminCleanupRows.length) {
    container.innerHTML = '<div class="clean-clear">✓ No invalid rows found. The database is clean.</div>';
    return;
  }
  const cell = value => escapeHTML(value === '' || value == null ? '—' : String(value));
  const added = value => value ? escapeHTML(String(value).slice(0, 19).replace('T', ' ')) : '—';
  const rows = adminCleanupRows.map(row =>
    '<tr>' +
      '<td class="clean-id">#' + escapeHTML(String(row.id)) + '</td>' +
      '<td class="clean-name">' + escapeHTML(row.name) + '</td>' +
      '<td>' + cell(row.season) + '</td>' +
      '<td>' + cell(row.type) + '</td>' +
      '<td>' + cell(row.genre) + '</td>' +
      '<td>' + cell(row.platform) + '</td>' +
      '<td>' + escapeHTML(String(row.episodes)) + '</td>' +
      '<td>' + escapeHTML(String(row.screentime)) + '</td>' +
      '<td class="clean-null">' + (row.watchDate ? escapeHTML(row.watchDate) : 'null') + '</td>' +
      '<td class="clean-added">' + added(row.createdAt) + '</td>' +
      '<td><button class="try-btn admin-del-btn admin-clean-del" type="button" data-row="' + escapeHTML(String(row.id)) + '">Delete</button></td>' +
    '</tr>'
  ).join('');
  container.innerHTML =
    '<div class="clean-sub">' + adminCleanupRows.length + ' invalid row' + (adminCleanupRows.length === 1 ? '' : 's') + ' — no watch date and 0 minutes</div>' +
    '<div class="clean-table-wrap"><table class="clean-table"><thead><tr>' +
      '<th>ID</th><th>Name</th><th>Season</th><th>Type</th><th>Genre</th><th>Platform</th>' +
      '<th>Eps</th><th>Mins</th><th>Watch date</th><th>Added (UTC)</th><th></th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

async function deleteInvalidRow(rowNumber, button) {
  const row = adminCleanupRows.find(item => item.id === rowNumber);
  const label = row ? '"' + row.name + '"' : 'this row';
  if (!window.confirm('Delete row #' + rowNumber + ' (' + label + ') from the database? This cannot be undone.')) return;
  const originalLabel = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = 'Deleting…'; }
  // The card can be replaced mid-request (session expiry rebuilds the page); a
  // missing message area is then a harmless no-op instead of a TypeError.
  const msg = () => document.getElementById('admin-clean-msg') || { innerHTML: '' };
  try {
    const result = await requestAdminDelete(rowNumber);
    if (result === null) return; // session expired — the login screen is already up
    adminCleanupRows = adminCleanupRows.filter(item => item.id !== rowNumber);
    renderInvalidRows();
    msg().innerHTML = '<div class="sf-success">Deleted row #' + escapeHTML(String(rowNumber)) +
      (row ? ' (' + escapeHTML(row.name) + ')' : '') + '. ' +
      (adminCleanupRows.length
        ? adminCleanupRows.length + ' invalid row' + (adminCleanupRows.length === 1 ? '' : 's') + ' left.'
        : 'The database is clean.') + '</div>';
  } catch (error) {
    msg().innerHTML = '<div class="sf-error">' + escapeHTML(error.message) + '</div>';
    if (button) { button.disabled = false; button.textContent = originalLabel; }
  }
}

async function checkAdminName() {
  const input = document.getElementById('admin-name');
  const result = document.getElementById('admin-name-result');
  const button = document.getElementById('admin-check-name');
  const name = input.value.trim();
  if (!name) { result.textContent = 'Enter a title name first.'; input.focus(); return; }
  button.disabled = true;
  button.textContent = 'Checking…';
  result.textContent = '';
  try {
    if (!rawData.length) await loadData(true);
    if (loadFailed) throw new Error('watchlist unreachable');
    const query = name.toLowerCase();
    const matches = rawData.filter(item => item.name.toLowerCase().includes(query));
    if (!matches.length) {
      result.className = 'admin-name-result available';
      result.textContent = 'No matching title found. This title can be added.';
    } else {
      result.className = 'admin-name-result found';
      const details = matches.map((item, index) => {
        const season = item.season ? `Season ${escapeHTML(item.season)}` : '';
        const type = item.type ? escapeHTML(item.type) : '';
        const year = item.year ? escapeHTML(item.year) : '';
        const meta = [type, season, year].filter(Boolean).join(' · ');
        return `<div class="admin-match"><strong>Match ${index + 1}</strong><span>${meta || 'Existing entry'}</span></div>`;
      }).join('');
      result.innerHTML = `<div>Found ${matches.length} matching entr${matches.length === 1 ? 'y' : 'ies'} in the watchlist.</div>${details}`;
    }
  } catch {
    result.className = 'admin-name-result found';
    result.textContent = 'Could not check the watchlist. Try again.';
  } finally {
    button.disabled = false;
    button.textContent = 'Check watchlist';
  }
}

async function autofillAdminEntry() {
  const nameInput = document.getElementById('admin-name');
  const seasonInput = document.getElementById('admin-season');
  const result = document.getElementById('admin-name-result');
  const button = document.getElementById('admin-autofill');
  const name = nameInput.value.trim();
  const season = seasonInput.value.trim();
  if (!name) { result.textContent = 'Enter a title name first.'; nameInput.focus(); return; }
  button.disabled = true;
  button.innerHTML = '<span class="autofill-spinner" aria-hidden="true"></span> Searching…';
  result.className = 'admin-name-result';
  result.textContent = 'Searching TMDB and preparing details…';
  try {
    const query = new URLSearchParams({ title: name });
    if (season) query.set('season', season);
    const response = await fetch('/.netlify/functions/tmdb-search?' + query.toString(), { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not find this title');
    const fields = { 'admin-name': data.name || name, 'admin-type': data.type || 'Movie', 'admin-season': data.season || (data.type === 'Movie' ? '' : season || '1'), 'admin-genre': String(data.genre || 'Uncategorized').split(',')[0].trim(), 'admin-platform': String(data.platform || 'Unknown platform').split(',')[0].trim(), 'admin-episodes': data.episodes || (data.type === 'Movie' ? 0 : 1), 'admin-screentime': data.screentime || 0 };
    Object.entries(fields).forEach(([id, value]) => {
      const field = document.getElementById(id);
      if (!field || value === undefined) return;
      if (field.tagName === 'SELECT' && value && !Array.from(field.options).some(option => option.value === String(value))) {
        field.add(new Option(String(value), String(value)));
      }
      field.value = value;
    });
    result.className = 'admin-name-result available';
    result.textContent = 'Details filled from TMDB. Review them before saving.';
  } catch (error) {
    result.className = 'admin-name-result found';
    result.textContent = error.message || 'Autofill could not find this title. Please try again.';
  } finally {
    button.disabled = false;
    button.textContent = 'Autofill';
  }
}

async function submitAdminEntry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const msg = document.getElementById('admin-entry-msg');
  const button = form.querySelector('button[type="submit"]');
  const isUpdate = adminEditRow !== null;
  // Read the override once and clear it, so the next attempt checks again.
  const forced = adminForceAdd;
  adminForceAdd = false;
  const payload = Object.fromEntries(new FormData(form));
  ['genre', 'platform'].forEach(key => {
    const select = document.getElementById('admin-' + key);
    const custom = document.getElementById('admin-' + key + '-custom');
    if (select.value === 'Other' && custom.value.trim()) payload[key] = custom.value.trim();
  });
  if (isUpdate) {
    payload.action = 'update';
    payload.row = adminEditRow;
  } else if (!forced) {
    // The duplicate check comes first and is the gate: a title already in the
    // list stops the add and says so, and only a row that is genuinely new (or
    // an explicit "Add anyway" rewatch) reaches the service.
    //
    // An empty rawData would make that check a silent no-op, so the watchlist is
    // read first — and a store that still cannot be read stops the add instead
    // of letting an unchecked entry through. (skipRerender keeps the repaint from
    // throwing away what is typed in the form.)
    if (!rawData.length) await loadData(true);
    if (!rawData.length) {
      msg.innerHTML = '<div class="sf-error">Could not read the watchlist to check for duplicates, so nothing was added. Check the connection and try again.</div>';
      return;
    }
    const duplicate = adminDuplicateCheck(payload);
    if (duplicate.exact.length || duplicate.exists.length) {
      renderAdminDuplicateWarning(payload, duplicate);
      return;
    }
  }
  button.disabled = true; button.textContent = 'Saving…'; msg.textContent = '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const response = await fetch('/.netlify/functions/admin-entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload), signal: controller.signal });
    clearTimeout(timeout);
    const result = await response.json().catch(() => ({}));
    if (response.status === 401 && result.code === 'SESSION_INVALID') {
      expireAdminSession('Your admin session has ended.');
      return;
    }
    if (!response.ok) {
      throw new Error((result.error || 'Unable to save entry') + (result.code ? ` [${result.code}]` : ''));
    }
    // Leave edit mode, then reload the whole page so the entry shows up everywhere.
    adminEditRow = null;
    const where = result.rowNumber ? ` (#${escapeHTML(String(result.rowNumber))})` : '';
    document.getElementById('admin-entry-msg').innerHTML = result.duplicate
      ? `<div class="sf-success">That entry was already saved${where}. Nothing was added again. Reloading…</div>`
      : `<div class="sf-success">Entry ${isUpdate ? 'updated' : 'added'} successfully${where}. Reloading…</div>`;
    reloading = true;
    setTimeout(() => reloadFresh(), 900);
  } catch (error) {
    msg.innerHTML = `<div class="sf-error">${escapeHTML(error.message)}</div>`;
  } finally { if (!reloading) { button.disabled = false; button.textContent = adminEditRow !== null ? 'Update Entry' : 'Add to Watchlist'; } }
}

// ── README ────────────────────────────────────────────────────────────────
function renderReadme() {
  const cy       = maxYear();
  const total    = rawData.length;
  const shows    = rawData.filter(r => r.type.includes('Show') || r.type.includes('Series')).length;
  const movies   = rawData.filter(r => r.type.toLowerCase() === 'movie').length;
  const allST    = rawData.reduce((s, r) => s + r.screentime, 0);
  const cyrData  = rawData.filter(r => r.year === cy);
  const cyrST    = cyrData.reduce((s, r) => s + r.screentime, 0);
  const prevData = rawData.filter(r => r.year === cy - 1);
  const prevST   = prevData.reduce((s, r) => s + r.screentime, 0);
  const topPlat  = countBy(rawData, 'platform')[0];
  const topGenre = countBy(rawData, 'genre')[0];
  const bestMo   = Object.entries(countByMonth(rawData)).sort((a, b) => b[1] - a[1])[0];
  const distinctMonths = new Set(rawData.filter(r => r.month).map(r => r.year + '-' + r.month)).size;
  const avgMo    = distinctMonths ? (total / distinctMonths).toFixed(1) : '—';

  // ── Insights + watch goal ────────────────────────────────────────────────
  const dayList = [...new Set(rawData.map(r => r.watchDate ? watchDateTimestamp(r.watchDate) : 0).filter(t => t > 0))].sort((a, b) => a - b);
  let streak = 0, curStreak = 0, prevDay = 0;
  dayList.forEach(t => { curStreak = (!prevDay || t - prevDay <= 90000000) ? curStreak + 1 : 1; prevDay = t; if (curStreak > streak) streak = curStreak; });
  const usedItems = key => countBy(rawData, key).filter(x => String(x[0] || '').toLowerCase() !== 'unknown' && String(x[0] || '').trim() !== '');
  const platList = usedItems('platform'); const leastPlat = platList[platList.length - 1] || ['', 0];
  const genreList = usedItems('genre'); const leastGenre = genreList[genreList.length - 1] || ['', 0];
  // Shared yearly goal: stored server-side so every device sees the same
  // target and lock state (set once per year, unlocks on 1 January).
  let goalHrs = Number(goalState.hrs) || 0;
  const goalLocked = goalHrs > 0 && String(goalState.year || '') === String(cy);
  if (!(goalHrs > 0)) goalHrs = Math.round(prevST / 60) || 1;
  const goalPct = Math.min(100, (cyrST / (goalHrs * 60)) * 100).toFixed(0);

  // ── Roadmap insights ────────────────────────────────────────────────────
  const monthIdx = { January:0, February:1, March:2, April:3, May:4, June:5, July:6, August:7, September:8, October:9, November:10, December:11 };
  const movieST = movies ? rawData.filter(r => r.type.toLowerCase() === 'movie').reduce((s, r) => s + r.screentime, 0) : 0;
  const showST = allST - movieST;
  const stShowsPct = allST ? Math.round(showST / allST * 100) : 0;

  const platAgg = {};
  countBy(rawData, 'platform').forEach(([p, n]) => { if (p && n >= 3) platAgg[p] = Math.round(rawData.filter(r => r.platform === p).reduce((s, r) => s + r.screentime, 0) / n); });
  const bingePlat = Object.entries(platAgg).sort((a, b) => b[1] - a[1])[0] || ['—', 0];

  const cyMonths = [...new Set(cyrData.map(r => r.month).filter(Boolean))].sort((a, b) => monthIdx[a] - monthIdx[b]);
  const latestMo = cyMonths[cyMonths.length - 1] || '';
  // Which month is "now" (used by the like-for-like comparisons below).
  const latestMoIdx = latestMo ? monthIdx[latestMo] : -1;
  const calNow = new Date();
  let yoyMonth = null;
  if (latestMo) {
    const cur = cyrData.filter(r => r.month === latestMo);
    let pr = prevData.filter(r => r.month === latestMo);
    // A month that is still running can't be compared with a finished one: cap
    // last year's side at the same day of the month (e.g. 1–5 Oct vs 1–5 Oct).
    const monthRunning = cy === calNow.getFullYear() && latestMoIdx === calNow.getMonth();
    if (monthRunning) {
      const cutoff = calNow.getDate();
      pr = pr.filter(r => { const dt = parseLocalDate(r.watchDate); return !!dt && dt.getDate() <= cutoff; });
    }
    yoyMonth = { name: latestMo, monthRunning: monthRunning, curTitles: cur.length, prevTitles: pr.length, curST: cur.reduce((s, r) => s + r.screentime, 0), prevST: pr.reduce((s, r) => s + r.screentime, 0) };
  }

  // Group seasons/sequels by title, but remember the first spelling seen so the
  // insight can show "The Blacklist" instead of the lowercased grouping key.
  const deep = {};
  rawData.forEach(r => {
    const label = String(r.name || '').trim();
    const key   = label.toLowerCase();
    if (!key) return;
    if (!deep[key]) deep[key] = { hrs: 0, label: label };
    deep[key].hrs += r.screentime || 0;
  });
  const deepTop = Object.entries(deep).sort((a, b) => b[1].hrs - a[1].hrs)[0] || ['', { hrs: 0, label: '' }];
  const deepFranchise = [deepTop[1].label, deepTop[1].hrs];
  const deepCount = rawData.filter(r => String(r.name || '').trim().toLowerCase() === deepTop[0]).length;

  // Months elapsed drives the pace/projection line. If the latest entry is
  // dated in the future of the current year, don't let it count the year as
  // complete — cap at the real current month in that case.
  const elapsed = (cy === calNow.getFullYear() && latestMoIdx > calNow.getMonth())
    ? calNow.getMonth() + 1
    : (latestMoIdx >= 0 ? latestMoIdx + 1 : 0);
  const projectedHrs = elapsed ? Math.round((cyrST / 60) / elapsed * 12) : Math.round(cyrST / 60);
  const paceDiff = Math.round((cyrST / 60) - (goalHrs / 12) * elapsed);
  const paceNote = goalError
    ? '⚠️ ' + goalError
    : (paceDiff >= 0 ? 'On track' : 'Behind') + ' by ' + Math.abs(paceDiff) + ' hrs · on pace for ' + projectedHrs + ' hrs/yr (last year ' + fmtHrs(prevST) + ').';
  // ── Year over year, like for like ───────────────────────────────────────
  // Comparing year-to-date against a whole previous year (9 months vs 12) made
  // the change look several points worse than it is, so both sides use the same
  // months, and a month that is still running is left out of both. The goal and
  // pace lines above still use the full-year figure and say so.
  const partialMo = (cy === calNow.getFullYear() && latestMoIdx === calNow.getMonth()) ? latestMo : '';
  const yoyMonths = cyMonths.filter(m => m !== partialMo);
  const yoySet    = new Set(yoyMonths);
  const yoyCurST  = cyrData.filter(r => yoySet.has(r.month)).reduce((s, r) => s + r.screentime, 0);
  const yoyPrevST = prevData.filter(r => yoySet.has(r.month)).reduce((s, r) => s + r.screentime, 0);
  const diff      = yoyCurST - yoyPrevST;
  const diffPct   = yoyPrevST ? ((diff / yoyPrevST) * 100).toFixed(1) : null;
  const yoyRange  = yoyMonths.length
    ? (yoyMonths.length === 1 ? yoyMonths[0] : yoyMonths[0].slice(0, 3) + '–' + yoyMonths[yoyMonths.length - 1].slice(0, 3))
    : '';
  const yoyTip    = 'Same months compared with ' + (cy - 1) + ' (' + yoyRange + '), not year-to-date against a full year';

  const cyTopGenre = countBy(cyrData, 'genre')[0] || ['—', 0];
  const cyTopPlat = countBy(cyrData, 'platform')[0] || ['—', 0];
  const cyBestMo = Object.entries(countByMonth(cyrData)).sort((a, b) => b[1] - a[1])[0] || ['—', 0];

  // Pre-compute dynamic classes — avoids single quotes inside template literals
  const diffBadgeClass = diff >= 0 ? 'badge badge-green' : 'badge badge-red';
  const diffSign       = diff >= 0 ? '+' : '';
  const diffBadge      = diffPct === null ? '—' : diffSign + diffPct + '%';
  const yoyBarWidth    = yoyPrevST ? Math.min((yoyCurST / yoyPrevST) * 100, 100) : 50;

  // Recent watches — last 6 titles with a valid watch date, sorted newest first
  const fmtShortDate = s => {
    if (!s) return '';
    var clean = String(s).trim();
    var pre = clean.match(/^(\d{1,2}\s+[A-Za-z]{3})\s+\d{4}$/);
    if (pre) return pre[1];
    var dt = parseLocalDate(clean);
    return dt ? dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
  };
  // "Recently watched" means actually watched — future-dated entries are
  // planned, so they don't appear here (they still show in Data/Timeline).
  const recent = rawData
    .filter(r => r.watchDate && watchDateTimestamp(r.watchDate) <= Date.now())
    .sort((a, b) => watchDateTimestamp(b.watchDate) - watchDateTimestamp(a.watchDate))
    .slice(0, 6);
  // Honest hero stamp: the newest date actually watched (future-dated rows are
  // planned, so they don't count), not whatever today happens to be.
  const lastWatchedTs = rawData.reduce((max, r) => {
    const t = r.watchDate ? watchDateTimestamp(r.watchDate) : 0;
    return (t > 0 && t <= Date.now() && t > max) ? t : max;
  }, 0);
  const lastWatched = lastWatchedTs
    ? new Date(lastWatchedTs).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';
  const recentHTML = recent.map(r => {
    const typeClass  = r.type.toLowerCase() === 'movie' ? 'rw-pill movie' : 'rw-pill show';
    const typeLabel  = r.type.toLowerCase() === 'movie' ? 'Movie' : 'Show';
    const genre      = r.genre ? '<span class="rw-genre">' + escapeHTML(r.genre) + '</span>' : '';
    const seasonStr  = r.type && r.type.toLowerCase() !== 'movie'
      ? ' S' + (r.season || '1')
      : '';
    const epsBadge   = r.episodes ? '<span class="rw-genre">' + escapeHTML(r.episodes + ' eps') + '</span>' : '';
    const posterTitle = escapeHTML(r.name || '');
    const ratingKey   = String(r.name || '').trim().toLowerCase();
    return '<div class="rw-card">' +
      // Poster + text sit in one span that becomes a link to the exact IMDb
      // page once the media lookup resolves (see applyImdbLink).
      '<span class="rw-link" data-tk="' + escapeHTML(ratingKey) + '">' +
        '<img class="rw-poster" alt="" loading="lazy" width="54" height="80" data-poster="' + posterTitle + '">' +
        '<div class="rw-info">' +
          '<div class="rw-name">' + escapeHTML(r.name) + escapeHTML(seasonStr) + '</div>' +
          '<div class="rw-meta">' +
            '<span class="' + typeClass + '">' + typeLabel + '</span>' +
            genre +
            epsBadge +
            '<span class="rw-date">' + escapeHTML(fmtShortDate(r.watchDate)) + '</span>' +
          '</div>' +
        '</div>' +
      '</span>' +
    '</div>';
  }).join('');

  document.getElementById('app').innerHTML = `
    <div class="readme-hero">
      <div class="readme-top">
        <div>
          <h1><em>personal media tracker</em>Content Tracking Dashboard</h1>
          <p class="readme-desc">Track and analyse my media consumption across streaming platforms. See genre trends, platform habits, and how my viewing changes over time.</p>
        </div>
        <div class="readme-updated" title="Newest watch date logged in the watchlist"><strong>${lastWatched}</strong>Last watched</div>
      </div>
      <div class="readme-stats">
        <div class="readme-stat">
          <div class="rs-label">Total Titles</div>
          <div class="rs-val">${total}</div>
          <div class="rs-sub">${shows} shows · ${movies} movies</div>
        </div>
        <div class="readme-stat">
          <div class="rs-label">All Time Screentime</div>
          <div class="rs-val">${fmtK(Math.round(allST / 60))}<small> hrs</small></div>
          <div class="rs-sub">≈ ${Math.round(allST / 60 / 24).toLocaleString('en-GB')} days of screen time</div>
        </div>
        <div class="readme-stat">
          <div class="rs-label">This Year (${cy})</div>
          <div class="rs-val">${Math.round(cyrST / 60)}<small> hrs</small></div>
          <div class="rs-sub"><span class="rs-accent">${cyrData.length} titles</span> watched in ${cy}</div>
        </div>
        <div class="readme-stat">
          <div class="rs-label">Top Platform</div>
          <div class="rs-val">${topPlat ? pe(topPlat[0]) : ''}${topPlat ? escapeHTML(topPlat[0]) : '—'}</div>
          <div class="rs-sub">${topPlat ? topPlat[1] + ' titles all time' : ''}</div>
        </div>
      </div>
    </div>
    <div class="readme-main">
      <div>
        <div class="cards-label">What's inside</div>
        <div class="cards-grid slim">
          <a class="info-card slim" href="#current" title="This year's stats — shows vs movies, platform breakdown, genre split and monthly viewing trend."><div class="ic-icon">📅</div><div class="ic-body"><h2>Current Year</h2></div></a>
          <a class="info-card slim" href="#alltime" title="Complete viewing history across all years. Filter by year, platform or genre to spot long-term patterns."><div class="ic-icon">📈</div><div class="ic-body"><h2>All Time</h2></div></a>
          <a class="info-card slim" href="#data" title="Full list of every title logged. Search by name, filter by type, genre, platform or month."><div class="ic-icon">🗂️</div><div class="ic-body"><h2>Data</h2></div></a>
          <a class="info-card slim" href="#suggestions" title="Can't decide what to watch? Spin for a random pick from your own list, filtered by genre or type."><div class="ic-icon gold">🎲</div><div class="ic-body"><h2>Random Pick</h2></div></a>
        </div>
        <div class="rw-section">
          <div class="cards-label">Recently Watched</div>
          <div class="rw-strip" id="rw-strip">${recentHTML}</div>
        </div>
        <div class="recap-card">
          <div class="recap-head"><span class="recap-kicker">Your Year in Screens</span><span class="recap-year">${cy}</span></div>
          <div class="recap-grid">
            <div class="recap-cell"><div class="recap-val">${cyrData.length}</div><div class="recap-lbl">titles</div></div>
            <div class="recap-cell"><div class="recap-val">${fmtK(Math.round(cyrST / 60))}</div><div class="recap-lbl">hours</div></div>
            <div class="recap-cell"><div class="recap-val recap-name">${escapeHTML(String(cyTopGenre[0]))}</div><div class="recap-lbl">top genre</div></div>
            <div class="recap-cell"><div class="recap-val recap-name">${pe(String(cyTopPlat[0]))} ${escapeHTML(String(cyTopPlat[0]))}</div><div class="recap-lbl">top platform</div></div>
            <div class="recap-cell"><div class="recap-val">${escapeHTML(String(cyBestMo[0]))}</div><div class="recap-lbl">best month</div></div>
            <div class="recap-cell"><div class="recap-val">${streak}</div><div class="recap-lbl">day streak</div></div>
          </div>
          <div class="recap-bar"><div class="recap-fill" data-w="${100 - stShowsPct}"></div></div>
          <div class="recap-foot">${100 - stShowsPct}% movies · ${stShowsPct}% shows (by time)</div>
        </div>
      </div>
      <div class="readme-sidebar">
        <div class="fact-card">
          <div class="fact-title">Quick Facts</div>
          <div class="fact-row"><div class="fact-l"><span>🎭</span> Top Genre</div><div class="fact-r">${topGenre ? escapeHTML(topGenre[0]) : '—'}</div></div>
          <div class="fact-row"><div class="fact-l"><span>📆</span> Best Month</div><div class="fact-r">${bestMo ? bestMo[0] : '—'}</div></div>
          <div class="fact-row"><div class="fact-l"><span>📊</span> Avg / Month</div><div class="fact-r">${avgMo} titles</div></div>
          <div class="fact-row"><div class="fact-l"><span>📺</span> Shows (of titles)</div><div class="fact-r">${total ? (shows / total * 100).toFixed(1) : 0}%</div></div>
          <div class="fact-row"><div class="fact-l"><span>🎬</span> Movies (of titles)</div><div class="fact-r">${total ? (movies / total * 100).toFixed(1) : 0}%</div></div>
        </div>
        <div class="fact-card">
          <div class="fact-title">Insights</div>
          <div class="ins-row"><div class="ins-l">🔥 Longest binge streak</div><div class="ins-r">${streak} day${streak === 1 ? '' : 's'}</div></div>
          <div class="ins-row"><div class="ins-l">🕒 Screen-time split</div><div class="ins-r">${stShowsPct}%<span class="ins-sub"> shows / ${100 - stShowsPct}% movies</span></div></div>
          <div class="ins-row"><div class="ins-l">📺 Most time per title</div><div class="ins-r">${escapeHTML(String(bingePlat[0]))}<span class="ins-sub"> ${fmtHrs(bingePlat[1])}/title</span></div></div>
          ${yoyMonth ? `<div class="ins-row"><div class="ins-l">🔄 ${escapeHTML(yoyMonth.name)}${yoyMonth.monthRunning ? ' so far' : ' ytd'}</div><div class="ins-r">${yoyMonth.curTitles}<span class="ins-sub"> vs ${yoyMonth.prevTitles} ${yoyMonth.monthRunning ? 'by this day last yr' : 'last yr'}</span></div></div>` : ''}
          <div class="ins-row"><div class="ins-l">🎬 Deepest franchise</div><div class="ins-r">${escapeHTML(String(deepFranchise[0]) || '—')}<span class="ins-sub"> ${fmtHrs(deepFranchise[1])} · ${deepCount}×</span></div></div>
          <div class="ins-cta">👀 Try next — you've watched little ${escapeHTML(String(leastGenre[0]) || 'any genre')}: something on ${escapeHTML(String(leastPlat[0]) || 'any platform')}?</div>
        </div>
        <div class="yoy-card">
          <div class="yoy-title">Year on Year</div>
          <div class="yoy-row">
            <div><div class="yoy-label">${yoyRange || 'This year'} so far</div><div class="yoy-val">${fmtHrs(yoyCurST)}</div></div>
            <span class="${diffBadgeClass}" title="${yoyTip}">${diffBadge}</span>
          </div>
          <div class="yoy-bar-track"><div class="yoy-bar-fill" data-w="${yoyBarWidth}"></div></div>
          <div class="yoy-note">vs ${fmtHrs(yoyPrevST)} in the same months of ${cy - 1}</div>
          <div class="yoy-note">full ${cy - 1}: ${fmtHrs(prevST)}</div>
        </div>
        <div class="fact-card">
          <div class="goal-top"><div class="fact-title fact-title-flush">Watch Goal · ${cy}</div><div class="goal-count"><strong>${fmtHrs(cyrST)}</strong> / ${goalHrs} hrs</div></div>
          <div class="goal-track"><div class="goal-fill" data-w="${goalPct}"></div></div>
          ${goalLocked ? '' : `<div class="goal-edit">
            <input id="goal-input" class="sf-input" type="number" aria-label="Target hours" inputmode="numeric" min="1" placeholder="Target hrs" value="${goalHrs}">
            <button class="try-btn btn-compact" id="goal-set" type="button">Set</button>
          </div>`}
          <div class="goal-note">${paceNote}</div>
          ${goalLocked ? `<div class="goal-note goal-lock-note">🔒 Locked for ${cy} — unlocks to set a new target on 1 Jan.</div>` : ''}
        </div>
      </div>
    </div>
    <div class="footer">Data loaded live · ${total} titles</div>`;

  const goalSet = document.getElementById('goal-set');
  if (goalSet) {
    goalSet.addEventListener('click', async () => {
      const input = document.getElementById('goal-input');
      const v = Math.max(0, parseFloat(input ? input.value : '') || 0);
      if (input) input.disabled = true;
      goalSet.disabled = true;
      goalSet.textContent = 'Saving…';
      const saved = await setSharedGoal(v, String(cy));
      if (saved) {
        goalState = saved;
        goalError = '';
      } else {
        // Server save unavailable (backend not redeployed yet / offline): keep
        // the card working on this device and say so instead of pretending.
        try {
          localStorage.setItem('ct-goal', v ? String(v) : '0');
          localStorage.setItem('ct-goal-year', String(cy));
        } catch (e) {}
        goalState = { hrs: v, year: v ? String(cy) : '' };
        goalError = 'Saved on this device only — syncing is unavailable right now.';
      }
      renderReadme();
    });
  }

  // Posters for the strip (same cached TMDB lookup the Data table uses).
  const rwStrip = document.getElementById('rw-strip');
  if (rwStrip) loadVisiblePosters(rwStrip);
}

// ── PLATFORM BARS HELPER ──────────────────────────────────────────────────
function buildPlatBars(platCounts) {
  const maxVal = platCounts[0] ? platCounts[0][1] : 1;
  return platCounts.map((p, i) => {
    p = [escapeHTML(p[0]), p[1]];
    // Pre-compute class — no ternary with quotes inside template literal
    const fillClass = i === 0 ? 'plat-fill top' : 'plat-fill';
    const pct = (p[1] / maxVal * 100).toFixed(0);
    return `<div class="plat-row">
      <div class="plat-name">${pe(p[0])} ${escapeHTML(p[0])}</div>
      <div class="plat-track"><div class="${fillClass}" data-w="${pct}"></div></div>
      <div class="plat-count">${p[1]}</div>
    </div>`;
  }).join('');
}

// ── TREEMAP HELPER ────────────────────────────────────────────────────────
function buildTreemap(genCounts, totalGen) {
  const cols = ['col1', 'col2a', 'col2b', 'col3a', 'col3b'];
  const pads = genCounts.slice(0, 5);
  while (pads.length < 5) pads.push(['—', 0]);
  return pads.map((g, i) => {
    const blockClass = `tm-block ${cols[i]}`;
    const pct = totalGen && g[1] ? (g[1] / totalGen * 100).toFixed(1) + '%' : '';
    return `<div class="${blockClass}">
      <div class="tm-name">${escapeHTML(g[0])}</div>
      <div class="tm-pct">${escapeHTML(pct)}</div>
    </div>`;
  }).join('');
}

// ── CURRENT YEAR ──────────────────────────────────────────────────────────
// ── SHARED PAGE-CHROME HELPERS ────────────────────────────────────────────
// Build <option> tags from a list; the 'all' sentinel gets the given label.
function optTags(items, allLabel) {
  return items.map(v => `<option value="${escapeHTML(v)}">${v === 'all' ? allLabel : escapeHTML(v)}</option>`).join('');
}
// Build a page-header filter control (label + select).
// `target` is "<object>.<key>" and `rebuild` names the section to redraw;
// both are read by the delegated dispatcher at the end of this file.
function phFilter(label, id, target, rebuild, optionsHtml) {
  return `<div class="ph-filter"><label class="ph-filter-label" for="${id}">${label}</label>`
       + `<select id="${id}" data-filter="${target}" data-rebuild="${rebuild}">${optionsHtml}</select></div>`;
}

// Re-select a persisted filter value in a rebuilt <select>; if that option
// no longer exists (its rows were deleted), drop the filter back to 'all'.
function syncFilterSelect(id, value) {
  const el = document.getElementById(id);
  if (!el) return value;
  if (Array.from(el.options).some(option => option.value === value)) { el.value = value; return value; }
  return 'all';
}

function renderCurrentYear() {
  const cy        = maxYear();
  const platforms = ['all', ...uniqueVals('platform')];
  const genres    = ['all', ...uniqueVals('genre')];

  const platOptions  = optTags(platforms, 'All');
  const genreOptions = optTags(genres, 'All');

  document.getElementById('app').innerHTML = `
    <div class="page-header">
      <div class="ph-left"><h1>Current Year Numbers</h1><p>${cy} · All months so far</p></div>
      <div class="ph-right">
        ${phFilter('Platform', 'cf-plat', 'curFilters.platform', 'currentYear', platOptions)}
        ${phFilter('Genre', 'cf-genre', 'curFilters.genre', 'currentYear', genreOptions)}
      </div>
    </div>
    <div class="main" id="cy-main"></div>
    <div class="footer" id="cy-footer"></div>`;

  // Filters persist across visits; re-select them so the dropdowns match the
  // data actually being shown.
  curFilters.platform = syncFilterSelect('cf-plat', curFilters.platform);
  curFilters.genre    = syncFilterSelect('cf-genre', curFilters.genre);
  updateCurrentYear();
}

function updateCurrentYear() {
  const cy   = maxYear();
  const base = rawData.filter(r => r.year === cy);
  const d    = filterData(base, curFilters);
  // Last year gets the same filters, otherwise a platform/genre filter would
  // compare a filtered year against an unfiltered one.
  const prev = filterData(rawData.filter(r => r.year === cy - 1), curFilters);

  const shows  = d.filter(r => r.type.includes('Show') || r.type.includes('Series')).length;
  const movies = d.filter(r => r.type.toLowerCase() === 'movie').length;
  const st     = d.reduce((s, r) => s + r.screentime, 0);
  const prevFullST = prev.reduce((s, r) => s + r.screentime, 0);

  // Difference YoY is like-for-like: the same months on both sides, skipping a
  // month that is still running (year-to-date against a whole previous year
  // made the drop look ~7 points worse than it is).
  const calNowY      = new Date();
  const cyMonthsAll  = [...new Set(base.map(r => r.month).filter(Boolean))].sort((a, b) => MONTHS.indexOf(a) - MONTHS.indexOf(b));
  const lastMo       = cyMonthsAll[cyMonthsAll.length - 1] || '';
  const runningMo    = (cy === calNowY.getFullYear() && lastMo && MONTHS.indexOf(lastMo) === calNowY.getMonth()) ? lastMo : '';
  const yoyMonths    = cyMonthsAll.filter(m => m !== runningMo);
  const yoySet       = new Set(yoyMonths);
  const yoyCurST     = d.filter(r => yoySet.has(r.month)).reduce((s, r) => s + r.screentime, 0);
  const yoyPrevST    = prev.filter(r => yoySet.has(r.month)).reduce((s, r) => s + r.screentime, 0);
  const diff   = yoyCurST - yoyPrevST;
  const diffPct = yoyPrevST ? ((diff / yoyPrevST) * 100).toFixed(1) : null;
  const yoyRange = yoyMonths.length
    ? (yoyMonths.length === 1 ? yoyMonths[0] : yoyMonths[0].slice(0, 3) + '–' + yoyMonths[yoyMonths.length - 1].slice(0, 3))
    : '';
  const yoyTip   = 'Same months compared with ' + (cy - 1) + ' (' + (yoyRange || 'no months yet') + '), not year-to-date against a full year. Full ' + (cy - 1) + ': ' + fmtHrs(prevFullST) + '.';

  const platCounts = countBy(d, 'platform').slice(0, 8);
  const genCounts  = countBy(d, 'genre').slice(0, 5);
  const totalGen   = genCounts.reduce((s, g) => s + g[1], 0);
  const topGenre   = genCounts[0] || ['—', 0];
  const bestMo     = Object.entries(countByMonth(d)).sort((a, b) => b[1] - a[1])[0] || ['—', 0];

  // ── Pre-compute ALL dynamic classes before template literals ──────────
  const showsPct   = d.length ? (shows / d.length * 100).toFixed(0) : 0;
  const moviesPct  = d.length ? (movies / d.length * 100).toFixed(0) : 0;
  const totalEpscy = d.filter(r => r.type.includes('Show') || r.type.includes('Series')).reduce((s, r) => s + r.episodes, 0);
  const diffCardClass = diff < 0 ? 'kpi-card accent-red a4' : 'kpi-card accent-gold a4';
  const diffValClass  = diff < 0 ? 'kpi-val negative' : 'kpi-val';
  const diffBadgeClass = diff < 0 ? 'badge badge-red' : 'badge badge-green';
  const diffSign      = diff >= 0 ? '+' : '';
  const diffBadge      = diffPct === null ? '—' : diffSign + diffPct + '%';
  const diffHrs       = Math.round(diff / 60);
  const genrePct      = totalGen ? (topGenre[1] / totalGen * 100).toFixed(1) : 0;
  const topPlatEmoji  = platCounts[0] ? pe(platCounts[0][0]) : '';
  const topPlatName   = platCounts[0] ? platCounts[0][0] : '—';
  const topPlatCount  = platCounts[0] ? platCounts[0][1] + ' titles' : '';

  destroyCharts();

  document.getElementById('cy-main').innerHTML = `
    <div class="kpi-row">
      <div class="kpi-card a1">
        <div class="kpi-label">Shows This Year</div>
        <div class="kpi-val">${shows}</div>
        <div class="kpi-sub"><span class="badge badge-green">${showsPct}%</span> of titles · ${totalEpscy} eps</div>
      </div>
      <div class="kpi-card a2">
        <div class="kpi-label">Movies This Year</div>
        <div class="kpi-val">${movies}</div>
        <div class="kpi-sub"><span class="badge badge-gold">${moviesPct}%</span> of titles</div>
      </div>
      <div class="kpi-card a3">
        <div class="kpi-label">Screentime This Year</div>
        <div class="kpi-val">${fmtHrs(st)}</div>
        <div class="kpi-sub">Across ${d.length} titles</div>
      </div>
      <div class="${diffCardClass}">
        <div class="kpi-label">Difference YoY</div>
        <div class="${diffValClass}">${diffSign}${diffHrs} <small>hrs</small></div>
        <div class="kpi-sub"><span class="${diffBadgeClass}" title="${yoyTip}">${diffBadge}</span> vs ${escapeHTML(yoyRange || 'last year')} ${cy - 1}</div>
      </div>
    </div>
    <div class="charts-row">
      <div class="chart-card a5">
        <div class="chart-title">By Platform</div>
        <div class="plat-bars">${buildPlatBars(platCounts)}</div>
      </div>
      <div class="chart-card a6">
        <div class="chart-title">Titles by Month</div>
        <div class="chart-canvas-wrap"><canvas id="cy-monthly"></canvas></div>
      </div>
    </div>
    <div class="bottom-row">
      <div class="chart-card chart-card-late">
        <div class="chart-title">By Genre</div>
        <div class="treemap">${buildTreemap(genCounts, totalGen)}</div>
      </div>
      <div class="stat-sidebar">
        <div class="stat-card a1">
          <div class="stat-info"><div class="stat-label">Top Platform</div><div class="stat-val">${topPlatEmoji} ${topPlatName}</div></div>
          <span class="stat-badge2">${topPlatCount}</span>
        </div>
        <div class="stat-card a2">
          <div class="stat-info"><div class="stat-label">Top Genre</div><div class="stat-val">${escapeHTML(topGenre[0])}</div></div>
          <span class="stat-badge2">${genrePct}%</span>
        </div>
        <div class="stat-card a3">
          <div class="stat-info"><div class="stat-label">Best Month</div><div class="stat-val">${escapeHTML(bestMo[0])}</div></div>
          <span class="stat-badge2">${bestMo[1]} titles</span>
        </div>
        <div class="stat-card a4">
          <div class="stat-info"><div class="stat-label">Total Watched</div><div class="stat-val">${d.length}</div></div>
          <div class="stat-info"><div class="stat-label stat-label-stack">titles in ${cy}</div></div>
        </div>
      </div>
    </div>`;

  document.getElementById('cy-footer').textContent = `Last updated live · ${cy} data`;

  const moData   = countByMonth(d);
  const moLabels = MONTHS.filter(m => moData[m] > 0);
  const moVals   = moLabels.map(m => moData[m]);
  initLineChart('cy-monthly', moLabels, moVals);
}

// ── ALL TIME ──────────────────────────────────────────────────────────────
function renderAllTime() {
  const years     = ['all', ...[...new Set(rawData.map(r => r.year))].sort((a, b) => b - a).map(y => y.toString())];
  const platforms = ['all', ...uniqueVals('platform')];
  const genres    = ['all', ...uniqueVals('genre')];

  const yearOptions  = optTags(years, 'All Years');
  const platOptions  = optTags(platforms, 'All');
  const genreOptions = optTags(genres, 'All');

  document.getElementById('app').innerHTML = `
    <div class="page-header">
      <div class="ph-left"><h1>All Time Numbers</h1><p>Complete viewing history · all years</p></div>
      <div class="ph-right">
        ${phFilter('Year', 'af-year', 'allFilters.year', 'allTime', yearOptions)}
        ${phFilter('Platform', 'af-plat', 'allFilters.platform', 'allTime', platOptions)}
        ${phFilter('Genre', 'af-genre', 'allFilters.genre', 'allTime', genreOptions)}
      </div>
    </div>
    <div class="main" id="at-main"></div>
    <div class="footer" id="at-footer"></div>`;

  // Same persisted-filter re-sync as Current Year, for all three dropdowns.
  allFilters.year     = syncFilterSelect('af-year', allFilters.year);
  allFilters.platform = syncFilterSelect('af-plat', allFilters.platform);
  allFilters.genre    = syncFilterSelect('af-genre', allFilters.genre);
  updateAllTime();
}

function updateAllTime() {
  const d      = filterData(rawData, allFilters);
  const shows  = d.filter(r => r.type.includes('Show') || r.type.includes('Series')).length;
  const movies = d.filter(r => r.type.toLowerCase() === 'movie').length;
  const st     = d.reduce((s, r) => s + r.screentime, 0);

  const platCounts = countBy(d, 'platform').slice(0, 8);
  const genCounts  = countBy(d, 'genre').slice(0, 5);
  const totalGen   = genCounts.reduce((s, g) => s + g[1], 0);
  const topPlat    = platCounts[0] || ['—', 0];
  const topGenre   = genCounts[0]  || ['—', 0];
  const bestMo     = Object.entries(countByMonth(d)).sort((a, b) => b[1] - a[1])[0] || ['—', 0];
  const yearsSet   = [...new Set(d.map(r => r.year))].filter(Boolean);
  const distinctMonthsAt = new Set(d.filter(r => r.month).map(r => r.year + '-' + r.month)).size;
  const avgMo      = distinctMonthsAt ? (d.length / distinctMonthsAt).toFixed(1) : '—';

  // ── Pre-compute ALL dynamic values before template literals ───────────
  const showsPct  = d.length ? (shows / d.length * 100).toFixed(1) : 0;
  const moviesPct = d.length ? (movies / d.length * 100).toFixed(1) : 0;
  const totalEpsat = d.filter(r => r.type.includes('Show') || r.type.includes('Series')).reduce((s, r) => s + r.episodes, 0);
  const genrePct  = totalGen ? (topGenre[1] / totalGen * 100).toFixed(1) : 0;
  const yearLabel = yearsSet.length + ' year' + (yearsSet.length !== 1 ? 's' : '') + ' of data';

  destroyCharts();

  document.getElementById('at-main').innerHTML = `
    <div class="kpi-row">
      <div class="kpi-card a1">
        <div class="kpi-label">Total Titles</div>
        <div class="kpi-val">${d.length}</div>
        <div class="kpi-sub">${shows} shows + ${movies} movies</div>
      </div>
      <div class="kpi-card accent-gold a2">
        <div class="kpi-label">Screentime All Time</div>
        <div class="kpi-val">${fmtK(Math.round(st / 60))}<small> hrs</small></div>
        <div class="kpi-sub">≈ ${Math.round(st / 60 / 24).toLocaleString('en-GB')} days of screen time</div>
      </div>
      <div class="kpi-card a3">
        <div class="kpi-label">Shows (All Time)</div>
        <div class="kpi-val">${shows}</div>
        <div class="kpi-sub"><span class="badge badge-green">${showsPct}%</span> of titles · ${totalEpsat} eps</div>
      </div>
      <div class="kpi-card a4">
        <div class="kpi-label">Movies (All Time)</div>
        <div class="kpi-val">${movies}</div>
        <div class="kpi-sub"><span class="badge badge-gold">${moviesPct}%</span> of titles</div>
      </div>
    </div>
    <div class="charts-row">
      <div class="chart-card a5">
        <div class="chart-title">By Platform</div>
        <div class="plat-bars">${buildPlatBars(platCounts)}</div>
      </div>
      <div class="chart-card a6">
        <div class="chart-title">Total Count by Month (All Years)</div>
        <div class="chart-canvas-wrap"><canvas id="at-monthly"></canvas></div>
      </div>
    </div>
    <div class="bottom-row">
      <div class="chart-card chart-card-late">
        <div class="chart-title">By Genre</div>
        <div class="treemap">${buildTreemap(genCounts, totalGen)}</div>
      </div>
      <div class="stat-sidebar">
        <div class="stat-card a1">
          <div class="stat-info"><div class="stat-label">Top Platform</div><div class="stat-val">${pe(topPlat[0])} ${escapeHTML(topPlat[0])}</div></div>
          <span class="stat-badge2">${topPlat[1]} titles</span>
        </div>
        <div class="stat-card a2">
          <div class="stat-info"><div class="stat-label">Top Genre</div><div class="stat-val">${escapeHTML(topGenre[0])}</div></div>
          <span class="stat-badge2">${genrePct}%</span>
        </div>
        <div class="stat-card a3">
          <div class="stat-info"><div class="stat-label">Best Month</div><div class="stat-val">${escapeHTML(bestMo[0])}</div></div>
          <span class="stat-badge2">${bestMo[1]} titles</span>
        </div>
        <div class="stat-card a4">
          <div class="stat-info"><div class="stat-label">Avg Per Month</div><div class="stat-val">${avgMo}</div></div>
          <div class="stat-info"><div class="stat-label stat-label-stack">titles / month</div></div>
        </div>
      </div>
    </div>`;

  document.getElementById('at-footer').textContent = `${d.length} titles · ${yearLabel}`;

  const moData = countByMonth(d);
  initLineChart('at-monthly', MONTHS, MONTHS.map(m => moData[m]));
}

// ── DATA TAB ──────────────────────────────────────────────────────────────
function renderData() {
  const years     = ['all', ...[...new Set(rawData.map(r => r.year))].sort((a, b) => b - a).map(y => y.toString())];
  const platforms = ['all', ...uniqueVals('platform')];
  const genres    = ['all', ...uniqueVals('genre')];
  const types     = ['all', ...uniqueVals('type')];
  const months    = ['all', ...MONTHS.filter(m => rawData.some(r => r.month === m))];

  const yearOpts  = optTags(years, 'All Years');
  const platOpts  = optTags(platforms, 'All Platforms');
  const typeOpts  = optTags(types, 'All Types');
  const genreOpts = optTags(genres, 'All Genres');
  const monthOpts = optTags(months, 'All Months');

  document.getElementById('app').innerHTML = `
    <div class="page-header">
      <div class="ph-left"><h1>All Shows &amp; Movies</h1><p>Your complete watchlist · sorted by watch date</p></div>
      <div class="ph-right">
        <div class="dh-pill">📺 <strong id="dh-shows">—</strong> shows</div>
        <div class="dh-pill">🎬 <strong id="dh-movies">—</strong> movies</div>
        <div class="dh-pill">Total <strong id="dh-total">—</strong></div>
      </div>
    </div>
    <div class="data-filters">
      <div class="df-select"><select id="df-year" aria-label="Year"  data-filter="datFilters.year" data-rebuild="dataTable" data-page-reset>${yearOpts}</select></div>
      <div class="df-select"><select id="df-plat" aria-label="Platform"  data-filter="datFilters.platform" data-rebuild="dataTable" data-page-reset>${platOpts}</select></div>
      <div class="df-select"><select id="df-type" aria-label="Type"  data-filter="datFilters.type" data-rebuild="dataTable" data-page-reset>${typeOpts}</select></div>
      <div class="df-select"><select id="df-genre" aria-label="Genre" data-filter="datFilters.genre" data-rebuild="dataTable" data-page-reset>${genreOpts}</select></div>
      <div class="df-select"><select id="df-month" aria-label="Month" data-filter="datFilters.month" data-rebuild="dataTable" data-page-reset>${monthOpts}</select></div>
      <div class="df-divider"></div>
      <div class="df-search">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.5" cy="6.5" r="5" stroke="#7a9e8a" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="#7a9e8a" stroke-width="1.5" stroke-linecap="round"/></svg>
        <input id="df-search" type="text" aria-label="Search by name" placeholder="Search by name…" data-filter="datFilters.search" data-rebuild="dataTable" data-page-reset>
      </div>
    </div>
    <div class="data-main">
      <div class="data-header-row">
        <div class="data-count" id="dat-count"></div>
        <div class="data-tools">
          <label class="tool-select" title="How many rows to show at once">Rows
            <select id="data-per">
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="9999">All</option>
            </select>
          </label>
          <span class="rating-status" id="rat-status"></span>
          <button class="tool-btn" id="rat-load" type="button" title="Fetch the public rating for every title still missing one, so sorting and the CSV export cover the whole list">⭐ Load all ratings</button>
          <button class="tool-btn" id="data-export" type="button" title="Download the filtered list as CSV">⬇ CSV</button>
          <button class="data-reset" id="data-reset" type="button">Reset filters</button>
        </div>
      </div>
      <div id="dat-table"></div>
      <div class="pagination" id="dat-pag"></div>
    </div>
    <div class="footer" id="dat-footer"></div>`;

  document.getElementById('data-reset').addEventListener('click', () => {
    datFilters = { year: 'all', platform: 'all', type: 'all', genre: 'all', month: 'all', search: '' };
    dataPageNum = 1;
    ['df-year', 'df-plat', 'df-type', 'df-genre', 'df-month'].forEach(id => { document.getElementById(id).value = 'all'; });
    document.getElementById('df-search').value = '';
    updateDataTable();
  });
  document.getElementById('data-export').addEventListener('click', exportDataCSV);
  document.getElementById('dat-table').addEventListener('click', event => {
    const th = event.target.closest('th[data-sort]');
    if (!th) return;
    sortDataBy(th.dataset.sort);
  });
  // Same sort, from the keyboard (Enter / Space on a focused header cell).
  document.getElementById('dat-table').addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    const th = event.target.closest('th[data-sort]');
    if (!th) return;
    event.preventDefault();
    sortDataBy(th.dataset.sort);
  });
  const perSel = document.getElementById('data-per');
  if (perSel) {
    perSel.value = String(dataPerPage);
    perSel.addEventListener('change', () => {
      dataPerPage = Math.max(1, parseInt(perSel.value, 10) || PER_PAGE);
      dataPageNum = 1;
      updateDataTable();
    });
  }
  const ratingBtn = document.getElementById('rat-load');
  if (ratingBtn) ratingBtn.addEventListener('click', loadAllRatings);
  applyDataFilters();
  updateDataTable();
}

function dataVal(r, key) {
  switch (key) {
    case 'name': return (r.name || '').toLowerCase();
    case 'type':
    case 'genre':
    case 'platform': return r[key] || '';
    // Missing numbers must read as EMPTY, not as the value 0: movies have no
    // episode count and a cold cache has no rating, and compareData() only
    // sinks empty values — sorting them as 0 dumped all 92 movies (or every
    // unrated row) on top of an ascending sort.
    case 'episodes':
    case 'screentime': {
      const n = Number(r[key]);
      return isFinite(n) && n > 0 ? n : '';
    }
    case 'rating': {
      const n = Number(r.rating);
      return isFinite(n) && n > 0 ? n : '';
    }
    // Same for dates the sheet never gave us a usable value for (the helper
    // reports those as 0, which is otherwise the oldest possible timestamp).
    case 'watchDate': {
      const t = watchDateTimestamp(r.watchDate);
      return t > 0 ? t : '';
    }
    default: return r[key] == null ? '' : String(r[key]);
  }
}
function compareData(a, b) {
  const va = dataVal(a, dataSort.key);
  const vb = dataVal(b, dataSort.key);
  const empty = v => v === '' || v === null || v === undefined || (typeof v === 'number' && isNaN(v));
  const aEmpty = empty(va), bEmpty = empty(vb);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const dir = dataSort.dir === 'asc' ? 1 : -1;
  if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
  return String(va).localeCompare(String(vb)) * dir;
}
// Sort state lives in one place so the header click and the keyboard handler
// can't drift apart.
function sortDataBy(key) {
  if (dataSort.key === key) dataSort.dir = dataSort.dir === 'asc' ? 'desc' : 'asc';
  else dataSort = { key: key, dir: key === 'watchDate' ? 'desc' : 'asc' };
  dataPageNum = 1;
  updateDataTable();
  // Sorting re-renders the table, which throws the header element away and
  // drops focus onto <body>. Put it back on the same column so a keyboard user
  // keeps their place; a mouse user sees no ring, because :focus-visible skips
  // programmatic focus that follows a pointer click. Both handlers come
  // through here so the mouse and keyboard paths can't drift apart.
  const again = document.querySelector('#dat-table th[data-sort="' + key + '"]');
  if (again) again.focus();
}
function dataHeader(key, label) {
  const active = dataSort.key === key;
  const arrow = active ? (dataSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  // title + aria-sort make the sorting discoverable, and tabindex keeps the
  // headers reachable for keyboard and screen-reader users.
  const state = active ? (dataSort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return '<th class="sortable" data-sort="' + key + '" tabindex="0" aria-sort="' + state + '" title="Sort by ' + label.toLowerCase() + '">' + label +
    (active ? '<span class="sort-arrow">' + arrow + '</span>' : '') + '</th>';
}
function buildDataCSV() {
  // Ratings fall back to the device cache, so the export covers every row we
  // already know a rating for — not just the ones on screen right now.
  const rows = dataFiltered.map(r => [r.name, r.type, r.genre, r.platform, r.episodes || '', r.screentime || '', r.month || '', r.year || '', r.watchDate || '', r.rating || cachedRating(r.name) || '']);
  const esc = s => { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['Name','Type','Genre','Platform','Episodes','Screentime (mins)','Month','Year','Watch Date','Rating'].map(esc).join(',');
  return head + '\n' + rows.map(r => r.map(esc).join(',')).join('\n');
}
function exportDataCSV() {
  const blob = new Blob([buildDataCSV()], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'watchlist-export.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 0);
}
// Read shareable filter params from the URL (e.g. ?year=2026) and sync the UI.
function applyDataFilters() {
  const qs = new URLSearchParams(location.search);
  ['year','platform','type','genre','month'].forEach(k => { if (qs.get(k)) datFilters[k] = qs.get(k); });
  if (qs.get('search') != null) datFilters.search = qs.get('search');
  const sels = { 'df-year':'year','df-plat':'platform','df-type':'type','df-genre':'genre','df-month':'month' };
  Object.keys(sels).forEach(id => { const el = document.getElementById(id); if (el) el.value = datFilters[sels[id]]; });
  const s = document.getElementById('df-search'); if (s) s.value = datFilters.search;
}
function syncDataURL() {
  if (!location.hash.startsWith('#data')) return;
  const p = new URLSearchParams();
  ['year','platform','type','genre','month'].forEach(k => { if (datFilters[k] && datFilters[k] !== 'all') p.set(k, datFilters[k]); });
  if (datFilters.search) p.set('search', datFilters.search);
  const qs = p.toString();
  // A fragment-only URL keeps the CURRENT query string, so a cleared filter
  // stayed in the address bar and came straight back the next time the page
  // read it (applyDataFilters runs on every render) — write the path out.
  try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + '#data'); } catch (e) {}
}

function updateDataTable() {
  // Sort by the active column (default: newest watch date first); empty values
  // always drop to the bottom.
  const d = filterData(rawData, datFilters).slice().sort(compareData);
  dataFiltered = d;
  syncDataURL();

  const shows  = d.filter(r => r.type && (r.type.includes('Show') || r.type.includes('Series'))).length;
  const movies = d.filter(r => r.type && r.type.toLowerCase() === 'movie').length;

  const el = id => document.getElementById(id);
  if (el('dh-shows'))  el('dh-shows').textContent  = shows;
  if (el('dh-movies')) el('dh-movies').textContent = movies;
  if (el('dh-total'))  el('dh-total').textContent  = d.length;

  const totalPages = Math.max(1, Math.ceil(d.length / dataPerPage));
  if (dataPageNum > totalPages) dataPageNum = 1;
  const start = (dataPageNum - 1) * dataPerPage;
  const end   = start + dataPerPage;
  const page  = d.slice(start, end);

  const countEl = el('dat-count');
  if (countEl) countEl.innerHTML = '<strong>' + d.length + '</strong> title' + (d.length !== 1 ? 's' : '') + ' found';

  if (!d.length) {
    el('dat-table').innerHTML = '<div class="empty-state"><span>🔍</span>No titles match your filters</div>';
    el('dat-pag').innerHTML = '';
    return;
  }

  const fmtDate = function(s) {
    if (!s) return '—';
    var clean = String(s).trim();
    if (/^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/.test(clean)) return clean;
    var dt = parseLocalDate(clean);
    return dt ? dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : clean;
  };

  // Build each row with pure string concatenation — no template literals
  var rowsHTML = '';
  for (var i = 0; i < page.length; i++) {
    var r = page[i];
    var pillClass  = (r.type && r.type.toLowerCase() === 'movie') ? 'type-pill movie' : 'type-pill show';
    var typeLabel  = escapeHTML(r.type || '—');
    var genre      = escapeHTML(r.genre || '—');
    var platEmoji  = pe(r.platform || '');
    var platName   = escapeHTML(r.platform || '—');
    var name       = r.name || '—';
    var isMovie      = r.type && r.type.toLowerCase() === 'movie';
    var seasonStr    = isMovie ? '' : ' S' + (r.season || '1');
    var epsStr       = r.episodes ? r.episodes + ' eps' : '—';
    name = escapeHTML(name);
    var    posterTitle  = escapeHTML(r.name || '');
    var ratingKey   = String(r.name || '').trim().toLowerCase();
    // The whole name cell (poster + title) starts as plain text and becomes a
    // link to its EXACT IMDb page once the lookup returns an imdbID
    // (see applyImdbLink) — never a find page.
    rowsHTML += '<tr>';
    rowsHTML += '<td class="row-num">' + (start + i + 1) + '</td>';
    // The Episodes column is dropped on phones to stop the table scrolling so
    // far, so the count rides along under the title instead of disappearing.
    var epsMobile  = (r.episodes && !isMovie) ? '<span class="meta-mobile">' + escapeHTML(r.episodes + ' eps') + '</span>' : '';
    rowsHTML += '<td class="td-strong"><span class="name-link" data-tk="' + escapeHTML(ratingKey) + '">' +
      '<img class="poster" alt="" loading="lazy" width="42" height="60" data-poster="' + posterTitle + '">' +
      '<span class="title-cell">' + name + '<span class="season-note">' + escapeHTML(seasonStr) + '</span>' + epsMobile + '</span>' +
      '</span></td>';
    rowsHTML += '<td><span class="' + pillClass + '">' + typeLabel + '</span></td>';
    rowsHTML += '<td>' + genre + '</td>';
    rowsHTML += '<td>' + platEmoji + ' ' + platName + '</td>';
    rowsHTML += '<td class="td-mid">' + escapeHTML(epsStr) + '</td>';
    rowsHTML += '<td class="td-mid">' + escapeHTML(r.screentime ? r.screentime + ' mins' : '—') + '</td>';
    rowsHTML += '<td class="rating-cell" data-rk="' + escapeHTML(ratingKey) + '">' + (isFinite(Number(r.rating)) && Number(r.rating) > 0 ? ratingStars(r.rating) : '<span class="rt-na">—</span>') + '</td>';
    rowsHTML += '<td class="td-soft">' + escapeHTML(fmtDate(r.watchDate)) + '</td>';
    rowsHTML += '</tr>';
  }

  el('dat-table').innerHTML =
    '<table>' +
      '<thead><tr>' +
        '<th>#</th>' +
        dataHeader('name', 'Name') +
        dataHeader('type', 'Type') +
        dataHeader('genre', 'Genre') +
        dataHeader('platform', 'Platform') +
        dataHeader('episodes', 'Episodes') +
        dataHeader('screentime', 'Screentime') +
        dataHeader('rating', 'Rating') +
        dataHeader('watchDate', 'Watch Date') +
      '</tr></thead>' +
      '<tbody>' + rowsHTML + '</tbody>' +
    '</table>';
  loadVisiblePosters(el('dat-table'));

  var prevDisabled = dataPageNum <= 1 ? 'disabled' : '';
  var nextDisabled = dataPageNum >= totalPages ? 'disabled' : '';

  el('dat-pag').innerHTML =
    '<div class="pag-info">Showing ' + (start + 1) + '–' + Math.min(end, d.length) + ' of ' + d.length +
      '<span class="pag-page"> · page ' + dataPageNum + ' of ' + totalPages + '</span></div>' +
    '<div class="pag-btns">' +
      '<button class="pag-btn" data-page-step="prev" ' + prevDisabled + '>← Prev</button>' +
      '<button class="pag-btn" data-page-step="next" ' + nextDisabled + '>Next →</button>' +
    '</div>';

  updateRatingStatus();
}

// ── RATINGS ───────────────────────────────────────────────────────────────
// Public ratings arrive with the on-demand TMDB/OMDb lookup and live in the
// per-device cache, so a fresh browser only knows the rows it has actually
// rendered — which made the Rating column look half-broken and quietly thinned
// the CSV export. This shows honest coverage and fills the rest in one pass.
function cachedRating(name) {
  const cached = MEDIA_CACHE[String(name || '').trim().toLowerCase()];
  return (cached && Number(cached.rating) > 0) ? Number(cached.rating) : 0;
}
function ratingCoverage() {
  let have = 0, dead = 0;
  rawData.forEach(r => {
    if (cachedRating(r.name) > 0 || Number(r.rating) > 0) have++;
    // A title the media API has already answered for, without a rating, can't
    // gain one by asking again — count it as unavailable rather than letting it
    // hold the coverage short forever.
    else if (mediaMissed(String(r.name || '').trim().toLowerCase())) dead++;
  });
  return { have: have, dead: dead, total: rawData.length, missing: rawData.length - have - dead };
}
let ratingScan = { running: false, done: 0, total: 0 };
function updateRatingStatus() {
  const status = document.getElementById('rat-status');
  const btn    = document.getElementById('rat-load');
  if (!status && !btn) return;
  const cov = ratingCoverage();
  if (status) {
    status.textContent = ratingScan.running
      ? '⏳ Ratings ' + cov.have + '/' + cov.total + ' · fetching ' + ratingScan.done + '/' + ratingScan.total
      : 'Ratings ' + cov.have + '/' + cov.total + (cov.dead ? ' · ' + cov.dead + ' unavailable' : '');
    status.classList.toggle('complete', cov.missing === 0);
  }
  if (btn) {
    btn.disabled = ratingScan.running || cov.missing === 0;
    btn.textContent = ratingScan.running
      ? '⏳ Loading…'
      : (cov.missing === 0 ? '⭐ Ratings complete' : '⭐ Load all ratings (' + cov.missing + ')');
  }
}
async function loadAllRatings() {
  if (ratingScan.running) return;
  // Titles already known to be unfindable are skipped rather than re-fetched.
  const pending = rawData.filter(r => cachedRating(r.name) <= 0 && !(Number(r.rating) > 0) &&
    !mediaMissed(String(r.name || '').trim().toLowerCase()));
  if (!pending.length) { updateRatingStatus(); return; }
  ratingScan = { running: true, done: 0, total: pending.length };
  updateRatingStatus();
  const CONCURRENCY = 3;   // gentle on the media APIs
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const row = pending[next++];
      try {
        const meta = await lookupMedia(String(row.name || '').trim().toLowerCase(), row.name);
        if (meta && Number(meta.rating) > 0) row.rating = Number(meta.rating);
      } catch (e) { /* nothing to do — coverage just stays short */ }
      ratingScan.done++;
      if (ratingScan.done % 4 === 0 || ratingScan.done === ratingScan.total) updateRatingStatus();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()));
  ratingScan.running = false;
  updateRatingStatus();
  // Repaint the visible page so the new stars show up straight away.
  if (document.getElementById('dat-table')) updateDataTable();
}

// ── TIMELINE ──────────────────────────────────────────────────────────────
function shortDate(value) {
  const d = parseLocalDate(value);
  return d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
}

function renderTimeline() {
  const dated = rawData.filter(r => r.watchDate).slice().sort((a, b) => watchDateTimestamp(b.watchDate) - watchDateTimestamp(a.watchDate));
  const byKey = {};
  dated.forEach(r => { const k = (r.year || '?') + '|' + (r.month || ''); (byKey[k] = byKey[k] || []).push(r); });
  const keys = Object.keys(byKey);
  keys.sort((a, b) => {
    const [ya, ma] = a.split('|');
    const [yb, mb] = b.split('|');
    if (ya !== yb) return Number(yb || 0) - Number(ya || 0);
    return MONTHS.indexOf(mb || '') - MONTHS.indexOf(ma || '');
  });
  // 370 entries in one scroll was the worst page to actually use: long months
  // now start collapsed, the month headers stick, and a jump bar skips years.
  const COLLAPSE_AFTER = 5;
  const yearSeen = {};
  const sections = keys.map(k => {
    const [year, month] = k.split('|');
    const items = byKey[k].map((r, i) => {
      const season = (r.season ? ' <span class="tl-season">S' + escapeHTML(r.season) + '</span>' : '');
      const type = r.type && r.type.toLowerCase() === 'movie' ? 'Movie' : 'Show';
      const extra = i >= COLLAPSE_AFTER ? ' tl-extra' : '';
      return '<div class="tl-item' + extra + '">' +
        '<span class="tl-name">' + escapeHTML(r.name) + season + '</span>' +
        '<span class="tl-meta">' + escapeHTML(type) + ' · ' + escapeHTML(r.genre || '') + '</span>' +
        '<span class="tl-date">' + escapeHTML(shortDate(r.watchDate)) + '</span>' +
      '</div>';
    }).join('');
    // The first section of each year carries the anchor the jump bar targets.
    const anchor = yearSeen[year] ? '' : ' id="tl-y' + escapeHTML(String(year)) + '"';
    yearSeen[year] = true;
    const hiddenCount = byKey[k].length - COLLAPSE_AFTER;
    const moreBtn = hiddenCount > 0
      ? '<button class="tl-more" type="button" aria-expanded="false">Show ' + hiddenCount + ' more</button>'
      : '';
    return '<div class="tl-section"' + anchor + '>' +
      '<div class="tl-head">' + escapeHTML(month || 'N/A') + ' ' + escapeHTML(String(year)) + '<span class="tl-count">' + byKey[k].length + '</span></div>' +
      '<div class="tl-list">' + items + moreBtn + '</div>' +
    '</div>';
  }).join('');

  const years = [...new Set(keys.map(k => k.split('|')[0]))];
  const jumpBar = years.length > 1
    ? '<div class="tl-jump"><span class="tl-jump-label">Jump to</span>' +
        years.map(y => '<button class="tl-jump-btn" type="button" data-year="' + escapeHTML(String(y)) + '">' + escapeHTML(String(y)) + '</button>').join('') +
      '</div>'
    : '';

  document.getElementById('app').innerHTML =
    '<div class="page-header"><div class="ph-left"><h1>Timeline</h1><p>Your watch history, month by month</p></div></div>' +
    '<div class="timeline">' + jumpBar + sections + '</div>' +
    '<div class="footer">Data loaded live · ' + rawData.length + ' titles</div>';

  bindTimelineNav();
}

// Jump bar + month expanders for the timeline.
function bindTimelineNav() {
  document.querySelectorAll('.tl-jump-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById('tl-y' + btn.dataset.year);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  document.querySelectorAll('.tl-more').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.tl-section');
      if (!section) return;
      const open = section.classList.toggle('expanded');
      btn.setAttribute('aria-expanded', String(open));
      const hidden = section.querySelectorAll('.tl-extra').length;
      btn.textContent = open ? 'Show less' : 'Show ' + hidden + ' more';
    });
  });
}

// ── RELEASE CALENDAR ──────────────────────────────────────────────────────
// A rolling release calendar. Films come from TMDB (the same key tmdb-search.js
// already uses, so there is nothing new to configure) and episodes from TVmaze,
// whose /schedule/full endpoint answers with the whole future schedule in one
// request — broadcast *and* streaming, every country.
//
// Rolling means nothing about it is fixed at build time:
//   * **This year** is month by month, from the current month to December. The
//     months come from the clock, so a finished month drops out of the strip and
//     a new one joins it at midnight with no deploy.
//   * **Next year** is one year-at-a-glance view: twelve sections, one per month,
//     of what is already dated. That is a genuinely different thing to fetch —
//     a year cannot be listed to the day (the function switches to a
//     popularity-ordered window for it, see moviePlan) — which is why the two
//     scopes are two windows rather than one long one.
//   * It refreshes itself: a 20-minute background poll, a refetch when the tab
//     comes back into view, and a midnight rollover that moves "today", drops
//     the month that just ended and rolls the two year tabs over on 1 January.
//     The function's own CDN cache (max-age 900) is what the background poll
//     mostly reads, and Refresh passes ?fresh= to ask for a URL the CDN has
//     never seen.
//
// One more thing worth knowing: "everything" is a real number here. Once daily
// news and talk shows count, TVmaze lists ~300 entries a day, so the default
// view is premieres + films and the day drawer is where the complete list lives.
const CALENDAR_URL = '/.netlify/functions/calendar';
const CAL_TTL_MS = 20 * 60 * 1000;    // how long a loaded window stays fresh
const CAL_AUTO_MS = 20 * 60 * 1000;   // and how often the open one is refetched
const CAL_CACHE_MAX = 4;              // windows kept in memory (this year + the year ahead)
const CAL_REGIONS = [
  ['US', 'United States'], ['GB', 'United Kingdom'], ['IN', 'India'], ['CA', 'Canada'],
  ['AU', 'Australia'], ['DE', 'Germany'], ['FR', 'France'], ['NL', 'Netherlands'],
  ['ES', 'Spain'], ['IT', 'Italy'], ['BR', 'Brazil'], ['MX', 'Mexico'], ['JP', 'Japan'],
  ['KR', 'South Korea'], ['SE', 'Sweden'], ['NO', 'Norway'], ['DK', 'Denmark'],
  ['PL', 'Poland'], ['PT', 'Portugal'], ['IE', 'Ireland'], ['NZ', 'New Zealand'],
  ['ZA', 'South Africa'], ['AE', 'United Arab Emirates'], ['SG', 'Singapore']
];
// A film releases country by country, so "every region" is not a region code the
// API has: it is the sentinel the picker offers, and the list above is what the
// request hands the function to union over. This array is the one place that
// list is defined — the function unions exactly what it is sent, so the dropdown
// and the calendar can never disagree about what "all" means.
const CAL_REGION_ALL = 'all';
const calRegionKnown = value => value === CAL_REGION_ALL || CAL_REGIONS.some(region => region[0] === value);
// Monday-first, matching the en-GB dates used everywhere else in the app.
const CAL_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// No floor on the platform list. A threshold used to hide any platform with
// fewer than eight releases in the window, which is not a list of the quiet ones
// — the whole-year view is thin by nature — but of the ones you cannot ask for:
// CBS, Hulu, Netflix, Disney+ and HBO Max all fell off it there. Every platform
// with a release in the loaded window earns an option instead; the cap only
// bounds a runaway list.
const CAL_PLATFORM_CAP = 30;
const CAL_DAILY_KINDS = new Set(['news', 'talk show']);
// The floor for what counts as a strip that airs every day. The "Episode
// releases" scope leaves those out (see calIndex), and the number of days it
// takes is scaled by the length of the window, so the same rule holds for a
// month (a third of it) and for a year (where a fixed five would flag every
// weekly show the moment it appeared 52 times).
const CAL_DAILY_FLOOR = 5;
const CAL_PREVIEW = 3;  // entries a day cell shows before its "+N more"

// The filters are kept on the device, like the region below: the calendar then
// opens on the view that was actually asked for — "Episode releases" stays
// applied through a reload, a new tab or a later visit — instead of falling back
// to the default, which reads as missing data rather than as a filter.
const CAL_FILTERS_KEY = 'ct-cal-filters';
const CAL_SCOPES = ['new', 'episodes', 'all'];
const CAL_TYPES = ['all', 'movie', 'episode'];
// The widest view is the default: every release of both kinds, on every service
// the watchlist logs against. "New & notable" is still one select away for a
// month that reads better with the weekly run of shows thinned out.
const CAL_FILTER_DEFAULTS = { scope: 'all', type: 'all', platform: 'all', search: '' };
// The shape of the stored filters, bumped when a default above changes. Storing
// only happens on a deliberate change, so an untouched device has nothing saved
// and needs no bump — but a device that once stored the *old* default would keep
// opening on it, which reads as the new default never having taken effect.
const CAL_FILTERS_VERSION = 2;
function calStoredFilters() {
  const fallback = CAL_FILTER_DEFAULTS;
  try {
    const saved = JSON.parse(localStorage.getItem(CAL_FILTERS_KEY) || 'null');
    if (!saved || typeof saved !== 'object' || saved.v !== CAL_FILTERS_VERSION) return fallback;
    return {
      scope: CAL_SCOPES.indexOf(saved.scope) === -1 ? fallback.scope : saved.scope,
      type: CAL_TYPES.indexOf(saved.type) === -1 ? fallback.type : saved.type,
      platform: typeof saved.platform === 'string' && saved.platform ? saved.platform.slice(0, 60) : 'all',
      search: typeof saved.search === 'string' ? saved.search.slice(0, 60) : ''
    };
  } catch (e) { return fallback; }
}
function calSaveFilters() {
  // An empty platform is what a rebuilt <select> reads back as, and it means
  // 'all' to calMatches — so store it that way rather than as a blank that a
  // later load would have to make sense of.
  try {
    localStorage.setItem(CAL_FILTERS_KEY, JSON.stringify({
      v: CAL_FILTERS_VERSION,
      scope: calFilters.scope,
      type: calFilters.type,
      platform: calFilters.platform || 'all',
      search: calFilters.search
    }));
  } catch (e) { /* private mode */ }
}
let calFilters = calStoredFilters();
// Movies release on a per-country schedule, so the region decides what the film
// half of the calendar contains — and the default is every region at once: a
// release calendar that quietly dropped everything outside one country was the
// wrong default for a watchlist that is not itself in one country. A single
// region is still one choice away, and a remembered one wins over the default.
let calRegion = (() => {
  try {
    const saved = localStorage.getItem('ct-cal-region');
    if (calRegionKnown(saved)) return saved;
  } catch (e) { /* private mode — fall through to the default */ }
  return CAL_REGION_ALL;
})();
let calState = {
  cache: new Map(),   // window key -> { data, loadedAt, updatedAt } — one entry per built window
  key: '',            // the window key currently painted
  data: null,         // { days, movies, episodes, platforms, warnings, generatedAt }
  loadedAt: 0,
  updated: '',        // "14:32" — when the painted window was last fetched
  status: 'idle',     // idle | loading | ready | error
  error: '',
  notice: '',         // a background refresh that failed, while a window is on screen
  scope: 'year',      // 'year' = this year month by month | 'next' = next year at a glance
  month: 0,           // index into calYearMonths() for the 'year' scope
  dateKey: '',        // today, so the minute tick can notice midnight
  expanded: new Set(),// year-view months opened with "Show all"
  openDay: '',        // ISO date of the open day drawer, '' when closed
  dayAll: false,      // the drawer is showing the day's full list ignored by filters
  opener: null,       // element to hand focus back to when the drawer closes
  platformsKey: '',
  platformOptions: []
};
let calTracked = new Set();
let calTimers = [];

function calISO(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
// Whole days in an inclusive ISO range — the denominator for "is this a daily
// strip" and nothing else.
function calDayCount(from, to) {
  const start = Date.parse(from + 'T00:00:00Z');
  const end = Date.parse(to + 'T00:00:00Z');
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(1, Math.round((end - start) / 86400000) + 1) : 1;
}
function calMonthAt(year, month) {
  return {
    year: year,
    month: month,
    label: MONTHS[month] + ' ' + year,
    short: MONTHS[month].slice(0, 3),
    first: calISO(new Date(year, month, 1)),
    last: calISO(new Date(year, month + 1, 0))
  };
}
// Every month of this year that is still to come — the current one through
// December. A month that has *ended* is not offered at all: nobody plans around
// one. The month that is running is offered whole, its past days included, since
// they are part of the month you are looking at.
function calYearMonths(now) {
  now = now || new Date();
  const months = [];
  for (let month = now.getMonth(); month < 12; month++) months.push(calMonthAt(now.getFullYear(), month));
  return months;
}
function calNextYearWindow(now) {
  now = now || new Date();
  const year = now.getFullYear() + 1;
  return { year: year, from: calISO(new Date(year, 0, 1)), to: calISO(new Date(year, 11, 31)) };
}
// The one window the current view is asking for. A month is asked for whole —
// the current one included, so its past days carry the releases that were on
// them instead of being a row of blanks — and next year is asked for whole by
// definition. The days of the current month that are already behind us are not
// in the schedule response the function fetches first; it goes back for them
// itself (see backfillDays in calendar.js), which is why the page asks for the
// whole month and gets a whole month.
function calScopeWindow() {
  const now = new Date();
  if (calState.scope === 'next') return calNextYearWindow(now);
  const months = calYearMonths(now);
  const month = months[Math.min(calState.month, months.length - 1)] || months[0];
  return { month: month, from: month.first, to: month.last };
}
function calWindowKey(win) {
  return win.from + '|' + win.to + '|' + calRegion;
}
// One slot per grid cell: leading blanks so the 1st lands under its weekday,
// then every day of the month.
function calSlots(month) {
  const lead = (new Date(month.year, month.month, 1).getDay() + 6) % 7;
  const days = new Date(month.year, month.month + 1, 0).getDate();
  const slots = [];
  for (let i = 0; i < lead; i++) slots.push('');
  for (let day = 1; day <= days; day++) slots.push(month.first.slice(0, 8) + String(day).padStart(2, '0'));
  return slots;
}
// Within a day the most interesting things lead: a new series first, then a
// film, then a returning season, then the weekly run of shows already on. Daily
// news rounds out the tail — which is what "every single thing" honestly looks
// like once a schedule stops flattering itself.
function calRank(item) {
  if (item.media === 'movie') return item.platforms.length ? 2 : 3;
  if (item.premiere === 'series') return item.streaming ? 0 : 1;
  if (item.premiere === 'season') return item.streaming ? 4 : 5;
  if (item.streaming) return 6;
  return CAL_DAILY_KINDS.has(String(item.kind || '').toLowerCase()) ? 8 : 7;
}
// What "trendy" means, in one place: where an item sits among its own kind — a
// percentile, so "the most popular film of the window" and "the most popular show
// of the window" are worth the same — plus a nudge for a rating, for arriving on
// a streaming service and for being a premiere. The two sources' figures are NOT
// one scale: TMDB's popularity is an unbounded hotness number with a long tail
// (median 3 across a month of films) while TVmaze's show weight saturates — 38
// different shows share a 100 in a single October — so a raw score compares TVmaze
// against itself and buries a Friday's theatrical opening under a PBS cooking
// show. calRank is what the day drawer is built on, because a schedule reads as
// tiers; this is what the month's cells preview, because a picture reads as what
// people watch.
function calTrend(item) {
  // The rating is a nudge, not a vote: a film a month from release often has no
  // vote average at all (that is a 0 here), and a thin one would otherwise beat a
  // bigger opening on its own.
  return item.pct * 100 + item.rating * 0.5 + (item.streaming ? 5 : 0) + (item.premiere ? 10 : 0);
}
// Ranks each kind against itself and stores the result as `pct` on the item: the
// strongest film of the window and the strongest show of the window both come out
// at 1, a median one at 0.5. Equal figures share a rank, so a saturated weight
// cannot decide anything on its own.
function calPopularity(list) {
  const sorted = list.slice().sort((a, b) => a.weight - b.weight);
  // One film in the window is still the best film in the window.
  if (sorted.length === 1) { sorted[0].pct = 1; list.forEach(item => { item.trend = calTrend(item); }); return; }
  const last = Math.max(1, sorted.length - 1);
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1].weight === sorted[start].weight) end++;
    const pct = ((start + end) / 2) / last;
    for (let i = start; i <= end; i++) sorted[i].pct = pct;
    start = end + 1;
  }
  list.forEach(item => {
    if (!Number.isFinite(item.pct)) item.pct = 0;
    item.trend = calTrend(item);
  });
}
const CAL_TIER_LABELS = ['Series premieres', '', 'Films', '', 'Season premieres', '', 'Streaming episodes', 'Broadcast episodes', 'News & talk'];
function calLabel(item) {
  if (item.media === 'movie') return 'Film';
  if (item.premiere === 'series') return 'Series premiere';
  if (item.premiere === 'season') return 'S' + (item.season || 1) + ' premiere';
  if (!item.number) return 'New episode';
  return 'S' + (item.season || 0) + 'E' + item.number;
}
function calTitle(item) { return item.title + ' ' + (item.episode || ''); }
// Titles the watchlist already knows about — a calendar entry you have logged
// is worth marking, and the sheet's "Homeland All Seasons" has to match the
// show the calendar lists bare.
function calTrackedTitles() {
  const set = new Set();
  rawData.forEach(row => {
    const name = dupNormTitle(row.name);
    if (!name) return;
    set.add(name);
    const bare = dupNormTitle(String(row.name || '').replace(/\s+(all seasons|season\s*\d+|s\s*\d+)$/i, ''));
    if (bare) set.add(bare);
  });
  return set;
}
function calSafeUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
}
// ── IMDb LINKS ───────────────────────────────────────────────────────────
// A calendar title links to its own IMDb page rather than to the API the row
// came from: IMDb is the page you were going to look at anyway. An episode
// arrives with its page already (the function carries it for free out of the
// payload it fetches), a film does not — TMDB's list endpoints have no `imdb_id`
// — so a film's page is resolved on the click, remembered on the device, and a
// title with no page to be had falls back to an IMDb search for its name. A
// click therefore never lands on TVmaze or TMDB.
const IMDB_CACHE_KEY = 'ct-imdb';
const IMDB_CACHE_MAX = 400;
function imdbLookupCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(IMDB_CACHE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) { return {}; }
}
function imdbLookupRemember(tmdbId, url) {
  try {
    const cache = imdbLookupCache();
    cache[tmdbId] = url || '';
    const keys = Object.keys(cache);
    if (keys.length > IMDB_CACHE_MAX) keys.slice(0, keys.length - IMDB_CACHE_MAX).forEach(key => delete cache[key]);
    localStorage.setItem(IMDB_CACHE_KEY, JSON.stringify(cache));
  } catch (e) { /* private mode — the click just resolves again next time */ }
}
function imdbTmdbId(item) {
  return item && item.media === 'movie' && /^m\d+$/.test(String(item.id)) ? String(item.id).slice(1) : '';
}
function imdbSearchUrl(item) {
  const year = item.media === 'movie' ? String(item.date || '').slice(0, 4) : '';
  return 'https://www.imdb.com/find/?q=' + encodeURIComponent([item.title, year].filter(Boolean).join(' ')) + '&s=tt';
}
// What the link should point at right now: its own page when that is known,
// otherwise a search a click can still improve on.
function calImdbHref(item) {
  if (item.imdb) return item.imdb;
  const tmdbId = imdbTmdbId(item);
  if (tmdbId) {
    const known = imdbLookupCache()[tmdbId];
    if (known) return known;
  }
  return imdbSearchUrl(item);
}
// True while a film's own page is still unknown — the case worth intercepting.
function calImdbPending(item) {
  if (item.imdb) return false;
  const tmdbId = imdbTmdbId(item);
  return Boolean(tmdbId) && !imdbLookupCache()[tmdbId];
}
// The attributes of a link to the release's own IMDb page — the one place they
// are built, so the drawer's title and its ↗, and the title on every tile, cannot
// drift apart. A film's page is not known until it is clicked (see calOpenImdb),
// so such an anchor carries the lookup instead of a final URL: its href is an
// IMDb search of the title, which is where the click lands if the exact page
// cannot be resolved.
function calImdbAttrs(item) {
  const pending = calImdbPending(item)
    ? ' data-act="calendarAction" data-cal="imdb" data-tmdb="' + escapeHTML(imdbTmdbId(item)) +
      '" data-title="' + escapeHTML(item.title) + '" data-date="' + escapeHTML(item.date || '') + '"'
    : '';
  return ' href="' + escapeHTML(calImdbHref(item)) + '" target="_blank" rel="noopener" title="Open on IMDb"' + pending;
}
// Opens IMDb for a title, resolving a film's page first when it is not known yet.
// The tab is opened *inside the click*, before the request goes out: a
// window.open that waits for a response is exactly what browsers block as a
// popup, and the wait here is one cached lookup.
async function calOpenImdb(item) {
  const fallback = imdbSearchUrl(item);
  if (item.imdb) { window.open(item.imdb, '_blank', 'noopener'); return; }
  const tmdbId = imdbTmdbId(item);
  if (!tmdbId) { window.open(fallback, '_blank', 'noopener'); return; }
  const known = imdbLookupCache()[tmdbId];
  if (known) { window.open(known, '_blank', 'noopener'); return; }
  const win = window.open('', '_blank');
  if (!win) { window.location.href = fallback; return; }   // popup blocked: use this tab
  try { win.opener = null; } catch (e) { /* very old browsers */ }
  let url = fallback;
  try {
    const response = await fetch('/.netlify/functions/imdb-id?id=' + encodeURIComponent(tmdbId));
    if (response.ok) {
      const data = await response.json();
      // A null answer is remembered too: a film the source has no IMDb id for
      // must not be looked up again on every single click.
      imdbLookupRemember(tmdbId, data && data.imdb ? data.imdb : '');
      if (data && data.imdb) url = data.imdb;
    }
  } catch (error) { /* the search page is the fallback */ }
  win.location.href = url;
}
// The cinema "platform" the calendar's own function labels a theatre release
// with (the Sheet's own wording for it), as opposed to a service a film
// arrives on.
const CAL_THEATER = 'Theater';
// Both sources are reshaped into one item shape so the grid, the agenda and the
// drawer can share a single renderer and a single filter.
function calIndex(payload, win) {
  const days = {};
  const platformCounts = new Map();
  const movies = [];
  const episodes = [];
  const bump = (name, streaming) => {
    if (!name) return;
    const row = platformCounts.get(name) || { name: name, streaming: false, count: 0 };
    row.count++;
    row.streaming = row.streaming || streaming;
    platformCounts.set(name, row);
  };

  (payload.movies || []).forEach(movie => {
    if (!movie.title || !movie.date) return;
    const providers = Array.isArray(movie.providers) ? movie.providers.filter(Boolean) : [];
    // A cinema release is a platform here (the Sheet's "Theater"), but it is not
    // a service a film *arrives on*: treating it as one would rank a film that
    // is only in cinemas alongside the week's streaming drops.
    const streaming = providers.some(name => name !== CAL_THEATER);
    const film = {
      media: 'movie', id: 'm' + movie.id, title: movie.title, episode: '',
      date: movie.date, time: '', season: 0, number: 0,
      platform: providers[0] || '', platforms: providers, streaming: streaming,
      kind: 'Film', poster: movie.poster || null, rating: Number(movie.rating) || 0,
      weight: Math.max(0, Math.min(100, Number(movie.popularity) || 0)),
      genres: [], premiere: '', url: movie.id ? 'https://www.themoviedb.org/movie/' + movie.id : '',
      // A film's IMDb page is not in TMDB's list response (see imdb-id.js), so it
      // is resolved when the title is clicked — `id` carries the TMDB id the
      // lookup needs.
      imdb: ''
    };
    movies.push(film);
    providers.forEach(name => bump(name, streaming && name !== CAL_THEATER));
  });

  (payload.episodes || []).forEach(episode => {
    if (!episode.title || !episode.date) return;
    const platform = episode.platform || '';
    const show = {
      media: 'episode', id: 'e' + episode.id, title: episode.title, episode: episode.episode || '',
      date: episode.date, time: episode.time || '', season: Number(episode.season) || 0, number: Number(episode.number) || 0,
      platform: platform, platforms: platform ? [platform] : [], streaming: Boolean(episode.streaming),
      kind: episode.kind || '', poster: episode.poster || null, rating: Number(episode.rating) || 0,
      weight: Number(episode.weight) || 0, genres: Array.isArray(episode.genres) ? episode.genres : [],
      premiere: episode.premiere || '', url: calSafeUrl(episode.url),
      // Carried by the calendar function for free; empty for the shows the source
      // has no IMDb id for, which then open an IMDb search instead.
      imdb: calSafeUrl(episode.imdb)
    };
    episodes.push(show);
    bump(platform, Boolean(episode.streaming));
  });

  // The strips that air every single day — a soap, a news bulletin, a talk show —
  // are what turns a month of episodes into an unreadable wall, so the "Episode
  // releases" scope leaves them out. Nothing here is hard-coded: a title whose
  // episodes land on more than a third of the window's days is running daily (a
  // weekly show can only reach a seventh of them), and a kind TVmaze already
  // calls news or talk is one from its first episode.
  const dailyDays = Math.max(CAL_DAILY_FLOOR, Math.round(calDayCount(win.from, win.to) / 3));
  const dailySeen = new Map();
  episodes.forEach(item => {
    const key = dupNormTitle(item.title);
    if (!key) return;
    const row = dailySeen.get(key) || { dates: new Set(), kind: false };
    row.dates.add(item.date);
    row.kind = row.kind || CAL_DAILY_KINDS.has(String(item.kind || '').toLowerCase());
    dailySeen.set(key, row);
  });
  const daily = new Set();
  dailySeen.forEach((row, key) => {
    if (row.kind || row.dates.size >= dailyDays) daily.add(key);
  });

  // Each source is ranked against itself before the two are mixed (see calTrend).
  calPopularity(movies);
  calPopularity(episodes);

  movies.concat(episodes).forEach(item => {
    (days[item.date] = days[item.date] || []).push(item);
  });
  Object.keys(days).forEach(date => {
    days[date].sort((a, b) => calRank(a) - calRank(b) || b.weight - a.weight || a.title.localeCompare(b.title));
  });

  return {
    days: days,
    movies: movies,
    episodes: episodes,
    daily: daily,
    // Streaming services first (that is what a release calendar is usually
    // asked about), then the busiest networks.
    platforms: [...platformCounts.values()].sort((a, b) => Number(b.streaming) - Number(a.streaming) || b.count - a.count || a.name.localeCompare(b.name)),
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    generatedAt: payload.generatedAt || ''
  };
}
// A strip that airs every day is not what "which episode of which show is on
// today" is asking about. A premiere still comes through, and so does anything
// searched for by name — typing the title *is* the request for it.
function calIsDaily(item) {
  const daily = calState.data && calState.data.daily;
  if (!daily || item.premiere) return false;
  if (String(calFilters.search || '').trim()) return false;
  return daily.has(dupNormTitle(item.title));
}
// `opts` overrides the Show select for a single caller: the day drawer asks for
// the whole day rather than for the month's noise dial (see calDayView).
function calMatches(item, opts) {
  const scope = (opts && opts.scope) || calFilters.scope;
  const type = (opts && opts.type) || calFilters.type;
  // An empty value counts as 'all': the platform <select> is rebuilt by the page
  // render, and for the moment before its options are repopulated a select can
  // read back as '' — which must not filter the calendar down to nothing. `opts`
  // can name a platform instead, which is how the platform list judges a
  // candidate without switching the live filter.
  const platform = (opts && opts.platform !== undefined) ? opts.platform : calFilters.platform;
  if (type !== 'all' && item.media !== type) return false;
  const onPlatform = Boolean(platform && platform !== 'all') && (item.platforms || []).indexOf(platform) !== -1;
  // Asking for a platform is asking for that platform's releases — the same call
  // a search makes, and the reason choosing Netflix must not answer with a CBS
  // month. Its own episodes come through even when they are not premieres; the
  // nightly strips still do not, which is what "Everything" is for.
  const askedFor = onPlatform && !calIsDaily(item);
  // The Show select is the noise dial. "New & notable" keeps premieres and films
  // and hides the weekly run of shows already on; "Episode releases" is its other
  // half — every episode of every show on its release day, with neither the films
  // nor the daily strips, which is the only shape in which a month reads as the
  // schedule it is; "Everything" is both sources raw.
  if (scope === 'episodes') {
    if (item.media !== 'episode' || calIsDaily(item)) return false;
  } else if (scope !== 'all' && !askedFor && item.media === 'episode' && !item.premiere) {
    return false;
  }
  if (platform && platform !== 'all' && !onPlatform) return false;
  const query = String(calFilters.search || '').trim().toLowerCase();
  if (query && calTitle(item).toLowerCase().indexOf(query) === -1) return false;
  return true;
}
// What a day you have opened is: the whole day, not the month's noise dial. The
// scope's rules exist so a *month* does not drown — a single day is a day you
// asked about, so they are off here and the drawer lists every show on it. What
// the scope implies about media still holds ("Episode releases" must not start
// listing films), and so do the type, platform and search filters, so the day
// still answers to the toolbar.
function calDayView() {
  const type = calFilters.scope === 'episodes' && calFilters.type === 'all' ? 'episode' : calFilters.type;
  return { scope: 'all', type: type };
}

// ── CALENDAR DATA ────────────────────────────────────────────────────────
// One window is on screen at a time and each one is remembered by key, so
// moving between this year's months (or out to next year and back) only fetches
// what it has never seen.
function calAdopt(entry, key) {
  calState.data = entry.data;
  calState.key = key;
  calState.loadedAt = entry.loadedAt;
  calState.updated = entry.updatedAt;
  calState.status = 'ready';
  calState.error = '';
  // The platform <select> belongs to the payload, so a new payload rebuilds it.
  calState.platformsKey = '';
}
// Drops windows the clock has made obsolete — a month that has ended can never
// be asked for again — and caps what is left, so browsing a year cannot grow the
// map without bound.
function calPruneCache(today) {
  calState.cache.forEach((entry, key) => {
    if (key.split('|')[1] < today) calState.cache.delete(key);
  });
  while (calState.cache.size > CAL_CACHE_MAX) {
    let oldestKey = '';
    let oldestAt = Infinity;
    calState.cache.forEach((entry, key) => {
      if (entry.loadedAt < oldestAt) { oldestAt = entry.loadedAt; oldestKey = key; }
    });
    if (!oldestKey) break;
    calState.cache.delete(oldestKey);
  }
}
// mode '' — paint the window from cache if it is still fresh, else fetch it.
//     'refresh' — always fetch (the background poll, the tab coming back).
//     'fresh' — always fetch, with ?fresh=, which is the only way to bypass the
//               Netlify CDN's own 15-minute copy of the response.
async function loadCalendar(mode) {
  const win = calScopeWindow();
  const key = calWindowKey(win);
  const cached = calState.cache.get(key);
  const hard = mode === 'refresh' || mode === 'fresh';
  if (!hard && cached && Date.now() - cached.loadedAt < CAL_TTL_MS) {
    calAdopt(cached, key);
    updateCalendar();
    return;
  }
  // A copy the page already has — stale, or the window still on screen — is
  // painted straight away and quietly replaced when the fetch lands, so moving
  // between months never flashes a loader for data that is right there.
  if (cached) calAdopt(cached, key);
  const painting = Boolean(calState.data && calState.key === key);
  if (!painting) {
    calState.data = null;
    calState.status = 'loading';
    calState.error = '';
  }
  calState.notice = '';
  updateCalendar();
  try {
    const query = new URLSearchParams({ from: win.from, to: win.to, region: calRegion });
    // "All regions" is a union the function does one region at a time, and it
    // only knows the list the picker offers — so the list travels with the ask.
    if (calRegion === CAL_REGION_ALL) query.set('regions', CAL_REGIONS.map(region => region[0]).join(','));
    if (mode === 'fresh') query.set('fresh', String(Date.now()));
    const response = await fetch(CALENDAR_URL + '?' + query.toString(), { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!response.ok) throw new Error('Calendar service returned ' + response.status);
    const payload = await response.json();
    const entry = {
      data: calIndex(payload, win),
      loadedAt: Date.now(),
      updatedAt: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    };
    calState.cache.set(key, entry);
    calPruneCache(calISO(new Date()));
    calAdopt(entry, key);
  } catch (error) {
    // A refresh that fails keeps the window that is already on screen and says
    // so; only a failure with nothing to show is an error state.
    if (painting) {
      calState.notice = 'Could not refresh right now — showing the last load.';
    } else {
      calState.status = 'error';
      calState.error = error && error.message ? error.message : 'Unable to load the calendar';
    }
  }
  updateCalendar();
}

// ── AUTO-UPDATE ──────────────────────────────────────────────────────────
// A rolling calendar is the clock's, not a deploy's: this notices midnight (the
// "today" marker moves, the month that ended leaves the strip, 1 January rolls
// the two year tabs over) and refetches the open window on a timer. The timers
// are torn down when the tab is left.
function calStopAuto() {
  calTimers.forEach(clearInterval);
  calTimers = [];
}
function calTick() {
  const today = calISO(new Date());
  if (today === calState.dateKey) return false;
  calState.dateKey = today;
  calState.expanded.clear();
  loadCalendar('refresh');
  return true;
}
function calStartAuto() {
  calStopAuto();
  calState.dateKey = calISO(new Date());
  calTimers.push(setInterval(calTick, 60000));
  calTimers.push(setInterval(() => { if (!document.hidden) loadCalendar('refresh'); }, CAL_AUTO_MS));
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !document.getElementById('cal-main')) return;
  calTick();
  if (Date.now() - calState.loadedAt > CAL_AUTO_MS) loadCalendar('refresh');
});

// ── CALENDAR RENDER ──────────────────────────────────────────────────────
function calPosters(scope) {
  if (!scope) return;
  // The src is set after the error handler is attached, so a poster that fails
  // (or that the CSP refuses) degrades to the same placeholder the rest of the
  // app shows instead of a broken-image icon.
  scope.querySelectorAll('img.cal-thumb[data-src]').forEach(img => {
    img.onerror = () => posterFallback(img);
    img.src = img.dataset.src;
  });
}
function calThumbHTML(item) {
  if (item.poster) return '<img class="cal-thumb" alt="" loading="lazy" data-src="' + escapeHTML(item.poster) + '">';
  return '<span class="cal-thumb placeholder" aria-hidden="true">' + (item.media === 'movie' ? '🎬' : '📺') + '</span>';
}
// A tile is a release: its poster, its title and its badges. **The title is the
// IMDb link** — the same destination the drawer's title has, so a title means one
// thing wherever it is — while the rest of the tile (the poster, the badges, the
// gaps between them) opens the day's complete list, which is what a cell of three
// entries needs a way into. The two cannot nest: a link inside a button is
// invalid markup, and a button inside a link would swallow the day. So the day's
// opener is a transparent button laid over the whole tile and the title is lifted
// above it — whichever one you aim at is the one that acts.
function calItemHTML(item, date) {
  const tag = item.media === 'episode' || item.platform
    ? '<span class="cal-tag' + (item.premiere ? ' new' : '') + '">' + escapeHTML(calLabel(item)) + '</span>'
    : '';
  const platform = item.platform ? '<span class="cal-plat">' + escapeHTML(item.platform) + '</span>' : '';
  const seen = calTracked.has(dupNormTitle(item.title)) ? '<span class="cal-tag seen" title="Already in your watchlist">✓</span>' : '';
  const day = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return '<div class="cal-item">' +
      '<button class="cal-item-open" type="button" data-act="calendarAction" data-cal="day" data-date="' + date + '"' +
        ' title="' + escapeHTML(calTitle(item).trim()) + '"' +
        ' aria-label="' + escapeHTML('Everything on ' + day) + '"></button>' +
      calThumbHTML(item) +
      '<span class="cal-item-text"><a class="cal-item-title"' + calImdbAttrs(item) + '>' + escapeHTML(item.title) + '</a>' +
      '<span class="cal-item-meta">' + tag + seen + platform + '</span></span>' +
    '</div>';
}
// "1 episodes" is how a count reads when nobody pluralised it.
const calWord = (count, word) => word + (count === 1 ? '' : 's');
// Counts read as a list of what is actually in the view: a calendar filtered to
// episodes has no business announcing "0 films" beside its episodes. When every
// count is zero the zeros are shown anyway — the drawer's empty line wants a
// number to sit next to.
function calCountParts(counts, bold) {
  const part = (count, word) => (bold ? '<strong>' + count + '</strong>' : count) + ' ' + calWord(count, word);
  const parts = [];
  if (counts.films) parts.push(part(counts.films, 'film'));
  if (counts.episodes) parts.push(part(counts.episodes, 'episode'));
  if (counts.premieres) parts.push(part(counts.premieres, 'premiere'));
  return parts.length ? parts : [part(0, 'release')];
}
function calDayCounts(list) {
  let films = 0, premieres = 0;
  list.forEach(item => {
    if (item.media === 'movie') films++;
    if (item.premiere) premieres++;
  });
  return { films: films, episodes: list.length - films, premieres: premieres };
}
// Filtered items for every day in the window: the single source the grid, the
// agenda and the counts all read from, so they can never disagree.
function calFilteredDays() {
  const days = {};
  if (!calState.data) return days;
  Object.keys(calState.data.days).forEach(date => {
    const list = calState.data.days[date].filter(calMatches);
    if (list.length) days[date] = list;
  });
  return days;
}
// The notable few of a day, not its first few, and not one kind's first few: a
// film opening that Friday and a headline premiere are both what a day is worth
// opening for, and the two sources cannot be ranked against each other by score
// alone (see calTrend — TVmaze's weight saturates, TMDB's popularity does not).
// So the day's most popular film takes the first slot, its best premiere the
// second, and the rest of the cell is the strongest of what is left. A day whose
// films are all below the floor is a day with no film opening to speak of, and
// the cell fills with episodes instead. The counts and the "+N more" are about
// the whole day either way, and the drawer behind that button is the complete day.
const CAL_FILM_FLOOR = 5;  // TMDB popularity below which nobody is looking for the film yet
const calPreview = list => {
  // A title TMDB lists without anyone looking for it yet — the long tail of
  // undated-window filler — does not take a cell slot from a show, or a quiet
  // Saturday would preview three films nobody can watch. A day of *only* those
  // still shows them: something has to be in the cell.
  const known = list.filter(item => item.media !== 'movie' || item.weight >= CAL_FILM_FLOOR);
  const pool = known.length ? known : list;
  const out = [];
  const add = item => { if (item && out.indexOf(item) === -1) out.push(item); };
  const byTrend = pool.slice().sort((a, b) =>
    b.trend - a.trend || b.rating - a.rating || calRank(a) - calRank(b) || a.title.localeCompare(b.title));
  add(byTrend.filter(item => item.media === 'movie')
    .sort((a, b) => b.weight - a.weight || b.rating - a.rating)[0]);
  add(byTrend.filter(item => item.premiere)[0]);
  byTrend.forEach(add);
  return out.slice(0, CAL_PREVIEW);
};
function calGridHTML(month, days, today) {
  const slots = calSlots(month);
  let cells = '';
  slots.forEach(date => {
    if (!date) { cells += '<div class="cal-cell cal-blank" aria-hidden="true"></div>'; return; }
    const list = days[date] || [];
    const dayNum = Number(date.slice(8));
    const classes = ['cal-cell'];
    if (date < today) classes.push('past');
    if (date === today) classes.push('today');
    if (!list.length) classes.push('cal-empty');
    const shown = calPreview(list);
    const preview = shown.map(item => calItemHTML(item, date)).join('');
    // What the button counts is what the cell is *not* showing, which is the wide
    // end of the day rather than a fixed three (see calPreview: a cell can choose
    // to show fewer, and then more of the day is behind the button).
    const hidden = list.length - shown.length;
    const more = hidden > 0
      ? '<button class="cal-more" type="button" data-act="calendarAction" data-cal="day" data-date="' + date + '">+' + hidden + ' more</button>'
      : '';
    const head = '<div class="cal-cell-top"><span class="cal-daynum">' + dayNum + '</span>' +
      (date === today ? '<span class="cal-today-tag">today</span>' : '') +
      (list.length ? '<span class="cal-cell-count" title="' + list.length + ' releases">' + list.length + '</span>' : '') +
      '</div>';
    const label = date === today ? 'Today, ' + list.length + ' releases' : new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + ', ' + list.length + ' releases';
    cells += '<div class="' + classes.join(' ') + '" role="group" aria-label="' + escapeHTML(label) + '">' +
      head + '<div class="cal-cell-body">' + preview + '</div>' + more + '</div>';
  });
  const head = '<div class="cal-grid-head">' + CAL_WEEKDAYS.map(day => '<span>' + day + '</span>').join('') + '</div>';
  return '<div class="cal-grid">' + head + '<div class="cal-grid-body">' + cells + '</div></div>';
}
// Phones get an agenda instead of a seven-column grid — a month of narrow cells
// is unreadable at 375px, and this view also naturally skips empty days.
function calAgendaHTML(month, days) {
  const dates = Object.keys(days).filter(date => date >= month.first && date <= month.last).sort();
  // Wrapped in .cal-agenda even when empty: that class is what keeps this
  // message off desktop, where the grid's own note (.cal-none) says the same
  // thing under a month that still shows its shape.
  if (!dates.length) return '<div class="cal-agenda"><div class="empty-state"><span>🔍</span>Nothing matches these filters in ' + escapeHTML(month.label) + '</div></div>';
  return '<div class="cal-agenda">' + dates.map(date => {
    const list = days[date];
    const shown = calPreview(list);
    const hidden = list.length - shown.length;
    return '<div class="cal-agenda-day">' +
      '<div class="cal-agenda-head">' + escapeHTML(new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })) +
        '<span class="cal-cell-count">' + list.length + '</span></div>' +
      shown.map(item => calItemHTML(item, date)).join('') +
      (hidden > 0 ? '<button class="cal-more" type="button" data-act="calendarAction" data-cal="day" data-date="' + date + '">+' + hidden + ' more</button>' : '') +
    '</div>';
  }).join('') + '</div>';
}
// "updated 14:32" is the visible half of the auto-update: the page fetches
// itself on a timer, so it should be possible to see when it last did.
function calUpdatedHTML() {
  if (!calState.updated || calState.status !== 'ready') return '';
  return ' · <span class="cal-updated" title="The calendar refreshes itself every ' + Math.round(CAL_AUTO_MS / 60000) +
    ' minutes while this tab is open">updated ' + escapeHTML(calState.updated) + '</span>';
}
function calSummaryHTML(parts) {
  return parts.filter(Boolean).join(' · ');
}
// Which filters are in force, named in the summary line. The view opens on
// whatever was chosen last, so a month that is short because of a filter has to
// say so rather than looking like a month with nothing in it.
function calFilterFlagHTML() {
  const bits = [];
  if (calFilters.scope === 'episodes') bits.push('Episode releases');
  else if (calFilters.scope === 'all') bits.push('Everything');
  if (calFilters.type === 'movie') bits.push('films only');
  else if (calFilters.type === 'episode') bits.push('TV only');
  // The platform is the loudest filter of all — one service can be a tenth of a
  // month — so the line that names the filters in force names it too.
  if (calFilters.platform && calFilters.platform !== 'all') bits.push('on ' + calFilters.platform);
  const query = String(calFilters.search || '').trim();
  if (query) bits.push('“' + query + '”');
  return bits.length
    ? '<span class="cal-flag" title="The filters this view is showing">' + escapeHTML(bits.join(' · ')) + '</span>'
    : '';
}

// The two scopes are the two shapes of the same question: this year one month at
// a time, next year as a whole. Their years come from the clock, so the labels
// roll over on 1 January without a deploy.
function calScopeBarHTML() {
  const now = new Date();
  const tab = (scope, year, note) => {
    const active = calState.scope === scope;
    return '<button class="cal-scope-tab' + (active ? ' active' : '') + '" type="button" role="tab" aria-selected="' + String(active) + '"' +
      ' data-act="calendarAction" data-cal="scope" data-scope="' + scope + '">' +
      '<span class="cal-scope-year">' + year + '</span><span class="cal-scope-note">' + note + '</span></button>';
  };
  return '<div class="cal-scopes" role="tablist" aria-label="Year">' +
    tab('year', String(now.getFullYear()), 'month by month') +
    tab('next', String(now.getFullYear() + 1), 'the year ahead') +
    '</div>';
}
// Month tabs are bare month names: they are all inside the year named by the
// scope tab above them, and twelve "October 2026"s do not fit a strip.
function calMonthBarHTML(days) {
  const months = calYearMonths();
  const tabs = months.map((month, index) => {
    const active = index === calState.month;
    return '<button class="cal-month-tab' + (active ? ' active' : '') + '" type="button" role="tab" aria-selected="' + String(active) + '"' +
      ' aria-label="' + escapeHTML(month.label) + '" data-act="calendarAction" data-cal="month" data-index="' + index + '">' +
      escapeHTML(month.short) + '</button>';
  }).join('');
  const month = months[Math.min(calState.month, months.length - 1)] || months[0];
  const monthDays = Object.keys(days).filter(date => date >= month.first && date <= month.last);
  const counts = calDayCounts(monthDays.flatMap(date => days[date]));
  const summary = calState.status === 'ready'
    ? calSummaryHTML([calFilterFlagHTML()].concat(calCountParts(counts, true), ['in ' + escapeHTML(month.label)])) + calUpdatedHTML()
    : '';
  return '<div class="cal-month-bar"><div class="cal-month-tabs" role="tablist" aria-label="Month">' + tabs + '</div>' +
    '<div class="cal-month-sum" id="cal-summary">' + summary + '</div></div>';
}
function calYearSummaryHTML(days) {
  const win = calNextYearWindow();
  const counts = calDayCounts(Object.keys(days).filter(date => date >= win.from && date <= win.to).flatMap(date => days[date]));
  const summary = calState.status === 'ready'
    ? calSummaryHTML([calFilterFlagHTML()].concat(calCountParts(counts, true), ['dated so far in ' + win.year])) + calUpdatedHTML()
    : '';
  return '<div class="cal-month-bar"><div class="cal-month-sum" id="cal-summary">' + summary + '</div></div>';
}

// ── NEXT YEAR, AT A GLANCE ───────────────────────────────────────────────
// One section per month of next year, in the order things arrive. Most of a year
// nobody has finished announcing is white space, so an empty month says so
// rather than rendering nothing, and a month with more than a handful of entries
// opens in place ("Show all") because the payload already holds them.
const CAL_YEAR_PREVIEW = 4;
function calYearRowHTML(item, date) {
  const label = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return '<div class="cal-year-row"><span class="cal-year-date">' + escapeHTML(label) + '</span>' + calItemHTML(item, date) + '</div>';
}
function calYearHTML(days) {
  const win = calNextYearWindow();
  const sections = [];
  for (let month = 0; month < 12; month++) {
    const info = calMonthAt(win.year, month);
    const pick = source => Object.keys(source)
      .filter(date => date >= info.first && date <= info.last)
      .sort()
      .flatMap(date => source[date].map(item => ({ item: item, date: date })));
    const list = pick(days);
    const unfiltered = pick(calState.data.days);
    const counts = calDayCounts(list.map(entry => entry.item));
    const open = calState.expanded.has(month);
    const shown = open ? list : list.slice(0, CAL_YEAR_PREVIEW);
    const hidden = list.length - shown.length;
    // "nothing announced yet" is a claim about the year, so it may only be made
    // when the month really has nothing — a month hidden by the filters says so
    // instead, the same way the month view's .cal-none does.
    const meta = list.length
      ? calCountParts(counts, false).join(' · ')
      : (unfiltered.length ? 'nothing matches these filters' : 'nothing announced yet');
    const toggle = (label, text) => '<button class="cal-more" type="button" data-act="calendarAction" data-cal="expand" data-month="' + month + '">' + label + '</button>';
    sections.push('<section class="cal-year-month' + (list.length ? '' : ' empty') + '">' +
      '<div class="cal-year-head"><h3>' + escapeHTML(MONTHS[month]) + '</h3>' +
        '<span class="cal-year-meta">' + escapeHTML(meta) + '</span></div>' +
      (shown.length ? '<div class="cal-year-items">' + shown.map(entry => calYearRowHTML(entry.item, entry.date)).join('') + '</div>' : '') +
      (hidden > 0 ? toggle('Show all ' + list.length, 'more') : '') +
      (open && list.length > CAL_YEAR_PREVIEW ? toggle('Show less', 'less') : '') +
    '</section>');
  }
  return '<div class="cal-year">' + sections.join('') + '</div>';
}
function calLoadLabel() {
  if (calState.scope === 'next') return 'Fetching everything dated for ' + calNextYearWindow().year + '…';
  const months = calYearMonths();
  const month = months[Math.min(calState.month, months.length - 1)] || months[0];
  return 'Fetching ' + month.label + '…';
}
// "Episode releases" and "Films only" cannot both hold, and the pair would paint
// an empty month that reads as a data problem. The film option is disabled while
// the episode scope is on, and a choice left over from before falls back.
function calSyncTypeSelect() {
  const select = document.getElementById('cal-type');
  if (!select) return;
  const films = select.querySelector('option[value="movie"]');
  const episodesScope = calFilters.scope === 'episodes';
  if (films) films.disabled = episodesScope;
  if (episodesScope && calFilters.type === 'movie') {
    calFilters.type = 'all';
    select.value = 'all';
  }
}
function updateCalendar() {
  const main = document.getElementById('cal-main');
  if (!main) return;
  calSyncTypeSelect();

  if (calState.status === 'loading' && !calState.data) {
    main.innerHTML = '<div class="cal-loading"><div class="loader-bar"><div class="loader-fill"></div></div>' +
      '<p>' + escapeHTML(calLoadLabel()) + '</p></div>';
    return;
  }
  if (calState.status === 'error' && !calState.data) {
    main.innerHTML = '<div class="note-card note-card-wide"><div class="note-icon" aria-hidden="true">⚠️</div>' +
      '<div class="note-body"><strong>Couldn\'t load the release calendar.</strong>' + escapeHTML(calState.error) + '</div></div>' +
      '<div class="cal-retry"><button class="try-btn" type="button" data-act="calendarAction" data-cal="retry">↻ Try again</button></div>';
    return;
  }

  calTracked = calTrackedTitles();
  const data = calState.data;
  if (!data) return;
  const today = calISO(new Date());
  const months = calYearMonths();
  const month = months[Math.min(calState.month, months.length - 1)] || months[0];
  // The platform filter's options come from the loaded window: every platform
  // with a release in it (see the note on CAL_PLATFORM_CAP), which is what keeps
  // the services you watch choosable in a thin month or a year at a glance. Each
  // candidate is judged as though it were the chosen one — `platform:` in `opts`
  // — so an option can never paint an empty calendar, and a platform that is
  // merely unrepresented in this window stays offered (it is in `data.platforms`),
  // so a remembered filter is not silently reset by a month that lacks it.
  //
  // This has to run *before* anything is painted, because the platform in force
  // decides what the paint contains. A stored platform the window does not carry
  // at all — a service whose releases are gone — otherwise left an empty month
  // whose select and summary line still named it; dropping it first is what keeps
  // the select, the summary and the grid from ever disagreeing.
  const offered = new Set();
  Object.keys(data.days).forEach(date => {
    data.days[date].forEach(item => {
      (item.platforms || (item.platform ? [item.platform] : [])).forEach(name => {
        if (calMatches(item, { platform: name })) offered.add(name);
      });
    });
  });
  const options = data.platforms
    .filter(platform => platform.name && (offered.has(platform.name) || platform.name === calFilters.platform))
    .slice(0, CAL_PLATFORM_CAP);
  const settled = options.some(platform => platform.name === calFilters.platform) ? calFilters.platform : 'all';
  const platformKey = options.map(platform => platform.name).join('|');
  if (platformKey !== calState.platformsKey) {
    calState.platformsKey = platformKey;
    const select = document.getElementById('cal-plat');
    if (select) {
      select.innerHTML = '<option value="all">All platforms</option>' + options
        .map(platform => '<option value="' + escapeHTML(platform.name) + '">' + escapeHTML(platform.name) + ' · ' + platform.count + '</option>').join('');
      select.value = settled;
    }
  }
  if (calFilters.platform !== settled) {
    calFilters.platform = settled;
    const select = document.getElementById('cal-plat');
    if (select) select.value = settled;
  }

  const days = calFilteredDays();

  const bar = document.getElementById('cal-months');
  if (bar) bar.innerHTML = calScopeBarHTML() + (calState.scope === 'year' ? calMonthBarHTML(days) : calYearSummaryHTML(days));
  // When the month strip has to scroll (phones), the selected month is the one
  // that matters — and after a rebuild it can be sitting off-screen behind the
  // strip's own scroll position.
  const tabs = document.querySelector('.cal-month-tabs');
  const activeTab = tabs && tabs.querySelector('.cal-month-tab.active');
  if (tabs && activeTab && tabs.scrollWidth > tabs.clientWidth + 4) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // The two pills follow the view: the selected month this year, the whole of
  // next year. The summary line above them says which period it is.
  const period = calState.scope === 'year'
    ? { from: month.first, to: month.last }
    : { from: calNextYearWindow().from, to: calNextYearWindow().to };
  const counts = calDayCounts(Object.keys(days).filter(date => date >= period.from && date <= period.to).flatMap(date => days[date]));
  const mCount = document.getElementById('cal-mcount');
  const eCount = document.getElementById('cal-ecount');
  if (mCount) mCount.textContent = counts.films;
  if (eCount) eCount.textContent = counts.episodes;

  const warnings = data.warnings.length
    ? '<div class="cal-warn"><strong>Partially loaded</strong>' + escapeHTML(data.warnings.join(' · ')) + '</div>'
    : '';
  const notice = calState.notice ? '<div class="cal-notice">' + escapeHTML(calState.notice) + '</div>' : '';
  if (calState.scope === 'next') {
    main.innerHTML = warnings + notice + calYearHTML(days);
  } else {
    const monthDays = Object.keys(days).filter(date => date >= month.first && date <= month.last);
    const none = monthDays.length ? '' : '<div class="cal-none">Nothing matches these filters in ' + escapeHTML(month.label) + ' — try “Everything” or a different platform.</div>';
    main.innerHTML = warnings + notice + calGridHTML(month, days, today) + calAgendaHTML(month, days) + none;
  }
  calPosters(main);
  paintCalDrawer();
}

// ── DAY DRAWER ───────────────────────────────────────────────────────────
// The complete list for one day. The grid can only ever show three entries a
// cell, so this is where "every single thing" is actually readable.
function calRowHTML(item) {
  // Both links — the title and the ↗ affordance — go to IMDb, so a release has
  // one destination and no way to land on a source API by accident (the
  // attributes are built by calImdbAttrs, the same ones a tile's title uses).
  const imdb = calImdbAttrs(item);
  const meta = [];
  if (item.media === 'episode') meta.push(escapeHTML(calLabel(item)));
  if (item.platform) meta.push(escapeHTML(item.platform));
  if (item.time) meta.push(escapeHTML(item.time));
  if (item.kind) meta.push(escapeHTML(item.kind));
  const genres = item.genres.length ? '<span class="cal-row-genres">' + escapeHTML(item.genres.join(' · ')) + '</span>' : '';
  const rating = item.rating > 0 ? '<span class="cal-row-rating">' + ratingStars(item.rating) + '</span>' : '';
  const seen = calTracked.has(dupNormTitle(item.title)) ? '<span class="cal-tag seen" title="Already in your watchlist">✓ in your list</span>' : '';
  return '<div class="cal-row">' + calThumbHTML(item) +
    '<div class="cal-row-main">' +
      '<div class="cal-row-title">' +
        '<a class="cal-row-imdb"' + imdb + '>' + escapeHTML(item.title) + '</a>' + seen +
      '</div>' +
      (item.episode ? '<div class="cal-row-ep">' + escapeHTML(item.episode) + '</div>' : '') +
      '<div class="cal-row-meta"><span>' + meta.join(' · ') + '</span>' + genres + rating + '</div>' +
    '</div>' +
    '<a class="cal-row-link"' + imdb + '>↗</a>' +
  '</div>';
}
function calDrawerRowsHTML(list) {
  let lastTier = -1;
  return list.map(item => {
    const tier = calRank(item);
    const heading = tier !== lastTier && CAL_TIER_LABELS[tier]
      ? '<div class="cal-row-head">' + escapeHTML(CAL_TIER_LABELS[tier]) + '</div>' : '';
    lastTier = tier;
    return heading + calRowHTML(item);
  }).join('');
}
function paintCalDrawer() {
  const existing = document.getElementById('cal-drawer');
  if (existing) existing.remove();
  const date = calState.openDay;
  if (!date || !calState.data) {
    document.documentElement.classList.remove('cal-lock');
    return;
  }
  const all = calState.data.days[date] || [];
  // The day itself, not the month's noise dial (see calDayView), so opening a
  // date really does show every show on it; "Show all" still lifts the platform,
  // type and search filters for that one day.
  const visible = calState.dayAll ? all : all.filter(item => calMatches(item, calDayView()));
  const counts = calDayCounts(visible);
  const hidden = all.length - visible.length;
  const title = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const summary = calCountParts(counts, false).join(' · ');
  const wrap = document.createElement('div');
  wrap.id = 'cal-drawer';
  wrap.className = 'cal-drawer';
  wrap.innerHTML =
    '<div class="cal-drawer-scrim" data-act="calendarAction" data-cal="close"></div>' +
    '<div class="cal-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="cal-drawer-title" tabindex="-1">' +
      '<div class="cal-drawer-top">' +
        '<div><div class="cal-drawer-title" id="cal-drawer-title">' + escapeHTML(title) + '</div>' +
        '<div class="cal-drawer-sub">' + escapeHTML(summary) + '</div></div>' +
        '<button class="cal-drawer-close" type="button" data-act="calendarAction" data-cal="close" aria-label="Close">✕</button>' +
      '</div>' +
      (hidden > 0 ? '<div class="cal-drawer-note">' + hidden + ' more release' + (hidden === 1 ? '' : 's') + ' here hidden by your filters.' +
        '<button class="cal-drawer-showall" type="button" data-act="calendarAction" data-cal="showall">Show all ' + all.length + '</button></div>' : '') +
      '<div class="cal-drawer-body">' + (visible.length ? calDrawerRowsHTML(visible) : '<div class="cal-row-empty">Nothing here matches the current filters.</div>') + '</div>' +
    '</div>';
  document.body.appendChild(wrap);
  document.documentElement.classList.add('cal-lock');
  calPosters(wrap);
  const panel = wrap.querySelector('.cal-drawer-panel');
  if (panel) panel.focus();
}
// The drawer is appended to <body>, so navigating away has to take it with it.
function calDropDrawer() {
  const el = document.getElementById('cal-drawer');
  if (el) el.remove();
  document.documentElement.classList.remove('cal-lock');
  calState.openDay = '';
  calState.dayAll = false;
}
function calOpenDay(date, opener) {
  calState.openDay = date;
  calState.dayAll = false;
  calState.opener = opener || null;
  paintCalDrawer();
}
function calCloseDay() {
  const opener = calState.opener;
  calState.opener = null;
  calDropDrawer();
  paintCalDrawer();
  // The grid is not rebuilt while the drawer is open, so the button that opened
  // it is still in the document and can take focus back.
  if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
}
// data-act="calendarAction" entry point, dispatched through ACTIONS so the
// markup stays free of inline handlers (see the CSP note at the end of app.js).
function calendarAction(event) {
  const el = this;
  const what = el.dataset.cal;
  if (what === 'day') { calOpenDay(el.dataset.date, el); return; }
  if (what === 'imdb') {
    // Only a title whose own page is still unknown gets here: the handler opens
    // the tab inside this click and points it at the resolved page, so the
    // anchor's own navigation is suppressed rather than racing it.
    event.preventDefault();
    calOpenImdb({
      media: 'movie', id: 'm' + el.dataset.tmdb, title: el.dataset.title || '',
      date: el.dataset.date || '', imdb: ''
    });
    return;
  }
  if (what === 'close') { calCloseDay(); return; }
  if (what === 'showall') { calState.dayAll = true; paintCalDrawer(); return; }
  if (what === 'scope') {
    const scope = el.dataset.scope === 'next' ? 'next' : 'year';
    if (scope === calState.scope) return;
    calState.scope = scope;
    calState.expanded.clear();
    loadCalendar('');
    return;
  }
  if (what === 'month') {
    const index = Number(el.dataset.index) || 0;
    if (index === calState.month) return;
    calState.month = index;
    loadCalendar('');
    return;
  }
  if (what === 'expand') {
    const month = Number(el.dataset.month);
    if (calState.expanded.has(month)) calState.expanded.delete(month);
    else calState.expanded.add(month);
    updateCalendar();
    return;
  }
  if (what === 'refresh' || what === 'retry') { loadCalendar('fresh'); return; }
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && calState.openDay) calCloseDay();
});

function renderCalendar() {
  calState.opener = null;
  const regionOptions = '<option value="' + CAL_REGION_ALL + '">All regions</option>' +
    CAL_REGIONS.map(region => '<option value="' + region[0] + '">' + escapeHTML(region[1]) + '</option>').join('');
  document.getElementById('app').innerHTML =
    '<div class="page-header">' +
      '<div class="ph-left"><h1>Release Calendar</h1><p>Rolling: this year month by month, next year at a glance · films from TMDB, episodes from TVmaze</p></div>' +
      '<div class="ph-right">' +
        '<div class="dh-pill">🎬 <strong id="cal-mcount">—</strong> films</div>' +
        '<div class="dh-pill">📺 <strong id="cal-ecount">—</strong> episodes</div>' +
      '</div>' +
    '</div>' +
    '<div class="data-filters cal-filters">' +
      '<div class="df-select"><select id="cal-scope" aria-label="Show" data-filter="calFilters.scope" data-rebuild="calendar">' +
        '<option value="new">New &amp; notable</option>' +
        '<option value="episodes" title="Every episode releasing. Left out: films, news and talk shows, and anything that airs every day">Episode releases</option>' +
        '<option value="all">Everything</option></select></div>' +
      '<div class="df-select"><select id="cal-type" aria-label="Type" data-filter="calFilters.type" data-rebuild="calendar">' +
        '<option value="all">Films &amp; TV</option><option value="movie">Films only</option><option value="episode">TV only</option></select></div>' +
      '<div class="df-select"><select id="cal-plat" aria-label="Platform" data-filter="calFilters.platform" data-rebuild="calendar">' +
        '<option value="all">All platforms</option></select></div>' +
      '<div class="df-select"><select id="cal-region" aria-label="Film release region">' + regionOptions + '</select></div>' +
      '<div class="df-divider"></div>' +
      '<div class="df-search">' +
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.5" cy="6.5" r="5" stroke="#7a9e8a" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="#7a9e8a" stroke-width="1.5" stroke-linecap="round"/></svg>' +
        '<input id="cal-search" type="text" aria-label="Search titles" placeholder="Search titles…" data-filter="calFilters.search" data-rebuild="calendar">' +
      '</div>' +
      '<button class="tool-btn" type="button" data-act="calendarAction" data-cal="refresh" title="Fetch the calendar again, bypassing the cache">↻ Refresh</button>' +
    '</div>' +
    '<div id="cal-months"></div>' +
    '<div class="cal-main" id="cal-main"></div>' +
    '<div class="footer">Release data: <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVmaze</a> (CC BY-SA) and <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a></div>';

  // The selects are rebuilt by the page render, so a filter kept across a tab
  // switch has to be put back into them.
  const keep = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  keep('cal-scope', calFilters.scope);
  keep('cal-type', calFilters.type);
  keep('cal-plat', calFilters.platform);
  const search = document.getElementById('cal-search');
  if (search) search.value = calFilters.search;
  const region = document.getElementById('cal-region');
  if (region) {
    region.value = calRegion;
    region.addEventListener('change', () => {
      calRegion = region.value;
      try { localStorage.setItem('ct-cal-region', calRegion); } catch (e) {}
      // A region is a different window key, so this is a first load for it — and
      // the CDN may already hold the same region from another device, which
      // ?fresh= is what gets past.
      loadCalendar('fresh');
    });
  }
  // This render has just written a fresh platform <select> holding only its
  // "All platforms" option, so the options cache must be dropped or
  // updateCalendar() would decide the list is already current and leave the
  // dropdown empty for the rest of the visit.
  calState.platformsKey = '';
  calStartAuto();
  loadCalendar('');
}

// ── SUGGESTIONS ───────────────────────────────────────────────────────────
// Uniform pick excluding the current suggestion so re-spins try someone new.
function pickFrom(pool, excludeName) {
  const filtered = pool.filter(r => r.name !== excludeName);
  const list = filtered.length ? filtered : pool;
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

function renderSuggestions() {
  const genres = [...new Set(rawData.map(r => r.genre).filter(Boolean))].sort();
  const types  = [...new Set(rawData.map(r => r.type).filter(Boolean))].sort();

  const genreOptions = genres.map(g => `<option value="${escapeHTML(g)}">${escapeHTML(g)}</option>`).join('');
  const typeOptions  = types.map(t  => `<option value="${escapeHTML(t)}">${escapeHTML(t)}</option>`).join('');

  document.getElementById('app').innerHTML = `
    <div class="page-header"><div class="ph-left"><h1>What Should I Watch?</h1><p>Spin for a random pick from your own watchlist — the Submit tab is where you recommend a <em>new</em> title</p></div></div>
    <div class="sugg-page">
      <div class="sugg-inner">
        <div class="sugg-filters">
          <div>
            <label class="sf-label" for="sg-genre">Genre</label>
            <select id="sg-genre" class="sf-select" data-change="updateSuggCount">
              <option value="all">All Genres</option>${genreOptions}
            </select>
          </div>
          <div>
            <label class="sf-label" for="sg-type">Type</label>
            <select id="sg-type" class="sf-select" data-change="updateSuggCount">
              <option value="all">All Types</option>${typeOptions}
            </select>
          </div>
        </div>
        <div class="result-card" id="sugg-card">
          <div class="result-tag">Your Pick</div>
          <div class="result-name empty" id="sugg-name"><span>🎬</span>Hit spin to get a suggestion</div>
          <div class="result-meta" id="sugg-meta"></div>
        </div>
        <button class="spin-btn" id="sugg-spin" data-act="suggSpin">
          <span class="sbi">🎲</span> Spin for a Suggestion
        </button>
        <button class="try-btn" id="sugg-try" data-act="suggTryAgain" disabled>
          <span class="arr">↻</span> Not feeling it — try another
        </button>
        <div class="sugg-count" id="sugg-count"></div>
      </div>
    </div>`;

  updateSuggCount();
}

function getSuggFiltered() {
  const g = document.getElementById('sg-genre')?.value || 'all';
  const t = document.getElementById('sg-type')?.value  || 'all';
  return rawData.filter(r => (g === 'all' || r.genre === g) && (t === 'all' || r.type === t));
}

function updateSuggCount() {
  const pool = getSuggFiltered();
  const el = document.getElementById('sugg-count');
  if (el) el.innerHTML = `<strong>${pool.length}</strong> title${pool.length !== 1 ? 's' : ''} available`;
}

function suggSpin(e) {
  const btn  = document.getElementById('sugg-spin');
  const pool = getSuggFiltered();
  if (!pool.length) { showSuggResult(null); return; }
  btn.disabled = true;
  btn.classList.add('spinning');
  addRipple(btn, e);
  let f = 0;
  const iv = setInterval(() => {
    const t  = pool[Math.floor(Math.random() * pool.length)];
    const ne = document.getElementById('sugg-name');
    if (ne) { ne.textContent = t.name; ne.className = 'result-name'; }
    const me = document.getElementById('sugg-meta');
    if (me) me.innerHTML = '';
    setSuggPoster(null);
    if (++f >= 7) {
      clearInterval(iv);
      const pick = pickFrom(pool, suggLastPick?.name);
      suggLastPick = pick;
      showSuggResult(pick);
      btn.disabled = false;
      btn.classList.remove('spinning');
      const tryBtn = document.getElementById('sugg-try');
      if (tryBtn) tryBtn.disabled = false;
    }
  }, 80);
}

function suggTryAgain() {
  const pool  = getSuggFiltered();
  const pick  = pickFrom(pool, suggLastPick?.name);
  suggLastPick = pick;
  showSuggResult(pick, true);
}

function showSuggResult(item, animate = true) {
  const ne = document.getElementById('sugg-name');
  const me = document.getElementById('sugg-meta');
  if (!ne || !me) return;
  if (!item) {
    ne.className = 'result-name empty';
    ne.innerHTML = '<span aria-hidden="true">😕</span>No matches. Try different filters';
    me.innerHTML = '';
    setSuggPoster(null);
    return;
  }
  ne.className = animate ? 'result-name spinning' : 'result-name';
  if (animate) ne.addEventListener('animationend', () => ne.classList.remove('spinning'), { once: true });
  ne.textContent = item.name;
  setSuggPoster(item);
  const typeEmoji = item.type === 'Movie' ? '🎬' : '📺';
  // Every one of these is stored free text, so it is escaped on the way into
  // the DOM: a genre or type cell is whatever the admin form (or an imported
  // row) put there.
  me.innerHTML = `
    <span class="rm-badge plat">${pe(item.platform)} ${escapeHTML(item.platform)}</span>
    <span class="rm-badge type">${typeEmoji} ${escapeHTML(item.type)}</span>
    <span class="rm-badge genre">🏷️ ${escapeHTML(item.genre)}</span>
    <span class="rm-badge time">⏱ ${escapeHTML(fmtHrs(item.screentime))}</span>`;
  burstConfetti();
}

// Poster for the current pick, created per spin so a title the media API can't
// resolve (which swaps the <img> for a placeholder) never sticks around.
function setSuggPoster(item) {
  const card = document.getElementById('sugg-card');
  if (!card) return;
  const old = document.getElementById('sugg-poster');
  if (old) old.remove();
  if (!item) return;
  const img = document.createElement('img');
  img.className = 'result-poster';
  img.id = 'sugg-poster';
  img.alt = '';
  img.width = 84;
  img.height = 126;
  card.insertBefore(img, card.querySelector('.result-name'));
  loadPoster(item.name, img);
}

function burstConfetti() {
  const card = document.getElementById('sugg-card');
  if (!card) return;
  const cols = ['#40916c', '#f4a261', '#74c69d', '#ffd166', '#2d6a4f'];
  for (let i = 0; i < 12; i++) {
    const dot  = document.createElement('div');
    dot.className = 'confetti-dot';
    const a    = (i / 12) * 360;
    const dist = 40 + Math.random() * 50;
    dot.style.cssText = `left:50%;top:50%;background:${cols[i % cols.length]};--dx:${Math.cos(a * Math.PI / 180) * dist}px;--dy:${Math.sin(a * Math.PI / 180) * dist}px;animation-delay:${i * .02}s;`;
    card.appendChild(dot);
    dot.addEventListener('animationend', () => dot.remove());
  }
}

function addRipple(btn, e) {
  const r2 = btn.getBoundingClientRect();
  const rp = document.createElement('div');
  rp.className = 'ripple';
  rp.style.left = (e.clientX - r2.left - 30) + 'px';
  rp.style.top  = (e.clientY - r2.top  - 30) + 'px';
  btn.appendChild(rp);
  rp.addEventListener('animationend', () => rp.remove());
}

// ── LINE CHART ────────────────────────────────────────────────────────────
// Chart.js can't read CSS variables, so resolve the design tokens here instead
// of hard-coding light-theme colours. initLineChart runs on every render (and
// on theme toggle), so the chart always matches the active theme.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function hexToRgba(hex, alpha) {
  const h = String(hex).replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!isFinite(n)) return 'rgba(45,106,79,' + alpha + ')';
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
}
function initLineChart(canvasId, labels, data) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  if (charts[canvasId]) { try { charts[canvasId].destroy(); } catch (e) {} }
  const lineColor = cssVar('--green', '#2d6a4f');
  const gridColor = cssVar('--border', '#e0ede6');
  const tickColor = cssVar('--text-soft', '#7a9e8a');
  const pointFill = cssVar('--surface', '#ffffff');
  charts[canvasId] = new Chart(el, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        fill: true,
        tension: .4,
        borderColor: lineColor,
        borderWidth: 2.5,
        pointRadius: 5,
        pointBackgroundColor: pointFill,
        pointBorderColor: lineColor,
        pointBorderWidth: 2.5,
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
          g.addColorStop(0, hexToRgba(lineColor, 0.18));
          g.addColorStop(1, hexToRgba(lineColor, 0));
          return g;
        }
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0d1f16',
          titleColor: '#fff',
          bodyColor: 'rgba(255,255,255,.7)',
          padding: 10,
          cornerRadius: 8,
          displayColors: false,
          callbacks: { label: ctx => `${ctx.raw} title${ctx.raw !== 1 ? 's' : ''}` }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 13 }, color: tickColor } },
        y: { grid: { color: gridColor, lineWidth: .8 }, ticks: { font: { family: 'Inter', size: 13 }, color: tickColor }, beginAtZero: true }
      }
    }
  });
}

// ── SUBMIT SUGGESTIONS ───────────────────────────────────────────────────
let suggData = []; // loaded Suggestions rows

async function loadSuggestions() {
  try {
    const res  = await fetch(WATCHLIST_URL + '?sheet=Suggestions', { redirect: 'follow', mode: 'cors' });
    const json = await res.json();
    // Keep only rows shaped like suggestions (a Title column), so an
    // unexpected response can never render as fake suggestions.
    suggData = Array.isArray(json) ? json.filter(r => r.Title !== undefined) : [];
  } catch (e) {
    suggData = [];
  }
}

function renderSubmit() {
  const genres    = [...new Set(rawData.map(r => r.genre).filter(Boolean))].sort();
  const platforms = [...new Set(rawData.map(r => r.platform).filter(Boolean))].sort();

  const genreOpts = genres.map(g => '<option value="' + escapeHTML(g) + '">' + escapeHTML(g) + '</option>').join('');
  const platOpts  = platforms.map(p => '<option value="' + escapeHTML(p) + '">' + escapeHTML(p) + '</option>').join('');

  document.getElementById('app').innerHTML = `
    <div class="page-header">
      <div class="ph-left"><h1>Submit a Suggestion</h1><p>Recommend a show or movie to add to the watchlist</p></div>
    </div>
    <div class="submit-page">
      <div class="submit-left">
        <div class="submit-form-card">
          <h2 class="submit-heading">New Suggestion</h2>
          <p class="submit-sub">Fill in the details below — all submissions are saved straight to the list.</p>

          <div class="sf-field">
            <label class="sf-lbl" for="sf-title">Title <span class="sf-req">*</span></label>
            <input id="sf-title" type="text" class="sf-input" placeholder="e.g. Severance, Dune: Part Two…" required aria-required="true" maxlength="120">
          </div>

          <div class="sf-row">
            <div class="sf-field">
              <label class="sf-lbl" for="sf-type">Type <span class="sf-req">*</span></label>
              <select id="sf-type" class="sf-input" required aria-required="true">
                <option value="Show">Show</option>
                <option value="Movie">Movie</option>
              </select>
            </div>
            <div class="sf-field">
              <label class="sf-lbl" for="sf-genre">Genre</label>
              <select id="sf-genre" class="sf-input">
                <option value="">— Select —</option>
                ${genreOpts}
              </select>
            </div>
          </div>

          <div class="sf-field">
            <label class="sf-lbl" for="sf-plat">Platform</label>
            <select id="sf-plat" class="sf-input">
              <option value="">— Select —</option>
              ${platOpts}
              <option value="Other">Other</option>
            </select>
          </div>

          <div class="sf-field">
            <label class="sf-lbl" for="sf-why">Why watch it?</label>
            <textarea id="sf-why" class="sf-input sf-ta" placeholder="What makes this worth watching? Keep it short…" maxlength="200" data-chars="sf-chars"></textarea>
            <div class="sf-chars"><span id="sf-chars">0</span> / 200</div>
          </div>

          <div id="sf-msg"></div>

          <button class="sf-submit-btn" data-act="submitSuggestion">
            <span>✦</span> Submit Suggestion
          </button>
        </div>
      </div>

      <div class="submit-right">
        <div id="submit-sidebar-content">
          <div class="submit-side-card">
            <div class="submit-side-title">Loading suggestions…</div>
          </div>
        </div>
        <div class="note-card">
          <div class="note-icon">💡</div>
          <div class="note-body"><strong>How it works</strong>Submissions go straight into my suggestions list — they won't automatically appear in the main tracker, they're a wishlist to pick from.</div>
        </div>
      </div>
    </div>`;

  loadSuggestions().then(renderSubmitSidebar);
}

function renderSubmitSidebar() {
  const box = document.getElementById('submit-sidebar-content');
  if (!box) return; // user navigated away before the suggestions loaded
  const topGenre = (() => {
    const m = {};
    suggData.forEach(r => { if (r.Genre) m[r.Genre] = (m[r.Genre] || 0) + 1; });
    const e = Object.entries(m).sort((a,b) => b[1]-a[1]);
    return e[0] ? e[0][0] : '—';
  })();
  const topPlat = (() => {
    const m = {};
    suggData.forEach(r => { if (r.Platform) m[r.Platform] = (m[r.Platform] || 0) + 1; });
    const e = Object.entries(m).sort((a,b) => b[1]-a[1]);
    return e[0] ? e[0][0] : '—';
  })();

  const recent = suggData.slice(-5).reverse();
  const ICONS  = ['🎬','📺','🍿','🎭','📽️'];
  const recentRows = recent.length ? recent.map((r, i) => {
    const meta = [r.Type, r.Genre, r.Platform].filter(Boolean).map(escapeHTML).join(' · ');
    return '<div class="sr-item">' +
      '<div class="sr-icon">' + ICONS[i % ICONS.length] + '</div>' +
      '<div><div class="sr-name">' + escapeHTML(r.Title || '—') + '</div><div class="sr-meta">' + (meta || '—') + '</div></div>' +
    '</div>';
  }).join('') : '<div class="sr-empty">😶 Apparently nobody wants me to watch anything. Rude.</div>';

  document.getElementById('submit-sidebar-content').innerHTML =
    '<div class="submit-side-card">' +
      '<div class="submit-side-title">Recent Suggestions</div>' +
      recentRows +
    '</div>' +
    '<div class="submit-side-card">' +
      '<div class="submit-side-title">Stats</div>' +
      '<div class="sr-stat"><span class="sr-stat-l">Total suggestions</span><span class="sr-stat-r">' + suggData.length + '</span></div>' +
      '<div class="sr-stat"><span class="sr-stat-l">Top genre</span><span class="sr-stat-r">' + escapeHTML(topGenre) + '</span></div>' +
      '<div class="sr-stat"><span class="sr-stat-l">Top platform</span><span class="sr-stat-r">' + escapeHTML(topPlat) + '</span></div>' +
    '</div>';
}

async function submitSuggestion() {
  const title = document.getElementById('sf-title').value.trim();
  const type  = document.getElementById('sf-type').value;
  const genre = document.getElementById('sf-genre').value;
  const plat  = document.getElementById('sf-plat').value;
  const why   = document.getElementById('sf-why').value.trim();
  const msg   = document.getElementById('sf-msg');

  if (!title) {
    msg.innerHTML = '<div class="sf-error">Please enter a title.</div>';
    document.getElementById('sf-title').focus();
    return;
  }

  const btn = document.querySelector('.sf-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Submitting…';
  msg.textContent = '';

  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  try {
    const res  = await fetch('/.netlify/functions/suggestions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Title: title, Type: type, Genre: genre, Platform: plat, Note: why, Date: today }) });
    const json = await res.json();

    if (!json || json.status !== 'ok') {
      msg.innerHTML = '<div class="sf-error">' + escapeHTML(json && json.error ? json.error : 'Could not save the suggestion. Please try again.') + '</div>';
      btn.disabled = false;
      btn.innerHTML = '<span>✦</span> Submit Suggestion';
      return;
    }

    msg.innerHTML = '<div class="sf-success">✓ Suggestion submitted! It\'s now in the suggestions list.</div>';
    // Clear form
    ['sf-title','sf-why'].forEach(id => document.getElementById(id).value = '');
    ['sf-genre','sf-plat'].forEach(id => document.getElementById(id).selectedIndex = 0);
    document.getElementById('sf-chars').textContent = '0';
    // Reload sidebar
    await loadSuggestions();
    renderSubmitSidebar();
  } catch (e) {
    msg.innerHTML = '<div class="sf-error">Something went wrong. Please try again.</div>';
  }

  btn.disabled = false;
  btn.innerHTML = '<span>✦</span> Submit Suggestion';
}

// ── INIT ──────────────────────────────────────────────────────────────────

/* ── Delegated markup handlers ────────────────────────────────────────────
   The generated markup used to carry inline on* attributes and one style=
   attribute. Either one forces 'unsafe-inline' into the deployed policy, and
   with 'unsafe-inline' in script-src the policy stops restricting script
   execution at all — so the header set could not contain a compromised response,
   which is the only thing it exists for. Every handler is now a data attribute
   read by the three listeners below, and the label's styling is a class
   (.ph-filter-label in styles.css).

   The pagination controls carry data-page-step, not data-page: the nav tabs
   already use data-page for the page they point at, and a shared name meant one
   document-level listener stepped the Data table's page counter on every tab
   click — you would return to Data on page 1 with nothing to explain it.

   Two details are load-bearing:
     * filter objects are looked up by NAME on each dispatch rather than captured
       in a table at load time. datFilters is reassigned wholesale by the Data
       tab's reset, so a captured reference would silently stop applying filters
       after a reset — and that failure would read as a broken table, not as a
       detached object.
     * the call mirrors the inline handler it replaced, argument for argument: an
       on* attribute received whatever its string passed, and its `this` was the
       element, so the event is passed first and `this` is bound to the element.
       suggSpin reads clientX/clientY off that event to place its ripple.
     * data-act and data-change both name a function in ACTIONS; which attribute an
       element carries is what decides the event it fires on. */
const ACTIONS = { suggSpin, suggTryAgain, submitSuggestion, updateSuggCount, calendarAction };

// Read the live bindings, so a reassignment of any filter object is picked up.
const filterByName = () => ({ curFilters, allFilters, datFilters, calFilters });

function rebuildSection(which) {
  if (which === 'currentYear') updateCurrentYear();
  else if (which === 'allTime') updateAllTime();
  else if (which === 'dataTable') updateDataTable();
  else if (which === 'suggCount') updateSuggCount();
  else if (which === 'calendar') updateCalendar();
}

function applyDelegated(el, event, attr) {
  if (attr === 'data-filter') {
    const [objName, key] = String(el.dataset.filter).split('.');
    const target = filterByName()[objName];
    if (!target || !(key in target)) return;
    target[key] = el.value;
    if (el.hasAttribute('data-page-reset')) dataPageNum = 1;
    rebuildSection(el.dataset.rebuild);
    // The calendar keeps its filters across visits, so a change has to reach the
    // device it was made on.
    if (objName === 'calFilters') calSaveFilters();
    return;
  }
  if (attr === 'data-page-step') {
    dataPageNum += el.dataset.pageStep === 'next' ? 1 : -1;
    updateDataTable();
    return;
  }
  if (attr === 'data-chars') {
    const out = document.getElementById(el.dataset.chars);
    if (out) out.textContent = el.value.length;
    return;
  }
  const action = el.dataset.act || el.dataset.change;
  const fn = ACTIONS[action];
  if (typeof fn === 'function') fn.call(el, event);
}

// One attribute list per event type, so a control only ever fires on the event
// its inline handler used to. Without this a <select> would also be dispatched
// from the click that precedes its change.
const DELEGATED = {
  click: ['data-act', 'data-page-step'],
  change: ['data-filter', 'data-change'],
  input: ['data-filter', 'data-chars'],
};

function onDelegated(event) {
  for (const attr of DELEGATED[event.type] || []) {
    const el = event.target.closest ? event.target.closest('[' + attr + ']') : null;
    if (el) { applyDelegated(el, event, attr); return; }
  }
}
document.addEventListener('click', onDelegated);
document.addEventListener('change', onDelegated);
document.addEventListener('input', onDelegated);

/* ── Bar widths ───────────────────────────────────────────────────────────
   The four progress fills carry a data-w percentage instead of a style=
   attribute. style-src is 'self', so the attribute would be refused and the bar
   would paint at zero; a custom property written through CSSOM is not covered
   by style-src, so the same value survives the policy. The value is clamped
   because an invalid custom property makes width revert to auto, i.e. the bar
   would fill its whole track — the opposite of what it means.

   An observer rather than a paint call at each render: the bars are emitted from
   several template strings, and the Data / All-time tables repaint on their own
   after a filter change, so a hand-kept list of call sites would rot the first
   time someone adds a bar. Observer callbacks run before paint, so no flash. */
function setBarWidth(bar) {
  const pct = Number(bar.dataset.w);
  bar.style.setProperty('--w', (Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0) + '%');
}

function paintWidths(scope) {
  for (const bar of scope.querySelectorAll('[data-w]')) setBarWidth(bar);
}

new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.hasAttribute('data-w')) setBarWidth(node);
      paintWidths(node);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

bindNavigation();
initTheme();
window.addEventListener('hashchange', () => navigateTo(window.location.hash.slice(1) || 'readme'));
bootData();

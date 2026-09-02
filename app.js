// ── CONFIG ────────────────────────────────────────────────────────────────
const SCRIPT_URL = '/.netlify/functions/watchlist';
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
let suggLastPick = null;
let adminAuthenticated = false;
let adminEditRow = null;
let reloading = false;

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

// Returns a sortable timestamp for a sheet watch date, handling the display
// formats the sheet produces ("29-Aug-26", "29 Aug 2026", ISO "2026-08-29",
// etc). Missing/undatable entries return 0 so they sort to the bottom.
function watchDateTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const iso = toISOFromDisplay(text);
  const date = iso ? new Date(iso) : new Date(text);
  return isNaN(date.getTime()) ? 0 : date.getTime();
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

function initTheme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const apply = () => { btn.textContent = document.documentElement.classList.contains('dark') ? '☀️' : '🌙'; };
  btn.addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('ct-theme', dark ? 'dark' : 'light'); } catch (e) {}
    apply();
  });
  apply();
}

// Poster + public rating + IMDb id — cached per title to avoid hammering TMDB/OMDB.
// Versioned so a schema change (adding imdbId) triggers one refetch pass, then caches forever.
const MEDIA_CACHE = (() => { try { const c = JSON.parse(localStorage.getItem('ct-media-cache') || '{}'); return c && c.v === 2 ? c.items : {}; } catch (e) { return {}; } })();
function saveMediaCache() { try { localStorage.setItem('ct-media-cache', JSON.stringify({ v: 2, items: MEDIA_CACHE })); } catch (e) {} }
function posterFallback(el) { if (el) { el.classList.add('placeholder'); el.textContent = '🎬'; } }
// Read-only star display for a 0-10 rating (IMDb/TMDB scale), plus the number.
function ratingStars(value) {
  const v = Number(value);
  if (!isFinite(v) || v <= 0) return '<span class="rt-na">—</span>';
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
      a.innerHTML = el.innerHTML;
      el.replaceWith(a);
    } else {
      el.href = 'https://www.imdb.com/title/' + imdbId + '/';
    }
  }
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
    const res = await fetch('/.netlify/functions/tmdb-search?' + new URLSearchParams({ title, light: '1' }), { credentials: 'same-origin' });
    const data = res.ok ? (await res.json()) : null;
    const meta = { poster: data?.poster || null, rating: Number(data?.rating) || null, imdbId: data?.imdbId || null };
    MEDIA_CACHE[key] = meta;
    saveMediaCache();
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
// Sequential loader for the visible data page (gentle on the API).
async function loadVisiblePosters(container) {
  const imgs = container ? Array.from(container.querySelectorAll('img[data-poster]')) : [];
  for (const img of imgs) await loadPoster(img.dataset.poster, img);
}

function bindNavigation() {
  document.querySelectorAll('.nav-tab, .nav-brand').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      navigateTo(link.dataset.page || 'readme');
    });
  });
}

// ── DATA LOADING ──────────────────────────────────────────────────────────
// loadData(skipRerender): normally it re-renders the current page after a
// data refresh. Pass true when you're on a stateful page (the admin form)
// and want to refresh rawData WITHOUT tearing down the DOM and losing form
// state / messages.
async function loadData(skipRerender) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(SCRIPT_URL, { redirect: 'follow', mode: 'cors', signal: controller.signal, cache: 'default' });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('Data service returned ' + res.status);
    const json = await res.json();
    rawData = json.map(r => ({
      name:       r.Name       || r.name       || '',
      season:     r.Season     || r.season     || '',
      type:       r.Type       || r.type       || '',
      genre:      r['Details/Genre'] || r.Genre || r.genre || '',
      platform:   normalizePlatform(r.Platform   || r.platform   || ''),
      episodes:   parseInt(r['Episode Count'] || r['Episode Count '] || r.episodes || 0) || 0,
      screentime: parseFloat(r.Screentime || r.screentime || 0) || 0,
      // Unify stored date formats into ISO (dd-MMM-yy stays as-is when unparsable).
      watchDate:  toISOFromDisplay(r['Watch Date'] || r.watchDate || '') || (r['Watch Date'] || r.watchDate || ''),
      month:      r.Month      || r.month      || '',
      row:        Number(r._row || r.row || 0),
      year:       parseInt(r.Year || r.year || 0) || 0
    })).filter(r => r.name && r.year > 0);
  } catch (e) {
    console.warn('Data load failed:', e);
    rawData = [];
  }
  document.getElementById('loading').classList.add('hide');
  if (!skipRerender) navigateTo(window.location.hash.slice(1) || 'readme', false);
}

// ── UTILS ─────────────────────────────────────────────────────────────────
const maxYear  = () => rawData.length ? Math.max(...rawData.map(r => r.year)) : new Date().getFullYear();
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

function navigateTo(page, updateHash = true) {
  destroyCharts();
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  document.getElementById('app').innerHTML = '';
  if (updateHash && window.location.hash.slice(1) !== page) window.location.hash = page;
  const pages = { readme: renderReadme, current: renderCurrentYear, alltime: renderAllTime, data: renderData, timeline: renderTimeline, suggestions: renderSuggestions, submit: renderSubmit, admin: renderAdmin };
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
  const genres = [...new Set(rawData.map(row => row.genre).filter(Boolean))].sort();
  const platforms = [...new Set(rawData.map(row => row.platform).filter(Boolean))].sort();
  const genreOpts = genres.map(genre => `<option value="${escapeHTML(genre)}">${escapeHTML(genre)}</option>`).join('');
  const platOpts = platforms.map(platform => `<option value="${escapeHTML(platform)}">${escapeHTML(platform)}</option>`).join('');

  document.getElementById('app').innerHTML = `
    <div class="page-header"><div class="ph-left"><h1>Admin</h1><p>Add a title directly to the live watchlist</p></div></div>
    <div class="submit-page"><div class="submit-left"><div class="submit-form-card">
      <h2 class="submit-heading" id="admin-form-heading">New Watchlist Entry</h2><p class="submit-sub" id="admin-form-sub">Saved through the protected admin service.</p>
      <form id="admin-entry-form">
        <div class="sf-field"><label class="sf-lbl" for="admin-name">Name <span class="sf-req">*</span></label><div class="admin-name-row"><input id="admin-name" name="name" class="sf-input" maxlength="160" required><button id="admin-check-name" class="try-btn admin-check-btn" type="button">Check sheet</button><button id="admin-autofill" class="try-btn admin-autofill-btn" type="button">Autofill</button></div><div id="admin-name-result" class="admin-name-result" aria-live="polite"></div></div>
        <div class="sf-row"><div class="sf-field"><label class="sf-lbl" for="admin-type">Type <span class="sf-req">*</span></label><select id="admin-type" name="type" class="sf-input"><option>Movie</option><option>Series/Show</option></select></div><div class="sf-field"><label class="sf-lbl" for="admin-season">Season</label><input id="admin-season" name="season" class="sf-input" maxlength="20"></div></div>
        <div class="sf-row"><div class="sf-field"><label class="sf-lbl" for="admin-genre">Genre</label><select id="admin-genre" name="genre" class="sf-input"><option value="">Select genre</option>${genreOpts}<option value="Other">Other</option></select><input id="admin-genre-custom" class="sf-input sf-custom-value" type="text" maxlength="80" placeholder="Enter a genre" aria-label="Custom genre" hidden></div><div class="sf-field"><label class="sf-lbl" for="admin-platform">Platform</label><select id="admin-platform" name="platform" class="sf-input"><option value="">Select platform</option>${platOpts}<option value="Other">Other</option></select><input id="admin-platform-custom" class="sf-input sf-custom-value" type="text" maxlength="160" placeholder="Enter a platform" aria-label="Custom platform" hidden></div></div>
        <div class="sf-row"><div class="sf-field"><label class="sf-lbl" for="admin-episodes">Episodes</label><input id="admin-episodes" name="episodes" class="sf-input" type="number" min="0" max="9999" inputmode="numeric"></div><div class="sf-field"><label class="sf-lbl" for="admin-screentime">Screentime (mins)</label><input id="admin-screentime" name="screentime" class="sf-input" type="number" min="0" max="100000" inputmode="numeric"></div></div>
        <div class="sf-field"><label class="sf-lbl" for="admin-date">Watch Date</label><input id="admin-date" name="watchDate" class="sf-input" type="date"></div>
        <div id="admin-edit-bar" class="admin-edit-bar" hidden><span>Editing row <strong id="admin-edit-row"></strong></span><button class="try-btn admin-edit-cancel" id="admin-cancel-edit" type="button">Cancel edit</button></div>
        <div id="admin-entry-msg" aria-live="polite"></div><button class="sf-submit-btn" type="submit" id="admin-submit-btn">Add to Watchlist</button>
      </form>
    </div>
    <div class="submit-form-card">
      <h2 class="submit-heading">Edit Existing Entry</h2>
      <p class="submit-sub">Search the tracker, then click <strong>Edit</strong> to load a title into the form above.</p>
      <input id="admin-edit-search" class="sf-input" type="text" placeholder="Search by title…" autocomplete="off">
      <div id="admin-edit-results" class="admin-edit-results" aria-live="polite"></div>
    </div></div><div class="submit-right"><div class="note-card"><div class="note-icon" aria-hidden="true">💡</div><div class="note-body"><strong>Protected entry</strong>The password is checked server-side and is never sent to Google Sheets.</div></div><button class="try-btn" id="admin-lock" type="button">Lock Admin</button></div></div>`;
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
    const meta = [item.type, item.season ? 'S' + escapeHTML(item.season) : '', item.year].filter(Boolean).join(' · ');
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
  document.getElementById('admin-form-sub').textContent = 'Update row ' + rowNumber + ' — changes are saved to the Google Sheet.';
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
  const msg = () => document.getElementById('admin-entry-msg');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch('/.netlify/functions/admin-entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'delete', row: rowNumber }), signal: controller.signal });
    clearTimeout(timeout);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = result.diagnostics
        ? ` [${result.code || 'ERROR'}${result.diagnostics.httpStatus ? ` · HTTP ${result.diagnostics.httpStatus}` : ''}${result.diagnostics.upstreamMessage ? ` · ${result.diagnostics.upstreamMessage}` : ''}]`
        : '';
      throw new Error((result.error || 'Unable to delete entry') + detail);
    }
    // Reload the whole page so the deletion is reflected everywhere.
    msg().innerHTML = `<div class="sf-success">Entry deleted${result.rowNumber ? ' (row ' + escapeHTML(result.rowNumber) + ')' : ''}. Reloading…</div>`;
    reloading = true;
    setTimeout(() => window.location.reload(), 900);
  } catch (error) {
    msg().innerHTML = `<div class="sf-error">${escapeHTML(error.message)}</div>`;
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Delete'; }
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
      result.innerHTML = `<div>Found ${matches.length} matching entr${matches.length === 1 ? 'y' : 'ies'} in the sheet.</div>${details}`;
    }
  } catch {
    result.className = 'admin-name-result found';
    result.textContent = 'Could not check the sheet. Try again.';
  } finally {
    button.disabled = false;
    button.textContent = 'Check sheet';
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
  button.classList.add('autofilling');
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
    button.classList.remove('autofilling');
    button.textContent = 'Autofill';
  }
}

async function submitAdminEntry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const msg = document.getElementById('admin-entry-msg');
  const button = form.querySelector('button[type="submit"]');
  const isUpdate = adminEditRow !== null;
  const payload = Object.fromEntries(new FormData(form));
  ['genre', 'platform'].forEach(key => {
    const select = document.getElementById('admin-' + key);
    const custom = document.getElementById('admin-' + key + '-custom');
    if (select.value === 'Other' && custom.value.trim()) payload[key] = custom.value.trim();
  });
  if (isUpdate) {
    payload.action = 'update';
    payload.row = adminEditRow;
  }
  button.disabled = true; button.textContent = 'Saving…'; msg.textContent = '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch('/.netlify/functions/admin-entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload), signal: controller.signal });
    clearTimeout(timeout);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = result.diagnostics
        ? ` [${result.code || 'ERROR'}${result.diagnostics.httpStatus ? ` · HTTP ${result.diagnostics.httpStatus}` : ''}${result.diagnostics.upstreamMessage ? ` · ${result.diagnostics.upstreamMessage}` : ''}]`
        : '';
      throw new Error((result.error || 'Unable to save entry') + detail);
    }
    const savedLocation = result.sheetName && result.rowNumber
      ? ` Saved to ${escapeHTML(result.sheetName)}, row ${escapeHTML(result.rowNumber)}.`
      : '';
    // Leave edit mode, then reload the whole page so the entry shows up everywhere.
    adminEditRow = null;
    document.getElementById('admin-entry-msg').innerHTML = `<div class="sf-success">Entry ${isUpdate ? 'updated' : 'added'} successfully.${savedLocation} Reloading…</div>`;
    reloading = true;
    setTimeout(() => window.location.reload(), 900);
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
  const diff     = cyrST - prevST;
  const diffPct  = prevST ? ((diff / prevST) * 100).toFixed(1) : 0;
  const topPlat  = countBy(rawData, 'platform')[0];
  const topGenre = countBy(rawData, 'genre')[0];
  const bestMo   = Object.entries(countByMonth(rawData)).sort((a, b) => b[1] - a[1])[0];
  const distinctMonths = new Set(rawData.map(r => r.year + '-' + r.month)).size;
  const avgMo    = distinctMonths ? (total / distinctMonths).toFixed(1) : '—';

  // ── Insights + watch goal ────────────────────────────────────────────────
  const dayList = [...new Set(rawData.map(r => r.watchDate ? watchDateTimestamp(r.watchDate) : 0).filter(t => t > 0))].sort((a, b) => a - b);
  let streak = 0, curStreak = 0, prevDay = 0;
  dayList.forEach(t => { curStreak = (!prevDay || t - prevDay <= 90000000) ? curStreak + 1 : 1; prevDay = t; if (curStreak > streak) streak = curStreak; });
  const usedItems = key => countBy(rawData, key).filter(x => String(x[0] || '').toLowerCase() !== 'unknown' && String(x[0] || '').trim() !== '');
  const platList = usedItems('platform'); const leastPlat = platList[platList.length - 1] || ['', 0];
  const genreList = usedItems('genre'); const leastGenre = genreList[genreList.length - 1] || ['', 0];
  let goalHrs = 0, goalYear = ''; try { goalHrs = parseFloat(localStorage.getItem('ct-goal') || '0') || 0; goalYear = String(localStorage.getItem('ct-goal-year') || ''); } catch (e) {}
  const goalLocked = goalHrs > 0 && goalYear === String(cy);
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
  let yoyMonth = null;
  if (latestMo) {
    const cur = cyrData.filter(r => r.month === latestMo);
    const pr = prevData.filter(r => r.month === latestMo);
    yoyMonth = { name: latestMo, curTitles: cur.length, prevTitles: pr.length, curST: cur.reduce((s, r) => s + r.screentime, 0), prevST: pr.reduce((s, r) => s + r.screentime, 0) };
  }

  const deep = {};
  rawData.forEach(r => { const b = String(r.name || '').trim().toLowerCase(); if (b) deep[b] = (deep[b] || 0) + (r.screentime || 0); });
  const deepFranchise = Object.entries(deep).sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const deepCount = rawData.filter(r => String(r.name || '').trim().toLowerCase() === deepFranchise[0]).length;

  const elapsed = latestMo ? (monthIdx[latestMo] + 1) : 0;
  const projectedHrs = elapsed ? Math.round((cyrST / 60) / elapsed * 12) : Math.round(cyrST / 60);
  const paceDiff = Math.round((cyrST / 60) - (goalHrs / 12) * elapsed);
  const cyTopGenre = countBy(cyrData, 'genre')[0] || ['—', 0];
  const cyTopPlat = countBy(cyrData, 'platform')[0] || ['—', 0];
  const cyBestMo = Object.entries(countByMonth(cyrData)).sort((a, b) => b[1] - a[1])[0] || ['—', 0];

  const today    = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  // Pre-compute dynamic classes — avoids single quotes inside template literals
  const diffBadgeClass = diff >= 0 ? 'badge badge-green' : 'badge badge-red';
  const diffSign       = diff >= 0 ? '+' : '';
  const yoyBarWidth    = prevST ? Math.min((cyrST / prevST) * 100, 100) : 50;

  // Recent watches — last 6 titles with a valid watch date, sorted newest first
  const fmtShortDate = s => {
    if (!s) return '';
    var clean = String(s).trim();
    var pre = clean.match(/^(\d{1,2}\s+[A-Za-z]{3})\s+\d{4}$/);
    if (pre) return pre[1];
    var dt = new Date(clean);
    if (!isNaN(dt.getTime())) {
      dt.setDate(dt.getDate() + 1);
      return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    }
    return '';
  };
  const recent = rawData
    .filter(r => r.watchDate)
    .sort((a, b) => new Date(b.watchDate) - new Date(a.watchDate))
    .slice(0, 6);
  const RW_ICONS = ['🎬','📽️','🎭','🍿','📺','🎞️','🎥','🎦','🌟','✨','🎪','🎨'];
  const recentHTML = recent.map((r, i) => {
    const typeClass  = r.type.toLowerCase() === 'movie' ? 'rw-pill movie' : 'rw-pill show';
    const typeLabel  = r.type.toLowerCase() === 'movie' ? 'Movie' : 'Show';
    const icon       = RW_ICONS[i % RW_ICONS.length];
    const genre      = r.genre ? '<span class="rw-genre">' + escapeHTML(r.genre) + '</span>' : '';
    const seasonStr  = r.type && r.type.toLowerCase() !== 'movie'
      ? ' S' + (r.season || '1')
      : '';
    const epsBadge   = r.episodes ? '<span class="rw-genre">' + escapeHTML(r.episodes + ' eps') + '</span>' : '';
    return '<div class="rw-card">' +
      '<div class="rw-emoji">' + icon + '</div>' +
      '<div class="rw-info">' +
        '<div class="rw-name">' + escapeHTML(r.name) + escapeHTML(seasonStr) + '</div>' +
        '<div class="rw-meta">' +
          '<span class="' + typeClass + '">' + typeLabel + '</span>' +
          genre +
          epsBadge +
          '<span class="rw-date">' + escapeHTML(fmtShortDate(r.watchDate)) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  document.getElementById('app').innerHTML = `
    <div class="readme-hero">
      <div class="readme-top">
        <div>
          <h1><em>personal media tracker</em>Content Tracking Dashboard</h1>
          <p class="readme-desc">Track and analyse my media consumption across streaming platforms. See genre trends, platform habits, and how my viewing changes over time.</p>
        </div>
        <div class="readme-updated"><strong>${today}</strong>Last updated</div>
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
          <div class="rs-sub">${fmtK(Math.round(allST))} mins logged</div>
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
        <div class="cards-grid">
          <div class="info-card" onclick="navigateTo('current')"><div class="ic-icon">📅</div><div class="ic-body"><h3>Current Year Numbers</h3><p>This year's stats — shows vs movies, platform breakdown, genre split and monthly viewing trend.</p></div></div>
          <div class="info-card" onclick="navigateTo('alltime')"><div class="ic-icon">📈</div><div class="ic-body"><h3>All Time Numbers</h3><p>Complete viewing history across all years. Filter by year, platform or genre to spot long-term patterns.</p></div></div>
          <div class="info-card" onclick="navigateTo('data')"><div class="ic-icon">🗂️</div><div class="ic-body"><h3>Data</h3><p>Full list of every title logged. Search by name, filter by type, genre, platform or month.</p></div></div>
          <div class="info-card" onclick="navigateTo('suggestions')"><div class="ic-icon gold">🎲</div><div class="ic-body"><h3>Suggestion Generator</h3><p>Can't decide what to watch? Spin for a random pick filtered by genre or type.</p></div></div>
        </div>
        <div class="rw-section">
          <div class="cards-label">Recently Watched</div>
          <div class="rw-strip">${recentHTML}</div>
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
          <div class="recap-bar"><div class="recap-fill" style="width:${100 - stShowsPct}%"></div></div>
          <div class="recap-foot">${100 - stShowsPct}% movies · ${stShowsPct}% shows (by time)</div>
        </div>
      </div>
      <div class="readme-sidebar">
        <div class="fact-card">
          <div class="fact-title">Quick Facts</div>
          <div class="fact-row"><div class="fact-l"><span>🎭</span> Top Genre</div><div class="fact-r">${topGenre ? escapeHTML(topGenre[0]) : '—'}</div></div>
          <div class="fact-row"><div class="fact-l"><span>📆</span> Best Month</div><div class="fact-r">${bestMo ? bestMo[0] : '—'}</div></div>
          <div class="fact-row"><div class="fact-l"><span>📊</span> Avg / Month</div><div class="fact-r">${avgMo} titles</div></div>
          <div class="fact-row"><div class="fact-l"><span>📺</span> Shows</div><div class="fact-r">${total ? (shows / total * 100).toFixed(1) : 0}%</div></div>
          <div class="fact-row"><div class="fact-l"><span>🎬</span> Movies</div><div class="fact-r">${total ? (movies / total * 100).toFixed(1) : 0}%</div></div>
        </div>
        <div class="fact-card">
          <div class="fact-title">Insights</div>
          <div class="ins-row"><div class="ins-l">🔥 Longest binge streak</div><div class="ins-r">${streak} day${streak === 1 ? '' : 's'}</div></div>
          <div class="ins-row"><div class="ins-l">🕒 Screen-time split</div><div class="ins-r">${stShowsPct}%<span class="ins-sub"> shows / ${100 - stShowsPct}% movies</span></div></div>
          <div class="ins-row"><div class="ins-l">📺 Biggest binges</div><div class="ins-r">${escapeHTML(String(bingePlat[0]))}<span class="ins-sub"> ${fmtHrs(bingePlat[1])}/title</span></div></div>
          ${yoyMonth ? `<div class="ins-row"><div class="ins-l">🔄 ${escapeHTML(yoyMonth.name)} ytd</div><div class="ins-r">${yoyMonth.curTitles}<span class="ins-sub"> vs ${yoyMonth.prevTitles} last yr</span></div></div>` : ''}
          <div class="ins-row"><div class="ins-l">🎬 Deepest franchise</div><div class="ins-r">${escapeHTML(String(deepFranchise[0]) || '—')}<span class="ins-sub"> ${fmtHrs(deepFranchise[1])} · ${deepCount}×</span></div></div>
          <div class="ins-cta">👀 Try next — you've watched little ${escapeHTML(String(leastGenre[0]) || 'any genre')}: something on ${escapeHTML(String(leastPlat[0]) || 'any platform')}?</div>
        </div>
        <div class="yoy-card">
          <div class="yoy-title">Year on Year</div>
          <div class="yoy-row">
            <div><div class="yoy-label">This year so far</div><div class="yoy-val">${fmtHrs(cyrST)}</div></div>
            <span class="${diffBadgeClass}">${diffSign}${diffPct}%</span>
          </div>
          <div class="yoy-bar-track"><div class="yoy-bar-fill" style="width:${yoyBarWidth}%"></div></div>
          <div class="yoy-note">vs ${fmtHrs(prevST)} full year ${cy - 1}</div>
        </div>
        <div class="fact-card">
          <div class="goal-top"><div class="fact-title" style="margin-bottom:0">Watch Goal · ${cy}</div><div class="goal-count"><strong>${fmtHrs(cyrST)}</strong> / ${goalHrs} hrs</div></div>
          <div class="goal-track"><div class="goal-fill" style="width:${goalPct}%"></div></div>
          <div class="goal-edit">
            <input id="goal-input" class="sf-input" type="number" min="1" placeholder="Target hrs" value="${goalHrs}" ${goalLocked ? 'disabled' : ''}>
            <button class="try-btn" id="goal-set" type="button" style="width:auto;padding:8px 12px;min-height:0" ${goalLocked ? 'disabled' : ''}>${goalLocked ? 'Locked 🔒' : 'Set'}</button>
          </div>
          <div class="goal-note">${paceDiff >= 0 ? 'On track' : 'Behind'} by ${Math.abs(paceDiff)} hrs · on pace for ${projectedHrs} hrs/yr (last year ${fmtHrs(prevST)}).</div>
          ${goalLocked ? `<div class="goal-note goal-lock-note">🔒 Locked for ${cy} — unlocks to set a new target on 1 Jan.</div>` : ''}
        </div>
        <div class="note-card">
          <div class="note-icon">💡</div>
          <div class="note-body"><strong>About Difference</strong>All difference figures compare screentime to the same metric from the previous year.</div>
        </div>
      </div>
    </div>
    <div class="footer">Data loaded live from Google Sheets · ${total} titles</div>`;

  const goalSet = document.getElementById('goal-set');
  if (goalSet) {
    goalSet.addEventListener('click', () => {
      const input = document.getElementById('goal-input');
      const v = parseFloat(input ? input.value : '0') || 0;
      try {
        localStorage.setItem('ct-goal', v ? String(v) : '0');
        localStorage.setItem('ct-goal-year', String(cy));
      } catch (e) {}
      renderReadme();
    });
  }

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
      <div class="plat-name">${pe(p[0])} ${p[0]}</div>
      <div class="plat-track"><div class="${fillClass}" style="width:${pct}%"></div></div>
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
function phFilter(label, id, onchange, optionsHtml) {
  const span = 'font-size:12px;line-height:16px;text-transform:uppercase;letter-spacing:.8px;color:rgba(255,255,255,.5);margin-right:6px;font-weight:500';
  return `<div class="ph-filter"><span style="${span}">${label}</span><select id="${id}" onchange="${onchange}">${optionsHtml}</select></div>`;
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
        ${phFilter('Platform', 'cf-plat', 'curFilters.platform=this.value;updateCurrentYear()', platOptions)}
        ${phFilter('Genre', 'cf-genre', 'curFilters.genre=this.value;updateCurrentYear()', genreOptions)}
      </div>
    </div>
    <div class="main" id="cy-main"></div>
    <div class="footer" id="cy-footer"></div>`;

  updateCurrentYear();
}

function updateCurrentYear() {
  const cy   = maxYear();
  const base = rawData.filter(r => r.year === cy);
  const d    = filterData(base, curFilters);
  const prev = rawData.filter(r => r.year === cy - 1);

  const shows  = d.filter(r => r.type.includes('Show') || r.type.includes('Series')).length;
  const movies = d.filter(r => r.type.toLowerCase() === 'movie').length;
  const st     = d.reduce((s, r) => s + r.screentime, 0);
  const prevST = prev.reduce((s, r) => s + r.screentime, 0);
  const diff   = st - prevST;
  const diffPct = prevST ? ((diff / prevST) * 100).toFixed(1) : 'N/A';

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
        <div class="kpi-sub"><span class="badge badge-green">${showsPct}%</span> of total · ${totalEpscy} eps</div>
      </div>
      <div class="kpi-card a2">
        <div class="kpi-label">Movies This Year</div>
        <div class="kpi-val">${movies}</div>
        <div class="kpi-sub"><span class="badge badge-gold">${moviesPct}%</span> of total</div>
      </div>
      <div class="kpi-card a3">
        <div class="kpi-label">Screentime This Year</div>
        <div class="kpi-val">${fmtHrs(st)}</div>
        <div class="kpi-sub">Across ${d.length} titles</div>
      </div>
      <div class="${diffCardClass}">
        <div class="kpi-label">Difference YoY</div>
        <div class="${diffValClass}">${diffSign}${diffHrs} <small>hrs</small></div>
        <div class="kpi-sub"><span class="${diffBadgeClass}">${diffSign}${diffPct}%</span> vs last year</div>
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
      <div class="chart-card" style="animation:fadeUp .5s ease .3s both">
        <div class="chart-title">By Genre</div>
        <div class="treemap">${buildTreemap(genCounts, totalGen)}</div>
      </div>
      <div class="stat-sidebar">
        <div class="stat-card a1">
          <div class="stat-info"><div class="stat-label">Top Platform</div><div class="stat-val">${topPlatEmoji} ${topPlatName}</div></div>
          <span class="stat-badge2">${topPlatCount}</span>
        </div>
        <div class="stat-card a2">
          <div class="stat-info"><div class="stat-label">Top Genre</div><div class="stat-val">${topGenre[0]}</div></div>
          <span class="stat-badge2">${genrePct}%</span>
        </div>
        <div class="stat-card a3">
          <div class="stat-info"><div class="stat-label">Best Month</div><div class="stat-val">${bestMo[0]}</div></div>
          <span class="stat-badge2">${bestMo[1]} titles</span>
        </div>
        <div class="stat-card a4">
          <div class="stat-info"><div class="stat-label">Total Watched</div><div class="stat-val">${d.length}</div></div>
          <div class="stat-info"><div class="stat-label" style="margin-top:2px">titles in ${cy}</div></div>
        </div>
      </div>
    </div>`;

  document.getElementById('cy-footer').textContent = `Last updated live from Google Sheets · ${cy} data`;

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
        ${phFilter('Year', 'af-year', 'allFilters.year=this.value;updateAllTime()', yearOptions)}
        ${phFilter('Platform', 'af-plat', 'allFilters.platform=this.value;updateAllTime()', platOptions)}
        ${phFilter('Genre', 'af-genre', 'allFilters.genre=this.value;updateAllTime()', genreOptions)}
      </div>
    </div>
    <div class="main" id="at-main"></div>
    <div class="footer" id="at-footer"></div>`;

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
        <div class="kpi-sub">${fmtK(Math.round(st))} minutes</div>
      </div>
      <div class="kpi-card a3">
        <div class="kpi-label">Shows (All Time)</div>
        <div class="kpi-val">${shows}</div>
        <div class="kpi-sub"><span class="badge badge-green">${showsPct}%</span> of total · ${totalEpsat} eps</div>
      </div>
      <div class="kpi-card a4">
        <div class="kpi-label">Movies (All Time)</div>
        <div class="kpi-val">${movies}</div>
        <div class="kpi-sub"><span class="badge badge-gold">${moviesPct}%</span> of total</div>
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
      <div class="chart-card" style="animation:fadeUp .5s ease .3s both">
        <div class="chart-title">By Genre</div>
        <div class="treemap">${buildTreemap(genCounts, totalGen)}</div>
      </div>
      <div class="stat-sidebar">
        <div class="stat-card a1">
          <div class="stat-info"><div class="stat-label">Top Platform</div><div class="stat-val">${pe(topPlat[0])} ${topPlat[0]}</div></div>
          <span class="stat-badge2">${topPlat[1]} titles</span>
        </div>
        <div class="stat-card a2">
          <div class="stat-info"><div class="stat-label">Top Genre</div><div class="stat-val">${topGenre[0]}</div></div>
          <span class="stat-badge2">${genrePct}%</span>
        </div>
        <div class="stat-card a3">
          <div class="stat-info"><div class="stat-label">Best Month</div><div class="stat-val">${bestMo[0]}</div></div>
          <span class="stat-badge2">${bestMo[1]} titles</span>
        </div>
        <div class="stat-card a4">
          <div class="stat-info"><div class="stat-label">Avg Per Month</div><div class="stat-val">${avgMo}</div></div>
          <div class="stat-info"><div class="stat-label" style="margin-top:2px">titles / month</div></div>
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
        <div style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,.7)">📺 <strong id="dh-shows" style="color:#fff">—</strong> shows</div>
        <div style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,.7)">🎬 <strong id="dh-movies" style="color:#fff">—</strong> movies</div>
        <div style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,.7)">Total <strong id="dh-total" style="color:#fff">—</strong></div>
      </div>
    </div>
    <div class="data-filters">
      <div class="df-select"><select id="df-year"  onchange="datFilters.year=this.value;dataPageNum=1;updateDataTable()">${yearOpts}</select></div>
      <div class="df-select"><select id="df-plat"  onchange="datFilters.platform=this.value;dataPageNum=1;updateDataTable()">${platOpts}</select></div>
      <div class="df-select"><select id="df-type"  onchange="datFilters.type=this.value;dataPageNum=1;updateDataTable()">${typeOpts}</select></div>
      <div class="df-select"><select id="df-genre" onchange="datFilters.genre=this.value;dataPageNum=1;updateDataTable()">${genreOpts}</select></div>
      <div class="df-select"><select id="df-month" onchange="datFilters.month=this.value;dataPageNum=1;updateDataTable()">${monthOpts}</select></div>
      <div class="df-divider"></div>
      <div class="df-search">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="#7a9e8a" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="#7a9e8a" stroke-width="1.5" stroke-linecap="round"/></svg>
        <input id="df-search" type="text" placeholder="Search by name…" oninput="datFilters.search=this.value;dataPageNum=1;updateDataTable()">
      </div>
    </div>
    <div class="data-main">
      <div class="data-header-row">
        <div class="data-count" id="dat-count"></div>
        <div class="data-tools">
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
    const key = th.dataset.sort;
    if (dataSort.key === key) dataSort.dir = dataSort.dir === 'asc' ? 'desc' : 'asc';
    else dataSort = { key: key, dir: key === 'watchDate' ? 'desc' : 'asc' };
    dataPageNum = 1;
    updateDataTable();
  });
  applyDataFilters();
  updateDataTable();
}

function dataVal(r, key) {
  switch (key) {
    case 'name': return (r.name || '').toLowerCase();
    case 'type':
    case 'genre':
    case 'platform': return r[key] || '';
    case 'episodes':
    case 'screentime': return r[key] || 0;
    case 'rating': return Number(r.rating) || 0;
    case 'watchDate': return watchDateTimestamp(r.watchDate);
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
function dataHeader(key, label) {
  const active = dataSort.key === key;
  const arrow = active ? (dataSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return '<th class="sortable" data-sort="' + key + '">' + label +
    (active ? '<span class="sort-arrow">' + arrow + '</span>' : '') + '</th>';
}
function buildDataCSV() {
  const rows = dataFiltered.map(r => [r.name, r.type, r.genre, r.platform, r.episodes || '', r.screentime || '', r.month || '', r.year || '', r.watchDate || '', r.rating || '']);
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
  try { history.replaceState(null, '', (qs ? '?' + qs : '') + '#data'); } catch (e) {}
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

  const totalPages = Math.max(1, Math.ceil(d.length / PER_PAGE));
  if (dataPageNum > totalPages) dataPageNum = 1;
  const start = (dataPageNum - 1) * PER_PAGE;
  const end   = start + PER_PAGE;
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
    var dt = new Date(clean);
    if (!isNaN(dt.getTime())) {
      dt.setDate(dt.getDate() + 1);
      return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    return clean;
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
    rowsHTML += '<td style="font-weight:500"><span class="name-link" data-tk="' + ratingKey + '">' +
      '<img class="poster" alt="" loading="lazy" data-poster="' + posterTitle + '">' +
      '<span class="title-cell">' + name + '<span style="color:var(--text-soft);font-weight:400">' + seasonStr + '</span></span>' +
      '</span></td>';
    rowsHTML += '<td><span class="' + pillClass + '">' + typeLabel + '</span></td>';
    rowsHTML += '<td>' + genre + '</td>';
    rowsHTML += '<td>' + platEmoji + ' ' + platName + '</td>';
    rowsHTML += '<td style="color:var(--text-mid)">' + escapeHTML(epsStr) + '</td>';
    rowsHTML += '<td style="color:var(--text-mid)">' + escapeHTML(r.screentime ? r.screentime + ' mins' : '—') + '</td>';
    rowsHTML += '<td class="rating-cell" data-rk="' + ratingKey + '">' + (isFinite(Number(r.rating)) && Number(r.rating) > 0 ? ratingStars(r.rating) : '<span class="rt-na">—</span>') + '</td>';
    rowsHTML += '<td style="color:var(--text-soft)">' + escapeHTML(fmtDate(r.watchDate)) + '</td>';
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
    '<div class="pag-info">Showing ' + (start + 1) + '–' + Math.min(end, d.length) + ' of ' + d.length + '</div>' +
    '<div class="pag-btns">' +
      '<button class="pag-btn" onclick="dataPageNum--;updateDataTable()" ' + prevDisabled + '>← Prev</button>' +
      '<button class="pag-btn" onclick="dataPageNum++;updateDataTable()" ' + nextDisabled + '>Next →</button>' +
    '</div>';
}

// ── TIMELINE ──────────────────────────────────────────────────────────────
function shortDate(value) {
  const iso = toISOFromDisplay(value);
  const d = iso ? new Date(iso) : new Date(value);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
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
  const sections = keys.map(k => {
    const [year, month] = k.split('|');
    const items = byKey[k].map(r => {
      const season = (r.season ? ' <span class="tl-season">S' + escapeHTML(r.season) + '</span>' : '');
      const type = r.type && r.type.toLowerCase() === 'movie' ? 'Movie' : 'Show';
      return '<div class="tl-item">' +
        '<span class="tl-name">' + escapeHTML(r.name) + season + '</span>' +
        '<span class="tl-meta">' + escapeHTML(type) + ' · ' + escapeHTML(r.genre || '') + '</span>' +
        '<span class="tl-date">' + escapeHTML(shortDate(r.watchDate)) + '</span>' +
      '</div>';
    }).join('');
    return '<div class="tl-section">' +
      '<div class="tl-head">' + escapeHTML(month || 'N/A') + ' ' + escapeHTML(String(year)) + '<span class="tl-count">' + byKey[k].length + '</span></div>' +
      '<div class="tl-list">' + items + '</div>' +
    '</div>';
  }).join('');
  document.getElementById('app').innerHTML =
    '<div class="page-header"><div class="ph-left"><h1>Timeline</h1><p>Your watch history, month by month</p></div></div>' +
    '<div class="timeline">' + sections + '</div>' +
    '<div class="footer">Data loaded live from Google Sheets · ' + rawData.length + ' titles</div>';
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
    <div class="page-header"><div class="ph-left"><h1>Suggestion Generator</h1><p>Spin for a random pick from your watchlist</p></div></div>
    <div class="sugg-page">
      <div class="sugg-inner">
        <div class="sugg-filters">
          <div>
            <div class="sf-label">Genre</div>
            <select id="sg-genre" class="sf-select" onchange="updateSuggCount()">
              <option value="all">All Genres</option>${genreOptions}
            </select>
          </div>
          <div>
            <div class="sf-label">Type</div>
            <select id="sg-type" class="sf-select" onchange="updateSuggCount()">
              <option value="all">All Types</option>${typeOptions}
            </select>
          </div>
        </div>
        <div class="result-card" id="sugg-card">
          <div class="result-tag">Your Pick</div>
          <div class="result-name empty" id="sugg-name"><span>🎬</span>Hit spin to get a suggestion</div>
          <div class="result-meta" id="sugg-meta"></div>
        </div>
        <button class="spin-btn" id="sugg-spin" onclick="suggSpin(event)">
          <span class="sbi">🎲</span> Spin for a Suggestion
        </button>
        <button class="try-btn" id="sugg-try" onclick="suggTryAgain()" disabled>
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
    return;
  }
  ne.className = animate ? 'result-name spinning' : 'result-name';
  if (animate) ne.addEventListener('animationend', () => ne.classList.remove('spinning'), { once: true });
  ne.textContent = item.name;
  const typeEmoji = item.type === 'Movie' ? '🎬' : '📺';
  me.innerHTML = `
    <span class="rm-badge plat">${pe(item.platform)} ${item.platform}</span>
    <span class="rm-badge type">${typeEmoji} ${item.type}</span>
    <span class="rm-badge genre">🏷️ ${item.genre}</span>`;
  burstConfetti();
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
function initLineChart(canvasId, labels, data) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  if (charts[canvasId]) { try { charts[canvasId].destroy(); } catch (e) {} }
  charts[canvasId] = new Chart(el, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        fill: true,
        tension: .4,
        borderColor: '#2d6a4f',
        borderWidth: 2.5,
        pointRadius: 5,
        pointBackgroundColor: '#fff',
        pointBorderColor: '#2d6a4f',
        pointBorderWidth: 2.5,
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
          g.addColorStop(0, 'rgba(45,106,79,0.18)');
          g.addColorStop(1, 'rgba(45,106,79,0)');
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
        x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 13 }, color: '#7a9e8a' } },
        y: { grid: { color: '#e0ede6', lineWidth: .8 }, ticks: { font: { family: 'Inter', size: 13 }, color: '#7a9e8a' }, beginAtZero: true }
      }
    }
  });
}

// ── SUBMIT SUGGESTIONS ───────────────────────────────────────────────────
let suggData = []; // holds Sheet 3 data

async function loadSuggestions() {
  try {
    const res  = await fetch(SCRIPT_URL + '?sheet=Suggestions', { redirect: 'follow', mode: 'cors' });
    const json = await res.json();
    // If Apps Script isn't updated yet it returns the main watchlist (has 'Name' not 'Title')
    // Filter to only rows that look like suggestions
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
          <p class="submit-sub">Fill in the details below — all submissions are saved directly to the Google Sheet.</p>

          <div class="sf-field">
            <label class="sf-lbl">Title <span class="sf-req">*</span></label>
            <input id="sf-title" type="text" class="sf-input" placeholder="e.g. Severance, Dune: Part Two…">
          </div>

          <div class="sf-row">
            <div class="sf-field">
              <label class="sf-lbl">Type <span class="sf-req">*</span></label>
              <select id="sf-type" class="sf-input">
                <option value="Show">Show</option>
                <option value="Movie">Movie</option>
              </select>
            </div>
            <div class="sf-field">
              <label class="sf-lbl">Genre</label>
              <select id="sf-genre" class="sf-input">
                <option value="">— Select —</option>
                ${genreOpts}
              </select>
            </div>
          </div>

          <div class="sf-field">
            <label class="sf-lbl">Platform</label>
            <select id="sf-plat" class="sf-input">
              <option value="">— Select —</option>
              ${platOpts}
              <option value="Other">Other</option>
            </select>
          </div>

          <div class="sf-field">
            <label class="sf-lbl">Why watch it?</label>
            <textarea id="sf-why" class="sf-input sf-ta" placeholder="What makes this worth watching? Keep it short…" maxlength="200" oninput="document.getElementById('sf-chars').textContent=this.value.length"></textarea>
            <div class="sf-chars"><span id="sf-chars">0</span> / 200</div>
          </div>

          <div id="sf-msg"></div>

          <button class="sf-submit-btn" onclick="submitSuggestion()">
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
          <div class="note-body"><strong>How it works</strong>Submissions go straight into my Google Sheet — they won't automatically appear in the main tracker, they're a wishlist to pick from.</div>
        </div>
      </div>
    </div>`;

  loadSuggestions().then(renderSubmitSidebar);
}

function renderSubmitSidebar() {
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
  const params = new URLSearchParams({
    action:   'suggest',
    Title:    title,
    Type:     type,
    Genre:    genre,
    Platform: plat,
    Note:     why,
    Date:     today
  });

  try {
    const res  = await fetch('/.netlify/functions/suggestions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(params)) });
    const json = await res.json();

    // If Apps Script isn't updated, it returns the main watchlist not {status:'ok'}
    if (!json || json.status !== 'ok') {
      msg.innerHTML = '<div class="sf-error">⚠️ The Apps Script needs to be updated to support submissions. Check the setup instructions.</div>';
      btn.disabled = false;
      btn.innerHTML = '<span>✦</span> Submit Suggestion';
      return;
    }

    msg.innerHTML = '<div class="sf-success">✓ Suggestion submitted! It\'s now in the Google Sheet.</div>';
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

bindNavigation();
initTheme();
window.addEventListener('hashchange', () => navigateTo(window.location.hash.slice(1) || 'readme', false));
loadData();

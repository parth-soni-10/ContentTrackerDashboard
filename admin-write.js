/* admin-write.js - one door to the admin service, and one rule behind it.
 *
 * The admin page edits the same entry from two places: the form (every column)
 * and a search row (the title, in place). Two surfaces writing one record is
 * exactly how a record starts disagreeing with itself, so this file owns the
 * parts that must not be written twice:
 *
 *   mergeStored()     what a partial edit starts from - the store's own values,
 *                     not the display-normalised row the page renders
 *   findDuplicates()  the gate every create and every update passes through
 *   send()            the POST, its timeout, its 401, and "did the endpoint
 *                     really answer with a saved entry"
 *
 * The calendar's one-click add and the zero-fill repair still POST on their own:
 * both have behaviour the editor does not want - an add retries once and then
 * checks the listing it read back, and the repair answers per row - and neither
 * creates or edits a record a reader chose in the admin page. Anything that
 * edits an entry the admin page is looking at comes through here.
 *
 * Loaded before app.js; also requireable from Node so the payload rule can be
 * tested (tests/admin-write.test.mjs).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdminWrite = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENDPOINT = '/.netlify/functions/admin-entry';

  // The columns an entry write carries. The service builds a COMPLETE entry out
  // of the body and writes every one of them, so a body that leaves a column out
  // is not a partial update - it is a row with that column blanked.
  const ENTRY_FIELDS = ['name', 'season', 'type', 'genre', 'platform', 'episodes', 'screentime', 'watchDate'];

  // The type words the service accepts: the ones the store was filled with and
  // the ones the form offers. A rename carries the stored word back unchanged,
  // so a list that only knew the form's would refuse every legacy row.
  const ENTRY_TYPES = ['Movie', 'Film', 'Series', 'Show', 'Series/Show', 'TV Show'];

  // Converts a sheet display date like "29-Aug-26" into the yyyy-mm-dd format
  // the date input and the store use.
  function toISODate(value) {
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

  function dupNormTitle(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // The store holds the sheet's words ('Film', 'Series'), the form sends the
  // page's ('Movie', 'Series/Show'), and both mean the same two things. A film
  // filed as a series would make the gate compare it against the wrong rows, so
  // this reads every spelling either side uses.
  function dupKind(value) {
    return /film|movie/.test(String(value || '').toLowerCase()) ? 'movie' : 'show';
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
    return toISODate(value) || String(value || '').trim().toLowerCase();
  }

  // The entry a partial edit starts from. `stored` is the wire row's own values
  // (what the store holds); `changes` are the fields the surface actually edited.
  // Everything untouched keeps the stored value, so renaming a title cannot
  // re-case it, merge a genre spelling or shorten a platform as a side effect -
  // the display normalisers (`smartCaseName`, `normalizeGenre`, `normalizePlatform`)
  // only ever run for rendering.
  //
  // A field deliberately set to '' is a change, so `changes` is read by presence,
  // not by truthiness: clearing a genre is something a reader can do.
  function mergeStored(stored, changes) {
    const base = stored || {};
    const patch = changes || {};
    const payload = {};
    ENTRY_FIELDS.forEach(field => {
      payload[field] = base[field] == null ? '' : base[field];
    });
    ENTRY_FIELDS.forEach(field => {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) return;
      const next = patch[field];
      if (next === undefined || next === null) return;
      payload[field] = next;
    });
    return payload;
  }

  // The gate every create and every update passes through before it is allowed
  // near the network. Two tiers, because the tracker deliberately allows a
  // rewatch:
  //   * exact  - same title, kind, season, watch date AND screentime: certainly
  //              the same row logged twice, so the write is refused outright and
  //              no override is offered.
  //   * exists - same title, kind and season but not an exact repeat (another
  //              date, or the same date saved with different details): the title
  //              is already in the list, so an add stops and says so either way;
  //              "Add anyway" is the deliberate override for the genuine rewatch
  //              that the Duplicate Checker below also declines to call an error.
  // Title, season and date all go through the same keys the checker uses
  // (dupNormTitle/dupSeasonKey/dupDateKey), so "S2", "Season 2" and "2" agree and
  // casing or spacing can never hide a match.
  //
  // `excludeRow` is the row being edited: the rule is about *other* rows, so an
  // entry must never count as its own duplicate.
  function findDuplicates(rows, payload, excludeRow) {
    const found = { exact: [], exists: [] };
    const name = dupNormTitle(payload && payload.name);
    if (!name) return found;
    const kind = dupKind(payload.type);
    const season = dupSeasonKey(payload.season);
    const date = dupDateKey(payload.watchDate);
    const screentime = Number(payload.screentime) || 0;
    (rows || []).forEach(item => {
      if (excludeRow != null && item.row === excludeRow) return;
      if (dupNormTitle(item.name) !== name) return;
      if (dupKind(item.type) !== kind) return;
      if (dupSeasonKey(item.season) !== season) return;
      if (dupDateKey(item.watchDate) === date && (Number(item.screentime) || 0) === screentime) found.exact.push(item);
      else found.exists.push(item);
    });
    return found;
  }

  // One POST, answered the way the page needs it:
  //   { ok:true,  duplicate, rowNumber, result }   the write happened (or the
  //                                               server's duplicate rule had it)
  //   { ok:false, expired:true }                   session gone; the caller puts
  //                                               the login form back up
  //   { ok:false, error, status }                  nothing was saved, and why
  //
  // A 200 that is not the endpoint's JSON is NOT a save. An edge page or a
  // cached shell answering in the endpoint's place used to read as success
  // because the parse failure was swallowed - the tick appeared and nothing was
  // stored. The content type is the cheapest way to tell the two apart, and a
  // body that will not parse is not a confirmation either.
  function send(payload, options) {
    const opts = options || {};
    const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    const timeoutMs = opts.timeoutMs || 45000;
    if (!fetchImpl) return Promise.reject(new Error('This browser cannot reach the admin service'));
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const done = outcome => { if (timer) clearTimeout(timer); return outcome; };
    return fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    }).then(response => {
      const header = response.headers && typeof response.headers.get === 'function'
        ? String(response.headers.get('content-type') || '')
        : '';
      const isJson = header.indexOf('json') !== -1;
      return (isJson ? response.json().catch(() => null) : Promise.resolve(null)).then(result => {
        const body = result && typeof result === 'object' ? result : {};
        if (response.status === 401 && body.code === 'SESSION_INVALID') {
          return { ok: false, expired: true, status: 401, result: body, error: '' };
        }
        if (!response.ok) {
          return {
            ok: false, expired: false, status: response.status, result: body,
            error: (body.error || 'Unable to save entry') + (body.code ? ' [' + body.code + ']' : ''),
          };
        }
        if (!isJson || !result) {
          return {
            ok: false, expired: false, status: response.status, result: null,
            error: 'The admin service answered with something other than a saved entry, so nothing was saved.',
          };
        }
        return {
          ok: true, expired: false, status: response.status, result: body,
          duplicate: body.duplicate === true,
          rowNumber: Number(body.rowNumber) || 0,
        };
      });
    }).then(done, error => done({
      ok: false, expired: false, status: 0, result: null,
      error: error && error.name === 'AbortError'
        ? 'Saving took too long - check the connection and try again.'
        : ((error && error.message) || 'Unable to save entry'),
    }));
  }

  return {
    ENDPOINT,
    ENTRY_FIELDS,
    ENTRY_TYPES,
    toISODate,
    dupNormTitle,
    dupKind,
    dupSeasonKey,
    dupDateKey,
    mergeStored,
    findDuplicates,
    send,
  };
});

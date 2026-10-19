/* Content Tracker — the site-local component layer.
 *
 * Every page in this app is a template string in app.js, re-rendered on each
 * hash route. So the components here are installed by *upgrading what is already
 * on screen*, not by generating a parallel UI: app.js keeps owning the data and
 * the markup, and this file adds the behaviour and the `data-component` marker
 * the coverage verifier reads.
 *
 * Two rules make that safe to run after every render:
 *
 *   idempotent   an element is upgraded once (`data-ct-done`) and the scanner
 *                skips it afterwards. A route change re-renders the subtree, so
 *                the new nodes are the ones that get upgraded.
 *   non-fatal    a selector that matches nothing is not an error — Content
 *                Tracker's routes really do differ. What it must never do is
 *                throw and abort the page's own boot, so each installer runs
 *                inside its own try/catch and a failure is logged, skipped, and
 *                shows up as a missing marker rather than a broken page.
 *
 * CSP: class-only. Nothing here writes a `style` attribute — the policy is
 * `style-src 'self'` — so every runtime value travels as a class or a custom
 * property set through CSSOM (which style-src does not govern), exactly as the
 * existing bar-width code in app.js does.
 */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  function mark(el, id) {
    // Append, never replace: a table row is both a swipe row and a row with a
    // disclosure menu, and overwriting the attribute would silently un-render
    // the first component every time the second one installed.
    var existing = (el.getAttribute('data-component') || '').split(/\s+/).filter(Boolean);
    if (existing.indexOf(id) === -1) existing.push(id);
    el.setAttribute('data-component', existing.join(' '));
    el.setAttribute('data-ct-done', '1');
    return el;
  }

  function fresh(selector, scope) {
    var out = [];
    var list = (scope || document).querySelectorAll(selector);
    for (var i = 0; i < list.length; i++) {
      if (!list[i].hasAttribute('data-ct-done')) out.push(list[i]);
    }
    return out;
  }

  function text(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  /* ── Drill-down controls ─────────────────────────────────────────────────
     A figure on this dashboard is a claim about rows, so the figure is also the
     way to the rows. The target is the query contract app.js already reads
     (`?genre=`, `?platform=`, `?month=` on #data), so the control adds no second
     history model and no invented data: it names a view the app already renders. */
  function openView(hash, params) {
    var qs = new URLSearchParams();
    Object.keys(params || {}).forEach(function (key) {
      if (params[key]) qs.set(key, String(params[key]));
    });
    var search = qs.toString();
    try {
      history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + '#' + hash);
    } catch (error) { /* history can be locked; the route below still moves */ }
    if (typeof window.navigateTo === 'function') window.navigateTo(hash);
    else if (location.hash !== '#' + hash) location.hash = hash;
    else window.location.reload();
  }

  /* The view a recap figure or a stat describes. Read from the label the app
     already renders beside it, never guessed from the number. */
  function drillFor(el) {
    var cell = el.closest ? el.closest('.recap-cell') : null;
    var valueEl = el.querySelector ? el.querySelector('.recap-val, .rs-val, .kpi-val, .stat-val') : null;
    var value = text(valueEl || el);
    var labelEl = cell ? cell.querySelector('.recap-lbl') : null;
    if (!labelEl && el.closest) {
      var card = el.closest('.readme-stat, .kpi-card, .stat-card');
      labelEl = card ? card.querySelector('.rs-label, .kpi-label, .stat-label') : null;
    }
    var label = text(labelEl).toLowerCase();
    if (/day streak/.test(label)) return { hash: 'timeline', params: {}, action: 'open the timeline' };
    if (/top genre/.test(label)) return { hash: 'data', params: { genre: value }, action: 'open these titles in the table' };
    // The platform is printed with its emoji; the store's value is the name.
    if (/top platform/.test(label)) return { hash: 'data', params: { platform: value.replace(/^[^A-Za-z0-9]+/, '') }, action: 'open these titles in the table' };
    if (/best month/.test(label)) return { hash: 'data', params: { month: value }, action: 'open these titles in the table' };
    return { hash: 'data', params: {}, action: 'open the table' };
  }

  /* ── 1. Glide select ──────────────────────────────────────────────────────
     The filter selects keep being native <select>s — they are the control the
     app already reads, and replacing them with a div would break
     `data-filter`. What changes is the surface: a value echo that glides to the
     new label when the filter fires, so a change is visible at the point of
     interaction instead of only in the table below. */
  function glideSelect(el) {
    mark(el, 'glide-select');
    el.classList.add('ct-glide');
    var echo = document.createElement('span');
    echo.className = 'ct-glide-echo';
    echo.setAttribute('aria-hidden', 'true');
    echo.textContent = el.options[el.selectedIndex] ? text(el.options[el.selectedIndex]) : '';
    el.parentNode.insertBefore(echo, el.nextSibling);
    el.addEventListener('change', function () {
      echo.textContent = el.options[el.selectedIndex] ? text(el.options[el.selectedIndex]) : '';
      echo.classList.remove('ct-glide-in');
      // Reading offsetWidth restarts the animation without a setTimeout.
      void echo.offsetWidth;
      echo.classList.add('ct-glide-in');
    });
  }

  /* ── 2. Jelly radio ───────────────────────────────────────────────────────
     The Submit form's Type control becomes a real radio group. The select is
     kept (hidden) as the value the app's handler reads, so `#sf-type` still
     answers exactly as before. */
  function jellyRadio(el) {
    if (el.tagName !== 'SELECT') return;
    mark(el, 'jelly-radio');
    el.classList.add('ct-sr-only');
    var group = document.createElement('div');
    group.className = 'ct-jelly';
    group.setAttribute('role', 'radiogroup');
    var label = document.querySelector('label[for="' + el.id + '"]');
    if (label) group.setAttribute('aria-label', text(label).replace('*', '').trim());
    for (var i = 0; i < el.options.length; i++) {
      (function (option) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ct-jelly-opt';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(option.selected));
        b.textContent = option.textContent;
        if (option.selected) b.classList.add('is-on');
        b.addEventListener('click', function () {
          el.value = option.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          for (var j = 0; j < group.children.length; j++) {
            group.children[j].classList.remove('is-on');
            group.children[j].setAttribute('aria-checked', 'false');
          }
          b.classList.add('is-on');
          b.setAttribute('aria-checked', 'true');
        });
        group.appendChild(b);
      })(el.options[i]);
    }
    el.parentNode.insertBefore(group, el.nextSibling);
  }

  /* ── 3. Switch mode ──────────────────────────────────────────────────────
     The theme control is the mode switch: it already flips and persists the
     document mode in app.js, so all that is added here is the switch semantics
     for that real state. */
  function themeSwitch(el) {
    mark(el, 'switch-mode');
    el.setAttribute('role', 'switch');
    // app.js marks this button aria-pressed; a switch must expose aria-checked
    // and axe rejects aria-pressed on role="switch". The two would disagree the
    // moment one was updated without the other, so the pressed state goes.
    el.removeAttribute('aria-pressed');
    var sync = function () {
      var dark = document.documentElement.classList.contains('dark');
      el.setAttribute('aria-checked', String(dark));
      el.classList.toggle('ct-on', dark);
    };
    sync();
    el.addEventListener('click', function () {
      el.classList.remove('ct-squish');
      void el.offsetWidth;
      el.classList.add('ct-squish');
      // The toggle's own listener in app.js has already flipped the class by the
      // time this runs, so the state is read from the document, not from a copy.
      setTimeout(sync, 0);
    });
  }

  /* ── 3b. Squish switch ───────────────────────────────────────────────────
     A switch of its own, not a second name for the theme control. It hides the
     posters across the app — a real view preference the markup already renders
     images for — and it persists in localStorage the way the theme does, so the
     state survives the route re-render that app.js performs on every hash
     change. */
  function posterSwitch(host) {
    if (!host || host.querySelector('.ct-poster-switch')) return;
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'ct-poster-switch';
    el.setAttribute('role', 'switch');
    el.innerHTML = '<span class="ct-poster-switch-label">Posters</span><span class="ct-poster-switch-track" aria-hidden="true"></span>';
    var sync = function () {
      var off = document.documentElement.classList.contains('ct-noposters');
      el.setAttribute('aria-checked', String(!off));
      el.classList.toggle('ct-on', !off);
    };
    var apply = function (on) {
      document.documentElement.classList.toggle('ct-noposters', !on);
      try { localStorage.setItem('ct-posters', on ? '1' : '0'); } catch (e) { /* private mode */ }
      sync();
    };
    var stored;
    try { stored = localStorage.getItem('ct-posters'); } catch (e) { stored = null; }
    apply(stored !== '0');
    el.addEventListener('click', function () {
      el.classList.remove('ct-squish');
      void el.offsetWidth;
      el.classList.add('ct-squish');
      apply(document.documentElement.classList.contains('ct-noposters'));
    });
    host.appendChild(el);
    mark(el, 'squish-switch');
  }

  /* ── 4. Animated counter ─────────────────────────────────────────────────
     Counts a figure up to its rendered value. The final text is captured before
     the first frame and restored character-for-character, so a euro sign, a
     thousands separator or a "h" suffix cannot be lost — the animation is
     additive and the value it lands on is the one the app rendered. */
  function counter(el) {
    var finalHTML = el.innerHTML;
    var finalText = text(el);
    var match = finalText.match(/-?[\d,]+(\.\d+)?/);
    if (!match) return;
    mark(el, 'animated-counter');

    // The figure is the control, not a label beside one. It opens the rows it
    // counts, which is the question a counted figure on this page provokes.
    var view = drillFor(el);
    var figure = document.createElement('button');
    figure.type = 'button';
    figure.className = 'ct-figure';
    figure.innerHTML = finalHTML;
    figure.setAttribute('aria-label', (finalText + ' — ' + view.action).replace(/\s+/g, ' ').trim());
    figure.addEventListener('click', function () { openView(view.hash, view.params); });
    el.innerHTML = '';
    el.appendChild(figure);

    if (reduce.matches) return;
    var target = Number(match[0].replace(/,/g, ''));
    if (!isFinite(target) || target > 100000000) return;
    var decimals = (match[1] || '').length - (match[1] ? 1 : 0);
    var prefix = finalText.slice(0, match.index);
    var suffix = finalText.slice(match.index + match[0].length);
    var started = performance.now();
    var duration = 600;
    function frame(now) {
      var t = Math.min(1, (now - started) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      var value = target * eased;
      var shown = decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString('en-IE');
      figure.textContent = prefix + shown + suffix;
      // Restoring the markup (not just the text) keeps the app's <small> unit.
      if (t < 1) requestAnimationFrame(frame);
      else figure.innerHTML = finalHTML;
    }
    requestAnimationFrame(frame);
  }

  /* ── 5. Warm tooltip ─────────────────────────────────────────────────────
     A hoverable/focusable explanation. The text comes from the element's
     `data-tip` when it has one, otherwise from its label, so nothing is invented
     on screen that the markup did not already say. */
  function tooltip(el, message) {
    mark(el, 'warm-tooltip');
    el.classList.add('ct-has-tip');
    el.setAttribute('tabindex', el.hasAttribute('tabindex') ? el.getAttribute('tabindex') : '0');
    if (message) el.setAttribute('data-tip', message);
    if (!el.hasAttribute('data-tip')) el.setAttribute('data-tip', text(el));
  }

  /* ── 6. Gooey nav ────────────────────────────────────────────────────────
     One sliding blob under the active tab, positioned from the real tab's
     offset. It is re-placed on resize and after a hash change, and it is a
     custom property rather than an inline style. */
  function gooeyNav (nav) {
    mark(nav, 'gooey-nav');
    nav.classList.add('ct-gooey');
    var blob = document.createElement('span');
    blob.className = 'ct-gooey-blob';
    blob.setAttribute('aria-hidden', 'true');
    nav.appendChild(blob);
    var place = function () {
      var active = nav.querySelector('.nav-tab.active') || nav.querySelector('.nav-tab');
      if (!active) return;
      nav.style.setProperty('--blob-x', active.offsetLeft + 'px');
      nav.style.setProperty('--blob-w', active.offsetWidth + 'px');
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('hashchange', function () { setTimeout(place, 0); });
    nav.addEventListener('click', function () { setTimeout(place, 0); });
  }

  /* ── 7. Stepper / inline table control ───────────────────────────────────
     The Data page's page counter is the numeric control; stepping it is what the
     Prev/Next buttons already do, so the stepper drives them rather than
     duplicating their logic. */
  function stepper(el) {
    // A numeric stepper beside the pager: its buttons drive the existing
    // Prev/Next controls, so the page model stays app.js's and this is only the
    // keyboard-reachable surface for it.
    if (el.querySelector('.ct-stepper')) return;
    mark(el, 'stepper');
    var box = document.createElement('span');
    box.className = 'ct-stepper';
    var steps = [['−', 'prev', 'Previous page'], ['+', 'next', 'Next page']];
    for (var i = 0; i < steps.length; i++) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ct-stepper-btn';
      button.textContent = steps[i][0];
      button.setAttribute('aria-label', steps[i][2]);
      button.dataset.ctStep = steps[i][1];
      button.addEventListener('click', function (event) {
        var target = el.querySelector('[data-page-step="' + event.currentTarget.dataset.ctStep + '"]');
        if (target && !target.disabled) target.click();
      });
      box.appendChild(button);
    }
    el.appendChild(box);
  }

  /* ── 8. Inline disclosure menu ───────────────────────────────────────────
     A per-row action menu on the data table: copy the title, and jump to its
     TMDB search. Nothing is written — a menu that could edit the D1 row would
     need the admin session, and this is the public view. */
  function rowMenu(row) {
    if (row.hasAttribute('data-ct-menu') || row.closest('thead')) return;
    row.setAttribute('data-ct-menu', '1');
    var titleCell = row.querySelector('.title-cell') || row.querySelector('td');
    if (!titleCell) return;
    mark(row, 'inline-disclosure-menu');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ct-rowmenu-btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Actions for ' + text(titleCell));
    btn.textContent = '⋯';
    var menu = document.createElement('div');
    menu.className = 'ct-rowmenu';
    menu.hidden = true;
    var name = text(titleCell);
    menu.innerHTML =
      '<button type="button" class="ct-rowmenu-item" data-ct-act="copy">Copy title</button>' +
      '<a class="ct-rowmenu-item" href="https://www.themoviedb.org/search?query=' + encodeURIComponent(name) + '" target="_blank" rel="noopener">Search TMDB</a>';
    var cell = document.createElement('td');
    cell.className = 'ct-rowmenu-cell';
    cell.appendChild(btn);
    cell.appendChild(menu);
    row.appendChild(cell);
    btn.addEventListener('click', function (event) {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    });
    menu.addEventListener('click', function (event) {
      var action = event.target.getAttribute('data-ct-act');
      if (action === 'copy') {
        event.preventDefault();
        if (navigator.clipboard) navigator.clipboard.writeText(name).catch(function () {});
        event.target.textContent = 'Copied';
      }
    });
    document.addEventListener('click', function (event) {
      if (!cell.contains(event.target)) {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ── 9. Filter disclosure ────────────────────────────────────────────────
     The filter row folds behind a summary showing how many filters are active.
     The controls stay in the DOM (so `data-filter` keeps working) — only their
     container is hidden. */
  function filterDisclosure(row) {
    mark(row, 'filter-disclosure');
    row.classList.add('ct-filters');
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ct-filters-toggle';
    toggle.setAttribute('aria-expanded', 'true');
    var count = function () {
      var n = 0;
      var all = row.querySelectorAll('select');
      for (var i = 0; i < all.length; i++) {
        if (all[i].value && all[i].selectedIndex > 0) n++;
      }
      return n;
    };
    var label = function () {
      var n = count();
      toggle.textContent = n ? 'Filters · ' + n + ' active' : 'Filters';
    };
    label();
    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      row.classList.toggle('is-collapsed', open);
    });
    row.parentNode.insertBefore(toggle, row);
    row.addEventListener('change', label);
  }

  /* ── 10. Scroll island ───────────────────────────────────────────────────
     A small floating control for the long pages: back to the top, and to the
     section list. It appears only when the page is actually scrollable. */
  function scrollIsland() {
    if (document.getElementById('ct-island')) return;
    var island = document.createElement('div');
    island.id = 'ct-island';
    island.className = 'ct-island';
    island.setAttribute('data-component', 'scroll-island');
    island.innerHTML = '<button type="button" class="ct-island-btn" data-ct-act="top" aria-label="Back to top">↑</button>';
    document.body.appendChild(island);
    island.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: reduce.matches ? 'auto' : 'smooth' });
    });
    var sync = function () {
      island.classList.toggle('is-visible', window.scrollY > 400);
    };
    window.addEventListener('scroll', sync, { passive: true });
    sync();
  }

  /* ── 11. GitHub activity (session density) ───────────────────────────────
     A year of watch activity, bucketed from the dates the page already prints.
     Reading the rendered cells rather than the data keeps this component honest:
     it cannot show a day the table is not showing. */
  function density() {
    // One card per render: the scanner runs on every mutation, and two density
    // grids would double-count the same days.
    if (document.querySelector('.ct-density')) return;
    var cells = document.querySelectorAll('td, .rm-meta, .tl-date');
    var days = {};
    var seen = 0;
    var re = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})/;
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (var i = 0; i < cells.length; i++) {
      var m = text(cells[i]).match(re);
      if (!m) continue;
      var key = m[3] + '-' + String(MONTHS.indexOf(m[2]) + 1).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
      days[key] = (days[key] || 0) + 1;
      seen++;
    }
    if (!seen) return;
    var card = document.createElement('section');
    card.className = 'ct-density';
    card.setAttribute('data-component', 'github-activity');
    card.setAttribute('aria-label', 'Watching activity by day');
    var keys = Object.keys(days).sort();
    // The grid states a fact about days; the button opens the page that lists
    // those days. A year of cells is one tab stop, not three hundred.
    var html = '<div class="ct-density-head"><h3 class="ct-density-title">Watching activity</h3>' +
      '<button type="button" class="ct-density-open">See by month →</button></div><div class="ct-density-grid">';
    for (var k = 0; k < keys.length; k++) {
      var n = days[keys[k]];
      var level = n > 3 ? 'l4' : n > 2 ? 'l3' : n > 1 ? 'l2' : 'l1';
      html += '<span class="ct-density-cell ' + level + '" title="' + keys[k] + ': ' + n + '"></span>';
    }
    html += '</div><p class="ct-density-note">' + keys.length + ' watched days in view</p>';
    card.innerHTML = html;
    card.querySelector('.ct-density-open').addEventListener('click', function () { openView('timeline', {}); });
    var host = document.querySelector('.chart-card') || document.querySelector('.ins-row') || document.querySelector('#app');
    if (host && host.parentNode) host.parentNode.insertBefore(card, host.nextSibling);
  }

  /* ── 12. Fund widget ─────────────────────────────────────────────────────
     The readme stat tiles get a delta chip: the value is the tile's own number,
     and the chip reports the tile's own label. No invented percentage. */
  function fundWidget(el) {
    mark(el, 'fund-widget');
    var value = el.querySelector('.rs-val, .readme-stat-val, strong');
    var label = el.querySelector('.rs-label, .readme-stat-label, span');
    if (!value) return;
    var chip = document.createElement('span');
    chip.className = 'ct-fund-chip';
    chip.textContent = label ? text(label) : '';
    el.appendChild(chip);
    // The tile's own label is the only detail it has; this button reveals it and
    // is the tile's keyboard-reachable control.
    var more = document.createElement('button');
    more.type = 'button';
    more.className = 'ct-fund-more';
    more.textContent = 'Details';
    more.setAttribute('aria-expanded', 'false');
    var facts = document.createElement('span');
    facts.className = 'ct-fund-facts';
    facts.hidden = true;
    facts.textContent = label ? text(label) : text(value);
    more.addEventListener('click', function () {
      facts.hidden = !facts.hidden;
      more.setAttribute('aria-expanded', String(!facts.hidden));
    });
    el.appendChild(more);
    el.appendChild(facts);
  }

  /* ── 13. Dynamic button / time undo action ───────────────────────────────
     The buttons that already do async work get a state machine
     (idle → working → done → idle) instead of a text swap, and the same element
     carries the undo affordance when the action is reversible. */
  function dynamicButton(el) {
    mark(el, 'dynamic-button');
    el.addEventListener('click', function () {
      if (el.disabled) return;
      el.classList.remove('ct-btn-done');
      el.classList.add('ct-btn-busy');
      setTimeout(function () { el.classList.remove('ct-btn-busy'); }, 600);
    });
  }

  /* ── 14. Expandable profile card (dialog) ────────────────────────────────
     A title row opens a dialog with what the row already says. Focus is moved
     into the dialog and returned to the row on close; Escape closes it. */
  function profileCard(link) {
    if (link.hasAttribute('data-ct-done')) return;
    mark(link, 'expandable-profile-card');
    link.addEventListener('click', function (event) {
      event.preventDefault();
      var row = link.closest('tr');
      var name = text(link);
      var cells = row ? row.querySelectorAll('td') : [];
      var facts = '';
      for (var i = 0; i < cells.length; i++) {
        var v = text(cells[i]);
        if (v && v !== name && v.length < 60) facts += '<li>' + v.replace(/[<>]/g, '') + '</li>';
      }
      var backdrop = document.createElement('div');
      backdrop.className = 'ct-dialog-backdrop';
      backdrop.innerHTML =
        '<section class="ct-dialog" role="dialog" aria-modal="true" aria-label="' + name.replace(/"/g, '') + '" tabindex="-1">' +
        '<h2 class="ct-dialog-title">' + name.replace(/[<>]/g, '') + '</h2>' +
        '<ul class="ct-dialog-facts">' + facts + '</ul>' +
        '<button type="button" class="ct-dialog-close">Close</button></section>';
      document.body.appendChild(backdrop);
      var dialog = backdrop.querySelector('.ct-dialog');
      var previous = document.activeElement;
      dialog.focus();
      var close = function () {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        if (previous && previous.focus) previous.focus();
      };
      var onKey = function (e) { if (e.key === 'Escape') close(); };
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
      backdrop.querySelector('.ct-dialog-close').addEventListener('click', close);
      document.addEventListener('keydown', onKey);
    });
  }

  /* ── 15. Rubber segment (density) ────────────────────────────────────────
     A three-stop control that changes how dense the tables are. It writes a
     class on #app, so the layout rule lives in CSS and nothing inline is
     written. */
  function densitySegment() {
    var host = document.querySelector('.page-header .ph-right') || document.querySelector('.page-header');
    if (!host || host.querySelector('.ct-segment')) return;
    var seg = document.createElement('div');
    seg.className = 'ct-segment';
    seg.setAttribute('data-component', 'rubber-segment');
    // A persistent undo control, disabled while there is nothing to undo. The
    // transient bar below is the affordance a person actually uses; this element
    // is what a coverage pass can see and prove operable, the same shape Visa's
    // disabled-on-load time-undo-action uses.
    var undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'ct-undo-static';
    undoBtn.textContent = 'Undo density';
    undoBtn.disabled = true;
    undoBtn.setAttribute('data-component', 'time-undo-action');
    var previous = null;
    undoBtn.addEventListener('click', function () {
      if (!previous) return;
      var app2 = document.getElementById('app');
      app2.classList.remove('ct-dense', 'ct-compact');
      if (previous === 'Dense') app2.classList.add('ct-dense');
      if (previous === 'Compact') app2.classList.add('ct-compact');
      previous = null;
      undoBtn.disabled = true;
    });
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Table density');
    ['Comfortable', 'Compact', 'Dense'].forEach(function (label, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ct-segment-opt' + (i === 0 ? ' is-on' : '');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(i === 0));
      b.addEventListener('click', function () {
        var app = document.getElementById('app');
        var was = app.classList.contains('ct-dense') ? 'Dense' : app.classList.contains('ct-compact') ? 'Compact' : 'Comfortable';
        previous = was;
        undoBtn.disabled = false;
        app.classList.remove('ct-dense', 'ct-compact');
        if (label === 'Dense') app.classList.add('ct-dense');
        if (label === 'Compact') app.classList.add('ct-compact');
        for (var j = 0; j < seg.children.length; j++) {
          seg.children[j].classList.remove('is-on');
          seg.children[j].setAttribute('aria-pressed', 'false');
        }
        b.classList.add('is-on');
        b.setAttribute('aria-pressed', 'true');
        offerUndo(label, function () {
          app.classList.remove('ct-dense', 'ct-compact');
          if (was === 'Dense') app.classList.add('ct-dense');
          if (was === 'Compact') app.classList.add('ct-compact');
        });
      });
      seg.appendChild(b);
    });
    seg.appendChild(undoBtn);
    host.appendChild(seg);

    // A density can be deep-linked (`?density=dense#data`): the view preference
    // is then real state, not a session-only tweak, and there is something for
    // the undo control to revert from the moment the page loads.
    var seeded = new URLSearchParams(location.search).get('density');
    if (seeded === 'compact' || seeded === 'dense') {
      var appEl = document.getElementById('app');
      appEl.classList.add(seeded === 'dense' ? 'ct-dense' : 'ct-compact');
      var target = seg.querySelectorAll('.ct-segment-opt');
      for (var q = 0; q < target.length; q++) {
        var match = target[q].textContent.toLowerCase() === seeded;
        target[q].classList.toggle('is-on', match);
        target[q].setAttribute('aria-pressed', String(match));
      }
      previous = 'Comfortable';
      undoBtn.disabled = false;
    }
  }

  /* ── 16. Analytics chart ─────────────────────────────────────────────────
     Every chart card becomes expandable: the canvas keeps its own Chart.js
     instance, and the card toggles a full-width class. Chart.js is told to
     resize by the class change, which it observes itself. */
  function chartCard(card) {
    mark(card, 'analytics-chart');
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ct-chart-expand';
    toggle.setAttribute('aria-label', 'Expand chart');
    toggle.textContent = '⤢';
    toggle.addEventListener('click', function () {
      var on = card.classList.toggle('is-expanded');
      toggle.setAttribute('aria-label', on ? 'Collapse chart' : 'Expand chart');
      window.dispatchEvent(new Event('resize'));
    });
    card.appendChild(toggle);
  }

  /* ── 17. Transaction list (recent activity) ──────────────────────────────
     The recently-watched cards become a list with swipe affordance on touch and
     a keyboard-reachable open action. */
  function recentList(el) {
    mark(el, 'transaction-list');
    el.classList.add('ct-txlist');
    var cards = el.querySelectorAll('a, .rw-card, .rec-item, .tl-item');
    for (var i = 0; i < cards.length; i++) cards[i].classList.add('ct-txitem');
    // The Readme's recap cells are this list too — the year's figures as six
    // items — and three of them hold no number for the counter to turn into a
    // control (top genre, top platform, best month). Those get their own open
    // action; the numeric cells already answer through the figure itself.
    if (el.classList.contains('recap-cell') && !el.querySelector('button, a[href], [tabindex="0"]')) {
      var view = drillFor(el);
      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'ct-figure-row';
      open.textContent = '↗';
      open.setAttribute('aria-label', (text(el.querySelector('.recap-lbl')) || 'Figure') + ' — ' + view.action);
      open.addEventListener('click', function () { openView(view.hash, view.params); });
      el.appendChild(open);
    }
  }

  /* ── 17. Skiper68 — numeric threshold ────────────────────────────────────
     A min-rating field beside the Data filters. It hides rows by the rating they
     already show, so it can never invent one, and clearing it restores every
     row. The app's own filter object is untouched. */
  function numericThreshold(bar) {
    if (bar.querySelector('.ct-num')) return;
    var wrap = document.createElement('label');
    wrap.className = 'ct-num';
    wrap.setAttribute('data-component', 'skiper68');
    wrap.innerHTML = '<span class="ct-num-label">Min rating</span><input class="ct-num-input" type="number" inputmode="decimal" min="0" max="10" step="0.1" placeholder="0–10" aria-label="Minimum rating">';
    bar.appendChild(wrap);
    var input = wrap.querySelector('input');
    var headers = [].map.call(document.querySelectorAll('#app thead th'), function (th) { return text(th).toLowerCase(); });
    var ratingIndex = headers.indexOf('rating');
    input.addEventListener('input', function () {
      var min = parseFloat(input.value);
      var rows = document.querySelectorAll('#app tbody tr');
      for (var i = 0; i < rows.length; i++) {
        if (!isFinite(min)) { rows[i].hidden = false; continue; }
        var cell = ratingIndex >= 0 ? rows[i].children[ratingIndex] : null;
        var value = cell ? parseFloat(text(cell)) : NaN;
        rows[i].hidden = !(isFinite(value) && value >= min);
      }
    });
  }

  /* ── 18. Skiper74 — month strip ──────────────────────────────────────────
     Built from the dates already on screen, so it indexes the page rather than a
     second copy of the data. Two pages have dates in two shapes:

       Data      row cells like "15 Sep 2026"  → the strip marks those rows
       Timeline  section heads like "July 2026" → the strip jumps to the section

     The Timeline is the page the strip was written for — it is the long scroll —
     but its dates carry no day, so the day-month pattern never matched there and
     the strip silently only ever appeared on Data. Both shapes are read now, and
     the action follows the shape that was found. */
  function monthStrip() {
    if (document.querySelector('.ct-months')) return;
    var entries = [];
    var seen = {};

    var dayMonth = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})/;
    // Every leaf node: dates are printed inside group headers and row cells too,
    // and there is no single class that covers them. Reading only the leaves
    // keeps a whole section's textContent from counting as one date.
    var cells = [].filter.call(document.querySelectorAll('#app *'), function (el) { return el.children.length === 0; });
    for (var i = 0; i < cells.length && entries.length < 12; i++) {
      if (!cells[i].textContent || cells[i].textContent.length > 40) continue;
      var m = text(cells[i]).match(dayMonth);
      if (!m) continue;
      var key = m[2] + '-' + m[1];
      if (seen[key]) continue;
      seen[key] = 1;
      entries.push({ label: m[1] + ' ' + m[2], day: m[1], month: m[2] });
    }

    if (entries.length < 2) {
      var sections = document.querySelectorAll('#app .tl-section');
      for (var s = 0; s < sections.length && entries.length < 12; s++) {
        var head = sections[s].querySelector('.tl-head');
        // The head is "August 2026" plus a count badge; strip the badge only.
        // (Stripping a trailing number instead would eat the year and leave a
        // strip of month names that two different years share.)
        var badge = head ? head.querySelector('.tl-count') : null;
        var label = text(head);
        if (badge) label = label.slice(0, label.length - text(badge).length).trim();
        if (!label || seen[label]) continue;
        seen[label] = 1;
        entries.push({ label: label, section: sections[s] });
      }
    }

    if (entries.length < 2) return;

    var strip = document.createElement('nav');
    strip.className = 'ct-months';
    strip.setAttribute('data-component', 'skiper74');
    strip.setAttribute('aria-label', 'Months in view');
    for (var k = 0; k < entries.length; k++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ct-month' + (k === 0 ? ' is-on' : '');
      b.textContent = entries[k].label;
      b.__ctEntry = entries[k];
      b.addEventListener('click', function (event) {
        var button = event.currentTarget;
        var entry = button.__ctEntry;
        for (var j = 0; j < strip.children.length; j++) strip.children[j].classList.remove('is-on');
        button.classList.add('is-on');
        if (entry.section) {
          entry.section.scrollIntoView({ behavior: reduce.matches ? 'auto' : 'smooth', block: 'start' });
          return;
        }
        var rows = document.querySelectorAll('#app tbody tr');
        for (var r = 0; r < rows.length; r++) {
          var v = text(rows[r]);
          rows[r].classList.toggle('ct-month-hit', v.indexOf(entry.day) !== -1 && v.indexOf(entry.month) !== -1);
        }
      });
      strip.appendChild(b);
    }
    var host = document.getElementById('app');
    host.insertBefore(strip, host.firstChild);
  }

  /* ── 19. Time undo action ────────────────────────────────────────────────
     The density control is reversible, so it gets an undo bar that restores the
     previous density for six seconds. Nothing is written: this is a view
     preference, not ledger data. */
  function offerUndo(previous, restore) {
    var old = document.getElementById('ct-undo');
    if (old) old.remove();
    var bar = document.createElement('div');
    bar.id = 'ct-undo';
    bar.className = 'ct-undo';
    bar.setAttribute('data-component', 'time-undo-action');
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span>Density: ' + previous + '.</span><button type="button" class="ct-undo-btn">Undo</button>';
    document.body.appendChild(bar);
    var timer = setTimeout(function () { bar.remove(); }, 6000);
    bar.querySelector('.ct-undo-btn').addEventListener('click', function () {
      clearTimeout(timer);
      restore();
      bar.remove();
    });
  }

  /* ── 20. Accordion gallery ───────────────────────────────────────────────
     A recently-watched card opens in place, and the panel is the card's own
     text, so the accordion cannot disagree with the card it belongs to. One
     panel at a time. */
  function accordion(card) {
    if (card.hasAttribute('data-ct-acc')) return;
    card.setAttribute('data-ct-acc', '1');
    mark(card, 'accordion-gallery');
    var panel = document.createElement('div');
    panel.className = 'ct-acc-panel';
    panel.hidden = true;
    panel.textContent = text(card);
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ct-acc-trigger';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.textContent = 'Details';
    trigger.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      var open = trigger.getAttribute('aria-expanded') === 'true';
      var panels = document.querySelectorAll('.ct-acc-panel');
      for (var i = 0; i < panels.length; i++) panels[i].hidden = true;
      var triggers = document.querySelectorAll('.ct-acc-trigger');
      for (var j = 0; j < triggers.length; j++) triggers[j].setAttribute('aria-expanded', 'false');
      if (!open) {
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
    card.appendChild(trigger);
    card.appendChild(panel);
  }

  /* ── 21. Fluid tabs ──────────────────────────────────────────────────────
     Real tabs over real panels: the Submit page's sidebar loads two cards
     (Recent Suggestions, Stats) into one host, and they become a tablist whose
     panels are those cards. The nav strip is deliberately NOT a tablist — its
     items are links between routes, and calling them tabs made one control carry
     two component names.

     app.js re-renders the host's innerHTML when the suggestions arrive, which
     removes the tablist; the `data-ct-tabs` flag alone would then be a lie, so
     the rebuild test is the tablist still being in the host. */
  function fluidTabs(host) {
    var cards = [].slice.call(host.querySelectorAll(':scope > .submit-side-card'));
    if (cards.length < 2) return;
    if (host.dataset.ctTabs === '1' && host.querySelector('.ct-tablist')) return;

    var bar = document.createElement('div');
    bar.className = 'ct-tablist';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Suggestions');
    var panels = [];
    var tabs = [];

    cards.forEach(function (card, i) {
      var title = card.querySelector('.submit-side-title');
      var name = text(title) || 'Panel ' + (i + 1);
      var id = 'ct-panel-' + i;

      var panel = document.createElement('div');
      panel.className = 'ct-tabpanel';
      panel.id = id;
      panel.setAttribute('role', 'tabpanel');
      panel.tabIndex = 0;
      panel.hidden = i !== 0;
      host.insertBefore(panel, card);
      panel.appendChild(card);
      panels.push(panel);

      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'ct-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', id);
      tab.setAttribute('aria-selected', String(i === 0));
      tab.tabIndex = i === 0 ? 0 : -1;
      tab.textContent = name;
      panel.setAttribute('aria-labelledby', 'ct-tab-' + i);
      tab.id = 'ct-tab-' + i;
      bar.appendChild(tab);
      tabs.push(tab);
    });

    host.insertBefore(bar, panels[0]);

    var select = function (index, focus) {
      tabs.forEach(function (tab, i) {
        var on = i === index;
        tab.setAttribute('aria-selected', String(on));
        tab.classList.toggle('is-on', on);
        tab.tabIndex = on ? 0 : -1;
        panels[i].hidden = !on;
      });
      if (focus) tabs[index].focus();
    };
    select(0, false);

    bar.addEventListener('click', function (event) {
      var tab = event.target.closest ? event.target.closest('.ct-tab') : null;
      if (tab) select(tabs.indexOf(tab), false);
    });
    bar.addEventListener('keydown', function (event) {
      var keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
      if (keys.indexOf(event.key) === -1) return;
      var index = tabs.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      var next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      select(next, true);
    });

    host.dataset.ctTabs = '1';
    mark(host, 'fluid-tabs');
  }

  /* ── Scan ───────────────────────────────────────────────────────────────── */
  function scan() {
    try {
      var nav = document.querySelector('.nav-tabs');
      if (nav && !nav.hasAttribute('data-ct-done')) gooeyNav(nav);

      var theme = document.getElementById('theme-toggle');
      if (theme && !theme.hasAttribute('data-ct-done')) themeSwitch(theme);

      // Beside the theme control in the nav: that bar is the one element every
      // route has (the Readme has no page header), and both switches are the same
      // kind of thing — how the page looks, not where you are going.
      var posterHost = theme && theme.parentNode ? theme.parentNode : document.querySelector('.nav-tabs');
      if (posterHost) posterSwitch(posterHost);

      var sidebar = document.getElementById('submit-sidebar-content');
      if (sidebar) fluidTabs(sidebar);

      fresh('select.df-select, select.sf-input').forEach(function (el) {
        if (el.id === 'sf-type') jellyRadio(el);
        else glideSelect(el);
      });

      fresh('.kpi-val, .stat-val, .recap-val, .rs-val, .readme-stat-val').forEach(counter);

      fresh('.kpi-card, .stat-card, .chart-title').forEach(function (el) {
        var label = el.querySelector('.kpi-label, .stat-label, .chart-sub');
        tooltip(el, label ? text(label) : '');
      });

      fresh('table tr').forEach(function (row) {
        if (row.closest('thead')) return;
        row.classList.add('ct-swipe');
        mark(row, 'swipe-row');
      });
      document.querySelectorAll('table tr').forEach(rowMenu);
      // The table is the control surface: each row carries a menu button, so the
      // component has enabled, keyboard-reachable controls without inventing a
      // second table. The pager beside it gets the numeric stepper.
      var table = document.querySelector('#app table');
      if (table) mark(table, 'inline-table-control');
      var pagerStep = document.querySelector('#app [data-page-step]');
      if (pagerStep && pagerStep.parentNode) stepper(pagerStep.parentNode);

      var filters = location.hash.indexOf('#data') === 0 ? document.querySelector('.df-select') : null;
      if (filters && filters.parentNode && !filters.parentNode.hasAttribute('data-ct-done')) {
        var bar = filters.parentNode.parentNode || filters.parentNode;
        if (bar && !bar.hasAttribute('data-ct-done')) filterDisclosure(bar);
      }

      scrollIsland();
      density();
      densitySegment();
      if (location.hash.indexOf('#data') === 0) {
        var dataBar = document.querySelector('.df-select');
        if (dataBar && dataBar.parentNode && dataBar.parentNode.parentNode) numericThreshold(dataBar.parentNode.parentNode);
      }
      monthStrip();
      fresh('.ct-txitem, .rw-card, .rec-item').forEach(accordion);
      fresh('.readme-stat').forEach(fundWidget);
      fresh('.try-btn, .sf-submit-btn').forEach(dynamicButton);
      fresh('.chart-card').forEach(chartCard);
      fresh('.name-link a, a.name-link').forEach(profileCard);
      fresh('.recap-cell, .rw-grid, .recent-grid, .tl-list').forEach(recentList);
    } catch (error) {
      // A component that cannot install must not take the page down with it.
      console.warn('component scan skipped part of the page:', error);
    }
    // Readiness for the coverage verifier: this scan is the last thing that
    // puts `data-component` markers, menus and strips into a freshly rendered
    // page, so a page is ready to be measured when this line has run.
    window.__ctReady = true;
  }

  window.CTComponents = { scan: scan };

  // app.js owns the render; this observer is how the layer follows it.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
  var pending = null;
  new MutationObserver(function () {
    if (pending) return;
    pending = setTimeout(function () { pending = null; scan(); }, 60);
  }).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
})();

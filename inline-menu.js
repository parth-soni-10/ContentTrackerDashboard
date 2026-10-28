/* Inline Disclosure Menu - the ":" on a row, and the actions behind it.
 *
 *   InlineMenu.attach(button, {
 *     label: 'Actions for Lidl, 12 Oct',
 *     items: [
 *       { id: 'edit',   label: 'Edit',   onSelect: function () { ... } },
 *       { id: 'delete', label: 'Delete', destructive: true,
 *         confirmLabel: 'Delete again', onSelect: function () { ... } }
 *     ]
 *   });
 *
 * attach() owns the trigger: it writes aria-haspopup/aria-expanded/aria-controls,
 * opens the menu on click (and ArrowDown), and puts focus back on the trigger
 * when the menu closes. The menu itself is appended to <body>, so a row that
 * scrolls or clips cannot cut it off; it is placed against the trigger's rect,
 * flipped above when there is no room below, and clamped inside the viewport.
 *
 * A destructive item is armed by its first activation, not run: its label swaps
 * to confirmLabel, it says so politely in a live region, and a second
 * activation within disarmAfter ms runs it. Escape, closing the menu, choosing
 * another item or the timer all disarm it, so a stray click can never delete.
 *
 * Keyboard: ArrowDown / ArrowUp walk the items, Home / End jump, a letter jumps
 * to the next item starting with it, Enter / Space activate, Escape closes,
 * Tab closes and lets the page continue. Disabled items are skipped.
 *
 * CSP-safe: no injected stylesheet, no style attribute in markup, no network.
 * It writes classes, attributes and CSS custom properties only.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var seq = 0;
  var STATE = '__imState';
  var open = null; // one menu at a time, page-wide
  var DEFAULTS = {
    label: 'Actions',
    align: 'end',
    disarmAfter: 4000,
    tokens: null,
    onOpen: null,
    onClose: null
  };
  // The panel lives on <body>, so it cannot inherit a row's custom properties
  // by cascade. These are copied off the trigger when the menu opens, which is
  // what makes a dark row's `--im-*` overrides reach the panel.
  var TOKENS = ['--im-bg', '--im-ink', '--im-muted', '--im-line', '--im-hover', '--im-danger', '--im-ring'];

  function inheritTokens(menu, trigger, extra) {
    var cs = global.getComputedStyle(trigger);
    TOKENS.forEach(function (name) {
      var value = cs.getPropertyValue(name);
      if (value && value.trim()) menu.style.setProperty(name, value.trim());
    });
    if (extra) {
      Object.keys(extra).forEach(function (name) {
        var value = extra[name];
        if (value !== null && value !== undefined && value !== '') menu.style.setProperty(name, String(value));
      });
    }
  }

  function makeEl(tag, cls, text) {
    var el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function focusables(menu) {
    return Array.prototype.filter.call(
      menu.querySelectorAll('.im-item'),
      function (el) { return !el.disabled && el.getAttribute('aria-disabled') !== 'true'; }
    );
  }

  function walk(menu, from, step) {
    var list = focusables(menu);
    if (!list.length) return;
    var i = list.indexOf(from);
    var next = list[(i + step + list.length) % list.length];
    next.focus();
  }

  function position(state) {
    var menu = state.menu;
    var trigger = state.trigger;
    if (!menu || !trigger) return;
    var r = trigger.getBoundingClientRect();
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var pad = 8;
    var gap = 6;
    var below = r.bottom + gap;
    var above = r.top - gap - h;
    var vh = global.innerHeight || doc.documentElement.clientHeight;
    var vw = global.innerWidth || doc.documentElement.clientWidth;
    var top;
    var origin;
    if (below + h <= vh - pad || above < pad) {
      top = Math.min(below, vh - pad - h);
      origin = 'top';
    } else {
      top = Math.max(pad, above);
      origin = 'bottom';
    }
    var left = state.align === 'start' ? r.left : r.right - w;
    left = Math.min(Math.max(pad, left), vw - pad - w);
    menu.style.setProperty('--im-x', Math.round(left) + 'px');
    menu.style.setProperty('--im-y', Math.round(top) + 'px');
    menu.setAttribute('data-im-side', origin);
  }

  function disarm(state) {
    if (!state.armed) return;
    var item = state.armed.item;
    var el = state.armed.el;
    if (state.disarmTimer) {
      global.clearTimeout(state.disarmTimer);
      state.disarmTimer = null;
    }
    el.classList.remove('is-armed');
    el.removeAttribute('data-im-armed');
    el.textContent = item.label;
    item.armed = false;
    state.armed = null;
  }

  function arm(state, item, el) {
    disarm(state);
    item.armed = true;
    el.classList.add('is-armed');
    el.setAttribute('data-im-armed', '');
    el.textContent = item.confirmLabel || 'Confirm';
    state.armed = { item: item, el: el };
    if (state.live) state.live.textContent = (item.confirmLabel || 'Confirm') + '. Press again to finish.';
    if (state.disarmAfter > 0) {
      state.disarmTimer = global.setTimeout(function () {
        disarm(state);
        if (state.live) state.live.textContent = 'Cancelled.';
      }, state.disarmAfter);
    }
  }

  function run(state, item, el) {
    if (!item || item.disabled) return;
    // The arm step is for a host with nothing to take the action back. A host
    // that already offers undo (or its own slide-to-confirm) opts out with
    // twoStep: false, so the item is styled dangerous but runs on one press.
    if (item.destructive && item.twoStep !== false) {
      if (!item.armed) {
        arm(state, item, el);
        return;
      }
      disarm(state);
      state.close(true);
      if (typeof item.onSelect === 'function') item.onSelect();
      return;
    }
    state.close(true);
    if (typeof item.onSelect === 'function') item.onSelect();
  }

  function build(state) {
    var menu = makeEl('div', 'im-menu');
    menu.id = 'im-menu-' + (++seq);
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', state.cfg.label);
    menu.setAttribute('data-im-side', 'top');

    var live = makeEl('span', 'im-live');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    menu.appendChild(live);
    state.live = live;

    state.items.forEach(function (item) {
      var el = makeEl('button', 'im-item', item.label);
      el.type = 'button';
      el.setAttribute('role', 'menuitem');
      el.setAttribute('tabindex', '-1');
      el.id = menu.id + '-' + item.id;
      if (item.destructive) el.classList.add('is-danger');
      if (item.className) el.classList.add(item.className);
      if (item.disabled) {
        el.disabled = true;
        el.setAttribute('aria-disabled', 'true');
      }
      if (item.hint) {
        var hint = makeEl('span', 'im-hint', item.hint);
        hint.setAttribute('aria-hidden', 'true');
        el.appendChild(hint);
      }
      el.addEventListener('click', function () { run(state, item, el); });
      el.addEventListener('keydown', function (ev) { onItemKey(ev, state, el, item); });
      menu.appendChild(el);
    });
    return menu;
  }

  function onItemKey(ev, state, el, item) {
    var k = ev.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      ev.preventDefault();
      disarm(state);
      walk(state.menu, el, k === 'ArrowDown' ? 1 : -1);
    } else if (k === 'Home' || k === 'End') {
      ev.preventDefault();
      disarm(state);
      var list = focusables(state.menu);
      if (list.length) list[k === 'Home' ? 0 : list.length - 1].focus();
    } else if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
      ev.preventDefault();
      run(state, item, el);
    } else if (k === 'Escape') {
      ev.preventDefault();
      state.close(true);
    } else if (k === 'Tab') {
      state.close(false);
    } else if (k && k.length === 1 && /\S/.test(k)) {
      var list2 = focusables(state.menu);
      var start = list2.indexOf(el) + 1;
      for (var i = 0; i < list2.length; i++) {
        var cand = list2[(start + i) % list2.length];
        if (cand.textContent.trim().toLowerCase().indexOf(k.toLowerCase()) === 0) {
          disarm(state);
          cand.focus();
          break;
        }
      }
    }
  }

  function attach(trigger, options) {
    if (!trigger) throw new Error('InlineMenu.attach needs a trigger element');
    if (trigger[STATE]) trigger[STATE].destroy();
    var cfg = Object.assign({}, DEFAULTS, options || {});
    var state = {
      trigger: trigger,
      cfg: cfg,
      items: (cfg.items || []).slice(),
      align: cfg.align === 'start' ? 'start' : 'end',
      disarmAfter: typeof cfg.disarmAfter === 'number' ? cfg.disarmAfter : DEFAULTS.disarmAfter,
      menu: null,
      live: null,
      armed: null,
      disarmTimer: null,
      open: false,
      close: null
    };

    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');

    // Enter and Space are the button's own activation (they fire click); the
    // arrows are the menu-button convention and open straight onto the items.
    function onTriggerKey(ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!state.open) openMenu(true);
      }
    }
    function onDocDown(ev) {
      if (!state.open) return;
      if (state.menu.contains(ev.target) || trigger.contains(ev.target)) return;
      state.close(false);
    }
    function onKeyDown(ev) {
      if (ev.key === 'Escape' && state.open) {
        ev.preventDefault();
        state.close(true);
      }
    }
    function onScroll() {
      if (state.open) position(state);
    }

    function openMenu(focusFirst) {
      if (state.open) return;
      if (open && open !== state) open.close(false);
      var menu = build(state);
      inheritTokens(menu, trigger, cfg.tokens);
      doc.body.appendChild(menu);
      state.menu = menu;
      trigger.setAttribute('aria-controls', menu.id);
      trigger.setAttribute('aria-expanded', 'true');
      state.open = true;
      open = state;
      position(state);
      doc.addEventListener('mousedown', onDocDown, true);
      doc.addEventListener('keydown', onKeyDown, true);
      global.addEventListener('resize', onScroll);
      global.addEventListener('scroll', onScroll, true);
      if (typeof cfg.onOpen === 'function') cfg.onOpen();
      var list = focusables(menu);
      if (focusFirst && list.length) list[0].focus();
    }

    state.close = function close(returnFocus) {
      if (!state.open) return;
      disarm(state);
      if (state.disarmTimer) {
        global.clearTimeout(state.disarmTimer);
        state.disarmTimer = null;
      }
      doc.removeEventListener('mousedown', onDocDown, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      global.removeEventListener('resize', onScroll);
      global.removeEventListener('scroll', onScroll, true);
      if (state.menu) state.menu.remove();
      state.menu = null;
      state.live = null;
      state.open = false;
      if (open === state) open = null;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-controls');
      if (returnFocus && trigger.isConnected && typeof trigger.focus === 'function') trigger.focus();
      if (typeof cfg.onClose === 'function') cfg.onClose();
    };

    state.toggle = function () {
      if (state.open) state.close(true);
      else openMenu(true);
    };

    state.setItems = function (items) {
      state.items = (items || []).slice();
      if (state.open) state.close(true);
    };

    state.destroy = function () {
      if (state.open) state.close(false);
      trigger.removeEventListener('click', onClick);
      trigger.removeEventListener('keydown', onTriggerKey);
      trigger.removeAttribute('aria-haspopup');
      trigger.removeAttribute('aria-expanded');
      delete trigger[STATE];
    };

    function onClick(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      state.toggle();
    }

    trigger.addEventListener('click', onClick);
    trigger.addEventListener('keydown', onTriggerKey);
    trigger[STATE] = state;
    return state;
  }

  function closeOpen() {
    if (open) open.close(false);
  }

  global.InlineMenu = {
    attach: attach,
    close: closeOpen,
    get current() { return open; }
  };

  // A page that navigates or hides the trigger must not leave a menu behind.
  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) closeOpen();
  });
})(typeof window !== 'undefined' ? window : this);

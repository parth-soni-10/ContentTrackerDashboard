/* Inline Table Control - a table cell that turns into its own small form.
 *
 *   InlineTable.attach(cellHost, {
 *     trigger: theButton,
 *     label: 'Edit €12.50 AIB slice',
 *     fields: [
 *       { key: 'amount', kind: 'money',  label: 'Amount', value: '12.50' },
 *       { key: 'method', kind: 'select', label: 'Method', value: 'AIB',
 *         options: [{ value: 'AIB', label: 'AIB · Current' }] }
 *     ],
 *     onSave: function (values) { ... }   // true, false, or a Promise
 *   });
 *
 * attach() owns the cell: the existing control is the trigger, and pressing it
 * hides that control and lays the fields out in its place, inside the cell the
 * control already occupied. Nothing moves on the page, so the row being edited
 * stays where the reader found it - the point of editing a table in place.
 *
 * The numbers behave like a spreadsheet cell rather than a dialog:
 *   Enter        commit (from the last field) or walk to the next field
 *   Escape       abandon the draft and hand focus back to the trigger
 *   Tab          leave the last field and the edit commits, like any cell
 *   click away   commits; an invalid value refuses and keeps the editor open
 *
 * onSave may return false to refuse the values (the host says no, the editor
 * stays), or a Promise to store them: the fields lock while it runs and the
 * editor closes only when it lands. A rejection keeps the draft and says so,
 * because a failed write must never look like a saved one.
 *
 * The editor is a detail of a cell, so it never activates the row around it:
 * pointer and Enter/Space events inside the fields stop there, and focus moving
 * between its own fields is not "clicked away" - only focus that truly leaves
 * the editor commits.
 *
 * A money field parses through the host's own `parse` (cents. hands over its
 * parseAmount), so a comma, a currency symbol and a trailing sign all mean what
 * they already mean everywhere else on the site.
 *
 * CSP-safe: classes, attributes and CSS custom properties only. No injected
 * style element, no inline handler, no network of its own.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var seq = 0;

  var ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  };

  var KINDS = {
    text: { inputmode: 'text', align: 'start' },
    money: { inputmode: 'decimal', align: 'end' },
    select: null
  };

  function el(tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function identity(value) { return value; }

  function attach(host, options) {
    if (!host) throw new Error('InlineTable.attach needs the cell to live in');
    if (!options || !options.trigger) throw new Error('InlineTable.attach needs a trigger');
    var cfg = options;
    var trigger = cfg.trigger;
    var fields = (cfg.fields || []).map(function (field) {
      var kind = field.kind || 'text';
      return Object.assign({
        kind: kind,
        parse: identity,
        format: function (v) { return String(v); }
      }, field, {
        // A money field is a text input that knows its keyboard; keeping it
        // type="text" is what lets the host's parser see "1,20" and "€4".
        inputmode: field.inputmode || (KINDS[kind] ? KINDS[kind].inputmode : 'text'),
        align: field.align || (KINDS[kind] ? KINDS[kind].align : 'start'),
        original: String(field.value == null ? '' : field.value)
      });
    });
    var uid = 'it' + (++seq);
    var editing = null;
    var busy = false;

    // The cell itself carries the token block (see the stylesheet), so a host
    // can re-theme one table by setting --it-* on any ancestor.
    host.classList.add('it');
    trigger.classList.add('it-trigger');
    trigger.setAttribute('aria-expanded', 'false');

    function isOpen() { return !!editing; }

    function open() {
      if (editing) return;
      var editor = el('span', 'it-editor');
      editor.setAttribute('role', 'group');
      editor.setAttribute('aria-label', cfg.label || 'Edit value');
      editor.setAttribute('data-it-busy', 'false');

      var inputs = {};
      fields.forEach(function (field, index) {
        var wrap = el('label', 'it-field');
        wrap.setAttribute('data-it-field', field.key);
        var caption = el('span', 'it-label', field.label);
        caption.id = uid + '-f' + index;
        wrap.appendChild(caption);

        var control;
        if (field.kind === 'select') {
          control = el('select', 'it-control it-select');
          (field.options || []).forEach(function (option) {
            var opt = el('option', null, option.label);
            opt.value = option.value;
            control.appendChild(opt);
          });
          control.value = field.original;
        } else {
          control = el('input', 'it-control it-input');
          control.type = 'text';
          control.autocomplete = 'off';
          control.spellcheck = false;
          control.value = field.original;
          control.setAttribute('inputmode', field.inputmode);
          if (field.maxLength) control.maxLength = field.maxLength;
          if (field.placeholder) control.placeholder = field.placeholder;
        }
        control.id = uid + '-i' + index;
        control.className += ' is-' + field.align;
        control.setAttribute('aria-labelledby', caption.id);
        if (field.width) control.style.width = field.width;
        control.addEventListener('keydown', function (ev) { onKey(ev, index); });
        inputs[field.key] = control;
        wrap.appendChild(control);
        editor.appendChild(wrap);
      });

      var actions = el('span', 'it-actions');
      var cancel = el('button', 'it-btn it-cancel');
      cancel.type = 'button';
      cancel.setAttribute('aria-label', 'Cancel edit');
      cancel.innerHTML = ICON.close;
      cancel.addEventListener('click', function () { close(true); });
      var save = el('button', 'it-btn it-save');
      save.type = 'button';
      save.setAttribute('aria-label', 'Save');
      save.innerHTML = ICON.check;
      save.addEventListener('click', commit);
      actions.appendChild(cancel);
      actions.appendChild(save);
      editor.appendChild(actions);

      var live = el('span', 'it-live');
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      editor.appendChild(live);

      // A pointerdown on Cancel must not be read as "clicked away", which would
      // commit the draft a moment before the button cancels it.
      var cancelling = false;
      cancel.addEventListener('pointerdown', function () { cancelling = true; });
      editor.addEventListener('focusout', function (ev) {
        if (!editing || busy || cancelling) return;
        var next = ev.relatedTarget;
        if (next && editor.contains(next)) return;
        // A <select> only takes focus once its popup opens, so the blur of the
        // field before it arrives with an empty relatedTarget - and committing
        // on that blink would tear the editor out from under the pointer that
        // is still on its way to the select. Where focus actually landed is the
        // only answer that holds for both a click away and a move between two
        // of this editor's own fields, so ask again on the next tick.
        var session = editing;
        setTimeout(function () {
          if (editing !== session || busy || cancelling) return;
          var landed = doc.activeElement;
          if (landed && editor.contains(landed)) return;
          commit();
        }, 0);
      });
      // The editor lives inside a table cell, and a table row is usually the
      // thing that opens the record. Nothing typed or clicked in a field is an
      // activation of that row, so the editor keeps its own input to itself -
      // pointer and Enter/Space alike, since that is how a row is opened.
      var keep = function (ev) { ev.stopPropagation(); };
      editor.addEventListener('pointerdown', keep);
      editor.addEventListener('mousedown', keep);
      editor.addEventListener('click', keep);
      editor.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') ev.stopPropagation();
      });

      editing = {
        editor: editor,
        inputs: inputs,
        live: live
      };
      cancelling = false;
      trigger.hidden = true;
      trigger.setAttribute('aria-expanded', 'true');
      host.appendChild(editor);
      if (cfg.row) {
        cfg.row.setAttribute('data-it-editing', '');
        // Everything but the cell being edited steps back, so the row reads as
        // one row with one live field in it rather than three competing ones.
        Array.prototype.forEach.call(cfg.row.children, function (sibling) {
          if (sibling !== host) sibling.classList.add('it-dim');
        });
      }
      var first = editor.querySelector('.it-control');
      if (first) {
        first.focus({ preventScroll: true });
        if (first.select && first.tagName === 'INPUT') first.select();
      }
    }

    function onKey(ev, index) {
      if (!editing) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        var key = fields[index].key;
        var control = editing.inputs[key];
        // Enter on a select is the browser's "confirm the open list"; only a
        // text field is the shortcut for the next field or the save.
        if (control.tagName === 'SELECT') return;
        var next = fields[index + 1];
        if (next && next.kind !== 'select') {
          editing.inputs[next.key].focus();
          editing.inputs[next.key].select();
        } else if (next) {
          editing.inputs[next.key].focus();
        } else {
          commit();
        }
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        close(true);
      } else if (ev.key === 'Tab' && !ev.shiftKey && index === fields.length - 1) {
        // Let the browser move focus; the focusout handler commits.
      }
    }

    function read() {
      var values = {};
      var bad = null;
      fields.forEach(function (field) {
        var raw = editing.inputs[field.key].value;
        var parsed = field.kind === 'select' ? raw : field.parse(raw);
        var invalid = field.kind !== 'select' && (parsed === undefined || parsed === null ||
          (typeof parsed === 'number' && !Number.isFinite(parsed)) || parsed === '');
        if (invalid) {
          if (!bad) bad = field.key;
        } else {
          values[field.key] = parsed;
        }
      });
      return { values: values, bad: bad };
    }

    function markInvalid(key, message) {
      editing.editor.setAttribute('data-it-invalid', '');
      editing.editor.classList.remove('is-invalid');
      void editing.editor.offsetWidth;
      editing.editor.classList.add('is-invalid');
      if (key && editing.inputs[key]) {
        editing.inputs[key].setAttribute('aria-invalid', 'true');
        editing.inputs[key].focus();
      }
      editing.live.textContent = message || 'That value does not work.';
    }

    function clearInvalid() {
      if (!editing) return;
      editing.editor.removeAttribute('data-it-invalid');
      editing.editor.classList.remove('is-invalid');
      Object.keys(editing.inputs).forEach(function (key) {
        editing.inputs[key].removeAttribute('aria-invalid');
      });
    }

    function commit() {
      if (!editing || busy) return;
      var read1 = read();
      if (read1.bad) {
        markInvalid(read1.bad, 'Check the highlighted field.');
        return;
      }
      // Nothing typed means nothing to save: closing without a write keeps the
      // undo journal quiet for a stray click into a cell.
      var changed = fields.some(function (field) {
        var before = field.kind === 'select' ? field.original : field.parse(field.original);
        if (before === undefined || before === null) before = field.original;
        return String(read1.values[field.key]) !== String(before);
      });
      if (!changed) { close(true); return; }
      clearInvalid();
      var outcome;
      try {
        outcome = cfg.onSave ? cfg.onSave(read1.values) : true;
      } catch (err) {
        fail(err);
        return;
      }
      if (outcome === false) {
        markInvalid(null, 'That change was refused.');
        return;
      }
      if (outcome && typeof outcome.then === 'function') {
        busy = true;
        editing.editor.setAttribute('data-it-busy', 'true');
        editing.editor.querySelectorAll('.it-control, .it-btn').forEach(function (node) {
          node.disabled = true;
        });
        outcome.then(function (result) {
          busy = false;
          if (result === false) {
            unbusy();
            markInvalid(null, 'That change was refused.');
            return;
          }
          close(false);
        }, function (err) {
          fail(err);
        });
        return;
      }
      close(false);
    }

    function unbusy() {
      if (!editing) return;
      editing.editor.setAttribute('data-it-busy', 'false');
      editing.editor.querySelectorAll('.it-control, .it-btn').forEach(function (node) {
        node.disabled = false;
      });
    }

    function fail(err) {
      busy = false;
      unbusy();
      markInvalid(null, (err && err.message) || 'Could not save. Try again.');
    }

    function close(returnFocus) {
      if (!editing) return;
      var editor = editing.editor;
      editing = null;
      busy = false;
      editor.remove();
      trigger.hidden = false;
      trigger.setAttribute('aria-expanded', 'false');
      if (cfg.row) {
        cfg.row.removeAttribute('data-it-editing');
        Array.prototype.forEach.call(cfg.row.children, function (sibling) {
          sibling.classList.remove('it-dim');
        });
      }
      if (returnFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    }

    trigger.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (isOpen()) close(true);
      else open();
    });

    var api = {
      open: open,
      close: function () { close(true); },
      isOpen: isOpen,
      destroy: function () {
        close(false);
        trigger.removeAttribute('aria-expanded');
      }
    };
    host.__it = api;
    return api;
  }

  global.InlineTable = { attach: attach };
})(typeof window !== 'undefined' ? window : this);

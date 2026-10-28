/* Dynamic Button - a button that resizes to whatever it is saying.
 *
 *   DynamicButton.say(btn, 'Copied ✓');          // crossfade in, and grow to fit
 *   DynamicButton.restore(btn);                  // crossfade back to the resting label
 *   DynamicButton.say(btn, nodeWithNewIcon);     // a Node: icons, not just text
 *
 * The host owns the button, its label, its handler and when a state begins and
 * ends. The kit owns the two things a label swap usually breaks: the box jumps
 * to the new width in one frame, and for that frame both labels are painted on
 * top of each other. Here the resting label becomes a layer, the state label
 * arrives as another, the two crossfade, and the width animates from one
 * layer's width to the other's - so a button that says "Copy CSV" and then
 * "Copied ✓" changes size rather than size-jumping.
 *
 * The resting label stays in flow (at opacity 0 while a state is showing), so
 * the button's height is still its own and its padding, gap and display are
 * unchanged. Everything else is untouched too: classes, aria, disabled, the
 * handler. No markup change is required - say() mounts the button on first use
 * - and with the script absent the button simply changes its own text, the way
 * it always did.
 *
 * Sizing is measured, never assumed: the shown layer's own width plus whatever
 * the button's own box adds around it, border-box or content-box. A button the
 * layout stretches - width:100%, a flex item that grows - is detected at mount
 * and keeps its own width; only its labels crossfade, because that box was
 * never the label's to decide. A box the host's own CSS pins (a 34px square
 * icon button) is the third case: it is a floor, not a target - a state that
 * fits inside it leaves the box exactly where it is, and one that needs more
 * room grows it and gives the box back on restore, rather than being silently
 * clipped by the box it was handed. Fonts that arrive late, and a resize,
 * re-measure quietly in one frame instead of animating to a stale width.
 *
 * A host that rebuilds its DOM - a screen that re-renders, a list that redraws -
 * throws the old button away without saying anything. The kit keeps one resize
 * listener for the whole page rather than one per mount, and prunes a button it
 * finds detached, so mounting again on the fresh button is all a host has to do
 * and a re-render does not leave a dead button alive behind it.
 */
(function (global) {
  'use strict';

  var doc = global.document;

  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function restFaceOf(btn) {
    return btn.querySelector('[data-db-rest]');
  }

  function faceWidth(face) {
    return face.getBoundingClientRect().width;
  }

  /* What the button's own box adds around the label, according to its own
     box-sizing. Measured fresh on every show, so a state that changes the
     padding is respected. */
  function boxOf(btn) {
    var cs = global.getComputedStyle(btn);
    var pad = num(cs.paddingLeft) + num(cs.paddingRight);
    var border = num(cs.borderLeftWidth) + num(cs.borderRightWidth);
    return cs.boxSizing === 'border-box' ? pad + border : 0;
  }

  /* Is the button as wide as the space its parent gives it? Then the layout is
     what set this width (width:100%, a flex item that grows) and the kit must
     not touch it: growing would push siblings and shrinking would leave a gap. */
  function fillsParent(btn, box) {
    var parent = btn.parentElement;
    if (!parent || !parent.getBoundingClientRect) return false;
    var cs = global.getComputedStyle(parent);
    var inner = parent.getBoundingClientRect().width - num(cs.paddingLeft) - num(cs.paddingRight)
      - num(cs.borderLeftWidth) - num(cs.borderRightWidth);
    return inner > 0 && Math.abs(box - inner) <= 1;
  }

  /* The width to paint a face at. A pinned box is the host's, and it only gives
     room when the label asks for more than the box's own label did: an
     icon-for-icon swap leaves a 34px square exactly where it was, while
     "Previewing" inside it grows the box to fit rather than being clipped by a
     width its own chrome (padding, border) was never counted in. */
  function widthFor(inst, face) {
    var w = faceWidth(face) + boxOf(inst.host);
    if (!inst.fixed) return w;
    var restW = faceWidth(restFaceOf(inst.host)) + boxOf(inst.host);
    return w > restW + 0.5 ? Math.max(w, inst.box) : inst.box;
  }

  /* One frame later, unless something newer was asked for in the meantime. */
  function afterPaint(inst, fn) {
    var seq = ++inst.seq;
    global.requestAnimationFrame(function () {
      if (inst.seq !== seq) return;
      fn();
    });
  }

  function makeFace(inst, content, kind) {
    var face = doc.createElement('span');
    face.className = 'db-face';
    face.setAttribute('data-db-face', kind || 'state');
    if (kind === 'rest') face.setAttribute('data-db-rest', '');
    if (typeof content === 'string') face.textContent = content;
    else if (content) face.appendChild(content);
    inst.host.appendChild(face);
    inst.faces.push(face);
    return face;
  }

  /* One frame with no transition: the first paint, a re-measure after a resize
     or a late font, or a state the host asked for instantly. */
  function quiet(inst, fn) {
    inst.host.setAttribute('data-db-quiet', '');
    fn();
    global.requestAnimationFrame(function () {
      global.requestAnimationFrame(function () {
        inst.host.removeAttribute('data-db-quiet');
      });
    });
  }

  function show(inst, face, opts) {
    if (!face) return;
    // Whatever was asked for earlier is settled by this: a deferred show that
    // has not run yet belongs to a state the host has already moved on from.
    inst.seq += 1;
    inst.current = face;
    inst.state = face.hasAttribute('data-db-rest') ? 'rest' : 'state';
    var apply = function () {
      var w = widthFor(inst, face);
      // A stretched button was never the label's width to set.
      inst.host.style.width = inst.stretch ? '' : (w > 0 ? w + 'px' : '');
      inst.faces.forEach(function (f) {
        var on = f === face;
        f.classList.toggle('is-on', on);
        if (on) f.removeAttribute('aria-hidden');
        else f.setAttribute('aria-hidden', 'true');
      });
      inst.host.setAttribute('data-db-showing', inst.state);
    };
    if (opts && opts.instant) quiet(inst, apply);
    else apply();
    inst.host.dispatchEvent(new global.CustomEvent('dynamic-button:change', {
      bubbles: true,
      detail: { label: face.textContent, state: inst.state, button: inst.host },
    }));
  }

  /* Hidden layers are reused, so a button that says several things in a row
     does not keep one layer per thing it has ever said. */
  function freeFace(inst) {
    for (var i = 0; i < inst.faces.length; i++) {
      var f = inst.faces[i];
      if (!f.hasAttribute('data-db-rest') && f !== inst.current) return f;
    }
    return null;
  }

  function say(btn, content, opts) {
    var el = typeof btn === 'string' ? doc.querySelector(btn) : btn;
    if (!el || el.nodeType !== 1) return null;
    var mounted = el.__dynamicButton;
    var inst = mounted || mount(el);
    if (!inst) return null;
    var face = freeFace(inst) || makeFace(inst, content, 'state');
    if (typeof content === 'string') face.textContent = content;
    else if (content) {
      while (face.firstChild) face.removeChild(face.firstChild);
      face.appendChild(content);
    }
    face.classList.remove('is-on');
    if (!mounted && !(opts && opts.instant)) {
      // A button this very call mounted has never been painted: the resting layer
      // was created a moment ago and mount()'s quiet frame is still on. Both have
      // to settle *before* the layers flip, or the host's first swap happens in
      // the same recalc that re-enabled the transitions and pops in instead of
      // cross-fading - the fixture the host was told to write would be the one
      // swap nobody ever sees. Reading geometry flushes the styles, and the swap
      // itself waits one frame so the browser has painted both layers at their
      // start values before it interpolates between them.
      el.removeAttribute('data-db-quiet');
      face.getBoundingClientRect();
      afterPaint(inst, function () {
        // A re-measure (a font arriving, the window resizing) opens a quiet frame
        // of its own and may have done so between the mount and this frame; the
        // swap is the thing being animated, so it turns that back off for itself.
        el.removeAttribute('data-db-quiet');
        face.getBoundingClientRect();
        show(inst, face, opts);
      });
      return inst;
    }
    show(inst, face, opts);
    return inst;
  }

  function restore(btn, opts) {
    var el = typeof btn === 'string' ? doc.querySelector(btn) : btn;
    if (!el || !el.__dynamicButton) return null;
    show(el.__dynamicButton, restFaceOf(el), opts);
    return el.__dynamicButton;
  }

  /* One resize listener for the page, not one per button: a host that rebuilds
     its DOM drops the old button without calling destroy(), and a listener per
     mount would keep every dead button alive for the life of the document. */
  var live = [];
  var watching = false;

  function remeasureAll() {
    for (var i = live.length - 1; i >= 0; i--) {
      var inst = live[i];
      if (!inst.host.isConnected) { live.splice(i, 1); continue; }
      if (inst.current) inst.remeasure();
    }
  }

  function watch(inst) {
    live.push(inst);
    if (watching) return;
    watching = true;
    global.addEventListener('resize', remeasureAll);
    if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) doc.fonts.ready.then(remeasureAll);
  }

  function unwatch(inst) {
    var i = live.indexOf(inst);
    if (i !== -1) live.splice(i, 1);
  }

  function mount(btn) {
    if (!btn || btn.nodeType !== 1) return null;
    if (btn.__dynamicButton) return btn.__dynamicButton;

    var inst = { host: btn, faces: [], current: null, state: 'rest', seq: 0, stretch: false, fixed: false, box: 0 };
    btn.__dynamicButton = inst;

    // The label the host wrote becomes the resting layer, in flow, so the
    // button's height, display and gap keep working.
    var rest = makeFace(inst, null, 'rest');
    while (btn.firstChild && btn.firstChild !== rest) rest.appendChild(btn.firstChild);

    // Is the button's width the label's to decide, the layout's, or the host's
    // own CSS? An unchanged label (natural == box) is the label's, and nothing
    // here has to decide anything.
    var natural = faceWidth(rest) + boxOf(btn);
    inst.box = btn.getBoundingClientRect().width;
    inst.stretch = Math.abs(inst.box - natural) > 1 && fillsParent(btn, inst.box);
    inst.fixed = Math.abs(inst.box - natural) > 1 && !inst.stretch;

    btn.setAttribute('data-db-ready', '');
    quiet(inst, function () { show(inst, rest); });

    inst.remeasure = function () {
      if (!inst.current) return;
      quiet(inst, function () {
        var w = widthFor(inst, inst.current);
        if (!inst.stretch) inst.host.style.width = w > 0 ? w + 'px' : '';
      });
    };
    watch(inst);
    return inst;
  }

  function destroy(btn) {
    var inst = btn && btn.__dynamicButton;
    if (!inst) return;
    inst.seq += 1; // a show waiting for its frame is not this button's problem any more
    var rest = restFaceOf(btn);
    // The resting layer's children go back where they were: the button is the
    // button it was before the kit touched it.
    if (rest) {
      while (rest.firstChild) btn.insertBefore(rest.firstChild, rest);
      btn.removeChild(rest);
    }
    inst.faces.forEach(function (f) { if (f.parentNode === btn) btn.removeChild(f); });
    unwatch(inst);
    btn.removeAttribute('data-db-ready');
    btn.removeAttribute('data-db-quiet');
    btn.removeAttribute('data-db-showing');
    btn.style.width = '';
    delete btn.__dynamicButton;
  }

  global.DynamicButton = {
    mount: mount,
    /* Say something: a string, or a Node for a state that carries its own icon. */
    say: say,
    /* Back to the label the host wrote in the markup. */
    restore: restore,
    destroy: destroy,
  };
})(window);

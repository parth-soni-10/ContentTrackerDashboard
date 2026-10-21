/* Reel — the watchlist as a film strip.
 *
 * The tiles are the six most recent rows the tracker has already loaded, so the
 * figure cannot show a title the Timeline does not. Pointing at a tile raises it
 * and reads its title and type; the real Timeline list stays the accessible
 * path to every row.
 *
 * Wrapped in an IIFE: the engine's figures are written at top level, and two of
 * them on one page would collide on their destructured names.
 */
(function () {
const {
  Cam, facing, fit, hull, open, poly, proj, rrect, ringAt, run, seg,
  spring, stepS, register, disposer, mk, pointer,
} = HL;

const STRIP_Z0 = 0.8, STRIP_Z1 = 2;
const TILE_Z0 = 2, TILE_Z1 = 5.4, LIFT = 4;
const HW = 6.4, HD = 8.6;
const XS = [-40, -24, -8, 8, 24, 40];

/** A rounded box, drawn from its foot and top rings. */
function boxAt(parent, P, front, cx, cy, hw, hd, z0, z1, r) {
  const foot = rrect(cx - hw, cy - hd, cx + hw, cy + hd, r, 6);
  const top = rrect(cx - hw + 0.8, cy - hd + 0.8, cx + hw - 0.8, cy + hd - 0.8, Math.max(0.6, r - 0.8), 6);
  const g = mk('g', {}, parent);
  const sil = mk('path', { d: poly(hull(ringAt(P, foot, z0).concat(ringAt(P, top, z1)))), class: 'sil' }, g);
  const cr = mk('path', { d: open(ringAt(P, run(top, front), z1)), class: 'nf lo' }, g);
  return { g, sil, cr, foot, top };
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();

  const C = Cam(45, 0.5, 2.55);
  fit(C, [[-52, -30, 0], [52, 30, 0], [-52, -30, 11], [52, 30, 11]], 200, 164);
  const P = proj(C), front = facing(C);
  const root = mk('g', {}, svg);

  let items = [];
  let tiles = [];
  let selected = -1;
  let signature = null;
  let board = null;

  function readDefault() {
    const n = items.length;
    read.textContent = n ? `${n} recent ${n === 1 ? 'watch' : 'watches'}` : 'No watch history yet';
    stage.setAttribute(
      'aria-label',
      n
        ? `${n} recent watches on a film strip. Point at a tile to read its title and type.`
        : 'No watch history has loaded yet.',
    );
  }

  function drawTile(tile, z) {
    tile.sil.setAttribute('d', poly(hull(ringAt(P, tile.foot, TILE_Z0).concat(ringAt(P, tile.top, z)))));
    tile.cr.setAttribute('d', open(ringAt(P, run(tile.top, front), z)));
  }

  function build() {
    if (board) {
      bag.add(board.unregister);
      board = null;
    }
    root.replaceChildren();
    selected = -1;

    const strip = boxAt(root, P, front, 0, 0, 50, 15, 0, STRIP_Z1, 3);
    // Sprocket guides: dashed rules just inside the strip's long edges.
    mk('path', { d: seg(P(-44, -12.6, STRIP_Z1), P(44, -12.6, STRIP_Z1)), class: 'nf dash' }, strip.g);
    mk('path', { d: seg(P(-44, 12.6, STRIP_Z1), P(44, 12.6, STRIP_Z1)), class: 'nf dash' }, strip.g);

    tiles = items.slice(0, XS.length).map((item, i) => {
      const cx = XS[i], cy = 0;
      const box = boxAt(root, P, front, cx, cy, HW, HD, TILE_Z0, TILE_Z1, 1.4);
      const sp = spring(0, { k: 150, c: 20 });
      const tile = { item, i, cx, cy, sil: box.sil, cr: box.cr, foot: box.foot, top: box.top, sp, lastZ: -1 };
      drawTile(tile, TILE_Z1);
      tile.lastZ = TILE_Z1;
      return tile;
    });

    const order = [{ key: -100, g: strip.g }, ...tiles.map((t) => ({ key: t.cx + t.cy, g: t.sil.parentNode }))];
    order.sort((a, b) => a.key - b.key).forEach((o) => root.appendChild(o.g));

    board = register(stage, (dt) => {
      let moving = false;
      for (const tile of tiles) {
        if (stepS(tile.sp, dt)) moving = true;
        const z = TILE_Z1 + tile.sp.x * LIFT;
        if (Math.abs(z - tile.lastZ) > 0.02) {
          tile.lastZ = z;
          drawTile(tile, z);
        }
      }
      return moving;
    });
    bag.add(board.unregister);
    bag.add(() => { board = null; });

    readDefault();
  }

  function highlight(i) {
    if (i === selected) return;
    selected = i;
    tiles.forEach((tile, k) => {
      tile.sp.t = k === i ? 1 : 0;
      tile.sil.setAttribute('class', k === i ? 'sil hi' : 'sil');
    });
    if (board) board.wake();
    if (i < 0) {
      readDefault();
      return;
    }
    const item = tiles[i].item;
    // The watchlist schema carries no rating column, so the suffix is drawn
    // only for a row that has one; nothing here invents a score.
    const rating = item.rating === '' || item.rating == null ? '' : ` · ★ ${item.rating}`;
    read.textContent = `${item.title} · ${item.type || 'Title'}${rating}`;
  }

  function pick(pt) {
    const [u, v] = HL.unproj(C, pt[0], pt[1], TILE_Z1 + LIFT);
    let best = -1, distance = Infinity;
    tiles.forEach((tile, i) => {
      const d = Math.abs(u - tile.cx);
      if (d < distance && d <= HW + 2 && Math.abs(v - tile.cy) <= HD + 2) {
        distance = d;
        best = i;
      }
    });
    return best;
  }

  function set(next) {
    const list = Array.isArray(next) ? next : [];
    const sig = list.map((x) => `${x.title}:${x.type || ''}:${x.rating || ''}`).join('|');
    if (sig === signature) return;
    signature = sig;
    items = list;
    build();
  }

  bag.add(pointer(stage, {
    move: (p) => highlight(pick(p)),
    down: (p) => highlight(pick(p)),
    leave: () => highlight(-1),
  }));
  bag.add(() => svg.replaceChildren());

  set(value);
  return { set, destroy: bag.dispose };
}

hairline({
  name: 'reel',
  means: 'Recent watches on a film strip; point at a tile to read its title and type.',
  rules: [1, 4, 6, 8],
  range: [0, 6, 1],
  tour: [[150, 150], [200, 120], [260, 160], [310, 200], null],
  mount,
});

let reelHandle = null;
let reelHost = null;

/**
 * The Timeline calls this with the rows it already holds. Keeping the mapping
 * here, rather than reading the app's internals, means the figure and the list
 * are fed from the same array on the same render.
 */
window.mountContentReel = function (rows) {
  const host = document.getElementById('content-reel');
  if (!host || !window.mountHairline) return;
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.name)
    .slice()
    .sort((a, b) => String(b.watchDate || '').localeCompare(String(a.watchDate || '')))
    .slice(0, 6)
    .map((r) => ({ title: String(r.name), type: r.type || '', rating: r.rating == null ? '' : String(r.rating) }));
  // The Timeline replaces #app on every render, so the host identity matters:
  // a set() on a detached host would leave the new strip blank.
  if (reelHandle && reelHost === host) {
    if (reelHandle.set) reelHandle.set(list);
    return;
  }
  if (reelHandle) reelHandle.destroy();
  reelHandle = window.mountHairline('content-reel', list);
  reelHost = host;
};
})();

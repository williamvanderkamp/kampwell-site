// The 3D view's geometry (view3d.js, docs/tools/model-3d.md): the meshes of the model's
// block, a cut through it, the water table, the wells, the boundary cells and the
// pathlines, built from the model and its run. Nothing here needs a window or WebGL, so it
// is tested in Node (tests/model/view3d-mesh.test.js).
//
// Coordinates are the model's own, in metres: x east of the grid's west edge, y north of
// its south edge (as MODPATH and the particle engine give them, so pathlines go in as they
// are), z the elevation. The view adds the vertical exaggeration, the georeference and the
// camera; nothing here is exaggerated.
//
// A grid of more than MAX_PLAN_CELLS cells in plan is drawn on a coarser display grid:
// blocks of stride × stride cells, each with the mean of their elevations and values, so
// a model of 1000 × 1000 cells is drawn as 500 × 500. The wells and boundary cells keep
// their own cells' positions.
import { edges, listIn } from './edit-model.js';

export const MAX_PLAN_CELLS = 250000;

// The codes of the cell texture: what a cell of the block is drawn as, over its layer's colour.
export const CODES = { none: 0, chd: 1, riv: 2, drn: 3, ghb: 4, evtList: 5, dry: 6 };
// When the cells of one display cell differ, the code drawn is the first of these it has.
const CODE_ORDER = ['chd', 'riv', 'ghb', 'drn', 'evtList'];

const at = (v, n) => (typeof v === 'number' ? v : v[n]);

/**
 * The grid as the view draws it. Returns { nlay, nrow, ncol, stride, ex, ey, W, H, iface,
 * active, full }: ex the display columns' edges east of the west edge (ncol + 1), ey the
 * rows' edges north of the south edge (nrow + 1, from the north edge down, as rows run from
 * north to south), iface[L] the elevation of interface L in each display cell (L = 0 the
 * top of the model, L = k + 1 the bottom of layer k), active 1 where a display cell is
 * drawn (idomain 1 in at least half its cells; a vertical pass-through cell, idomain −1,
 * is not drawn, as the map does not draw it), and full the model grid's own edges.
 */
export function displayGrid(model, maxCells = MAX_PLAN_CELLS) {
  const g = model.grid, { nlay, nrow, ncol } = g;
  const stride = Math.max(1, Math.ceil(Math.sqrt((nrow * ncol) / maxCells) - 1e-9));
  const nr = Math.ceil(nrow / stride), nc = Math.ceil(ncol / stride);
  const fx = edges(g.delr), fy = edges(g.delc);
  const W = fx[ncol], H = fy[nrow];
  const ex = Float64Array.from({ length: nc + 1 }, (_, j) => fx[Math.min(ncol, j * stride)]);
  const ey = Float64Array.from({ length: nr + 1 }, (_, i) => H - fy[Math.min(nrow, i * stride)]);
  const ncpl = nrow * ncol;
  const dg = { nlay, nrow: nr, ncol: nc, stride, ex, ey, W, H, full: { nrow, ncol, ex: fx, ey: Float64Array.from(fy, (v) => H - v) } };
  const active = new Uint8Array(nlay * nr * nc);
  const count = new Uint32Array(nr * nc), total = new Uint32Array(nr * nc);
  for (let k = 0; k < nlay; k++) {
    count.fill(0); total.fill(0);
    for (let i = 0; i < nrow; i++) {
      const di = Math.floor(i / stride) * nc;
      for (let j = 0; j < ncol; j++) {
        const d = di + Math.floor(j / stride);
        total[d]++;
        if (!g.idomain || g.idomain[k * ncpl + i * ncol + j] === 1) count[d]++;
      }
    }
    for (let d = 0; d < nr * nc; d++) active[k * nr * nc + d] = count[d] * 2 >= total[d] && count[d] > 0 ? 1 : 0;
  }
  dg.active = active;
  dg.iface = [];
  for (let L = 0; L <= nlay; L++) {
    const src = L === 0 ? g.top : g.botm[L - 1];
    dg.iface.push(meanOf(dg, (n) => at(src, n)));
  }
  return dg;
}

/**
 * The mean over each display cell of value(n), n the model's cell in plan (row * ncol +
 * col), over the cells where it is a finite number; NaN where none is.
 */
export function meanOf(dg, value) {
  const { nrow, ncol } = dg.full, s = dg.stride, nc = dg.ncol;
  const sum = new Float64Array(dg.nrow * nc), cnt = new Uint32Array(dg.nrow * nc);
  for (let i = 0; i < nrow; i++) {
    const di = Math.floor(i / s) * nc;
    for (let j = 0; j < ncol; j++) {
      const v = value(i * ncol + j);
      if (!Number.isFinite(v)) continue;
      const d = di + Math.floor(j / s);
      sum[d] += v; cnt[d]++;
    }
  }
  for (let d = 0; d < sum.length; d++) sum[d] = cnt[d] ? sum[d] / cnt[d] : NaN;
  return sum;
}

/**
 * The elevation of interface L at each corner of the display grid ((nrow + 1) × (ncol + 1),
 * row by row from the north-west corner): the mean of the cells around it that are drawn
 * in a layer the interface bounds, or of all the cells around it when none is. So the
 * surfaces of neighbouring cells meet, and the block has no gaps.
 */
export function cornerZ(dg, L) {
  const { nrow: nr, ncol: nc, nlay, active } = dg, z = dg.iface[L], ncpl = nr * nc;
  const out = new Float64Array((nr + 1) * (nc + 1));
  const drawn = (d) => (L > 0 && active[(L - 1) * ncpl + d]) || (L < nlay && active[L * ncpl + d]);
  for (let i = 0; i <= nr; i++) {
    for (let j = 0; j <= nc; j++) {
      let s = 0, n = 0, sAll = 0, nAll = 0;
      for (let a = i - 1; a <= i; a++) {
        if (a < 0 || a >= nr) continue;
        for (let b = j - 1; b <= j; b++) {
          if (b < 0 || b >= nc) continue;
          const d = a * nc + b, v = z[d];
          if (!Number.isFinite(v)) continue;
          sAll += v; nAll++;
          if (drawn(d)) { s += v; n++; }
        }
      }
      out[i * (nc + 1) + j] = n ? s / n : nAll ? sAll / nAll : 0;
    }
  }
  return out;
}

/** The lowest and highest elevation of the cells drawn: { zMin, zMax }. */
export function elevationRange(dg) {
  const { nrow: nr, ncol: nc, nlay, active } = dg, ncpl = nr * nc;
  let zMin = Infinity, zMax = -Infinity;
  for (let k = 0; k < nlay; k++) {
    for (let d = 0; d < ncpl; d++) {
      if (!active[k * ncpl + d]) continue;
      const t = dg.iface[k][d], b = dg.iface[k + 1][d];
      if (t > zMax) zMax = t;
      if (b < zMin) zMin = b;
    }
  }
  return Number.isFinite(zMin) ? { zMin, zMax } : { zMin: 0, zMax: 1 };
}

/**
 * The vertical exaggeration the view opens with: the one of 1, 2 and 5 times a power of
 * ten nearest (on a log scale) to the one that makes the model's thickness a fifth of its
 * longer side, and never below 1. m04 (800 m across, 46 m thick) opens at 5, m03
 * (11.8 km across, 10 m thick) at 200.
 */
export function defaultExaggeration(dg) {
  const { zMin, zMax } = elevationRange(dg);
  const thick = zMax - zMin, side = Math.max(dg.W, dg.H);
  if (!(thick > 0) || !(side > 0)) return 1;
  const want = side / 5 / thick;
  if (want <= 1) return 1;
  return EXAGGERATIONS.reduce((best, v) => (Math.abs(Math.log(v / want)) < Math.abs(Math.log(best / want)) ? v : best), 1);
}
export const EXAGGERATIONS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

// Typed arrays that grow as vertices are added: one per attribute, of the given widths.
function builder(widths) {
  let cap = 1024, n = 0, icap = 3072, ni = 0;
  const arrays = Object.fromEntries(Object.entries(widths).map(([k, w]) => [k, new Float32Array(cap * w)]));
  let index = new Uint32Array(icap);
  const grow = () => {
    cap *= 2;
    for (const [k, w] of Object.entries(widths)) { const a = new Float32Array(cap * w); a.set(arrays[k]); arrays[k] = a; }
  };
  return {
    get count() { return n; },
    // add({ position: [x, y, z], ... }) → the vertex's number
    add(v) {
      if (n === cap) grow();
      for (const [k, w] of Object.entries(widths)) {
        const a = arrays[k], src = v[k];
        if (w === 1) a[n] = src; else for (let c = 0; c < w; c++) a[n * w + c] = src[c];
      }
      return n++;
    },
    tri(a, b, c) {
      if (ni + 3 > icap) { icap *= 2; const x = new Uint32Array(icap); x.set(index); index = x; }
      index[ni++] = a; index[ni++] = b; index[ni++] = c;
    },
    quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); },
    finish() {
      const out = { vertexCount: n, index: index.slice(0, ni) };
      for (const [k, w] of Object.entries(widths)) out[k] = arrays[k].slice(0, n * w);
      return out;
    },
  };
}

// The normal of a surface z given at the nodes x (columns) and y (rows), at node (i, j), from
// the differences to its neighbours (one-sided at the edges and where a neighbour is not a
// number). up false turns it downward.
function nodeNormal(z, x, y, i, j, up = true) {
  const nx = x.length, ny = y.length, v = z[i * nx + j];
  const pick = (a, b) => (Number.isFinite(a) ? a : b);
  const jl = j > 0 && Number.isFinite(z[i * nx + j - 1]) ? j - 1 : j, jr = j < nx - 1 && Number.isFinite(z[i * nx + j + 1]) ? j + 1 : j;
  const iu = i > 0 && Number.isFinite(z[(i - 1) * nx + j]) ? i - 1 : i, id = i < ny - 1 && Number.isFinite(z[(i + 1) * nx + j]) ? i + 1 : i;
  const dzdx = jr > jl ? (pick(z[i * nx + jr], v) - pick(z[i * nx + jl], v)) / (x[jr] - x[jl]) : 0;
  const dzdy = id > iu ? (pick(z[id * nx + j], v) - pick(z[iu * nx + j], v)) / (y[id] - y[iu]) : 0;
  const l = Math.hypot(dzdx, dzdy, 1), s = up ? 1 : -1;
  return [(-dzdx / l) * s, (-dzdy / l) * s, (1 / l) * s];
}

const BLOCK_ATTRS = { position: 3, normal: 3, grid: 2, layer: 1, kind: 1, fixed: 1 };

/**
 * The outer surface of the cells drawn: the top of each cell with no cell drawn above it,
 * the bottom of each with none below, and each side with no cell drawn beside it. Each face
 * belongs to its cell's layer (layer, from 0). The tops and bottoms share their corners, so
 * they are smooth; grid gives the column and row at a corner (rows from the north), so the
 * cell under a point is (floor(grid[0]), floor(grid[1])). A side has kind 1, grid the
 * position along it (column or row) and down it (k at its top, k + 1 at its bottom), and
 * fixed the row or column it is on. Returns typed arrays: position, normal, grid, layer,
 * kind, fixed, index (triangles), vertexCount.
 */
export function blockMesh(dg) {
  const { nrow: nr, ncol: nc, nlay, active, ex, ey } = dg, ncpl = nr * nc, nn = (nr + 1) * (nc + 1);
  const corners = [];
  for (let L = 0; L <= nlay; L++) corners.push(cornerZ(dg, L));
  const on = (k, i, j) => k >= 0 && k < nlay && i >= 0 && i < nr && j >= 0 && j < nc && active[k * ncpl + i * nc + j] === 1;
  const b = builder(BLOCK_ATTRS);
  // The shared corners of each layer's tops (up) and bottoms (down), made as they are needed.
  const shared = new Map();
  const corner = (k, L, up, i, j) => {
    const key = `${k}|${up ? 1 : 0}`;
    let m = shared.get(key);
    if (!m) { m = new Int32Array(nn).fill(-1); shared.set(key, m); }
    const c = i * (nc + 1) + j;
    if (m[c] < 0) {
      m[c] = b.add({ position: [ex[j], ey[i], corners[L][c]], normal: nodeNormal(corners[L], ex, ey, i, j, up), grid: [j, i], layer: k, kind: 0, fixed: 0 });
    }
    return m[c];
  };
  const side = (k, pts, normal, along, fixed) => {
    // pts: the two corners [i, j] at its ends; along: their positions along the side.
    const v = [];
    for (const [L, down] of [[k, k], [k + 1, k + 1]]) {
      pts.forEach(([i, j], e) => v.push(b.add({ position: [ex[j], ey[i], corners[L][i * (nc + 1) + j]], normal, grid: [along[e], down], layer: k, kind: 1, fixed })));
    }
    b.quad(v[0], v[1], v[3], v[2]);
  };
  for (let k = 0; k < nlay; k++) {
    for (let i = 0; i < nr; i++) {
      for (let j = 0; j < nc; j++) {
        if (!on(k, i, j)) continue;
        if (!on(k - 1, i, j)) b.quad(corner(k, k, true, i, j), corner(k, k, true, i, j + 1), corner(k, k, true, i + 1, j + 1), corner(k, k, true, i + 1, j));
        if (!on(k + 1, i, j)) b.quad(corner(k, k + 1, false, i, j), corner(k, k + 1, false, i + 1, j), corner(k, k + 1, false, i + 1, j + 1), corner(k, k + 1, false, i, j + 1));
        if (!on(k, i, j - 1)) side(k, [[i, j], [i + 1, j]], [-1, 0, 0], [i, i + 1], j);
        if (!on(k, i, j + 1)) side(k, [[i, j + 1], [i + 1, j + 1]], [1, 0, 0], [i, i + 1], j);
        if (!on(k, i - 1, j)) side(k, [[i, j], [i, j + 1]], [0, 1, 0], [j, j + 1], i);
        if (!on(k, i + 1, j)) side(k, [[i + 1, j], [i + 1, j + 1]], [0, -1, 0], [j, j + 1], i);
      }
    }
  }
  return b.finish();
}

/**
 * Each layer's value in each display cell: values is the model's nlay × nrow × ncol (heads,
 * NaN where inactive or dry), averaged over the cells of each display cell that are active
 * (idomain 1) and finite. Returns a Float64Array of nlay × nrow × ncol display cells.
 */
export function layerMeans(dg, model, values) {
  const g = model.grid, ncpl = g.nrow * g.ncol, dcpl = dg.nrow * dg.ncol;
  const out = new Float64Array(dg.nlay * dcpl);
  for (let k = 0; k < dg.nlay; k++) {
    const m = meanOf(dg, (n) => (!g.idomain || g.idomain[k * ncpl + n] === 1 ? values[k * ncpl + n] : NaN));
    out.set(m, k * dcpl);
  }
  return out;
}

/**
 * The water table: in each column of the model, the head in its uppermost active cell that
 * is not dry (heads, nlay × nrow × ncol, NaN where inactive or dry), and, when ref is given
 * (the reference heads of the drawdown), the drawdown there, ref − head, in that same cell.
 * Returns { z, value, layer } per display cell: z the head (NaN where no cell has one),
 * value the drawdown (or the head again), layer the uppermost layer the water table is in.
 */
export function waterTable(dg, model, heads, ref = null) {
  const g = model.grid, ncpl = g.nrow * g.ncol;
  const top = new Float64Array(ncpl).fill(NaN), dd = new Float64Array(ncpl).fill(NaN), lay = new Int16Array(ncpl).fill(-1);
  for (let n = 0; n < ncpl; n++) {
    for (let k = 0; k < g.nlay; k++) {
      const c = k * ncpl + n;
      if (g.idomain && g.idomain[c] !== 1) continue;
      const h = heads[c];
      if (!Number.isFinite(h)) continue;
      top[n] = h; lay[n] = k;
      if (ref) dd[n] = ref[c] - h;
      break;
    }
  }
  const z = meanOf(dg, (n) => top[n]);
  const layer = new Int16Array(dg.nrow * dg.ncol).fill(-1);
  const s = dg.stride;
  for (let i = 0; i < g.nrow; i++) for (let j = 0; j < g.ncol; j++) {
    const n = i * g.ncol + j, d = Math.floor(i / s) * dg.ncol + Math.floor(j / s);
    if (lay[n] >= 0 && (layer[d] < 0 || lay[n] < layer[d])) layer[d] = lay[n];
  }
  return { z, value: ref ? meanOf(dg, (n) => dd[n]) : z, layer };
}

const SURFACE_ATTRS = { position: 3, normal: 3, grid: 2, value: 1 };

/**
 * A surface over the grid through the centre of each display cell, at z (one per display
 * cell) and carrying value: the water table. Its nodes are the cells' centres and the grid's
 * edges, so the surface reaches the edges and, between centres, is linear as the map's
 * contours are. A square of four nodes is drawn only when all four have a z and a value,
 * so dry and inactive columns leave holes. Returns typed arrays: position, normal, grid,
 * value, index, vertexCount.
 */
export function surfaceMesh(dg, z, value) {
  const { nrow: nr, ncol: nc, ex, ey } = dg;
  const X = new Float64Array(nc + 2), Y = new Float64Array(nr + 2), U = new Float64Array(nc + 2), V = new Float64Array(nr + 2);
  X[0] = ex[0]; X[nc + 1] = ex[nc]; U[0] = 0; U[nc + 1] = nc;
  for (let j = 0; j < nc; j++) { X[j + 1] = (ex[j] + ex[j + 1]) / 2; U[j + 1] = j + 0.5; }
  Y[0] = ey[0]; Y[nr + 1] = ey[nr]; V[0] = 0; V[nr + 1] = nr;
  for (let i = 0; i < nr; i++) { Y[i + 1] = (ey[i] + ey[i + 1]) / 2; V[i + 1] = i + 0.5; }
  const cellOf = (I, J) => Math.min(nr - 1, Math.max(0, I - 1)) * nc + Math.min(nc - 1, Math.max(0, J - 1));
  const nx = nc + 2, ny = nr + 2;
  const nz = new Float64Array(nx * ny);
  for (let I = 0; I < ny; I++) for (let J = 0; J < nx; J++) {
    const c = cellOf(I, J);
    nz[I * nx + J] = Number.isFinite(z[c]) && Number.isFinite(value[c]) ? z[c] : NaN;
  }
  const b = builder(SURFACE_ATTRS);
  const id = new Int32Array(nx * ny).fill(-1);
  const node = (I, J) => {
    const q = I * nx + J;
    if (id[q] < 0) id[q] = b.add({ position: [X[J], Y[I], nz[q]], normal: nodeNormal(nz, X, Y, I, J), grid: [U[J], V[I]], value: value[cellOf(I, J)] });
    return id[q];
  };
  for (let I = 0; I + 1 < ny; I++) {
    for (let J = 0; J + 1 < nx; J++) {
      if (!(Number.isFinite(nz[I * nx + J]) && Number.isFinite(nz[I * nx + J + 1]) && Number.isFinite(nz[(I + 1) * nx + J]) && Number.isFinite(nz[(I + 1) * nx + J + 1]))) continue;
      b.quad(node(I, J), node(I, J + 1), node(I + 1, J + 1), node(I + 1, J));
    }
  }
  return b.finish();
}

// A value too large to be a head: a node of a cut with no value.
export const NONE = 3e38;
const SECTION_ATTRS = { position: 3, normal: 3, grid: 2, layer: 1, kind: 1, fixed: 1, value: 1, wt: 1 };

/**
 * The face of a cut through the block. axis 'col': the west face of display column index,
 * for rows from to to (end not included); axis 'row': the south face of display row index,
 * for columns from to to. The face has the cells drawn of that column or row, each split at
 * its centre across and down, so values (display cells, nlay × nrow × ncol: heads or
 * drawdown, NaN for none) are linear between cell centres as on the map, and at a layer's
 * top and bottom are the mean of the layers' values. wt, one z per display cell, is the
 * water table, given per node, above which the view shows the layers instead of the value.
 * Returns the mesh's typed arrays (position, normal, grid, layer, kind, fixed, value, wt,
 * index, vertexCount) and line, the water table along the face as segments
 * [x0, y0, z0, x1, y1, z1, ...].
 */
export function sectionMesh(dg, { axis, index, from = 0, to, values = null, wt = null }) {
  const { nrow: nr, ncol: nc, nlay, active, ex, ey } = dg, ncpl = nr * nc;
  const n = axis === 'col' ? nr : nc;
  const end = Math.min(n, to === undefined ? n : to);
  const corners = [];
  for (let L = 0; L <= nlay; L++) corners.push(cornerZ(dg, L));
  // The display cell at position a along the face, and the corner at edge e (0 to n) of the face.
  const cellAt = (a) => (axis === 'col' ? a * nc + index : index * nc + a);
  const cornerAt = (e) => (axis === 'col' ? e * (nc + 1) + index : (index + 1) * (nc + 1) + e);
  const xyAt = (e) => (axis === 'col' ? [ex[index], ey[e]] : [ex[e], ey[index + 1]]);
  const normal = axis === 'col' ? [-1, 0, 0] : [0, -1, 0];
  const on = (k, a) => a >= 0 && a < n && k >= 0 && k < nlay && active[k * ncpl + cellAt(a)] === 1;
  const val = (k, a) => (values && on(k, a) && Number.isFinite(values[k * ncpl + cellAt(a)]) ? values[k * ncpl + cellAt(a)] : NaN);
  const mean = (p, q) => (Number.isFinite(p) && Number.isFinite(q) ? (p + q) / 2 : Number.isFinite(p) ? p : q);
  // A layer's value at the face's edge e (between a − 1 and a), or at the centre of a.
  const atEdge = (k, e) => mean(val(k, e - 1), val(k, e));
  const wtAt = (a) => (wt && a >= 0 && a < n && Number.isFinite(wt[cellAt(a)]) ? wt[cellAt(a)] : NaN);
  const wtEdge = (e) => mean(wtAt(e - 1), wtAt(e));
  const b = builder(SECTION_ATTRS);
  const line = [];
  for (let a = from; a < end; a++) {
    const hor = [[a, 0], [a, 0.5], [a + 1, 0]]; // edge a, centre of a, edge a + 1
    const xy = hor.map(([e, half]) => (half ? xyAt(e).map((v, c) => (v + xyAt(e + 1)[c]) / 2) : xyAt(e)));
    const zAt = (L) => {
      const z0 = corners[L][cornerAt(a)], z1 = corners[L][cornerAt(a + 1)];
      return [z0, (z0 + z1) / 2, z1];
    };
    const w = [wtEdge(a), wtAt(a), wtEdge(a + 1)];
    for (let k = 0; k < nlay; k++) {
      if (!on(k, a)) continue;
      const own = val(k, a);
      const h = [atEdge(k, a), own, atEdge(k, a + 1)];
      const above = [atEdge(k - 1, a), val(k - 1, a), atEdge(k - 1, a + 1)], below = [atEdge(k + 1, a), val(k + 1, a), atEdge(k + 1, a + 1)];
      const zt = zAt(k), zb = zAt(k + 1);
      const rows = [
        { z: zt, v: h.map((x, c) => mean(x, above[c])), down: k },
        { z: zt.map((x, c) => (x + zb[c]) / 2), v: h, down: k + 0.5 },
        { z: zb, v: h.map((x, c) => mean(x, below[c])), down: k + 1 },
      ];
      const ids = rows.map((r) => hor.map(([e, half], c) => b.add({
        position: [xy[c][0], xy[c][1], r.z[c]], normal, grid: [e + half, r.down], layer: k, kind: 1, fixed: index,
        value: Number.isFinite(own) && Number.isFinite(r.v[c]) ? r.v[c] : NONE, wt: Number.isFinite(w[c]) ? w[c] : -NONE,
      })));
      for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) b.quad(ids[r][c], ids[r][c + 1], ids[r + 1][c + 1], ids[r + 1][c]);
    }
    for (let c = 0; c < 2; c++) {
      if (Number.isFinite(w[c]) && Number.isFinite(w[c + 1])) line.push(xy[c][0], xy[c][1], w[c], xy[c + 1][0], xy[c + 1][1], w[c + 1]);
    }
  }
  return { ...b.finish(), line: Float32Array.from(line) };
}

/**
 * What each display cell of the block is drawn as in period p (CODES): a constant head,
 * river, drain, general-head or evapotranspiration cell of that period's lists, or dry
 * (dry, the model's cells, nlay × nrow × ncol numbering, that are dry at the step).
 * Returns a Uint8Array of nlay × nrow × ncol display cells.
 */
export function cellCodes(dg, model, p, dry = []) {
  const g = model.grid, ncpl = g.nrow * g.ncol, dcpl = dg.nrow * dg.ncol, s = dg.stride;
  const out = new Uint8Array(dg.nlay * dcpl);
  const display = (k, i, j) => k * dcpl + Math.floor(i / s) * dg.ncol + Math.floor(j / s);
  for (const n of dry) {
    const k = Math.floor(n / ncpl), c = n - k * ncpl;
    out[display(k, Math.floor(c / g.ncol), c % g.ncol)] = CODES.dry;
  }
  for (const id of [...CODE_ORDER].reverse()) {
    for (const e of listIn(model, id, p)) {
      const d = display(e[0], e[1], e[2]);
      if (out[d] !== CODES.dry || id === 'chd') out[d] = CODES[id];
    }
  }
  return out;
}

/**
 * The wells of a period's list ([lay, row, col, q]) as rods: one per cell in plan, at its
 * centre, from the top of its uppermost active cell (land) down, with a screen for each
 * layer the list gives it, from that cell's bottom to its top. q is the sum of the rates in
 * the column (m³/d, negative for pumping). Returns [{ row, col, x, y, land, screens:
 * [{ lay, z0, z1, q }], q }].
 */
export function wellRods(model, wells) {
  const g = model.grid, ncpl = g.nrow * g.ncol;
  const fx = edges(g.delr), fy = edges(g.delc), H = fy[g.nrow];
  const iface = (L, n) => at(L === 0 ? g.top : g.botm[L - 1], n);
  const byCell = new Map();
  for (const [lay, row, col, q] of wells) {
    const n = row * g.ncol + col;
    let w = byCell.get(n);
    if (!w) {
      let top = 0;
      while (top < g.nlay - 1 && g.idomain && g.idomain[top * ncpl + n] !== 1) top++;
      w = { row, col, x: (fx[col] + fx[col + 1]) / 2, y: H - (fy[row] + fy[row + 1]) / 2, land: iface(top, n), screens: [], q: 0 };
      byCell.set(n, w);
    }
    w.screens.push({ lay, z0: iface(lay + 1, n), z1: iface(lay, n), q });
    w.q += q;
  }
  return [...byCell.values()];
}

/**
 * Pathlines as segments for the view: paths are the particle engine's ([{ points: [{ x, y,
 * z, t }] }], x and y as here). Returns { segments: Float32Array [x0, y0, z0, t0, x1, y1,
 * z1, t1, ...], tMin, tMax }: tMin the earliest time above zero on any point and tMax the
 * latest, for the colour scale of travel time.
 */
export function pathSegments(paths) {
  const out = [];
  let tMin = Infinity, tMax = 0;
  for (const p of paths) {
    const pts = p.points;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      if (q.t > 0 && q.t < tMin) tMin = q.t;
      if (q.t > tMax) tMax = q.t;
      if (i === 0) continue;
      const a = pts[i - 1];
      if (a.x === q.x && a.y === q.y && a.z === q.z) continue;
      out.push(a.x, a.y, a.z, a.t, q.x, q.y, q.z, q.t);
    }
  }
  return { segments: Float32Array.from(out), tMin: Number.isFinite(tMin) ? tMin : 0, tMax };
}

/**
 * Where each particle is at time t (days of tracking): along its path, linearly between
 * the path's points, and at its end once it has stopped. Returns a Float32Array of
 * [x, y, z, moving] per path, moving 1 while the particle is still on its way and 0 once it
 * has stopped.
 */
export function particlesAt(paths, t) {
  const out = new Float32Array(paths.length * 4);
  paths.forEach((p, n) => {
    const pts = p.points, last = pts[pts.length - 1];
    let q = last, moving = 0;
    if (t < last.t) {
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].t <= t) lo = m; else hi = m; }
      const a = pts[lo], b = pts[hi], f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      q = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
      moving = 1;
    }
    out.set([q.x, q.y, q.z, moving], n * 4);
  });
  return out;
}

/**
 * The elevation of the top of the block at the point (x, y), linear between the centres of
 * the display cells as the water table is, for lines laid on the land surface. top is
 * one value per display cell: the top of its uppermost cell drawn (landSurface).
 */
export function surfaceAt(dg, top, x, y) {
  const { nrow: nr, ncol: nc, ex, ey } = dg;
  const find = (e, v, n, down) => {
    // The fractional cell centre index of v along edges e: centres at index + 0.5.
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (down ? e[m] >= v : e[m] <= v) lo = m; else hi = m; }
    const f = (v - e[lo]) / (e[lo + 1] - e[lo]);
    return Math.min(n - 1, Math.max(0, lo + f - 0.5));
  };
  const fj = find(ex, x, nc, false), fi = find(ey, y, nr, true);
  const j0 = Math.floor(fj), i0 = Math.floor(fi), j1 = Math.min(nc - 1, j0 + 1), i1 = Math.min(nr - 1, i0 + 1);
  const a = fj - j0, c = fi - i0;
  const v = (i, j) => top[i * nc + j];
  const pts = [[v(i0, j0), (1 - a) * (1 - c)], [v(i0, j1), a * (1 - c)], [v(i1, j0), (1 - a) * c], [v(i1, j1), a * c]];
  let s = 0, w = 0;
  for (const [z, f] of pts) if (Number.isFinite(z)) { s += z * f; w += f; }
  return w > 0 ? s / w : NaN;
}

/** The top of the uppermost cell drawn in each display column (NaN where none is). */
export function landSurface(dg) {
  const { nrow: nr, ncol: nc, nlay, active } = dg, ncpl = nr * nc;
  const out = new Float64Array(ncpl).fill(NaN);
  for (let d = 0; d < ncpl; d++) {
    for (let k = 0; k < nlay; k++) if (active[k * ncpl + d]) { out[d] = dg.iface[k][d]; break; }
  }
  return out;
}

/**
 * Lines laid on the land surface: each outline ([{ x, y }], closed) cut into pieces no
 * longer than a display cell, each piece's ends at the surface's elevation there. Returns
 * segments [x0, y0, z0, x1, y1, z1, ...].
 */
export function drape(dg, top, outlines) {
  const out = [];
  // Pieces of the smallest cell's width, or of 1/2000 of the grid where its cells are smaller.
  let small = Infinity;
  for (let j = 0; j < dg.ncol; j++) small = Math.min(small, dg.ex[j + 1] - dg.ex[j]);
  for (let i = 0; i < dg.nrow; i++) small = Math.min(small, dg.ey[i] - dg.ey[i + 1]);
  const step = Math.max(small, Math.max(dg.W, dg.H) / 2000);
  for (const pts of outlines) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / step));
      let x0 = p.x, y0 = p.y, z0 = surfaceAt(dg, top, x0, y0);
      for (let s = 1; s <= n; s++) {
        const x1 = p.x + ((q.x - p.x) * s) / n, y1 = p.y + ((q.y - p.y) * s) / n, z1 = surfaceAt(dg, top, x1, y1);
        if (Number.isFinite(z0) && Number.isFinite(z1)) out.push(x0, y0, z0, x1, y1, z1);
        x0 = x1; y0 = y1; z0 = z1;
      }
    }
  }
  return Float32Array.from(out);
}

/** Whether two models have the same grid: sizes, widths, top, bottoms and active cells. */
export function sameGrid(a, b) {
  if (!a || !b) return false;
  const ga = a.grid, gb = b.grid;
  if (ga.nlay !== gb.nlay || ga.nrow !== gb.nrow || ga.ncol !== gb.ncol) return false;
  const same = (x, y) => {
    if (x === y) return true;
    if (!x || !y || typeof x === 'number' || typeof y === 'number' || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  };
  return same(ga.delr, gb.delr) && same(ga.delc, gb.delc) && same(ga.top, gb.top) && ga.botm.every((v, k) => same(v, gb.botm[k])) && same(ga.idomain, gb.idomain);
}

/** The smallest and largest finite value of any of the arrays given, or null. */
export function rangeOf(arrays) {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrays) for (let i = 0; i < a.length; i++) { const v = a[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  return lo <= hi ? [lo, hi] : null;
}

// The 3D view panel of the model page (docs/tools/model-3d.md): the model as a block of its
// layers, cut along a row or a column with the heads on the cut, the water table over it
// coloured by head or drawdown, the wells, the boundary cells, dry cells and the pathlines
// of the particle panel, at any time step, in WebGL2. Built from view3d-mesh.js (the
// geometry, tested in Node) and view3d-gl.js (the drawing).
//
// The page mounts it as its other panels (panels.js): mount(host, ctx) resolves to
// { update(model, result, state), overlaysChanged() }. ctx.overlays() gives what the other
// panels have drawn, by panel id: the particle panel's { paths, zones }. The panel opens
// closed, with a button: no WebGL context is made, and nothing is drawn, until it is asked
// for, and closing it or leaving the page (ctx.signal) frees the context and stops its
// animation.
import { countOf, el, fixed, panel, sig, together } from '../../kit.js';
import { saveFile } from '../../ui.js';
import { drawdownReference, intervalDecimals, niceInterval, referenceHeads, referenceText } from './calc.js';
import { field } from './common.js';
import { PACKAGES } from './edit-model.js';
import { orbit, project, renderer, hexRgb } from './view3d-gl.js';
import {
  blockMesh, cellCodes, CODES, defaultExaggeration, displayGrid, drape, elevationRange, EXAGGERATIONS, landSurface, layerMeans,
  particlesAt, pathSegments, rangeOf, sameGrid, sectionMesh, surfaceAt, surfaceMesh, waterTable, wellRods,
} from './view3d-mesh.js';

const FOV = (30 * Math.PI) / 180;
const DEG = Math.PI / 180;
const HOME = { azimuth: 225 * DEG, elevation: 28 * DEG };
// The block's boundary cells, in the order the legend lists them.
const BOUNDARY_IDS = ['chd', 'riv', 'drn', 'ghb', 'evtList'];

export async function mount(host, ctx) {
  let model = ctx.model, result = ctx.result, state = ctx.state || {};
  const css = (name, fallback) => getComputedStyle(host).getPropertyValue(name).trim() || fallback;
  let uid = 0;
  const id = (s) => `v3-${s}-${++uid}`;

  const openBtn = el('button', { class: 'btn', type: 'button' }, 'Show the model in 3D');
  const intro = el('div', { class: 'stack' },
    el('p', { class: 'hint' }, 'The model as a block of its layers, cut open along a row or a column with the heads on the cut, the water table and the cone of depression over it, the wells and boundaries, and the paths of tracked particles, at every time step. Drawn in this browser with WebGL2.'),
    openBtn);
  const resetBtn = el('button', { class: 'btn quiet small', type: 'button', hidden: true }, 'Reset view');
  const wellsBtn = el('button', { class: 'btn quiet small', type: 'button', hidden: true }, 'Zoom to the wells');
  const saveBtn = el('button', { class: 'btn quiet small', type: 'button', hidden: true }, 'Save image (.png)');
  const fullBtn = el('button', { class: 'btn quiet small', type: 'button', hidden: true }, 'Full screen');
  const closeBtn = el('button', { class: 'btn quiet small', type: 'button', hidden: true }, 'Close');
  const box = panel(el('div', { class: 'chart-head' }, el('h2', {}, '3D view'), el('div', { class: 'btn-row' }, resetBtn, wellsBtn, saveBtn, fullBtn, closeBtn)), intro);
  box.classList.add('model-3d');
  host.append(box);
  const banner = el('div', { class: 'model-stale', role: 'status', hidden: true });
  const body = el('div', { class: 'stack', hidden: true });
  box.append(banner, body);

  // What the user has chosen; null where the model sets it (the exaggeration, the cut's place).
  const blank = () => ({ ve: null, cut: 'corner', col: null, row: null, cutShows: 'value', colour: null, scale: null, block: 'glass', surface: true, contours: true, boundaries: true, wells: true, grid: true, paths: true, zones: true, moving: true, step: null });
  let opts = blank();
  let view = null; // the open view: its canvas, context, renderer and what it has built

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  ctx.signal.addEventListener('abort', close);

  function showState() {
    const why = !model ? 'The model is not complete, so the 3D view waits: give every value it still needs.'
      : state.stale ? 'The model has changed since the last run: the 3D view shows its layers, wells and boundaries as they are now, and heads again after the next run.' : '';
    // The native replaceChildren writes a null as the text "null", so the button is added only when offered.
    banner.replaceChildren(el('p', {}, why));
    if (state.stale && state.complete && ctx.run) banner.append(el('button', { class: 'btn', type: 'button', onclick: () => ctx.run() }, 'Run the model'));
    banner.hidden = !why || !view;
  }

  function open() {
    if (view) return;
    const canvas = el('canvas', { class: 'model-3d-canvas', tabindex: '0', role: 'img' });
    const labels = el('canvas', { class: 'model-3d-labels', 'aria-hidden': 'true' });
    const stage = el('div', { class: 'model-3d-stage' }, canvas, labels);
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    intro.hidden = true;
    body.hidden = false;
    closeBtn.hidden = false;
    if (!gl) {
      body.replaceChildren(el('p', { class: 'model-note' }, 'This browser has no WebGL2, which the 3D view needs, or it is turned off. The map above shows the same model in plan, layer by layer. WebGL2 is in current versions of Chrome, Edge, Firefox and Safari.'));
      view = { gl: null, stop: new AbortController() };
      return;
    }
    let draw;
    try { draw = renderer(gl); } catch (e) {
      body.replaceChildren(el('p', { class: 'model-note' }, `The 3D view could not start: ${e.message}`));
      view = { gl, stop: new AbortController() };
      return;
    }
    const stop = new AbortController();
    view = { gl, draw, canvas, labels, stage, stop, raf: 0, dirty: true, geo: null, data: null, cam: null, play: null, clock: 0 };
    buildControls(stage);
    resetBtn.hidden = false; saveBtn.hidden = false;
    fullBtn.hidden = !document.fullscreenEnabled;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      cancelAnimationFrame(view.raf);
      body.prepend(el('p', { class: 'model-note' }, 'The 3D view lost its drawing context (the graphics processor was reset or ran short). Close it and show it again to redraw.'));
    }, { signal: stop.signal });
    interact(canvas, stop.signal);
    const ro = new ResizeObserver(() => redraw());
    ro.observe(stage);
    stop.signal.addEventListener('abort', () => ro.disconnect());
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (view && view.geo) { colours(); buildResults(); legend(); redraw(); } }, { signal: stop.signal });
    document.addEventListener('fullscreenchange', () => { fullBtn.textContent = document.fullscreenElement === box ? 'Leave full screen' : 'Full screen'; redraw(); }, { signal: stop.signal });
    resetBtn.addEventListener('click', () => { home(); redraw(); }, { signal: stop.signal });
    wellsBtn.addEventListener('click', () => { if (!view.cam) home(); zoomToWells(); redraw(); }, { signal: stop.signal });
    saveBtn.addEventListener('click', saveImage, { signal: stop.signal });
    fullBtn.addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else box.requestFullscreen().catch(() => {}); }, { signal: stop.signal });
    refresh();
    canvas.focus({ preventScroll: true });
  }

  // Closing, or leaving the page: the animation stops, the context is given back.
  function close() {
    if (!view) return;
    const v = view;
    view = null;
    v.stop.abort();
    if (v.gl) {
      cancelAnimationFrame(v.raf);
      if (v.play) clearInterval(v.play);
      if (v.draw) v.draw.dispose();
      const lose = v.gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
    if (document.fullscreenElement === box) document.exitFullscreen().catch(() => {});
    body.replaceChildren();
    body.hidden = true;
    intro.hidden = false;
    banner.hidden = true;
    resetBtn.hidden = true; wellsBtn.hidden = true; saveBtn.hidden = true; fullBtn.hidden = true; closeBtn.hidden = true;
  }

  // ---- the controls ----
  const ui = {};
  function buildControls(stage) {
    const select = (key, label, choices) => {
      const s = el('select', { id: id(key), 'aria-label': label });
      s.addEventListener('change', () => { opts[key] = s.value; changed(key); });
      ui[key] = s;
      ui[`${key}Choices`] = choices;
      return s;
    };
    const range = (key, label) => {
      const r = el('input', { type: 'range', id: id(key), min: '0', max: '0', step: '1', value: '0', 'aria-label': label });
      r.addEventListener('input', () => { opts[key] = Number(r.value); changed(key); });
      ui[key] = r;
      return r;
    };
    const check = (key, label) => {
      const c = el('input', { type: 'checkbox', id: id(key) });
      c.checked = opts[key];
      c.addEventListener('change', () => { opts[key] = c.checked; changed(key); });
      ui[key] = c;
      return el('label', { class: 'model-3d-check', for: c.id }, c, label);
    };
    ui.stepText = el('span', { class: 'hint', 'aria-live': 'polite' });
    ui.colText = el('span', { class: 'hint' });
    ui.rowText = el('span', { class: 'hint' });
    ui.playBtn = el('button', { class: 'btn quiet small', type: 'button' }, 'Play');
    ui.playBtn.addEventListener('click', togglePlay);
    ui.veBox = field('Vertical exaggeration', select('ve', 'Vertical exaggeration'));
    ui.cutBox = field('Cut', select('cut', 'Cut'));
    ui.colBox = field('Cut at column', range('col', 'Cut at column'), ui.colText);
    ui.rowBox = field('Cut at row', range('row', 'Cut at row'), ui.rowText);
    ui.cutShowsBox = field('The cut shows', select('cutShows', 'The cut shows'));
    ui.colourBox = field('Colour by', select('colour', 'Colour by'));
    ui.scaleBox = field('Colour scale', select('scale', 'Colour scale'));
    ui.blockBox = field('Block', select('block', 'Block'));
    const stepInput = range('step', 'Time step');
    ui.stepBox = el('div', { class: 'field model-3d-time' }, el('label', { for: stepInput.id }, 'Time step'),
      el('div', { class: 'model-3d-timerow' }, stepInput, ui.playBtn), ui.stepText);
    ui.checks = el('div', { class: 'model-3d-checks' },
      check('surface', 'Water table'), check('contours', 'Contours'), check('wells', 'Wells'), check('boundaries', 'Boundary cells'),
      check('grid', 'Grid lines'), ui.pathsCheck = check('paths', 'Pathlines'), ui.movingCheck = check('moving', 'Moving particles'), ui.zonesCheck = check('zones', 'Capture zones'));
    ui.legend = el('div', { class: 'model-legend model-3d-legend', 'aria-live': 'polite' });
    body.replaceChildren(
      el('div', { class: 'fields model-tools' }, ui.veBox, ui.cutBox, ui.colBox, ui.rowBox, ui.cutShowsBox, ui.colourBox, ui.scaleBox, ui.blockBox, ui.stepBox),
      ui.checks, stage, ui.legend,
      el('p', { class: 'hint' }, 'With a mouse: drag to turn the model, drag with the right button or with Shift held to move it, and use the wheel to zoom. On a trackpad: drag to turn, pinch to zoom. On a touch screen: one finger turns it, two fingers move and zoom. On the view with a keyboard: the arrow keys turn it (with Shift, move it), + and − zoom, and 0 resets the view.'));
  }

  // The choices that depend on the model and its run.
  function fillControls() {
    const g = view.geo;
    const fill = (key, choices) => {
      const s = ui[key];
      s.textContent = '';
      for (const [v, t] of choices) s.add(new Option(t, String(v)));
      if (!choices.some(([v]) => String(v) === String(opts[key]))) opts[key] = choices[0][0];
      s.value = String(opts[key]);
    };
    fill('ve', EXAGGERATIONS.map((v) => [v, `${v}×${v === g.ve0 ? ' (chosen for this model)' : ''}`]));
    fill('cut', [['none', 'None'], ['col', 'Along a column'], ['row', 'Along a row'], ['corner', 'A corner cut away']]);
    const run = Boolean(result);
    const colours = [['head', run ? 'Head' : 'Starting head']];
    if (run && view.data && view.data.ref) colours.push(['drawdown', 'Drawdown']);
    fill('colour', colours);
    fill('scale', opts.colour === 'drawdown' ? [['log', 'Log'], ['linear', 'Linear']] : [['linear', 'Linear']]);
    fill('cutShows', [['value', opts.colour === 'drawdown' ? 'Drawdown' : run ? 'Heads' : 'Starting heads'], ['layers', 'The layers']]);
    fill('block', [['glass', 'Solid, the land surface clear'], ['solid', 'Solid'], ['clear', 'See-through'], ['hidden', 'Hidden']]);
    ui.col.max = String(g.dg.ncol - 1);
    ui.row.max = String(g.dg.nrow - 1);
    ui.col.value = String(opts.col); ui.row.value = String(opts.row);
    const steps = result ? result.times.length : 1;
    ui.step.max = String(steps - 1);
    ui.step.value = String(opts.step);
    for (const k of ['surface', 'contours', 'wells', 'boundaries', 'grid', 'paths', 'moving', 'zones']) ui[k].checked = opts[k];
    showControls();
  }
  function showControls() {
    const cut = opts.cut;
    ui.colBox.hidden = !(cut === 'col' || cut === 'corner');
    ui.rowBox.hidden = !(cut === 'row' || cut === 'corner');
    ui.cutShowsBox.hidden = cut === 'none';
    ui.scaleBox.hidden = opts.colour !== 'drawdown';
    ui.stepBox.hidden = !result || result.times.length < 2;
    const tracks = shared();
    ui.pathsCheck.hidden = !tracks || !tracks.paths.length;
    ui.movingCheck.hidden = ui.pathsCheck.hidden;
    ui.zonesCheck.hidden = !tracks || !(tracks.zones || []).length;
    const g = view.geo, s = g.dg.stride;
    const span = (i, n) => (s === 1 ? `${i * s + 1}` : `${i * s + 1} to ${Math.min(n, (i + 1) * s)}`);
    ui.colText.textContent = together(`Column ${span(opts.col, model.grid.ncol)} of ${model.grid.ncol}: the part west of it is cut away${cut === 'corner' ? ', south of the row' : ''}.`);
    ui.rowText.textContent = together(`Row ${span(opts.row, model.grid.nrow)} of ${model.grid.nrow}: the part south of it is cut away${cut === 'corner' ? ', west of the column' : ''}.`);
    if (result) ui.stepText.textContent = together(whenText(opts.step).replace(/^p/, 'P'));
  }

  function changed(key) {
    if (!view || !view.geo) return;
    if (key === 'colour') { opts.scale = opts.colour === 'drawdown' ? 'log' : 'linear'; fillControls(); }
    if (['cut', 'col', 'row', 'cutShows', 'colour', 'scale', 'step', 'paths', 'zones', 'boundaries'].includes(key)) buildResults();
    if (key === 'moving') { view.clock = performance.now(); }
    if (key === 'cut') faceTheCut();
    showControls();
    legend();
    describe();
    redraw();
  }

  // ---- what is built from the model and its run ----

  // Everything the grid alone gives: the block, built again only when the grid changes.
  function buildGeometry() {
    const old = view.geo;
    if (old && sameGrid(old.model, model)) { old.model = model; return false; }
    const dg = displayGrid(model);
    const mesh = blockMesh(dg);
    const { zMin, zMax } = elevationRange(dg);
    const ve0 = defaultExaggeration(dg);
    view.geo = { model, dg, zMin, zMax, ve0, land: landSurface(dg), origin: [dg.W / 2, dg.H / 2, (zMin + zMax) / 2], rotation: ((model.georef && model.georef.angrot) || 0) * DEG };
    view.draw.set.block(mesh);
    view.geo.triangles = mesh.index.length / 3;
    if (opts.ve === null || !old) opts.ve = ve0;
    // The cut opens through the strongest pumping well, or the middle of the grid.
    const wells = (model.wel && Object.values(model.wel).flat()) || [];
    const main = wells.filter((w) => w[3] < 0).sort((a, b) => a[3] - b[3])[0];
    const s = dg.stride;
    if (opts.col === null || opts.col >= dg.ncol) opts.col = main ? Math.floor(main[2] / s) : Math.floor(dg.ncol / 2);
    if (opts.row === null || opts.row >= dg.nrow) opts.row = main ? Math.floor(main[1] / s) : Math.floor(dg.nrow / 2);
    return true;
  }

  // What the run (or, before one, the starting heads) gives at the step shown.
  function heads() {
    const g = model.grid, ncpl = g.nrow * g.ncol;
    if (result) return result.heads[opts.step];
    const out = new Float64Array(g.nlay * ncpl);
    for (let k = 0; k < g.nlay; k++) { const v = model.ic.strt[k]; for (let n = 0; n < ncpl; n++) out[k * ncpl + n] = typeof v === 'number' ? v : v[n]; }
    return out;
  }
  function runData() {
    if (view.data && view.data.result === result && view.data.model === model) return view.data;
    const ref = result ? drawdownReference(model, result) : null;
    view.data = { result, model, ref, refHeads: ref ? referenceHeads(model, result, ref) : null, ranges: {} };
    return view.data;
  }
  // The colour scale's ends for what is coloured, over every step, so a time animation keeps its colours.
  function valueRange(kind) {
    const d = runData();
    if (d.ranges[kind]) return d.ranges[kind];
    const g = model.grid, act = (c) => !g.idomain || g.idomain[c] === 1;
    const all = result ? result.heads : [heads()];
    const arrays = all.map((h) => (kind === 'drawdown' ? Float64Array.from(h, (v, c) => (act(c) ? d.refHeads[c] - v : NaN)) : Float64Array.from(h, (v, c) => (act(c) ? v : NaN))));
    let r = rangeOf(arrays) || [0, 1];
    if (!(r[1] > r[0])) r = [r[0] - 0.5, r[0] + 0.5];
    d.ranges[kind] = r;
    return r;
  }

  function buildResults() {
    const g = view.geo, dg = g.dg, d = runData();
    if (opts.step === null || !result || opts.step >= result.times.length) opts.step = result ? result.times.length - 1 : 0;
    const h = heads();
    // A run with a well pumping and a time to measure from opens on drawdown, on a log scale,
    // which shows the cone of depression from its edge to the well.
    if (opts.colour === null) opts.colour = d.refHeads && Object.values(model.wel || {}).flat().some((w) => w[3] < 0) ? 'drawdown' : 'head';
    if (opts.colour === 'drawdown' && !d.refHeads) opts.colour = 'head';
    if (opts.scale === null || (opts.colour !== 'drawdown' && opts.scale === 'log')) opts.scale = opts.colour === 'drawdown' ? 'log' : 'linear';
    const dd = opts.colour === 'drawdown' && d.refHeads;
    const wt = waterTable(dg, model, h, dd ? d.refHeads : null);
    const values = layerMeans(dg, model, dd ? Float64Array.from(h, (v, c) => d.refHeads[c] - v) : h);
    // The colour scale and the contours.
    const [lo, hi] = valueRange(dd ? 'drawdown' : 'head');
    const log = dd && opts.scale === 'log';
    let smallest = hi;
    for (const v of values) if (v > 0 && v < smallest) smallest = v;
    const logLo = Math.max(hi / 1000, smallest);
    const interval = niceInterval(lo, hi);
    view.scale = { lo: log ? logLo : lo, hi, log, interval, decimals: intervalDecimals(interval), kind: dd ? 'drawdown' : 'head' };
    view.draw.set.surface(surfaceMesh(dg, wt.z, wt.value));
    view.wtNow = wt;
    // The cut's faces, and the water table along them.
    const cuts = [];
    if (opts.cut === 'col' || opts.cut === 'corner') cuts.push({ axis: 'col', index: opts.col, from: opts.cut === 'corner' ? opts.row + 1 : 0 });
    if (opts.cut === 'row' || opts.cut === 'corner') cuts.push({ axis: 'row', index: opts.row, from: 0, to: opts.cut === 'corner' ? opts.col : undefined });
    const sections = cuts.filter((c) => !(c.axis === 'col' && c.index === 0 && opts.cut === 'col')).map((c) => sectionMesh(dg, { ...c, values, wt: wt.z }));
    view.draw.set.sections(sections);
    const wtLine = [];
    for (const s of sections) for (let i = 0; i < s.line.length; i += 6) wtLine.push(s.line[i], s.line[i + 1], s.line[i + 2], -1, s.line[i + 3], s.line[i + 4], s.line[i + 5], -1);
    view.draw.set.lines('wt', Float32Array.from(wtLine));
    view.clip = clipOf(dg);
    // The cells' codes, of the step's period.
    const period = result ? result.periods[opts.step] : 0;
    const dry = result ? result.dry[opts.step] : [];
    const codes = opts.boundaries ? cellCodes(dg, model, Math.min(period, model.periods.length - 1), dry) : cellCodes(dg, { ...model, chd: null, riv: null, drn: null, ghb: null, evtList: null }, 0, dry);
    view.draw.set.codes(codes, dg.nlay, dg.nrow, dg.ncol);
    view.present = { dry: dry.length, boundaries: new Set(BOUNDARY_IDS.filter((b) => opts.boundaries && Object.values(model[b] || {}).length && codesHave(codes, CODES[b]))) };
    // The wells of the period, outside the part cut away.
    const wells = wellRods(model, (inForceList(model.wel, period) || []));
    const shown = wells.filter((w) => !(w.x < view.clip[0] && w.y < view.clip[1]));
    view.wellsShown = wells.filter((w) => w.q < 0);
    wellsBtn.hidden = !view.wellsShown.length;
    view.draw.set.rods(rodInstances(shown));
    view.present.wells = { pumping: shown.some((w) => w.q < 0), injecting: shown.some((w) => w.q > 0) };
    // The particle panel's paths and capture zones.
    const tracks = shared();
    view.tracks = null;
    if (tracks && tracks.paths.length && opts.paths) {
      const p = pathSegments(tracks.paths);
      view.tracks = { paths: tracks.paths, tMin: p.tMin || p.tMax / 1000, tMax: p.tMax };
      view.draw.set.lines('paths', p.segments);
    } else view.draw.set.lines('paths', null);
    const zones = tracks && opts.zones ? (tracks.zones || []) : [];
    const outlines = zones.map((z) => z.outline.map((q) => ({ x: q.x, y: q.y })));
    const draped = drape(dg, g.land, outlines);
    const zoneSegs = new Float32Array((draped.length / 6) * 8);
    for (let i = 0, o = 0; i < draped.length; i += 6, o += 8) zoneSegs.set([draped[i], draped[i + 1], draped[i + 2], -1, draped[i + 3], draped[i + 4], draped[i + 5], -1], o);
    view.draw.set.lines('zones', zoneSegs);
    view.zoneTimes = zones.map((z) => z.time);
    // Each outline is labelled with its time at its point farthest from its middle, so nested outlines' labels part.
    view.zoneLabels = outlines.map((pts, i) => {
      if (!pts.length) return null;
      const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length, cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
      const far = pts.reduce((best, q) => (Math.hypot(q.x - cx, q.y - cy) > Math.hypot(best.x - cx, best.y - cy) ? q : best), pts[0]);
      return { time: zones[i].time, x: far.x, y: far.y, z: surfaceAt(dg, g.land, far.x, far.y) };
    }).filter((l) => l && Number.isFinite(l.z));
    view.draw.set.points(null);
  }
  const codesHave = (codes, c) => { for (let i = 0; i < codes.length; i++) if (codes[i] === c) return true; return false; };
  const inForceList = (pkg, p) => {
    if (!pkg) return [];
    let best = -1;
    for (const key of Object.keys(pkg)) { const kp = Number(key); if (kp <= p && kp > best) best = kp; }
    return best < 0 ? [] : pkg[best];
  };
  // x and y west and south of which the cut takes the block away (Infinity for no limit).
  function clipOf(dg) {
    const x = dg.ex[opts.col], y = dg.ey[opts.row + 1];
    switch (opts.cut) {
      case 'col': return [x, Infinity];
      case 'row': return [Infinity, y];
      case 'corner': return [x, y];
      default: return [-Infinity, -Infinity];
    }
  }
  function shared() {
    const o = ctx.overlays ? ctx.overlays() : null;
    const t = o && o.particles;
    return t && result && !state.stale ? t : null;
  }

  // The wells as cylinders: from each screen's bottom to its top, wider, in the colour of
  // pumping or injection; the casing from the land surface down, thin and grey; and a
  // stick-up above the land surface in the well's colour, so a well shows over the block.
  function rodInstances(wells) {
    const g = view.geo, size = Math.max(g.dg.W, g.dg.H);
    const r = size * 0.0035;
    const pump = [...hexRgb(css('--model-wel', '#e3001b')), 1], inject = [...hexRgb(css('--model-inject', '#1f5fd6')), 1], casing = [...hexRgb(css('--model-casing', '#5b6770')), 1];
    const out = [];
    const stick = size * 0.035;
    for (const w of wells) {
      const colour = w.q < 0 ? pump : inject;
      const deepest = Math.min(...w.screens.map((s) => s.z0));
      out.push(w.x, w.y, r * 0.55, deepest, w.land, 0, 0, ...casing);
      out.push(w.x, w.y, r, w.land, w.land, 0, stick, ...colour);
      for (const s of w.screens) out.push(w.x, w.y, r * 1.5, s.z0, s.z1, 0, 0, ...(s.q < 0 ? pump : inject));
    }
    return Float32Array.from(out);
  }

  // ---- colours, from the page's own ----
  function colours() {
    // Each layer a unit of its own colour, in turn; past the list, the same again a little darker.
    const units = css('--model-units', '#d3bd8c #a2b36d #86a3bd #a893b4 #c4936f #87ab9c').split(/\s+/).filter(Boolean).map(hexRgb);
    const layers = Array.from({ length: model.grid.nlay }, (_, k) => units[k % units.length].map((v) => v * 0.88 ** Math.floor(k / units.length)));
    view.layerColours = layers;
    view.draw.set.layers(layers);
    view.draw.set.ramp(rampOf(css('--model-ramp', '#3b0f70 #3b528b #21918c #5ec962 #c8e020 #fde725')));
    view.draw.set.timeRamp(rampOf(css('--model-time-ramp', '#fff3b0 #fdb863 #e66101 #b2182b #5c0a28')));
  }
  const rampOf = (text) => {
    const stops = text.split(/\s+/).filter(Boolean).map(hexRgb);
    return Array.from({ length: 256 }, (_, i) => {
      const t = (i / 255) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
      return stops[k].map((v, ch) => v + (stops[k + 1][ch] - v) * f);
    });
  };

  // ---- the camera ----
  function radius() {
    const g = view.geo;
    return 0.5 * Math.hypot(g.dg.W, g.dg.H, (g.zMax - g.zMin) * opts.ve);
  }
  function home() {
    const g = view.geo;
    view.cam = { target: [0, 0, 0], ...HOME, distance: radius() / Math.sin(FOV / 2), fovy: FOV };
    fit({ x0: 0, x1: g.dg.W, y0: 0, y1: g.dg.H, z0: g.zMin, z1: g.zMax });
  }
  // Turns model coordinates into the world the camera looks at, as the shaders do.
  function toWorld(x, y, z) {
    const g = view.geo, [ox, oy, oz] = g.origin, r = g.rotation;
    const qx = x - ox, qy = y - oy;
    return [Math.cos(r) * qx - Math.sin(r) * qy, Math.sin(r) * qx + Math.cos(r) * qy, (z - oz) * opts.ve];
  }
  // Moves the camera, keeping its direction, so the box (model coordinates) fills the view
  // with a margin, a little more below for the axes' labels.
  function fit(box) {
    const c = view.cam, { canvas } = view;
    const w = Math.max(1, canvas.clientWidth || 600), h = Math.max(1, canvas.clientHeight || 400);
    const corners = [];
    for (const x of [box.x0, box.x1]) for (const y of [box.y0, box.y1]) for (const z of [box.z0, box.z1]) corners.push(toWorld(x, y, z));
    c.target = [0, 1, 2].map((i) => corners.reduce((sum, p) => sum + p[i], 0) / 8);
    const extent = () => {
      const m = orbit(c, w / h, radius());
      const pts = corners.map((p) => project(m.viewProj, p, w, h));
      if (pts.some((p) => !p)) return null;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    for (let pass = 0; pass < 2; pass++) {
      // The distance at which the box just fits, by halving the interval.
      let lo = radius() * 0.01, hi = radius() * 20;
      for (let i = 0; i < 40; i++) {
        c.distance = Math.sqrt(lo * hi);
        const e = extent();
        if (e && e.x0 >= w * 0.06 && e.x1 <= w * 0.94 && e.y0 >= h * 0.08 && e.y1 <= h * 0.86) hi = c.distance; else lo = c.distance;
      }
      c.distance = hi;
      // Then the box's middle to the middle of the view.
      const e = extent();
      if (e) panBy((e.x0 + e.x1) / 2 - w / 2, (e.y0 + e.y1) / 2 - h * 0.47, h);
    }
  }
  // Moves what the camera looks at by dx, dy screen pixels, of a view h pixels high.
  function panBy(dx, dy, h) {
    const c = view.cam;
    const per = (2 * c.distance * Math.tan(c.fovy / 2)) / h;
    const right = [-Math.sin(c.azimuth), Math.cos(c.azimuth), 0];
    const up = [-Math.sin(c.elevation) * Math.cos(c.azimuth), -Math.sin(c.elevation) * Math.sin(c.azimuth), Math.cos(c.elevation)];
    for (let i = 0; i < 3; i++) c.target[i] += (dx * right[i] - dy * up[i]) * per;
  }
  // The pumping wells and, by drawdown, the cone around them: the cells whose drawdown is at
  // least a tenth of the largest, or the wells' own cells with a margin.
  function zoomToWells() {
    const g = view.geo, dg = g.dg;
    const wells = view.wellsShown || [];
    if (!wells.length) return;
    let box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    const take = (x, y) => { box.x0 = Math.min(box.x0, x); box.x1 = Math.max(box.x1, x); box.y0 = Math.min(box.y0, y); box.y1 = Math.max(box.y1, y); };
    for (const w of wells) take(w.x, w.y);
    const wt = view.wtNow;
    if (view.scale.kind === 'drawdown' && wt) {
      const most = view.scale.hi;
      for (let i = 0; i < dg.nrow; i++) for (let j = 0; j < dg.ncol; j++) {
        if (wt.value[i * dg.ncol + j] >= most / 10) take((dg.ex[j] + dg.ex[j + 1]) / 2, (dg.ey[i] + dg.ey[i + 1]) / 2);
      }
    }
    const pad = Math.max(box.x1 - box.x0, box.y1 - box.y0, Math.max(dg.W, dg.H) / 20) * 0.5;
    box = { x0: Math.max(0, box.x0 - pad), x1: Math.min(dg.W, box.x1 + pad), y0: Math.max(0, box.y0 - pad), y1: Math.min(dg.H, box.y1 + pad), z0: g.zMin, z1: g.zMax };
    // With the block hidden, the water table alone is framed: its lowest and highest heads there.
    if (opts.block === 'hidden' && wt) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < dg.nrow; i++) for (let j = 0; j < dg.ncol; j++) {
        const x = (dg.ex[j] + dg.ex[j + 1]) / 2, y = (dg.ey[i] + dg.ey[i + 1]) / 2, z = wt.z[i * dg.ncol + j];
        if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && Number.isFinite(z)) { lo = Math.min(lo, z); hi = Math.max(hi, z); }
      }
      if (lo <= hi) { box.z0 = lo; box.z1 = hi; }
    }
    fit(box);
  }
  // A cut faces west (a column) or south (a row): the camera is turned to see it, if it looked from the other side.
  function faceTheCut() {
    const c = view.cam;
    if (!c) return;
    const fromEast = Math.cos(c.azimuth) > 0, fromNorth = Math.sin(c.azimuth) > 0;
    if ((opts.cut === 'col' && fromEast) || (opts.cut === 'row' && fromNorth) || (opts.cut === 'corner' && (fromEast || fromNorth))) {
      c.azimuth = opts.cut === 'col' ? 200 * DEG : opts.cut === 'row' ? 250 * DEG : HOME.azimuth;
    }
  }
  function camera() {
    const { canvas } = view;
    const w = Math.max(1, canvas.width), h = Math.max(1, canvas.height);
    return orbit(view.cam, w / h, radius());
  }

  function interact(canvas, signal) {
    const pointers = new Map();
    const opt = { signal };
    const turn = (dx, dy) => {
      const c = view.cam;
      c.azimuth -= dx * 0.008;
      c.elevation = Math.max(-80 * DEG, Math.min(89 * DEG, c.elevation + dy * 0.008));
    };
    const pan = (dx, dy) => panBy(-dx, -dy, canvas.clientHeight || 1);
    const zoom = (f) => {
      const c = view.cam, r = radius();
      c.distance = Math.max(r * 0.03, Math.min(r * 12, c.distance * f));
    };
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), opt);
    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer has */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }, opt);
    canvas.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p || !view.cam) return;
      if (pointers.size === 1) {
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        if (e.pointerType === 'mouse' && (e.buttons & 6 || e.shiftKey || e.metaKey || e.ctrlKey)) pan(dx, dy); else turn(dx, dy);
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const before = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        p.x = e.clientX; p.y = e.clientY;
        const [a2, b2] = [...pointers.values()];
        const after = { d: Math.hypot(a2.x - b2.x, a2.y - b2.y), cx: (a2.x + b2.x) / 2, cy: (a2.y + b2.y) / 2 };
        if (before.d > 0 && after.d > 0) zoom(before.d / after.d);
        pan(after.cx - before.cx, after.cy - before.cy);
        redraw();
        return;
      }
      p.x = e.clientX; p.y = e.clientY;
      redraw();
    }, opt);
    const up = (e) => { pointers.delete(e.pointerId); };
    canvas.addEventListener('pointerup', up, opt);
    canvas.addEventListener('pointercancel', up, opt);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!view.cam) return;
      // A trackpad's pinch comes as a wheel with ctrlKey; a line or page of a wheel is steeper.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      zoom(Math.exp(e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015)));
      redraw();
    }, { signal, passive: false });
    // Safari's own pinch.
    let gestureScale = 1;
    canvas.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; }, opt);
    canvas.addEventListener('gesturechange', (e) => { e.preventDefault(); if (!view.cam) return; zoom(gestureScale / e.scale); gestureScale = e.scale; redraw(); }, opt);
    canvas.addEventListener('keydown', (e) => {
      if (!view.cam) return;
      const step = 24;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) { const [dx, dy] = moves[e.key]; if (e.shiftKey) pan(dx, dy); else turn(dx, dy); }
      else if (e.key === '+' || e.key === '=') zoom(1 / 1.25);
      else if (e.key === '-' || e.key === '−' || e.key === '_') zoom(1.25);
      else if (e.key === '0') home();
      else return;
      e.preventDefault();
      redraw();
    }, opt);
  }

  // ---- drawing ----
  function redraw() {
    if (!view || !view.gl || view.raf) return;
    view.raf = requestAnimationFrame(frame);
  }
  const animating = () => Boolean(view && view.tracks && opts.moving && opts.paths);

  function frame(now) {
    if (!view || !view.geo) return;
    view.raf = 0;
    const { canvas, labels } = view;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; labels.width = w; labels.height = h; }
    if (!view.cam) home();
    // The particles where they are now: each cycle of the animation runs through the whole
    // travel time in about twelve seconds.
    if (animating()) {
      const t = view.tracks, cycle = 12000;
      const f = ((now - view.clock) % cycle) / cycle;
      view.time = t.tMax * f;
      view.draw.set.points(particlesAt(t.paths, view.time));
    } else if (view.time !== undefined) { view.time = undefined; view.draw.set.points(null); }
    renderNow(dpr);
    if (animating()) view.raf = requestAnimationFrame(frame);
  }

  function renderNow(dpr = Math.min(window.devicePixelRatio || 1, 2)) {
    const { canvas, geo: g } = view;
    const cam = camera();
    const ink = hexRgb(css('--ink', '#10222b')), halo = hexRgb(css('--model-halo', '#10222b'));
    const bg = hexRgb(css('--panel', '#fbfdfd'));
    const k = [-0.35, -0.6, 0.72], kl = Math.hypot(...k);
    const rot = g.rotation;
    const codeColours = [[0, 0, 0], ...['chd', 'riv', 'drn', 'ghb', 'evt'].map((b) => hexRgb(css(`--model-${b}`, '#888888'))), hexRgb(css('--bad', '#a22c2b'))].flat();
    const lines = [];
    const size = Math.max(g.dg.W, g.dg.H);
    if (view.tracks) lines.push({ name: 'paths', width: 3, colour: [1, 1, 1], halo, range: [view.tracks.tMin, view.tracks.tMax], alpha: 1, bias: 0.0005 });
    lines.push({ name: 'zones', width: 3, colour: hexRgb(css('--model-zone', '#ff4fd8')), halo, alpha: 1, bias: 0.001, lift: size * 0.001 });
    if (opts.surface) lines.push({ name: 'wt', width: 2.5, colour: hexRgb(css('--model-water', '#1565c0')), halo: hexRgb(css('--model-water', '#1565c0')), alpha: 1, bias: 0.001 });
    view.draw.draw({
      width: canvas.width, height: canvas.height, dpr,
      viewProj: cam.viewProj, eye: cam.eye, key: k.map((v) => v / kl), origin: g.origin, ve: opts.ve, rotation: rot,
      clip: view.clip, background: bg, ink, halo, particle: [1, 1, 1], codeColours,
      scale: view.scale, contour: { interval: view.scale.interval, base: 0, width: 1.1 },
      gridLines: [opts.grid ? 0.22 : 0, 0.55],
      show: { block: opts.block === 'glass' && !opts.surface ? 'solid' : opts.block, grid: opts.grid, contours: opts.contours, surface: opts.surface, wells: opts.wells, cutValues: opts.cutShows === 'value' },
      surfaceAlpha: opts.block === 'clear' ? 0.8 : 0.92,
      lines,
    });
    drawLabels(cam);
  }

  // The words on the view: the scale of each axis, north, the exaggeration and the time.
  function drawLabels(cam) {
    const { labels, geo: g } = view;
    const c2 = labels.getContext('2d');
    const w = labels.width, h = labels.height, dpr = w / Math.max(1, labels.clientWidth || w);
    c2.clearRect(0, 0, w, h);
    const ink = css('--ink-2', '#47606b'), font = css('--font-data', 'monospace');
    c2.font = `${11 * dpr}px ${font}`;
    c2.fillStyle = ink; c2.strokeStyle = ink;
    const rot = g.rotation, [ox, oy, oz] = g.origin;
    const world = (x, y, z) => {
      const qx = x - ox, qy = y - oy;
      return [Math.cos(rot) * qx - Math.sin(rot) * qy, Math.sin(rot) * qx + Math.cos(rot) * qy, (z - oz) * opts.ve];
    };
    const at = (x, y, z) => project(cam.viewProj, world(x, y, z), w, h);
    const { W, H } = g.dg, z0 = g.zMin, z1 = g.zMax;
    // The box's bottom corners; the axes run along the two bottom edges nearest the eye.
    const cornersXY = [[0, 0], [W, 0], [W, H], [0, H]];
    const eye = cam.eye;
    const dist = (p) => { const q = world(p[0], p[1], z0); return Math.hypot(q[0] - eye[0], q[1] - eye[1], q[2] - eye[2]); };
    const near = cornersXY.map((p, i) => [dist(p), i]).sort((a, b) => a[0] - b[0])[0][1];
    const [nx, ny] = cornersXY[near];
    const xEdgeY = ny, yEdgeX = nx;
    const geo = model.georef || {};
    const x0 = geo.xorigin || 0, y0 = geo.yorigin || 0;
    const tickLine = (pts) => { if (pts.some((p) => !p)) return; c2.beginPath(); c2.moveTo(...pts[0]); for (const p of pts.slice(1)) c2.lineTo(...p); c2.stroke(); };
    c2.lineWidth = dpr;
    c2.globalAlpha = 0.8;
    const ticks = (lo, hi, n) => { const step = niceInterval(lo, hi, n); if (!(step > 0)) return []; const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12))); return out; };
    const label = (p, text, dx = 0, dy = 0, align = 'center') => { if (!p) return; c2.textAlign = align; c2.fillText(text, p[0] + dx * dpr, p[1] + dy * dpr); };
    // Along x (east), at the bottom of the edge nearest the eye.
    tickLine([at(0, xEdgeY, z0), at(W, xEdgeY, z0)]);
    const out = xEdgeY === 0 ? -1 : 1, tick = size() * 0.012;
    for (const v of ticks(x0, x0 + W, 5)) {
      const x = v - x0;
      tickLine([at(x, xEdgeY, z0), at(x, xEdgeY + out * tick, z0)]);
      label(at(x, xEdgeY + out * tick * 3.2, z0), together(fmtCoord(v)), 0, 4);
    }
    label(at(W / 2, xEdgeY + out * tick * 9, z0), geo.xorigin !== undefined ? 'Easting (m)' : 'East (m)', 0, 4);
    tickLine([at(yEdgeX, 0, z0), at(yEdgeX, H, z0)]);
    const outX = yEdgeX === 0 ? -1 : 1;
    for (const v of ticks(y0, y0 + H, 5)) {
      const y = v - y0;
      tickLine([at(yEdgeX, y, z0), at(yEdgeX + outX * tick, y, z0)]);
      label(at(yEdgeX + outX * tick * 3.2, y, z0), together(fmtCoord(v)), 0, 4);
    }
    label(at(yEdgeX + outX * tick * 9, H / 2, z0), geo.yorigin !== undefined ? 'Northing (m)' : 'North (m)', 0, 4);
    // Elevation, up the corner furthest left on the screen, its labels on the outside.
    const onScreen = cornersXY.map((p) => [at(p[0], p[1], z0), p]).filter(([q]) => q).sort((a, b) => a[0][0] - b[0][0]);
    if (onScreen.length) {
      const [zx, zy] = onScreen[0][1];
      const sx = zx === 0 ? -1 : 1, sy = zy === 0 ? -1 : 1;
      tickLine([at(zx, zy, z0), at(zx, zy, z1)]);
      // Not at the very bottom, where the corner's other labels are.
      for (const v of ticks(z0, z1, 4).filter((t) => t > z0 + (z1 - z0) * 0.08)) {
        const p = at(zx, zy, v), q = at(zx + sx * tick, zy + sy * tick, v);
        tickLine([p, q]);
        if (q) label(q, `${fmtCoord(v)} m`, -6, 4, 'right');
      }
    }
    c2.globalAlpha = 1;
    // North, as the camera turns.
    const cx = w - 34 * dpr, cy = 34 * dpr, r = 17 * dpr;
    // The screen direction of north (world +y), from a short step north of the centre.
    let ang = 0;
    const base = project(cam.viewProj, [0, 0, (z0 - oz) * opts.ve], w, h), step = project(cam.viewProj, [0, size() * 0.05, (z0 - oz) * opts.ve], w, h);
    if (step && base) ang = Math.atan2(step[0] - base[0], -(step[1] - base[1]));
    c2.save();
    c2.translate(cx, cy);
    c2.beginPath(); c2.arc(0, 0, r, 0, 2 * Math.PI);
    c2.fillStyle = css('--panel', '#fbfdfd'); c2.globalAlpha = 0.85; c2.fill();
    c2.globalAlpha = 1; c2.lineWidth = dpr; c2.strokeStyle = css('--rule', '#d3dee2'); c2.stroke();
    c2.rotate(ang);
    // A needle: its north half filled, its south half open.
    const n = r * 0.82, wd = r * 0.3;
    c2.beginPath(); c2.moveTo(0, -n); c2.lineTo(wd, 0); c2.lineTo(-wd, 0); c2.closePath();
    c2.fillStyle = css('--ink', '#10222b'); c2.fill();
    c2.beginPath(); c2.moveTo(0, n); c2.lineTo(wd, 0); c2.lineTo(-wd, 0); c2.closePath();
    c2.strokeStyle = css('--ink', '#10222b'); c2.lineWidth = dpr; c2.stroke();
    c2.restore();
    c2.globalAlpha = 1;
    c2.fillStyle = css('--ink', '#10222b');
    c2.font = `600 ${12 * dpr}px ${css('--font-body', 'sans-serif')}`;
    c2.textAlign = 'center';
    c2.fillText('N', cx + Math.sin(ang) * (r + 9 * dpr), cy - Math.cos(ang) * (r + 9 * dpr) + 4 * dpr);
    // The exaggeration and, while the particles move, their time.
    c2.textAlign = 'left';
    c2.font = `${12 * dpr}px ${css('--font-body', 'sans-serif')}`;
    c2.fillStyle = ink;
    const notes = [`Vertical exaggeration ${opts.ve}×`];
    if (view.time !== undefined) notes.push(together(`Particles at ${sig(view.time, 3)} d of ${sig(view.tracks.tMax, 3)} d`));
    notes.forEach((t, i) => c2.fillText(t, 12 * dpr, (20 + i * 17) * dpr));
    // The capture zones' times, at their outlines.
    if (view.zoneLabels && opts.zones) {
      c2.font = `600 ${12 * dpr}px ${css('--font-body', 'sans-serif')}`;
      c2.lineWidth = 3 * dpr;
      c2.strokeStyle = css('--panel', '#fbfdfd');
      c2.fillStyle = css('--model-zone', '#ff4fd8');
      for (const l of view.zoneLabels) {
        const p = at(l.x, l.y, l.z);
        if (!p) continue;
        const t = together(`${sig(l.time, 4)} d`);
        c2.strokeText(t, p[0] + 6 * dpr, p[1] - 6 * dpr);
        c2.fillText(t, p[0] + 6 * dpr, p[1] - 6 * dpr);
      }
    }
  }
  const size = () => Math.max(view.geo.dg.W, view.geo.dg.H);
  const fmtCoord = (v) => (Math.abs(v) >= 1000 ? fixed(v, 0) : sig(v, 4));

  // ---- the legend and the description ----
  // The step shown in words: a steady period is a steady state, not a time.
  function whenText(s) {
    const p = result.periods[s];
    if (model.periods[p] && model.periods[p].steady) return `period ${p + 1}, steady state`;
    return `period ${p + 1}, step ${result.steps[s] + 1} (${sig(result.times[s], 4)} d)`;
  }
  function legend() {
    if (!view || !view.geo || !ui.legend) return;
    const items = [];
    const sc = view.scale, run = Boolean(result);
    const when = run ? whenText(opts.step) : '';
    const what = sc.kind === 'drawdown' ? `Drawdown from ${referenceText(result, runData().ref)}` : run ? 'Head' : 'Starting head (no run yet)';
    const fmt = (v) => (sc.log ? sig(v, 3) : fixed(Math.abs(v) < 0.5 * 10 ** -Math.max(2, sc.decimals) ? 0 : v, Math.max(2, sc.decimals)));
    const valuesShown = opts.surface || (opts.cut !== 'none' && opts.cutShows === 'value');
    if (valuesShown) {
      const bar = el('span', { class: 'model-bar', 'aria-hidden': 'true' });
      bar.style.background = `linear-gradient(to right, ${css('--model-ramp', '').split(/\s+/).filter(Boolean).join(', ')})`;
      const on = [opts.surface ? 'the water table' : '', opts.cut !== 'none' && opts.cutShows === 'value' ? 'the cut' : ''].filter(Boolean).join(' and ');
      items.push(el('span', { class: 'model-scale' }, el('span', { class: 'model-scale-name' }, together(`${what}${when ? `, ${when}` : ''}, on ${on} (m)`)),
        el('span', { class: 'model-scale-row' }, el('span', {}, fmt(sc.lo)), bar, el('span', {}, fmt(sc.hi))),
        el('span', { class: 'hint' }, together(`${sc.log ? `Log scale from ${fmt(sc.lo)} m (1/1000 of the largest, or the smallest above zero), smaller values taking the bottom colour` : 'Linear scale'}${run && result.times.length > 1 ? ', from the smallest to the largest over every time step, so the colours hold as the steps change' : ''}.${opts.contours ? ` Contours every ${fixed(sc.interval, sc.decimals)} m, every fifth heavier.` : ''}`))));
    }
    if (opts.surface) items.push(key(swatch('k-water'), 'Water table: the head in the uppermost active cell that is not dry (the potentiometric surface where that layer is confined)'));
    if (opts.cut !== 'none' && opts.surface) items.push(key(swatch('k-wtline'), opts.cutShows === 'value' ? 'The water table on the cut; above it, the layers' : 'The water table on the cut'));
    const nlay = model.grid.nlay;
    model.npf.icelltype.forEach((t, k) => {
      const sw = swatch('k-layer');
      const c = view.layerColours[k];
      sw.style.background = `rgb(${c.map((v) => Math.round(v * 255)).join(', ')})`;
      if (nlay <= 12 || k === 0 || k === nlay - 1) items.push(key(sw, `Layer ${k + 1}${t === 0 ? '' : ', convertible'}`));
    });
    for (const b of view.present.boundaries) items.push(key(swatch(`k-${b}`), PACKAGES[b].plural));
    if (opts.wells && view.present.wells.pumping) items.push(key(swatch('k-wel'), 'Pumping wells (the thicker part is the screen)'));
    if (opts.wells && view.present.wells.injecting) items.push(key(swatch('k-inject'), 'Injecting wells'));
    if (view.present.dry) items.push(key(swatch('k-dry3d'), `Dry cells, hatched (${countOf(view.present.dry, 'cell', 'cells')})`));
    if (view.tracks) {
      const bar = el('span', { class: 'model-bar', 'aria-hidden': 'true' });
      bar.style.background = `linear-gradient(to right, ${css('--model-time-ramp', '').split(/\s+/).filter(Boolean).join(', ')})`;
      items.push(el('span', { class: 'model-scale' }, el('span', { class: 'model-scale-name' }, 'Pathlines by travel time (d), log scale'),
        el('span', { class: 'model-scale-row' }, el('span', {}, sig(view.tracks.tMin, 3)), bar, el('span', {}, sig(view.tracks.tMax, 3)))));
    }
    if (view.zoneTimes && view.zoneTimes.length) items.push(key(swatch('k-zone'), together(`Capture zone at ${view.zoneTimes.map((t) => sig(t, 4)).join(', ')} d, each outline labelled with its time and drawn on the land surface above where the particles were`)));
    if (model.grid.idomain && model.grid.idomain.some((v) => v !== 1)) items.push(el('span', { class: 'hint' }, 'Inactive cells (idomain 0, and −1, the vertical pass-through cells) are not part of the block, so a cut shows the block\'s sides behind them.'));
    if (view.geo.dg.stride > 1) items.push(el('span', { class: 'hint' }, together(`The block and the water table are drawn on blocks of ${view.geo.dg.stride} × ${view.geo.dg.stride} cells (${view.geo.dg.nrow} × ${view.geo.dg.ncol}), each the mean of its cells, so the view stays smooth; the wells keep their own cells.`)));
    items.push(el('span', { class: 'hint' }, together(`Vertical exaggeration ${opts.ve}×. Elevations and coordinates in m${model.georef && (model.georef.xorigin || model.georef.yorigin) ? ', from the model\'s georeference' : ', from the grid\'s south-west corner'}.`)));
    ui.legend.replaceChildren(...items);
  }
  const swatch = (cls) => el('span', { class: `model-swatch ${cls}`, 'aria-hidden': 'true' });
  const key = (sw, text) => el('span', { class: 'model-key' }, sw, text);

  function describe() {
    if (!view || !view.canvas || !view.geo) return;
    const g = model.grid;
    const cut = { none: 'not cut', col: `cut along column ${opts.col * view.geo.dg.stride + 1}`, row: `cut along row ${opts.row * view.geo.dg.stride + 1}`, corner: `with the corner south-west of column ${opts.col * view.geo.dg.stride + 1} and row ${opts.row * view.geo.dg.stride + 1} cut away` }[opts.cut];
    view.canvas.setAttribute('aria-label', together(`The model in 3D: ${countOf(g.nlay, 'layer', 'layers')} of ${g.nrow} rows and ${g.ncol} columns, ${cut}, vertical exaggeration ${opts.ve}×${opts.surface ? `, with the water table coloured by ${view.scale.kind}` : ''}.`));
  }

  // ---- the image ----
  function saveImage() {
    if (!view || !view.geo) return;
    renderNow();
    const { canvas, labels } = view;
    const w = canvas.width, h = canvas.height, dpr = w / Math.max(1, canvas.clientWidth);
    const keys = imageKeys();
    const legendH = Math.round((keys.length ? 92 : 64) * dpr);
    const out = document.createElement('canvas');
    out.width = w; out.height = h + legendH;
    const c2 = out.getContext('2d');
    c2.fillStyle = css('--panel', '#fbfdfd');
    c2.fillRect(0, 0, out.width, out.height);
    c2.drawImage(canvas, 0, 0);
    c2.drawImage(labels, 0, 0);
    // The colour scale and the model's name under the view.
    const sc = view.scale, pad = 14 * dpr;
    c2.fillStyle = css('--ink', '#10222b');
    c2.font = `600 ${13 * dpr}px ${css('--font-body', 'sans-serif')}`;
    c2.textAlign = 'left';
    const run = Boolean(result);
    const title = `${model.name || 'Model'}: ${sc.kind === 'drawdown' ? 'drawdown' : run ? 'head' : 'starting head'} (m)${run ? `, ${whenText(opts.step)}` : ''}`;
    c2.fillText(together(title), pad, h + 22 * dpr);
    const stops = css('--model-ramp', '#3b0f70 #fde725').split(/\s+/).filter(Boolean);
    const bx = pad + 70 * dpr, bw = Math.min(w - bx - 90 * dpr, 360 * dpr), by = h + 34 * dpr, bh = 12 * dpr;
    const grad = c2.createLinearGradient(bx, 0, bx + bw, 0);
    stops.forEach((s, i) => grad.addColorStop(i / (stops.length - 1), s));
    c2.fillStyle = grad;
    c2.fillRect(bx, by, bw, bh);
    c2.fillStyle = css('--ink-2', '#47606b');
    c2.font = `${12 * dpr}px ${css('--font-data', 'monospace')}`;
    const fmt = (v) => (sc.log ? sig(v, 3) : fixed(v, Math.max(2, sc.decimals)));
    c2.textAlign = 'right'; c2.fillText(fmt(sc.lo), bx - 8 * dpr, by + bh - 1 * dpr);
    c2.textAlign = 'left'; c2.fillText(fmt(sc.hi), bx + bw + 8 * dpr, by + bh - 1 * dpr);
    // A line of keys: the layers, boundaries, wells and lines shown.
    c2.font = `${12 * dpr}px ${css('--font-body', 'sans-serif')}`;
    let x = pad;
    const y = h + 70 * dpr, size = 12 * dpr;
    for (const k of keys) {
      const tw = c2.measureText(k.text).width;
      if (x + size + 6 * dpr + tw > w - pad) break;
      c2.fillStyle = k.colour;
      if (k.line) c2.fillRect(x, y - size / 2 - dpr, size * 1.6, 3 * dpr); else if (k.round) { c2.beginPath(); c2.arc(x + size / 2, y - size / 2, size / 2, 0, 2 * Math.PI); c2.fill(); } else c2.fillRect(x, y - size, size, size);
      c2.fillStyle = css('--ink-2', '#47606b');
      const sw = k.line ? size * 1.6 : size;
      c2.fillText(k.text, x + sw + 6 * dpr, y - 1 * dpr);
      x += sw + 6 * dpr + tw + 16 * dpr;
    }
    out.toBlob((blob) => { if (blob) saveFile(`${model.name || 'model'}-3d.png`, blob); }, 'image/png');
  }

  // The keys under a saved image, as the legend has them.
  function imageKeys() {
    const rgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(', ')})`;
    const out = view.layerColours.slice(0, 8).map((c, k) => ({ colour: rgb(c), text: `Layer ${k + 1}` }));
    for (const b of view.present.boundaries) out.push({ colour: css(`--model-${b === 'evtList' ? 'evt' : b}`, '#888'), text: PACKAGES[b].plural });
    if (opts.wells && view.present.wells.pumping) out.push({ colour: css('--model-wel', '#e3001b'), text: 'Pumping well', round: true });
    if (opts.wells && view.present.wells.injecting) out.push({ colour: css('--model-inject', '#1f5fd6'), text: 'Injecting well', round: true });
    if (opts.surface && opts.cut !== 'none') out.push({ colour: css('--model-water', '#0b57c4'), text: 'Water table on the cut', line: true });
    if (view.zoneTimes && view.zoneTimes.length) out.push({ colour: css('--model-zone', '#ff4fd8'), text: 'Capture zone', line: true });
    if (view.tracks) out.push({ colour: css('--model-time-ramp', '#ef7d2a').split(/\s+/)[1], text: 'Pathlines, by travel time', line: true });
    out.push({ colour: 'transparent', text: `Vertical exaggeration ${opts.ve}×` });
    return out;
  }

  // ---- play through the steps ----
  function togglePlay() {
    if (!view) return;
    if (view.play) { clearInterval(view.play); view.play = null; ui.playBtn.textContent = 'Play'; return; }
    if (!result || result.times.length < 2) return;
    if (opts.step >= result.times.length - 1) opts.step = 0;
    ui.playBtn.textContent = 'Pause';
    view.play = setInterval(() => {
      if (!view || !result) return;
      if (opts.step >= result.times.length - 1) { togglePlay(); return; }
      opts.step++;
      ui.step.value = String(opts.step);
      changed('step');
    }, 140);
  }

  // A new model, run or edit: what is built is brought up to date.
  function refresh() {
    showState();
    if (!view || !view.gl || !view.draw) return;
    if (!model) { view.stage.hidden = true; return; }
    view.stage.hidden = false;
    if (view.play && !result) togglePlay();
    const fresh = buildGeometry();
    colours();
    if (result && opts.step !== null && opts.step >= result.times.length) opts.step = null;
    buildResults();
    fillControls();
    if (fresh) { view.cam = null; }
    legend();
    describe();
    redraw();
  }

  return {
    update(nextModel, nextResult, nextState = {}) {
      const isFresh = Boolean(nextState.fresh);
      if (isFresh) { opts = blank(); if (view && view.geo) view.geo = null; }
      if (nextResult !== result) opts.step = null;
      model = nextModel; result = nextResult; state = nextState;
      if (view && view.play && !result) togglePlay();
      refresh();
    },
    overlaysChanged() { if (view && view.geo) refresh(); },
  };
}

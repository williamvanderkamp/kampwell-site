// The /wsa/ page's charts are drawn at build time (scripts/wsa/page.js, chart.js). This adds a
// readout (the date and each series' value at the day under the pointer, with a line marking
// that day) and zooming as the site's other charts zoom (zoom.js): drag across a chart to zoom
// in, double-click to see all of it; the charts of one well show the same stretch of time.
// Without it the charts are the same.
import { BOX, chartSvg } from './chart.js';
import { attachZoom, zoomGroup } from './zoom.js';

const DAY = 864e5;
const groups = new Map();

for (const fig of document.querySelectorAll('figure[data-chart]')) {
  const spec = JSON.parse(fig.dataset.chart);
  const box = fig.querySelector('.plot-box');
  const out = fig.querySelector('.readout');
  const home = [spec.t0, spec.t0 + (spec.n - 1) * DAY];
  let range = null;
  // Over the plot area, an element that takes the pointer; the SVG under it is redrawn on zoom.
  const H = spec.height;
  const hit = document.createElement('div');
  hit.className = 'plot-hit';
  Object.assign(hit.style, {
    left: `${BOX.L / BOX.W * 100}%`, width: `${(BOX.W - BOX.L - BOX.R) / BOX.W * 100}%`,
    top: `${BOX.T / H * 100}%`, height: `${(H - BOX.T - BOX.B) / H * 100}%`,
  });
  const sel = document.createElement('div');
  sel.className = 'zoom-sel';
  sel.hidden = true;
  hit.append(sel);
  box.append(hit);

  const shown = () => range || home;
  const toVal = (px) => { const [a, b] = shown(); return a + px / hit.clientWidth * (b - a); };
  const draw = () => { box.querySelector('svg').outerHTML = chartSvg(spec, range); };

  const section = fig.closest('section') || document.body;
  if (!groups.has(section)) groups.set(section, zoomGroup());
  attachZoom({
    el: hit,
    width: () => hit.clientWidth,
    toVal,
    show: (r) => { range = r; draw(); },
    select: (s) => {
      sel.hidden = !s;
      if (s) Object.assign(sel.style, { left: `${s[0]}px`, width: `${s[1] - s[0]}px` });
    },
  }, { group: groups.get(section) });

  // The readout of the day under the pointer.
  const show = (event) => {
    const px = event.clientX - hit.getBoundingClientRect().left;
    const i = Math.round((toVal(px) - spec.t0) / DAY);
    const [a, b] = shown();
    const ms = spec.t0 + i * DAY;
    if (i < 0 || i >= spec.n || ms < a || ms > b) { hide(); return; }
    const sx = (BOX.L + (ms - a) / (b - a) * (BOX.W - BOX.L - BOX.R)).toFixed(1);
    const cursor = box.querySelector('svg .cursor');
    cursor.setAttribute('x1', sx);
    cursor.setAttribute('x2', sx);
    cursor.removeAttribute('hidden');
    const day = new Date(ms).toISOString().slice(0, 10);
    out.textContent = `${day}   ${spec.series.map((s) => `${s.label}: ${s.v[i] === null ? 'no value' : `${s.v[i].toFixed(spec.dec)} ${spec.unit}`}`).join('   ')}`;
  };
  const hide = () => { box.querySelector('svg .cursor').setAttribute('hidden', ''); out.textContent = ''; };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
}

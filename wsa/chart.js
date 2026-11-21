// The /wsa/ page's charts: one daily series or more over time, as SVG. Written at build time
// by scripts/wsa/page.js, so the page shows them without a script, and drawn again in the
// browser by wsa.js for a stretch of time when the reader zooms (app/zoom.js). Colours come
// from wsa.css, by class.

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 864e5;
// The chart's box, in SVG units: its size and the margins round the plot.
export const BOX = { W: 960, L: 66, R: 92, T: 12, B: 30 };

// Round tick values covering [lo, hi], about `count` of them.
function ticks(lo, hi, count) {
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return { values: out, step };
}
// Enough decimals to write every tick of this step exactly: 2.5 needs one.
const decimalsOf = (step) => { const t = String(Number(step.toPrecision(6))); return t.includes('.') ? t.split('.')[1].length : 0; };

/**
 * What a chart needs, kept in the page for drawing it again: t (ms, one a day), series
 * [{ label, values, cls }], the y unit, height, a scale for the values (100: m to cm),
 * the title, and whether the y axis must show zero.
 */
export function chartSpec({ id, t, series, unit, height, scale = 1, title, zero = false }) {
  t.forEach((ms, i) => { if (ms !== t[0] + i * DAY) throw new Error(`${id}: the times are not one a day (row ${i}).`); });
  return {
    id, title, unit, height, zero, t0: t[0], n: t.length, dec: unit === 'cm' ? 1 : 3,
    series: series.map((s) => ({ label: s.label, cls: s.cls, v: s.values.map((v) => (Number.isFinite(v) ? Number((v * scale).toFixed(4)) : null)) })),
  };
}

/** The chart as SVG, over all of it or the stretch range = [from, to] (ms). */
export function chartSvg(spec, range = null) {
  const { W, L, R, T, B } = BOX, H = spec.height;
  const { t0, n } = spec;
  const [x0, x1] = range || [t0, t0 + (n - 1) * DAY];
  // The days in view, and one either side so the lines run to the edges.
  const i0 = Math.max(0, Math.floor((x0 - t0) / DAY) - 1), i1 = Math.min(n - 1, Math.ceil((x1 - t0) / DAY) + 1);
  const seen = (i) => { const ms = t0 + i * DAY; return ms >= x0 && ms <= x1; };
  const all = [];
  for (const s of spec.series) for (let i = i0; i <= i1; i++) if (seen(i) && s.v[i] !== null) all.push(s.v[i]);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (!all.length) { lo = 0; hi = 1; }
  if (spec.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad; hi += pad;
  const yt = ticks(lo, hi, 5);
  const dec = decimalsOf(yt.step);
  const x = (ms) => L + (ms - x0) / (x1 - x0) * (W - L - R);
  const y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const clip = `${spec.id}-clip`;
  const parts = [];
  parts.push(`<svg class="wsa-chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${spec.id}-t">`, `<title id="${spec.id}-t">${esc(spec.title)}</title>`);
  parts.push(`<clipPath id="${clip}"><rect x="${L}" y="0" width="${W - L - R}" height="${H}"/></clipPath>`);
  for (const v of yt.values) {
    parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`);
    parts.push(`<text class="tick" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v.toFixed(dec)}</text>`);
  }
  if (spec.zero) parts.push(`<line class="zero" x1="${L}" x2="${W - R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`);
  // Over more than about ten weeks a tick at the first of each month, with the year under
  // January and the first month; over less, a tick every 1, 2, 7 or 14 days, with the month
  // under the first day of each month and the first tick.
  const tickAt = (ms, label) => {
    const xm = x(ms).toFixed(1);
    parts.push(`<line class="mtick" x1="${xm}" x2="${xm}" y1="${H - B}" y2="${H - B + 5}"/>`);
    parts.push(`<text class="tick" x="${xm}" y="${H - B + 19}" text-anchor="middle">${label}</text>`);
  };
  const days = (x1 - x0) / DAY;
  if (days > 75) {
    const start = new Date(x0);
    for (let d = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + (start.getUTCDate() === 1 && start.getUTCHours() === 0 ? 0 : 1), 1), first = true; d <= x1; first = false) {
      const dt = new Date(d);
      tickAt(d, dt.getUTCMonth() === 0 || first ? `${MON[dt.getUTCMonth()]} ${dt.getUTCFullYear()}` : MON[dt.getUTCMonth()]);
      d = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1);
    }
  } else {
    const step = [1, 2, 7, 14].find((s) => days / s <= 10) || 14;
    const s0 = new Date(x0);
    let d = Date.UTC(s0.getUTCFullYear(), s0.getUTCMonth(), s0.getUTCDate());
    if (d < x0) d += DAY;
    if (step === 7) while (new Date(d).getUTCDay() !== 1) d += DAY; // Mondays
    for (let first = true; d <= x1; d += step * DAY, first = false) {
      const dt = new Date(d);
      const label = first || dt.getUTCDate() <= step ? `${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}${first || dt.getUTCMonth() === 0 ? ` ${dt.getUTCFullYear()}` : ''}` : String(dt.getUTCDate());
      tickAt(d, label);
    }
  }
  parts.push(`<line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>`);
  const ends = [];
  for (const s of spec.series) {
    let d = '', pen = false, last = null;
    for (let i = i0; i <= i1; i++) {
      const v = s.v[i];
      if (v === null) { pen = false; continue; }
      const px = x(t0 + i * DAY), py = y(v);
      d += `${pen ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
      pen = true;
      if (seen(i)) last = [px, py];
    }
    parts.push(`<path class="line ${s.cls}" clip-path="url(#${clip})" d="${d}"/>`);
    // The series named at its last point in view, in ink, beside a short swatch of its colour.
    if (last) {
      parts.push(`<line class="swatch ${s.cls}" x1="${(last[0] + 6).toFixed(1)}" x2="${(last[0] + 18).toFixed(1)}" y1="${last[1].toFixed(1)}" y2="${last[1].toFixed(1)}"/>`);
      ends.push({ s, x: last[0] + 22, y: last[1] });
    }
  }
  // Keep end labels apart.
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
  for (const e of ends) parts.push(`<text class="end-label" x="${e.x.toFixed(1)}" y="${(e.y + 4).toFixed(1)}">${esc(e.s.label)}</text>`);
  parts.push(`<line class="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" hidden/>`);
  parts.push('</svg>');
  return parts.join('\n');
}

/** The chart's figure for the page: title, legend, the chart over all of it, and its data. */
export function chartFigure(spec) {
  const legend = spec.series.map((s) => `<span class="key"><span class="swatch-box ${s.cls}"></span>${esc(s.label)}</span>`).join('');
  return `<figure class="wsa-figure" data-chart='${esc(JSON.stringify(spec))}'>
<figcaption class="chart-head"><span class="chart-title">${esc(spec.title)}</span><span class="legend">${legend}</span></figcaption>
<div class="chart-scroll"><div class="plot-box">
${chartSvg(spec)}
</div></div>
<p class="readout" aria-live="polite"></p>
</figure>`;
}

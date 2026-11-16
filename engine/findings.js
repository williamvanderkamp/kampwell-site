// Checks that read a well record's fit to air pressure and say where it should not be
// trusted, or what it shows, with no setting made for the well. The tests, their sources
// and their thresholds, fixed before they were run on new wells: docs/design/findings.md.
//
// Each uses the cleaner's own regression (correct.js): the change in level from one step to
// the next against the change in air pressure (as a height of water) at each lag, with a
// constant, on the rows the cleaner fits.
import { LAG_HOURS } from './correct.js';
import * as libm from './libm.js';
import { invertSPD } from './linalg.js';
import { erfc, isNum } from './numeric.js';
import { prepare } from './prepare.js';
import { stepsIn } from './regression.js';

export const FINDINGS = {
  alpha: 0.01,          // significance for a finding
  replicates: 999,      // bootstrap replicates for the change test
  seed: 1,
  minDays: 30,          // shortest stretch either side of a change
  z95: 1.959963984540054,
  // Dates whose statistic is within this of the largest form the range given for a change:
  // Hansen's (2000) 95% value for the likelihood ratio of a split point.
  dateMargin: 7.35,
  longerLags: [96, 144],
};
const DAY_H = 24;

// A small seeded generator (mulberry32), uniform on [0, 1), and standard normals from it,
// so a run is the same every time.
function uniform(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normals(seed) {
  const u = uniform(seed);
  let spare = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let x;
    do x = u(); while (x === 0);
    const r = Math.sqrt(-2 * libm.log(x)), th = 2 * Math.PI * u();
    spare = r * libm.sin(th);
    return r * libm.cos(th);
  };
}

/**
 * The regression's rows on the model grid: x = [1, change in pressure at lag 0..nLags],
 * y = change in level, for steps where all are known and include(i) holds, as
 * regression.js's fitDifferences takes them.
 */
export function design(grid, nLags, include = null) {
  const { h, b } = grid;
  const rows = [], X = [], y = [];
  for (let i = nLags + 1; i < h.length; i++) {
    if (!isNum(h[i]) || !isNum(h[i - 1]) || (include && !include(i))) continue;
    const x = [1];
    for (let k = 0; k <= nLags; k++) {
      const d = b[i - k] - b[i - k - 1];
      if (!isNum(d)) break;
      x.push(d);
    }
    if (x.length !== nLags + 2) continue;
    rows.push(i); X.push(x); y.push(h[i] - h[i - 1]);
  }
  return { rows, X, y, k: nLags + 2 };
}

const xtx = (X, k, w = null) => {
  const A = new Float64Array(k * k);
  X.forEach((x, r) => { const s = w ? w[r] : 1; for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) A[a * k + c] += s * x[a] * x[c]; });
  return A;
};
const mulVec = (A, v, k) => Array.from({ length: k }, (_, a) => { let s = 0; for (let c = 0; c < k; c++) s += A[a * k + c] * v[c]; return s; });
const quad = (A, u, v, k) => { let s = 0; for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) s += u[a] * A[a * k + c] * v[c]; return s; };

/** Ordinary least squares: coefficients, residuals and (X'X)^-1. Null when the columns cannot all be fitted. */
export function ols(X, y, k) {
  if (X.length < 3 * k) return null;
  const { inv } = invertSPD(xtx(X, k), k);
  if (!inv) return null;
  const xy = new Array(k).fill(0);
  X.forEach((x, r) => { for (let a = 0; a < k; a++) xy[a] += x[a] * y[r]; });
  const beta = mulVec(inv, xy, k);
  const e = y.map((v, r) => v - X[r].reduce((s, x, a) => s + x * beta[a], 0));
  return { beta, e, inv };
}

/** Newey and West's (1994) bandwidth for n rows. */
export const bandwidth = (n) => Math.floor(4 * libm.exp((2 / 9) * libm.log(n / 100)));

/**
 * The Newey–West (1987) covariance of OLS coefficients: Bartlett weights, lags counted on
 * the grid (rows[]), so a gap breaks the products across it.
 */
export function hac(X, e, rows, inv, k, L = bandwidth(X.length)) {
  const S = new Float64Array(k * k);
  const at = new Map(rows.map((g, r) => [g, r]));
  X.forEach((x, r) => {
    for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) S[a * k + c] += e[r] * e[r] * x[a] * x[c];
    for (let l = 1; l <= L; l++) {
      const q = at.get(rows[r] - l);
      if (q === undefined) continue;
      const w = 1 - l / (L + 1), z = X[q], ee = w * e[r] * e[q];
      for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) S[a * k + c] += ee * (x[a] * z[c] + z[a] * x[c]);
    }
  });
  // inv S inv
  const T = new Float64Array(k * k), V = new Float64Array(k * k);
  for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) { let s = 0; for (let m = 0; m < k; m++) s += inv[a * k + m] * S[m * k + c]; T[a * k + c] = s; }
  for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) { let s = 0; for (let m = 0; m < k; m++) s += T[a * k + m] * inv[m * k + c]; V[a * k + c] = s; }
  return V;
}

const pNormal = (z) => erfc(Math.abs(z) / Math.SQRT2);

/**
 * Check 1: did the same-day response to air pressure change at some date? Sup of the
 * heteroskedasticity-robust Wald statistic over dates (Andrews 1993), p-value by the
 * fixed-regressor bootstrap (Hansen 2000) with dependent wild bootstrap multipliers
 * (Shao 2010). On a change: its date, its size γ with a 95% Newey–West interval, and its kind.
 */
export function responseChange(grid, nLags, stepH, o = FINDINGS) {
  const { X, y, rows, k } = design(grid, nLags);
  const minRows = Math.ceil(o.minDays * DAY_H / stepH);
  const m = X.length;
  if (m < 2 * minRows + k) return { ran: false, reason: 'too-short', rows: m };
  const fit = ols(X, y, k);
  if (!fit) return { ran: false, reason: 'not-fitted', rows: m };
  const { inv, e: e0 } = fit;
  const d = X.map((x) => x[1]);
  // For each date (row j), the column z: the same-day pressure change from row j on. Its
  // part not explained by X, z̃ = z − X c with c = inv X'z, is what the test reads (Frisch–Waugh).
  const js = [];
  for (let j = minRows; j <= m - minRows; j++) js.push(j);
  const sxz = new Array(k).fill(0);
  const zt = new Array(js.length);
  for (let q = js.length - 1, r = m - 1; q >= 0; q--) {
    for (; r >= js[q]; r--) for (let a = 0; a < k; a++) sxz[a] += X[r][a] * d[r];
    const c = mulVec(inv, sxz, k), j = js[q];
    zt[q] = Float64Array.from(X, (x, i) => (i >= j ? d[i] : 0) - x.reduce((s, v, a) => s + v * c[a], 0));
  }
  // sup over dates of the heteroskedasticity-robust Wald statistic for γ, for residuals e
  // of the fit without the change (orthogonal to X): γ = z̃'e / z̃'z̃, var = Σ z̃² (e − γ z̃)² / (z̃'z̃)².
  const supWald = (e, profile = null) => {
    let best = -1, at = -1;
    zt.forEach((z, q) => {
      let zz = 0, ze = 0;
      for (let i = 0; i < m; i++) { zz += z[i] * z[i]; ze += z[i] * e[i]; }
      const g = ze / zz;
      let v = 0;
      for (let i = 0; i < m; i++) { const r1 = e[i] - g * z[i]; v += z[i] * z[i] * r1 * r1; }
      const wald = v > 0 ? (g * g * zz * zz) / v : 0;
      if (profile) profile.push(wald);
      if (wald > best) { best = wald; at = js[q]; }
    });
    return { lm: best, j: at };
  };
  const profile = [];
  const obs = supWald(e0, profile);
  // Bootstrap: residuals times multipliers correlated over ℓ steps of the grid (a moving
  // sum of ℓ normals over √ℓ gives Bartlett correlation), then projected off X again.
  const ell = Math.max(1, Math.round(libm.exp(libm.log(m) / 3)));
  const g0 = rows[0], span = rows[m - 1] - g0 + 1;
  const rnd = normals(o.seed);
  let above = 0;
  for (let rep = 0; rep < o.replicates; rep++) {
    const z = Array.from({ length: span + ell }, rnd);
    const w = new Float64Array(span);
    let s = 0;
    for (let q = 0; q < ell; q++) s += z[q];
    for (let g = 0; g < span; g++) { w[g] = s / Math.sqrt(ell); s += z[g + ell] - z[g]; }
    const v = e0.map((x, r) => x * w[rows[r] - g0]);
    const xv = new Array(k).fill(0);
    X.forEach((x, r) => { for (let a = 0; a < k; a++) xv[a] += x[a] * v[r]; });
    const bv = mulVec(inv, xv, k);
    const ev = v.map((x, r) => x - X[r].reduce((acc, xa, a) => acc + xa * bv[a], 0));
    if (supWald(ev).lm >= obs.lm) above++;
  }
  const p = (1 + above) / (o.replicates + 1);
  const j = obs.j;
  // The change at that date, fitted: γ on the same-day pressure change from that row on.
  const Xz = X.map((x, r) => [...x, r >= j ? d[r] : 0]);
  const full = ols(Xz, y, k + 1);
  const V = hac(Xz, full.e, rows, full.inv, k + 1);
  const gamma = full.beta[k], se = Math.sqrt(V[k * (k + 1) + k]);
  const ci = [gamma - o.z95 * se, gamma + o.z95 * se];
  // Named by the nearest of 0, +1 (a correction stopped) and −1 (one applied twice), once the
  // interval leaves out 0. Not "the interval holds ±1": a date a day out, or a fault that
  // starts within a day and so reaches only part of that day's mean, moves γ a little.
  // And the interval must come within a quarter of ±1, so a change of 0.6 ± 0.05 is not
  // named a stopped correction.
  const near = (x) => ci[0] <= x + 0.25 && ci[1] >= x - 0.25;
  const kind = ci[0] <= 0 && 0 <= ci[1] ? 'changed' : gamma > 0.5 && near(1) ? 'stopped' : gamma < -0.5 && near(-1) ? 'doubled' : 'changed';
  // The dates the data cannot choose between: those whose statistic is within dateMargin
  // of the largest (Hansen 2000). Days with little change in pressure say little about
  // when the response changed, so the range can be several days.
  const close = js.filter((_, q) => profile[q] >= obs.lm - o.dateMargin);
  const range = [grid.t[rows[close[0]]], grid.t[rows[close[close.length - 1]]]];
  // The largest change in level from one step to the next, from that date on.
  let jump = 0;
  for (let i = rows[j]; i < grid.h.length; i++) if (isNum(grid.h[i]) && isNum(grid.h[i - 1])) jump = Math.max(jump, Math.abs(grid.h[i] - grid.h[i - 1]));
  return {
    ran: true, rows: m, statistic: obs.lm, p, alpha: o.alpha, replicates: o.replicates, blockRows: ell, minRows,
    found: p < o.alpha, at: grid.t[rows[j]], range, gridIndex: rows[j], gamma, se, ci, kind, jumpAfterM: jump,
  };
}

/**
 * Checks 2 and 4 on one stretch: whether the response has settled at the longest lag
 * (its last coefficient against 0), and its shape, the response at the longest lag less
 * the same-day response (Rasmussen and Crawford 1997). Responses here are shares of a
 * change in air pressure, positive when the level falls as pressure rises, as the
 * cleaner gives them.
 */
export function responseStretch(grid, nLags, stepH, include = null, o = FINDINGS) {
  const { X, y, rows, k } = design(grid, nLags, include);
  const fit = ols(X, y, k);
  if (!fit) return { ran: false, reason: 'too-short', rows: X.length };
  const V = hac(X, fit.e, rows, fit.inv, k);
  const u = fit.beta.slice(1);
  let cum = 0;
  const steps = u.map((x) => { cum += x; return -cum; });
  const last = k - 1, seLast = Math.sqrt(V[last * k + last]);
  const zLast = u[nLags] / seLast;
  // Response at the longest lag less the same-day one: −Σ u[1..].
  const a = new Array(k).fill(0);
  for (let c = 2; c < k; c++) a[c] = -1;
  const diff = -u.slice(1).reduce((s, x) => s + x, 0);
  const seDiff = Math.sqrt(quad(V, a, a, k));
  const ciDiff = [diff - o.z95 * seDiff, diff + o.z95 * seDiff];
  const longer = o.longerLags.map((lagHours) => {
    const n2 = stepsIn(lagHours, stepH);
    const d2 = design(grid, n2, include), f2 = ols(d2.X, d2.y, d2.k);
    return { lagHours, be: f2 ? -f2.beta.slice(1).reduce((s, x) => s + x, 0) : NaN };
  });
  const sse = fit.e.reduce((s, x) => s + x * x, 0), sst = y.reduce((s, x) => s + x * x, 0);
  return {
    ran: true, rows: X.length, steps, explained: 1 - sse / sst, residuals: fit.e, gridRows: rows,
    unsettled: { coefficient: -u[nLags], se: seLast, z: zLast, p: pNormal(zLast), found: pNormal(zLast) < o.alpha, alpha: o.alpha, longer },
    shape: { diff, se: seDiff, ci: ciDiff, kind: ciDiff[0] > 0 ? 'rising' : ciDiff[1] < 0 ? 'falling' : 'steady' },
  };
}

/**
 * Check 3: a weekly pattern in residuals e on grid rows. The statistic is the spread of the
 * weekday means (their sum of squares about the overall mean, weighted by count). Its
 * p-value comes from shuffling the weekdays within each calendar week (Monday to Sunday),
 * 999 times with a fixed seed: a randomization test (Edgington and Onghena 2007) that
 * keeps whatever moves the record from week to week, and holds its size however short the
 * stretch. Weekday of the time as the file gives it.
 */
export function weeklyPattern(t, e, rows, o = FINDINGS) {
  if (e.length < 28) return { ran: false, reason: 'too-short', rows: e.length };
  const day = rows.map((g) => new Date(t[g]).getUTCDay());
  const week = rows.map((g) => Math.floor((t[g] / 864e5 + 3) / 7)); // weeks start on Monday (1970-01-01 was a Thursday)
  const spread = (lab) => {
    const sums = new Array(7).fill(0), counts = new Array(7).fill(0);
    lab.forEach((wd, r) => { sums[wd] += e[r]; counts[wd]++; });
    const all = sums.reduce((x, y) => x + y, 0) / e.length;
    let ss = 0;
    for (let q = 0; q < 7; q++) if (counts[q]) { const d = sums[q] / counts[q] - all; ss += counts[q] * d * d; }
    return { ss, sums, counts };
  };
  const obs = spread(day);
  // Rows of each week, to shuffle their weekdays among them.
  const groups = new Map();
  week.forEach((k, r) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const rnd = uniform(o.seed);
  const lab = day.slice();
  let above = 0;
  for (let rep = 0; rep < o.replicates; rep++) {
    for (const g of groups.values()) {
      for (let a = g.length - 1; a > 0; a--) {
        const b = Math.floor(rnd() * (a + 1));
        const x = lab[g[a]]; lab[g[a]] = lab[g[b]]; lab[g[b]] = x;
      }
    }
    if (spread(lab).ss >= obs.ss) above++;
  }
  const p = (1 + above) / (o.replicates + 1);
  return { ran: true, rows: e.length, p, found: p < o.alpha, alpha: o.alpha, replicates: o.replicates, meanByWeekday: obs.sums.map((x, q) => x / obs.counts[q]), counts: obs.counts };
}

/**
 * All the checks on one record, with the cleaner's entries (correct.js). Runs on records a
 * day apart; others get { ran: false, reason: 'not-daily' }. Returns each check's result,
 * found or not, and fitEnd: the end of the stretch to fit the response to, the step before
 * the first date in the range of a correction found by check 1 to have stopped or been
 * applied twice (null otherwise); faultFrom is that first date.
 */
export function recordFindings(input, opts, o = FINDINGS) {
  const prep = prepare(input, opts);
  const { grid, stepH } = prep;
  if (Math.abs(stepH - DAY_H) > 1e-9) return { ran: false, reason: 'not-daily', stepH };
  const nLags = stepsIn(opts.lagHours || LAG_HOURS, stepH);
  const change = responseChange(grid, nLags, stepH, o);
  // Only a recognised fault moves the fit: the stretch from a correction that stopped, or
  // one applied twice, is known to be wrong. For a response that just changed nothing says
  // which side is right, so the whole record is fitted and the change left for a person.
  const fault = change.ran && change.found && (change.kind === 'stopped' || change.kind === 'doubled');
  const at = fault ? change.range[0] : null;
  const before = at === null ? null : (i) => grid.t[i] < at;
  const stretch = responseStretch(grid, nLags, stepH, before, o);
  const weekly = [];
  if (stretch.ran) weekly.push({ stretch: at === null ? 'whole' : 'before', ...weeklyPattern(grid.t, stretch.residuals, stretch.gridRows, o) });
  if (at !== null) {
    const after = responseStretch(grid, nLags, stepH, (i) => grid.t[i] >= at, o);
    weekly.push({ stretch: 'from', ...(after.ran ? weeklyPattern(grid.t, after.residuals, after.gridRows, o) : { ran: false, reason: after.reason }) });
  }
  const { residuals: _r, gridRows: _g, ...kept } = stretch;
  return {
    ran: true, stepH, nLags,
    change, response: kept, weekly,
    fitEnd: at === null ? null : at - stepH * 36e5,
    faultFrom: at,
    days: { grid: grid.n, noLevel: grid.h.filter((x) => !isNum(x)).length, noPressure: grid.b.filter((x) => !isNum(x)).length },
  };
}

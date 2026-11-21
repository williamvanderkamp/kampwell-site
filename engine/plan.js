// The observation planner: which observation sites and test lengths can tell the stated
// hypotheses from a confined aquifer of infinite extent, across the range a first test
// left, what each design would determine, and what it would do for a prediction.
// Design, inputs and limits: docs/design/planner.md. Metres and days throughout; the
// pumped well is at the origin, x east and y north.
import theis from './solutions/theis.js';
import hantushJacob from './solutions/hantush-jacob.js';
import { wellsDrawdown } from './superpose.js';
import { wellFunction } from './pumping.js';
import { invertSPD } from './linalg.js';
import { isNum } from './numeric.js';
import * as libm from './libm.js';

export const PLAN = {
  // λ at which a two-sided test at 5% with one added value finds the feature 9 times in 10:
  // (1.96 + 1.2816)².
  lambda: (1.959963984540054 + 1.2815515655446004) * (1.959963984540054 + 1.2815515655446004),
  gridPoints: 9,       // values across a hypothesis's range
  z95: 1.959963984540054,
  maxNew: 3,
};

export const KINDS = {
  noflow: { name: 'a no-flow boundary', param: 'a', unit: 'm', line: 'noflow' },
  head: { name: 'a constant-head boundary', param: 'a', unit: 'm', line: 'head' },
  leaky: { name: 'leakage through an aquitard', param: 'B', unit: 'm' },
};

const geo = (lo, hi) => Math.sqrt(lo * hi);
const logGrid = (lo, hi, n) => Array.from({ length: n }, (_, i) => lo * libm.exp((libm.log(hi / lo) * i) / (n - 1)));
const range = (v, what) => {
  if (!Array.isArray(v) || v.length !== 2 || !(v[0] > 0) || !(v[1] >= v[0]) || !isNum(v[1])) throw new Error(`${what}: give a range, two numbers above zero, the first no larger than the second.`);
  return v;
};

/** Reading times in days: perCycle a log cycle from first, up to and including no later than until. */
export function readingTimes(first, perCycle, until) {
  if (!(first > 0) || !(perCycle >= 1) || !(until > first)) throw new Error('Reading times: the first reading, the readings per log cycle and the test length must be above zero, and the test longer than the first reading.');
  const out = [];
  for (let k = 0; ; k++) {
    const t = first * libm.exp((libm.log(10) * k) / perCycle);
    if (t > until * (1 + 1e-12)) break;
    out.push(t);
  }
  return out;
}

/** Checks a planning problem and fills in what follows from it; throws naming what is missing. */
export function checkProblem(pr) {
  if (!(pr.Q > 0)) throw new Error('Give the main test\'s pumping rate, above zero.');
  range(pr.T, 'Transmissivity from the first test');
  range(pr.S, 'Storativity from the first test');
  if (!(pr.S[1] < 1)) throw new Error('Storativity from the first test must be below 1.');
  if (!(pr.sigma > 0)) throw new Error('Give the noise of one reading after cleaning, in m, above zero.');
  if (!pr.reading || !(pr.reading.first > 0) || !(pr.reading.perCycle >= 1)) throw new Error('Give the reading plan: the time of the first reading and the readings per log cycle.');
  if (!Array.isArray(pr.durations) || !pr.durations.length || !pr.durations.every((d) => d > pr.reading.first)) throw new Error('Give the test lengths to compare, each longer than the first reading.');
  if (!Array.isArray(pr.hypotheses) || !pr.hypotheses.length) throw new Error('State at least one hypothesis, with its source.');
  pr.hypotheses.forEach((h, i) => {
    const k = KINDS[h.kind];
    if (!k) throw new Error(`Hypothesis ${i + 1}: the kind must be a no-flow boundary, a constant-head boundary or leakage.`);
    if (!h.source) throw new Error(`Hypothesis ${i + 1}: give its source (a map, a log, a report).`);
    range(h.range, `Hypothesis ${i + 1}, ${k.param === 'a' ? 'distance' : 'leakage factor B'}`);
    if (k.line && !isNum(h.bearing)) throw new Error(`Hypothesis ${i + 1}: give the bearing of the boundary from the pumped well, in degrees clockwise from north.`);
  });
  const sites = pr.sites || [];
  if (!sites.length) throw new Error('Mark at least one site where an observation well is or could be.');
  sites.forEach((s, i) => {
    if (!s.name || !isNum(s.x) || !isNum(s.y)) throw new Error(`Site ${i + 1}: give a name and its x and y.`);
    if (s.x === 0 && s.y === 0) throw new Error(`Site ${s.name} is the pumped well itself.`);
  });
  return pr;
}

// The five stage-1 points: each corner of the T and S ranges, and the centre.
const stagePoints = (pr) => [
  { T: geo(...pr.T), S: geo(...pr.S) },
  { T: pr.T[0], S: pr.S[0] }, { T: pr.T[0], S: pr.S[1] }, { T: pr.T[1], S: pr.S[0] }, { T: pr.T[1], S: pr.S[1] },
];

// A site's position along the boundary's bearing (u) and across it (v).
function rotate(site, bearing) {
  const b = (bearing * Math.PI) / 180, sb = libm.sin(b), cb = libm.cos(b);
  return { u: site.x * sb + site.y * cb, v: -site.x * cb + site.y * sb };
}

/**
 * Drawdown at a site at times t under hypothesis h with its value at `value`, T and S.
 * Null where the site lies beyond the boundary, outside the aquifer.
 */
export function hypothesisDrawdown(h, value, T, S, Q, site, t) {
  const k = KINDS[h.kind];
  if (!k.line) return hantushJacob.drawdown({ T, S, B: value }, { r: Math.sqrt(site.x * site.x + site.y * site.y) }, t, Q);
  const { u, v } = rotate(site, h.bearing);
  if (u >= value) return null;
  return wellsDrawdown(theis, { T, S }, {}, t, { wells: [{ x: 0, y: 0, rates: [[0, Q]] }], obs: { x: u, y: v }, lines: [{ axis: 'x', at: value, type: k.line }], pointwise: true });
}

/**
 * The least sum of squares, in σ², between drawdowns y at distances r and times t and
 * Theis's, over T and S: Gauss–Newton on ln T and ln S with the slopes in closed form,
 * from (T0, S0). Returns { lambda, T, S }.
 */
export function baseMisfit(y, r, t, Q, sigma, T0, S0) {
  const n = y.length;
  let lt = libm.log(T0), ls = libm.log(S0);
  const evaluate = (lT, lS) => {
    const T = libm.exp(lT), S = libm.exp(lS), c = Q / (4 * Math.PI * T);
    const s = new Float64Array(n), gT = new Float64Array(n), gS = new Float64Array(n);
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const u = (r[i] * r[i] * S) / (4 * T * t[i]);
      const e = libm.exp(-u);
      s[i] = c * wellFunction(u);
      gS[i] = -c * e;
      gT[i] = -s[i] + c * e;
      const d = y[i] - s[i];
      sse += d * d;
    }
    return { sse, gT, gS, s };
  };
  let cur = evaluate(lt, ls);
  for (let it = 0; it < 100; it++) {
    let a = 0, b = 0, c = 0, p = 0, q = 0;
    for (let i = 0; i < n; i++) {
      const d = y[i] - cur.s[i];
      a += cur.gT[i] * cur.gT[i]; b += cur.gT[i] * cur.gS[i]; c += cur.gS[i] * cur.gS[i];
      p += cur.gT[i] * d; q += cur.gS[i] * d;
    }
    const det = a * c - b * b;
    if (!(det > 0)) break;
    let dT = (c * p - b * q) / det, dS = (a * q - b * p) / det;
    // No step longer than a factor of e in either value; halve until the sum falls.
    const m = Math.max(Math.abs(dT), Math.abs(dS));
    if (m > 1) { dT /= m; dS /= m; }
    let next = null;
    for (let h = 0; h < 30; h++) {
      const tryIt = evaluate(lt + dT, ls + dS);
      if (tryIt.sse < cur.sse) { next = tryIt; break; }
      dT /= 2; dS /= 2;
    }
    if (!next) break;
    const drop = cur.sse - next.sse;
    lt += dT; ls += dS; cur = next;
    if (drop <= 1e-12 * cur.sse || cur.sse === 0) break;
  }
  return { lambda: cur.sse / (sigma * sigma), T: libm.exp(lt), S: libm.exp(ls) };
}

/**
 * Everything the search needs once: reading times for the longest test, and for each
 * hypothesis, grid value, stage-1 point and site, the hypothesis's drawdown at those times.
 */
export function prepare(problem) {
  const pr = checkProblem(problem);
  const longest = Math.max(...pr.durations);
  const t = readingTimes(pr.reading.first, pr.reading.perCycle, longest);
  const counts = Object.fromEntries(pr.durations.map((d) => [d, t.filter((x) => x <= d * (1 + 1e-12)).length]));
  const points = stagePoints(pr);
  const hyps = pr.hypotheses.map((h) => {
    const grid = logGrid(h.range[0], h.range[1], PLAN.gridPoints);
    const curves = grid.map((value) => points.map((p) => pr.sites.map((s) => hypothesisDrawdown(h, value, p.T, p.S, pr.Q, s, t))));
    return { h, grid, curves };
  });
  return { pr, t, counts, points, hyps };
}

/**
 * λ for a design (site indexes, duration) under hypothesis j at grid value g and stage-1
 * point q. Sites beyond a boundary give nothing and are left out.
 */
function lambdaAt(P, idx, duration, j, g, q) {
  const n = P.counts[duration];
  const y = [], r = [], t = [];
  for (const i of idx) {
    const c = P.hyps[j].curves[g][q][i];
    if (!c) continue;
    const s = P.pr.sites[i], ri = Math.sqrt(s.x * s.x + s.y * s.y);
    for (let k = 0; k < n; k++) { y.push(c[k]); r.push(ri); t.push(P.t[k]); }
  }
  if (!y.length) return 0;
  const p = P.points[q];
  return baseMisfit(y, r, t, P.pr.Q, P.pr.sigma, p.T, p.S).lambda;
}

// The values of each hypothesis a design detects: λ ≥ PLAN.lambda at every stage-1 point.
function detection(P, idx, duration) {
  return P.hyps.map((H, j) => {
    const detected = H.grid.filter((_, g) => P.points.every((__, q) => lambdaAt(P, idx, duration, j, g, q) >= PLAN.lambda));
    return { kind: H.h.kind, bearing: H.h.bearing, source: H.h.source, tested: H.h.range, grid: H.grid, detected, share: detected.length / H.grid.length };
  });
}

// ---------------------------------------------------------------------------------------
// Determination and data worth, at the centre values, by central differences in the logs.

function centreValues(pr, h) { return { T: geo(...pr.T), S: geo(...pr.S), x: geo(...h.range) }; }

// The hypothesis's drawdown at a design's sites (beyond a boundary left out), as one list.
function designCurve(pr, h, v, idx, t) {
  const out = [];
  for (const i of idx) {
    const c = hypothesisDrawdown(h, v.x, v.T, v.S, pr.Q, pr.sites[i], t);
    if (c) out.push(...c);
  }
  return out;
}

const STEP = 1e-4;
function slopes(f, v) {
  const keys = ['T', 'S', 'x'];
  return keys.map((k) => {
    const up = { ...v, [k]: v[k] * libm.exp(STEP) }, dn = { ...v, [k]: v[k] * libm.exp(-STEP) };
    const a = f(up), b = f(dn);
    return a.map((x, i) => (x - b[i]) / (2 * STEP));
  });
}

function solve3(A) {
  const { inv } = invertSPD(Float64Array.from(A), 3);
  return inv;
}

/**
 * For one design under hypothesis h: the factor of each value's 95% interval from the
 * planned readings alone, and, given a prediction { x, y, t, Q }, its 95% half-width
 * before and after the readings (prior from the stated ranges taken as 95% intervals).
 */
export function worth(pr, h, idx, duration, prediction = null) {
  const t = readingTimes(pr.reading.first, pr.reading.perCycle, duration);
  const v = centreValues(pr, h);
  const J = slopes((w) => designCurve(pr, h, w, idx, t), v);
  const F = new Array(9).fill(0);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) F[a * 3 + b] = J[a].reduce((s, x, i) => s + x * J[b][i], 0) / (pr.sigma * pr.sigma);
  const cov = solve3(F);
  const factor = cov ? [0, 1, 2].map((a) => libm.exp(PLAN.z95 * Math.sqrt(cov[a * 3 + a]))) : null;
  let pred = null;
  if (prediction) {
    const sd = [pr.T, pr.S, h.range].map(([lo, hi]) => libm.log(hi / lo) / (2 * PLAN.z95));
    const prior = [0, 1, 2].map((a) => [0, 1, 2].map((b) => (a === b ? sd[a] * sd[a] : 0)));
    const at = { name: 'prediction', x: prediction.x, y: prediction.y };
    const f = (w) => { const s = hypothesisDrawdown(h, w.x, w.T, w.S, prediction.Q, at, [prediction.t]); return s ? s : [NaN]; };
    const y = slopes(f, v).map((g) => g[0]);
    const A = new Array(9).fill(0);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[a * 3 + b] = F[a * 3 + b] + (a === b ? 1 / prior[a][a] : 0);
    const post = solve3(A);
    const quad = (M) => y.reduce((s, ya, a) => s + ya * y.reduce((u, yb, b) => u + M[a * 3 + b] * yb, 0), 0);
    const priorM = [0, 1, 2].flatMap((a) => [0, 1, 2].map((b) => prior[a][b]));
    pred = { value: f(v)[0], before: PLAN.z95 * Math.sqrt(quad(priorM)), after: post ? PLAN.z95 * Math.sqrt(quad(post)) : NaN };
  }
  return { factor, prediction: pred };
}

// ---------------------------------------------------------------------------------------
// The design, and the search.

/** Score and statements for one design: { sites: [names], duration }. */
export function evaluateDesign(problem, design, P = prepare(problem)) {
  const idx = design.sites.map((name) => {
    const i = P.pr.sites.findIndex((s) => s.name === name);
    if (i < 0) throw new Error(`The design names a site that was not marked: ${name}.`);
    return i;
  });
  if (!P.pr.durations.includes(design.duration)) throw new Error(`The design's test length, ${design.duration} d, is not among those compared.`);
  return describe(P, idx, design.duration);
}

function describe(P, idx, duration) {
  const hyps = detection(P, idx, duration);
  const score = hyps.reduce((s, h) => s + h.share, 0) / hyps.length;
  const worths = P.pr.hypotheses.map((h) => worth(P.pr, h, idx, duration, P.pr.prediction || null));
  const widest = Math.max(...worths.map((w) => (w.prediction ? w.prediction.after : 0)));
  return { sites: idx.map((i) => P.pr.sites[i].name), duration, score, hypotheses: hyps, worth: worths, widest };
}

const combos = (n, k, from = 0, pre = [], out = []) => {
  if (pre.length === k) { out.push(pre.slice()); return out; }
  for (let i = from; i < n; i++) { pre.push(i); combos(n, k, i + 1, pre, out); pre.pop(); }
  return out;
};

/**
 * Every set of one to maxNew new sites (existing ones always in), for every duration.
 * Returns the best design for each number of new sites and duration, ranked as the
 * design note says, and the design with existing wells alone.
 */
export function searchDesigns(problem, { maxNew = PLAN.maxNew } = {}) {
  const P = prepare(problem);
  const existing = P.pr.sites.map((s, i) => (s.existing ? i : -1)).filter((i) => i >= 0);
  const fresh = P.pr.sites.map((s, i) => (s.existing ? -1 : i)).filter((i) => i >= 0);
  const best = [];
  for (const duration of P.pr.durations) {
    if (existing.length) best.push({ added: 0, ...describe(P, existing, duration) });
    for (let k = 1; k <= Math.min(maxNew, fresh.length); k++) {
      let top = null, topIdx = null, topScore = -1;
      for (const c of combos(fresh.length, k)) {
        const idx = [...existing, ...c.map((j) => fresh[j])];
        const hyps = detection(P, idx, duration);
        const score = hyps.reduce((s, h) => s + h.share, 0) / hyps.length;
        if (score > topScore + 1e-12) { topScore = score; topIdx = [idx]; } else if (Math.abs(score - topScore) <= 1e-12) topIdx.push(idx);
      }
      // Ties on score go to the narrower prediction interval.
      for (const idx of topIdx) {
        const d = describe(P, idx, duration);
        if (!top || d.widest < top.widest - 1e-12) top = d;
      }
      best.push({ added: k, ...top });
    }
  }
  best.sort((a, b) => b.score - a.score || a.widest - b.widest || a.added - b.added || a.duration - b.duration);
  return { problem: P.pr, lambda: PLAN.lambda, best };
}

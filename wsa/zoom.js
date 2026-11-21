// Zooming the /wsa/ page's charts along their time axis, the way the site's other charts zoom
// (uPlot's own): drag across a chart to zoom into that stretch, double-click to see all of it.
// The y axis follows what is in view. Charts in one group (zoomGroup) show the same stretch.
//
// A chart gives an adapter, its positions in CSS pixels from the left of its plot area:
//   el            the element over the plot area that takes the pointer
//   width()       the plot area's width
//   toVal(px)     the x value at a position
//   show([lo, hi] | null)  draw that range (null: all of it)
//   select([a, b] | null)  draw the drag selection between positions, or clear it

const DRAG_PX = 5;          // a smaller drag is a click

export const zoomGroup = () => new Set();

export function attachZoom(a, { group = null } = {}) {
  const el = a.el;
  const me = {
    // Show a range (null: all of it) on this chart and, unless told not to, the others in its group.
    set(r, quiet = false) {
      a.show(r);
      if (group && !quiet) for (const o of group) if (o !== me) o.set(r, true);
    },
  };
  if (group) group.add(me);
  const at = (e) => Math.max(0, Math.min(a.width(), e.clientX - el.getBoundingClientRect().left));

  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    drag = { from: at(e), to: at(e), id: e.pointerId };
    try { el.setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer tracks */ }
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.to = at(e);
    if (Math.abs(drag.to - drag.from) >= DRAG_PX) a.select([Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)]);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { from, to } = drag;
    drag = null;
    a.select(null);
    if (e.type === 'pointerup' && Math.abs(to - from) >= DRAG_PX) me.set([a.toVal(Math.min(from, to)), a.toVal(Math.max(from, to))]);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', (e) => { e.preventDefault(); me.set(null); });
  return me;
}

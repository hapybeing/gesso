// Shape snapping: recognise a freehand stroke as a line, arc, polyline, ellipse/circle, rectangle or polygon,
// then let the user adjust it (rubber-band while still holding the pen, handles after lifting).
// All tolerances are given in screen px and converted with the view scale, so recognition feels the same at any zoom.

export interface P { x: number; y: number; }
export type ShapeKind = 'line' | 'arc' | 'polyline' | 'ellipse' | 'circle' | 'rect' | 'square' | 'polygon';

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });

function segDist(p: P, a: P, b: P) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function pathLen(pts: P[]) { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; }

/** resample to n points evenly spaced by arc length */
export function resample(pts: P[], n: number): P[] {
  const L = pathLen(pts); if (L === 0 || pts.length < 2) return pts.slice();
  const step = L / (n - 1), out: P[] = [pts[0]];
  let acc = 0, i = 1, prev = pts[0];
  while (i < pts.length && out.length < n) {
    const d = dist(prev, pts[i]);
    if (acc + d >= step) {
      const t = (step - acc) / d;
      const q = { x: prev.x + (pts[i].x - prev.x) * t, y: prev.y + (pts[i].y - prev.y) * t };
      out.push(q); prev = q; acc = 0;
    } else { acc += d; prev = pts[i]; i++; }
  }
  while (out.length < n) out.push(pts[pts.length - 1]);
  return out;
}

/** Ramer–Douglas–Peucker simplification (indices kept) */
function rdp(pts: P[], eps: number): P[] {
  if (pts.length < 3) return pts.slice();
  let idx = 0, md = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > md) { md = d; idx = i; } }
  if (md <= eps) return [pts[0], pts[pts.length - 1]];
  const a = rdp(pts.slice(0, idx + 1), eps), b = rdp(pts.slice(idx), eps);
  return a.slice(0, -1).concat(b);
}

function circumcircle(a: P, b: P, c: P) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

/** A recognised, editable shape. Points are in document px. */
export class Shape {
  kind: ShapeKind;
  /** control points: line [a,b]; arc [a,mid,b]; polyline/polygon vertices; rect 4 corners; ellipse [centre] + ex */
  pts: P[];
  ex = { rx: 0, ry: 0, rot: 0 };
  constructor(kind: ShapeKind, pts: P[], ex?: { rx: number; ry: number; rot: number }) { this.kind = kind; this.pts = pts; if (ex) this.ex = { ...ex }; }
  clone() { const s = new Shape(this.kind, this.pts.map((p) => ({ ...p })), this.ex); s.endPoint = { ...this.endPoint }; return s; }
  get closed() { return this.kind === 'ellipse' || this.kind === 'circle' || this.kind === 'rect' || this.kind === 'square' || this.kind === 'polygon'; }
  get label() { return { line: 'Line', arc: 'Arc', polyline: 'Polyline', ellipse: 'Ellipse', circle: 'Circle', rect: 'Rectangle', square: 'Square', polygon: this.pts.length === 3 ? 'Triangle' : 'Polygon' }[this.kind]; }

  /** the path to stamp, densely sampled where curved */
  path(): P[] {
    const k = this.kind;
    if (k === 'line') return this.pts.slice(0, 2);
    if (k === 'polyline') return this.pts.slice();
    if (k === 'rect' || k === 'square' || k === 'polygon') return [...this.pts, this.pts[0], this.pts[1]]; // overlap one edge so the join is seamless
    if (k === 'ellipse' || k === 'circle') {
      const { rx, ry, rot } = this.ex, c = this.pts[0];
      const per = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
      const n = Math.max(48, Math.min(1440, Math.ceil(per / 2.5)));
      const out: P[] = [], cs = Math.cos(rot), sn = Math.sin(rot);
      for (let i = 0; i <= n + 2; i++) { // a little past 360° so the seam is covered
        const t = (i / n) * Math.PI * 2;
        const x = Math.cos(t) * rx, y = Math.sin(t) * ry;
        out.push({ x: c.x + x * cs - y * sn, y: c.y + x * sn + y * cs });
      }
      return out;
    }
    // arc through a, mid, b
    const [a, m, b] = this.pts;
    const cc = circumcircle(a, m, b);
    if (!cc || cc.r > 1e5) return [a, b];
    let a0 = Math.atan2(a.y - cc.y, a.x - cc.x), a1 = Math.atan2(b.y - cc.y, b.x - cc.x);
    const am = Math.atan2(m.y - cc.y, m.x - cc.x);
    const norm = (v: number) => { while (v < 0) v += Math.PI * 2; while (v >= Math.PI * 2) v -= Math.PI * 2; return v; };
    // choose the sweep direction that passes through the mid handle
    let sweep = norm(a1 - a0);
    if (norm(am - a0) > sweep) sweep = sweep - Math.PI * 2;
    const n = Math.max(16, Math.ceil((Math.abs(sweep) * cc.r) / 2.5));
    const out: P[] = [];
    for (let i = 0; i <= n; i++) { const t = a0 + (sweep * i) / n; out.push({ x: cc.x + Math.cos(t) * cc.r, y: cc.y + Math.sin(t) * cc.r }); }
    void a1;
    return out;
  }

  /** draggable handles (document px) */
  handles(): P[] {
    if (this.kind === 'ellipse' || this.kind === 'circle') {
      const { rx, ry, rot } = this.ex, c = this.pts[0], cs = Math.cos(rot), sn = Math.sin(rot);
      return [c, { x: c.x + rx * cs, y: c.y + rx * sn }, { x: c.x - ry * sn, y: c.y + ry * cs }, { x: c.x - rx * cs, y: c.y - rx * sn }, { x: c.x + ry * sn, y: c.y - ry * cs }];
    }
    return this.pts;
  }

  /** move handle i to p. constrain = the perfect variant (circle, square, 15° steps) */
  moveHandle(i: number, p: P, constrain = false) {
    const k = this.kind;
    if (k === 'ellipse' || k === 'circle') {
      const c = this.pts[0];
      if (i === 0) { this.pts[0] = { ...p }; return; }
      const d = sub(p, c), r = Math.hypot(d.x, d.y);
      const ang = Math.atan2(d.y, d.x);
      if (i === 1 || i === 3) { this.ex.rx = Math.max(1, r); this.ex.rot = i === 1 ? ang : ang + Math.PI; }
      else { this.ex.ry = Math.max(1, r); this.ex.rot = i === 2 ? ang - Math.PI / 2 : ang + Math.PI / 2; }
      if (k === 'circle' || constrain) { const m = i === 1 || i === 3 ? this.ex.rx : this.ex.ry; this.ex.rx = this.ex.ry = m; }
      return;
    }
    if (k === 'rect' || k === 'square') {
      // keep a true rectangle: the opposite corner stays, the rectangle keeps its orientation
      const o = this.pts[(i + 2) % 4];
      const ux = sub(this.pts[(i + 1) % 4], this.pts[(i + 2) % 4]), uy = sub(this.pts[(i + 3) % 4], this.pts[(i + 2) % 4]);
      const nu = (v: P) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
      const ax = nu(ux), ay = nu(uy);
      const d = sub(p, o);
      let w = d.x * ax.x + d.y * ax.y, hh = d.x * ay.x + d.y * ay.y;
      if (k === 'square' || constrain) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
      const P1 = { x: o.x + ax.x * w, y: o.y + ax.y * w }, P3 = { x: o.x + ay.x * hh, y: o.y + ay.y * hh };
      this.pts[i] = { x: o.x + ax.x * w + ay.x * hh, y: o.y + ax.y * w + ay.y * hh };
      this.pts[(i + 1) % 4] = P1; this.pts[(i + 3) % 4] = P3;
      return;
    }
    let q = { ...p };
    if (k === 'line' || k === 'polyline') {
      // gentle angle snapping to 15° steps (always when within 2°, forced with constrain)
      const ref = this.pts[i === 0 ? 1 : i - 1];
      const d = sub(q, ref), r = Math.hypot(d.x, d.y), a = Math.atan2(d.y, d.x);
      const step = Math.PI / 12, sa = Math.round(a / step) * step;
      if (constrain || Math.abs(sa - a) < (2 * Math.PI) / 180) q = { x: ref.x + Math.cos(sa) * r, y: ref.y + Math.sin(sa) * r };
    }
    this.pts[i] = q;
  }

  /** while the pen is still down after snapping: drag the shape's "end" with the pen */
  rubberBand(p: P, constrain: boolean, anchor: Shape) {
    const k = this.kind;
    if (k === 'line' || k === 'polyline' || k === 'arc') { this.moveHandle(this.pts.length - 1, p, constrain); if (k === 'arc') this.pts[1] = anchor.pts[1]; return; }
    if (k === 'ellipse' || k === 'circle') {
      // scale uniformly about the centre so the pen tracks the ellipse edge
      const c = anchor.pts[0], s0 = anchor.endPoint, d0 = dist(c, s0) || 1, d1 = dist(c, p);
      const f = d1 / d0;
      this.ex = { ...anchor.ex, rx: anchor.ex.rx * f, ry: anchor.ex.ry * f };
      if (constrain || k === 'circle') this.ex.rx = this.ex.ry = (this.ex.rx + this.ex.ry) / 2;
      return;
    }
    // polygons/rects: scale about the centroid
    const cx = anchor.pts.reduce((s, q) => s + q.x, 0) / anchor.pts.length, cy = anchor.pts.reduce((s, q) => s + q.y, 0) / anchor.pts.length;
    const d0 = dist({ x: cx, y: cy }, anchor.endPoint) || 1, f = dist({ x: cx, y: cy }, p) / d0;
    this.pts = anchor.pts.map((q) => ({ x: cx + (q.x - cx) * f, y: cy + (q.y - cy) * f }));
  }
  /** where the pen was when the shape snapped (set by recognise) */
  endPoint: P = { x: 0, y: 0 };

  /** turn into the "perfect" variant (second finger while holding) */
  perfect() {
    if (this.kind === 'ellipse') { this.kind = 'circle'; this.ex.rx = this.ex.ry = (this.ex.rx + this.ex.ry) / 2; }
    else if (this.kind === 'rect') { this.kind = 'square'; this.moveHandle(2, this.pts[2], true); }
    else if (this.kind === 'line') this.moveHandle(1, this.pts[1], true);
  }
}

/**
 * Recognise a stroke. tol = screen-px → doc-px factor (1 / view scale).
 * Returns null when nothing fits well (the stroke stays freehand).
 */
export function recognise(raw: P[], tol: number): Shape | null {
  const pts = raw.filter((p, i) => i === 0 || dist(p, raw[i - 1]) > 0.25 * tol);
  if (pts.length < 4) return null;
  const L = pathLen(pts);
  if (L < 24 * tol) return null;
  const a = pts[0], b = pts[pts.length - 1], chord = dist(a, b);
  const R = resample(pts, 96);
  const end = { ...b };
  const done = (s: Shape) => { s.endPoint = end; return s; };

  const closed = chord < Math.max(0.2 * L, 18 * tol) && L > 60 * tol;
  if (!closed) {
    // line
    const lineErr = Math.max(...R.map((p) => segDist(p, a, b)));
    if (lineErr < Math.max(0.045 * chord, 4 * tol) && chord > 0.85 * L) {
      const s = new Shape('line', [{ ...a }, { ...b }]);
      s.moveHandle(1, b); // apply the gentle 15° snap
      return done(s);
    }
    // polyline (corners)
    const eps = Math.max(0.035 * L, 5 * tol);
    const simp = rdp(R, eps);
    // arc: circle through start, middle, end
    const mid = R[48];
    const cc = circumcircle(a, mid, b);
    if (cc && cc.r < 20 * L) {
      const arcErr = Math.max(...R.map((p) => Math.abs(dist(p, cc) - cc.r)));
      const sharp = simp.length > 2 && simp.slice(1, -1).some((v, i) => {
        const p0 = simp[i], p2 = simp[i + 2];
        const a1 = Math.atan2(v.y - p0.y, v.x - p0.x), a2 = Math.atan2(p2.y - v.y, p2.x - v.x);
        let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d;
        return d > 0.9; // > ~50° turn = a corner, not a curve
      });
      if (!sharp && arcErr < Math.max(0.05 * cc.r, 4 * tol)) return done(new Shape('arc', [{ ...a }, { ...mid }, { ...b }]));
    }
    if (simp.length >= 3 && simp.length <= 8) {
      // a polyline needs real corners at every vertex and straight runs between them; a wavy curve is not one
      const corners = simp.slice(1, -1).every((v, i) => {
        const p0 = simp[i], p2 = simp[i + 2];
        const a1 = Math.atan2(v.y - p0.y, v.x - p0.x), a2 = Math.atan2(p2.y - v.y, p2.x - v.x);
        let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d;
        return d > 0.6;
      });
      const err = Math.max(...R.map((p) => Math.min(...simp.slice(1).map((q, i) => segDist(p, simp[i], q)))));
      const meanSeg = L / (simp.length - 1);
      if (corners && err <= Math.max(0.06 * meanSeg, 4.5 * tol)) return done(new Shape('polyline', simp.map((p) => ({ ...p }))));
    }
    return null;
  }

  // ---- closed shapes
  const cx = R.reduce((s, p) => s + p.x, 0) / R.length, cy = R.reduce((s, p) => s + p.y, 0) / R.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of R) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  sxx /= R.length; syy /= R.length; sxy /= R.length;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  const rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // refine radii from the actual points along each axis (moments under-estimate for uneven sampling)
  const cs = Math.cos(rot), sn = Math.sin(rot);
  let rx = Math.sqrt(2 * l1), ry = Math.sqrt(2 * Math.max(l2, 1e-6));
  {
    let mx = 0, my = 0;
    for (const p of R) { const dx = p.x - cx, dy = p.y - cy; mx = Math.max(mx, Math.abs(dx * cs + dy * sn)); my = Math.max(my, Math.abs(-dx * sn + dy * cs)); }
    rx = (rx + mx) / 2; ry = (ry + my) / 2;
  }
  const ellErr = R.reduce((s, p) => {
    const dx = p.x - cx, dy = p.y - cy, u = dx * cs + dy * sn, v = -dx * sn + dy * cs;
    return s + Math.abs(Math.hypot(u / rx, v / ry) - 1);
  }, 0) / R.length;

  // polygon candidate: corners via closed RDP (split at the point farthest from the start)
  let far = 0, fd = 0; R.forEach((p, i) => { const d = dist(p, R[0]); if (d > fd) { fd = d; far = i; } });
  const eps = Math.max(0.045 * L, 5 * tol);
  const loop = [...R, R[0]];
  let poly = rdp(loop.slice(0, far + 1), eps).concat(rdp(loop.slice(far), eps).slice(1));
  poly = poly.slice(0, -1); // drop the repeated start
  // merge near-collinear vertices
  const corners = poly.filter((v, i) => {
    const p0 = poly[(i - 1 + poly.length) % poly.length], p2 = poly[(i + 1) % poly.length];
    const a1 = Math.atan2(v.y - p0.y, v.x - p0.x), a2 = Math.atan2(p2.y - v.y, p2.x - v.x);
    let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d;
    return d > 0.45;
  });
  const polyErr = corners.length >= 3 ? R.reduce((s, p) => s + Math.min(...corners.map((q, i) => segDist(p, q, corners[(i + 1) % corners.length]))), 0) / R.length / Math.sqrt(rx * ry) : Infinity;

  if (corners.length >= 3 && corners.length <= 6 && polyErr < ellErr * 0.8 && polyErr < 0.06) {
    if (corners.length === 4) {
      // rectangle if all corners are near 90°
      const right = corners.every((v, i) => {
        const p0 = corners[(i + 3) % 4], p2 = corners[(i + 1) % 4];
        const u = sub(p0, v), w = sub(p2, v);
        const c = (u.x * w.x + u.y * w.y) / ((Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y)) || 1);
        return Math.abs(c) < 0.3; // within ~17° of square
      });
      if (right) {
        // oriented best-fit rectangle: average edge direction, extents from the corners
        let ang = 0, wsum = 0;
        for (let i = 0; i < 4; i++) {
          const e = sub(corners[(i + 1) % 4], corners[i]); const l = Math.hypot(e.x, e.y);
          let t = Math.atan2(e.y, e.x); t = ((t % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
          if (t > Math.PI / 4) t -= Math.PI / 2;
          ang += t * l; wsum += l;
        }
        ang /= wsum || 1;
        if (Math.abs(ang) < (3 * Math.PI) / 180) ang = 0; // axis-aligned when nearly so
        const ux = { x: Math.cos(ang), y: Math.sin(ang) }, uy = { x: -Math.sin(ang), y: Math.cos(ang) };
        const pc = { x: corners.reduce((s, q) => s + q.x, 0) / 4, y: corners.reduce((s, q) => s + q.y, 0) / 4 };
        const hw = corners.reduce((s, q) => s + Math.abs((q.x - pc.x) * ux.x + (q.y - pc.y) * ux.y), 0) / 4;
        const hh = corners.reduce((s, q) => s + Math.abs((q.x - pc.x) * uy.x + (q.y - pc.y) * uy.y), 0) / 4;
        const C = (sx: number, sy: number) => ({ x: pc.x + ux.x * hw * sx + uy.x * hh * sy, y: pc.y + ux.y * hw * sx + uy.y * hh * sy });
        const sq = Math.abs(hw - hh) / Math.max(hw, hh) < 0.06;
        const s = new Shape(sq ? 'square' : 'rect', [C(-1, -1), C(1, -1), C(1, 1), C(-1, 1)]);
        if (sq) s.moveHandle(2, s.pts[2], true);
        return done(s);
      }
    }
    return done(new Shape('polygon', corners.map((p) => ({ ...p }))));
  }
  if (ellErr < 0.11) {
    const round = ry / rx > 0.9;
    const r0 = round ? (rx + ry) / 2 : 0;
    return done(new Shape(round ? 'circle' : 'ellipse', [{ x: cx, y: cy }], { rx: round ? r0 : rx, ry: round ? r0 : ry, rot: round ? 0 : rot }));
  }
  return null;
}

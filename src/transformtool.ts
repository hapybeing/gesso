// Transform box for placing an imported image (and, later, moving layer content / selections).
// One finger or the pen: drag inside to move, corners to scale, edge handles to stretch (Free mode),
// the knob to rotate. Two fingers anywhere: move + pinch-scale + twist together.
// Snapping: centre to the canvas centre/edges, rotation to 15° steps, all within a few screen px / degrees.
import type { Engine, Layer } from './engine';
import type { Target } from './gl';
import type { Grab } from './input';

interface Xf { cx: number; cy: number; sx: number; sy: number; rot: number; }
interface P { x: number; y: number; }
type Handle = { kind: 'corner' | 'edge'; i: number } | { kind: 'rot' } | { kind: 'move' } | { kind: 'cp'; i: number } | { kind: 'warp'; u: number; v: number } | null;
export type XfMode = 'uniform' | 'free' | 'distort' | 'warp';

// ---- geometry helpers
/** projective map of the unit square onto quad q (TL, TR, BR, BL); null when the quad is not convex */
export function homography(q: P[]): ((u: number, v: number) => P) | null {
  for (let i = 0, sgn = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-6) return null;
    if (sgn && Math.sign(cr) !== sgn) return null;
    sgn = Math.sign(cr);
  }
  const [q0, q1, q2, q3] = q;
  const sx = q0.x - q1.x + q2.x - q3.x, sy = q0.y - q1.y + q2.y - q3.y;
  let a, b, c, d, e, f, g = 0, hh = 0;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = q1.x - q0.x; b = q3.x - q0.x; c = q0.x; d = q1.y - q0.y; e = q3.y - q0.y; f = q0.y;
  } else {
    const dx1 = q1.x - q2.x, dx2 = q3.x - q2.x, dy1 = q1.y - q2.y, dy2 = q3.y - q2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den; hh = (dx1 * sy - sx * dy1) / den;
    a = q1.x - q0.x + g * q1.x; b = q3.x - q0.x + hh * q3.x; c = q0.x;
    d = q1.y - q0.y + g * q1.y; e = q3.y - q0.y + hh * q3.y; f = q0.y;
  }
  return (u, v) => { const w = g * u + hh * v + 1; return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w }; };
}
const bern = (t: number) => { const s = 1 - t; return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]; };
/** bicubic Bézier patch, control points row-major (v rows of u) */
export function bezier(cp: P[], u: number, v: number): P {
  const bu = bern(u), bv = bern(v); let x = 0, y = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const w = bu[i] * bv[j]; x += cp[j * 4 + i].x * w; y += cp[j * 4 + i].y * w; }
  return { x, y };
}

export interface TransformHost {
  engine: Engine;
  overlayChanged(): void;
  done(committed: boolean): void;
  toast(msg: string): void;
}

export class TransformTool implements Grab {
  xf: Xf;
  private start: Xf;
  mode: XfMode = 'uniform';
  get uniform() { return this.mode === 'uniform'; }
  set uniform(v: boolean) { this.setMode(v ? 'uniform' : 'free'); }
  /** distort: corners TL, TR, BR, BL in doc px */
  quad: P[] = [];
  /** warp: 4×4 Bézier control points in doc px */
  grid: P[] = [];
  private grabPts: P[] = [];
  filter: 'smooth' | 'sharp' = 'smooth';
  private pointers = new Map<number, { x: number; y: number }>();
  private handle: Handle = null;
  private grabDoc = { x: 0, y: 0 };
  private grabXf: Xf;
  private pinch: { a: number; b: number; p0: [{ x: number; y: number }, { x: number; y: number }]; xf: Xf } | null = null;
  private snapLines: { x?: number; y?: number; rot?: boolean } = {};
  private bar: HTMLElement;
  private raf = 0;

  constructor(private host: TransformHost, readonly layer: Layer, readonly src: Target, private purpose: 'insert' | 'replace', private onFinish: (commit: boolean, tool: TransformTool) => void, init?: Xf, private keep: Target | null = null) {
    const e = host.engine;
    if (init) this.xf = { ...init };
    else {
      // fit inside 90 % of the canvas when larger, otherwise 1:1, centred
      const k = Math.min(1, (e.w * 0.9) / src.w, (e.h * 0.9) / src.h);
      this.xf = { cx: e.w / 2, cy: e.h / 2, sx: k, sy: k, rot: 0 };
    }
    this.start = { ...this.xf };
    this.grabXf = { ...this.xf };
    this.bar = document.createElement('div');
    this.bar.id = 'xfbar';
    document.body.append(this.bar);
    this.renderBar();
    this.apply();
  }

  /** doc = M * src px */
  matrix(xf = this.xf): number[] {
    const c = Math.cos(xf.rot), s = Math.sin(xf.rot);
    const a = c * xf.sx, b = s * xf.sx, cc = -s * xf.sy, d = c * xf.sy;
    const hw = this.src.w / 2, hh = this.src.h / 2;
    return [a, b, cc, d, xf.cx - a * hw - cc * hh, xf.cy - b * hw - d * hh];
  }
  /** corners in doc px: TL, TR, BR, BL (source orientation) */
  corners(xf = this.xf) {
    const m = this.matrix(xf), W = this.src.w, H = this.src.h;
    return [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }));
  }

  private apply() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => { this.renderTo(this.layer.target, this.src, this.keep); this.layer.version++; });
    this.host.overlayChanged();
  }

  /** the current mapping from source uv (0..1) to doc px */
  mapping(): (u: number, v: number) => P {
    if (this.mode === 'distort') { const hm = homography(this.quad); if (hm) return hm; }
    if (this.mode === 'warp') { const g = this.grid; return (u, v) => bezier(g, u, v); }
    const m = this.matrix(), W = this.src.w, H = this.src.h;
    return (u, v) => ({ x: m[0] * u * W + m[2] * v * H + m[4], y: m[1] * u * W + m[3] * v * H + m[5] });
  }
  get affine() { return this.mode === 'uniform' || this.mode === 'free'; }
  /** draw src through the current geometry into dst (also used for the selection mask on commit) */
  renderTo(dst: Target, src: Target, keep: Target | null = null, filter = this.filter) {
    const e = this.host.engine;
    if (this.affine) { e.renderTransformed(dst, src, this.matrix(), filter, keep); return; }
    const f = this.mapping(), N = 32, W = this.src.w, H = this.src.h;
    // local scale range (dest px per source px) from the mesh cells, for filter choice and the AA margin
    let minS = Infinity, maxS = 0;
    const pts: P[] = [];
    for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) pts.push(f(i / 8, j / 8));
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const a = pts[j * 9 + i], b = pts[j * 9 + i + 1], c = pts[(j + 1) * 9 + i];
      const su = Math.hypot(b.x - a.x, b.y - a.y) / (W / 8), sv = Math.hypot(c.x - a.x, c.y - a.y) / (H / 8);
      minS = Math.min(minS, su, sv); maxS = Math.max(maxS, su, sv);
    }
    const gu = 1.5 / Math.max(1e-3, minS) / W, gv = 1.5 / Math.max(1e-3, minS) / H;
    const v = new Float32Array((N + 1) * (N + 1) * 4);
    let k = 0;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const u = -gu + (1 + 2 * gu) * (i / N), w = -gv + (1 + 2 * gv) * (j / N);
      const p = f(u, w);
      v[k++] = p.x; v[k++] = p.y; v[k++] = u; v[k++] = w;
    }
    e.renderMesh(dst, src, v, N, filter, minS, keep);
  }

  setMode(m: XfMode) {
    if (m === this.mode) return;
    const from = this.mode;
    const f = this.mapping();
    if (m === 'distort') this.quad = from === 'warp' ? [this.grid[0], this.grid[3], this.grid[15], this.grid[12]].map((p) => ({ ...p })) : [f(0, 0), f(1, 0), f(1, 1), f(0, 1)];
    else if (m === 'warp') { this.grid = []; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) this.grid.push(f(i / 3, j / 3)); }
    else if (!this.affine || from === 'distort' || from === 'warp') {
      // back to a box: the closest rectangle through the current top-left/top-right/bottom-left corners
      const tl = f(0, 0), tr = f(1, 0), bl = f(0, 1), br = f(1, 1);
      const rot = Math.atan2(tr.y - tl.y, tr.x - tl.x);
      const sx = Math.hypot(tr.x - tl.x, tr.y - tl.y) / this.src.w, sy = Math.hypot(bl.x - tl.x, bl.y - tl.y) / this.src.h;
      this.xf = { cx: (tl.x + tr.x + bl.x + br.x) / 4, cy: (tl.y + tr.y + bl.y + br.y) / 4, sx: Math.sign(this.xf.sx) * sx, sy: Math.sign(this.xf.sy) * sy, rot: Math.sign(this.xf.sx) < 0 ? rot + Math.PI : rot };
      if (m === 'uniform') { const k = Math.sqrt(Math.abs(this.xf.sx * this.xf.sy)); this.xf.sx = Math.sign(this.xf.sx) * k; this.xf.sy = Math.sign(this.xf.sy) * k; }
    }
    this.mode = m;
    this.renderBar();
    this.apply();
  }

  // ---------------------------------------------------------------- pointer handling (Grab)
  private hit(sx: number, sy: number): Handle {
    const e = this.host.engine;
    const R = 30;
    if (this.mode === 'warp') {
      let best = -1, bd = R;
      this.grid.forEach((p, i) => { const q = e.docToScreen(p.x, p.y); const d = Math.hypot(sx - q.x, sy - q.y) - ((i === 0 || i === 3 || i === 12 || i === 15) ? 4 : 0); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) return { kind: 'cp', i: best };
      const uv = this.uvAt(e.screenToDoc(sx, sy));
      return uv ? { kind: 'warp', u: uv.u, v: uv.v } : { kind: 'move' };
    }
    if (this.mode === 'distort') {
      const cs = this.quad.map((p) => e.docToScreen(p.x, p.y));
      for (let i = 0; i < 4; i++) if (Math.hypot(sx - cs[i].x, sy - cs[i].y) < R) return { kind: 'corner', i };
      for (let i = 0; i < 4; i++) { const a = cs[i], b = cs[(i + 1) % 4]; if (Math.hypot(sx - (a.x + b.x) / 2, sy - (a.y + b.y) / 2) < R) return { kind: 'edge', i }; }
      return { kind: 'move' };
    }
    const cs = this.corners().map((p) => e.docToScreen(p.x, p.y));
    const rk = this.rotKnob();
    if (Math.hypot(sx - rk.x, sy - rk.y) < R) return { kind: 'rot' };
    for (let i = 0; i < 4; i++) if (Math.hypot(sx - cs[i].x, sy - cs[i].y) < R) return { kind: 'corner', i };
    for (let i = 0; i < 4; i++) {
      const a = cs[i], b = cs[(i + 1) % 4];
      if (Math.hypot(sx - (a.x + b.x) / 2, sy - (a.y + b.y) / 2) < R) return { kind: 'edge', i };
    }
    // anywhere inside the box (or near it) moves
    return { kind: 'move' };
  }
  private rotKnob() {
    const e = this.host.engine;
    const cs = this.corners().map((p) => e.docToScreen(p.x, p.y));
    const mx = (cs[0].x + cs[1].x) / 2, my = (cs[0].y + cs[1].y) / 2;
    const cx = (cs[0].x + cs[2].x) / 2, cy = (cs[0].y + cs[2].y) / 2;
    const dx = mx - cx, dy = my - cy, L = Math.hypot(dx, dy) || 1;
    return { x: mx + (dx / L) * 44, y: my + (dy / L) * 44 };
  }

  /** source uv under a doc point (inside the warped patch), by nearest sample + Newton refinement */
  private uvAt(p: P): { u: number; v: number } | null {
    const f = this.mapping(); const N = 24;
    let bu = 0, bv = 0, bd = Infinity;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { const q = f(i / N, j / N); const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (d < bd) { bd = d; bu = i / N; bv = j / N; } }
    for (let it = 0; it < 8; it++) {
      const q = f(bu, bv), h = 1e-3;
      const qu = f(bu + h, bv), qv = f(bu, bv + h);
      const a = (qu.x - q.x) / h, b = (qv.x - q.x) / h, c = (qu.y - q.y) / h, d = (qv.y - q.y) / h;
      const det = a * d - b * c; if (Math.abs(det) < 1e-9) break;
      const ex = p.x - q.x, ey = p.y - q.y;
      bu += (d * ex - b * ey) / det; bv += (-c * ex + a * ey) / det;
    }
    const q = f(bu, bv);
    if (bu < -0.02 || bu > 1.02 || bv < -0.02 || bv > 1.02 || Math.hypot(q.x - p.x, q.y - p.y) > 2) return null;
    return { u: Math.max(0, Math.min(1, bu)), v: Math.max(0, Math.min(1, bv)) };
  }

  down(e: PointerEvent, x: number, y: number) {
    this.pointers.set(e.pointerId, { x, y });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.keys()];
      this.handle = null;
      this.pinch = { a, b, p0: [{ ...this.pointers.get(a)! }, { ...this.pointers.get(b)! }], xf: { ...this.xf } };
      this.grabPts = (this.mode === 'warp' ? this.grid : this.quad).map((p) => ({ ...p }));
      return;
    }
    if (this.pointers.size > 2) return;
    this.handle = this.hit(x, y);
    this.grabDoc = this.host.engine.screenToDoc(x, y);
    this.grabXf = { ...this.xf };
    this.grabPts = (this.mode === 'warp' ? this.grid : this.quad).map((p) => ({ ...p }));
  }

  move(e: PointerEvent, x: number, y: number) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x, y });
    const eng = this.host.engine;
    if (this.pinch) {
      const pa = this.pointers.get(this.pinch.a), pb = this.pointers.get(this.pinch.b);
      if (!pa || !pb) return;
      const [q0, q1] = this.pinch.p0;
      const A0 = eng.screenToDoc(q0.x, q0.y), B0 = eng.screenToDoc(q1.x, q1.y), A1 = eng.screenToDoc(pa.x, pa.y), B1 = eng.screenToDoc(pb.x, pb.y);
      const f = Math.hypot(B1.x - A1.x, B1.y - A1.y) / (Math.hypot(B0.x - A0.x, B0.y - A0.y) || 1);
      const dr = Math.atan2(B1.y - A1.y, B1.x - A1.x) - Math.atan2(B0.y - A0.y, B0.x - A0.x);
      const m0 = { x: (A0.x + B0.x) / 2, y: (A0.y + B0.y) / 2 }, m1 = { x: (A1.x + B1.x) / 2, y: (A1.y + B1.y) / 2 };
      const s0 = this.pinch.xf, c = Math.cos(dr), s = Math.sin(dr);
      if (!this.affine) {
        const pts = this.grabPts.map((q) => { const vx = (q.x - m0.x) * f, vy = (q.y - m0.y) * f; return { x: m1.x + vx * c - vy * s, y: m1.y + vx * s + vy * c }; });
        if (this.mode === 'warp') this.grid = pts; else this.quad = pts;
        this.apply();
        return;
      }
      const vx = (s0.cx - m0.x) * f, vy = (s0.cy - m0.y) * f;
      this.xf = { cx: m1.x + vx * c - vy * s, cy: m1.y + vx * s + vy * c, sx: s0.sx * f, sy: s0.sy * f, rot: this.snapRot(s0.rot + dr) };
      this.apply();
      return;
    }
    const h = this.handle;
    if (!h) return;
    const p = eng.screenToDoc(x, y);
    if (!this.affine) { this.moveDeform(h, p); this.apply(); return; }
    const g = this.grabXf;
    const c = Math.cos(g.rot), s = Math.sin(g.rot);
    // pointer in the box's local (unrotated, unscaled-axis) frame relative to its centre
    const toLocal = (q: { x: number; y: number }) => ({ u: (q.x - g.cx) * c + (q.y - g.cy) * s, v: -(q.x - g.cx) * s + (q.y - g.cy) * c });
    const W = this.src.w, H = this.src.h;
    if (h.kind === 'move') {
      let cx = g.cx + p.x - this.grabDoc.x, cy = g.cy + p.y - this.grabDoc.y;
      const tol = 8 / eng.view.scale;
      this.snapLines = {};
      for (const t of [eng.w / 2, 0, eng.w]) if (Math.abs(cx - t) < tol) { cx = t; this.snapLines.x = t; }
      for (const t of [eng.h / 2, 0, eng.h]) if (Math.abs(cy - t) < tol) { cy = t; this.snapLines.y = t; }
      this.xf = { ...g, cx, cy };
    } else if (h.kind === 'rot') {
      const a0 = Math.atan2(this.grabDoc.y - g.cy, this.grabDoc.x - g.cx), a1 = Math.atan2(p.y - g.cy, p.x - g.cx);
      this.xf = { ...g, rot: this.snapRot(g.rot + a1 - a0) };
    } else if (h.kind === 'corner' || h.kind === 'edge') {
      // corners: TL(-,-) TR(+,-) BR(+,+) BL(-,+); edges: top, right, bottom, left
      const sgn = h.kind === 'corner' ? [[-1, -1], [1, -1], [1, 1], [-1, 1]][h.i] : [[0, -1], [1, 0], [0, 1], [-1, 0]][h.i];
      const hw = (W / 2) * g.sx, hh = (H / 2) * g.sy;
      const opp = { u: -sgn[0] * hw, v: -sgn[1] * hh }; // the fixed opposite point (local)
      const q = toLocal(p);
      let nsx = g.sx, nsy = g.sy;
      if (sgn[0]) nsx = (q.u - opp.u) / (sgn[0] * W);
      if (sgn[1]) nsy = (q.v - opp.v) / (sgn[1] * H);
      if (h.kind === 'corner' && this.uniform) {
        // uniform: project onto the diagonal so the aspect ratio stays
        const k = ((q.u - opp.u) * sgn[0] * W * g.sx + (q.v - opp.v) * sgn[1] * H * g.sy) / (W * W * g.sx * g.sx + H * H * g.sy * g.sy);
        nsx = g.sx * k; nsy = g.sy * k;
        // magnetic 100 %: snap when within 2 %
        const mag = Math.abs(nsx);
        if (Math.abs(mag - 1) < 0.02) { const f = 1 / mag; nsx *= f; nsy *= f; }
      } else if (h.kind === 'edge' && this.uniform) {
        const k = sgn[0] ? nsx / g.sx : nsy / g.sy; nsx = g.sx * k; nsy = g.sy * k;
      }
      const minS = 2 / Math.max(W, H);
      if (Math.abs(nsx) < minS) nsx = Math.sign(nsx || 1) * minS;
      if (Math.abs(nsy) < minS) nsy = Math.sign(nsy || 1) * minS;
      // new centre: the opposite corner/edge stays put along each dragged axis
      const ccu = sgn[0] ? opp.u + (sgn[0] * W * nsx) / 2 : 0, ccv = sgn[1] ? opp.v + (sgn[1] * H * nsy) / 2 : 0;
      this.xf = { sx: nsx, sy: nsy, rot: g.rot, cx: g.cx + ccu * c - ccv * s, cy: g.cy + ccu * s + ccv * c };
    }
    this.apply();
  }

  /** distort / warp drags */
  private moveDeform(h: NonNullable<Handle>, p: P) {
    const dx = p.x - this.grabDoc.x, dy = p.y - this.grabDoc.y;
    const G = this.grabPts;
    const shifted = (idx: number[]) => G.map((q, i) => (idx.includes(i) ? { x: q.x + dx, y: q.y + dy } : { ...q }));
    if (this.mode === 'distort') {
      let next: P[];
      if (h.kind === 'corner') next = shifted([h.i]);
      else if (h.kind === 'edge') next = shifted([h.i, (h.i + 1) % 4]);
      else next = shifted([0, 1, 2, 3]);
      if (homography(next)) this.quad = next; // refuse folds: the quad must stay convex
      return;
    }
    if (h.kind === 'cp') {
      // a corner drags its two neighbouring tangent handles along so the local shape is kept
      const nb: Record<number, number[]> = { 0: [0, 1, 4, 5], 3: [3, 2, 7, 6], 12: [12, 13, 8, 9], 15: [15, 14, 11, 10] };
      this.grid = shifted(nb[h.i] || [h.i]);
    } else if (h.kind === 'warp') {
      // drag the surface itself: least-change update of the control net that moves S(u,v) exactly with the pointer
      const bu = bern(h.u), bv = bern(h.v);
      let s2 = 0; const w: number[] = [];
      // the four corners stay pinned (only the 12 other control points move), as when pushing a sheet in its frame
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const corner = (i === 0 || i === 3) && (j === 0 || j === 3); const b = corner ? 0 : bu[i] * bv[j]; w.push(b); s2 += b * b; }
      if (s2 < 1e-9) return;
      this.grid = G.map((q, i) => ({ x: q.x + (dx * w[i]) / s2, y: q.y + (dy * w[i]) / s2 }));
    } else this.grid = shifted(G.map((_, i) => i));
  }

  up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pinch && this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) { this.handle = null; this.snapLines = {}; this.host.overlayChanged(); }
    else if (this.pointers.size === 1) {
      // continue with the remaining finger as a move
      const [id] = [...this.pointers.keys()]; const q = this.pointers.get(id)!;
      this.handle = { kind: 'move' }; this.grabDoc = this.host.engine.screenToDoc(q.x, q.y); this.grabXf = { ...this.xf };
    }
  }

  private snapRot(r: number) {
    const st = Math.PI / 12, sr = Math.round(r / st) * st;
    const on = Math.abs(sr - r) < (2.5 * Math.PI) / 180;
    this.snapLines.rot = on;
    return on ? sr : r;
  }

  // ---------------------------------------------------------------- actions
  flipH() { this.xf.sx = -this.xf.sx; this.apply(); }
  flipV() { this.xf.sy = -this.xf.sy; this.apply(); }
  rotate90() { this.xf.rot = this.snapRot(this.xf.rot + Math.PI / 2); this.apply(); }
  fit() {
    const e = this.host.engine;
    const cs = Math.abs(Math.cos(this.xf.rot)), sn = Math.abs(Math.sin(this.xf.rot));
    const bw = this.src.w * cs + this.src.h * sn, bh = this.src.w * sn + this.src.h * cs;
    const k = Math.min(e.w / bw, e.h / bh);
    this.xf = { ...this.xf, cx: e.w / 2, cy: e.h / 2, sx: Math.sign(this.xf.sx) * k, sy: Math.sign(this.xf.sy) * k };
    this.apply();
  }
  reset() {
    this.xf = { ...this.start };
    const m = this.mode; this.mode = 'free';
    if (m === 'distort' || m === 'warp') this.setMode(m); else this.mode = m;
    this.apply();
  }

  private finished = false;
  finish(commit: boolean) {
    if (this.finished) return;
    this.finished = true;
    cancelAnimationFrame(this.raf);
    if (commit) { this.renderTo(this.layer.target, this.src, this.keep); this.layer.version++; }
    this.bar.remove();
    this.host.done(commit);
    this.onFinish(commit, this);
  }

  private renderBar() {
    const b = this.bar;
    b.innerHTML = '';
    const btn = (label: string, fn: () => void, cls = 'chip', on = false) => { const x = document.createElement('button'); x.className = cls + (on ? ' on' : ''); x.textContent = label; x.onclick = () => { fn(); this.renderBar(); }; return x; };
    const grp = (...k: HTMLElement[]) => { const d = document.createElement('div'); d.className = 'chips'; d.append(...k); return d; };
    const modes: [XfMode, string][] = [['uniform', 'Uniform'], ['free', 'Free'], ['distort', 'Distort'], ['warp', 'Warp']];
    b.append(
      grp(...modes.map(([m, l]) => btn(l, () => this.setMode(m), 'chip', this.mode === m))),
      this.affine ? grp(btn('Flip ↔', () => this.flipH()), btn('Flip ↕', () => this.flipV()), btn('Rotate 90°', () => this.rotate90()), btn('Fit', () => this.fit()), btn('Reset', () => this.reset()))
        : grp(btn('Reset', () => this.reset())),
      grp(btn('Smooth', () => { this.filter = 'smooth'; this.apply(); }, 'chip', this.filter === 'smooth'), btn('Sharp', () => { this.filter = 'sharp'; this.apply(); }, 'chip', this.filter === 'sharp')),
      grp(btn('Cancel', () => this.finish(false), 'btn ghost small'), btn('Done', () => this.finish(true), 'btn small')),
    );
    void this.purpose;
  }

  drawOverlay(g: CanvasRenderingContext2D) {
    if (!this.affine) { this.drawDeformOverlay(g); return; }
    const e = this.host.engine;
    const cs = this.corners().map((p) => e.docToScreen(p.x, p.y));
    // snap guides
    g.strokeStyle = 'rgba(232,165,75,.9)'; g.lineWidth = 1; g.setLineDash([6, 4]);
    if (this.snapLines.x !== undefined) { const a = e.docToScreen(this.snapLines.x, 0), b = e.docToScreen(this.snapLines.x, e.h); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    if (this.snapLines.y !== undefined) { const a = e.docToScreen(0, this.snapLines.y), b = e.docToScreen(e.w, this.snapLines.y); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
    g.setLineDash([]);
    // box
    g.beginPath(); cs.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath();
    g.strokeStyle = 'rgba(20,18,17,.6)'; g.lineWidth = 3; g.stroke();
    g.strokeStyle = '#50aaff'; g.lineWidth = 1.5; g.stroke();
    // rotation knob
    const rk = this.rotKnob(), tm = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
    g.beginPath(); g.moveTo(tm.x, tm.y); g.lineTo(rk.x, rk.y); g.strokeStyle = '#50aaff'; g.lineWidth = 1.5; g.stroke();
    const dot = (p: { x: number; y: number }, r: number, fill: string) => { g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); g.lineWidth = 2.5; g.strokeStyle = 'rgba(20,18,17,.85)'; g.stroke(); };
    dot(rk, 9, this.snapLines.rot ? '#e8a54b' : '#ffffff');
    // live readout while manipulating
    if (this.handle || this.pinch) {
      const deg = ((this.xf.rot * 180) / Math.PI) % 360;
      const txt = `${Math.round(Math.abs(this.xf.sx) * 100)}%${Math.abs(this.xf.sx - this.xf.sy) > 1e-3 && Math.abs(Math.abs(this.xf.sx) - Math.abs(this.xf.sy)) > 1e-3 ? ' × ' + Math.round(Math.abs(this.xf.sy) * 100) + '%' : ''} · ${Math.round(deg)}°`;
      g.font = '600 13px system-ui, sans-serif';
      const w = g.measureText(txt).width + 16;
      g.fillStyle = 'rgba(32,29,27,.92)'; g.beginPath(); g.roundRect(rk.x - w / 2, rk.y - 40, w, 24, 12); g.fill();
      g.fillStyle = '#f1e9dd'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, rk.x, rk.y - 28);
    }
    for (let i = 0; i < 4; i++) {
      dot(cs[i], 9, '#ffffff');
      if (!this.uniform) { const a = cs[i], b = cs[(i + 1) % 4]; dot({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 6.5, '#ffffff'); }
    }
  }

  private drawDeformOverlay(g: CanvasRenderingContext2D) {
    const e = this.host.engine, f = this.mapping();
    const S = (p: P) => e.docToScreen(p.x, p.y);
    const curve = (fn: (t: number) => P) => { g.beginPath(); for (let k = 0; k <= 32; k++) { const q = S(fn(k / 32)); if (k) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); } };
    const dot = (p: P, r: number, fill: string) => { g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); g.lineWidth = 2.5; g.strokeStyle = 'rgba(20,18,17,.85)'; g.stroke(); };
    const lines = this.mode === 'warp' ? [0, 1 / 3, 2 / 3, 1] : [0, 1];
    for (const pass of [0, 1]) {
      g.strokeStyle = pass ? '#50aaff' : 'rgba(20,18,17,.6)'; g.lineWidth = pass ? 1.3 : 3;
      for (const t of lines) { curve((s) => f(s, t)); g.stroke(); curve((s) => f(t, s)); g.stroke(); }
    }
    if (this.mode === 'warp') {
      // control net, faint
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.setLineDash([3, 3]);
      for (let j = 0; j < 4; j++) { g.beginPath(); for (let i = 0; i < 4; i++) { const q = S(this.grid[j * 4 + i]); if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); } g.stroke(); }
      for (let i = 0; i < 4; i++) { g.beginPath(); for (let j = 0; j < 4; j++) { const q = S(this.grid[j * 4 + i]); if (j) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); } g.stroke(); }
      g.setLineDash([]);
      this.grid.forEach((p, i) => dot(S(p), i === 0 || i === 3 || i === 12 || i === 15 ? 9 : 6, '#ffffff'));
    } else {
      const cs = this.quad.map(S);
      for (let i = 0; i < 4; i++) { const a = cs[i], b = cs[(i + 1) % 4]; dot({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 6, '#ffffff'); }
      cs.forEach((p) => dot(p, 9, '#ffffff'));
    }
  }
}

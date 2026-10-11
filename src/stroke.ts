import { Brush, rng } from './brushes';
import type { Dab } from './engine';

/** One pointer sample in document space. t = timestamp in ms (0 if unknown). */
export interface Sample { x: number; y: number; p: number; tx: number; ty: number; t?: number; }
interface DabX extends Dab { dist: number; }
interface Pt { x: number; y: number; p: number; tx: number; ty: number; }

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Pressure response curve: cubic Bezier from (0,0) to (1,1) with two control points, baked into a LUT. */
export class PressureCurve {
  private lut = new Float32Array(257);
  constructor(public x1 = 0.25, public y1 = 0.25, public x2 = 0.75, public y2 = 0.75) { this.bake(); }
  set(x1: number, y1: number, x2: number, y2: number) { Object.assign(this, { x1, y1, x2, y2 }); this.bake(); }
  private bake() {
    const { x1, y1, x2, y2 } = this;
    const bz = (a: number, b: number, t: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
    // sample densely along t, then resample uniformly in x
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i <= 512; i++) { const t = i / 512; xs.push(bz(x1, x2, t)); ys.push(bz(y1, y2, t)); }
    let j = 0;
    for (let i = 0; i <= 256; i++) {
      const x = i / 256;
      while (j < 511 && xs[j + 1] < x) j++;
      const span = xs[j + 1] - xs[j];
      const k = span > 1e-6 ? (x - xs[j]) / span : 0;
      this.lut[i] = Math.max(0, Math.min(1, lerp(ys[j], ys[j + 1], Math.max(0, Math.min(1, k)))));
    }
  }
  map(p: number) {
    const f = Math.max(0, Math.min(1, p)) * 256, i = Math.floor(f);
    return i >= 256 ? this.lut[256] : lerp(this.lut[i], this.lut[i + 1], f - i);
  }
}

/**
 * Adaptive low-pass ("one-euro" style) filter: heavy smoothing when the pen moves slowly (kills hand jitter),
 * light smoothing when it moves fast (keeps lag low). Time based, so it behaves the same at 60, 120 or 240 Hz.
 */
class AdaptiveFilter {
  private x = 0; private y = 0; private dx = 0; private dy = 0; private init = false;
  constructor(private minCut: number, private beta: number, private screenScale: number) {}
  private static alpha(cut: number, dt: number) { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
  reset(x: number, y: number) { this.x = x; this.y = y; this.dx = 0; this.dy = 0; this.init = true; }
  step(x: number, y: number, dt: number): [number, number] {
    if (!this.init) { this.reset(x, y); return [x, y]; }
    const ad = AdaptiveFilter.alpha(1.2, dt);
    this.dx = lerp(this.dx, (x - this.x) / dt, ad);
    this.dy = lerp(this.dy, (y - this.y) / dt, ad);
    const speed = Math.hypot(this.dx, this.dy) * this.screenScale; // screen px per second
    const a = AdaptiveFilter.alpha(this.minCut + this.beta * speed, dt);
    this.x = lerp(this.x, x, a); this.y = lerp(this.y, y, a);
    return [this.x, this.y];
  }
}

export interface StrokeOpts {
  curve?: PressureCurve;
  /** document px -> screen px, so smoothing and tapers feel the same at every zoom */
  viewScale?: number;
  /** brush size relative to its preset size: tapers scale with it */
  sizeRatio?: number;
}

/** Turns pointer samples into evenly spaced, jittered dabs with adaptive smoothing, curve interpolation and tapers. */
export class StrokeBuilder {
  private all: DabX[] = [];
  readonly raw: Sample[] = [];       // unfiltered input (QuickShape fitting, replay)
  private pts: Pt[] = [];            // smoothed points (last 3 used for curve interpolation)
  private emitted: Pt | null = null; // where the path drawn so far ends
  private dist = 0;
  private carry = 0;
  private dir = 0;
  private lastT = 0;
  private pSm = 0;
  private filter: AdaptiveFilter | null;
  private rand: () => number;
  private curve: PressureCurve | null;
  private taperK: number;
  constructor(public brush: Brush, opts: StrokeOpts = {}) {
    this.rand = rng((Math.random() * 1e9) | 0);
    this.curve = opts.curve || null;
    const vs = opts.viewScale || 1;
    const s = brush.smoothing;
    this.filter = s > 0.01 ? new AdaptiveFilter(0.5 + 11 * (1 - s) * (1 - s), 0.0025 + 0.02 * (1 - s), vs) : null;
    this.taperK = Math.max(0.3, Math.min(3, opts.sizeRatio ?? 1));
  }

  private press(p: number) { return this.curve ? this.curve.map(p) : Math.max(0, Math.min(1, p)); }

  private makeDab(x: number, y: number, p: number, tx: number, ty: number, dist: number): DabX {
    const b = this.brush, r = this.rand;
    const pr = this.press(p);
    let size = b.size * (1 - b.pressSize * (1 - (b.minSize + (1 - b.minSize) * pr)));
    let flow = b.flow * (1 - b.pressOpacity * (1 - pr));
    const ts = b.taperStart * this.taperK;
    if (ts > 0) size *= 0.12 + 0.88 * smooth(Math.min(1, dist / ts));
    if (b.sizeJitter > 0) size *= 1 - b.sizeJitter * r();
    if (b.opacityJitter > 0) flow *= 1 - b.opacityJitter * r();
    let angle = (b.angle * Math.PI) / 180 + (b.followDir ? this.dir : 0) + (b.rotJitter > 0 ? (r() - 0.5) * 2 * Math.PI * b.rotJitter : 0);
    let aspect = b.roundness;
    if (b.tiltSize > 0 && (tx || ty)) {
      const tilt = Math.min(1, Math.max(Math.abs(tx), Math.abs(ty)) / 70);
      size *= 1 + b.tiltSize * tilt * tilt;
      flow *= 1 - 0.45 * tilt;
      aspect *= 1 - 0.55 * tilt;
      angle = Math.atan2(ty, tx);
    }
    if (b.scatter > 0) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * b.scatter * size;
      x += Math.cos(a) * d; y += Math.sin(a) * d;
    }
    return { x, y, r: Math.max(0.25, size / 2), a: Math.max(0, Math.min(1, flow)), angle, aspect: Math.max(0.05, aspect), dist };
  }

  private step(p: number) {
    const b = this.brush, pr = this.press(p);
    const size = b.size * (1 - b.pressSize * (1 - (b.minSize + (1 - b.minSize) * pr)));
    return Math.max(0.35, size * b.spacing);
  }

  /** advance along the straight segment a->b emitting dabs */
  private walk(a: Pt, b: Pt, out: DabX[]) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    const nd = Math.atan2(dy, dx);
    let dd = nd - this.dir; while (dd > Math.PI) dd -= 2 * Math.PI; while (dd < -Math.PI) dd += 2 * Math.PI;
    this.dir += dd * Math.min(1, L / 12);
    let t = 0;
    for (let guard = 0; guard < 100000; guard++) {
      const p = a.p + (b.p - a.p) * (t / L);
      const need = this.step(p) - this.carry;
      if (t + need > L) { this.carry += L - t; break; }
      t += need; this.carry = 0;
      const k = t / L;
      out.push(this.makeDab(a.x + dx * k, a.y + dy * k, a.p + (b.p - a.p) * k, a.tx + (b.tx - a.tx) * k, a.ty + (b.ty - a.ty) * k, this.dist + t));
    }
    this.dist += L;
  }

  /** quadratic Bezier from a to c with control b, flattened into short segments */
  private curveTo(a: Pt, b: Pt, c: Pt, out: DabX[]) {
    const len = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y);
    const n = Math.max(1, Math.min(48, Math.ceil(len / 3)));
    let prev = a;
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const q: Pt = {
        x: u * u * a.x + 2 * u * t * b.x + t * t * c.x, y: u * u * a.y + 2 * u * t * b.y + t * t * c.y,
        p: lerp(a.p, c.p, t), tx: lerp(a.tx, c.tx, t), ty: lerp(a.ty, c.ty, t),
      };
      this.walk(prev, q, out);
      prev = q;
    }
  }

  private mid(a: Pt, b: Pt): Pt { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: (a.p + b.p) / 2, tx: (a.tx + b.tx) / 2, ty: (a.ty + b.ty) / 2 }; }

  start(s: Sample): Dab[] {
    this.raw.push(s);
    this.lastT = s.t || 0;
    this.pSm = s.p;
    this.filter?.reset(s.x, s.y);
    const p0: Pt = { x: s.x, y: s.y, p: s.p, tx: s.tx, ty: s.ty };
    this.pts = [p0]; this.emitted = p0;
    const d = this.makeDab(s.x, s.y, s.p, s.tx, s.ty, 0);
    this.all.push(d);
    return [d];
  }

  add(raw: Sample): Dab[] {
    if (!this.emitted) return this.start(raw);
    this.raw.push(raw);
    // dt from event timestamps; synthetic/unknown timestamps fall back to a 240 Hz cadence
    let dt = raw.t && this.lastT ? (raw.t - this.lastT) / 1000 : 0;
    if (!(dt > 0.0005)) dt = 1 / 240;
    dt = Math.min(dt, 0.05);
    if (raw.t) this.lastT = raw.t;
    const [x, y] = this.filter ? this.filter.step(raw.x, raw.y, dt) : [raw.x, raw.y];
    // pressure: short time-constant smoothing so swells do not step
    this.pSm = lerp(this.pSm, raw.p, 1 - Math.exp(-dt / 0.012));
    const np: Pt = { x, y, p: this.pSm, tx: raw.tx, ty: raw.ty };
    const last = this.pts[this.pts.length - 1];
    if (Math.hypot(np.x - last.x, np.y - last.y) < 0.2) { last.p = np.p; return []; }
    this.pts.push(np);
    if (this.pts.length > 3) this.pts.shift();
    const out: DabX[] = [];
    if (this.pts.length === 2) {
      const m = this.mid(this.pts[0], this.pts[1]);
      this.walk(this.emitted, m, out); this.emitted = m;
    } else {
      const [, b, c] = this.pts;
      const m = this.mid(b, c);
      this.curveTo(this.emitted, b, m, out); this.emitted = m;
    }
    this.all.push(...out);
    return out;
  }

  /** total path length so far (document px) */
  get length() { return this.dist; }

  /** catch the smoothed path up to the pen, return new dabs and (if tapered) the full re-tapered list */
  finish(): { added: Dab[]; full: Dab[] | null } {
    const out: DabX[] = [];
    const lastRaw = this.raw[this.raw.length - 1];
    if (this.emitted && lastRaw) {
      const end: Pt = { x: lastRaw.x, y: lastRaw.y, p: this.pSm, tx: lastRaw.tx, ty: lastRaw.ty };
      const b = this.pts[this.pts.length - 1];
      if (this.pts.length >= 2) this.curveTo(this.emitted, b, end, out); else this.walk(this.emitted, end, out);
      this.emitted = end;
    }
    this.all.push(...out);
    const total = this.dist;
    const b = this.brush;
    if (total < 1.5 && this.all.length) {
      // a tap: one clean dot without tapers
      const d0 = this.all[0];
      const full = [{ ...d0, r: Math.max(d0.r, b.size * (1 - b.pressSize * (1 - b.minSize)) * 0.5) }];
      return { added: out, full };
    }
    const tsN = b.taperStart * this.taperK, teN = b.taperEnd * this.taperK;
    if (teN > 0 || tsN > 0) {
      const te = Math.min(teN, total * 0.45);
      const full = this.all.map((d) => {
        let f = 1;
        if (te > 0) f = 0.1 + 0.9 * smooth(Math.min(1, (total - d.dist) / te));
        if (tsN > total * 0.55) {
          // short stroke: renormalise start taper so it still reaches full width
          const ts = Math.max(1, total * 0.55);
          f *= (0.12 + 0.88 * smooth(Math.min(1, d.dist / ts))) / (0.12 + 0.88 * smooth(Math.min(1, d.dist / tsN)));
        }
        return { ...d, r: Math.max(0.25, d.r * f) };
      });
      return { added: out, full };
    }
    return { added: out, full: null };
  }

  /** dabs along straight segments (corners stay sharp), with end taper applied */
  path(path: { x: number; y: number }[], p: number): Dab[] {
    if (!path.length) return [];
    const P = (q: { x: number; y: number }): Pt => ({ x: q.x, y: q.y, p, tx: 0, ty: 0 });
    const out: DabX[] = [this.makeDab(path[0].x, path[0].y, p, 0, 0, 0)];
    for (let i = 1; i < path.length; i++) this.walk(P(path[i - 1]), P(path[i]), out);
    const total = this.dist, te = Math.min(this.brush.taperEnd * this.taperK, total * 0.45);
    if (te <= 0) return out;
    return out.map((d) => ({ ...d, r: Math.max(0.25, d.r * (0.1 + 0.9 * smooth(Math.min(1, (total - d.dist) / te)))) }));
  }

  /** finish (if not yet) and return the complete, tapered dab list */
  finishedDabs(): Dab[] { const { full } = this.finish(); return full || this.all; }

  /** every dab of the stroke (for symmetry re-expansion / QuickShape replacement) */
  get dabs(): Dab[] { return this.all; }
}

/** Dabs along an arbitrary polyline with constant pressure (QuickShape output). Closed shapes get no tapers. */
export function dabsAlong(brush: Brush, path: { x: number; y: number }[], p: number, opts: StrokeOpts = {}, closed = false): Dab[] {
  const b = closed ? { ...brush, taperStart: 0, taperEnd: 0 } : brush;
  return new StrokeBuilder({ ...b, smoothing: 0 }, opts).path(path, p);
}

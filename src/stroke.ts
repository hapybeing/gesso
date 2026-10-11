import { Brush, rng } from './brushes';
import type { Dab } from './engine';

export interface Sample { x: number; y: number; p: number; tx: number; ty: number; }
interface DabX extends Dab { dist: number; }

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Turns pointer samples into evenly spaced, jittered dabs with streamline smoothing and tapers. */
export class StrokeBuilder {
  private all: DabX[] = [];
  private s: Sample | null = null;      // smoothed position
  private last: Sample | null = null;   // last raw sample
  private dist = 0;                     // distance travelled along smoothed path
  private carry = 0;                    // distance since last dab
  private dir = 0;
  private rand: () => number;
  constructor(public brush: Brush, private gamma = 1, private scaleHint = 1) {
    this.rand = rng((Math.random() * 1e9) | 0);
  }

  private press(p: number) { return Math.pow(Math.max(0.001, Math.min(1, p)), this.gamma); }

  private makeDab(x: number, y: number, p: number, tx: number, ty: number, dist: number): DabX {
    const b = this.brush, r = this.rand;
    const pr = this.press(p);
    let size = b.size * (1 - b.pressSize * (1 - (b.minSize + (1 - b.minSize) * pr)));
    let flow = b.flow * (1 - b.pressOpacity * (1 - pr));
    if (b.taperStart > 0) size *= 0.12 + 0.88 * smooth(Math.min(1, dist / b.taperStart));
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

  /** advance along segment a->b emitting dabs */
  private walk(a: Sample, b: Sample, out: DabX[]) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    const nd = Math.atan2(dy, dx);
    // smooth direction for followDir brushes
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

  start(s: Sample): Dab[] {
    this.s = { ...s }; this.last = { ...s };
    const d = this.makeDab(s.x, s.y, s.p, s.tx, s.ty, 0);
    this.all.push(d);
    return [d];
  }

  add(raw: Sample): Dab[] {
    if (!this.s) return this.start(raw);
    this.last = raw;
    // streamline: speed-independent exponential pull, stronger smoothing = more lag
    const k = 1 - Math.min(0.92, this.brush.smoothing * 0.92);
    const prev = this.s;
    const next: Sample = {
      x: prev.x + (raw.x - prev.x) * k, y: prev.y + (raw.y - prev.y) * k,
      p: prev.p + (raw.p - prev.p) * Math.max(k, 0.45),
      tx: raw.tx, ty: raw.ty,
    };
    const out: DabX[] = [];
    this.walk(prev, next, out);
    this.s = next;
    this.all.push(...out);
    return out;
  }

  /** catch the lagging smoothed point up to the pen, return new dabs and (if tapered) the full re-tapered list */
  finish(): { added: Dab[]; full: Dab[] | null } {
    const out: DabX[] = [];
    if (this.s && this.last) {
      // ease into the final point in a few steps so the end stays smooth
      for (let i = 0; i < 4; i++) {
        const prev = this.s;
        const next: Sample = { x: prev.x + (this.last.x - prev.x) * 0.6, y: prev.y + (this.last.y - prev.y) * 0.6, p: prev.p, tx: this.last.tx, ty: this.last.ty };
        if (i === 3) { next.x = this.last.x; next.y = this.last.y; }
        this.walk(prev, next, out);
        this.s = next;
      }
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
    if (b.taperEnd > 0 || b.taperStart > 0) {
      const te = Math.min(b.taperEnd, total * 0.45);
      const full = this.all.map((d) => {
        let f = 1;
        if (te > 0) f = 0.1 + 0.9 * smooth(Math.min(1, (total - d.dist) / te));
        if (b.taperStart > total * 0.55) {
          // short stroke: renormalise start taper so it still reaches full width
          const ts = Math.max(1, total * 0.55);
          f *= (0.12 + 0.88 * smooth(Math.min(1, d.dist / ts))) / (0.12 + 0.88 * smooth(Math.min(1, d.dist / b.taperStart)));
        }
        return { ...d, r: Math.max(0.25, d.r * f) };
      });
      return { added: out, full };
    }
    return { added: out, full: null };
  }
}

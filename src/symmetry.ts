// Symmetry drawing guide: vertical, horizontal, quadrant and radial (any N, rotational or kaleidoscope).
// Every dab of a stroke is replicated through a set of rotations/reflections about the guide centre,
// so brushes, tapers, jitter and snapped shapes all mirror exactly.
import type { Dab, Engine } from './engine';

export type SymMode = 'off' | 'vertical' | 'horizontal' | 'quadrant' | 'radial';
export interface Symmetry {
  mode: SymMode;
  n: number;          // radial segments
  mirror: boolean;    // radial: also reflect inside each segment (kaleidoscope)
  cx: number; cy: number; // doc px
  angle: number;      // guide rotation (radians)
  assist: boolean;    // replicate strokes (off = guide only)
  show: boolean;      // draw the guide lines
}
export const defaultSymmetry = (w: number, h: number): Symmetry => ({ mode: 'off', n: 6, mirror: true, cx: w / 2, cy: h / 2, angle: 0, assist: true, show: true });

/** linear part of each copy: [a, b, c, d] maps (x,y) -> (a x + b y, c x + d y); refl = orientation flips */
interface Xf { a: number; b: number; c: number; d: number; refl: boolean; rot: number; axis: number; }
const rotX = (t: number): Xf => ({ a: Math.cos(t), b: -Math.sin(t), c: Math.sin(t), d: Math.cos(t), refl: false, rot: t, axis: 0 });
/** reflection across a line through the origin at angle t */
const refX = (t: number): Xf => ({ a: Math.cos(2 * t), b: Math.sin(2 * t), c: Math.sin(2 * t), d: -Math.cos(2 * t), refl: true, rot: 0, axis: t });

export function transforms(s: Symmetry): Xf[] {
  const A = s.angle;
  switch (s.mode) {
    case 'vertical': return [rotX(0), refX(A + Math.PI / 2)];
    case 'horizontal': return [rotX(0), refX(A)];
    case 'quadrant': return [rotX(0), refX(A + Math.PI / 2), refX(A), rotX(Math.PI)];
    case 'radial': {
      const n = Math.max(2, Math.min(32, Math.round(s.n)));
      const out: Xf[] = [];
      for (let k = 0; k < n; k++) out.push(rotX((2 * Math.PI * k) / n));
      if (s.mirror) for (let k = 0; k < n; k++) out.push(refX(A + (Math.PI * k) / n));
      return out;
    }
    default: return [rotX(0)];
  }
}

export function expandDabs(dabs: Dab[], s: Symmetry): Dab[] {
  const xs = transforms(s);
  if (xs.length <= 1) return dabs;
  const out: Dab[] = new Array(dabs.length * xs.length);
  let k = 0;
  for (const x of xs) for (const d of dabs) {
    const px = d.x - s.cx, py = d.y - s.cy;
    out[k++] = {
      ...d,
      x: s.cx + x.a * px + x.b * py, y: s.cy + x.c * px + x.d * py,
      angle: x.refl ? 2 * x.axis - d.angle : d.angle + x.rot,
    };
  }
  return out;
}

/** guide handle positions in doc px: centre and rotation knob */
export function guideHandles(s: Symmetry, e: Engine) {
  const r = 70 / e.view.scale; // 70 screen px from the centre
  const dir = s.mode === 'vertical' ? s.angle + Math.PI / 2 : s.angle;
  return { c: { x: s.cx, y: s.cy }, r: { x: s.cx + Math.cos(dir) * r, y: s.cy + Math.sin(dir) * r } };
}

/** draw the guide in screen space (CSS px) */
export function drawGuide(g: CanvasRenderingContext2D, e: Engine, s: Symmetry, editing: boolean) {
  if (s.mode === 'off' || (!s.show && !editing)) return;
  const L = Math.hypot(e.w, e.h) * 2;
  const axes: number[] = [];
  const A = s.angle;
  if (s.mode === 'vertical') axes.push(A + Math.PI / 2);
  else if (s.mode === 'horizontal') axes.push(A);
  else if (s.mode === 'quadrant') axes.push(A, A + Math.PI / 2);
  // clip to the canvas rectangle
  g.save();
  const corners = [[0, 0], [e.w, 0], [e.w, e.h], [0, e.h]].map(([x, y]) => e.docToScreen(x, y));
  g.beginPath(); corners.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.clip();
  const line = (ax: number, ay: number, bx: number, by: number) => {
    const a = e.docToScreen(ax, ay), b = e.docToScreen(bx, by);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
    g.strokeStyle = 'rgba(20,18,17,.45)'; g.lineWidth = 3; g.stroke();
    g.strokeStyle = 'rgba(80,170,255,.9)'; g.lineWidth = 1.3; g.stroke();
  };
  for (const t of axes) line(s.cx - Math.cos(t) * L, s.cy - Math.sin(t) * L, s.cx + Math.cos(t) * L, s.cy + Math.sin(t) * L);
  if (s.mode === 'radial') {
    const n = Math.max(2, Math.min(32, Math.round(s.n)));
    for (let k = 0; k < n; k++) {
      const t = A + (2 * Math.PI * k) / n;
      line(s.cx, s.cy, s.cx + Math.cos(t) * L, s.cy + Math.sin(t) * L);
    }
  }
  g.restore();
  if (editing) {
    const hd = guideHandles(s, e);
    const c = e.docToScreen(hd.c.x, hd.c.y), r = e.docToScreen(hd.r.x, hd.r.y);
    g.setLineDash([3, 4]); g.strokeStyle = 'rgba(80,170,255,.9)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(c.x, c.y); g.lineTo(r.x, r.y); g.stroke(); g.setLineDash([]);
    for (const [p, big] of [[c, true], [r, false]] as const) {
      g.beginPath(); g.arc(p.x, p.y, big ? 11 : 8, 0, Math.PI * 2);
      g.fillStyle = big ? '#50aaff' : '#ffffff'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = 'rgba(20,18,17,.85)'; g.stroke();
    }
  }
}

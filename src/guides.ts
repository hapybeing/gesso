// Drawing guides: 2D grid, isometric grid, 1/2/3-point perspective and a ruler, each with Drawing assist.
// Assist works on the pen samples (before smoothing): the first ~10 screen px of a stroke are held back while
// its direction is read, then the stroke locks to the guide line that best matches that direction (a grid axis,
// the line through the start point and a vanishing point, the ruler's edge…) and every sample is projected onto
// it. A start direction more than 35° away from every guide line leaves the stroke free, so details and curves
// can be drawn without turning the guide off (Procreate forces every stroke; Krita and Clip Studio need a
// modifier or a separate toggle).
import type { Engine } from './engine';
import type { Sample } from './stroke';

export type GuideKind = 'off' | 'grid' | 'iso' | 'persp' | 'ruler';
export interface Pt { x: number; y: number; }
export interface Guides {
  kind: GuideKind;
  /** grid spacing in doc px (2D and isometric) */
  size: number;
  /** perspective: number of vanishing points in use and their positions (doc px; may lie off the canvas) */
  points: 1 | 2 | 3;
  vps: Pt[];
  /** ruler: its two ends, and whether strokes anywhere draw parallel to it (else only strokes near its edge snap) */
  ra: Pt; rb: Pt; parallel: boolean;
  assist: boolean;
  opacity: number;
}
export const defaultGuides = (w: number, h: number): Guides => ({
  kind: 'off', size: Math.max(16, Math.round(Math.min(w, h) / 16)), points: 2,
  vps: [{ x: w * 0.12, y: h * 0.42 }, { x: w * 0.88, y: h * 0.42 }, { x: w * 0.5, y: h * 1.25 }],
  ra: { x: w * 0.25, y: h * 0.6 }, rb: { x: w * 0.75, y: h * 0.6 }, parallel: false, assist: true, opacity: 0.55,
});
export const GUIDE_LABEL: Record<GuideKind, string> = { off: 'Off', grid: '2D grid', iso: 'Isometric', persp: 'Perspective', ruler: 'Ruler' };

const D2R = Math.PI / 180;
/** candidate lines through a start point: [origin, unit direction] */
export function candidates(gd: Guides, p: Pt, e?: { view: { scale: number } }): { o: Pt; d: Pt }[] {
  const dir = (a: number) => ({ x: Math.cos(a), y: Math.sin(a) });
  const out: { o: Pt; d: Pt }[] = [];
  switch (gd.kind) {
    case 'grid': out.push({ o: p, d: dir(0) }, { o: p, d: dir(90 * D2R) }); break;
    case 'iso': out.push({ o: p, d: dir(-30 * D2R) }, { o: p, d: dir(30 * D2R) }, { o: p, d: dir(90 * D2R) }); break;
    case 'persp': {
      const vps = gd.vps.slice(0, gd.points);
      for (const v of vps) { const dx = p.x - v.x, dy = p.y - v.y, L = Math.hypot(dx, dy); if (L > 1e-6) out.push({ o: p, d: { x: dx / L, y: dy / L } }); }
      // 1-point: horizontals and verticals stay parallel; 2-point: verticals stay vertical
      if (gd.points === 1) out.push({ o: p, d: dir(0) }, { o: p, d: dir(90 * D2R) });
      if (gd.points === 2) out.push({ o: p, d: dir(90 * D2R) });
      break;
    }
    case 'ruler': {
      const dx = gd.rb.x - gd.ra.x, dy = gd.rb.y - gd.ra.y, L = Math.hypot(dx, dy) || 1, d = { x: dx / L, y: dy / L };
      if (gd.parallel) { out.push({ o: p, d }); break; }
      // only strokes that start near the edge (48 screen px) snap, onto the edge itself
      const t = (p.x - gd.ra.x) * d.x + (p.y - gd.ra.y) * d.y;
      const q = { x: gd.ra.x + d.x * t, y: gd.ra.y + d.y * t };
      const near = 48 / (e ? e.view.scale : 1);
      if (Math.hypot(p.x - q.x, p.y - q.y) < near && t > -near && t < L + near) out.push({ o: q, d });
      break;
    }
  }
  return out;
}

/** per-stroke assist: hold back the start, lock to a line, project */
export class GuideAssist {
  private start: Sample | null = null;
  private held: Sample[] = [];
  line: { o: Pt; d: Pt } | null = null;
  free = false;
  constructor(private gd: Guides, private e: Engine, private lockPx = 10, private maxAngle = 35) {}
  get active() { return this.gd.kind !== 'off' && this.gd.assist; }
  /** first sample of the stroke; returns what to draw now */
  begin(s: Sample): Sample[] {
    this.start = s; this.held = []; this.line = null; this.free = false;
    if (!this.active || !candidates(this.gd, s, this.e).length) { this.free = true; return [s]; }
    this.held.push(s);
    return [];
  }
  private project(s: Sample): Sample {
    const L = this.line!; const t = (s.x - L.o.x) * L.d.x + (s.y - L.o.y) * L.d.y;
    return { ...s, x: L.o.x + L.d.x * t, y: L.o.y + L.d.y * t };
  }
  add(ss: Sample[]): Sample[] {
    if (this.free) return ss;
    if (this.line) return ss.map((s) => this.project(s));
    this.held.push(...ss);
    const a = this.start!, b = ss[ss.length - 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) * this.e.view.scale < this.lockPx) return [];
    return this.lock(b);
  }
  private lock(b: Sample): Sample[] {
    const a = this.start!;
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    let best: { o: Pt; d: Pt } | null = null, bc = -1;
    for (const c of candidates(this.gd, a, this.e)) { const cos = Math.abs((dx * c.d.x + dy * c.d.y) / L); if (cos > bc) { bc = cos; best = c; } }
    const held = this.held; this.held = [];
    if (!best || Math.acos(Math.min(1, bc)) > this.maxAngle * D2R) { this.free = true; return held; }
    this.line = best;
    return held.map((s) => this.project(s));
  }
  /** stroke ended before the lock distance: a dot or tiny mark, drawn as is */
  flush(): Sample[] { const h = this.held; this.held = []; return h; }
}

// ------------------------------------------------------------------ handles & drawing
export type GuideHandle = { kind: 'vp'; i: number } | { kind: 'ra' } | { kind: 'rb' } | { kind: 'rmove' };
export function guideHandleAt(gd: Guides, e: Engine, sx: number, sy: number): GuideHandle | null {
  const near = (p: Pt, r = 30) => { const s = e.docToScreen(p.x, p.y); return Math.hypot(sx - s.x, sy - s.y) < r; };
  if (gd.kind === 'persp') { for (let i = 0; i < gd.points; i++) if (near(gd.vps[i])) return { kind: 'vp', i }; }
  if (gd.kind === 'ruler') {
    if (near(gd.ra)) return { kind: 'ra' };
    if (near(gd.rb)) return { kind: 'rb' };
    if (near({ x: (gd.ra.x + gd.rb.x) / 2, y: (gd.ra.y + gd.rb.y) / 2 }, 34)) return { kind: 'rmove' };
  }
  return null;
}
export function dragGuideHandle(gd: Guides, h: GuideHandle, p: Pt, prev: Pt) {
  if (h.kind === 'vp') gd.vps[h.i] = { x: p.x, y: p.y };
  else if (h.kind === 'ra') gd.ra = snapRuler(gd.rb, p);
  else if (h.kind === 'rb') gd.rb = snapRuler(gd.ra, p);
  else { const dx = p.x - prev.x, dy = p.y - prev.y; gd.ra = { x: gd.ra.x + dx, y: gd.ra.y + dy }; gd.rb = { x: gd.rb.x + dx, y: gd.rb.y + dy }; }
}
/** ruler ends snap to 15° steps within 2° */
function snapRuler(fixed: Pt, p: Pt): Pt {
  const dx = p.x - fixed.x, dy = p.y - fixed.y, L = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
  const st = 15 * D2R, sa = Math.round(a / st) * st;
  return Math.abs(sa - a) < 2 * D2R ? { x: fixed.x + Math.cos(sa) * L, y: fixed.y + Math.sin(sa) * L } : p;
}
export function rulerAngle(gd: Guides) { return Math.round(Math.atan2(gd.rb.y - gd.ra.y, gd.rb.x - gd.ra.x) / D2R * 10) / 10; }

/** draw the guide on the overlay (CSS px space) */
export function drawGuides(g: CanvasRenderingContext2D, e: Engine, gd: Guides, editing: boolean, lock: { o: Pt; d: Pt } | null) {
  if (gd.kind === 'off') return;
  const S = (x: number, y: number) => e.docToScreen(x, y);
  const docCorners = [[0, 0], [e.w, 0], [e.w, e.h], [0, e.h]];
  const corners = docCorners.map(([x, y]) => S(x, y));
  const scale = e.view.scale;
  g.save();
  g.globalAlpha = Math.max(0.15, Math.min(1, gd.opacity));
  g.lineCap = 'round';
  g.save();
  g.beginPath(); corners.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.clip();
  const seg = (a: Pt, b: Pt) => { const p = S(a.x, a.y), q = S(b.x, b.y); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); };
  /** all lines of one family: direction d, spacing sp (doc px), offset 0 at the doc origin */
  const family = (d: Pt, sp: number) => {
    const n = { x: -d.y, y: d.x };
    const proj = docCorners.map(([x, y]) => x * n.x + y * n.y);
    const lo = Math.floor(Math.min(...proj) / sp), hi = Math.ceil(Math.max(...proj) / sp);
    const R = Math.hypot(e.w, e.h) * 1.5;
    for (let k = lo; k <= hi; k++) { const c = { x: n.x * k * sp, y: n.y * k * sp }; seg({ x: c.x - d.x * R, y: c.y - d.y * R }, { x: c.x + d.x * R, y: c.y + d.y * R }); }
  };
  const stroke = (w = 1, col = 'rgba(70,160,255,.75)') => {
    g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = w + 1.6; g.stroke();
    g.strokeStyle = col; g.lineWidth = w; g.stroke();
  };
  if (gd.kind === 'grid' || gd.kind === 'iso') {
    // too dense on screen → every 2nd/4th… line, so the grid stays readable zoomed out
    let sp = gd.size; while (sp * scale < 7) sp *= 2;
    g.beginPath();
    if (gd.kind === 'grid') { family({ x: 1, y: 0 }, sp); family({ x: 0, y: 1 }, sp); }
    // equal spacing for the three families → equilateral triangles
    else { family({ x: Math.cos(-30 * D2R), y: Math.sin(-30 * D2R) }, sp); family({ x: Math.cos(30 * D2R), y: Math.sin(30 * D2R) }, sp); family({ x: 0, y: 1 }, sp); }
    stroke(1);
  }
  if (gd.kind === 'persp') {
    const vps = gd.vps.slice(0, gd.points), cols = ['rgba(255,110,90,.8)', 'rgba(80,200,120,.8)', 'rgba(90,150,255,.8)'];
    const R = Math.hypot(e.w, e.h) * 4;
    // horizon: through VP1 and VP2 (2/3-point) or horizontal through the single VP
    g.beginPath();
    if (gd.points >= 2) { const a = vps[0], b = vps[1], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1; seg({ x: a.x - dx / L * R, y: a.y - dy / L * R }, { x: a.x + dx / L * R, y: a.y + dy / L * R }); }
    else seg({ x: vps[0].x - R, y: vps[0].y }, { x: vps[0].x + R, y: vps[0].y });
    stroke(1.6, 'rgba(255,220,120,.9)');
    vps.forEach((v, i) => {
      // rays spread evenly over the angle the canvas subtends from the VP (all round when it is inside)
      const inside = v.x > 0 && v.y > 0 && v.x < e.w && v.y < e.h;
      let a0 = -Math.PI, a1 = Math.PI;
      if (!inside) {
        const ang = docCorners.map(([x, y]) => Math.atan2(y - v.y, x - v.x)), base = ang[0];
        const rel = ang.map((a) => { let d = a - base; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; });
        a0 = base + Math.min(...rel); a1 = base + Math.max(...rel);
      }
      const n = inside ? 48 : 24;
      g.beginPath();
      for (let k = 0; k <= n; k++) { const a = a0 + (a1 - a0) * k / n; seg(v, { x: v.x + Math.cos(a) * R, y: v.y + Math.sin(a) * R }); }
      stroke(1, cols[i]);
    });
    if (gd.points < 3) { g.beginPath(); family({ x: 0, y: 1 }, gd.size * 2); stroke(0.8, 'rgba(255,255,255,.32)'); }
  }
  // the line the current stroke is locked to
  if (lock) { g.beginPath(); const R = Math.hypot(e.w, e.h) * 2; seg({ x: lock.o.x - lock.d.x * R, y: lock.o.y - lock.d.y * R }, { x: lock.o.x + lock.d.x * R, y: lock.o.y + lock.d.y * R }); g.globalAlpha = 0.9; stroke(1.4, 'rgba(255,200,80,.95)'); }
  g.restore();
  // the ruler body and the handles draw outside the canvas clip too
  if (gd.kind === 'ruler') {
    const a = S(gd.ra.x, gd.ra.y), b = S(gd.rb.x, gd.rb.y), dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L, Wd = 34;
    g.globalAlpha = 1;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(b.x + nx * Wd, b.y + ny * Wd); g.lineTo(a.x + nx * Wd, a.y + ny * Wd); g.closePath();
    g.fillStyle = 'rgba(240,232,220,.22)'; g.fill(); g.strokeStyle = 'rgba(30,26,24,.5)'; g.lineWidth = 1; g.stroke();
    // ticks every 10 doc px (longer every 50 / 100) while legible
    const docL = Math.hypot(gd.rb.x - gd.ra.x, gd.rb.y - gd.ra.y);
    let step = 10; while (step * scale < 6) step *= 5;
    g.beginPath();
    for (let t = 0; t <= docL; t += step) { const k = t / docL, x = a.x + dx * k, y = a.y + dy * k, i = Math.round(t / step), big = i % 10 === 0 ? 14 : i % 5 === 0 ? 9 : 5; g.moveTo(x, y); g.lineTo(x + nx * big, y + ny * big); }
    g.strokeStyle = 'rgba(30,26,24,.7)'; g.stroke();
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.strokeStyle = 'rgba(255,200,80,.95)'; g.lineWidth = 2; g.stroke();
    if (gd.parallel) { g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '600 11px system-ui'; g.fillText('∥ ' + rulerAngle(gd) + '°', a.x + nx * (Wd + 14), a.y + ny * (Wd + 14)); }
  }
  if (editing) {
    const knob = (p: Pt, col: string, label?: string) => {
      const s = S(p.x, p.y); g.globalAlpha = 1; g.beginPath(); g.arc(s.x, s.y, 13, 0, Math.PI * 2); g.fillStyle = 'rgba(20,18,17,.75)'; g.fill(); g.lineWidth = 3; g.strokeStyle = col; g.stroke();
      if (label) { g.fillStyle = '#fff'; g.font = '700 12px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, s.x, s.y); }
    };
    if (gd.kind === 'persp') ['#ff6e5a', '#50c878', '#5a96ff'].slice(0, gd.points).forEach((c, i) => knob(gd.vps[i], c, String(i + 1)));
    if (gd.kind === 'ruler') { knob(gd.ra, '#ffc850'); knob(gd.rb, '#ffc850'); knob({ x: (gd.ra.x + gd.rb.x) / 2, y: (gd.ra.y + gd.rb.y) / 2 }, '#fff', '✥'); }
  }
  g.restore();
}

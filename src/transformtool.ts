// Transform box for placing an imported image (and, later, moving layer content / selections).
// One finger or the pen: drag inside to move, corners to scale, edge handles to stretch (Free mode),
// the knob to rotate. Two fingers anywhere: move + pinch-scale + twist together.
// Snapping: centre to the canvas centre/edges, rotation to 15° steps, all within a few screen px / degrees.
import type { Engine, Layer } from './engine';
import type { Target } from './gl';
import type { Grab } from './input';

interface Xf { cx: number; cy: number; sx: number; sy: number; rot: number; }
type Handle = { kind: 'corner' | 'edge'; i: number } | { kind: 'rot' } | { kind: 'move' } | null;

export interface TransformHost {
  engine: Engine;
  overlayChanged(): void;
  done(committed: boolean): void;
  toast(msg: string): void;
}

export class TransformTool implements Grab {
  xf: Xf;
  private start: Xf;
  uniform = true;
  filter: 'smooth' | 'sharp' = 'smooth';
  private pointers = new Map<number, { x: number; y: number }>();
  private handle: Handle = null;
  private grabDoc = { x: 0, y: 0 };
  private grabXf: Xf;
  private pinch: { a: number; b: number; p0: [{ x: number; y: number }, { x: number; y: number }]; xf: Xf } | null = null;
  private snapLines: { x?: number; y?: number; rot?: boolean } = {};
  private bar: HTMLElement;
  private raf = 0;

  constructor(private host: TransformHost, readonly layer: Layer, readonly src: Target, private mode: 'insert' | 'replace', private onFinish: (commit: boolean) => void, init?: Xf) {
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
    this.raf = requestAnimationFrame(() => {
      this.host.engine.renderTransformed(this.layer.target, this.src, this.matrix(), this.filter);
      this.layer.version++;
    });
    this.host.overlayChanged();
  }

  // ---------------------------------------------------------------- pointer handling (Grab)
  private hit(sx: number, sy: number): Handle {
    const e = this.host.engine;
    const cs = this.corners().map((p) => e.docToScreen(p.x, p.y));
    const R = 30;
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

  down(e: PointerEvent, x: number, y: number) {
    this.pointers.set(e.pointerId, { x, y });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.keys()];
      this.handle = null;
      this.pinch = { a, b, p0: [{ ...this.pointers.get(a)! }, { ...this.pointers.get(b)! }], xf: { ...this.xf } };
      return;
    }
    if (this.pointers.size > 2) return;
    this.handle = this.hit(x, y);
    this.grabDoc = this.host.engine.screenToDoc(x, y);
    this.grabXf = { ...this.xf };
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
      const vx = (s0.cx - m0.x) * f, vy = (s0.cy - m0.y) * f;
      this.xf = { cx: m1.x + vx * c - vy * s, cy: m1.y + vx * s + vy * c, sx: s0.sx * f, sy: s0.sy * f, rot: this.snapRot(s0.rot + dr) };
      this.apply();
      return;
    }
    const h = this.handle;
    if (!h) return;
    const p = eng.screenToDoc(x, y);
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
    } else {
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
  reset() { this.xf = { ...this.start }; this.apply(); }

  finish(commit: boolean) {
    cancelAnimationFrame(this.raf);
    if (commit) { this.host.engine.renderTransformed(this.layer.target, this.src, this.matrix(), this.filter); this.layer.version++; }
    this.bar.remove();
    this.onFinish(commit);
    this.host.done(commit);
  }

  private renderBar() {
    const b = this.bar;
    b.innerHTML = '';
    const btn = (label: string, fn: () => void, cls = 'chip', on = false) => { const x = document.createElement('button'); x.className = cls + (on ? ' on' : ''); x.textContent = label; x.onclick = () => { fn(); this.renderBar(); }; return x; };
    const grp = (...k: HTMLElement[]) => { const d = document.createElement('div'); d.className = 'chips'; d.append(...k); return d; };
    b.append(
      grp(btn('Uniform', () => { this.uniform = true; }, 'chip', this.uniform), btn('Free', () => { this.uniform = false; }, 'chip', !this.uniform)),
      grp(btn('Flip ↔', () => this.flipH()), btn('Flip ↕', () => this.flipV()), btn('Rotate 90°', () => this.rotate90()), btn('Fit', () => this.fit()), btn('Reset', () => this.reset())),
      grp(btn('Smooth', () => { this.filter = 'smooth'; this.apply(); }, 'chip', this.filter === 'smooth'), btn('Sharp', () => { this.filter = 'sharp'; this.apply(); }, 'chip', this.filter === 'sharp')),
      grp(btn('Cancel', () => this.finish(false), 'btn ghost small'), btn('Done', () => this.finish(true), 'btn small')),
    );
    void this.mode;
  }

  drawOverlay(g: CanvasRenderingContext2D) {
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
}

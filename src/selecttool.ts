// Selection tool: rectangle, ellipse, freehand (drag) + polygon (taps), and automatic (magic wand: tap, then
// slide sideways to change the threshold live). Add / subtract / replace modes. Fingers keep navigating the
// canvas once a stylus is known; with no stylus, one finger selects.
import type { Engine } from './engine';
import type { Grab, Input } from './input';

export type SelKind = 'auto' | 'free' | 'rect' | 'ellipse';
export type SelMode = 0 | 1 | 2; // replace, add, subtract
interface P { x: number; y: number; }

export interface SelectHost {
  engine: Engine;
  overlayChanged(): void;
  toast(msg: string): void;
  /** pixels to flood from: active layer or the whole composite (premultiplied RGBA, row 0 = top) */
  wandPixels(sampleAll: boolean): Promise<Uint8Array>;
}

export class SelectTool implements Grab {
  kind: SelKind = 'free';
  mode: SelMode = 0;
  sampleAll = false;
  threshold = 0.16;
  private id: number | null = null;
  private start: P = { x: 0, y: 0 };      // doc
  private cur: P = { x: 0, y: 0 };
  private poly: P[] = [];                 // freehand / polygon in progress (doc)
  private dragPath: P[] = [];
  private downScreen: P = { x: 0, y: 0 };
  private travel = 0; private lastScreen: P = { x: 0, y: 0 };
  private wand: { px: Uint8Array; seed: P; base: number; sx: number; raf: number } | null = null;
  private wandCache: Promise<Uint8Array> | null = null;

  constructor(private host: SelectHost) {}

  wants(e: PointerEvent, input: Input) {
    if (e.pointerType !== 'touch') return true;
    return input.stylusMode === 'any' || (input.stylusMode === 'auto' && !input.penSeen);
  }

  private doc(x: number, y: number) { return this.host.engine.screenToDoc(x, y); }

  down(e: PointerEvent, x: number, y: number) {
    if (this.id !== null) return;
    this.id = e.pointerId;
    this.downScreen = { x, y }; this.lastScreen = { x, y }; this.travel = 0;
    const p = this.doc(x, y);
    this.start = p; this.cur = p;
    this.dragPath = [p];
    if (this.kind === 'auto') void this.beginWand(p, x);
  }

  move(e: PointerEvent, x: number, y: number) {
    if (e.pointerId !== this.id) return;
    const p = this.doc(x, y);
    this.cur = p;
    this.travel += Math.hypot(x - this.lastScreen.x, y - this.lastScreen.y); this.lastScreen = { x, y };
    if (this.kind === 'auto') { if (this.wand) { this.threshold = Math.max(0.01, Math.min(1, this.wand.base + (x - this.wand.sx) / 600)); this.scheduleWand(); } return; }
    if (this.kind === 'free') this.dragPath.push(p);
    this.host.overlayChanged();
  }

  up(e: PointerEvent, x: number, y: number) {
    if (e.pointerId !== this.id) return;
    this.id = null;
    const eng = this.host.engine;
    const moved = Math.max(this.travel, Math.hypot(x - this.downScreen.x, y - this.downScreen.y));
    if (this.kind === 'auto') { if (this.wand) { cancelAnimationFrame(this.wand.raf); this.runWand(true); } return; }
    if (this.kind === 'rect' || this.kind === 'ellipse') {
      if (moved < 6) { this.host.overlayChanged(); return; }
      this.commitShape((g) => {
        const x0 = Math.min(this.start.x, this.cur.x), y0 = Math.min(this.start.y, this.cur.y);
        const w = Math.abs(this.cur.x - this.start.x), h = Math.abs(this.cur.y - this.start.y);
        if (this.kind === 'rect') g.rect(x0, y0, w, h); else g.ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      }, this.kind === 'rect' ? 'Rectangle selection' : 'Ellipse selection');
      return;
    }
    // freehand: a drag adds its path, a tap adds a straight-edge vertex; closing near the first point commits
    const nearFirst = (q: P) => { const first = this.poly[0]; return first && Math.hypot(eng.docToScreen(q.x, q.y).x - eng.docToScreen(first.x, first.y).x, eng.docToScreen(q.x, q.y).y - eng.docToScreen(first.x, first.y).y) < 24; };
    if (moved < 6) {
      if (this.poly.length >= 3 && nearFirst(this.start)) { this.closePoly(); return; }
      this.poly.push(this.start);
    } else {
      this.poly.push(...this.dragPath);
      if (this.poly.length > 8 && nearFirst(this.cur)) { this.closePoly(); return; }
    }
    this.host.overlayChanged();
  }

  /** finish a polygon in progress (also used by the bar's Close button) */
  closePoly() {
    const pts = this.poly; this.poly = [];
    if (pts.length < 3) { this.host.overlayChanged(); return; }
    this.commitShape((g) => { pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y))); g.closePath(); }, 'Freehand selection');
  }
  get polyOpen() { return this.poly.length > 0; }
  cancelPoly() { this.poly = []; this.host.overlayChanged(); }

  private commitShape(path: (g: CanvasRenderingContext2D) => void, label: string) {
    const e = this.host.engine;
    const c = document.createElement('canvas'); c.width = e.w; c.height = e.h;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.beginPath(); path(g); g.fill();
    e.selectFromCanvas(c, this.mode, label);
    c.width = c.height = 1;
    this.host.overlayChanged();
  }

  // ---------------------------------------------------------------- magic wand
  invalidateWand() { this.wandCache = null; }
  private async beginWand(p: P, sx: number) {
    const e = this.host.engine;
    if (p.x < 0 || p.y < 0 || p.x >= e.w || p.y >= e.h) return;
    if (!this.wandCache) this.wandCache = this.host.wandPixels(this.sampleAll);
    const px = await this.wandCache;
    this.wand = { px, seed: { x: Math.floor(p.x), y: Math.floor(p.y) }, base: this.threshold, sx, raf: 0 };
    this.runWand(this.id === null);
  }
  private scheduleWand() {
    if (!this.wand || this.wand.raf) return;
    this.wand.raf = requestAnimationFrame(() => { if (this.wand) { this.wand.raf = 0; this.runWand(false); } });
  }
  private preview: Uint8Array | null = null;
  /** flood fill with soft edges; commit=false shows a live preview, commit=true records the selection */
  private runWand(commit: boolean) {
    const w = this.wand; if (!w) return;
    const e = this.host.engine, W = e.w, H = e.h, px = w.px;
    const cov = flood(px, W, H, w.seed.x, w.seed.y, this.threshold);
    this.preview = cov;
    if (commit) {
      e.selectFromBytes(cov, this.mode, 'Automatic selection');
      this.wand = null; this.preview = null;
      this.host.toast(`Threshold ${Math.round(this.threshold * 100)}%`);
    }
    this.host.overlayChanged();
  }
  get wandPreview() { return this.preview; }

  /** in-progress outlines on the overlay */
  drawOverlay(g: CanvasRenderingContext2D) {
    const e = this.host.engine;
    const S = (q: P) => e.docToScreen(q.x, q.y);
    const ants = (draw: () => void) => {
      g.lineWidth = 1.5; g.setLineDash([]); g.strokeStyle = '#000'; draw(); g.stroke();
      g.setLineDash([5, 5]); g.lineDashOffset = -(performance.now() / 40) % 10; g.strokeStyle = '#fff'; draw(); g.stroke(); g.setLineDash([]);
    };
    if (this.id !== null && (this.kind === 'rect' || this.kind === 'ellipse')) {
      const a = S(this.start), b = S(this.cur), c = S({ x: this.cur.x, y: this.start.y }), d = S({ x: this.start.x, y: this.cur.y });
      ants(() => {
        g.beginPath();
        if (this.kind === 'rect') { g.moveTo(a.x, a.y); g.lineTo(c.x, c.y); g.lineTo(b.x, b.y); g.lineTo(d.x, d.y); g.closePath(); }
        else {
          // ellipse in doc space mapped to screen (handles canvas rotation)
          const cx = (this.start.x + this.cur.x) / 2, cy = (this.start.y + this.cur.y) / 2, rx = Math.abs(this.cur.x - this.start.x) / 2, ry = Math.abs(this.cur.y - this.start.y) / 2;
          for (let i = 0; i <= 72; i++) { const t = (i / 72) * Math.PI * 2, q = S({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry }); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); }
        }
      });
    }
    const pts = [...this.poly, ...(this.id !== null && this.kind === 'free' ? this.dragPath : [])];
    if (pts.length) {
      ants(() => { g.beginPath(); pts.forEach((q, i) => { const s = S(q); i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); }); });
      const f = S(pts[0]);
      g.beginPath(); g.arc(f.x, f.y, 8, 0, Math.PI * 2); g.fillStyle = '#50aaff'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
    }
    if (this.preview && this.wand) {
      const s = S(this.wand.seed);
      g.font = '600 13px system-ui, sans-serif'; g.textAlign = 'center';
      const t = `Threshold ${Math.round(this.threshold * 100)}% · slide sideways`;
      const w = g.measureText(t).width + 18;
      g.fillStyle = 'rgba(32,29,27,.92)'; g.beginPath(); g.roundRect(s.x - w / 2, s.y - 48, w, 26, 13); g.fill();
      g.fillStyle = '#f1e9dd'; g.textBaseline = 'middle'; g.fillText(t, s.x, s.y - 35);
    }
  }
}

/**
 * Scanline flood fill from (sx, sy) over premultiplied RGBA. Pixels within `t` of the seed colour are fully
 * selected; a soft band up to t + 0.06 gives anti-aliased edges. Returns coverage bytes (w*h).
 */
export function flood(px: Uint8Array, W: number, H: number, sx: number, sy: number, t: number): Uint8Array {
  const out = new Uint8Array(W * H);
  const seen = new Uint8Array(W * H);
  const i0 = (sy * W + sx) * 4;
  const r0 = px[i0], g0 = px[i0 + 1], b0 = px[i0 + 2], a0 = px[i0 + 3];
  const hard = t * 255 * 2, soft = (t + 0.06) * 255 * 2; // compare against a weighted RGBA distance
  const dist = (i: number) => {
    const dr = px[i] - r0, dg = px[i + 1] - g0, db = px[i + 2] - b0, da = px[i + 3] - a0;
    return Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db + da * da);
  };
  const cov = (d: number) => (d <= hard ? 255 : d >= soft ? 0 : Math.round((255 * (soft - d)) / (soft - hard)));
  const stack: number[] = [sx, sy];
  // a pixel outside the solid range but inside the soft band becomes an anti-aliased edge pixel
  const edge = (k: number, d: number) => { if (d < soft) { seen[k] = 1; out[k] = cov(d); } };
  while (stack.length) {
    const y = stack.pop()!, x0 = stack.pop()!;
    const row = y * W;
    if (seen[row + x0]) continue;
    let x = x0;
    while (x >= 0 && !seen[row + x] && dist((row + x) * 4) <= hard) x--;
    if (x >= 0 && !seen[row + x]) edge(row + x, dist((row + x) * 4));
    x++;
    let upOpen = false, downOpen = false;
    for (; x < W; x++) {
      const k = row + x;
      if (seen[k]) break;
      const d = dist(k * 4);
      if (d > hard) { edge(k, d); break; }
      seen[k] = 1; out[k] = 255;
      if (y > 0) {
        const u = k - W;
        if (!seen[u]) { const du = dist(u * 4); if (du <= hard) { if (!upOpen) { stack.push(x, y - 1); upOpen = true; } } else { edge(u, du); upOpen = false; } } else upOpen = false;
      }
      if (y < H - 1) {
        const dn = k + W;
        if (!seen[dn]) { const dd = dist(dn * 4); if (dd <= hard) { if (!downOpen) { stack.push(x, y + 1); downOpen = true; } } else { edge(dn, dd); downOpen = false; } } else downOpen = false;
      }
    }
  }
  return out;
}

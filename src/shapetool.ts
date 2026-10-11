// Hold-to-snap controller. Lifecycle of one stroke:
//   drawing --(pen still ~500 ms)--> snapped, pen still down: the pen rubber-bands the shape
//   --(lift)--> editing: handles on the overlay, banner with Done / Freehand
//   --(Done, a new stroke elsewhere, a tool/menu action)--> committed as one undo step.
import type { Engine, Dab } from './engine';
import { recognise, Shape, P } from './quickshape';

export interface ShapeHost {
  engine: Engine;
  /** dabs for a shape path with the current stroke's brush (symmetry already applied) */
  dabsFor(shape: Shape): Dab[];
  /** expand freehand dabs with symmetry (for "keep freehand") */
  freehandDabs(): Dab[];
  overlayChanged(): void;
  committed(): void;
}

const HIT = 30; // screen px

export class ShapeTool {
  enabled = true;
  delay = 500;
  shape: Shape | null = null;
  private anchor: Shape | null = null;
  phase: 'idle' | 'hold' | 'edit' = 'idle';
  private timer = 0;
  private still: { x: number; y: number } | null = null;   // screen point the pen is resting near
  private raw: () => P[] = () => [];
  private drag = -1;
  private constrain = false;
  private bar: HTMLElement;

  constructor(private host: ShapeHost) {
    this.bar = document.createElement('div');
    this.bar.id = 'qsbar';
    document.body.append(this.bar);
  }

  get active() { return this.phase !== 'idle'; }

  // ---------------------------------------------------------------- during a freehand stroke
  strokeBegan(raw: () => P[]) { this.raw = raw; this.still = null; this.constrain = false; clearTimeout(this.timer); }

  /** a new pen position (screen px); restarts the stillness timer when the pen moves */
  pen(sx: number, sy: number) {
    if (!this.enabled || this.phase !== 'idle') return;
    if (!this.still || Math.hypot(sx - this.still.x, sy - this.still.y) > 5) {
      this.still = { x: sx, y: sy };
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.trySnap(), this.delay);
    }
  }
  strokeEnded() { clearTimeout(this.timer); }

  private trySnap() {
    const e = this.host.engine;
    if (!e.stroking) return;
    const s = recognise(this.raw(), 1 / e.view.scale);
    if (!s) return;
    this.shape = s; this.anchor = s.clone();
    this.phase = 'hold';
    if (navigator.vibrate) try { navigator.vibrate(8); } catch { /* not allowed */ }
    this.redraw();
    this.showBar();
  }

  /** pen moved while snapped and still down */
  holdMove(p: P) {
    if (this.phase !== 'hold' || !this.shape || !this.anchor) return;
    this.shape.rubberBand(p, this.constrain, this.anchor);
    this.redraw();
  }
  /** second finger touched while holding: perfect circle / square / 15° line */
  secondary() {
    if (this.phase !== 'hold' || !this.shape || !this.anchor) return;
    this.constrain = true;
    this.anchor.perfect(); this.shape.perfect();
    this.redraw(); this.showBar();
  }
  /** pen lifted after a snap: enter handle editing */
  holdEnd() {
    if (this.phase !== 'hold') return;
    this.phase = 'edit';
    this.showBar();
    this.host.overlayChanged();
  }

  // ---------------------------------------------------------------- editing handles
  handleAt(sx: number, sy: number): number {
    if (this.phase !== 'edit' || !this.shape) return -1;
    const e = this.host.engine;
    let best = -1, bd = HIT;
    this.shape.handles().forEach((h, i) => { const s = e.docToScreen(h.x, h.y); const d = Math.hypot(s.x - sx, s.y - sy); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  beginDrag(i: number) { this.drag = i; }
  get dragging() { return this.drag >= 0; }
  dragTo(p: P) {
    if (this.drag < 0 || !this.shape) return;
    this.shape.moveHandle(this.drag, p, false);
    this.redraw();
  }
  endDrag() { this.drag = -1; this.host.overlayChanged(); }

  // ---------------------------------------------------------------- finishing
  commit() {
    if (this.phase === 'idle') return;
    const e = this.host.engine;
    this.reset();
    if (e.stroking) { e.endStroke(); this.host.committed(); }
  }
  cancel() {
    if (this.phase === 'idle') return;
    this.reset();
    this.host.engine.cancelStroke();
  }
  /** back to the freehand stroke that was drawn */
  keepFreehand() {
    if (this.phase === 'idle') return;
    this.host.engine.redrawStroke(this.host.freehandDabs());
    this.commit();
  }
  private reset() {
    clearTimeout(this.timer);
    this.phase = 'idle'; this.shape = null; this.anchor = null; this.drag = -1;
    this.bar.classList.remove('show');
    this.host.overlayChanged();
  }

  private redraw() {
    if (!this.shape) return;
    this.host.engine.redrawStroke(this.host.dabsFor(this.shape));
    this.host.overlayChanged();
  }

  private showBar() {
    if (!this.shape) return;
    this.bar.innerHTML = '';
    const lbl = document.createElement('span');
    lbl.textContent = this.phase === 'hold' ? `${this.shape.label} · keep holding to resize, touch a finger for a perfect one` : `${this.shape.label} · drag the points to adjust`;
    const mk = (t: string, cls: string, fn: () => void) => { const b = document.createElement('button'); b.className = cls; b.textContent = t; b.onclick = fn; return b; };
    this.bar.append(lbl);
    if (this.phase === 'edit') this.bar.append(mk('Freehand', 'btn ghost small', () => this.keepFreehand()), mk('Done', 'btn small', () => this.commit()));
    this.bar.classList.add('show');
  }

  /** draw handles on the overlay (screen space, CSS px) */
  drawOverlay(g: CanvasRenderingContext2D) {
    if (this.phase !== 'edit' || !this.shape) return;
    const e = this.host.engine;
    const hs = this.shape.handles();
    if (this.shape.kind === 'ellipse' || this.shape.kind === 'circle') {
      const c = e.docToScreen(hs[0].x, hs[0].y);
      g.setLineDash([4, 4]); g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1;
      for (const i of [1, 2]) { const a = e.docToScreen(hs[i].x, hs[i].y), b = e.docToScreen(hs[i + 2].x, hs[i + 2].y); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
      g.setLineDash([]);
      void c;
    }
    hs.forEach((h, i) => {
      const s = e.docToScreen(h.x, h.y);
      g.beginPath(); g.arc(s.x, s.y, i === this.drag ? 12 : 9, 0, Math.PI * 2);
      g.fillStyle = i === this.drag ? '#e8a54b' : '#ffffff'; g.fill();
      g.lineWidth = 2.5; g.strokeStyle = 'rgba(20,18,17,.85)'; g.stroke();
    });
  }
}

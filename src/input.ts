import type { Engine } from './engine';
import type { Sample } from './stroke';

export interface InputHooks {
  strokeStart(s: Sample, pointerType: string, eraserEnd: boolean): boolean;
  strokeMove(s: Sample[]): void;
  strokeEnd(): void;
  strokeCancel(): void;
  undo(): void;
  redo(): void;
  eyedrop(docX: number, docY: number, done: boolean, sx: number, sy: number): void;
  viewChanged(): void;
  eyedropArmed(): boolean; // one-shot eyedropper button
  /** an on-canvas handle wants this pointer (shape handles, guides, transform box): route it as a "draw" */
  captureAt(sx: number, sy: number, pointerType: string): boolean;
  /** a finger touched while the pen is drawing (used as a modifier, e.g. perfect shapes) */
  secondaryTouch(): void;
}

export type StylusMode = 'auto' | 'pen' | 'any';

/** a modal tool (transform box) that takes every canvas pointer while active */
export interface Grab {
  down(e: PointerEvent, x: number, y: number): void;
  move(e: PointerEvent, x: number, y: number): void;
  up(e: PointerEvent, x: number, y: number): void;
}

interface TouchPt { x: number; y: number; sx: number; sy: number; }

export class Input {
  stylusMode: StylusMode = 'auto';
  penSeen = false;
  private touches = new Map<number, TouchPt>();
  private ignored = new Set<number>();
  private drawId: number | null = null;
  private drawType = '';
  private drawStart = 0;
  private drawMoved = 0;
  private holdTimer: number | null = null;
  private eyedropId: number | null = null;
  private panMouse: { x: number; y: number } | null = null;
  private gesture: {
    t0: number; maxTouches: number; moved: boolean;
    v0: { x: number; y: number; scale: number; rot: number };
    ids: number[]; p0: [TouchPt, TouchPt] | null; held: boolean;
  } | null = null;
  private repeatTimer: number | null = null;
  spaceDown = false;
  grab: Grab | null = null;

  constructor(private el: HTMLElement, private engine: Engine, private hooks: InputHooks) {
    el.addEventListener('pointerdown', this.down, { passive: false });
    el.addEventListener('pointermove', this.move, { passive: false });
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
    el.addEventListener('lostpointercapture', (e) => { if (e.pointerId === this.drawId) this.up(e); });
    el.addEventListener('wheel', this.wheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const t of ['touchstart', 'touchmove', 'gesturestart']) el.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }

  private local(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private sample(e: PointerEvent): Sample {
    const l = this.local(e);
    const d = this.engine.screenToDoc(l.x, l.y);
    const pen = e.pointerType === 'pen';
    let p = pen ? e.pressure : 1;
    if (pen && p === 0 && e.buttons) p = 0.02;
    return { x: d.x, y: d.y, p, tx: pen ? e.tiltX || 0 : 0, ty: pen ? e.tiltY || 0 : 0, t: e.timeStamp };
  }
  private touchDraws() {
    if (this.stylusMode === 'pen') return false;
    if (this.stylusMode === 'any') return true;
    return !this.penSeen;
  }
  private stopRepeat() { if (this.repeatTimer !== null) { clearTimeout(this.repeatTimer); this.repeatTimer = null; } }
  private clearHold() { if (this.holdTimer !== null) { clearTimeout(this.holdTimer); this.holdTimer = null; } }

  private startEyedrop(id: number, sx: number, sy: number) {
    if (this.drawId !== null) { this.hooks.strokeCancel(); this.drawId = null; }
    this.eyedropId = id;
    const d = this.engine.screenToDoc(sx, sy);
    this.hooks.eyedrop(d.x, d.y, false, sx, sy);
  }

  private down = (e: PointerEvent) => {
    e.preventDefault();
    const l = this.local(e);
    try { this.el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    if (this.grab) { if (e.pointerType === 'touch' && e.width * e.height > 4200) return; this.grab.down(e, l.x, l.y); return; }
    if (this.drawId === null && !this.gesture && this.touches.size === 0 && this.hooks.captureAt(l.x, l.y, e.pointerType)) { this.beginDraw(e); return; }
    if (e.pointerType === 'touch') {
      // palm: very large contact patch
      if (e.width * e.height > 4200) { this.ignored.add(e.pointerId); return; }
      if (this.drawId !== null && this.drawType === 'pen') { this.ignored.add(e.pointerId); this.hooks.secondaryTouch(); return; }
      this.touches.set(e.pointerId, { x: l.x, y: l.y, sx: l.x, sy: l.y });
      if (this.touches.size === 1) {
        if (this.hooks.eyedropArmed()) { this.startEyedrop(e.pointerId, l.x, l.y); return; }
        if (this.touchDraws() && this.drawId === null) this.beginDraw(e);
        const id = e.pointerId;
        this.clearHold();
        this.holdTimer = window.setTimeout(() => {
          this.holdTimer = null;
          const t = this.touches.get(id);
          if (t && this.touches.size === 1 && Math.hypot(t.x - t.sx, t.y - t.sy) < 8) this.startEyedrop(id, t.x, t.y);
        }, 480);
      } else {
        this.clearHold();
        if (this.eyedropId !== null) { this.eyedropId = null; }
        if (this.drawId !== null && this.drawType === 'touch') {
          if (performance.now() - this.drawStart < 260 || this.drawMoved < 30) { this.hooks.strokeCancel(); this.drawId = null; }
          else { this.ignored.add(e.pointerId); this.touches.delete(e.pointerId); return; }
        }
        if (this.drawId !== null) return; // pen is drawing; ignore
        this.beginGesture();
      }
      return;
    }
    if (e.pointerType === 'pen') this.penSeen = true;
    if (e.pointerType === 'mouse') {
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) { this.panMouse = { x: l.x, y: l.y }; return; }
      if (e.button === 2) { this.startEyedrop(e.pointerId, l.x, l.y); return; }
      if (e.button !== 0) return;
    }
    if (this.gesture) return;
    if (this.hooks.eyedropArmed()) { this.startEyedrop(e.pointerId, l.x, l.y); return; }
    if (this.drawId !== null) return;
    this.beginDraw(e);
  };

  private beginDraw(e: PointerEvent) {
    // buttons bit 32 = the eraser end of a stylus (or its eraser barrel button)
    const ok = this.hooks.strokeStart(this.sample(e), e.pointerType, e.pointerType === 'pen' && (e.buttons & 32) !== 0);
    if (!ok) return;
    this.drawId = e.pointerId;
    this.drawType = e.pointerType;
    this.drawStart = performance.now();
    this.drawMoved = 0;
  }

  private beginGesture() {
    const ids = [...this.touches.keys()].slice(0, 2);
    const p0 = ids.length === 2 ? [{ ...this.touches.get(ids[0])! }, { ...this.touches.get(ids[1])! }] as [TouchPt, TouchPt] : null;
    const prev = this.gesture;
    this.gesture = {
      t0: prev ? prev.t0 : performance.now(),
      maxTouches: Math.max(prev ? prev.maxTouches : 0, this.touches.size),
      moved: prev ? prev.moved : false,
      v0: { ...this.engine.view }, ids, p0, held: prev ? prev.held : false,
    };
    // two fingers held still: rapid undo, accelerating, until they lift
    if (this.touches.size === 2 && !prev) {
      this.stopRepeat();
      let delay = 260;
      const fire = () => {
        const g = this.gesture;
        if (!g || g.moved || this.touches.size !== 2) { this.repeatTimer = null; return; }
        g.held = true; this.hooks.undo();
        delay = Math.max(70, delay * 0.82);
        this.repeatTimer = window.setTimeout(fire, delay);
      };
      this.repeatTimer = window.setTimeout(fire, 650);
    }
  }

  private move = (e: PointerEvent) => {
    if (this.grab) { const g = this.local(e); this.grab.move(e, g.x, g.y); return; }
    if (this.ignored.has(e.pointerId)) return;
    const l = this.local(e);
    if (this.panMouse) {
      this.engine.view.x += l.x - this.panMouse.x; this.engine.view.y += l.y - this.panMouse.y;
      this.panMouse = l; this.hooks.viewChanged(); return;
    }
    if (e.pointerId === this.eyedropId) {
      const d = this.engine.screenToDoc(l.x, l.y);
      this.hooks.eyedrop(d.x, d.y, false, l.x, l.y);
      const t = this.touches.get(e.pointerId); if (t) { t.x = l.x; t.y = l.y; }
      return;
    }
    if (e.pointerType === 'touch' && e.pointerId !== this.drawId) {
      const t = this.touches.get(e.pointerId);
      if (!t) return;
      t.x = l.x; t.y = l.y;
      if (Math.hypot(t.x - t.sx, t.y - t.sy) > 8) this.clearHold();
      if (this.gesture) { this.updateGesture(); return; }
    }
    if (e.pointerId === this.drawId) {
      const evs = (typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []) as PointerEvent[];
      const list = evs.length ? evs : [e];
      const samples = list.map((x) => this.sample(x));
      this.drawMoved += samples.length;
      this.hooks.strokeMove(samples);
    }
  };

  private updateGesture() {
    const g = this.gesture!;
    if (this.touches.size !== 2 || !g.p0) {
      // 3+ fingers: track movement only (for tap detection)
      for (const t of this.touches.values()) if (Math.hypot(t.x - t.sx, t.y - t.sy) > 14) g.moved = true;
      return;
    }
    const a = this.touches.get(g.ids[0]), b = this.touches.get(g.ids[1]);
    if (!a || !b) return;
    const [p1, p2] = g.p0;
    const d0 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const d1 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const m0 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!g.moved && (Math.abs(d1 - d0) > 14 || Math.hypot(m1.x - m0.x, m1.y - m0.y) > 14)) g.moved = true;
    if (!g.moved) return;
    const v0 = g.v0;
    const scale = Math.min(64, Math.max(0.02, v0.scale * d1 / d0));
    let rot = v0.rot + Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(p2.y - p1.y, p2.x - p1.x);
    // gentle snapping to right angles
    const q = Math.PI / 2, near = Math.round(rot / q) * q;
    if (Math.abs(rot - near) < 0.07) rot = near;
    // doc point under the starting midpoint stays under the fingers
    const ev = this.engine.view;
    const save = { ...ev };
    Object.assign(ev, v0);
    const D = this.engine.screenToDoc(m0.x, m0.y);
    Object.assign(ev, save);
    const c = Math.cos(rot) * scale, s = Math.sin(rot) * scale;
    ev.scale = scale; ev.rot = rot;
    ev.x = m1.x - (c * D.x - s * D.y);
    ev.y = m1.y - (s * D.x + c * D.y);
    this.hooks.viewChanged();
  }

  private up = (e: PointerEvent) => {
    if (this.grab) { const g = this.local(e); this.grab.up(e, g.x, g.y); return; }
    if (this.ignored.delete(e.pointerId)) return;
    if (this.panMouse && e.pointerType === 'mouse') { this.panMouse = null; return; }
    if (e.pointerId === this.eyedropId) {
      const l = this.local(e);
      const d = this.engine.screenToDoc(l.x, l.y);
      this.hooks.eyedrop(d.x, d.y, true, l.x, l.y);
      this.eyedropId = null;
      this.touches.delete(e.pointerId);
      this.clearHold();
      return;
    }
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      this.clearHold();
      if (this.gesture) {
        if (this.touches.size === 0) {
          const g = this.gesture;
          this.gesture = null;
          this.stopRepeat();
          if (!g.moved && !g.held && performance.now() - g.t0 < 380) {
            if (g.maxTouches === 2) this.hooks.undo();
            else if (g.maxTouches === 3) this.hooks.redo();
          }
        } else { this.stopRepeat(); this.beginGesture(); }
      }
    }
    if (e.pointerId === this.drawId) {
      this.drawId = null;
      this.hooks.strokeEnd();
    }
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const v = this.engine.view;
    const D = this.engine.screenToDoc(sx, sy);
    if (e.shiftKey) v.rot += e.deltaY * 0.003;
    else v.scale = Math.min(64, Math.max(0.02, v.scale * Math.exp(-e.deltaY * 0.0015)));
    const c = Math.cos(v.rot) * v.scale, s = Math.sin(v.rot) * v.scale;
    v.x = sx - (c * D.x - s * D.y); v.y = sy - (s * D.x + c * D.y);
    this.hooks.viewChanged();
  };
}

// Reference window: a floating, draggable, resizable panel showing either the whole artwork (live, so you can
// judge the full composition while zoomed in) or a reference image (pan with a drag, pinch or wheel to zoom,
// double-tap to fit). With "Pick colour" on, a tap takes the colour under it.
import type { Engine } from './engine';
import { h } from './dom';

export interface RefHost { engine: Engine; setColor(c: [number, number, number]): void; toast(m: string): void; }

export class ReferenceWindow {
  el: HTMLElement | null = null;
  private cv!: HTMLCanvasElement;
  private mode: 'canvas' | 'image' = 'canvas';
  private img: ImageBitmap | null = null;
  private view = { x: 0, y: 0, k: 1 };
  private pick = false;
  private timer = 0;
  private lastShown = -1;
  private snapshot: HTMLCanvasElement | null = null;
  private geo = { x: 0, y: 0, w: 300, h: 240 };
  constructor(private host: RefHost) {
    try { Object.assign(this.geo, JSON.parse(localStorage.getItem('gesso.ref') || '{}')); } catch { /* defaults */ }
  }
  get open() { return !!this.el; }
  toggle() { if (this.el) this.close(); else this.show(); }
  close() { this.el?.remove(); this.el = null; clearInterval(this.timer); }

  show() {
    if (this.el) return;
    if (!this.geo.x) { this.geo.x = innerWidth - this.geo.w - 90; this.geo.y = 80; }
    this.cv = h('canvas', { class: 'ref-cv' }) as HTMLCanvasElement;
    const head = h('div', { class: 'ref-head' });
    const grip = h('div', { class: 'ref-grip', title: 'Resize' });
    this.el = h('div', { class: 'ref' }, head, this.cv, grip);
    document.body.append(this.el);
    this.place();
    this.renderHead(head);
    // move by the header, resize by the corner
    const drag = (target: HTMLElement, fn: (dx: number, dy: number) => void) => {
      target.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault(); const sx = e.clientX, sy = e.clientY, g0 = { ...this.geo };
        try { target.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        const mv = (ev: PointerEvent) => { Object.assign(this.geo, g0); fn(ev.clientX - sx, ev.clientY - sy); this.place(); };
        const up = () => { target.removeEventListener('pointermove', mv); target.removeEventListener('pointerup', up); this.save(); this.draw(); };
        target.addEventListener('pointermove', mv); target.addEventListener('pointerup', up);
      });
    };
    drag(head, (dx, dy) => { this.geo.x += dx; this.geo.y += dy; });
    drag(grip, (dx, dy) => { this.geo.w = Math.max(180, this.geo.w + dx); this.geo.h = Math.max(140, this.geo.h + dy); });
    this.bindView();
    this.timer = window.setInterval(() => this.refresh(), 400);
    void this.refresh(true);
  }
  private save() { localStorage.setItem('gesso.ref', JSON.stringify(this.geo)); }
  private place() {
    const g = this.geo, el = this.el!;
    g.x = Math.max(0, Math.min(innerWidth - 120, g.x)); g.y = Math.max(0, Math.min(innerHeight - 60, g.y));
    Object.assign(el.style, { left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px' });
  }
  private renderHead(head: HTMLElement) {
    head.innerHTML = '';
    const chip = (label: string, on: boolean, fn: () => void) => h('button', { class: 'chip small' + (on ? ' on' : ''), onClick: () => { fn(); this.renderHead(head); this.draw(); } }, label);
    head.append(
      chip('Canvas', this.mode === 'canvas', () => { this.mode = 'canvas'; void this.refresh(true); }),
      chip('Image', this.mode === 'image', () => { if (this.img) this.mode = 'image'; else this.chooseImage(head); }),
      chip('Pick colour', this.pick, () => { this.pick = !this.pick; }),
      h('button', { class: 'ib small ref-x', title: 'Close', 'aria-label': 'Close reference', onClick: () => this.close() }, '×'));
  }
  chooseImage(head?: HTMLElement) {
    const inp = h('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
    inp.onchange = async () => { const f = inp.files?.[0]; if (f) await this.setImage(f); if (head) this.renderHead(head); };
    inp.click();
  }
  async setImage(blob: Blob) {
    try { this.img?.close(); this.img = await createImageBitmap(blob); this.mode = 'image'; this.fit(); this.draw(); }
    catch { this.host.toast('Could not read that image'); }
  }
  private fit() { const s = this.src(); if (!s) return; const r = this.cv.getBoundingClientRect(); const k = Math.min(r.width / s.width, r.height / s.height); this.view = { k, x: (r.width - s.width * k) / 2, y: (r.height - s.height * k) / 2 }; }
  private src(): { width: number; height: number } | null { return this.mode === 'image' ? this.img : this.snapshot; }

  /** canvas mode: re-read the artwork preview when something changed (cheap async thumbnail) */
  async refresh(force = false) {
    if (!this.el || this.mode !== 'canvas') return;
    const e = this.host.engine;
    const v = e.history.lastTouched ? e.layers.reduce((a, l) => a + l.version, 0) : -2;
    if (!force && v === this.lastShown && this.snapshot) return;
    this.lastShown = v;
    const r = this.cv.getBoundingClientRect();
    this.snapshot = await e.compositeThumbnail(Math.max(64, Math.round(Math.max(r.width, r.height) * Math.min(2, devicePixelRatio || 1))));
    if (force || this.view.k === 1) this.fit();
    this.draw();
  }
  draw() {
    if (!this.el) return;
    const r = this.cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
    if (this.cv.width !== Math.round(r.width * d) || this.cv.height !== Math.round(r.height * d)) { this.cv.width = Math.round(r.width * d); this.cv.height = Math.round(r.height * d); if (this.mode === 'canvas') this.fit(); }
    const g = this.cv.getContext('2d', { willReadFrequently: true })!;   // colour picking reads it back
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.cv.width, this.cv.height);
    const s = this.mode === 'image' ? this.img : this.snapshot; if (!s) return;
    if (this.mode === 'canvas') this.fit();
    g.setTransform(d, 0, 0, d, 0, 0);
    g.imageSmoothingQuality = 'high';
    g.drawImage(s as CanvasImageSource, this.view.x, this.view.y, s.width * this.view.k, s.height * this.view.k);
  }
  private bindView() {
    const cv = this.cv, pts = new Map<number, { x: number; y: number }>();
    let moved = 0, lastTap = 0;
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', (e) => { e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ } pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; });
    cv.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId); if (!p || this.mode !== 'image') return;
      if (pts.size === 1) { this.view.x += e.clientX - p.x; this.view.y += e.clientY - p.y; moved += Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y); }
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()], o = a === p ? b : a;
        const d0 = Math.hypot(p.x - o.x, p.y - o.y), d1 = Math.hypot(e.clientX - o.x, e.clientY - o.y);
        const r = cv.getBoundingClientRect(), cx = (o.x + e.clientX) / 2 - r.left, cy = (o.y + e.clientY) / 2 - r.top;
        this.zoom(d1 / Math.max(1, d0), cx, cy); moved += 10;
      }
      p.x = e.clientX; p.y = e.clientY; this.draw();
    });
    const end = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      if (moved < 6) {
        const now = performance.now();
        if (this.pick) this.pickAt(e);
        else if (now - lastTap < 320) { this.fit(); this.draw(); }
        lastTap = now;
      }
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', (e) => { if (this.mode !== 'image') return; e.preventDefault(); const r = cv.getBoundingClientRect(); this.zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); this.draw(); }, { passive: false });
  }
  private zoom(f: number, cx: number, cy: number) { const v = this.view; const k = Math.max(0.02, Math.min(40, v.k * f)); v.x = cx - (cx - v.x) * k / v.k; v.y = cy - (cy - v.y) * k / v.k; v.k = k; }
  private pickAt(e: PointerEvent) {
    const r = this.cv.getBoundingClientRect(), d = this.cv.width / r.width;
    const px = this.cv.getContext('2d', { willReadFrequently: true })!.getImageData(Math.round((e.clientX - r.left) * d), Math.round((e.clientY - r.top) * d), 1, 1).data;
    if (px[3] < 8) return;
    this.host.setColor([px[0] / 255, px[1] / 255, px[2] / 255]);
  }
}

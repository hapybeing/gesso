// Text tool: tap the canvas to place text, type in the panel, pick a font (system families plus two bundled
// open fonts), size, alignment, weight, slant, line height and letter spacing; drag on the canvas to move it.
// The text renders onto its own layer and stays editable (Layers → Edit text) until the layer is painted on.
import type { Engine, Layer } from './engine';
import type { Input, Grab } from './input';
import type { Stash } from './engine';
import { h } from './dom';

export interface TextSpec {
  text: string; font: string; size: number; color: [number, number, number];
  align: 'left' | 'center' | 'right'; bold: boolean; italic: boolean; lineHeight: number; tracking: number;
  x: number; y: number;
}
export const FONTS: { key: string; label: string; css: string; file?: string }[] = [
  { key: 'sans', label: 'Sans', css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { key: 'serif', label: 'Serif', css: 'Georgia, "Noto Serif", "Times New Roman", serif' },
  { key: 'mono', label: 'Mono', css: 'ui-monospace, "Roboto Mono", Menlo, monospace' },
  { key: 'hand', label: 'Caveat', css: '"Gesso Caveat", cursive', file: 'fonts/caveat.woff2' },
  { key: 'display', label: 'Bebas Neue', css: '"Gesso Bebas", Impact, sans-serif', file: 'fonts/bebas.woff2' },
];
let fontsLoading: Promise<void> | null = null;
/** load the bundled fonts once (they are cached offline by the service worker) */
export function loadBundledFonts(): Promise<void> {
  if (!fontsLoading) fontsLoading = Promise.all(FONTS.filter((f) => f.file).map(async (f) => {
    const fam = f.css.match(/"([^"]+)"/)![1];
    try { const ff = new FontFace(fam, `url(${f.file})`); await ff.load(); document.fonts.add(ff); } catch { /* falls back to the generic family */ }
  })).then(() => {});
  return fontsLoading;
}

/** rasterise text (straight-alpha canvas) and where its top-left lands in the document */
export function renderText(s: TextSpec): { canvas: OffscreenCanvas; x: number; y: number; w: number; h: number } | null {
  const lines = s.text.replace(/\r/g, '').split('\n');
  if (!s.text.trim()) return null;
  const font = FONTS.find((f) => f.key === s.font) ?? FONTS[0];
  const css = `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : '400 '}${s.size}px ${font.css}`;
  const m = new OffscreenCanvas(4, 4).getContext('2d')!;
  m.font = css; (m as unknown as { letterSpacing: string }).letterSpacing = s.tracking + 'px';
  const widths = lines.map((l) => m.measureText(l).width);
  const lh = s.size * s.lineHeight, pad = Math.ceil(s.size * 0.35 + Math.abs(s.tracking));
  const W = Math.ceil(Math.max(1, ...widths)) + pad * 2, H = Math.ceil(lh * (lines.length - 1) + s.size * 1.25) + pad * 2;
  const c = new OffscreenCanvas(W, H), g = c.getContext('2d')!;
  g.font = css; (g as unknown as { letterSpacing: string }).letterSpacing = s.tracking + 'px';
  g.textBaseline = 'alphabetic';
  g.fillStyle = `rgb(${s.color.map((v) => Math.round(v * 255)).join(',')})`;
  lines.forEach((l, i) => {
    const x = s.align === 'left' ? pad : s.align === 'right' ? W - pad - widths[i] : (W - widths[i]) / 2;
    g.fillText(l, x, pad + s.size * 0.95 + i * lh);
  });
  // anchor: x/y is the box's top-left for left text, its top-centre / top-right otherwise
  const ox = s.align === 'left' ? s.x - pad : s.align === 'right' ? s.x - W + pad : s.x - W / 2;
  return { canvas: c, x: Math.round(ox), y: Math.round(s.y - pad), w: W, h: H };
}

export interface TextHost { engine: Engine; input: Input; toast(m: string): void; color(): [number, number, number]; changed(): void; overlayChanged(): void; }

export class TextTool implements Grab {
  layer: Layer | null = null;
  spec: TextSpec | null = null;
  private before: Stash | null = null;
  private isNew = false;
  bar: HTMLElement | null = null;
  armed = false;
  private raf = 0;
  private drag: { x: number; y: number; sx: number; sy: number } | null = null;
  last: TextSpec = { text: '', font: 'sans', size: 72, color: [0, 0, 0], align: 'left', bold: false, italic: false, lineHeight: 1.2, tracking: 0, x: 0, y: 0 };
  constructor(private host: TextHost) {}
  get active() { return this.armed || !!this.layer; }

  /** arm the tool: the next tap places text */
  arm() { void loadBundledFonts(); this.armed = true; this.host.input.grab = this; this.host.toast('Tap the canvas to place text'); this.host.changed(); }
  disarm() { if (this.layer) this.finish(true); this.armed = false; if (this.host.input.grab === this) this.host.input.grab = null; this.host.changed(); }

  /** start a new text at doc (x, y) */
  place(x: number, y: number) {
    const e = this.host.engine;
    const layer = e.addLayerRaw('Text');
    if (!layer) { this.host.toast('Not enough memory for another layer'); return; }
    this.layer = layer; this.isNew = true; this.before = null;
    this.spec = { ...this.last, text: '', color: this.host.color(), x, y, size: this.last.size || Math.round(Math.max(e.w, e.h) / 24) };
    this.openBar(true);
  }
  /** edit an existing text layer (still unpainted) */
  edit(layer: Layer) {
    const e = this.host.engine;
    if (!layer.text) return;
    void loadBundledFonts();
    if (this.layer) this.finish(true);
    this.layer = layer; this.isNew = false; this.spec = { ...(layer.text as TextSpec) };
    this.before = e.stashLayer(layer);
    this.armed = true; this.host.input.grab = this;
    this.openBar(false);
    this.host.changed();
  }
  private openBar(focus: boolean) {
    this.bar?.remove();
    this.bar = h('div', { id: 'textbar' });
    document.body.append(this.bar);
    this.renderBar();
    if (focus) setTimeout(() => (this.bar?.querySelector('textarea') as HTMLTextAreaElement | null)?.focus(), 30);
  }
  private upd() { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.preview()); }
  preview() {
    const e = this.host.engine, s = this.spec, l = this.layer; if (!s || !l) return;
    const r = renderText(s);
    e.drawCanvasToLayer(l, r ? r.canvas : null, r ? r.x : 0, r ? r.y : 0);
    this.host.overlayChanged();
  }
  private renderBar() {
    const s = this.spec!, bar = this.bar!; bar.innerHTML = '';
    const ta = h('textarea', { class: 'text-in', rows: 2, placeholder: 'Type here', spellcheck: false }) as HTMLTextAreaElement;
    ta.value = s.text;
    ta.oninput = () => { s.text = ta.value; this.upd(); };
    const chip = (label: string, on: boolean, fn: () => void, style = '') => h('button', { class: 'chip' + (on ? ' on' : ''), style, onClick: () => { fn(); this.upd(); this.renderBar(); } }, label);
    const big = Math.max(this.host.engine.w, this.host.engine.h);
    const range = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const out = h('b', { class: 'edge-val' }, fmt(get()));
      const r = h('input', { type: 'range', min, max, step, value: get(), class: 'edge-range', 'aria-label': label }) as HTMLInputElement;
      r.oninput = () => { set(+r.value); out.textContent = fmt(+r.value); this.upd(); };
      return h('label', { class: 'edge-row' }, h('span', { class: 'muted' }, label), r, out);
    };
    bar.append(ta,
      h('div', { class: 'chips' }, ...FONTS.map((f) => chip(f.label, s.font === f.key, () => { s.font = f.key; }, `font-family:${f.css.replace(/"/g, "'")}`))),
      h('div', { class: 'text-row' },
        range('Size', 8, Math.round(big / 3), 1, () => s.size, (v) => { s.size = v; }, (v) => v + ' px'),
        range('Line', 0.8, 2.4, 0.05, () => s.lineHeight, (v) => { s.lineHeight = v; }, (v) => v.toFixed(2)),
        range('Spacing', -10, 60, 0.5, () => s.tracking, (v) => { s.tracking = v; }, (v) => v + ' px')),
      h('div', { class: 'chips' },
        chip('Left', s.align === 'left', () => this.realign('left')), chip('Centre', s.align === 'center', () => this.realign('center')), chip('Right', s.align === 'right', () => this.realign('right')),
        chip('Bold', s.bold, () => { s.bold = !s.bold; }), chip('Italic', s.italic, () => { s.italic = !s.italic; }),
        chip('Use current colour', false, () => { s.color = this.host.color(); }),
        h('button', { class: 'btn ghost small', onClick: () => this.finish(false) }, 'Cancel'), h('button', { class: 'btn small', onClick: () => this.finish(true) }, 'Done')),
      h('div', { class: 'muted small' }, 'Drag on the canvas to move the text · Transform it afterwards to rotate or scale'));
  }
  /** change alignment keeping the box where it is */
  private realign(a: TextSpec['align']) {
    const s = this.spec!; const r = renderText(s);
    if (r) { const left = r.x + Math.ceil(s.size * 0.35 + Math.abs(s.tracking)), w = r.w - 2 * Math.ceil(s.size * 0.35 + Math.abs(s.tracking)); s.x = a === 'left' ? left : a === 'right' ? left + w : left + w / 2; }
    s.align = a;
  }
  finish(commit: boolean) {
    const e = this.host.engine, l = this.layer, s = this.spec; if (!l || !s) return;
    cancelAnimationFrame(this.raf);
    this.preview();
    const empty = !s.text.trim();
    if (this.isNew) {
      if (commit && !empty) { l.name = s.text.trim().split('\n')[0].slice(0, 24) || 'Text'; e.recordInsert(l, 'Text'); l.text = { ...s }; l.textVersion = l.version; }
      else e.removeLayerRaw(l);
    } else if (this.before) {
      if (commit) {
        const oldSpec = l.text, newSpec = { ...s };
        e.recordReplace(l, this.before, 'Edit text'); l.text = newSpec; l.textVersion = l.version;
        // undo/redo bring the matching text spec back, so the layer stays editable either way
        const ent = e.history.lastTouched;
        if (ent) { const u = ent.undo, r = ent.redo; ent.undo = () => { u(); l.text = oldSpec; l.textVersion = l.version; }; ent.redo = () => { r(); l.text = newSpec; l.textVersion = l.version; }; }
      }
      else { e.restoreStash(l, this.before); }
    }
    if (commit && !empty) this.last = { ...s, text: '' };
    this.layer = null; this.spec = null; this.before = null;
    this.bar?.remove(); this.bar = null;
    if (!this.armed && this.host.input.grab === this) this.host.input.grab = null;
    this.host.changed(); this.host.overlayChanged();
  }

  // ------------------------------------------------------------------ Grab: tap to place, drag to move
  wants(e: PointerEvent, input: Input) {
    if (e.pointerType !== 'touch') return true;
    return input.stylusMode === 'any' || (input.stylusMode === 'auto' && !input.penSeen) || !this.layer;
  }
  down(_e: PointerEvent, x: number, y: number) {
    const d = this.host.engine.screenToDoc(x, y);
    if (this.layer && this.spec) { this.drag = { x: this.spec.x, y: this.spec.y, sx: d.x, sy: d.y }; return; }
    this.drag = null;
    this.place(d.x, d.y);
  }
  move(_e: PointerEvent, x: number, y: number) {
    if (!this.drag || !this.spec) return;
    const d = this.host.engine.screenToDoc(x, y);
    this.spec.x = this.drag.x + d.x - this.drag.sx; this.spec.y = this.drag.y + d.y - this.drag.sy;
    this.upd();
  }
  up() { this.drag = null; }
  drawOverlay(g: CanvasRenderingContext2D) {
    const s = this.spec; if (!s || !this.layer) return;
    const r = renderText(s.text.trim() ? s : { ...s, text: 'M' }); if (!r) return;
    const e = this.host.engine;
    const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => e.docToScreen(x, y));
    g.save(); g.setLineDash([5, 4]); g.lineWidth = 1.2; g.strokeStyle = 'rgba(232,165,75,.95)';
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.stroke(); g.restore();
  }
}

// Adjustments menu and the live panel for each filter. Sliders preview on the next animation frame; Liquify
// takes the pen (or a finger when no stylus is known) as its brush, with a size ring on the overlay.
import type { Engine } from './engine';
import type { Input, Grab } from './input';
import { h } from './dom';
import { AdjustSession, AdjKind, ADJ_LABEL, defaultParams, GRADIENTS, curveLut, AdjParams } from './adjust';

export interface AdjustHost {
  engine: Engine; input: Input;
  toast(m: string): void;
  overlayChanged(): void;
  /** called whenever a session opens or closes (button states, autosave) */
  changed(): void;
}

const KINDS: AdjKind[] = ['hsb', 'balance', 'curves', 'gradmap', 'blur', 'sharpen', 'noise', 'liquify'];
const LIQ_MODES: [string, string][] = [['push', 'Push'], ['twirl', 'Twirl ↻'], ['twirlCcw', 'Twirl ↺'], ['pinch', 'Pinch'], ['expand', 'Expand'], ['reconstruct', 'Restore']];
const CURVE_COLOURS = ['#eee', '#ff5a5a', '#5ad16a', '#5a9bff'];

export class AdjustUI implements Grab {
  s: AdjustSession | null = null;
  bar: HTMLElement | null = null;
  private raf = 0;
  private last: { x: number; y: number } | null = null;
  private hover: { x: number; y: number } | null = null;
  constructor(private host: AdjustHost) {}

  get active() { return !!this.s; }

  renderMenu(el: HTMLElement, close: () => void) {
    el.innerHTML = '';
    el.append(h('div', { class: 'pop-head' }, h('b', {}, 'Adjustments')));
    const e = this.host.engine;
    const list = h('div', { class: 'adj-list' });
    for (const k of KINDS) list.append(h('button', { class: 'adj-item', onClick: () => { close(); this.open(k); } }, ADJ_LABEL[k]));
    el.append(list, h('div', { class: 'muted small' }, e.activeLayer.group ? 'Pick a layer (not a group) to adjust' : e.sel ? 'Applies inside the selection' : 'Applies to the active layer'));
  }

  open(kind: AdjKind) {
    const e = this.host.engine;
    if (this.s) this.close(true);
    if (e.activeLayer.group) { this.host.toast('Pick a layer (not a group) to adjust'); return; }
    this.s = new AdjustSession(e, kind, defaultParams(kind));
    if (kind === 'liquify') this.host.input.grab = this;
    this.bar = h('div', { id: 'adjbar' });
    document.body.append(this.bar);
    this.render();
    this.host.changed();
  }
  close(commit: boolean) {
    const s = this.s; if (!s) return;
    cancelAnimationFrame(this.raf);
    if (commit) s.commit(); else s.cancel();
    this.s = null;
    if (this.host.input.grab === this) this.host.input.grab = null;
    this.bar?.remove(); this.bar = null; this.hover = null;
    this.host.overlayChanged();
    this.host.changed();
  }
  private upd(p: AdjParams) {
    const s = this.s!; s.params = { ...s.params, ...p };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.s?.preview());
  }

  private slider(label: string, key: string, min: number, max: number, fmt: (v: number) => string, idx = -1, step = 1) {
    const s = this.s!;
    const get = () => (idx >= 0 ? (s.params[key] as number[])[idx] : +s.params[key]);
    const out = h('b', { class: 'edge-val' }, fmt(get()));
    const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()), class: 'edge-range', 'aria-label': label }) as HTMLInputElement;
    r.oninput = () => {
      const v = +r.value;
      if (idx >= 0) { const a = [...(s.params[key] as number[])]; a[idx] = v; this.upd({ [key]: a }); } else this.upd({ [key]: v });
      out.textContent = fmt(v);
    };
    r.ondblclick = () => { r.value = String(idx >= 0 ? 0 : (defaultParams(s.kind)[key] as number)); r.dispatchEvent(new Event('input')); };
    return h('label', { class: 'edge-row' }, h('span', { class: 'muted' }, label), r, out);
  }
  private chips(opts: [string | number, string][], cur: string | number, pick: (v: string | number) => void) {
    return h('div', { class: 'chips' }, ...opts.map(([v, l]) => h('button', { class: 'chip' + (v === cur ? ' on' : ''), onClick: () => { pick(v); this.render(); } }, l)));
  }

  render() {
    const s = this.s, bar = this.bar; if (!s || !bar) return;
    bar.innerHTML = '';
    const P = s.params;
    const pct = (v: number) => (v > 0 ? '+' : '') + Math.round(v) + '%';
    const body = h('div', { class: 'adj-body' });
    switch (s.kind) {
      case 'hsb':
        body.append(this.slider('Hue', 'hue', -180, 180, (v) => (v > 0 ? '+' : '') + v + '°'), this.slider('Saturation', 'sat', -100, 100, pct), this.slider('Brightness', 'bri', -100, 100, pct));
        break;
      case 'balance': {
        const range = String(P.range) as 'shadows' | 'mid' | 'hi';
        body.append(this.chips([['shadows', 'Shadows'], ['mid', 'Midtones'], ['hi', 'Highlights']], range, (v) => { s.params.range = v as string; }),
          this.slider('Cyan · Red', range, -100, 100, pct, 0), this.slider('Magenta · Green', range, -100, 100, pct, 1), this.slider('Yellow · Blue', range, -100, 100, pct, 2),
          h('div', { class: 'chips' }, h('button', { class: 'chip' + (P.keepLum ? ' on' : ''), onClick: () => { this.upd({ keepLum: !P.keepLum }); s.params.keepLum = !P.keepLum; this.render(); } }, 'Preserve brightness')));
        break;
      }
      case 'curves': body.append(this.curveEditor()); break;
      case 'gradmap':
        body.append(h('div', { class: 'chips grads' }, ...GRADIENTS.map((g, i) => h('button', {
          class: 'chip grad' + (+P.gradient === i ? ' on' : ''), title: g.name,
          style: `background:linear-gradient(90deg,${g.stops.map(([x, c]) => c + ' ' + x * 100 + '%').join(',')})`,
          onClick: () => { this.upd({ gradient: i }); s.params.gradient = i; this.render(); },
        }, h('span', {}, g.name)))), this.slider('Strength', 'amount', 0, 100, (v) => v + '%'));
        break;
      case 'blur': body.append(this.slider('Radius', 'radius', 0, 200, (v) => v + ' px', -1, 0.5)); break;
      case 'sharpen': body.append(this.slider('Amount', 'amount', 0, 200, (v) => v + '%'), this.slider('Radius', 'radius', 1, 20, (v) => v + ' px')); break;
      case 'noise':
        body.append(this.slider('Amount', 'amount', 0, 100, (v) => v + '%'), this.slider('Grain size', 'scale', 1, 8, (v) => v + ' px'),
          h('div', { class: 'chips' }, h('button', { class: 'chip' + (P.mono ? ' on' : ''), onClick: () => { s.params.mono = !P.mono; this.upd({}); this.render(); } }, 'Monochrome'),
            h('button', { class: 'chip', onClick: () => this.upd({ seed: Math.random() }) }, 'New pattern')));
        break;
      case 'liquify':
        body.append(this.chips(LIQ_MODES, String(P.mode), (v) => { s.params.mode = v as string; }),
          this.slider('Size', 'size', 10, 600, (v) => v + ' px'), this.slider('Strength', 'strength', 5, 100, (v) => v + '%'),
          h('div', { class: 'chips' }, h('button', { class: 'chip', onClick: () => s.resetLiquify() }, 'Reset all')));
        break;
    }
    bar.append(h('b', { class: 'adj-title' }, ADJ_LABEL[s.kind]), body,
      h('div', { class: 'chips' }, h('button', { class: 'btn ghost small', onClick: () => this.close(false) }, 'Cancel'), h('button', { class: 'btn small', onClick: () => this.close(true) }, 'Apply')));
  }

  /** curve editor: tap to add a point, drag to move, drag a point off the box to remove; channels Master/R/G/B */
  private curveEditor() {
    const s = this.s!;
    const W = 220;
    const cv = h('canvas', { width: W * 2, height: W * 2, class: 'curve-ed', style: `width:${W}px;height:${W}px` }) as HTMLCanvasElement;
    const g = cv.getContext('2d')!;
    const curves = () => s.params.curves as [number, number][][];
    const ch = () => +s.params.channel;
    const draw = () => {
      g.setTransform(2, 0, 0, 2, 0, 0); g.clearRect(0, 0, W, W);
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, W, W);
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
      for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(i * W / 4, 0); g.lineTo(i * W / 4, W); g.moveTo(0, i * W / 4); g.lineTo(W, i * W / 4); g.stroke(); }
      curves().forEach((pts, c) => {
        const lut = curveLut(pts);
        g.strokeStyle = CURVE_COLOURS[c]; g.globalAlpha = c === ch() ? 1 : 0.35; g.lineWidth = c === ch() ? 2 : 1;
        g.beginPath(); for (let i = 0; i < 256; i++) { const x = i / 255 * W, y = (1 - lut[i]) * W; if (i) g.lineTo(x, y); else g.moveTo(x, y); } g.stroke();
      });
      g.globalAlpha = 1; g.fillStyle = CURVE_COLOURS[ch()];
      for (const [x, y] of curves()[ch()]) { g.beginPath(); g.arc(x * W, (1 - y) * W, 6, 0, Math.PI * 2); g.fill(); }
    };
    let drag = -1;
    const at = (ev: PointerEvent) => { const r = cv.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width, 1 - (ev.clientY - r.top) / r.height] as [number, number]; };
    cv.onpointerdown = (ev) => {
      ev.preventDefault(); cv.setPointerCapture(ev.pointerId);
      const [x, y] = at(ev), pts = curves()[ch()];
      drag = pts.findIndex(([px, py]) => Math.hypot((px - x) * W, (py - y) * W) < 16);
      if (drag < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); drag = pts.findIndex((p) => p[0] === x && p[1] === y); }
      this.upd({}); draw();
    };
    cv.onpointermove = (ev) => {
      if (drag < 0) return;
      const pts = curves()[ch()]; let [x, y] = at(ev);
      const outside = x < -0.08 || x > 1.08 || y < -0.08 || y > 1.08;
      const end = drag === 0 || drag === pts.length - 1;
      if (outside && !end && pts.length > 2) { pts.splice(drag, 1); drag = -1; }
      else {
        x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));
        const lo = drag > 0 ? pts[drag - 1][0] + 0.01 : 0, hi = drag < pts.length - 1 ? pts[drag + 1][0] - 0.01 : 1;
        pts[drag] = [Math.max(lo, Math.min(hi, x)), y];
      }
      this.upd({}); draw();
    };
    cv.onpointerup = () => { drag = -1; };
    draw();
    return h('div', { class: 'curve-wrap' }, cv, h('div', { class: 'curve-side' },
      this.chips([[0, 'Master'], [1, 'Red'], [2, 'Green'], [3, 'Blue']], ch(), (v) => { s.params.channel = v as number; }),
      h('button', { class: 'chip', onClick: () => { curves()[ch()] = [[0, 0], [1, 1]]; this.upd({}); this.render(); } }, 'Reset channel'),
      h('div', { class: 'muted small' }, 'Tap to add a point · drag it off the box to remove')));
  }

  // ------------------------------------------------------------------ liquify brush (Grab)
  wants(e: PointerEvent, input: Input) {
    if (e.pointerType !== 'touch') return true;
    return input.stylusMode === 'any' || (input.stylusMode === 'auto' && !input.penSeen);
  }
  private dab(ev: PointerEvent, x: number, y: number) {
    const s = this.s; if (!s || s.kind !== 'liquify') return;
    const e = this.host.engine, d = e.screenToDoc(x, y);
    const P = s.params, r = +P.size / 2;
    const pr = ev.pointerType === 'pen' ? Math.max(0.15, ev.pressure || 0.5) : 1;
    const evs = ev.getCoalescedEvents?.() ?? [];
    const pts = evs.length ? evs.map((c) => e.screenToDoc(c.clientX - (ev.clientX - x), c.clientY - (ev.clientY - y))) : [d];
    for (const p of pts) {
      const last = this.last ?? p;
      const vx = p.x - last.x, vy = p.y - last.y;
      const dist = Math.hypot(vx, vy);
      if (P.mode === 'push') {
        if (dist < 0.5) continue;
        // split long moves so the push follows the path (each step at most a quarter radius)
        const n = Math.max(1, Math.ceil(dist / (r * 0.25)));
        for (let i = 1; i <= n; i++) s.liquifyDab(last.x + vx * i / n, last.y + vy * i / n, r, vx / n, vy / n, (+P.strength / 100) * pr, 'push');
      } else s.liquifyDab(p.x, p.y, r, 0, 0, (+P.strength / 100) * pr * 0.6, String(P.mode));
      this.last = p;
    }
    this.hover = d; this.host.overlayChanged();
  }
  private held = 0;
  down(ev: PointerEvent, x: number, y: number) {
    this.last = this.host.engine.screenToDoc(x, y);
    this.dab(ev, x, y);
    // twirl/pinch/expand keep working while the pen rests
    clearInterval(this.held);
    const s = this.s;
    if (s && s.params.mode !== 'push') this.held = window.setInterval(() => {
      const P = s.params, pr = ev.pointerType === 'pen' ? Math.max(0.15, ev.pressure || 0.5) : 1;
      if (this.last && this.s === s) s.liquifyDab(this.last.x, this.last.y, +P.size / 2, 0, 0, (+P.strength / 100) * pr * 0.6, String(P.mode));
    }, 33);
  }
  move(ev: PointerEvent, x: number, y: number) { this.dab(ev, x, y); }
  up() { clearInterval(this.held); this.last = null; }
  drawOverlay(g: CanvasRenderingContext2D) {
    const s = this.s; if (!s || s.kind !== 'liquify' || !this.hover) return;
    const e = this.host.engine, c = e.docToScreen(this.hover.x, this.hover.y), r = (+s.params.size / 2) * e.view.scale;
    g.lineWidth = 1.5; g.strokeStyle = 'rgba(0,0,0,.6)'; g.beginPath(); g.arc(c.x, c.y, r + 1, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(c.x, c.y, r, 0, Math.PI * 2); g.stroke();
  }
}

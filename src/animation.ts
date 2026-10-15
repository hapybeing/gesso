// Animation assist: every visible layer is a frame (clipping layers ride with the frame below them). The compositor
// gets a draw list per frame: background/foreground layers that show on every frame, onion skins (count before and
// after, falloff, before/after tints), light-table pins, and the current frame. Playback follows the wall clock, so
// holds and FPS stay exact even when a display frame is dropped.
import type { Engine, Layer, DrawItem } from './engine';
import { h } from './dom';
import { dragSort } from './dragsort';
import { AnimAudio, drawWave } from './animaudio';

export type PlayMode = 'loop' | 'pingpong' | 'oneshot';
export interface AnimState {
  on: boolean;
  fps: number;
  mode: PlayMode;
  onionBefore: number; onionAfter: number; onionOpacity: number;
  tint: 'off' | 'redgreen' | 'blueorange';
  blendPrimary: boolean;
  /** onion skins wrap around the ends (for cycles) */
  onionWrap: boolean;
  lightOpacity: number;
  /** extra display frames per frame (uid → n) */
  holds: Record<string, number>;
  /** layers shown under ("bg") or over ("fg") every frame */
  roles: Record<string, 'bg' | 'fg'>;
  /** light-table pins: frames always shown faintly */
  pins: string[];
  /** hidden layers are frames too (off: hidden layers are left out, as before) */
  includeHidden: boolean;
}
export const defaultAnim = (): AnimState => ({ on: false, fps: 12, mode: 'loop', onionBefore: 2, onionAfter: 1, onionOpacity: 0.45, tint: 'redgreen', blendPrimary: false, onionWrap: false, lightOpacity: 0.3, holds: {}, roles: {}, pins: [], includeHidden: false });
const TINTS: Record<AnimState['tint'], [[number, number, number], [number, number, number]] | null> = {
  off: null,
  redgreen: [[0.86, 0.22, 0.2], [0.16, 0.6, 0.3]],
  blueorange: [[0.2, 0.42, 0.9], [0.95, 0.55, 0.12]],
};
const PIN_TINT: [number, number, number] = [0.45, 0.45, 0.62];

export interface Frame { base: Layer; clips: Layer[]; }
export interface AnimHost {
  engine: Engine;
  toast(m: string): void;
  changed(): void;              // anim settings changed (save soon)
  openExport(): void;
  layerLimit(): void;
  layout(): void;               // the timeline appeared/disappeared: refit the canvas
  /** the artwork's audio track (M5.5) */
  audio?: AnimAudio;
  /** pick and import an audio file */
  importAudio?(): void;
  /** transform tween from the current frame: n in-betweens, then the end pose set with the transform box */
  tween?(n: number, ease: Ease): void;
}
export type Ease = 'linear' | 'in' | 'out' | 'inout';
export const EASE: Record<Ease, (t: number) => number> = { linear: (t) => t, in: (t) => t * t, out: (t) => 1 - (1 - t) * (1 - t), inout: (t) => t * t * (3 - 2 * t) };

export class Animator {
  st: AnimState = defaultAnim();
  playing = false;
  private t0 = 0; private raf = 0; private shownTick = -1;
  private lastFrame: string | null = null;
  bar: HTMLElement | null = null;
  private pop: HTMLElement | null = null;
  private thumbs = new Map<string, { v: number; c: HTMLCanvasElement }>();
  /** playback stats (tests / tuning) */
  stats = { shown: 0, late: 0 };

  constructor(private host: AnimHost) {}
  get e() { return this.host.engine; }
  get on() { return this.st.on; }

  load(x: Partial<AnimState> | undefined) {
    this.stop();
    this.st = { ...defaultAnim(), ...(x || {}) };
    this.thumbs.clear();
    if (this.st.on) this.mount(); else this.unmount();
    this.apply();
  }
  toggle(on = !this.st.on) {
    this.st.on = on; this.stop();
    if (on) this.mount(); else this.unmount();
    this.apply(); this.host.changed(); this.host.layout();
    if (on) this.host.toast(this.frames().length + ' frames · ' + this.st.fps + ' fps');
  }

  // ---------------------------------------------------------------- model
  frames(): Frame[] {
    const out: Frame[] = [];
    for (const l of this.e.layers) {
      if (l.parent) continue;                 // a group is one frame: its members are drawn with it
      if (this.st.roles[l.uid]) continue;
      const vis = l.visible || this.st.includeHidden;
      if (l.clip && !l.group && out.length && vis && !out[out.length - 1].base.group) { out[out.length - 1].clips.push(l); continue; }
      if (!vis || l.clip) continue;
      out.push({ base: l, clips: [] });
    }
    return out;
  }
  hold(l: Layer) { return Math.max(0, this.st.holds[l.uid] || 0); }
  /** index of the frame being edited (follows the active layer) */
  current(fr = this.frames()): number {
    if (!fr.length) return -1;
    const a = this.e.activeLayer;
    let i = fr.findIndex((f) => f.base === a || f.clips.includes(a) || this.e.isInside(a, f.base));
    if (i < 0 && this.lastFrame) i = fr.findIndex((f) => f.base.uid === this.lastFrame);
    if (i < 0) i = 0;
    this.lastFrame = fr[i].base.uid;
    return i;
  }
  /** frame index per display tick for one cycle of the play mode */
  ticks(fr = this.frames()): number[] {
    const fwd: number[] = [];
    fr.forEach((f, i) => { for (let k = 0; k <= this.hold(f.base); k++) fwd.push(i); });
    if (this.st.mode !== 'pingpong' || fr.length < 3) return fwd;
    const back: number[] = [];
    for (let i = fr.length - 2; i >= 1; i--) for (let k = 0; k <= this.hold(fr[i].base); k++) back.push(i);
    return fwd.concat(back);
  }
  /** first display tick of frame i in the forward order (its time = tickStart / fps) */
  tickStart(i: number, fr = this.frames()) { let t = 0; for (let j = 0; j < i && j < fr.length; j++) t += this.hold(fr[j].base) + 1; return t; }
  /** seconds in one cycle of the play mode */
  cycleSeconds(fr = this.frames()) { return this.ticks(fr).length / this.st.fps; }
  get audio() { return this.host.audio; }
  /** runs of [frame, ticks] for export */
  runs(fr = this.frames()): [number, number][] {
    const out: [number, number][] = [];
    for (const i of this.ticks(fr)) { const r = out[out.length - 1]; if (r && r[0] === i) r[1]++; else out.push([i, 1]); }
    return out;
  }

  /** what the compositor draws for frame i */
  list(i: number, onion: boolean, fr = this.frames()): DrawItem[] {
    const items: DrawItem[] = [];
    const roleItems = (role: 'bg' | 'fg') => {
      let clipBase: Layer | null = null;
      for (const l of this.e.layers) {
        if (l.parent || this.st.roles[l.uid] !== role) continue;
        if (!l.clip || l.group) clipBase = l.group ? null : l;
        if (!l.visible || l.opacity <= 0) continue;
        items.push(...this.e.itemsFor(l, l.opacity, l.blend, undefined, l.clip && clipBase !== l ? clipBase : null));
      }
    };
    const unit = (f: Frame, opacity: number, tint?: [number, number, number, number], keepBlend = false) => {
      items.push(...this.e.itemsFor(f.base, opacity * (keepBlend ? f.base.opacity : 1), keepBlend ? f.base.blend : 0, tint));
      for (const c of f.clips) items.push({ layer: c, opacity: opacity * (keepBlend ? c.opacity : 1), blend: keepBlend ? c.blend : 0, tint, clipBase: f.base });
    };
    roleItems('bg');
    if (onion && i >= 0) {
      const tints = TINTS[this.st.tint];
      const amt = tints ? 0.8 : 0;
      // nearest frames claim their slot first (matters when wrapping round a short cycle), then draw far → near
      const N = fr.length, nb = this.st.onionBefore, na = this.st.onionAfter;
      const shown = new Set<number>([i]);
      const picks: { j: number; k: number; n: number; tint: [number, number, number] | null }[] = [];
      for (let k = 1; k <= Math.max(nb, na); k++) {
        for (const [dir, n, tint] of [[-1, nb, tints ? tints[0] : null], [1, na, tints ? tints[1] : null]] as [number, number, [number, number, number] | null][]) {
          if (k > n) continue;
          let j = i + dir * k;
          if (this.st.onionWrap && N > 2) j = ((j % N) + N) % N;
          if (j < 0 || j >= N || shown.has(j)) continue;
          shown.add(j); picks.push({ j, k, n, tint });
        }
      }
      // light-table pins that are not already onion skins go underneath everything else
      for (const uid of this.st.pins) {
        const k = fr.findIndex((f) => f.base.uid === uid);
        if (k >= 0 && !shown.has(k)) unit(fr[k], this.st.lightOpacity, [...PIN_TINT, 0.7]);
      }
      picks.sort((x, y) => y.k - x.k);
      for (const p of picks) {
        const fall = p.n > 1 ? 1 - (0.6 * (p.k - 1)) / (p.n - 1) : 1;
        unit(fr[p.j], this.st.onionOpacity * fall, p.tint ? [...p.tint, amt] : undefined);
      }
    }
    if (i >= 0 && fr[i]) unit(fr[i], onion && this.st.blendPrimary ? 0.65 : 1, undefined, true);
    roleItems('fg');
    return items;
  }

  /** point the compositor at the right draw list */
  apply() {
    const e = this.e;
    if (!this.st.on) { if (e.drawList) { e.drawList = null; e.markDirty(); } return; }
    const fr = this.frames();
    const i = this.playing ? this.tickFrame(fr) : this.current(fr);
    e.drawList = this.list(i, !this.playing, fr);
    e.markDirty();
    this.renderBar();
  }
  /** the current frame for the time-lapse (no onion skins) */
  captureList(): DrawItem[] | undefined { if (!this.st.on) return undefined; const fr = this.frames(); return this.list(this.current(fr), false, fr); }

  goto(i: number, scrub = false) {
    const fr = this.frames(); if (!fr.length) return;
    i = Math.max(0, Math.min(fr.length - 1, i));
    // frame stepping plays that frame's slice of the audio (for lip-sync)
    if (scrub && !this.playing && this.audio?.ready) this.audio.scrub(this.tickStart(i, fr) / this.st.fps, (this.hold(fr[i].base) + 1) / this.st.fps);
    this.e.active = this.e.layers.indexOf(fr[i].base);
    this.lastFrame = fr[i].base.uid;
    this.apply();
    this.e.onLayersChanged();
  }
  step(d: number) {
    const fr = this.frames(); if (!fr.length) return;
    const n = fr.length; let i = this.current(fr) + d;
    i = this.st.mode === 'oneshot' ? Math.max(0, Math.min(n - 1, i)) : ((i % n) + n) % n;
    this.goto(i, true);
  }

  // ---------------------------------------------------------------- playback
  private tickFrame(fr: Frame[]): number {
    const t = this.ticks(fr);
    if (!t.length) return -1;
    const k = this.shownTick < 0 ? 0 : this.shownTick;
    return t[Math.min(k, t.length - 1)];
  }
  play() {
    if (this.playing || !this.st.on) return;
    const fr = this.frames(); if (fr.length < 2) { this.host.toast('Add a second frame to play'); return; }
    this.playing = true;
    // start from the current frame
    const t = this.ticks(fr), cur = this.current(fr);
    const startTick = Math.max(0, t.indexOf(cur));
    this.t0 = performance.now() - (startTick * 1000) / this.st.fps;
    // audio starts with the picture; the picture waits for the output latency so lips land on the sound
    const au = this.audio?.ready ? this.audio : null;
    if (au) { au.playFrom(startTick / this.st.fps, (t.length - startTick) / this.st.fps); this.t0 += au.latency() * 1000; }
    let cycle = 0;
    this.shownTick = -1;
    this.stats = { shown: 0, late: 0 };
    const loop = () => {
      if (!this.playing) return;
      this.raf = requestAnimationFrame(loop);
      const ft = this.frames(), tt = this.ticks(ft);
      let k = Math.floor(((performance.now() - this.t0) * this.st.fps) / 1000);
      if (this.st.mode === 'oneshot' && k >= tt.length) { this.stop(); this.goto(tt[tt.length - 1]); return; }
      const cyc = Math.floor(Math.max(0, k) / tt.length);
      if (cyc !== cycle) { cycle = cyc; if (au) au.playFrom(0, tt.length / this.st.fps); }   // every cycle restarts the sound
      k = ((k % tt.length) + tt.length) % tt.length;
      if (k === this.shownTick) return;
      if (this.shownTick >= 0 && k !== (this.shownTick + 1) % tt.length) this.stats.late++;
      const prevFrame = this.shownTick >= 0 ? tt[this.shownTick] : -1;
      this.shownTick = k;
      if (tt[k] === prevFrame) return; // a hold: nothing to redraw
      this.e.drawList = this.list(tt[k], false, ft);
      this.e.markDirty();
      this.stats.shown++;
      this.highlight(tt[k]);
    };
    this.raf = requestAnimationFrame(loop);
    this.renderBar();
  }
  stop() {
    if (!this.playing) return;
    this.playing = false; cancelAnimationFrame(this.raf);
    this.audio?.stop();
    this.shownTick = -1;
    this.apply();
  }
  togglePlay() { if (this.playing) this.stop(); else this.play(); }

  // ---------------------------------------------------------------- frame edits
  addFrame() {
    const e = this.e; const fr = this.frames(); const cur = this.current(fr);
    if (cur >= 0) { const f = fr[cur]; e.active = e.layers.indexOf(f.clips.length ? f.clips[f.clips.length - 1] : f.base); }
    const l = e.addLayer();
    if (!l) { this.host.layerLimit(); return; }
    l.name = 'Frame ' + (this.frames().findIndex((f) => f.base === l) + 1);
    this.lastFrame = l.uid; this.apply();
  }
  duplicateFrame() {
    const e = this.e; const fr = this.frames(); const cur = this.current(fr); if (cur < 0) return;
    e.active = e.layers.indexOf(fr[cur].base);
    const hold = this.hold(fr[cur].base), before = this.timing();
    e.history.beginGroup();
    const l = e.duplicateLayer();
    if (l && hold) { this.st.holds[l.uid] = hold; this.recordTiming('Hold', before); }
    e.history.endGroup('Duplicate frame');
    if (!l) { this.host.layerLimit(); return; }
    this.lastFrame = l.uid; this.apply(); this.host.changed();
  }
  deleteFrame() {
    const e = this.e; const fr = this.frames(); const cur = this.current(fr); if (cur < 0) return;
    if (e.layers.length <= 1) { this.host.toast('The last frame cannot be deleted'); return; }
    e.active = e.layers.indexOf(fr[cur].base);
    e.deleteLayer();
    const after = this.frames(); if (after.length) this.goto(Math.min(cur, after.length - 1));
  }
  moveFrame(d: -1 | 1) { const cur = this.current(); this.moveFrameTo(cur, cur + d); }
  /** move frame `from` to position `to` (frame indices), one undo step; units = frame + its clipping layers */
  moveFrameTo(from: number, to: number) {
    const e = this.e; let fr = this.frames();
    if (from < 0 || from >= fr.length || to < 0 || to >= fr.length || from === to) return;
    const a = fr[from];
    e.history.beginGroup();
    for (let i = from; i !== to; i += to > from ? 1 : -1) {
      fr = this.frames();
      const cur = fr.indexOf(fr.find((f) => f.base === a.base)!), nb = cur + (to > from ? 1 : -1);
      // swap adjacent units: the upper unit's layers move down to the lower unit's base
      const b = fr[nb];
      const [lower, upper] = to > from ? [fr[cur], b] : [b, fr[cur]];
      const target = lower.base.group ? e.blockOf(lower.base)[0] : e.layers.indexOf(lower.base);
      const ul = upper.base.group ? e.layers.slice(e.blockOf(upper.base)[0], e.blockOf(upper.base)[1] + 1) : [upper.base, ...upper.clips];
      ul.forEach((l, k) => e.moveLayer(e.layers.indexOf(l), target + k));
    }
    e.history.endGroup('Move frame');
    e.active = e.layers.indexOf(a.base);
    this.apply();
  }
  // Holds, under/over roles and pins are undo steps (R3 debt): each edit snapshots the three maps before and after.
  private timing() { return JSON.stringify({ holds: this.st.holds, roles: this.st.roles, pins: this.st.pins }); }
  private restoreTiming(j: string) { const t = JSON.parse(j); this.st.holds = t.holds; this.st.roles = t.roles; this.st.pins = t.pins; this.barKey = ''; this.apply(); this.host.changed(); }
  /** push one undo step for a timing edit; `before` from timing() taken before the change */
  recordTiming(label: string, before: string) {
    const after = this.timing(); if (after === before) return;
    this.e.history.push({ label, bytes: 64 + before.length + after.length, undo: () => this.restoreTiming(before), redo: () => this.restoreTiming(after) });
  }
  setHold(l: Layer, n: number) {
    const b = this.timing(); n = Math.max(0, Math.min(120, Math.round(n))); if (n) this.st.holds[l.uid] = n; else delete this.st.holds[l.uid];
    this.recordTiming('Hold', b); this.apply(); this.host.changed();
  }
  setRole(l: Layer, r: 'bg' | 'fg' | null) { const b = this.timing(); if (r) this.st.roles[l.uid] = r; else delete this.st.roles[l.uid]; this.recordTiming(r ? (r === 'bg' ? 'Show under every frame' : 'Show over every frame') : 'Make frame', b); this.apply(); this.host.changed(); }
  togglePin(l: Layer) { const b = this.timing(); const i = this.st.pins.indexOf(l.uid); if (i >= 0) this.st.pins.splice(i, 1); else this.st.pins.push(l.uid); this.recordTiming(i >= 0 ? 'Unpin' : 'Pin', b); this.apply(); this.host.changed(); }
  set<K extends keyof AnimState>(k: K, v: AnimState[K]) { this.st[k] = v; if (this.playing && k === 'fps') { this.stop(); this.play(); } this.apply(); this.host.changed(); }

  // ---------------------------------------------------------------- timeline UI
  private mount() {
    if (this.bar) return;
    this.bar = h('div', { id: 'timeline' });
    document.body.append(this.bar);
    document.body.classList.add('anim-on');
    this.renderBar();
  }
  private unmount() { this.closePop(); this.bar?.remove(); this.bar = null; document.body.classList.remove('anim-on'); }
  closePop() { this.pop?.remove(); this.pop = null; }

  private barKey = '';
  renderBar() {
    const bar = this.bar; if (!bar) return;
    const fr = this.frames(), cur = this.current(fr);
    const au = this.audio?.ready ? this.audio : null;
    const key = JSON.stringify([fr.map((f) => [f.base.uid, this.hold(f.base), this.st.pins.includes(f.base.uid)]), cur, this.playing, this.st.fps, this.st.mode, this.e.w, this.e.h, au ? [au.meta!.offset, au.meta!.muted, au.duration] : 0]);
    if (key === this.barKey) { this.updateThumbs(); return; }
    this.barKey = key;
    bar.innerHTML = '';
    const total = this.ticks(fr).length;
    const ctl = h('div', { class: 'tl-ctl' },
      h('button', { class: 'ib', title: this.playing ? 'Pause' : 'Play', 'aria-label': this.playing ? 'Pause' : 'Play', onClick: () => this.togglePlay() }, icon(this.playing ? 'M8 5v14M16 5v14' : 'M7 4.5v15l12.5-7.5z')),
      h('button', { class: 'ib', title: 'Animation settings', 'aria-label': 'Animation settings', onClick: () => this.openSettings() }, icon('M4 7h10M18 7h2M4 17h4M12 17h8M16 4v6M10 14v6')),
    );
    if (this.audio) ctl.append(h('button', { class: 'ib' + (au ? ' on' : ''), title: au ? 'Audio · ' + au.meta!.name : 'Add audio (lip-sync)', 'aria-label': 'Audio', onClick: (ev: Event) => this.openAudio(ev.currentTarget as HTMLElement) }, icon('M9 18V6l10-2v12M9 18a3 3 0 11-6 0 3 3 0 016 0zm10-2a3 3 0 11-6 0 3 3 0 016 0z')));
    const strip = h('div', { class: 'tl-strip' + (au ? ' has-audio' : '') });
    let tick = 0;
    const tw = 64, th = Math.max(28, Math.min(64, Math.round((tw * this.e.h) / this.e.w)));
    fr.forEach((f, i) => {
      const t = this.thumbFor(f.base, tw, th);
      const hold = this.hold(f.base);
      const cell = h('div', { class: 'tl-cell' + (i === cur ? ' on' : '') + (this.st.pins.includes(f.base.uid) ? ' pinned' : ''), 'data-i': String(i) },
        t, h('span', { class: 'tl-num' }, String(i + 1)));
      cell.onclick = () => { if (this.playing) this.stop(); if (i === cur) this.openFrameOptions(cell, f); else this.goto(i, true); };
      const grp = h('div', { class: 'tl-unit' }, cell);
      if (hold) grp.append(h('div', { class: 'tl-hold', style: `width:${Math.min(240, hold * 12)}px`, title: `Held for ${hold + 1} frames` }, h('span', {}, '+' + hold)));
      if (au) {
        // the sound heard while this frame is on screen, under the frame (and its hold)
        const t0 = tick / this.st.fps, t1 = (tick + hold + 1) / this.st.fps, off = au.meta!.offset;
        const wv = h('canvas', { class: 'tl-wave', height: 32 }) as HTMLCanvasElement;
        grp.append(wv);
        requestAnimationFrame(() => { const w = Math.max(8, cell.offsetWidth + ((grp.querySelector('.tl-hold') as HTMLElement | null)?.offsetWidth ?? 0) - 2); wv.width = w * 2; wv.style.width = w + 'px'; drawWave(wv, au.peaks!, t0 + off, t1 + off); });
      }
      tick += hold + 1;
      // drag the grip sideways to change the hold (12 px per frame)
      const grip = h('div', { class: 'tl-grip', title: 'Drag to hold this frame longer' });
      grip.onpointerdown = (ev) => {
        ev.stopPropagation(); grip.setPointerCapture(ev.pointerId);
        const x0 = ev.clientX, h0 = hold, before = this.timing();
        grip.onpointermove = (m) => { const n = Math.max(0, h0 + Math.round((m.clientX - x0) / 12)); if (n !== this.hold(f.base)) { this.st.holds[f.base.uid] = n; if (!n) delete this.st.holds[f.base.uid]; const hd = grp.querySelector('.tl-hold') as HTMLElement | null; if (hd) { hd.style.width = Math.min(240, n * 12) + 'px'; hd.firstElementChild!.textContent = '+' + n; } } };
        grip.onpointerup = grip.onpointercancel = () => { grip.onpointermove = null; this.recordTiming('Hold', before); this.barKey = ''; this.apply(); this.host.changed(); };
      };
      grp.append(grip);
      strip.append(grp);
    });
    dragSort({ scroller: strip, axis: 'x', items: () => [...strip.querySelectorAll<HTMLElement>('.tl-unit')],
      onDrop: (from, to) => { if (this.playing) this.stop(); this.moveFrameTo(from, to > from ? to - 1 : to); } });
    strip.append(h('button', { class: 'tl-add', title: 'New frame', 'aria-label': 'New frame', onClick: () => this.addFrame() }, '+'));
    const info = h('div', { class: 'tl-info muted' }, `${cur + 1}/${fr.length}`, h('br'), `${this.st.fps} fps · ${(total / this.st.fps).toFixed(1)} s`);
    bar.append(ctl, strip, info);
    const on = strip.querySelector('.tl-cell.on') as HTMLElement | null;
    if (on) requestAnimationFrame(() => on.scrollIntoView({ inline: 'nearest', block: 'nearest' }));
    this.updateThumbs();
  }
  private highlight(i: number) {
    if (!this.bar) return;
    this.bar.querySelectorAll('.tl-cell').forEach((c) => c.classList.toggle('play', (c as HTMLElement).dataset.i === String(i)));
  }
  private thumbFor(l: Layer, w: number, hh: number) {
    let t = this.thumbs.get(l.uid);
    if (!t || t.c.width !== w || t.c.height !== hh) { t = { v: -1, c: h('canvas', { width: w, height: hh, class: 'tl-thumb' }) as HTMLCanvasElement }; this.thumbs.set(l.uid, t); }
    return t.c;
  }
  private thumbTimer = 0;
  updateThumbs() {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => {
      if (this.e.stroking) { this.updateThumbs(); return; }
      for (const f of this.frames()) { const t = this.thumbs.get(f.base.uid); const v = this.e.contentVersion(f.base); if (t && t.v !== v) { t.v = v; void this.e.thumbnailAsync(f.base, t.c); } }
    }, 120);
  }

  private popAt(anchor: HTMLElement | null, cls: string) {
    this.closePop();
    const p = h('div', { class: 'anim-pop ' + cls });
    document.body.append(p);
    if (anchor) { const r = anchor.getBoundingClientRect(); p.style.left = Math.max(8, Math.min(innerWidth - 330, r.left + r.width / 2 - 160)) + 'px'; }
    const close = (ev: PointerEvent) => { if (!p.contains(ev.target as Node) && !(anchor && anchor.contains(ev.target as Node))) { this.closePop(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
    this.pop = p;
    return p;
  }

  openFrameOptions(anchor: HTMLElement, f: Frame) {
    const p = this.popAt(anchor, 'fopts');
    const draw = () => {
      p.innerHTML = '';
      const hold = this.hold(f.base), fr = this.frames(), i = fr.indexOf(fr.find((x) => x.base === f.base)!);
      const btn = (label: string, fn: () => void, dis = false) => h('button', { class: 'chip', disabled: dis, onClick: () => { fn(); draw(); } }, label);
      p.append(
        h('div', { class: 'pop-head' }, h('b', {}, 'Frame ' + (i + 1)), f.base.name !== 'Frame ' + (i + 1) ? h('span', { class: 'muted' }, f.base.name) : ''),
        h('div', { class: 'fo-row' }, h('span', {}, 'Hold'), h('button', { class: 'ib small', onClick: () => { this.setHold(f.base, hold - 1); draw(); } }, '−'),
          h('b', { class: 'fo-val' }, `${hold + 1} frame${hold ? 's' : ''}`), h('button', { class: 'ib small', onClick: () => { this.setHold(f.base, hold + 1); draw(); } }, '+'),
          h('span', { class: 'muted' }, `${((hold + 1) / this.st.fps).toFixed(2)} s`)),
        h('div', { class: 'chips' },
          btn('Duplicate', () => { this.duplicateFrame(); this.closePop(); }),
          btn('Insert blank', () => { this.addFrame(); this.closePop(); }),
          btn('◀ Move', () => this.moveFrame(-1), i <= 0), btn('Move ▶', () => this.moveFrame(1), i >= fr.length - 1),
          btn(this.st.pins.includes(f.base.uid) ? 'Unpin from light table' : 'Pin to light table', () => this.togglePin(f.base)),
          this.host.tween && !f.base.group ? btn('Tween…', () => this.openTween(anchor)) : null,
          h('button', { class: 'chip danger-text', disabled: this.e.layers.length <= 1, onClick: () => { this.deleteFrame(); this.closePop(); } }, 'Delete')),
        h('div', { class: 'fo-row' }, h('span', { class: 'muted' }, 'Show on every frame'),
          btn('Under', () => { this.setRole(f.base, 'bg'); this.closePop(); }), btn('Over', () => { this.setRole(f.base, 'fg'); this.closePop(); })),
      );
      const roles = this.e.layers.filter((l) => this.st.roles[l.uid]);
      if (roles.length) p.append(h('div', { class: 'fo-row' }, h('span', { class: 'muted' }, 'On every frame:'), ...roles.map((l) => h('button', { class: 'chip on', title: 'Make it a frame again', onClick: () => { this.setRole(l, null); draw(); } }, `${l.name} (${this.st.roles[l.uid] === 'bg' ? 'under' : 'over'}) ×`))));
    };
    draw();
  }

  private tweenN = 4; private tweenEase: Ease = 'inout';
  /** tween options, then the end pose in the transform box */
  openTween(anchor: HTMLElement | null) {
    const p = this.popAt(anchor, 'fopts');
    const draw = () => {
      p.innerHTML = '';
      const n = this.tweenN;
      p.append(h('div', { class: 'pop-head' }, h('b', {}, 'Tween')),
        h('p', { class: 'muted' }, 'Move, scale or rotate a copy of this frame into its end pose; Gesso draws the frames in between.'),
        h('div', { class: 'fo-row' }, h('span', {}, 'In-betweens'), h('button', { class: 'ib small', onClick: () => { this.tweenN = Math.max(1, n - 1); draw(); } }, '−'),
          h('b', { class: 'fo-val' }, String(n)), h('button', { class: 'ib small', onClick: () => { this.tweenN = Math.min(48, n + 1); draw(); } }, '+'),
          h('span', { class: 'muted' }, `${n + 2} frames · ${((n + 1) / this.st.fps).toFixed(2)} s`)),
        h('div', { class: 'chips' }, ...([['linear', 'Linear'], ['in', 'Ease in'], ['out', 'Ease out'], ['inout', 'Ease in & out']] as [Ease, string][]).map(([k, l]) =>
          h('button', { class: 'chip' + (this.tweenEase === k ? ' on' : ''), onClick: () => { this.tweenEase = k; draw(); } }, l))),
        h('div', { class: 'chips' }, h('button', { class: 'btn small', onClick: () => { this.closePop(); this.host.tween!(this.tweenN, this.tweenEase); } }, 'Set end pose…')));
    };
    draw();
  }

  /** audio track: import / replace, shift, volume, mute, scrub, remove */
  openAudio(anchor: HTMLElement | null) {
    const a = this.audio; if (!a) return;
    const p = this.popAt(anchor, 'asettings');
    const draw = () => {
      p.innerHTML = '';
      const m = a.ready ? a.meta! : null, fps = this.st.fps;
      p.append(h('div', { class: 'pop-head' }, h('b', {}, 'Audio'), m ? h('span', { class: 'muted' }, m.name) : ''));
      if (!m) {
        p.append(h('p', { class: 'muted' }, 'Add a voice line or music to time the animation to it. Its waveform shows under each frame for exactly the time that frame is on screen; stepping frames plays that slice so mouth shapes land on the syllables. Exported with MP4 and WebM.'),
          h('div', { class: 'chips' }, h('button', { class: 'btn small', onClick: () => { this.closePop(); this.host.importAudio?.(); } }, 'Import audio…')));
        return;
      }
      const shiftF = Math.round(m.offset * fps * 100) / 100;
      const set = (k: 'offset' | 'volume', v: number) => { m[k] = v; a.applyVolume(); this.barKey = ''; this.apply(); this.host.changed(); };
      const nudge = (df: number) => h('button', { class: 'chip', onClick: () => { set('offset', Math.round((m.offset - df / fps) * 1e6) / 1e6); draw(); } }, df < 0 ? '◀ ' + -df : df + ' ▶');
      const vol = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(m.volume * 100)) }) as HTMLInputElement;
      const vv = h('b', { class: 'fo-val' }, Math.round(m.volume * 100) + '%');
      vol.oninput = () => { vv.textContent = vol.value + '%'; set('volume', +vol.value / 100); };
      p.append(
        h('p', { class: 'muted' }, `${a.duration.toFixed(2)} s of audio · ${this.cycleSeconds().toFixed(2)} s of animation per cycle`),
        h('h4', {}, 'Sync'),
        h('div', { class: 'fo-row' }, h('span', {}, 'Shift'), nudge(-1), h('b', { class: 'fo-val' }, (shiftF > 0 ? '−' : shiftF < 0 ? '+' : '') + Math.abs(shiftF) + ' fr'), nudge(1),
          h('span', { class: 'muted' }, `${Math.round(-m.offset * 1000)} ms`)),
        h('p', { class: 'muted small' }, '◀ makes the sound come earlier, ▶ later.'),
        h('label', { class: 'srow' }, h('span', {}, 'Volume'), vol, vv),
        h('div', { class: 'chips' },
          h('button', { class: 'chip' + (m.muted ? ' on' : ''), onClick: () => { m.muted = !m.muted; a.applyVolume(); this.barKey = ''; this.apply(); this.host.changed(); draw(); } }, 'Mute'),
          h('button', { class: 'chip' + (m.scrub ? ' on' : ''), title: 'Play each frame’s slice of sound when you step or tap frames', onClick: () => { m.scrub = !m.scrub; this.host.changed(); draw(); } }, 'Hear frames when stepping'),
          h('button', { class: 'chip', onClick: () => { this.closePop(); this.host.importAudio?.(); } }, 'Replace…'),
          h('button', { class: 'chip danger-text', onClick: () => { void a.remove().then(() => { this.barKey = ''; this.apply(); this.host.changed(); }); this.closePop(); } }, 'Remove')),
      );
    };
    draw();
  }

  openSettings() {
    const p = this.popAt(null, 'asettings');
    const draw = () => {
      p.innerHTML = '';
      const s = this.st;
      const seg = <T extends string>(opts: [T, string][], cur: T, fn: (v: T) => void) => h('div', { class: 'chips' }, ...opts.map(([v, l]) => h('button', { class: 'chip' + (v === cur ? ' on' : ''), onClick: () => { fn(v); draw(); } }, l)));
      const range = (label: string, min: number, max: number, step: number, v: number, fmt: (v: number) => string, fn: (v: number) => void) => {
        const out = h('b', { class: 'fo-val' }, fmt(v));
        const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(v) }) as HTMLInputElement;
        r.oninput = () => { out.textContent = fmt(+r.value); fn(+r.value); };
        return h('label', { class: 'srow' }, h('span', {}, label), r, out);
      };
      p.append(
        h('div', { class: 'pop-head' }, h('b', {}, 'Animation'), h('button', { class: 'btn ghost small', onClick: () => { this.toggle(false); this.closePop(); } }, 'Turn off')),
        h('h4', {}, 'Playback'),
        seg<PlayMode>([['loop', 'Loop'], ['pingpong', 'Ping-pong'], ['oneshot', 'One shot']], s.mode, (v) => this.set('mode', v)),
        range('Frames per second', 1, 60, 1, s.fps, (v) => v + ' fps', (v) => this.set('fps', v)),
        h('div', { class: 'chips' }, ...[6, 8, 12, 15, 24, 30].map((f) => h('button', { class: 'chip' + (s.fps === f ? ' on' : ''), onClick: () => { this.set('fps', f); draw(); } }, String(f)))),
        h('div', { class: 'chips' }, h('button', { class: 'chip' + (s.includeHidden ? ' on' : ''), title: 'Hidden layers become frames too (off: hiding a layer takes it out of the animation)', onClick: () => { this.set('includeHidden', !s.includeHidden); this.barKey = ''; this.apply(); draw(); } }, 'Include hidden layers')),
        h('h4', {}, 'Onion skin'),
        range('Frames before', 0, 12, 1, s.onionBefore, (v) => String(v), (v) => this.set('onionBefore', v)),
        range('Frames after', 0, 12, 1, s.onionAfter, (v) => String(v), (v) => this.set('onionAfter', v)),
        range('Opacity', 0, 100, 1, Math.round(s.onionOpacity * 100), (v) => v + '%', (v) => this.set('onionOpacity', v / 100)),
        seg<AnimState['tint']>([['redgreen', 'Red / green'], ['blueorange', 'Blue / orange'], ['off', 'True colour']], s.tint, (v) => this.set('tint', v)),
        h('div', { class: 'chips' }, h('button', { class: 'chip' + (s.blendPrimary ? ' on' : ''), onClick: () => { this.set('blendPrimary', !s.blendPrimary); draw(); } }, 'Blend current frame'),
          h('button', { class: 'chip' + (s.onionWrap ? ' on' : ''), title: 'Show the last frames before frame 1 (and the first after the last) — for loops and cycles', onClick: () => { this.set('onionWrap', !s.onionWrap); draw(); } }, 'Wrap around (cycles)')),
        h('h4', {}, 'Light table'),
        range('Pinned frames', 5, 80, 1, Math.round(s.lightOpacity * 100), (v) => v + '%', (v) => this.set('lightOpacity', v / 100)),
        h('p', { class: 'muted' }, s.pins.length ? `${s.pins.length} pinned — tap a frame twice → Unpin.` : 'Pin key poses (tap a frame twice → Pin) to keep them visible while you draw in-betweens anywhere in the timeline.'),
        h('h4', {}, 'Export'),
        h('div', { class: 'chips' }, h('button', { class: 'btn small', onClick: () => { this.closePop(); this.host.openExport(); } }, 'Export animation…')),
      );
    };
    draw();
  }
}

function icon(d: string) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  return t.content.firstChild as SVGElement;
}

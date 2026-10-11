// Time-lapse: every committed change (stroke, fill, undo…) becomes one video frame. The composite is downscaled on
// the GPU (≤1080p), read back asynchronously and handed to a hardware/software WebCodecs encoder, so a step costs one
// small async readback plus an encode on the codec's own thread. Encoded chunks are tiny (one stroke ≈ a few KB),
// batched into IndexedDB packs, and survive reloads (each session is a new keyframe-started segment).
// Without WebCodecs, frames are stored as small WebP images and exported through MediaRecorder instead.
import type { Engine, DrawItem } from './engine';
import { store, TlPack } from './store';
import { evenFit, pickEncoder, hasWebCodecs, Clip, ClipFrame, decodeClip, ClipSeeker, VideoWriter, mux, canMux, sleep, toBytes } from './video';
import type { Sample, TrackInfo } from './mux';
import { h } from './dom';
import { ask } from './gallery';

export const TL_FPS = 30;
const FRAME_US = 1e6 / TL_FPS;
const END_HOLD_US = 2e6;          // the finished artwork stays on screen for 2 s at the end
const SHORT_TOTAL_US = 30e6;      // the short version: about 30 seconds including the end hold
const KEY_EVERY = 90;             // keyframe every 3 s of video (bounds scrubbing cost)

export interface TlState { on: boolean; }

export class TimelapseRecorder {
  enabled = true;
  docId: string | null = null;
  /** frames recorded for this document (persisted + pending), for the UI */
  frames = 0;
  /** what to draw for a frame (animation mode supplies the current frame without onion skins) */
  list: () => DrawItem[] | null | undefined = () => undefined;
  blocked: () => boolean = () => false;
  /** main-thread cost of the last capture (ms) and running stats, for tests */
  stats = { captures: 0, mainMs: 0, lastMainMs: 0, bytes: 0 };

  private seg = -1; private seq = 0;
  private ready: Promise<void> = Promise.resolve();
  private enc: VideoEncoder | null = null;
  private encCfg: VideoEncoderConfig | null = null;
  private decCfg: TlPack['config'] = null;
  private kind: 'video' | 'img' | null = null;
  private w = 0; private h = 0;
  private segFrames = 0;
  private areas: number[] = [];          // FIFO of areas for frames handed to the encoder
  private pending: TlPack['frames'] = [];
  private timer = 0; private persistTimer = 0;
  private busy = false;
  private nextArea = 0;

  constructor(private engine: Engine) {}

  /** start recording a document (fresh = brand new, so its blank canvas becomes frame 0) */
  attach(docId: string, enabled: boolean) {
    this.detach();
    this.docId = docId; this.enabled = enabled;
    this.frames = 0; this.seg = -1; this.seq = 0; this.kind = null; this.w = 0; this.h = 0; this.queue = [];
    this.ready = (async () => {
      try {
        const last = await store.lastTl(docId);
        this.seq = last.next; this.seg = last.seg + 1;
        this.frames = last.next ? (await store.getTl(docId)).reduce((s, p) => s + p.frames.length, 0) : 0;
      } catch { this.seq = 0; this.seg = 0; }
    })();
  }

  /** stop recording the current document; pending frames are flushed in the background */
  detach() {
    clearTimeout(this.timer); clearTimeout(this.persistTimer);
    const enc = this.enc, docId = this.docId;
    this.enc = null; this.docId = null; this.segFrames = 0;
    if (docId && enc) {
      const done = this.ready.then(() => enc.flush()).catch(() => {}).then(() => { try { enc.close(); } catch { /* closed */ } return this.persistNow(docId); });
      this.ready = done.catch(() => {});
    } else if (docId) void this.persistNow(docId);
  }

  /**
   * Something was committed: read the composite back right now (async PBO, so it is the exact state after this
   * step even if the next step follows immediately) and queue it for the encoder. Captures pipeline on the GPU;
   * only if the encoder falls far behind are steps merged.
   */
  request(area: number) {
    if (!this.enabled || !this.docId) return;
    this.nextArea = Math.max(this.nextArea, area);
    clearTimeout(this.timer);
    if (this.engine.stroking || this.blocked()) { this.timer = window.setTimeout(() => this.request(0), 150); return; }
    if (this.queue.length >= 6) { this.timer = window.setTimeout(() => this.request(0), 100); return; }
    const t0 = performance.now();
    const e = this.engine;
    if (!this.w) { const v = evenFit(e.w, e.h, 1920, 1080); this.w = v.w; this.h = v.h; }
    const px = e.captureScaled(this.w, this.h, { flatten: e.flattenColour, list: this.list() });
    this.queue.push({ px, area: Math.max(0.0005, Math.min(1, this.nextArea || 0.01)), docId: this.docId, w: this.w, h: this.h, ms: performance.now() - t0 });
    this.nextArea = 0;
    void this.pump();
  }
  /** capture right away (tests, and the first frame of a new artwork) */
  async capture() { this.request(1); await this.drained(); }
  private queue: { px: Promise<Uint8Array>; area: number; docId: string; w: number; h: number; ms: number }[] = [];
  private async drained() { while (this.queue.length || this.busy) await sleep(20); }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.ready;
      while (this.queue.length) {
        const q = this.queue[0];
        try {
          if (q.docId !== this.docId) continue;
          if (!this.kind) await this.init();
          const data = await q.px;
          if (q.docId !== this.docId) continue;
          const t1 = performance.now();
          if (this.kind === 'video' && this.enc) {
            const f = new VideoFrame(data, { format: 'RGBX', codedWidth: q.w, codedHeight: q.h, timestamp: Math.round(this.segFrames * FRAME_US) } as VideoFrameBufferInit);
            this.areas.push(q.area);
            this.enc.encode(f, { keyFrame: this.segFrames % KEY_EVERY === 0 });
            f.close();
            this.segFrames++;
            this.note(q.ms + performance.now() - t1);
          } else if (this.kind === 'img') {
            const c = new OffscreenCanvas(q.w, q.h);
            c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer), q.w, q.h), 0, 0);
            const s = new OffscreenCanvas(this.imgW, this.imgH);
            s.getContext('2d')!.drawImage(c, 0, 0, this.imgW, this.imgH);
            this.note(q.ms + performance.now() - t1);
            const blob = await s.convertToBlob({ type: 'image/webp', quality: 0.8 });
            if (q.docId === this.docId) this.pushFrame({ key: true, data: await blob.arrayBuffer(), area: q.area });
          }
        } catch (err) { console.info('time-lapse capture failed', err); }
        finally { this.queue.shift(); }
      }
    } finally { this.busy = false; }
  }
  private imgW = 0; private imgH = 0;
  private note(ms: number) { this.stats.captures++; this.stats.mainMs += ms; this.stats.lastMainMs = ms; }

  private async init() {
    const e = this.engine;
    if (!this.w) { const v = evenFit(e.w, e.h, 1920, 1080); this.w = v.w; this.h = v.h; }
    // realtime mode: far less CPU per frame (battery), at a slightly larger size per step
    const cfg = await pickEncoder(this.w, this.h, ['avc', 'vp9', 'vp8'], Math.round(Math.min(10e6, Math.max(2e6, this.w * this.h * 3))), 'realtime');
    if (cfg) {
      this.kind = 'video'; this.encCfg = cfg; this.decCfg = null; this.segFrames = 0;
      this.enc = new VideoEncoder({
        output: (c, meta) => {
          if (meta?.decoderConfig) {
            const d = meta.decoderConfig;
            this.decCfg = { codec: d.codec, codedWidth: d.codedWidth || this.w, codedHeight: d.codedHeight || this.h, description: d.description ? toBytes(d.description) : undefined };
          }
          const buf = new ArrayBuffer(c.byteLength); c.copyTo(buf);
          this.pushFrame({ key: c.type === 'key', data: buf, area: this.areas.shift() ?? 0.01 });
        },
        error: (err) => { console.info('time-lapse encoder error', err); this.enc = null; this.kind = null; },
      });
      this.enc.configure(cfg);
    } else {
      const s = evenFit(e.w, e.h, 960, 960);
      this.kind = 'img'; this.imgW = s.w; this.imgH = s.h;
      this.decCfg = { codec: 'img', codedWidth: s.w, codedHeight: s.h };
    }
  }

  private pushFrame(f: TlPack['frames'][number]) {
    this.pending.push(f);
    this.frames++;
    this.stats.bytes += f.data.byteLength;
    if (this.pending.length >= 24) void this.persistNow(this.docId);
    else { clearTimeout(this.persistTimer); this.persistTimer = window.setTimeout(() => void this.persistNow(this.docId), 2500); }
  }

  private persistChain: Promise<void> = Promise.resolve();
  /** write pending frames as one pack */
  persistNow(docId: string | null): Promise<void> {
    if (!docId || !this.pending.length) return this.persistChain;
    const pack: TlPack = { seg: this.seg, config: this.decCfg, w: this.kind === 'img' ? this.imgW : this.w, h: this.kind === 'img' ? this.imgH : this.h, frames: this.pending };
    this.pending = [];
    const seq = this.seq++;
    this.persistChain = this.persistChain.then(() => store.putTl(docId, seq, pack)).catch((err) => console.info('time-lapse save failed', err));
    return this.persistChain;
  }

  /** everything recorded so far is in storage (encoder drained) */
  async flush() {
    await this.ready;
    await this.drained();
    if (this.enc) { try { await this.enc.flush(); } catch { /* closed */ } }
    await this.persistNow(this.docId);
  }

  /** resolves once a detached document's last frames have been written */
  async idle() { await this.ready; await this.persistChain; }

  /** delete the recording of the current document */
  async purge() {
    const id = this.docId; if (!id) return;
    const enabled = this.enabled;
    this.detach();
    await this.ready;
    await this.persistChain;
    this.pending = [];
    await store.clearTl(id);
    this.attach(id, enabled);
  }
}

// ------------------------------------------------------------------ loading + frame selection
export async function loadClip(docId: string): Promise<Clip & { kind: 'video' | 'img' }> {
  const packs = await store.getTl(docId);
  const configs = new Map<number, VideoDecoderConfig>();
  const frames: ClipFrame[] = [];
  let w = 0, h = 0, kind: 'video' | 'img' = 'video';
  for (const p of packs) {
    if (p.config) {
      if (p.config.codec === 'img') kind = 'img';
      if (!configs.has(p.seg)) configs.set(p.seg, { codec: p.config.codec, codedWidth: p.config.codedWidth, codedHeight: p.config.codedHeight, ...(p.config.description ? { description: p.config.description } : {}) });
    }
    w = p.w; h = p.h;
    for (const f of p.frames) frames.push({ seg: p.seg, key: f.key, data: new Uint8Array(f.data), area: f.area });
  }
  // a segment whose first pack lacked a config (encoder had not reported yet) borrows the next pack's
  for (const p of packs) if (!configs.has(p.seg) && p.config) configs.set(p.seg, p.config as VideoDecoderConfig);
  // drop frames of segments we cannot decode or that do not start with a keyframe
  const ok = new Set<number>(); const seen = new Set<number>();
  const out = frames.filter((f) => {
    if (!seen.has(f.seg)) { seen.add(f.seg); if (f.key && configs.has(f.seg)) ok.add(f.seg); }
    return ok.has(f.seg);
  });
  return { w, h, configs, frames: out, kind };
}

/**
 * Frames to show and how long each stays. Full length: every step at 30 fps. Short: about 30 s, chosen so screen
 * time follows visual change — each step is weighted by the area it touched (plus a uniform share so detail
 * passes still appear), and frames are sampled evenly along the cumulative weight. Big early blocking-in
 * strokes keep most of their frames; long runs of tiny detail strokes are compressed.
 */
export function selectFrames(frames: { area: number }[], short: boolean): { idx: number[]; durs: number[] } {
  const N = frames.length;
  const all = () => { const idx = frames.map((_, i) => i); const durs = idx.map(() => FRAME_US); if (N) durs[N - 1] += END_HOLD_US; return { idx, durs }; };
  const T = Math.floor((SHORT_TOTAL_US - END_HOLD_US) / FRAME_US);
  if (!short || N <= T) return all();
  const sumA = frames.reduce((s, f) => s + Math.max(0.002, f.area), 0);
  // each step's share of the T output frames, capped at one frame (water-filling the excess onto the rest)
  const sh = frames.map((f) => T * (0.35 / N + (0.65 * Math.max(0.002, f.area)) / sumA));
  for (let it = 0; it < 30; it++) {
    let excess = 0, free = 0;
    for (const v of sh) { if (v > 1) excess += v - 1; else if (v < 1) free += v; }
    if (excess < 1e-6 || free <= 0) break;
    const k = (free + excess) / free;
    for (let i = 0; i < N; i++) sh[i] = sh[i] >= 1 ? 1 : Math.min(1, sh[i] * k);
  }
  const idx: number[] = [];
  let cum = 0, k = 0;
  for (let i = 0; i < N; i++) {
    cum += sh[i];
    if (cum >= k + 0.5) { idx.push(i); while (cum >= k + 0.5) k++; }
  }
  if (idx[0] !== 0) idx.unshift(0);
  if (idx[idx.length - 1] !== N - 1) idx.push(N - 1);
  const durs = idx.map(() => FRAME_US); durs[durs.length - 1] += END_HOLD_US;
  return { idx, durs };
}

const sameConfig = (a: VideoDecoderConfig, b: VideoDecoderConfig) => {
  if (a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) return false;
  const x = a.description ? toBytes(a.description) : null, y = b.description ? toBytes(b.description) : null;
  if (!x || !y) return !x && !y;
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export interface ExportResult { blob: Blob; ext: string; frames: number; seconds: number; transcoded: boolean; ms: number; codec: string; }

/** render a stored time-lapse to a video file */
export async function exportClip(clip: Clip & { kind: 'video' | 'img' }, short: boolean, fmt: 'mp4' | 'webm', progress: (t: number) => void = () => {}, forceTranscode = false): Promise<ExportResult> {
  const t0 = performance.now();
  const sel = selectFrames(clip.frames, short);
  const seconds = sel.durs.reduce((a, b) => a + b, 0) / 1e6;
  if (clip.kind === 'img' || !hasWebCodecs()) {
    const blob = await recordImages(clip, sel, progress);
    return { blob, ext: blob.type.includes('mp4') ? 'mp4' : 'webm', frames: sel.idx.length, seconds, transcoded: true, ms: performance.now() - t0, codec: blob.type };
  }
  const cfgs = [...clip.configs.values()];
  const codec = cfgs[0].codec;
  const uniform = cfgs.every((c) => sameConfig(c, cfgs[0]));
  // MP4 should be H.264 when this device can encode it (what every app and site accepts)
  const wantAvc = fmt === 'mp4' && !codec.startsWith('avc1') && !!(await pickEncoder(clip.w, clip.h, ['avc']));
  const direct = !short || sel.idx.length === clip.frames.length;
  if (direct && uniform && canMux(codec, fmt) && !wantAvc && !forceTranscode) {
    const samples: Sample[] = clip.frames.map((f, i) => ({ data: f.data, key: f.key, dur: sel.durs[i] }));
    const track: TrackInfo = { codec, width: cfgs[0].codedWidth!, height: cfgs[0].codedHeight!, description: cfgs[0].description ? toBytes(cfgs[0].description) : undefined };
    progress(1);
    return { blob: mux(fmt, track, samples), ext: fmt, frames: samples.length, seconds, transcoded: false, ms: performance.now() - t0, codec };
  }
  // transcode: decode the chosen frames, re-encode into the target codec
  const families: ('avc' | 'vp9' | 'vp8')[] = fmt === 'mp4' ? ['avc', 'vp9'] : ['vp9', 'vp8'];
  const cfg = await pickEncoder(clip.w, clip.h, families);
  if (!cfg) throw new Error(fmt === 'mp4' ? 'This device cannot encode MP4 video — try WebM' : 'This device cannot encode WebM video — try MP4');
  const writer = new VideoWriter(cfg, KEY_EVERY);
  const durOf = new Map(sel.idx.map((i, k) => [i, sel.durs[k]]));
  const order = new Map(sel.idx.map((i, k) => [i, k]));
  try {
    await decodeClip(clip, async (i, f) => {
      const k = order.get(i)!;
      const g = new VideoFrame(f, { timestamp: k * 1000 });
      try { await writer.add(g, durOf.get(i)!, k === 0); } finally { g.close(); }
      progress((k + 1) / sel.idx.length);
    }, new Set(sel.idx));
    const { track, samples } = await writer.finish();
    return { blob: mux(fmt, track, samples), ext: fmt, frames: samples.length, seconds, transcoded: true, ms: performance.now() - t0, codec: cfg.codec };
  } catch (err) { writer.close(); throw err; }
}

/** fallback export: play the stored images into a canvas stream and record it in real time */
async function recordImages(clip: Clip, sel: { idx: number[]; durs: number[] }, progress: (t: number) => void): Promise<Blob> {
  const c = document.createElement('canvas'); c.width = clip.w; c.height = clip.h;
  const g = c.getContext('2d')!;
  const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('Video export is not supported in this browser');
  const stream = c.captureStream(TL_FPS);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise<void>((r) => { rec.onstop = () => r(); });
  const draw = async (i: number) => { const b = await createImageBitmap(new Blob([clip.frames[i].data as BlobPart], { type: 'image/webp' })); g.drawImage(b, 0, 0); b.close(); };
  await draw(sel.idx[0]);
  rec.start(1000);
  const start = performance.now(); let t = 0;
  for (let k = 0; k < sel.idx.length; k++) {
    await draw(sel.idx[k]);
    t += sel.durs[k] / 1000;
    const wait = start + t - performance.now();
    if (wait > 0) await sleep(wait);
    progress((k + 1) / sel.idx.length);
  }
  rec.stop();
  await stopped;
  return new Blob(parts, { type: type.split(';')[0] });
}

// ------------------------------------------------------------------ replay + export screen
export interface TlHost { engine: Engine; recorder: TimelapseRecorder; docName(): string; download(b: Blob, name: string, type: string): void; toast(m: string): void; closed(): void; }

export class TimelapseView {
  root: HTMLElement;
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private clip: (Clip & { kind: 'video' | 'img' }) | null = null;
  private seeker: ClipSeeker | null = null;
  private i = 0;
  private playing = true;
  private raf = 0;
  private lastT = 0; private acc = 0; private holdUntil = 0;
  private slider: HTMLInputElement;
  private time: HTMLElement;
  private playBtn: HTMLButtonElement;
  private drawing = false;
  private pendingIdx = -1;
  private status: HTMLElement;
  private body: HTMLElement;
  private fmt: 'mp4' | 'webm' = (localStorage.getItem('gesso.tlfmt') as 'mp4' | 'webm') || 'mp4';
  private fullBtn!: HTMLButtonElement; private shortBtn!: HTMLButtonElement;
  private fmtChip(f: 'mp4' | 'webm', label: string) {
    const b = h('button', { class: 'chip' + (this.fmt === f ? ' on' : ''), 'data-fmt': f, onClick: () => {
      this.fmt = f; try { localStorage.setItem('gesso.tlfmt', f); } catch { /* private mode */ }
      this.root.querySelectorAll('[data-fmt]').forEach((x) => x.classList.toggle('on', x.getAttribute('data-fmt') === f));
    } }, label);
    return b;
  }

  constructor(private host: TlHost) {
    this.cv = h('canvas', { class: 'tl-canvas' }) as HTMLCanvasElement;
    this.g = this.cv.getContext('2d')!;
    this.slider = h('input', { type: 'range', min: '0', max: '0', value: '0', class: 'tl-scrub', 'aria-label': 'Scrub' }) as HTMLInputElement;
    this.time = h('span', { class: 'tl-time' }, '0:00');
    this.playBtn = h('button', { class: 'btn small', onClick: () => this.toggle() }, 'Pause') as HTMLButtonElement;
    this.status = h('div', { class: 'tl-status muted' }, 'Loading…');
    const rec = host.recorder;
    const recBtn = h('button', { class: 'chip' + (rec.enabled ? ' on' : ''), onClick: () => { rec.enabled = !rec.enabled; recBtn.classList.toggle('on', rec.enabled); recBtn.textContent = rec.enabled ? 'Recording on' : 'Recording off'; this.host.toast(rec.enabled ? 'Time-lapse recording on' : 'Time-lapse recording paused'); } }, rec.enabled ? 'Recording on' : 'Recording off');
    this.body = h('div', { class: 'tl-stage' }, this.cv, this.status);
    this.root = h('div', { class: 'tl-view' },
      h('div', { class: 'tl-head' }, h('b', {}, 'Time-lapse'), h('span', { class: 'muted tl-sub' }, ''), h('div', { class: 'grow' }), recBtn, h('button', { class: 'btn ghost', onClick: () => this.close() }, 'Done')),
      this.body,
      h('div', { class: 'tl-bar' }, this.playBtn, this.slider, this.time),
      h('div', { class: 'tl-bar tl-export' },
        h('span', { class: 'muted' }, 'Export'),
        h('div', { class: 'chips seg' }, this.fmtChip('mp4', 'MP4'), this.fmtChip('webm', 'WebM')),
        this.fullBtn = h('button', { class: 'btn small', onClick: () => void this.export(false, this.fmt) }, 'Full length') as HTMLButtonElement,
        this.shortBtn = h('button', { class: 'btn small', onClick: () => void this.export(true, this.fmt) }, '30 seconds') as HTMLButtonElement,
        h('div', { class: 'grow' }),
        h('button', { class: 'chip danger-text', onClick: () => void this.purge() }, 'Delete recording')),
    );
    this.slider.oninput = () => { this.playing = false; this.playBtn.textContent = 'Play'; this.show(+this.slider.value); };
    // drag across the picture to scrub
    let drag: { x: number; i: number } | null = null;
    this.cv.onpointerdown = (e) => { drag = { x: e.clientX, i: this.i }; this.cv.setPointerCapture(e.pointerId); this.playing = false; this.playBtn.textContent = 'Play'; };
    this.cv.onpointermove = (e) => { if (!drag || !this.clip) return; const n = this.clip.frames.length; const di = Math.round(((e.clientX - drag.x) / Math.max(200, this.cv.clientWidth)) * n); this.show(drag.i + di); };
    this.cv.onpointerup = () => { drag = null; };
    document.body.append(this.root);
    void this.load();
  }

  private async load() {
    const id = this.host.recorder.docId;
    if (!id) { this.status.textContent = 'Nothing recorded yet'; return; }
    await this.host.recorder.flush();
    const clip = await loadClip(id);
    this.clip = clip;
    if (!clip.frames.length) { this.status.textContent = 'Nothing recorded yet. Paint something, then come back.'; return; }
    this.status.textContent = '';
    this.cv.width = clip.w; this.cv.height = clip.h;
    this.slider.max = String(clip.frames.length - 1);
    const total = selectFrames(clip.frames, false).durs.reduce((a, b) => a + b, 0) / 1e6;
    (this.root.querySelector('.tl-sub') as HTMLElement).textContent = `${clip.frames.length} steps`;
    const shortS = selectFrames(clip.frames, true).durs.reduce((a, b) => a + b, 0) / 1e6;
    this.fullBtn.textContent = `Full length · ${fmtTime(total)}`;
    this.shortBtn.textContent = shortS < total - 0.5 ? `Short · ${fmtTime(shortS)}` : 'Short (same length)';
    this.shortBtn.disabled = shortS >= total - 0.5;
    if (clip.kind === 'video') this.seeker = new ClipSeeker(clip);
    this.i = 0;
    await this.draw(0);
    this.lastT = performance.now();
    const tick = (t: number) => {
      this.raf = requestAnimationFrame(tick);
      const dt = t - this.lastT; this.lastT = t;
      if (!this.playing || this.drawing || !this.clip) return;
      if (t < this.holdUntil) return;
      this.acc += dt;
      const step = 1000 / TL_FPS;
      if (this.acc < step) return;
      const adv = Math.min(4, Math.floor(this.acc / step)); this.acc -= adv * step;
      let n = this.i + adv;
      if (n >= this.clip.frames.length) { n = this.clip.frames.length - 1; }
      if (this.i === this.clip.frames.length - 1) { n = 0; }
      if (n === this.clip.frames.length - 1) this.holdUntil = t + END_HOLD_US / 1000;
      void this.draw(n);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private show(i: number) {
    if (!this.clip) return;
    i = Math.max(0, Math.min(this.clip.frames.length - 1, i));
    if (this.drawing) { this.pendingIdx = i; return; }
    void this.draw(i);
  }

  private async draw(i: number) {
    const clip = this.clip; if (!clip) return;
    this.drawing = true;
    try {
      if (clip.kind === 'video') {
        const f = await this.seeker!.frame(i);
        if (f) { this.g.drawImage(f, 0, 0, clip.w, clip.h); f.close(); }
      } else {
        const b = await createImageBitmap(new Blob([clip.frames[i].data as BlobPart], { type: 'image/webp' }));
        this.g.drawImage(b, 0, 0); b.close();
      }
      this.i = i;
      this.slider.value = String(i);
      this.time.textContent = `${fmtTime(i / TL_FPS)} / ${fmtTime((clip.frames.length - 1) / TL_FPS)}`;
    } finally { this.drawing = false; }
    if (this.pendingIdx >= 0) { const p = this.pendingIdx; this.pendingIdx = -1; void this.draw(p); }
  }

  private toggle() { this.playing = !this.playing; this.playBtn.textContent = this.playing ? 'Pause' : 'Play'; this.lastT = performance.now(); this.acc = 0; }

  private busy = false;
  async export(short: boolean, fmt: 'mp4' | 'webm') {
    if (!this.clip || !this.clip.frames.length || this.busy) { if (!this.clip?.frames.length) this.host.toast('Nothing recorded yet'); return; }
    this.busy = true;
    const was = this.playing; this.playing = false;
    const bar = h('div', { class: 'tl-progress' }, h('i', {}));
    const label = h('span', {}, short ? 'Making the 30-second version…' : 'Making the video…');
    const panel = h('div', { class: 'tl-busy' }, label, bar);
    this.body.append(panel);
    try {
      const r = await exportClip(this.clip, short, fmt, (t) => { (bar.firstChild as HTMLElement).style.width = Math.round(t * 100) + '%'; });
      const name = `${this.host.docName()} time-lapse${short ? ' (30s)' : ''}.${r.ext}`;
      this.host.download(r.blob, name, r.blob.type);
      (window as any).__lastTimelapse = r;
      this.host.toast(`Saved ${fmtTime(r.seconds)} video`);
    } catch (err) {
      this.host.toast(String((err as Error).message || err));
      console.info('time-lapse export failed', err);
    } finally {
      panel.remove(); this.busy = false; this.playing = was;
    }
  }

  private async purge() {
    const ok = await ask('Delete this time-lapse?', { body: 'The recording so far is removed. Your artwork stays. Recording continues from now if it is on.', okLabel: 'Delete', danger: true });
    if (!ok) return;
    await this.host.recorder.purge();
    this.close();
    this.host.toast('Time-lapse deleted');
  }

  close() {
    cancelAnimationFrame(this.raf);
    this.seeker?.close();
    this.root.remove();
    this.host.closed();
  }
}

const fmtTime = (s: number) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

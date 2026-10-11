// WebCodecs helpers: codec choice, an encoder that collects samples, decoding of stored clips (sequential and
// seekable), and a transcode pipeline (decode → pick frames → re-encode) with back-pressure.
import { Sample, TrackInfo, muxMP4, muxWebM, canMux } from './mux';

export const hasWebCodecs = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof VideoFrame !== 'undefined';

/** largest even size with the same aspect that fits inside maxW×maxH (either orientation), never upscaled */
export function evenFit(w: number, h: number, maxLong: number, maxShort: number) {
  const long = Math.max(w, h), short = Math.min(w, h);
  const k = Math.min(1, maxLong / long, maxShort / short);
  const ev = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { w: ev(w), h: ev(h) };
}

const avcLevel = (w: number, h: number) => (Math.ceil(w / 16) * Math.ceil(h / 16) > 8192 ? '33' : '28');
export const CODECS = {
  avc: (w: number, h: number) => ['avc1.6400' + avcLevel(w, h), 'avc1.4D00' + avcLevel(w, h), 'avc1.42E0' + avcLevel(w, h)],
  vp9: () => ['vp09.00.10.08', 'vp09.00.41.08'],
  vp8: () => ['vp8'],
};

/** first supported encoder config among the codec families, in order */
export async function pickEncoder(w: number, h: number, families: ('avc' | 'vp9' | 'vp8')[], bitrate = 0): Promise<VideoEncoderConfig | null> {
  if (!hasWebCodecs()) return null;
  const br = bitrate || Math.round(Math.min(12e6, Math.max(1.5e6, w * h * 30 * 0.12)));
  for (const f of families) for (const codec of CODECS[f](w, h)) {
    const cfg: VideoEncoderConfig = { codec, width: w, height: h, bitrate: br, framerate: 30, latencyMode: 'quality' };
    if (f === 'avc') (cfg as any).avc = { format: 'avc' };
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return cfg; } catch { /* try next */ }
  }
  return null;
}

/** encoder that collects chunks as mux samples; add() applies back-pressure */
export class VideoWriter {
  private enc: VideoEncoder;
  private out: { data: Uint8Array; key: boolean; ts: number }[] = [];
  private durs = new Map<number, number>();
  private err: Error | null = null;
  description?: Uint8Array;
  decoderConfig: VideoDecoderConfig | null = null;
  private n = 0;
  constructor(readonly cfg: VideoEncoderConfig, private keyEvery = 90) {
    this.enc = new VideoEncoder({
      output: (c, meta) => {
        const d = new Uint8Array(c.byteLength); c.copyTo(d);
        this.out.push({ data: d, key: c.type === 'key', ts: c.timestamp });
        if (meta?.decoderConfig) {
          this.decoderConfig = { ...meta.decoderConfig };
          if (meta.decoderConfig.description) this.description = toBytes(meta.decoderConfig.description);
        }
      },
      error: (e) => { this.err = e as Error; },
    });
    this.enc.configure(cfg);
  }
  get queue() { return this.enc.encodeQueueSize; }
  /** encode one frame (consumed/closed by the caller afterwards); dur in µs */
  async add(frame: VideoFrame, dur: number, forceKey = false) {
    if (this.err) throw this.err;
    while (this.enc.encodeQueueSize > 3) await sleep(4);
    this.durs.set(frame.timestamp, dur);
    this.enc.encode(frame, { keyFrame: forceKey || this.n % this.keyEvery === 0 });
    this.n++;
  }
  /** wrap raw RGBA (top row first) into a frame and encode it */
  async addRGBA(px: Uint8Array, w: number, h: number, dur: number, forceKey = false, opaque = true) {
    const ts = this.n * 1000;
    const f = new VideoFrame(px, { format: opaque ? 'RGBX' : 'RGBA', codedWidth: w, codedHeight: h, timestamp: ts } as VideoFrameBufferInit);
    try { await this.add(f, dur, forceKey); } finally { f.close(); }
  }
  async finish(): Promise<{ track: TrackInfo; samples: Sample[] }> {
    await this.enc.flush();
    if (this.err) throw this.err;
    this.enc.close();
    const samples = this.out.map((c) => ({ data: c.data, key: c.key, dur: this.durs.get(c.ts) ?? 33333 }));
    return { track: { codec: this.cfg.codec, width: this.cfg.width, height: this.cfg.height, description: this.description }, samples };
  }
  close() { try { this.enc.close(); } catch { /* closed */ } }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function toBytes(b: AllowSharedBufferSource): Uint8Array {
  if (b instanceof Uint8Array) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  return new Uint8Array((b as ArrayBuffer).slice(0));
}

export function mux(fmt: 'mp4' | 'webm', track: TrackInfo, samples: Sample[]) { return fmt === 'mp4' ? muxMP4(track, samples) : muxWebM(track, samples); }
export { canMux };

// ------------------------------------------------------------------ stored clips
export interface ClipFrame { seg: number; key: boolean; data: Uint8Array; /** fraction of the canvas this step changed */ area: number; }
export interface Clip { w: number; h: number; configs: Map<number, VideoDecoderConfig>; frames: ClipFrame[]; }

/**
 * Decode every frame of a clip in order, calling onFrame(index, frame) (the callback must not keep the frame;
 * it is closed afterwards). Only frames in `want` (sorted indices) are delivered when given.
 */
export async function decodeClip(clip: Clip, onFrame: (i: number, f: VideoFrame) => Promise<void> | void, want?: Set<number>, onProgress?: (k: number) => void) {
  let dec: VideoDecoder | null = null, seg = -1;
  let err: Error | null = null;
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0;
  let lastNeeded = -1;
  if (want) for (const i of want) lastNeeded = Math.max(lastNeeded, i);
  else lastNeeded = clip.frames.length - 1;
  const mk = () => new VideoDecoder({
    output: (f) => {
      const i = f.timestamp;
      if (want && !want.has(i)) { f.close(); return; }
      inFlight++;
      chain = chain.then(() => onFrame(i, f)).catch((e) => { err = err || e; }).finally(() => { f.close(); inFlight--; });
    },
    error: (e) => { err = e as Error; },
  });
  for (let i = 0; i <= lastNeeded; i++) {
    const fr = clip.frames[i];
    if (fr.seg !== seg) {
      if (dec) { await dec.flush(); dec.close(); }
      seg = fr.seg; dec = mk(); dec.configure(clip.configs.get(seg)!);
      if (!fr.key) throw new Error('segment does not start with a keyframe');
    }
    while (dec!.decodeQueueSize > 4 || inFlight > 3) await sleep(2);
    if (err) throw err;
    dec!.decode(new EncodedVideoChunk({ type: fr.key ? 'key' : 'delta', timestamp: i, data: fr.data }));
    onProgress?.(i);
  }
  if (dec) { await dec.flush(); dec.close(); }
  await chain;
  if (err) throw err;
}

/** keyframe-aware random access for replay scrubbing */
export class ClipSeeker {
  private dec: VideoDecoder | null = null;
  private seg = -1;
  private next = -1;          // index of the next chunk to feed when continuing sequentially
  private resolve: ((f: VideoFrame | null) => void) | null = null;
  private want = -1;
  private needKey = true;
  constructor(private clip: Clip) {}
  private open(seg: number) {
    this.dec?.close();
    this.dec = new VideoDecoder({
      output: (f) => { if (f.timestamp === this.want && this.resolve) { const r = this.resolve; this.resolve = null; r(f); } else f.close(); },
      error: () => { if (this.resolve) { const r = this.resolve; this.resolve = null; r(null); } this.dec = null; this.seg = -1; },
    });
    this.dec.configure(this.clip.configs.get(seg)!);
    this.seg = seg; this.needKey = true;
  }
  /** decoded frame at index i (caller closes it) */
  async frame(i: number): Promise<VideoFrame | null> {
    const fr = this.clip.frames;
    i = Math.max(0, Math.min(fr.length - 1, i));
    let start = i;
    while (start > 0 && !(fr[start].key) ) start--;
    // continue sequentially when possible (no flush happened since)
    const sequential = this.dec && this.seg === fr[i].seg && !this.needKey && this.next <= i && this.next > start;
    if (!sequential) { this.open(fr[i].seg); this.next = start; }
    this.want = i;
    const p = new Promise<VideoFrame | null>((r) => { this.resolve = r; });
    for (let k = this.next; k <= i; k++) this.dec!.decode(new EncodedVideoChunk({ type: fr[k].key ? 'key' : 'delta', timestamp: k, data: fr[k].data }));
    this.next = i + 1;
    this.needKey = false;
    // decoders may hold the last frame until flushed; flush if it does not arrive promptly
    const t = setTimeout(() => { if (this.resolve && this.dec) { this.needKey = true; this.dec.flush().catch(() => {}); } }, 60);
    const f = await p;
    clearTimeout(t);
    return f;
  }
  close() { this.dec?.close(); this.dec = null; }
}

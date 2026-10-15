// Audio track for animation (M5.5): lip-sync and timing to music.
// Bar (research): the leading iPad app's Animation Assist has no audio at all; its sister animation app (and
// FlipaClip, Rough Animator, Clip Studio, Toon Boom Harmony) import a sound file, draw its waveform under the
// frames so mouth shapes can be placed on the syllables, scrub it frame by frame, offset it, and mux it into video
// exports. Gesso: one audio track per artwork — import (any format the browser decodes: MP3, M4A/AAC, WAV, OGG,
// FLAC, WebM/Opus), waveform under each frame for exactly the time that frame is on screen (holds widen it),
// play-along that restarts with every cycle, frame-step scrubbing (you hear the frame's slice), shift by frames
// or milliseconds, volume and mute, stored with the artwork (IndexedDB asset + inside .gesso), and muxed into
// MP4 (AAC, or Opus where AAC encoding is missing) and WebM (Opus) exports.
import { store } from './store';
import type { AudioTrack, AudioSample } from './mux';

export interface AudioMeta { name: string; type: string; /** seconds of audio before frame 1 (positive: audio shifted earlier) */ offset: number; volume: number; muted: boolean; scrub: boolean; }
export const PEAK_RATE = 400;   // waveform buckets per second

export class AnimAudio {
  meta: AudioMeta | null = null;
  bytes: Uint8Array | null = null;
  buffer: AudioBuffer | null = null;
  /** max |sample| per 1/PEAK_RATE s bucket (all channels) */
  peaks: Float32Array | null = null;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private src: AudioBufferSourceNode | null = null;
  private docId: string | null = null;
  private gen = 0;
  onChange: () => void = () => {};

  get ready() { return !!this.buffer && !!this.meta; }
  get duration() { return this.buffer?.duration ?? 0; }

  /** a document opened: load its audio (if any) from storage */
  async attach(docId: string, meta: AudioMeta | null | undefined) {
    this.stop();
    const g = ++this.gen;
    this.docId = docId; this.meta = meta ? { ...defaults(), ...meta } : null; this.bytes = null; this.buffer = null; this.peaks = null;
    this.onChange();
    if (!this.meta) return;
    try {
      const b = await store.getAsset(docId, 'audio');
      if (g !== this.gen) return;
      if (!b) { this.meta = null; this.onChange(); return; }
      await this.decode(new Uint8Array(await b.arrayBuffer()), g);
    } catch (err) { console.info('audio load failed', err); }
  }
  /** set new audio bytes for the open document (import, or a .gesso file's audio) */
  async set(bytes: Uint8Array, name: string, type: string, keep?: Partial<AudioMeta>) {
    this.stop();
    const g = ++this.gen;
    await this.decode(bytes, g);          // throws for files the browser cannot decode
    if (g !== this.gen) return;
    this.meta = { ...defaults(), ...keep, name, type };
    if (this.docId) await store.putAsset(this.docId, 'audio', new Blob([bytes as BlobPart], { type }));
    this.onChange();
  }
  async remove() {
    this.stop(); this.gen++;
    if (this.docId) await store.deleteAsset(this.docId, 'audio');
    this.meta = null; this.bytes = null; this.buffer = null; this.peaks = null;
    this.onChange();
  }
  private async decode(bytes: Uint8Array, g: number) {
    // an OfflineAudioContext decodes without a user gesture and resamples nothing (keeps the file's rate)
    const oc = new OfflineAudioContext(1, 1, 48000);
    const buf = await oc.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    if (g !== this.gen) return;
    this.bytes = bytes; this.buffer = buf; this.peaks = computePeaks(buf);
    this.onChange();
  }

  // ---------------------------------------------------------------- live playback
  private ensureCtx() {
    if (!this.ctx) { this.ctx = new AudioContext({ latencyHint: 'interactive' }); this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.gain!.gain.value = this.meta?.muted ? 0 : this.meta?.volume ?? 1;
    return this.ctx;
  }
  /** output latency (s): the visuals wait this long so what you see matches what you hear */
  latency() { const c = this.ctx; return c ? (c.baseLatency || 0) + ((c as AudioContext & { outputLatency?: number }).outputLatency || 0) : 0; }
  /** play from timeline time t (s) for at most `dur` s (the rest of the cycle) */
  playFrom(t: number, dur: number) {
    this.stop();
    if (!this.ready || this.meta!.muted) return;
    const ctx = this.ensureCtx(), m = this.meta!;
    const a = t + m.offset;                         // position in the audio
    const delay = Math.max(0, -a), from = Math.max(0, a), len = dur - delay;
    if (len <= 0 || from >= this.buffer!.duration) return;
    const s = ctx.createBufferSource(); s.buffer = this.buffer; s.connect(this.gain!);
    s.start(ctx.currentTime + delay, from, len);
    this.src = s;
  }
  /** hear one frame's slice (frame stepping); short fade in/out so it does not click */
  scrub(t: number, dur: number) {
    if (!this.ready || !this.meta!.scrub || this.meta!.muted) return;
    const ctx = this.ensureCtx(), a = t + this.meta!.offset, len = Math.max(0.09, dur);
    if (a + len <= 0 || a >= this.buffer!.duration) return;
    this.stop();
    const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = this.buffer; s.connect(g); g.connect(this.gain!);
    const now = ctx.currentTime, v = 1;
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(v, now + 0.008); g.gain.setValueAtTime(v, now + len - 0.012); g.gain.linearRampToValueAtTime(0, now + len);
    s.start(now + Math.max(0, -a), Math.max(0, a), len);
    this.src = s;
  }
  stop() { if (this.src) { try { this.src.stop(); } catch { /* not started */ } this.src.disconnect(); this.src = null; } }
  applyVolume() { if (this.gain) this.gain.gain.value = this.meta?.muted ? 0 : this.meta?.volume ?? 1; }

  // ---------------------------------------------------------------- export
  /** the audio as heard in playback: `cycle` s of timeline, restarted every cycle, `repeats` times, at `rate` */
  async render(cycle: number, repeats: number, rate = 48000): Promise<AudioBuffer | null> {
    if (!this.ready || this.meta!.muted) return null;
    const ch = Math.min(2, this.buffer!.numberOfChannels), total = cycle * repeats;
    const oc = new OfflineAudioContext(ch, Math.max(1, Math.ceil(total * rate)), rate);
    const g = oc.createGain(); g.gain.value = this.meta!.volume; g.connect(oc.destination);
    for (let r = 0; r < repeats; r++) {
      const a = this.meta!.offset, delay = Math.max(0, -a), from = Math.max(0, a), len = cycle - delay;
      if (len <= 0 || from >= this.buffer!.duration) continue;
      const s = oc.createBufferSource(); s.buffer = this.buffer; s.connect(g); s.start(r * cycle + delay, from, len);
    }
    return oc.startRendering();
  }
}
const defaults = (): AudioMeta => ({ name: 'Audio', type: 'audio/*', offset: 0, volume: 1, muted: false, scrub: true });

export function computePeaks(buf: AudioBuffer): Float32Array {
  const n = Math.ceil(buf.duration * PEAK_RATE), out = new Float32Array(n), per = buf.sampleRate / PEAK_RATE;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) { let m = out[i]; const a = Math.floor(i * per), b = Math.min(d.length, Math.floor((i + 1) * per)); for (let k = a; k < b; k++) { const v = d[k] < 0 ? -d[k] : d[k]; if (v > m) m = v; } out[i] = m; }
  }
  return out;
}

/** draw the waveform of timeline seconds [t0, t1) (+ offset) into a canvas; peaks are mirrored around the middle */
export function drawWave(c: HTMLCanvasElement, peaks: Float32Array, t0: number, t1: number, colour = 'rgba(232,165,75,.9)') {
  const g = c.getContext('2d')!, W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(0, H / 2 - 0.5, W, 1);
  g.fillStyle = colour;
  for (let x = 0; x < W; x++) {
    const a = Math.floor((t0 + ((t1 - t0) * x) / W) * PEAK_RATE), b = Math.max(a + 1, Math.floor((t0 + ((t1 - t0) * (x + 1)) / W) * PEAK_RATE));
    let m = 0; for (let k = Math.max(0, a); k < Math.min(peaks.length, b); k++) if (peaks[k] > m) m = peaks[k];
    if (m <= 0) continue;
    const hh = Math.max(1, Math.sqrt(m) * (H - 2));       // sqrt: quiet consonants stay visible next to loud vowels
    g.fillRect(x, (H - hh) / 2, 1, hh);
  }
}

/**
 * Encode rendered audio for a container: WebM → Opus; MP4 → AAC when the browser can encode it, else Opus
 * (valid in MP4, plays in browsers, VLC, ffmpeg). Returns null when no audio encoder exists.
 */
export async function encodeAudio(buf: AudioBuffer, fmt: 'mp4' | 'webm'): Promise<AudioTrack | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  const ch = buf.numberOfChannels, rate = buf.sampleRate;
  const tries: { codec: 'aac' | 'opus'; cfg: AudioEncoderConfig }[] = [];
  if (fmt === 'mp4') tries.push({ codec: 'aac', cfg: { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: ch, bitrate: 160000 } });
  tries.push({ codec: 'opus', cfg: { codec: 'opus', sampleRate: rate, numberOfChannels: ch, bitrate: 128000 } });
  let pick: (typeof tries)[number] | null = null;
  for (const t of tries) { try { if ((await AudioEncoder.isConfigSupported(t.cfg)).supported) { pick = t; break; } } catch { /* next */ } }
  if (!pick) return null;
  const samples: AudioSample[] = []; let desc: Uint8Array | undefined, err: Error | null = null;
  const enc = new AudioEncoder({
    output: (c, meta) => {
      const d = new Uint8Array(c.byteLength); c.copyTo(d);
      samples.push({ data: d, dur: Math.round(((c.duration ?? 0) * rate) / 1e6) || (pick!.codec === 'opus' ? Math.round(rate / 50) : 1024) });
      const dd = meta?.decoderConfig?.description; if (dd && !desc) desc = new Uint8Array(ArrayBuffer.isView(dd) ? dd.buffer.slice(dd.byteOffset, dd.byteOffset + dd.byteLength) as ArrayBuffer : (dd as ArrayBuffer).slice(0));
    },
    error: (e) => { err = e as Error; },
  });
  enc.configure(pick.cfg);
  const block = 4800, chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  for (let o = 0; o < buf.length; o += block) {
    const n = Math.min(block, buf.length - o), data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) data.set(chans[c].subarray(o, o + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((o * 1e6) / rate), data });
    enc.encode(ad); ad.close();
    while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
  }
  await enc.flush(); enc.close();
  if (err) throw err;
  // Opus: the encoder's delay (pre-skip) from its OpusHead when it gives one; libopus' usual 312 at 48 kHz otherwise
  let preSkip = 0;
  if (pick.codec === 'opus') {
    preSkip = Math.round(312 * rate / 48000);
    if (desc && desc.length >= 12 && String.fromCharCode(...desc.subarray(0, 8)) === 'OpusHead') preSkip = desc[10] | (desc[11] << 8);
  }
  const info = { codec: pick.codec, rate, channels: ch, description: pick.codec === 'aac' ? desc : undefined, preSkip };
  return { info, samples };
}

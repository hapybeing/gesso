// Minimal video muxers for WebCodecs output: MP4 (H.264 'avc1' or VP9 'vp09', moov first, one chunk)
// and WebM (VP8 / VP9 / AV1 SimpleBlocks in keyframe-started clusters, with cues).
// Samples carry their own duration, so frame holds and a long final frame cost nothing extra.

export interface Sample { data: Uint8Array; key: boolean; /** duration in microseconds */ dur: number; }
export interface TrackInfo { codec: string; width: number; height: number; description?: Uint8Array; }
/** an optional audio track (M5.5): Opus or AAC packets with durations in samples at `rate` */
export interface AudioTrackInfo { codec: 'opus' | 'aac'; rate: number; channels: number; /** AAC AudioSpecificConfig */ description?: Uint8Array; /** Opus encoder delay in samples (48 kHz) */ preSkip: number; }
export interface AudioSample { data: Uint8Array; dur: number; }
export interface AudioTrack { info: AudioTrackInfo; samples: AudioSample[]; }
/** OpusHead (RFC 7845), little-endian: WebM CodecPrivate */
export function opusHead(a: AudioTrackInfo) {
  const b = new Uint8Array(19), d = new DataView(b.buffer);
  'OpusHead'.split('').forEach((c, i) => b[i] = c.charCodeAt(0));
  b[8] = 1; b[9] = a.channels; d.setUint16(10, a.preSkip, true); d.setUint32(12, a.rate, true); d.setInt16(16, 0, true); b[18] = 0;
  return b;
}

// ------------------------------------------------------------------ byte writer
class W {
  buf = new Uint8Array(1 << 16); n = 0;
  private need(k: number) { if (this.n + k > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf.subarray(0, this.n)); this.buf = b; } }
  u8(v: number) { this.need(1); this.buf[this.n++] = v & 255; return this; }
  u16(v: number) { return this.u8(v >> 8).u8(v); }
  u24(v: number) { return this.u8(v >> 16).u8(v >> 8).u8(v); }
  u32(v: number) { this.need(4); const d = new DataView(this.buf.buffer); d.setUint32(this.n, v >>> 0); this.n += 4; return this; }
  str(s: string) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); return this; }
  bytes(b: Uint8Array) { this.need(b.length); this.buf.set(b, this.n); this.n += b.length; return this; }
  zeros(k: number) { this.need(k); this.buf.fill(0, this.n, this.n + k); this.n += k; return this; }
  out() { return this.buf.slice(0, this.n); }
}

// ------------------------------------------------------------------ MP4
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const len = 8 + parts.reduce((s, p) => s + p.length, 0);
  const w = new W(); w.u32(len).str(type); for (const p of parts) w.bytes(p);
  return w.out();
}
const full = (type: string, version: number, flags: number, body: Uint8Array) => box(type, new W().u8(version).u24(flags).bytes(body).out());
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

/** convert microsecond durations to integer timescale units without drift */
function toUnits(samples: Sample[], scale: number) {
  let t = 0, u = 0;
  return samples.map((s) => { t += s.dur; const nu = Math.round((t * scale) / 1e6); const d = Math.max(1, nu - u); u += d; return d; });
}


const dinf = () => box('dinf', full('dref', 0, 0, new W().u32(1).bytes(full('url ', 0, 1, new Uint8Array(0))).out()));
function tkhdBox(id: number, ms: number, w: number, h: number, audio: boolean) {
  const t = new W().u32(0).u32(0).u32(id).u32(0).u32(ms).zeros(8).u16(0).u16(audio ? 1 : 0).u16(audio ? 0x100 : 0).u16(0);
  for (const m of MATRIX) t.u32(m);
  t.u32(w << 16).u32(h << 16);
  return full('tkhd', 0, 3, t.out());
}
/** MPEG-4 descriptor: tag, one-byte length (payloads here are < 128 bytes) */
const desc = (tag: number, body: Uint8Array) => new W().u8(tag).u8(body.length).bytes(body).out();
/** the audio 'trak': Opus ('Opus' + dOps, edit list skipping the encoder delay) or AAC ('mp4a' + esds) */
function audioTrak(a: AudioTrack, offset: number, capMs: number) {
  const { info, samples } = a, TS = info.rate;
  const total = samples.reduce((s, x) => s + x.dur, 0), play = Math.max(0, total - (info.codec === 'opus' ? info.preSkip : 0));
  const ms = Math.min(capMs, Math.round((play / TS) * 1000));   // the edit list ends the sound with the picture
  let cfg: Uint8Array;
  if (info.codec === 'opus') cfg = box('dOps', new W().u8(0).u8(info.channels).u16(info.preSkip).u32(info.rate).u16(0).u8(0).out());
  else {
    const asc = info.description ?? new Uint8Array([0x11, 0x90]);
    const dcd = desc(0x04, new W().u8(0x40).u8(0x15).u24(0).u32(0).u32(0).bytes(desc(0x05, asc)).out());
    cfg = full('esds', 0, 0, desc(0x03, new W().u16(2).u8(0).bytes(dcd).bytes(desc(0x06, new Uint8Array([2]))).out()));
  }
  const entry = box(info.codec === 'opus' ? 'Opus' : 'mp4a', new W().zeros(6).u16(1).zeros(8).u16(info.channels).u16(16).u16(0).u16(0).u32(info.rate * 65536).out(), cfg);
  const runs: [number, number][] = [];
  for (const s of samples) { const r = runs[runs.length - 1]; if (r && r[1] === s.dur) r[0]++; else runs.push([1, s.dur]); }
  const stts = full('stts', 0, 0, (() => { const w = new W().u32(runs.length); for (const [c, d] of runs) w.u32(c).u32(d); return w.out(); })());
  const stsc = full('stsc', 0, 0, new W().u32(1).u32(1).u32(samples.length).u32(1).out());
  const stsz = full('stsz', 0, 0, (() => { const w = new W().u32(0).u32(samples.length); for (const s of samples) w.u32(s.data.length); return w.out(); })());
  const stco = full('stco', 0, 0, new W().u32(1).u32(offset).out());
  const stbl = box('stbl', full('stsd', 0, 0, new W().u32(1).bytes(entry).out()), stts, stsc, stsz, stco);
  const minf = box('minf', full('smhd', 0, 0, new W().u16(0).u16(0).out()), dinf(), stbl);
  const mdhd = full('mdhd', 0, 0, new W().u32(0).u32(0).u32(TS).u32(total).u16(0x55c4).u16(0).out());
  const hdlr = full('hdlr', 0, 0, new W().u32(0).str('soun').zeros(12).str('SoundHandler').u8(0).out());
  const skip = info.codec === 'opus' ? info.preSkip : 0;
  const edts = box('edts', full('elst', 0, 0, new W().u32(1).u32(ms).u32(skip).u16(1).u16(0).out()));
  return { trak: box('trak', tkhdBox(2, ms, 0, 0, true), edts, box('mdia', mdhd, hdlr, minf)), ms };
}

export function muxMP4(track: TrackInfo, samples: Sample[], audio?: AudioTrack): Blob {
  const TS = 90000;
  const durs = toUnits(samples, TS);
  const total = durs.reduce((a, b) => a + b, 0);
  const totalMs = Math.round((total / TS) * 1000);
  const isAvc = track.codec.startsWith('avc1');
  const { width: Wd, height: Ht } = track;

  // sample entry
  let cfg: Uint8Array;
  if (isAvc) {
    if (!track.description) throw new Error('H.264 needs an avcC description');
    cfg = box('avcC', track.description);
  } else {
    const p = track.codec.split('.'); // vp09.PP.LL.DD
    const prof = +(p[1] || 0), lvl = +(p[2] || 10), depth = +(p[3] || 8);
    cfg = full('vpcC', 1, 0, new W().u8(prof).u8(lvl).u8((depth << 4) | (1 << 1)).u8(1).u8(1).u8(1).u16(0).out());
  }
  const entry = box(isAvc ? 'avc1' : 'vp09', new W().zeros(6).u16(1).u16(0).u16(0).zeros(12).u16(Wd).u16(Ht)
    .u32(0x480000).u32(0x480000).u32(0).u16(1).zeros(32).u16(0x18).u16(0xffff).out(), cfg);
  const stsd = full('stsd', 0, 0, new W().u32(1).bytes(entry).out());
  // stts (run-length durations)
  const runs: [number, number][] = [];
  for (const d of durs) { const r = runs[runs.length - 1]; if (r && r[1] === d) r[0]++; else runs.push([1, d]); }
  const stts = full('stts', 0, 0, (() => { const w = new W().u32(runs.length); for (const [c, d] of runs) w.u32(c).u32(d); return w.out(); })());
  const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
  const stss = keys.length === samples.length ? null : full('stss', 0, 0, (() => { const w = new W().u32(keys.length); for (const k of keys) w.u32(k); return w.out(); })());
  const stsc = full('stsc', 0, 0, new W().u32(1).u32(1).u32(samples.length).u32(1).out());
  const stsz = full('stsz', 0, 0, (() => { const w = new W().u32(0).u32(samples.length); for (const s of samples) w.u32(s.data.length); return w.out(); })());
  const vBytes = samples.reduce((s, x) => s + x.data.length, 0);
  const build = (offset: number) => {
    const stco = full('stco', 0, 0, new W().u32(1).u32(offset).out());
    const stbl = box('stbl', ...[stsd, stts, stss, stsc, stsz, stco].filter(Boolean) as Uint8Array[]);
    const vmhd = full('vmhd', 0, 1, new W().zeros(8).out());
    const minf = box('minf', vmhd, dinf(), stbl);
    const mdhd = full('mdhd', 0, 0, new W().u32(0).u32(0).u32(TS).u32(total).u16(0x55c4).u16(0).out());
    const hdlr = full('hdlr', 0, 0, new W().u32(0).str('vide').zeros(12).str('VideoHandler').u8(0).out());
    const mdia = box('mdia', mdhd, hdlr, minf);
    const tkhd = tkhdBox(1, totalMs, Wd, Ht, false);
    const trak = box('trak', tkhd, mdia);
    const at = audio && audio.samples.length ? audioTrak(audio, offset + vBytes, totalMs) : null;
    const mvW = new W().u32(0).u32(0).u32(1000).u32(Math.max(totalMs, at?.ms ?? 0)).u32(0x10000).u16(0x100).zeros(10);
    for (const m of MATRIX) mvW.u32(m);
    mvW.zeros(24).u32(at ? 3 : 2);
    return box('moov', full('mvhd', 0, 0, mvW.out()), trak, ...(at ? [at.trak] : []));
  };
  const ftyp = box('ftyp', new W().str('isom').u32(0x200).str('isom').str('iso2').str(isAvc ? 'avc1' : 'vp09').str('mp41').out());
  const aSamples = audio?.samples ?? [];
  const mdatLen = 8 + vBytes + aSamples.reduce((s, x) => s + x.data.length, 0);
  const probe = build(0);
  const moov = build(ftyp.length + probe.length + 8);
  const head = new W().u32(mdatLen).str('mdat').out();
  return new Blob([ftyp, moov, head, ...samples.map((s) => s.data), ...aSamples.map((s) => s.data)] as BlobPart[], { type: 'video/mp4' });
}

// ------------------------------------------------------------------ WebM (EBML)
function vint(n: number): Uint8Array {
  // minimal-length EBML size
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len); let v = n;
      for (let i = len - 1; i >= 0; i--) { out[i] = v & 255; v = Math.floor(v / 256); }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error('size too large');
}
function idBytes(id: number) { const b: number[] = []; let v = id; while (v > 0) { b.unshift(v & 255); v = Math.floor(v / 256); } return new Uint8Array(b); }
function el(id: number, ...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const idb = idBytes(id), sz = vint(len);
  const out = new Uint8Array(idb.length + sz.length + len);
  out.set(idb); out.set(sz, idb.length);
  let o = idb.length + sz.length; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const uintEl = (id: number, v: number) => { const b: number[] = []; let x = v; do { b.unshift(x & 255); x = Math.floor(x / 256); } while (x > 0); return el(id, new Uint8Array(b)); };
/** signed integer element, 8 bytes big-endian (DiscardPadding) */
const sintEl = (id: number, v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v)); return el(id, b); };
const strEl = (id: number, s: string) => el(id, new TextEncoder().encode(s));
const f64El = (id: number, v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return el(id, b); };

export function muxWebM(track: TrackInfo, samples: Sample[], audio?: AudioTrack): Blob {
  const codecId = track.codec.startsWith('vp09') ? 'V_VP9' : track.codec.startsWith('vp8') ? 'V_VP8' : track.codec.startsWith('av01') ? 'V_AV1' : '';
  if (!codecId) throw new Error('WebM cannot hold ' + track.codec);
  // timestamps in ms (TimecodeScale 1 ms), accumulated without drift
  const starts: number[] = []; let t = 0;
  for (const s of samples) { starts.push(Math.round(t / 1000)); t += s.dur; }
  let totalMs = Math.round(t / 1000);
  let au = audio && audio.samples.length && audio.info.codec === 'opus' ? audio : null;
  const aStarts: number[] = [];
  let discardNs = 0;
  if (au) {
    // end the sound with the picture: drop packets that start after the end, discard the rest of the last one
    const end = Math.round((t / 1e6) * au.info.rate) + au.info.preSkip, keep: AudioSample[] = [];
    let at = 0;
    for (const s of au.samples) { if (at >= end) break; aStarts.push(Math.round((at * 1000) / au.info.rate)); keep.push(s); at += s.dur; }
    if (at > end) discardNs = Math.round(((at - end) * 1e9) / au.info.rate);
    au = { info: au.info, samples: keep };
  }
  const header = el(0x1a45dfa3, uintEl(0x4286, 1), uintEl(0x42f7, 1), uintEl(0x42f2, 4), uintEl(0x42f3, 8), strEl(0x4282, 'webm'), uintEl(0x4287, 4), uintEl(0x4285, 2));
  const info = el(0x1549a966, uintEl(0x2ad7b1, 1000000), strEl(0x4d80, 'Gesso'), strEl(0x5741, 'Gesso'), f64El(0x4489, totalMs));
  const tracks = el(0x1654ae6b, el(0xae, uintEl(0xd7, 1), uintEl(0x73c5, 1), uintEl(0x83, 1), strEl(0x86, codecId), uintEl(0x9c, 0),
    el(0xe0, uintEl(0xb0, track.width), uintEl(0xba, track.height))),
    ...(au ? [el(0xae, uintEl(0xd7, 2), uintEl(0x73c5, 2), uintEl(0x83, 2), strEl(0x86, 'A_OPUS'), uintEl(0x9c, 0), el(0x63a2, opusHead(au.info)),
      uintEl(0x56aa, Math.round((au.info.preSkip * 1e9) / au.info.rate)), uintEl(0x56bb, 80000000),
      el(0xe1, f64El(0xb5, au.info.rate), uintEl(0x9f, au.info.channels)))] : []));
  // clusters start at video keyframes (or when the 16-bit relative timecode would overflow); audio blocks are
  // interleaved by time into the same clusters
  const clusters: { time: number; parts: Uint8Array[] }[] = [];
  const evs: { t: number; v: number; i: number }[] = samples.map((_, i) => ({ t: starts[i], v: 1, i }));
  if (au) au.samples.forEach((_, i) => evs.push({ t: aStarts[i], v: 0, i }));
  evs.sort((a, b) => a.t - b.t || b.v - a.v);
  for (const ev of evs) {
    let c = clusters[clusters.length - 1];
    const vs = ev.v ? samples[ev.i] : null;
    if (!c || (vs && vs.key) || ev.t - c.time > 30000) { c = { time: ev.t, parts: [uintEl(0xe7, ev.t)] }; clusters.push(c); }
    const rel = ev.t - c.time;
    if (!vs) {
      const ah = new Uint8Array([0x82, (rel >> 8) & 255, rel & 255, 0x80]);
      if (ev.i === au!.samples.length - 1 && discardNs > 0) { ah[3] = 0; c.parts.push(el(0xa0, el(0xa1, ah, au!.samples[ev.i].data), sintEl(0x75a2, discardNs))); }
      else c.parts.push(el(0xa3, ah, au!.samples[ev.i].data));
      continue;
    }
    const hdr = new Uint8Array([0x81, (rel >> 8) & 255, rel & 255, vs.key ? 0x80 : 0]);
    if (ev.i === samples.length - 1) {
      // last frame: a BlockGroup so its duration (e.g. the final hold) is explicit
      hdr[3] = 0;
      c.parts.push(el(0xa0, el(0xa1, hdr, vs.data), uintEl(0x9b, Math.max(1, Math.round(t / 1000) - starts[ev.i]))));
    } else c.parts.push(el(0xa3, hdr, vs.data));
  }
  const clusterEls = clusters.map((c) => el(0x1f43b675, ...c.parts));
  // cues: positions relative to the segment payload start; Cues are written after the clusters
  const pre = info.length + tracks.length;
  let pos = pre;
  const cuePts: Uint8Array[] = [];
  clusters.forEach((c, i) => { cuePts.push(el(0xbb, uintEl(0xb3, c.time), el(0xb7, uintEl(0xf7, 1), uintEl(0xf1, pos)))); pos += clusterEls[i].length; });
  const cues = el(0x1c53bb6b, ...cuePts);
  const segPayload = [info, tracks, ...clusterEls, cues];
  const segLen = segPayload.reduce((s, p) => s + p.length, 0);
  const segHead = new Uint8Array([...idBytes(0x18538067), ...vint(segLen)]);
  return new Blob([header, segHead, ...segPayload] as BlobPart[], { type: 'video/webm' });
}

/** which container a codec can be muxed into directly */
export const canMux = (codec: string, fmt: 'mp4' | 'webm') => fmt === 'mp4' ? /^(avc1|vp09)/.test(codec) : /^(vp8|vp09|av01)/.test(codec);

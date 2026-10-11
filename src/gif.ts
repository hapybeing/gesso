// Animated GIF encoder (runs in the worker): median-cut + k-means palette shared by all frames (no colour flicker
// between frames), optional ordered dithering (stable from frame to frame, so unchanged areas stay unchanged),
// frame differencing (unchanged pixels become transparent and each frame is cropped to what changed), and an own
// GIF-flavoured LZW coder.

export interface GifOpts { w: number; h: number; dither: boolean; transparent: boolean; loop: boolean; }

// ------------------------------------------------------------------ palette
/** palette of up to k colours (rgb triplets) from sampled straight-alpha RGBA pixels */
export function buildPalette(samples: Uint8Array, k: number): Uint8Array {
  const n = samples.length / 3;
  if (!n) return new Uint8Array(3);
  const idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
  interface Box { lo: number; hi: number; score: number; ch: number; }
  const stat = (lo: number, hi: number): Box => {
    const mn = [255, 255, 255], mx = [0, 0, 0];
    for (let i = lo; i < hi; i++) { const o = idx[i] * 3; for (let c = 0; c < 3; c++) { const v = samples[o + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; } }
    // perceptual weights: green matters most, blue least
    const r = [(mx[0] - mn[0]) * 1.0, (mx[1] - mn[1]) * 1.2, (mx[2] - mn[2]) * 0.8];
    const ch = r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2;
    return { lo, hi, ch, score: r[ch] * r[ch] * Math.sqrt(hi - lo) };
  };
  const boxes: Box[] = [stat(0, n)];
  while (boxes.length < k) {
    let bi = -1, bs = 0;
    boxes.forEach((b, i) => { if (b.hi - b.lo > 1 && b.score > bs) { bs = b.score; bi = i; } });
    if (bi < 0) break;
    const b = boxes[bi];
    const sub = Array.from(idx.subarray(b.lo, b.hi)).sort((x, y) => samples[x * 3 + b.ch] - samples[y * 3 + b.ch]);
    idx.set(sub, b.lo);
    const mid = (b.lo + b.hi) >> 1;
    boxes.splice(bi, 1, stat(b.lo, mid), stat(mid, b.hi));
  }
  let pal = boxes.map((b) => { const s = [0, 0, 0]; for (let i = b.lo; i < b.hi; i++) { const o = idx[i] * 3; s[0] += samples[o]; s[1] += samples[o + 1]; s[2] += samples[o + 2]; } const c = b.hi - b.lo; return [s[0] / c, s[1] / c, s[2] / c]; });
  // k-means refinement (Lloyd), a few rounds on the samples
  const step = Math.max(1, Math.floor(n / 60000));
  for (let it = 0; it < 4; it++) {
    const acc = pal.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i += step) {
      const o = i * 3, r = samples[o], g = samples[o + 1], b = samples[o + 2];
      let best = 0, bd = Infinity;
      for (let p = 0; p < pal.length; p++) { const q = pal[p]; const d = (q[0] - r) ** 2 * 1.0 + (q[1] - g) ** 2 * 1.44 + (q[2] - b) ** 2 * 0.64; if (d < bd) { bd = d; best = p; } }
      const a = acc[best]; a[0] += r; a[1] += g; a[2] += b; a[3]++;
    }
    pal = pal.map((q, p) => (acc[p][3] ? [acc[p][0] / acc[p][3], acc[p][1] / acc[p][3], acc[p][2] / acc[p][3]] : q));
  }
  // flat colours (backgrounds, fills) must come out exact: a centroid whose cluster is dominated by one exact
  // colour snaps to it (k-means alone averages white with its anti-aliased neighbours into an off-white)
  const counts = pal.map(() => new Map<number, number>()), sizes = pal.map(() => 0);
  for (let i = 0; i < n; i += step) {
    const o = i * 3, r = samples[o], g = samples[o + 1], b = samples[o + 2];
    let best = 0, bd = Infinity;
    for (let p = 0; p < pal.length; p++) { const q = pal[p]; const d = (q[0] - r) ** 2 * 1.0 + (q[1] - g) ** 2 * 1.44 + (q[2] - b) ** 2 * 0.64; if (d < bd) { bd = d; best = p; } }
    const key = (r << 16) | (g << 8) | b, m = counts[best];
    m.set(key, (m.get(key) || 0) + 1); sizes[best]++;
  }
  pal = pal.map((q, p) => {
    let bk = -1, bc = 0; for (const [k2, c] of counts[p]) if (c > bc) { bc = c; bk = k2; }
    return bk >= 0 && bc >= sizes[p] * 0.25 ? [bk >> 16, (bk >> 8) & 255, bk & 255] : q;
  });
  const seen = new Set<string>();
  pal = pal.filter((q) => { const k2 = q.map(Math.round).join(','); if (seen.has(k2)) return false; seen.add(k2); return true; });
  const out = new Uint8Array(pal.length * 3);
  pal.forEach((q, p) => { out[p * 3] = Math.round(q[0]); out[p * 3 + 1] = Math.round(q[1]); out[p * 3 + 2] = Math.round(q[2]); });
  return out;
}

const BAYER8 = (() => {
  const m = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25], [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
  return Float32Array.from(m.flat().map((v) => (v + 0.5) / 64 - 0.5));
})();

/** maps colours to palette indices: exact per-colour cache (a coarse 6-bit cache takes over for huge colour counts) */
export class Mapper {
  private exact = new Map<number, number>();
  private cache = new Int16Array(1 << 18).fill(-1);
  constructor(private pal: Uint8Array, private n = pal.length / 3) {}
  private search(r: number, g: number, b: number) {
    let bd = Infinity, v = 0;
    for (let p = 0; p < this.n; p++) { const d = (this.pal[p * 3] - r) ** 2 + (this.pal[p * 3 + 1] - g) ** 2 * 1.44 + (this.pal[p * 3 + 2] - b) ** 2 * 0.64; if (d < bd) { bd = d; v = p; } }
    return v;
  }
  nearest(r: number, g: number, b: number) {
    const key = (r << 16) | (g << 8) | b;
    let v = this.exact.get(key);
    if (v !== undefined) return v;
    if (this.exact.size < 400000) { v = this.search(r, g, b); this.exact.set(key, v); return v; }
    const ck = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    v = this.cache[ck];
    if (v < 0) { v = this.search((r & ~3) + 2, (g & ~3) + 2, (b & ~3) + 2); this.cache[ck] = v; }
    return v;
  }
  /** straight RGBA → indices; alpha < 128 → transparent index */
  map(px: Uint8Array, w: number, h: number, dither: boolean, transIdx: number): Uint8Array {
    const out = new Uint8Array(w * h);
    const amp = dither ? 22 : 0;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const o = i * 4;
      if (px[o + 3] < 128) { out[i] = transIdx; continue; }
      if (amp) {
        // colours the palette holds exactly (flat fills, backgrounds) stay clean; only in-between tones are dithered
        const e0 = this.nearest(px[o], px[o + 1], px[o + 2]);
        if (Math.abs(this.pal[e0 * 3] - px[o]) + Math.abs(this.pal[e0 * 3 + 1] - px[o + 1]) + Math.abs(this.pal[e0 * 3 + 2] - px[o + 2]) <= 3) { out[i] = e0; continue; }
        const d = BAYER8[(y & 7) * 8 + (x & 7)] * amp;
        const r = Math.min(255, Math.max(0, px[o] + d)), g = Math.min(255, Math.max(0, px[o + 1] + d)), b = Math.min(255, Math.max(0, px[o + 2] + d));
        out[i] = this.nearest(r | 0, g | 0, b | 0);
      } else out[i] = this.nearest(px[o], px[o + 1], px[o + 2]);
    }
    return out;
  }
}

// ------------------------------------------------------------------ LZW (GIF variant)
export function lzwEncode(data: Uint8Array, minCode = 8): Uint8Array {
  const out: number[] = [];
  let acc = 0, bits = 0;
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1;
  const HS = 5003;
  const htab = new Int32Array(HS).fill(-1), ctab = new Int32Array(HS);
  const emit = (code: number) => { acc |= code << bits; bits += size; while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8; } };
  emit(clear);
  if (!data.length) { emit(eoi); if (bits) out.push(acc & 255); return Uint8Array.from(out); }
  let prefix = data[0];
  for (let i = 1; i < data.length; i++) {
    const k = data[i];
    const key = (k << 12) | prefix;
    let h = ((k << 4) ^ prefix) % HS;
    const disp = h === 0 ? 1 : HS - h;
    let found = -1;
    while (htab[h] >= 0) {
      if (htab[h] === key) { found = ctab[h]; break; }
      h -= disp; if (h < 0) h += HS;
    }
    if (found >= 0) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) {
      htab[h] = key; ctab[h] = next++;
      if (next - 1 === 1 << size && size < 12) size++;
    } else {
      emit(clear); htab.fill(-1); size = minCode + 1; next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits) out.push(acc & 255);
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------ file
export class GifWriter {
  private parts: Uint8Array[] = [];
  private prev: Uint8Array | null = null;
  private mapper: Mapper;
  readonly trans: number;
  constructor(private o: GifOpts, pal: Uint8Array) {
    // up to 255 colours + one reserved index (transparency / "unchanged")
    const n = Math.min(255, pal.length / 3);
    this.trans = n;
    const table = new Uint8Array(256 * 3); table.set(pal.subarray(0, n * 3));
    this.mapper = new Mapper(table.subarray(0, n * 3), n);
    const head = [...'GIF89a'].map((c) => c.charCodeAt(0));
    const lsd = [o.w & 255, o.w >> 8, o.h & 255, o.h >> 8, 0xf7, 0, 0];
    this.parts.push(Uint8Array.from([...head, ...lsd]), table);
    if (o.loop) this.parts.push(Uint8Array.from([0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0]));
  }
  /** add a frame (straight RGBA, full size) shown for delayCs hundredths of a second */
  addFrame(px: Uint8Array, delayCs: number) {
    const { w, h } = this.o;
    const idx = this.mapper.map(px, w, h, this.o.dither, this.trans);
    let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1, disposal = 1;
    let data = idx;
    if (this.o.transparent) {
      // transparent artwork: full frames over a cleared background, cropped to the visible pixels
      disposal = 2;
      [x0, y0, x1, y1] = bbox(idx, w, h, (i) => idx[i] !== this.trans);
    } else if (this.prev) {
      const prev = this.prev;
      [x0, y0, x1, y1] = bbox(idx, w, h, (i) => idx[i] !== prev[i]);
      data = idx.slice();
      for (let i = 0; i < data.length; i++) if (data[i] === prev[i]) data[i] = this.trans;
    }
    if (x1 < x0) { x0 = y0 = x1 = y1 = 0; data = new Uint8Array(w * h).fill(this.trans); } // nothing changed: a 1 px no-op frame keeps the timing
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const crop = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) crop.set(data.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + cw), y * cw);
    if (!this.o.transparent) this.prev = idx;
    const d = Math.max(2, Math.round(delayCs));
    const gce = [0x21, 0xf9, 4, (disposal << 2) | 1, d & 255, d >> 8, this.trans, 0];
    const desc = [0x2c, x0 & 255, x0 >> 8, y0 & 255, y0 >> 8, cw & 255, cw >> 8, ch & 255, ch >> 8, 0];
    const lz = lzwEncode(crop, 8);
    const blocks = new Uint8Array(lz.length + Math.ceil(lz.length / 255) + 2);
    let o = 0; blocks[o++] = 8;
    for (let i = 0; i < lz.length; i += 255) { const n = Math.min(255, lz.length - i); blocks[o++] = n; blocks.set(lz.subarray(i, i + n), o); o += n; }
    blocks[o++] = 0;
    this.parts.push(Uint8Array.from([...gce, ...desc]), blocks.subarray(0, o));
  }
  finish(): Uint8Array {
    this.parts.push(Uint8Array.of(0x3b));
    const len = this.parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len); let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

function bbox(_idx: Uint8Array, w: number, h: number, on: (i: number) => boolean): [number, number, number, number] {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) if (on(r + x)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  }
  return [x0, y0, x1, y1];
}

/** turn frame durations (µs) into GIF delays (1/100 s) without accumulating rounding drift */
export function gifDelays(durs: number[]): number[] {
  let t = 0, prev = 0;
  return durs.map((d) => { t += d; const cs = Math.round(t / 1e4); const v = Math.max(2, cs - prev); prev += v; return v; });
}

/** a whole encode, driven message by message (the worker owns one; main thread fallback uses it directly) */
export class GifSession {
  private samples: number[] = [];
  private writer: GifWriter | null = null;
  constructor(private o: GifOpts) {}
  /** feed a (small) rendering of a frame for the palette */
  sample(px: Uint8Array, premul: boolean) {
    const n = px.length / 4, want = 24000, step = Math.max(1, Math.floor(n / want));
    for (let i = (Math.random() * step) | 0; i < n; i += step) {
      const o = i * 4, a = px[o + 3];
      if (a < 128) continue;
      const k = premul && a < 255 ? 255 / a : 1;
      this.samples.push(Math.min(255, px[o] * k), Math.min(255, px[o + 1] * k), Math.min(255, px[o + 2] * k));
    }
  }
  frame(px: Uint8Array, premul: boolean, delayCs: number) {
    if (!this.writer) {
      const s = Uint8Array.from(this.samples.length ? this.samples : [0, 0, 0]); this.samples = [];
      this.writer = new GifWriter(this.o, buildPalette(s, 255));
    }
    if (premul) for (let i = 0; i < px.length; i += 4) { const a = px[i + 3]; if (a && a < 255) { const k = 255 / a; px[i] = Math.min(255, px[i] * k); px[i + 1] = Math.min(255, px[i + 1] * k); px[i + 2] = Math.min(255, px[i + 2] * k); } }
    this.writer.addFrame(px, delayCs);
  }
  end(): Uint8Array { if (!this.writer) this.frame(new Uint8Array(this.o.w * this.o.h * 4), false, 10); return this.writer!.finish(); }
}

// Palettes (M5.4): a library of named palettes, a palette carried by the artwork, extraction from an image,
// and file formats — Adobe Swatch Exchange (.ase, binary), GIMP palette (.gpl, text) and plain hex lists
// (.hex/.txt, the format Lospec and most palette sites hand out).
// Bar (research): the leading iPad app — palettes in Compact/Card views, "+" adds the current colour, tap a
// swatch to use it, hold to delete or set, palettes from a photo or the camera, import/export of its own
// format and .ase, a default palette. Krita — palette docker, .gpl/.kpl/.ase/.aco, palette stored *in the
// document*. Clip Studio — colour sets, import .ase/.aco/.cls. Gesso: all of the above that fits a tablet,
// with the image extractor tuned so small saturated accents survive (see extractPalette).

export interface Swatch { hex: string; name?: string }
export interface Palette { id: string; name: string; colors: Swatch[] }

export const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const rgbHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
export const hexRgb = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1, 7), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
const normHex = (s: string): string | null => {
  let t = s.trim().replace(/^#|^0x/i, '');
  if (/^[0-9a-f]{3}$/i.test(t)) t = t.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{8}$/i.test(t)) t = t.slice(2);          // AARRGGBB (paint.net / Lospec .txt) → RRGGBB
  return /^[0-9a-f]{6}$/i.test(t) ? '#' + t.toLowerCase() : null;
};

// ------------------------------------------------------------------ GIMP .gpl
export function parseGPL(text: string, fallback = 'Imported'): Palette {
  const lines = text.replace(/\r/g, '').split('\n');
  if (!/^GIMP Palette/i.test(lines[0] || '')) throw new Error('Not a GIMP palette');
  let name = fallback; const colors: Swatch[] = [];
  for (const ln of lines.slice(1)) {
    const m = /^Name:\s*(.*)$/i.exec(ln); if (m) { name = m[1].trim() || name; continue; }
    if (/^(Columns:|#)/i.test(ln) || !ln.trim()) continue;
    const p = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(ln); if (!p) continue;
    const [r, g, b] = [p[1], p[2], p[3]].map((v) => Math.min(255, +v) / 255);
    const nm = p[4].trim();
    colors.push(nm && !/^untitled$/i.test(nm) && !/^#?[0-9a-f]{6}$/i.test(nm) ? { hex: rgbHex(r, g, b), name: nm } : { hex: rgbHex(r, g, b) });
  }
  return { id: newId(), name, colors };
}
export function toGPL(p: Palette): string {
  const out = ['GIMP Palette', 'Name: ' + p.name.replace(/[\r\n]/g, ' '), 'Columns: ' + Math.min(16, Math.max(1, p.colors.length)), '#'];
  for (const c of p.colors) { const [r, g, b] = hexRgb(c.hex).map((v) => Math.round(v * 255)); out.push(`${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\t${c.name || c.hex}`); }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ hex lists
export function parseHexList(text: string, name = 'Imported'): Palette {
  const colors: Swatch[] = [];
  for (const ln of text.replace(/\r/g, '').split('\n')) {
    if (/^\s*;/.test(ln)) continue;                       // paint.net comment lines
    for (const tok of ln.split(/[\s,]+/)) { const h = normHex(tok); if (h) colors.push({ hex: h }); }
  }
  if (!colors.length) throw new Error('No colours found');
  return { id: newId(), name, colors };
}

// ------------------------------------------------------------------ Adobe Swatch Exchange
// "ASEF", version 1.0, block count; blocks: 0x0001 colour, 0xC001 group start, 0xC002 group end, each with a
// u32 length. Colour block: u16 name length (UTF-16 units incl. the terminating 0), UTF-16BE name, 4-char model
// ("RGB ", "CMYK", "LAB ", "Gray"), big-endian float32 values, u16 type (0 global, 1 spot, 2 normal).
// Groups come back as separate palettes; loose colours form one palette named after the file.
function labToRgb(L: number, a: number, b: number): [number, number, number] {
  // CIE L*a*b* (D50, as Adobe writes it) → XYZ → Bradford D50→D65 → linear sRGB → sRGB
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200, e = 216 / 24389, k = 24389 / 27;
  const f = (t: number) => (t ** 3 > e ? t ** 3 : (116 * t - 16) / k);
  const X = 0.96422 * f(fx), Y = L > k * e ? fy ** 3 : L / k, Z = 0.82521 * f(fz);
  const x = 0.9555766 * X - 0.0230393 * Y + 0.0631636 * Z, y = -0.0282895 * X + 1.0099416 * Y + 0.0210077 * Z, z = 0.0122982 * X - 0.020483 * Y + 1.3299098 * Z;
  const lin = [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
  return lin.map((v) => clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)) as [number, number, number];
}
export function parseASE(buf: ArrayBuffer, fallback = 'Imported'): Palette[] {
  const v = new DataView(buf); let o = 0;
  if (buf.byteLength < 12 || String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)) !== 'ASEF') throw new Error('Not an .ase file');
  o = 8; const n = v.getUint32(o); o += 4;
  const str = (at: number) => { const len = v.getUint16(at); let s = ''; for (let i = 0; i < len; i++) { const c = v.getUint16(at + 2 + i * 2); if (c) s += String.fromCharCode(c); } return { s, end: at + 2 + len * 2 }; };
  const loose: Palette = { id: newId(), name: fallback, colors: [] }, out: Palette[] = [];
  let cur: Palette | null = null;
  for (let i = 0; i < n && o + 6 <= buf.byteLength; i++) {
    const type = v.getUint16(o), len = v.getUint32(o + 2), body = o + 6; o = body + len;
    if (o > buf.byteLength) throw new Error('Truncated .ase file');
    if (type === 0xc001) { cur = { id: newId(), name: str(body).s || fallback, colors: [] }; out.push(cur); continue; }
    if (type === 0xc002) { cur = null; continue; }
    if (type !== 0x0001) continue;
    const nm = str(body); let p = nm.end;
    const model = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3)).trim().toUpperCase(); p += 4;
    const f = (k: number) => v.getFloat32(p + k * 4);
    let rgb: [number, number, number];
    if (model === 'RGB') rgb = [f(0), f(1), f(2)];
    else if (model === 'CMYK') { const k = f(3); rgb = [(1 - f(0)) * (1 - k), (1 - f(1)) * (1 - k), (1 - f(2)) * (1 - k)]; }
    else if (model === 'LAB') rgb = labToRgb(f(0) * 100, f(1), f(2));
    else if (model === 'GRAY') rgb = [f(0), f(0), f(0)];
    else continue;
    const sw: Swatch = { hex: rgbHex(...rgb) }; if (nm.s && !/^#?[0-9a-f]{6}$/i.test(nm.s)) sw.name = nm.s;
    (cur || loose).colors.push(sw);
  }
  if (loose.colors.length) out.unshift(loose);
  const res = out.filter((p) => p.colors.length);
  if (!res.length) throw new Error('No colours in the .ase file');
  return res;
}
export function toASE(p: Palette): Uint8Array {
  const blocks: Uint8Array[] = [];
  const nameBytes = (s: string) => { const u = [...s.slice(0, 200)].map((c) => c.charCodeAt(0) & 0xffff); const b = new Uint8Array(2 + (u.length + 1) * 2); const d = new DataView(b.buffer); d.setUint16(0, u.length + 1); u.forEach((c, i) => d.setUint16(2 + i * 2, c)); return b; };
  const block = (type: number, body: Uint8Array) => { const b = new Uint8Array(6 + body.length); const d = new DataView(b.buffer); d.setUint16(0, type); d.setUint32(2, body.length); b.set(body, 6); blocks.push(b); };
  block(0xc001, nameBytes(p.name));
  for (const c of p.colors) {
    const nb = nameBytes(c.name || c.hex), body = new Uint8Array(nb.length + 4 + 12 + 2), d = new DataView(body.buffer);
    body.set(nb, 0); let q = nb.length; 'RGB '.split('').forEach((ch, i) => body[q + i] = ch.charCodeAt(0)); q += 4;
    hexRgb(c.hex).forEach((x, i) => d.setFloat32(q + i * 4, x)); q += 12; d.setUint16(q, 2);
    block(0x0001, body);
  }
  block(0xc002, new Uint8Array(0));
  const total = 12 + blocks.reduce((s, b) => s + b.length, 0), out = new Uint8Array(total), d = new DataView(out.buffer);
  out.set([0x41, 0x53, 0x45, 0x46]); d.setUint16(4, 1); d.setUint16(6, 0); d.setUint32(8, blocks.length);
  let o = 12; for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

/** any supported palette file → palettes (by extension, then by sniffing) */
export async function parsePaletteFile(f: Blob & { name?: string }): Promise<Palette[]> {
  const name = (f.name || 'Imported').replace(/\.[^.]+$/, '').slice(0, 40) || 'Imported';
  const buf = await f.arrayBuffer(), head = new Uint8Array(buf.slice(0, 12));
  if (String.fromCharCode(...head.slice(0, 4)) === 'ASEF') return parseASE(buf, name);
  const text = new TextDecoder().decode(buf);
  if (/^GIMP Palette/i.test(text)) return [parseGPL(text, name)];
  return [parseHexList(text, name)];
}

// ------------------------------------------------------------------ extraction from an image
// OKLab (Ottosson): perceptually even, so k-means distances match what the eye calls "different colours".
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
export function toOklab(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B), m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B), s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function fromOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)].map(clamp01) as [number, number, number];
}
export interface ExtractOpts { count: number; /** weight = pixels^power: 1 = plain k-means, <1 lets small accents win a slot */ power?: number; /** snap each centre to the most common real colour of its cluster */ snap?: boolean; /** skip sharp-edge pixels (anti-aliasing mixtures); default true */ edges?: boolean }
/**
 * Pick `count` colours from straight-alpha RGBA. Pixels are binned at 5 bits per channel (≤32 768 bins), each
 * bin weighted by count^power; k-means++ seeding (farthest-point flavoured, deterministic) then Lloyd in
 * OKLab; each centre snapped to the heaviest real bin in its cluster so the swatch is a colour that is
 * actually in the picture rather than a muddy average; near-duplicates (ΔOK < 0.04) merged; sorted dark→light
 * within hue families.
 */
export function extractPalette(px: Uint8ClampedArray | Uint8Array, w: number, h: number, o: ExtractOpts): Swatch[] {
  const power = o.power ?? 0.5, snap = o.snap ?? true;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  // R5 refinement: anti-aliased edges between two flat colours are mixtures nobody wants as swatches, and the
  // accent-friendly weighting below would give them slots — so pixels that differ sharply from a neighbour are
  // left out (unless that would leave too little of the picture, as in grainy photos).
  const flat = new Uint8Array(w * h);
  let nFlat = 0, nOpaque = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x, i = k * 4; if (px[i + 3] < 128) continue; nOpaque++;
    let m = 0;
    for (const q of [x > 0 ? i - 4 : -1, x < w - 1 ? i + 4 : -1, y > 0 ? i - w * 4 : -1, y < h - 1 ? i + w * 4 : -1]) {
      if (q < 0) continue; const d = Math.abs(px[q] - px[i]) + Math.abs(px[q + 1] - px[i + 1]) + Math.abs(px[q + 2] - px[i + 2]); if (d > m) m = d;
    }
    if (m < 40) { flat[k] = 1; nFlat++; }
  }
  const useFlat = (o.edges ?? true) && nFlat > nOpaque * 0.3;
  for (let i = 0, k = 0; i < w * h * 4; i += 4, k++) {
    if (px[i + 3] < 128 || (useFlat && !flat[k])) continue;
    const key = (px[i] >> 3) << 10 | (px[i + 1] >> 3) << 5 | px[i + 2] >> 3;
    const e = bins.get(key); if (e) { e.n++; e.r += px[i]; e.g += px[i + 1]; e.b += px[i + 2]; } else bins.set(key, { n: 1, r: px[i], g: px[i + 1], b: px[i + 2] });
  }
  const B = [...bins.values()]; if (!B.length) return [];
  const P = B.map((e) => toOklab(e.r / e.n / 255, e.g / e.n / 255, e.b / e.n / 255)), Wt = B.map((e) => Math.pow(e.n, power));
  const K = Math.min(o.count, B.length);
  const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // seeding: heaviest bin first, then the bin maximising weight × distance² to the chosen centres (deterministic k-means++)
  let first = 0; for (let i = 1; i < B.length; i++) if (Wt[i] > Wt[first]) first = i;
  const C: number[][] = [P[first].slice()], best = P.map((p) => d2(p, C[0]));
  while (C.length < K) {
    let j = 0, bv = -1; for (let i = 0; i < P.length; i++) { const v = Wt[i] * best[i]; if (v > bv) { bv = v; j = i; } }
    if (bv <= 0) break;
    C.push(P[j].slice()); for (let i = 0; i < P.length; i++) best[i] = Math.min(best[i], d2(P[i], P[j]));
  }
  const asg = new Int32Array(P.length);
  for (let it = 0; it < 12; it++) {
    let moved = 0;
    for (let i = 0; i < P.length; i++) { let bj = 0, bd = Infinity; for (let j = 0; j < C.length; j++) { const d = d2(P[i], C[j]); if (d < bd) { bd = d; bj = j; } } if (asg[i] !== bj) { asg[i] = bj; moved++; } }
    const S = C.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < P.length; i++) { const s = S[asg[i]]; s[0] += P[i][0] * Wt[i]; s[1] += P[i][1] * Wt[i]; s[2] += P[i][2] * Wt[i]; s[3] += Wt[i]; }
    S.forEach((s, j) => { if (s[3] > 0) C[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    if (!moved && it) break;
  }
  let out = C.map((c, j) => {
    if (!snap) return { lab: c, rgb: fromOklab(c[0], c[1], c[2]) };
    // the heaviest real bin of the cluster, among those near its centre (keeps a gradient's middle tone)
    let bi = -1, bv = -1;
    for (let i = 0; i < P.length; i++) if (asg[i] === j) { const v = B[i].n / (1 + 40 * d2(P[i], c)); if (v > bv) { bv = v; bi = i; } }
    if (bi < 0) return { lab: c, rgb: fromOklab(c[0], c[1], c[2]) };
    const e = B[bi]; return { lab: P[bi], rgb: [e.r / e.n / 255, e.g / e.n / 255, e.b / e.n / 255] as [number, number, number] };
  });
  // merge near duplicates
  const kept: typeof out = [];
  for (const c of out) if (!kept.some((k) => d2(k.lab, c.lab) < 0.04 * 0.04)) kept.push(c);
  out = kept;
  // order: neutrals first (dark → light), then by hue angle, dark → light inside a hue band
  const key = (l: number[]) => { const ch = Math.hypot(l[1], l[2]); if (ch < 0.03) return -1 + l[0] / 10; const hue = (Math.atan2(l[2], l[1]) / (2 * Math.PI) + 1) % 1; return Math.floor(hue * 12) + l[0] * 0.9; };
  out.sort((a, b) => key(a.lab) - key(b.lab));
  return out.map((c) => ({ hex: rgbHex(...c.rgb) }));
}

// ------------------------------------------------------------------ library
export const DEFAULT_PALETTE: Palette = {
  id: 'default', name: 'Gesso earth & bright', colors: ['#1d1b19', '#4a4038', '#8c7b6b', '#d9cbb8', '#f6f0e6', '#ffffff',
    '#7a1f1f', '#c0392b', '#e8734a', '#f2a65a', '#f5d06f', '#a8b545', '#4f7c3a', '#2f6b5f', '#3c8dad', '#28477a', '#5b3f8c', '#b5578f'].map((hex) => ({ hex })),
};
/** validate untrusted palette JSON (localStorage, .gesso manifests) */
export function cleanPalette(x: unknown): Palette | null {
  const p = x as Partial<Palette> | null;
  if (!p || typeof p !== 'object' || !Array.isArray(p.colors)) return null;
  const colors: Swatch[] = [];
  for (const c of p.colors.slice(0, 512)) { const hx = typeof c?.hex === 'string' ? normHex(c.hex) : null; if (hx) colors.push(typeof c.name === 'string' && c.name ? { hex: hx, name: c.name.slice(0, 60) } : { hex: hx }); }
  return { id: typeof p.id === 'string' ? p.id.slice(0, 40) : newId(), name: typeof p.name === 'string' ? p.name.slice(0, 60) || 'Palette' : 'Palette', colors };
}
export class PaletteLibrary {
  list: Palette[]; activeId: string;
  constructor(private store: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
    let raw: { list?: unknown[]; active?: string } = {};
    try { raw = JSON.parse(store.getItem('gesso.palettes') || '{}'); } catch { /* corrupt: start over */ }
    this.list = (raw.list || []).map(cleanPalette).filter(Boolean) as Palette[];
    if (!this.list.length) this.list = [structuredClone(DEFAULT_PALETTE)];
    this.activeId = raw.active && this.list.some((p) => p.id === raw.active) ? raw.active : this.list[0].id;
  }
  save() { this.store.setItem('gesso.palettes', JSON.stringify({ list: this.list, active: this.activeId })); }
  get(id: string) { return this.list.find((p) => p.id === id) || null; }
  add(p: Palette, activate = true) { if (this.list.some((q) => q.id === p.id)) p.id = newId(); this.list.push(p); if (activate) this.activeId = p.id; this.save(); return p; }
  remove(id: string) { this.list = this.list.filter((p) => p.id !== id); if (!this.list.length) this.list = [structuredClone(DEFAULT_PALETTE)]; if (!this.get(this.activeId)) this.activeId = this.list[0].id; this.save(); }
}

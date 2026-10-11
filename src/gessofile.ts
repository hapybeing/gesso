// Native .gesso file: a zip that is also a valid OpenRaster (.ora) document.
//   mimetype                  "image/openraster" (stored, first entry, per the ORA spec)
//   manifest.json             Gesso's full document description (layer props incl. clip / alpha lock / all 18 blends)
//   stack.xml                 ORA layer stack (so Krita, GIMP and MyPaint can open the file renamed to .ora)
//   data/<uid>.png            one straight-alpha PNG per layer, encoded exactly by our own PNG writer
//   mergedimage.png           flattened image (ORA requirement)
//   Thumbnails/thumbnail.png  ≤256 px preview
// Import reads manifest.json when present, otherwise falls back to stack.xml, so plain .ora files open too.
import type { LayerProps } from './engine';
import { BLEND_MODES } from './engine';

// ------------------------------------------------------------------ CRC32
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ------------------------------------------------------------------ streams
async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const s = new Blob([data as unknown as BlobPart]).stream().pipeThrough(t as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const enc = new TextEncoder(), dec = new TextDecoder();

// ------------------------------------------------------------------ zip writer
export interface ZipEntry { name: string; data: Uint8Array; deflate?: boolean; }
export async function zipWrite(entries: ZipEntry[]): Promise<Blob> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const body = e.deflate ? await pipe(e.data, new CompressionStream('deflate-raw')) : e.data;
    const method = e.deflate ? 8 : 0;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true); lh.setUint32(22, e.data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true); ch.setUint32(24, e.data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as unknown as BlobPart[], { type: 'application/zip' });
}

// ------------------------------------------------------------------ zip reader
export async function zipRead(blob: Blob): Promise<Map<string, () => Promise<Uint8Array>>> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, () => Promise<Uint8Array>>();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    out.set(name, async () => {
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const raw = buf.subarray(start, start + csize);
      let data: Uint8Array;
      if (method === 0) data = raw;
      else if (method === 8) data = await pipe(raw, new DecompressionStream('deflate-raw'));
      else throw new Error('Unsupported zip compression in ' + name);
      if (crc32(data) !== crc) throw new Error('Damaged file: checksum mismatch in ' + name);
      return data;
    });
  }
  return out;
}

// ------------------------------------------------------------------ PNG writer (RGBA8, straight alpha)
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** encode straight-alpha RGBA rows (top row first) as PNG; per-row adaptive filter choice */
export async function encodePNG(px: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < h; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    // 1 Sub, 2 Up, 4 Paeth, and 0 None (row itself)
    let best = 0, bestScore = 0;
    for (let i = 0; i < stride; i++) bestScore += row[i] < 128 ? row[i] : 256 - row[i];
    const [sub, upf, , pae] = cand;
    let sS = 0, sU = 0, sP = 0;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0, b = up ? up[i] : 0, c = up && i >= 4 ? up[i - 4] : 0;
      const v1 = (row[i] - a) & 255, v2 = (row[i] - b) & 255;
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const v4 = (row[i] - pr) & 255;
      sub[i] = v1; upf[i] = v2; pae[i] = v4;
      sS += v1 < 128 ? v1 : 256 - v1; sU += v2 < 128 ? v2 : 256 - v2; sP += v4 < 128 ? v4 : 256 - v4;
    }
    let src: Uint8Array = row;
    if (sS < bestScore) { best = 1; bestScore = sS; src = sub; }
    if (sU < bestScore) { best = 2; bestScore = sU; src = upf; }
    if (sP < bestScore) { best = 4; bestScore = sP; src = pae; }
    const o = y * (stride + 1);
    raw[o] = best; raw.set(src, o + 1);
    if ((y & 255) === 255) await new Promise((r) => setTimeout(r, 0)); // stay responsive on big layers
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = await pipe(raw, new CompressionStream('deflate'));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let k = 0; for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}

/** premultiplied RGBA -> straight RGBA (new array) */
export function unpremultiply(px: Uint8Array): Uint8Array {
  const out = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    out[i + 3] = a;
    if (a === 255) { out[i] = px[i]; out[i + 1] = px[i + 1]; out[i + 2] = px[i + 2]; }
    else if (a) { const k = 255 / a; out[i] = Math.min(255, Math.round(px[i] * k)); out[i + 1] = Math.min(255, Math.round(px[i + 1] * k)); out[i + 2] = Math.min(255, Math.round(px[i + 2] * k)); }
  }
  return out;
}

// ------------------------------------------------------------------ document <-> file
export interface GessoDoc {
  name: string; w: number; h: number;
  bg: [number, number, number]; bgVisible: boolean;
  active: number;
  layers: { props: LayerProps; png: Uint8Array; offset?: { x: number; y: number } }[];   // bottom to top
  merged?: Uint8Array; thumb?: Uint8Array;
  extra?: Record<string, unknown>;
}

const ORA_OPS = ['svg:src-over', 'svg:multiply', 'svg:screen', 'svg:overlay', 'svg:darken', 'svg:lighten', 'svg:color-dodge', 'svg:color-burn',
  'svg:hard-light', 'svg:soft-light', 'svg:difference', 'svg:exclusion', 'svg:plus', 'krita:linear_burn', 'svg:hue', 'svg:saturation', 'svg:color', 'svg:luminosity'];
const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));

export async function writeGesso(doc: GessoDoc): Promise<Blob> {
  const manifest = {
    format: 'gesso', version: 1, app: 'Gesso',
    name: doc.name, width: doc.w, height: doc.h, background: doc.bg, backgroundVisible: doc.bgVisible, active: doc.active,
    layers: doc.layers.map((l) => ({ ...l.props, blendName: BLEND_MODES[l.props.blend], file: `data/${l.props.uid}.png` })),
    extra: doc.extra || {},
  };
  const stack = `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.5" w="${doc.w}" h="${doc.h}">\n <stack>\n` +
    [...doc.layers].reverse().map((l) => `  <layer name="${xmlEsc(l.props.name)}" src="data/${l.props.uid}.png" x="0" y="0" opacity="${l.props.opacity.toFixed(3)}" visibility="${l.props.visible ? 'visible' : 'hidden'}" composite-op="${ORA_OPS[l.props.blend] || 'svg:src-over'}"${l.props.alphaLock ? ' alpha-preserve="true"' : ''}/>`).join('\n') +
    (doc.bgVisible ? `\n  <layer name="Background" src="data/background.png" x="0" y="0" opacity="1.000" visibility="visible" composite-op="svg:src-over"/>` : '') +
    `\n </stack>\n</image>\n`;
  const entries: ZipEntry[] = [
    { name: 'mimetype', data: enc.encode('image/openraster') },
    { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 1)), deflate: true },
    { name: 'stack.xml', data: enc.encode(stack), deflate: true },
    ...doc.layers.map((l) => ({ name: `data/${l.props.uid}.png`, data: l.png })),
  ];
  if (doc.bgVisible) {
    // solid background for other apps (Gesso itself reads the colour from manifest.json)
    const px = new Uint8Array(doc.w * doc.h * 4);
    const [r, g, b] = doc.bg.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
    for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
    entries.push({ name: 'data/background.png', data: await encodePNG(px, doc.w, doc.h) });
  }
  if (doc.merged) entries.push({ name: 'mergedimage.png', data: doc.merged });
  if (doc.thumb) entries.push({ name: 'Thumbnails/thumbnail.png', data: doc.thumb });
  return zipWrite(entries);
}

export async function readGesso(blob: Blob, fallbackName = 'Imported'): Promise<GessoDoc> {
  const z = await zipRead(blob);
  const get = async (n: string) => { const f = z.get(n); if (!f) throw new Error('Missing ' + n + ' in file'); return f(); };
  if (z.has('manifest.json')) {
    const m = JSON.parse(dec.decode(await get('manifest.json')));
    if (m.format !== 'gesso') throw new Error('Not a Gesso file');
    if (m.version > 1) throw new Error('This file was made by a newer Gesso — update the app to open it');
    const layers = await Promise.all((m.layers as (LayerProps & { file: string })[]).map(async (l) => ({
      props: { uid: l.uid, name: String(l.name ?? 'Layer'), visible: l.visible !== false, opacity: +l.opacity || 0, blend: Math.max(0, Math.min(BLEND_MODES.length - 1, l.blend | 0)), alphaLock: !!l.alphaLock, clip: !!l.clip },
      png: await get(l.file),
    })));
    return { name: m.name || fallbackName, w: m.width | 0, h: m.height | 0, bg: m.background || [1, 1, 1], bgVisible: m.backgroundVisible !== false, active: m.active | 0, layers, extra: m.extra || {} };
  }
  // plain OpenRaster
  const xml = new DOMParser().parseFromString(dec.decode(await get('stack.xml')), 'application/xml');
  const img = xml.querySelector('image');
  if (!img) throw new Error('Not an OpenRaster or Gesso file');
  const w = +(img.getAttribute('w') || 0), h = +(img.getAttribute('h') || 0);
  const nodes = [...xml.querySelectorAll('layer')].reverse(); // ORA lists top first
  const layers: GessoDoc['layers'] = [];
  let n = 0;
  for (const el of nodes) {
    const src = el.getAttribute('src'); if (!src || !z.has(src)) continue;
    const x = +(el.getAttribute('x') || 0), y = +(el.getAttribute('y') || 0);
    const op = ORA_OPS.indexOf(el.getAttribute('composite-op') || 'svg:src-over');
    layers.push({
      props: { uid: 'ora' + n++ + Math.random().toString(36).slice(2, 6), name: el.getAttribute('name') || 'Layer ' + n, visible: el.getAttribute('visibility') !== 'hidden', opacity: el.hasAttribute('opacity') ? +el.getAttribute('opacity')! : 1, blend: Math.max(0, op), alphaLock: el.getAttribute('alpha-preserve') === 'true', clip: false },
      png: await get(src), offset: { x, y },
    });
  }
  return { name: fallbackName, w, h, bg: [1, 1, 1], bgVisible: false, active: layers.length - 1, layers };
}

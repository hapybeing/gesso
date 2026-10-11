// Brush presets and procedurally generated (original) stamp + grain textures.

export type ShapeId = 'hard' | 'soft' | 'pencil' | 'chalk' | 'spatter' | 'chisel' | 'bristle' | 'wash';
export type GrainId = 'none' | 'paper' | 'canvas' | 'noise' | 'cold';

export interface Brush {
  id: string;
  name: string;
  group: string;
  shape: ShapeId;
  grain: GrainId;
  mode: 'paint' | 'smudge';
  size: number;        // max diameter in canvas px
  minSize: number;     // size at zero pressure (fraction)
  opacity: number;     // stroke max opacity 0..1
  flow: number;        // per-dab alpha 0..1
  spacing: number;     // dab spacing as fraction of diameter
  sizeJitter: number;
  opacityJitter: number;
  scatter: number;     // fraction of diameter
  rotJitter: number;   // 0..1 => 0..360deg
  followDir: boolean;  // rotate dabs along stroke direction
  roundness: number;   // 0..1 aspect
  angle: number;       // degrees
  taperStart: number;  // px of screen-independent taper
  taperEnd: number;
  pressSize: number;   // 0..1
  pressOpacity: number;// 0..1 (affects flow)
  tiltSize: number;    // 0..1 how much tilt grows the dab
  grainScale: number;  // texture scale
  grainDepth: number;  // 0..1
  wetEdges: number;    // 0..1
  smoothing: number;   // 0..1 streamline
  smudge: number;      // smudge strength 0..1
  /** wet media: after the stroke, pigment and water diffuse and dry on the paper (0 = off) */
  wet?: number;
  /** granulation of the drying pigment into the paper grain 0..1 */
  granulation?: number;
}

const base: Omit<Brush, 'id' | 'name' | 'group'> = {
  shape: 'hard', grain: 'none', mode: 'paint', size: 24, minSize: 0.15, opacity: 1, flow: 1, spacing: 0.08,
  sizeJitter: 0, opacityJitter: 0, scatter: 0, rotJitter: 0, followDir: false, roundness: 1, angle: 0,
  taperStart: 0, taperEnd: 0, pressSize: 1, pressOpacity: 0, tiltSize: 0, grainScale: 1, grainDepth: 0,
  wetEdges: 0, smoothing: 0.25, smudge: 0.7,
};

const B = (id: string, name: string, group: string, o: Partial<Brush>): Brush => ({ ...base, id, name, group, ...o });

export const BRUSHES: Brush[] = [
  B('ink-studio', 'Studio Ink', 'Inking', { size: 14, minSize: 0.05, spacing: 0.05, taperStart: 30, taperEnd: 40, smoothing: 0.35 }),
  B('ink-gel', 'Gel Pen', 'Inking', { size: 8, minSize: 0.55, spacing: 0.05, smoothing: 0.3 }),
  B('ink-brushpen', 'Brush Pen', 'Inking', { size: 30, minSize: 0.02, spacing: 0.04, roundness: 0.55, angle: 35, taperStart: 60, taperEnd: 90, smoothing: 0.45 }),
  B('pencil-hb', 'HB Pencil', 'Sketching', { shape: 'pencil', grain: 'paper', size: 7, minSize: 0.5, flow: 0.55, spacing: 0.12, pressSize: 0.4, pressOpacity: 1, tiltSize: 1.6, grainScale: 0.9, grainDepth: 0.85, rotJitter: 1, smoothing: 0.1 }),
  B('pencil-6b', '6B Graphite', 'Sketching', { shape: 'pencil', grain: 'cold', size: 16, minSize: 0.4, flow: 0.45, spacing: 0.1, pressSize: 0.5, pressOpacity: 1, tiltSize: 2.2, grainScale: 1.1, grainDepth: 0.9, rotJitter: 1, smoothing: 0.1 }),
  B('charcoal', 'Willow Charcoal', 'Sketching', { shape: 'chalk', grain: 'paper', size: 40, minSize: 0.35, flow: 0.5, spacing: 0.1, pressOpacity: 0.9, pressSize: 0.6, tiltSize: 1.5, grainScale: 1.6, grainDepth: 0.95, rotJitter: 1, scatter: 0.05, smoothing: 0.05 }),
  B('air-soft', 'Soft Air', 'Airbrush', { shape: 'soft', size: 160, minSize: 0.6, flow: 0.06, spacing: 0.06, pressSize: 0.4, pressOpacity: 1, smoothing: 0.4 }),
  B('air-hard', 'Hard Air', 'Airbrush', { shape: 'soft', size: 60, minSize: 0.7, flow: 0.18, spacing: 0.05, pressSize: 0.2, pressOpacity: 1, smoothing: 0.3 }),
  B('air-spatter', 'Speckle Can', 'Airbrush', { shape: 'spatter', size: 120, minSize: 0.6, flow: 0.5, spacing: 0.35, rotJitter: 1, sizeJitter: 0.4, scatter: 0.3, pressOpacity: 0.7, smoothing: 0 }),
  B('wc-wash', 'Wet Wash', 'Watercolour', { shape: 'wash', grain: 'paper', size: 90, minSize: 0.5, opacity: 0.75, flow: 0.25, spacing: 0.07, pressSize: 0.6, pressOpacity: 0.6, grainScale: 3, grainDepth: 0.12, wetEdges: 0.9, rotJitter: 1, smoothing: 0.35, wet: 0.8, granulation: 0.5 }),
  B('wc-round', 'Round Sable', 'Watercolour', { shape: 'soft', grain: 'cold', size: 36, minSize: 0.2, opacity: 0.8, flow: 0.35, spacing: 0.05, grainScale: 2.5, grainDepth: 0.15, wetEdges: 0.7, taperStart: 20, taperEnd: 40, smoothing: 0.35, wet: 0.45, granulation: 0.35 }),
  B('wc-bleed', 'Bleed Bloom', 'Watercolour', { shape: 'wash', grain: 'paper', size: 140, minSize: 0.7, opacity: 0.55, flow: 0.14, spacing: 0.08, scatter: 0.06, sizeJitter: 0.2, rotJitter: 1, grainScale: 3, grainDepth: 0.15, wetEdges: 1, smoothing: 0.3, wet: 1, granulation: 0.6 }),
  B('marker-chisel', 'Chisel Marker', 'Markers', { shape: 'chisel', size: 28, minSize: 0.85, opacity: 0.7, flow: 1, spacing: 0.03, roundness: 0.3, angle: 45, pressSize: 0.15, smoothing: 0.3 }),
  B('marker-felt', 'Felt Tip', 'Markers', { shape: 'hard', grain: 'noise', size: 12, minSize: 0.8, opacity: 0.85, flow: 0.9, spacing: 0.05, pressSize: 0.2, grainDepth: 0.25, smoothing: 0.25 }),
  B('paint-bristle', 'Oil Bristle', 'Painting', { shape: 'bristle', grain: 'canvas', size: 50, minSize: 0.4, flow: 0.85, spacing: 0.04, followDir: true, pressSize: 0.6, pressOpacity: 0.4, grainDepth: 0.35, grainScale: 1.0, taperEnd: 40, smoothing: 0.2 }),
  B('paint-gouache', 'Gouache Flat', 'Painting', { shape: 'chalk', grain: 'canvas', size: 44, minSize: 0.6, flow: 0.7, opacity: 1, spacing: 0.05, roundness: 0.6, followDir: true, grainDepth: 0.3, pressOpacity: 0.5, smoothing: 0.2 }),
  B('smudge-soft', 'Soft Blend', 'Smudge', { mode: 'smudge', shape: 'soft', size: 70, minSize: 0.6, spacing: 0.08, smudge: 0.8, pressOpacity: 1, smoothing: 0.2 }),
  B('smudge-streak', 'Streaky Drag', 'Smudge', { mode: 'smudge', shape: 'bristle', size: 50, minSize: 0.6, spacing: 0.06, followDir: true, smudge: 0.9, pressOpacity: 1, smoothing: 0.2 }),
];

export const SHAPES: ShapeId[] = ['hard', 'soft', 'pencil', 'chalk', 'spatter', 'chisel', 'bristle', 'wash'];
export const GRAINS: GrainId[] = ['none', 'paper', 'cold', 'canvas', 'noise'];

// Seeded RNG (mulberry32)
export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SZ = 128;
function canvas(w = SZ, h = SZ) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Returns a canvas whose alpha (stored in all channels as white) is the dab mask.
export function makeShape(id: ShapeId): HTMLCanvasElement {
  const c = canvas();
  const g = c.getContext('2d')!;
  const img = g.createImageData(SZ, SZ);
  const r = rng(id.length * 7919 + id.charCodeAt(0));
  const put = (fn: (x: number, y: number, d: number) => number) => {
    for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) {
      const nx = (x + 0.5) / SZ * 2 - 1, ny = (y + 0.5) / SZ * 2 - 1;
      const d = Math.hypot(nx, ny);
      const a = Math.max(0, Math.min(1, fn(nx, ny, d)));
      const i = (y * SZ + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  };
  const smooth = (e0: number, e1: number, v: number) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  switch (id) {
    case 'hard': put((_x, _y, d) => 1 - smooth(0.9, 1.0, d)); break;
    case 'soft': put((_x, _y, d) => { const t = Math.max(0, 1 - d); return t * t * (3 - 2 * t); }); break;
    case 'chisel': put((x, y) => (1 - smooth(0.85, 1, Math.abs(x))) * (1 - smooth(0.85, 1, Math.abs(y)))); break;
    case 'pencil': {
      const n = new Float32Array(SZ * SZ).map(() => r());
      put((x, y, d) => {
        const px = Math.floor((x * 0.5 + 0.5) * (SZ - 1)), py = Math.floor((y * 0.5 + 0.5) * (SZ - 1));
        const v = n[py * SZ + px];
        return (1 - smooth(0.55, 1, d)) * (v > 0.35 ? 0.4 + v * 0.6 : v * 0.6);
      });
      break;
    }
    case 'chalk': {
      const blobs: [number, number, number][] = [];
      for (let i = 0; i < 90; i++) { const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * 0.85; blobs.push([Math.cos(a) * rr, Math.sin(a) * rr, 0.05 + r() * 0.18]); }
      put((x, y, d) => {
        let v = 0;
        for (const [bx, by, br] of blobs) { const dd = Math.hypot(x - bx, y - by); if (dd < br) v += (1 - dd / br) * 0.9; }
        return Math.min(1, v) * (1 - smooth(0.75, 1, d));
      });
      break;
    }
    case 'spatter': {
      const dots: [number, number, number][] = [];
      for (let i = 0; i < 70; i++) { const a = r() * Math.PI * 2, rr = Math.pow(r(), 0.7) * 0.9; dots.push([Math.cos(a) * rr, Math.sin(a) * rr, 0.012 + Math.pow(r(), 3) * 0.08]); }
      put((x, y) => { let v = 0; for (const [bx, by, br] of dots) { const dd = Math.hypot(x - bx, y - by); v = Math.max(v, 1 - smooth(br * 0.7, br, dd)); } return v; });
      break;
    }
    case 'bristle': {
      const hairs: [number, number][] = [];
      // stratified so hairs cover the whole tip (random placement left a visible bald band)
      for (let i = 0; i < 30; i++) hairs.push([-0.92 + ((i + 0.2 + r() * 0.6) / 30) * 1.84, 0.35 + r() * 0.65]);
      put((x, y) => {
        let v = 0;
        for (const [hx, hs] of hairs) { const dd = Math.abs(y - hx); if (dd < 0.07) v = Math.max(v, (1 - dd / 0.07) * hs); }
        return v * (1 - smooth(0.6, 1, Math.abs(x))) * (1 - smooth(0.9, 1, Math.abs(y)));
      });
      break;
    }
    case 'wash': {
      // irregular soft blob with a slightly lumpy edge
      const k = [r(), r(), r(), r(), r()];
      put((x, y, d) => {
        const a = Math.atan2(y, x);
        const edge = 0.84 + 0.06 * Math.sin(a * 3 + k[0] * 6) + 0.04 * Math.sin(a * 5 + k[1] * 6) + 0.02 * Math.sin(a * 9 + k[2] * 6);
        return 1 - smooth(edge * 0.25, edge, d);
      });
      break;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Tileable value-noise fbm
function tileNoise(size: number, periods: number[], seed: number, weights: number[]): Float32Array {
  const out = new Float32Array(size * size);
  let ws = 0;
  periods.forEach((p, oi) => {
    const r = rng(seed + oi * 101);
    const lat = new Float32Array(p * p).map(() => r());
    const w = weights[oi]; ws += w;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / size * p, fy = y / size * p;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const L = (i: number, j: number) => lat[((j % p) * p) + (i % p)];
      const a = L(x0, y0), b = L(x0 + 1, y0), c = L(x0, y0 + 1), d = L(x0 + 1, y0 + 1);
      out[y * size + x] += w * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
    }
  });
  for (let i = 0; i < out.length; i++) out[i] /= ws;
  return out;
}

export function makeGrain(id: GrainId): HTMLCanvasElement {
  const S = 256;
  const c = canvas(S, S);
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  let v: Float32Array;
  switch (id) {
    case 'paper': v = tileNoise(S, [8, 32, 64, 128], 11, [0.2, 0.3, 0.3, 0.6]); break;
    case 'cold': v = tileNoise(S, [6, 16, 48, 128], 23, [0.5, 0.5, 0.35, 0.3]); break;
    case 'noise': v = tileNoise(S, [128, 256], 5, [0.5, 0.5]); break;
    case 'canvas': {
      const n = tileNoise(S, [64, 128], 9, [0.5, 0.5]);
      v = new Float32Array(S * S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const wx = Math.sin(x / S * Math.PI * 2 * 32), wy = Math.sin(y / S * Math.PI * 2 * 32);
        const over = ((Math.floor(x / S * 32) + Math.floor(y / S * 32)) & 1) ? wx : wy;
        v[y * S + x] = 0.5 + 0.35 * Math.abs(over) - 0.15 + n[y * S + x] * 0.3;
      }
      break;
    }
    default: v = new Float32Array(S * S).fill(1);
  }
  // normalise contrast
  let mn = 1, mx = 0;
  for (const x of v) { mn = Math.min(mn, x); mx = Math.max(mx, x); }
  for (let i = 0; i < S * S; i++) {
    const t = id === 'none' ? 1 : (v[i] - mn) / Math.max(1e-6, mx - mn);
    const b = Math.round(t * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

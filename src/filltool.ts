// Fill tool (M5): colour fill with live threshold, gap closing and expand; linear/radial gradient; recolour.
// Bar (research): Procreate ColorDrop — drag the colour onto the canvas, keep holding and slide to set the
// threshold, "Reference" layer for filling flats under line art; Clip Studio's fill — close gaps, area scaling
// (expand under the line), reference (all / reference / editing layer); Krita — fill gaps, grow, reference
// layers; Infinite Painter — gap closing + expand. Gesso: touch (or ColorDrop from the colour button) fills,
// slide sideways before lifting to change the threshold with a live preview; gaps up to 2×gap px are closed
// (barriers dilated by `gap`, flood, then the region regrown geodesically so corners fill); the fill expands
// `expand` px under the line art with a 1-px anti-aliased edge, so no light halo is left next to the lines.
import type { Engine, Rect } from './engine';
import type { Grab, Input } from './input';

export type FillRef = 'canvas' | 'layer' | 'reference';
export type FillMode = 'fill' | 'gradient' | 'recolour';
export interface FillSettings { mode: FillMode; threshold: number; gap: number; expand: number; ref: FillRef; grad: 'linear' | 'radial'; gradTo: 'transparent' | 'previous'; global: boolean; }
export const defaultFill = (): FillSettings => ({ mode: 'fill', threshold: 0.1, gap: 0, expand: 1, ref: 'canvas', grad: 'linear', gradTo: 'transparent', global: false });

const INF = 1e20;
/** exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher) of a 0/INF grid, in place */
export function edt(f: Float32Array, W: number, H: number) {
  const n = Math.max(W, H), d = new Float32Array(n), v = new Int32Array(n), z = new Float32Array(n + 1), g = new Float32Array(n);
  const pass = (len: number, get: (i: number) => number, set: (i: number, x: number) => void) => {
    for (let i = 0; i < len; i++) g[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + g[v[k]]; }
    for (let i = 0; i < len; i++) set(i, d[i]);
  };
  for (let x = 0; x < W; x++) pass(H, (i) => f[i * W + x], (i, val) => { f[i * W + x] = val; });
  for (let y = 0; y < H; y++) { const o = y * W; pass(W, (i) => f[o + i], (i, val) => { f[o + i] = val; }); }
}

export interface FillResult { cov: Uint8Array; rect: Rect; seed: [number, number, number]; area: number; closedGap: boolean; }
/**
 * Region fill over premultiplied RGBA (row 0 = top). Returns bbox-cropped coverage (0..255) or null when the
 * seed is outside the image. global = every similar pixel (recolour), not just the connected region.
 */
/** colour distance of every pixel from the seed (weighted premultiplied RGBA, as the wand); independent of the threshold */
export function seedDistance(px: Uint8Array, W: number, H: number, sx: number, sy: number): Float32Array {
  const N = W * H, i0 = (sy * W + sx) * 4;
  const r0 = px[i0], g0 = px[i0 + 1], b0 = px[i0 + 2], a0 = px[i0 + 3];
  const dist = new Float32Array(N);
  for (let k = 0, i = 0; k < N; k++, i += 4) {
    const dr = px[i] - r0, dg = px[i + 1] - g0, db = px[i + 2] - b0, da = px[i + 3] - a0;
    dist[k] = Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db + da * da);
  }
  return dist;
}
export function regionFill(px: Uint8Array, W: number, H: number, sx: number, sy: number, o: { threshold: number; gap: number; expand: number; global?: boolean }, distIn?: Float32Array): FillResult | null {
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const N = W * H, i0 = (sy * W + sx) * 4;
  const a0 = px[i0 + 3], r0 = px[i0], g0 = px[i0 + 1], b0 = px[i0 + 2];
  // hard threshold + a soft band for anti-aliased edges
  const hard = Math.max(1, o.threshold * 255 * 2), soft = hard + 0.06 * 255 * 2;
  // the distance field is reused while the threshold slides (only the flood re-runs)
  const dist = distIn ?? seedDistance(px, W, H, sx, sy);
  const region = new Uint8Array(N);
  let closedGap = false;
  if (o.global) { for (let k = 0; k < N; k++) if (dist[k] <= hard) region[k] = 1; }
  else {
    // passable = within threshold, and (with gap closing) farther than `gap` from any barrier pixel
    let pass: Uint8Array;
    if (o.gap > 0) {
      const f = new Float32Array(N); for (let k = 0; k < N; k++) f[k] = dist[k] > hard ? 0 : INF;
      edt(f, W, H);
      const g2 = o.gap * o.gap;
      pass = new Uint8Array(N); for (let k = 0; k < N; k++) pass[k] = f[k] > g2 ? 1 : 0;
      if (!pass[sy * W + sx]) { for (let k = 0; k < N; k++) pass[k] = dist[k] <= hard ? 1 : 0; } else closedGap = true;
    } else { pass = new Uint8Array(N); for (let k = 0; k < N; k++) pass[k] = dist[k] <= hard ? 1 : 0; }
    // scanline flood (4-connected) over pass
    const st: number[] = [sx, sy];
    while (st.length) {
      const y = st.pop()!, x0 = st.pop()!, row = y * W;
      if (region[row + x0] || !pass[row + x0]) continue;
      let x = x0; while (x > 0 && pass[row + x - 1] && !region[row + x - 1]) x--;
      let up = false, dn = false;
      for (; x < W && pass[row + x] && !region[row + x]; x++) {
        region[row + x] = 1;
        if (y > 0) { const u = row + x - W; if (pass[u] && !region[u]) { if (!up) { st.push(x, y - 1); up = true; } } else up = false; }
        if (y < H - 1) { const d = row + x + W; if (pass[d] && !region[d]) { if (!dn) { st.push(x, y + 1); dn = true; } } else dn = false; }
      }
    }
    if (closedGap) {
      // regrow by gap+1 px through non-barrier pixels only (geodesic BFS), so the fill reaches into corners
      // the dilated barrier cut off, without crossing a line
      const R = o.gap + 1; let front: number[] = [];
      for (let k = 0; k < N; k++) if (region[k]) front.push(k);
      for (let step = 0; step < R && front.length; step++) {
        const next: number[] = [];
        for (const k of front) {
          const x = k % W, y = (k - x) / W;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const q = ny * W + nx; if (region[q] || dist[q] > hard) continue;
            region[q] = 1; next.push(q);
          }
        }
        front = next;
      }
    }
  }
  // coverage: inside 255; the soft band next to the region gets partial coverage (anti-aliased edge)
  const cov = new Uint8Array(N); let area = 0;
  let x1 = W, y1 = H, x2 = -1, y2 = -1;
  const mark = (k: number, v: number) => { if (v > cov[k]) cov[k] = v; const x = k % W, y = (k - x) / W; if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; };
  for (let k = 0; k < N; k++) {
    if (region[k]) { mark(k, 255); area++; continue; }
    const d = dist[k]; if (d >= soft) continue;
    const x = k % W;
    if ((x > 0 && region[k - 1]) || (x < W - 1 && region[k + 1]) || (k >= W && region[k - W]) || (k < N - W && region[k + W])) mark(k, Math.round(255 * (soft - d) / (soft - hard)));
  }
  if (x2 < 0) return null;
  if (o.expand > 0) {
    // grow under the line art: distance to the region, full inside expand, 1-px anti-aliased rim
    const e = o.expand, pad = Math.ceil(e) + 2;
    const bx = Math.max(0, x1 - pad), by = Math.max(0, y1 - pad), bw = Math.min(W, x2 + pad + 1) - bx, bh = Math.min(H, y2 + pad + 1) - by;
    const f = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) f[y * bw + x] = cov[(by + y) * W + bx + x] >= 128 ? 0 : INF;
    edt(f, bw, bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const dd = Math.sqrt(f[y * bw + x]); const v = Math.max(0, Math.min(1, e + 0.5 - dd));
      if (v > 0) mark((by + y) * W + bx + x, Math.round(v * 255));
    }
  }
  const rect = { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
  const out = new Uint8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) out.set(cov.subarray((rect.y + y) * W + rect.x, (rect.y + y) * W + rect.x + rect.w), y * rect.w);
  const a = a0 / 255 || 1;
  return { cov: out, rect, seed: [r0 / 255 / a, g0 / 255 / a, b0 / 255 / a].map((v) => Math.min(1, v)) as [number, number, number], area, closedGap };
}

export interface FillHost {
  engine: Engine;
  settings(): FillSettings;
  colour(): [number, number, number];
  previous(): [number, number, number];
  /** reference pixels for a fill (premultiplied, row 0 = top) */
  pixels(ref: FillRef): Promise<Uint8Array>;
  overlayChanged(): void;
  toast(m: string): void;
  changed(): void;
}

export class FillTool implements Grab {
  private cache: { key: string; p: Promise<Uint8Array> } | null = null;
  private session: { px: Uint8Array; dist: Float32Array; seed: { x: number; y: number }; sx: number; base: number; res: FillResult | null; raf: number; id: number } | null = null;
  private grad: { id: number; a: { x: number; y: number }; b: { x: number; y: number } } | null = null;
  stats = { fills: 0, lastMs: 0 };
  constructor(private host: FillHost) {}
  get e() { return this.host.engine; }
  wants(e: PointerEvent, input: Input) {
    if (e.pointerType !== 'touch') return true;
    return input.stylusMode === 'any' || (input.stylusMode === 'auto' && !input.penSeen);
  }
  private refKey(ref: FillRef) {
    const e = this.e;
    if (ref === 'layer') return 'L' + e.activeLayer.id + ':' + e.activeLayer.version;
    return ref + ':' + e.layers.map((l) => l.id + '.' + l.version + (l.visible ? 'v' : 'h') + Math.round(l.opacity * 100) + 'b' + l.blend).join(',') + ':' + e.structVersion;
  }
  invalidate() { this.cache = null; }
  private pixels(ref: FillRef) {
    const k = this.refKey(ref);
    if (!this.cache || this.cache.key !== k) this.cache = { key: k, p: this.host.pixels(ref) };
    return this.cache.p;
  }
  // -------------------------------------------------------------- input
  down(ev: PointerEvent, x: number, y: number) {
    const s = this.host.settings(), d = this.e.screenToDoc(x, y);
    if (s.mode === 'gradient') { this.grad = { id: ev.pointerId, a: d, b: d }; this.host.overlayChanged(); return; }
    void this.begin(d, x, ev.pointerId);
  }
  move(ev: PointerEvent, x: number, y: number) {
    if (this.grad && ev.pointerId === this.grad.id) { this.grad.b = this.e.screenToDoc(x, y); this.host.overlayChanged(); return; }
    const ss = this.session; if (!ss || ev.pointerId !== ss.id) return;
    // ColorDrop-style: slide sideways while holding to change the threshold (600 px = 100 %)
    const s = this.host.settings();
    const t = Math.max(0.005, Math.min(1, ss.base + (x - ss.sx) / 600));
    if (Math.abs(t - s.threshold) > 0.002) { s.threshold = t; this.schedule(); }
  }
  up(ev: PointerEvent) {
    if (this.grad && ev.pointerId === this.grad.id) { this.applyGradient(); return; }
    const ss = this.session; if (!ss || ev.pointerId !== ss.id) return;
    ss.id = -1;
    if (!ss.raf) this.commit();
  }
  /** a ColorDrop released over the canvas at screen (x, y) */
  async drop(x: number, y: number) { await this.begin(this.e.screenToDoc(x, y), x, -1); }

  private async begin(d: { x: number; y: number }, sx: number, id: number) {
    const e = this.e, s = this.host.settings();
    if (d.x < 0 || d.y < 0 || d.x >= e.w || d.y >= e.h) return;
    if (e.activeLayer.group) { this.host.toast('Pick a layer (not a group) to fill'); return; }
    const ref = s.mode === 'recolour' ? 'layer' : s.ref;
    const px = await this.pixels(ref);
    const seed = { x: Math.floor(d.x), y: Math.floor(d.y) };
    this.session = { px, dist: seedDistance(px, e.w, e.h, seed.x, seed.y), seed, sx, base: s.threshold, res: null, raf: 0, id };
    this.run();
    if (id < 0) this.commit();
  }
  private schedule() {
    const ss = this.session; if (!ss || ss.raf) return;
    ss.raf = requestAnimationFrame(() => { ss.raf = 0; this.run(); if (ss.id < 0 && this.session === ss) this.commit(); });
  }
  private run() {
    const ss = this.session; if (!ss) return;
    const s = this.host.settings(), e = this.e;
    const t0 = performance.now();
    const opt = s.mode === 'recolour' ? { threshold: s.threshold, gap: 0, expand: 0, global: s.global } : { threshold: s.threshold, gap: s.gap, expand: s.expand };
    ss.res = regionFill(ss.px, e.w, e.h, ss.seed.x, ss.seed.y, opt, ss.dist);
    this.stats.lastMs = Math.round(performance.now() - t0);
    this.preview = ss.res ? this.previewCanvas(ss.res) : null;
    this.host.overlayChanged();
  }
  private commit() {
    const ss = this.session; this.session = null; this.preview = null;
    if (!ss || !ss.res) { this.host.overlayChanged(); return; }
    const s = this.host.settings(), c = this.host.colour();
    const label = s.mode === 'recolour' ? 'Recolour' : 'Fill';
    this.e.paintLayer({ mode: s.mode === 'recolour' ? 3 : 0, c0: [c[0], c[1], c[2], 1], seed: ss.res.seed, cov: { data: ss.res.cov, rect: ss.res.rect }, label });
    this.stats.fills++;
    this.host.toast(`${label} · threshold ${Math.round(s.threshold * 100)}%` + (ss.res.closedGap ? ' · gaps closed' : ''));
    this.host.changed(); this.host.overlayChanged();
  }
  private applyGradient() {
    const g = this.grad!; this.grad = null;
    const s = this.host.settings(), c = this.host.colour();
    const len = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) * this.e.view.scale;
    if (len < 6) { this.host.overlayChanged(); return; }
    const p = this.host.previous();
    const c1: [number, number, number, number] = s.gradTo === 'transparent' ? [c[0], c[1], c[2], 0] : [p[0], p[1], p[2], 1];
    this.e.paintLayer({ mode: s.grad === 'linear' ? 1 : 2, c0: [c[0], c[1], c[2], 1], c1, p0: g.a, p1: g.b, label: 'Gradient' });
    this.host.changed(); this.host.overlayChanged();
  }
  cancel() { if (this.session?.raf) cancelAnimationFrame(this.session.raf); this.session = null; this.grad = null; this.preview = null; this.host.overlayChanged(); }

  // -------------------------------------------------------------- overlay
  private preview: { c: HTMLCanvasElement; rect: Rect } | null = null;
  private previewCanvas(r: FillResult) {
    const c = document.createElement('canvas'); c.width = r.rect.w; c.height = r.rect.h;
    const g = c.getContext('2d')!, img = g.createImageData(r.rect.w, r.rect.h);
    const col = this.host.settings().mode === 'recolour' ? [255, 255, 255] : this.host.colour().map((v) => Math.round(v * 255));
    for (let i = 0, k = 0; k < r.cov.length; k++, i += 4) { img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = Math.round(r.cov[k] * 0.75); }
    g.putImageData(img, 0, 0);
    return { c, rect: r.rect };
  }
  drawOverlay(g: CanvasRenderingContext2D) {
    const e = this.e, v = e.view;
    if (this.preview) {
      g.save();
      const cs = Math.cos(v.rot) * v.scale, sn = Math.sin(v.rot) * v.scale;
      g.transform(cs, sn, -sn, cs, v.x, v.y);
      g.imageSmoothingEnabled = false;
      g.drawImage(this.preview.c, this.preview.rect.x, this.preview.rect.y);
      g.restore();
      const ss = this.session;
      if (ss) {
        const s = e.docToScreen(ss.seed.x, ss.seed.y), st = this.host.settings();
        const t = `Threshold ${Math.round(st.threshold * 100)}%` + (ss.id >= 0 ? ' · slide sideways' : '');
        g.font = '600 13px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        const w = g.measureText(t).width + 18;
        g.fillStyle = 'rgba(32,29,27,.92)'; g.beginPath(); g.roundRect(s.x - w / 2, s.y - 48, w, 26, 13); g.fill();
        g.fillStyle = '#f1e9dd'; g.fillText(t, s.x, s.y - 35);
      }
    }
    if (this.grad) {
      const a = e.docToScreen(this.grad.a.x, this.grad.a.y), b = e.docToScreen(this.grad.b.x, this.grad.b.y);
      const s = this.host.settings(), c = this.host.colour().map((x) => Math.round(x * 255)).join(',');
      g.save();
      if (s.grad === 'radial') { g.beginPath(); g.arc(a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y), 0, Math.PI * 2); g.strokeStyle = 'rgba(255,255,255,.8)'; g.setLineDash([6, 5]); g.lineWidth = 1.5; g.stroke(); g.setLineDash([]); }
      const gr = g.createLinearGradient(a.x, a.y, b.x, b.y); gr.addColorStop(0, `rgb(${c})`); gr.addColorStop(1, s.gradTo === 'transparent' ? `rgba(${c},0)` : `rgb(${this.host.previous().map((x) => Math.round(x * 255)).join(',')})`);
      g.lineCap = 'round'; g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 9; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      g.strokeStyle = gr; g.lineWidth = 6; g.stroke();
      for (const p of [a, b]) { g.beginPath(); g.arc(p.x, p.y, 8, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke(); }
      g.restore();
    }
  }
}

// Adjustments as live-preview filters on the active layer (inside the selection when there is one):
// Hue/Saturation/Brightness, Colour balance, Curves, Gaussian blur, Sharpen, Noise, Gradient map, Liquify.
// A session keeps the original pixels; every parameter change re-renders filter(original) into the layer, so
// previews never accumulate error. Apply records one undo step; Cancel restores the original exactly.
import type { Engine, Layer } from './engine';
import { Program, Target, makeTarget, freeTarget, bindTarget, makeTexture, Readback } from './gl';

export type AdjKind = 'hsb' | 'balance' | 'curves' | 'blur' | 'sharpen' | 'noise' | 'gradmap' | 'liquify';
export const ADJ_LABEL: Record<AdjKind, string> = {
  hsb: 'Hue, Saturation, Brightness', balance: 'Colour balance', curves: 'Curves', blur: 'Gaussian blur',
  sharpen: 'Sharpen', noise: 'Noise', gradmap: 'Gradient map', liquify: 'Liquify',
};

const HEAD = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc, uSel; uniform int uUseSel; uniform vec2 uTexel;
vec3 unp(vec4 c){ return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
vec4 finish(vec4 src, vec4 f){ float k = uUseSel == 1 ? texture(uSel, vUv).r : 1.0; return mix(src, f, k); }
`;
const FS: Record<string, string> = {
  hsb: HEAD + `uniform float uHue, uSat, uBri;
vec3 rgb2hsv(vec3 c){ vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0); vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r)); float d = q.x - min(q.w, q.y); float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x); }
vec3 hsv2rgb(vec3 c){ vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0); return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y); }
void main(){ vec4 s = texture(uSrc, vUv); vec3 h = rgb2hsv(unp(s));
  h.x = fract(h.x + uHue);
  vec3 c = hsv2rgb(h);
  // saturation pivots on perceived brightness (luma), so desaturating keeps the tone instead of jumping to the max channel
  float l = lum(c); c = l + (c - l) * uSat;
  float mn = min(min(c.r, c.g), c.b), mx = max(max(c.r, c.g), c.b);
  if (mn < 0.0) c = l + (c - l) * l / max(l - mn, 1e-5);
  if (mx > 1.0) c = l + (c - l) * (1.0 - l) / max(mx - l, 1e-5);
  c = uBri >= 0.0 ? c + (1.0 - c) * uBri : c * (1.0 + uBri);
  o = finish(s, vec4(clamp(c, 0.0, 1.0) * s.a, s.a)); }`,
  balance: HEAD + `uniform vec3 uSh, uMid, uHi; uniform int uKeepLum;
void main(){ vec4 s = texture(uSrc, vUv); vec3 c = unp(s); float l = lum(c);
  float sh = 1.0 - smoothstep(0.0, 0.5, l), hi = smoothstep(0.5, 1.0, l), mid = clamp(1.0 - sh - hi, 0.0, 1.0);
  vec3 d = (uSh * sh + uMid * mid + uHi * hi) * 0.5;
  vec3 r = clamp(c + d, 0.0, 1.0);
  if (uKeepLum == 1) r = clamp(r + (l - lum(r)), 0.0, 1.0);
  o = finish(s, vec4(r * s.a, s.a)); }`,
  lut: HEAD + `uniform sampler2D uLut; uniform int uMode; uniform float uAmount; // 0 per-channel curves, 1 gradient map
vec4 L(float x){ return texture(uLut, vec2((x * 255.0 + 0.5) / 256.0, 0.5)); }
void main(){ vec4 s = texture(uSrc, vUv); vec3 c = unp(s); vec3 r;
  if (uMode == 0) r = vec3(L(c.r).r, L(c.g).g, L(c.b).b);
  else r = mix(c, L(lum(c)).rgb, uAmount);
  o = finish(s, vec4(r * s.a, s.a)); }`,
  blur: HEAD + `uniform vec2 uDir; uniform float uSigma; uniform int uFinal; uniform sampler2D uOrig;
void main(){
  vec4 acc = vec4(0.0); float wsum = 0.0;
  float rad = ceil(uSigma * 3.0); float st = max(1.0, rad / 48.0);
  for (float i = -144.0; i <= 144.0; i += 1.0) {
    float x = i * st; if (abs(x) > rad) continue;
    float w = exp(-0.5 * x * x / (uSigma * uSigma));
    acc += texture(uSrc, vUv + uDir * uTexel * x) * w; wsum += w;
  }
  vec4 b = acc / wsum;
  if (uFinal == 1) o = finish(texture(uOrig, vUv), b); else o = b; }`,
  sharpen: HEAD + `uniform sampler2D uBlur; uniform float uAmount;
void main(){ vec4 s = texture(uSrc, vUv), b = texture(uBlur, vUv);
  vec3 c = clamp(s.rgb + (s.rgb - b.rgb) * uAmount, 0.0, s.a);
  o = finish(s, vec4(c, s.a)); }`,
  noise: HEAD + `uniform float uAmount, uSeed, uScale; uniform int uMono;
float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423) + uSeed); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
void main(){ vec4 s = texture(uSrc, vUv); vec3 c = unp(s);
  vec2 cell = floor(gl_FragCoord.xy / uScale);
  vec3 n = uMono == 1 ? vec3(hash(cell)) : vec3(hash(cell), hash(cell + 17.3), hash(cell + 41.7));
  vec3 r = clamp(c + (n - 0.5) * uAmount, 0.0, 1.0);
  o = finish(s, vec4(r * s.a, s.a)); }`,
  // liquify displacement field: two signed 16-bit fixed-point numbers per texel (x in rg, y in ba), ±1024 px
  liqDab: `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uD; uniform vec2 uSize; uniform vec2 uC; uniform float uR, uK; uniform vec2 uV; uniform int uMode;
vec2 dec(vec4 t){ vec4 b = floor(t * 255.0 + 0.5); return vec2((b.r * 256.0 + b.g) / 65535.0, (b.b * 256.0 + b.a) / 65535.0) * 2048.0 - 1024.0; }
vec4 enc(vec2 d){ vec2 u = clamp(floor((d + 1024.0) / 2048.0 * 65535.0 + 0.5), 0.0, 65535.0); vec2 hi = floor(u / 256.0), lo = u - hi * 256.0; return vec4(hi.x, lo.x, hi.y, lo.y) / 255.0; }
vec2 D(vec2 p){ // bilinear in doc px
  vec2 q = p - 0.5; vec2 f = fract(q); ivec2 i = ivec2(floor(q)); ivec2 m = ivec2(uSize) - 1;
  vec2 a = dec(texelFetch(uD, clamp(i, ivec2(0), m), 0)), b = dec(texelFetch(uD, clamp(i + ivec2(1, 0), ivec2(0), m), 0));
  vec2 c = dec(texelFetch(uD, clamp(i + ivec2(0, 1), ivec2(0), m), 0)), d = dec(texelFetch(uD, clamp(i + ivec2(1, 1), ivec2(0), m), 0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
void main(){
  vec2 p = vUv * uSize; vec2 rel = p - uC; float dist = length(rel);
  vec2 cur = dec(texelFetch(uD, ivec2(p), 0));
  if (dist >= uR) { o = enc(cur); return; }
  float t = dist / uR; float f = (1.0 - t * t); f = f * f * uK;   // smooth falloff
  vec2 nd;
  if (uMode == 0) nd = D(p - uV * f) - uV * f;                     // push: content follows the drag
  else if (uMode == 1 || uMode == 2) { float a = (uMode == 1 ? 1.0 : -1.0) * 0.35 * f; vec2 r2 = vec2(rel.x * cos(a) - rel.y * sin(a), rel.x * sin(a) + rel.y * cos(a)); vec2 v = r2 - rel; nd = D(p + v) + v; } // twirl cw/ccw
  else if (uMode == 3) { vec2 v = rel * 0.12 * f; nd = D(p + v) + v; }       // pinch: sample from further out
  else if (uMode == 4) { vec2 v = -rel * 0.12 * f; nd = D(p + v) + v; }      // expand
  else nd = cur * (1.0 - 0.25 * f);                                           // reconstruct
  o = enc(nd); }`,
  liqApply: HEAD + `uniform sampler2D uD; uniform vec2 uSize;
vec2 dec(vec4 t){ vec4 b = floor(t * 255.0 + 0.5); return vec2((b.r * 256.0 + b.g) / 65535.0, (b.b * 256.0 + b.a) / 65535.0) * 2048.0 - 1024.0; }
void main(){ vec2 p = vUv * uSize; vec2 q = p - 0.5; vec2 f = fract(q); ivec2 i = ivec2(floor(q)); ivec2 m = ivec2(uSize) - 1;
  vec2 a = dec(texelFetch(uD, clamp(i, ivec2(0), m), 0)), b = dec(texelFetch(uD, clamp(i + ivec2(1, 0), ivec2(0), m), 0));
  vec2 c = dec(texelFetch(uD, clamp(i + ivec2(0, 1), ivec2(0), m), 0)), d = dec(texelFetch(uD, clamp(i + ivec2(1, 1), ivec2(0), m), 0));
  vec2 disp = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  vec4 s = texture(uSrc, vUv);
  o = finish(s, texture(uSrc, (p + disp) / uSize)); }`,
};

export const GRADIENTS: { name: string; stops: [number, string][] }[] = [
  { name: 'Noir', stops: [[0, '#000000'], [1, '#ffffff']] },
  { name: 'Sepia', stops: [[0, '#1c1008'], [0.55, '#a0703c'], [1, '#fff3d6']] },
  { name: 'Dusk', stops: [[0, '#14082b'], [0.45, '#b0306a'], [0.8, '#ff9a3c'], [1, '#fff1c2']] },
  { name: 'Ocean', stops: [[0, '#02121f'], [0.5, '#0f6b8c'], [1, '#d9fbff']] },
  { name: 'Duotone', stops: [[0, '#2b1a6b'], [1, '#ffd23f']] },
  { name: 'Thermal', stops: [[0, '#000000'], [0.3, '#5a00a8'], [0.55, '#e0123a'], [0.8, '#ffb000'], [1, '#ffffff']] },
];

/** a curve through points (x, y in 0..1, sorted by x): monotone cubic (Fritsch–Carlson), sampled to 256 values */
export function curveLut(pts: [number, number][]): Float32Array {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(256);
  const n = p.length;
  if (n < 2) { for (let i = 0; i < 256; i++) out[i] = i / 255; return out; }
  const dx: number[] = [], m: number[] = [], t: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { dx.push(Math.max(1e-6, p[i + 1][0] - p[i][0])); m.push((p[i + 1][1] - p[i][1]) / dx[i]); }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    if (x <= p[0][0]) { out[k] = p[0][1]; continue; }
    if (x >= p[n - 1][0]) { out[k] = p[n - 1][1]; continue; }
    let i = 0; while (x > p[i + 1][0]) i++;
    const hh = dx[i], s = (x - p[i][0]) / hh, s2 = s * s, s3 = s2 * s;
    out[k] = Math.max(0, Math.min(1, (2 * s3 - 3 * s2 + 1) * p[i][1] + (s3 - 2 * s2 + s) * hh * t[i] + (-2 * s3 + 3 * s2) * p[i + 1][1] + (s3 - s2) * hh * t[i + 1]));
  }
  return out;
}
const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

export interface AdjParams { [k: string]: number | number[] | [number, number][][] | string | boolean }

export class AdjustSession {
  readonly layer: Layer;
  private orig: Target;
  private tmp: Target | null = null; private tmp2: Target | null = null;
  private lut: WebGLTexture | null = null;
  private progs = new Map<string, Program>();
  private d: Target[] | null = null;   // liquify displacement ping-pong
  params: AdjParams;
  done = false;

  constructor(private e: Engine, readonly kind: AdjKind, params: AdjParams) {
    this.layer = e.activeLayer;
    e.keepResident.add(this.layer);
    this.orig = e.copyOfLayer(this.layer);
    this.params = { ...params };
    if (kind === 'liquify') this.resetLiquify();
  }
  /**
   * Histogram of the original pixels (inside the selection when there is one): 4×256 bins (luma, R, G, B),
   * straight (un-premultiplied) colour weighted by alpha × selection. Point-sampled down to ≤ 512² on the GPU
   * so the value distribution is preserved, then read back asynchronously (never stalls the frame).
   */
  async histogram(): Promise<Float32Array[]> {
    const e = this.e, gl = e.gl;
    const k = Math.max(1, Math.max(e.w, e.h) / 512), w = Math.max(1, Math.round(e.w / k)), h = Math.max(1, Math.round(e.h / k));
    const small = makeTarget(gl, w, h, { filter: gl.NEAREST }), ms = e.sel ? makeTarget(gl, w, h, { filter: gl.NEAREST }) : null;
    const blit = (src: Target, dst: Target) => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
      gl.disable(gl.SCISSOR_TEST);
      gl.blitFramebuffer(0, 0, e.w, e.h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    };
    blit(this.orig, small); if (ms && e.sel) blit(e.sel, ms);
    const [px, mk] = await Promise.all([new Readback(gl, small.fb, 0, 0, w, h).wait(), ms ? new Readback(gl, ms.fb, 0, 0, w, h).wait() : Promise.resolve(null)]);
    freeTarget(gl, small); if (ms) freeTarget(gl, ms);
    const H = [0, 1, 2, 3].map(() => new Float32Array(256));
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3]; if (a < 4) continue;
      const wt = (a / 255) * (mk ? mk[i] / 255 : 1); if (wt <= 0) continue;
      const r = Math.min(255, Math.round(px[i] * 255 / a)), g = Math.min(255, Math.round(px[i + 1] * 255 / a)), b = Math.min(255, Math.round(px[i + 2] * 255 / a));
      H[0][Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)] += wt; H[1][r] += wt; H[2][g] += wt; H[3][b] += wt;
    }
    return H;
  }
  private prog(k: string) { let p = this.progs.get(k); if (!p) { p = this.e.program(FS[k]); this.progs.set(k, p); } return p; }
  private scratch(): [Target, Target] {
    const { w, h } = this.e;
    if (!this.tmp) this.tmp = makeTarget(this.e.gl, w, h);
    if (!this.tmp2) this.tmp2 = makeTarget(this.e.gl, w, h);
    return [this.tmp, this.tmp2];
  }
  private common(p: Program, src: WebGLTexture) {
    const e = this.e;
    p.use().tex('uSrc', 0, src).tex('uSel', 1, e.sel ? e.sel.tex : null).i('uUseSel', e.sel ? 1 : 0).f('uTexel', 1 / e.w, 1 / e.h);
    return p;
  }
  private uploadLut(rgba: Uint8Array) {
    const gl = this.e.gl;
    if (!this.lut) this.lut = makeTexture(gl, 256, 1, { filter: gl.LINEAR });
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }
  private blurInto(dst: Target, src: WebGLTexture, sigma: number, finalOrig: WebGLTexture | null) {
    const gl = this.e.gl, [a] = this.scratch();
    const p = this.prog('blur');
    bindTarget(gl, a); this.common(p, src).f('uDir', 1, 0).f('uSigma', sigma).i('uFinal', 0); this.e.quad();
    bindTarget(gl, dst); this.common(p, a.tex).f('uDir', 0, 1).f('uSigma', sigma).i('uFinal', finalOrig ? 1 : 0).tex('uOrig', 2, finalOrig); this.e.quad();
  }

  /** re-render the preview from the original pixels */
  preview(params: AdjParams = this.params) {
    this.params = { ...this.params, ...params };
    const e = this.e, gl = e.gl, P = this.params, dst = this.layer.target;
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    const o = this.orig.tex;
    switch (this.kind) {
      case 'hsb': bindTarget(gl, dst); this.common(this.prog('hsb'), o).f('uHue', +P.hue / 360).f('uSat', 1 + +P.sat / 100).f('uBri', +P.bri / 100); e.quad(); break;
      case 'balance': {
        const v = (k: string) => (P[k] as number[]).map((x) => x / 100) as [number, number, number];
        bindTarget(gl, dst); this.common(this.prog('balance'), o).f('uSh', ...v('shadows')).f('uMid', ...v('mid')).f('uHi', ...v('hi')).i('uKeepLum', P.keepLum ? 1 : 0); e.quad(); break;
      }
      case 'curves': {
        const ch = P.curves as [number, number][][]; // master, r, g, b
        const M = curveLut(ch[0]), R = curveLut(ch[1]), G = curveLut(ch[2]), B = curveLut(ch[3]);
        const lut = new Uint8Array(256 * 4);
        const at = (c: Float32Array, x: number) => c[Math.round(Math.max(0, Math.min(1, x)) * 255)];
        for (let i = 0; i < 256; i++) { const m = M[i]; lut[i * 4] = Math.round(at(R, m) * 255); lut[i * 4 + 1] = Math.round(at(G, m) * 255); lut[i * 4 + 2] = Math.round(at(B, m) * 255); lut[i * 4 + 3] = 255; }
        this.uploadLut(lut);
        bindTarget(gl, dst); this.common(this.prog('lut'), o).tex('uLut', 2, this.lut).i('uMode', 0).f('uAmount', 1); e.quad(); break;
      }
      case 'gradmap': {
        const g = GRADIENTS[+P.gradient] ?? GRADIENTS[0];
        const lut = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
          const x = i / 255; let k = 0; while (k < g.stops.length - 2 && x > g.stops[k + 1][0]) k++;
          const [x0, c0] = g.stops[k], [x1, c1] = g.stops[Math.min(k + 1, g.stops.length - 1)];
          const t = x1 > x0 ? Math.max(0, Math.min(1, (x - x0) / (x1 - x0))) : 0;
          const a = hex(c0), b = hex(c1);
          for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(a[c] + (b[c] - a[c]) * t);
          lut[i * 4 + 3] = 255;
        }
        this.uploadLut(lut);
        bindTarget(gl, dst); this.common(this.prog('lut'), o).tex('uLut', 2, this.lut).i('uMode', 1).f('uAmount', +P.amount / 100); e.quad(); break;
      }
      case 'blur': {
        const r = +P.radius;
        if (r <= 0.05) { this.copy(o, dst); break; }
        this.blurInto(dst, o, Math.max(0.3, r / 2), o); break;
      }
      case 'sharpen': {
        const [, b] = this.scratch();
        this.blurInto(b, o, Math.max(0.5, +P.radius / 2), null);
        bindTarget(gl, dst); this.common(this.prog('sharpen'), o).tex('uBlur', 2, b.tex).f('uAmount', +P.amount / 100 * 2); e.quad(); break;
      }
      case 'noise':
        bindTarget(gl, dst); this.common(this.prog('noise'), o).f('uAmount', +P.amount / 100).f('uSeed', +P.seed).f('uScale', Math.max(1, +P.scale)).i('uMono', P.mono ? 1 : 0); e.quad(); break;
      case 'liquify':
        bindTarget(gl, dst); this.common(this.prog('liqApply'), o).tex('uD', 2, this.d![0].tex).f('uSize', e.w, e.h); e.quad(); break;
    }
    e.layerChanged(this.layer);
  }
  private copy(src: WebGLTexture, dst: Target) {
    const gl = this.e.gl;
    void src;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.orig.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
    gl.blitFramebuffer(0, 0, this.e.w, this.e.h, 0, 0, this.e.w, this.e.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  // ------------------------------------------------------------------ liquify
  resetLiquify() {
    const gl = this.e.gl, { w, h } = this.e;
    if (!this.d) this.d = [makeTarget(gl, w, h, { filter: gl.NEAREST }), makeTarget(gl, w, h, { filter: gl.NEAREST })];
    // zero displacement = 32768 in both lanes = bytes (128, 0, 128, 0)
    for (const t of this.d) { bindTarget(gl, t); gl.disable(gl.SCISSOR_TEST); gl.clearColor(128 / 255, 0, 128 / 255, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    if (this.kind === 'liquify') this.preview();
  }
  /**
   * one liquify dab at doc (x, y), radius r, drag vector (vx, vy) since the last dab, strength 0..1.
   * mode: push, twirl (clockwise), twirlCcw, pinch, expand, reconstruct.
   */
  liquifyDab(x: number, y: number, r: number, vx: number, vy: number, strength: number, mode: string) {
    const e = this.e, gl = e.gl, d = this.d!;
    const m = ['push', 'twirl', 'twirlCcw', 'pinch', 'expand', 'reconstruct'].indexOf(mode);
    const R = Math.ceil(r + 2);
    // only the dab's square changes: copy the rest by keeping both buffers in sync over that square
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.floor(x - R), Math.floor(y - R), R * 2, R * 2);
    bindTarget(gl, d[1]);
    this.prog('liqDab').use().tex('uD', 0, d[0].tex).f('uSize', e.w, e.h).f('uC', x, y).f('uR', r).f('uK', Math.max(0, Math.min(1, strength))).f('uV', vx, vy).i('uMode', Math.max(0, m));
    e.quad();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, d[1].fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, d[0].fb);
    gl.blitFramebuffer(0, 0, e.w, e.h, 0, 0, e.w, e.h, gl.COLOR_BUFFER_BIT, gl.NEAREST); // scissored: just the square
    // re-render the layer only in the square
    bindTarget(gl, this.layer.target);
    this.common(this.prog('liqApply'), this.orig.tex).tex('uD', 2, d[0].tex).f('uSize', e.w, e.h); e.quad();
    gl.disable(gl.SCISSOR_TEST);
    this.layer.version++;
    e.markDirty({ x: x - R, y: y - R, w: R * 2, h: R * 2 });
  }

  commit(label = ADJ_LABEL[this.kind]) {
    if (this.done) return;
    this.done = true;
    this.e.recordReplace(this.layer, this.e.newStash(this.orig), label);   // the stash now owns the original
    this.free(false);
  }
  cancel() {
    if (this.done) return;
    this.done = true;
    this.copy(this.orig.tex, this.layer.target);
    this.e.layerChanged(this.layer);
    this.free(true);
  }
  private free(origToo: boolean) {
    const gl = this.e.gl;
    if (origToo) freeTarget(gl, this.orig);
    for (const t of [this.tmp, this.tmp2, ...(this.d ?? [])]) if (t) freeTarget(gl, t);
    this.tmp = this.tmp2 = null; this.d = null;
    if (this.lut) gl.deleteTexture(this.lut);
    this.lut = null;
    this.e.keepResident.delete(this.layer);
    this.e.onLayersChanged();
  }
}

export function defaultParams(kind: AdjKind): AdjParams {
  switch (kind) {
    case 'hsb': return { hue: 0, sat: 0, bri: 0 };
    case 'balance': return { shadows: [0, 0, 0], mid: [0, 0, 0], hi: [0, 0, 0], keepLum: true, range: 'mid' };
    case 'curves': return { curves: [[[0, 0], [1, 1]], [[0, 0], [1, 1]], [[0, 0], [1, 1]], [[0, 0], [1, 1]]], channel: 0 };
    case 'blur': return { radius: 0 };
    case 'sharpen': return { amount: 0, radius: 2 };
    case 'noise': return { amount: 0, scale: 1, mono: true, seed: Math.random() };
    case 'gradmap': return { gradient: 1, amount: 100 };
    case 'liquify': return { mode: 'push', size: 80, strength: 60 };
  }
}

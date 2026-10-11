import { GL, Program, Target, makeTarget, freeTarget, bindTarget, textureFromCanvas, makeTexture, Readback } from './gl';
import * as S from './shaders';
import { Brush, ShapeId, GrainId, makeShape, makeGrain } from './brushes';
import { History, Entry } from './history';

export const BLEND_MODES = ['Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten', 'Colour Dodge', 'Colour Burn',
  'Hard Light', 'Soft Light', 'Difference', 'Exclusion', 'Add', 'Linear Burn', 'Hue', 'Saturation', 'Colour', 'Luminosity'];

export interface Rect { x: number; y: number; w: number; h: number; }
export interface Dab { x: number; y: number; r: number; a: number; angle: number; aspect: number; }

let layerSeq = 1;
const newUid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export interface LayerProps { uid: string; name: string; visible: boolean; opacity: number; blend: number; alphaLock: boolean; clip: boolean; }
export class Layer {
  id = layerSeq++;
  /** stable identity across sessions (storage key) */
  uid = newUid();
  visible = true;
  opacity = 1;
  blend = 0;
  alphaLock = false;
  clip = false;
  version = 0;
  constructor(public name: string, public target: Target) {}
  props(): LayerProps { return { uid: this.uid, name: this.name, visible: this.visible, opacity: this.opacity, blend: this.blend, alphaLock: this.alphaLock, clip: this.clip }; }
}

export type Tool = 'brush' | 'eraser' | 'smudge';

interface StrokeState {
  layer: Layer;
  tool: Tool;
  brush: Brush;
  color: [number, number, number];
  bbox: Rect | null;
  dabs: Dab[];
  smudgeInit: boolean;
}

const unionRect = (a: Rect | null, b: Rect): Rect => {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/**
 * Pixels kept for undo. Starts life as a GPU texture (instant to take and restore, no pipeline stall) and is
 * migrated to CPU memory in the background by an async PBO readback once the GPU budget is exceeded.
 */
export class Stash {
  t: Target | null;
  data: Uint8Array | null = null;
  private rb: Readback | null = null;
  readonly w: number; readonly h: number;
  constructor(private gl: GL, t: Target, private registry: Set<Stash>) {
    this.t = t; this.w = t.w; this.h = t.h;
    registry.add(this);
  }
  get bytes() { return this.w * this.h * 4; }
  get onGpu() { return !!this.t; }
  migrate() { if (this.t && !this.rb) this.rb = new Readback(this.gl, this.t.fb, 0, 0, this.w, this.h); }
  get migrating() { return !!this.rb; }
  poll() {
    if (this.rb && this.rb.poll()) { this.data = this.rb.data; this.rb = null; if (this.t) freeTarget(this.gl, this.t); this.t = null; }
  }
  /** copy the stashed pixels into dst at (x, y) */
  writeTo(dst: Target, x: number, y: number) {
    const gl = this.gl;
    if (this.t) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.t.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
      gl.blitFramebuffer(0, 0, this.w, this.h, x, y, x + this.w, y + this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    } else if (this.data) {
      gl.bindTexture(gl.TEXTURE_2D, dst.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this.data);
    }
  }
  /** turn the stash into a standalone full texture (consumes the stash) */
  take(): Target {
    let t = this.t;
    if (t) { this.t = null; }
    else { t = makeTarget(this.gl, this.w, this.h); this.writeTo(t, 0, 0); }
    this.dispose();
    return t;
  }
  dispose() {
    this.rb?.dispose(); this.rb = null;
    if (this.t) freeTarget(this.gl, this.t);
    this.t = null; this.data = null;
    this.registry.delete(this);
  }
}

export interface EngineStats { dabs: number; compositePx: number; presents: number; presentPx: number; }

export class Engine {
  gl: GL;
  w = 0; h = 0;
  layers: Layer[] = [];
  active = 0;
  bg: [number, number, number] = [1, 1, 1];
  bgVisible = true;
  history = new History();

  private quadVao!: WebGLVertexArrayObject;
  private dabVao!: WebGLVertexArrayObject;
  private dabBuf!: WebGLBuffer;
  private dabData = new Float32Array(6 * 4096);
  private pComposite!: Program; private pBake!: Program; private pMerge!: Program; private pDab!: Program;
  private pSmudge!: Program; private pPickup!: Program; private pScreen!: Program; private pDown!: Program; private pPremul!: Program; private pFill!: Program;
  private shapes = new Map<ShapeId, WebGLTexture>();
  private grains = new Map<GrainId, WebGLTexture>();
  private stroke!: Target;   // coverage buffer
  private comp!: Target;     // full composite
  private s1!: Target; private s2!: Target;
  private snapshot: Target | null = null;
  private pick: Target[] = [];
  private thumbT: Target | null = null;
  private strokeFloat = false;
  private cur: StrokeState | null = null;
  private dirty: Rect | null = null;
  needsPresent = true;
  maxTex: number;
  /** undo pixel stashes; GPU-resident ones beyond this budget migrate to CPU memory */
  readonly stashes = new Set<Stash>();
  gpuStashBudget = 160 * 1024 * 1024;
  stats: EngineStats = { dabs: 0, compositePx: 0, presents: 0, presentPx: 0 };
  private mipStale = true;
  onLayersChanged: () => void = () => {};

  // view: doc px -> screen css px
  view = { x: 0, y: 0, scale: 1, rot: 0 };

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false, desynchronized: true, powerPreference: 'high-performance' } as WebGLContextAttributes);
    if (!gl) throw new Error('WebGL2 is not available on this device/browser.');
    this.gl = gl;
    this.strokeFloat = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    this.initGL();
  }

  private initGL() {
    const gl = this.gl;
    this.pComposite = new Program(gl, S.QUAD_VS, S.COMPOSITE_FS);
    this.pBake = new Program(gl, S.QUAD_VS, S.BAKE_FS);
    this.pMerge = new Program(gl, S.QUAD_VS, S.MERGE_FS);
    this.pDab = new Program(gl, S.DAB_VS, S.DAB_FS);
    this.pSmudge = new Program(gl, S.QUAD_VS, S.SMUDGE_FS);
    this.pPickup = new Program(gl, S.QUAD_VS, S.PICKUP_FS);
    this.pScreen = new Program(gl, S.SCREEN_VS, S.SCREEN_FS);
    this.pDown = new Program(gl, S.QUAD_VS, S.DOWNSAMPLE_FS);
    this.pPremul = new Program(gl, S.QUAD_VS, S.PREMUL_FS);
    this.pFill = new Program(gl, S.QUAD_VS, S.FILL_FS);

    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    // all quad programs bind aPos at location 0
    for (const p of [this.pComposite, this.pBake, this.pMerge, this.pSmudge, this.pPickup, this.pScreen, this.pDown, this.pPremul, this.pFill]) {
      gl.bindAttribLocation(p.prog, 0, 'aPos'); gl.linkProgram(p.prog);
    }
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindAttribLocation(this.pDab.prog, 0, 'aCorner');
    gl.bindAttribLocation(this.pDab.prog, 1, 'aDab');
    gl.bindAttribLocation(this.pDab.prog, 2, 'aDab2');
    gl.linkProgram(this.pDab.prog);
    this.dabVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.dabVao);
    const cb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.dabBuf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.dabData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 24, 16); gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    for (let i = 0; i < 2; i++) this.pick.push(makeTarget(gl, 128, 128));
  }

  shapeTex(id: ShapeId) {
    let t = this.shapes.get(id);
    if (!t) { t = textureFromCanvas(this.gl, makeShape(id)); this.shapes.set(id, t); }
    return t;
  }
  grainTex(id: GrainId) {
    let t = this.grains.get(id);
    if (!t) { t = textureFromCanvas(this.gl, makeGrain(id), true); this.grains.set(id, t); }
    return t;
  }

  /** rough maximum number of layers given a GPU memory budget */
  maxLayersFor(w: number, h: number) {
    const budget = 560 * 1024 * 1024;
    const fixed = w * h * (4 * 3 + (this.strokeFloat ? 2 : 4));
    return Math.max(4, Math.min(64, Math.floor((budget - fixed) / (w * h * 4))));
  }

  newDocument(w: number, h: number, bg: [number, number, number] = [1, 1, 1]) {
    const gl = this.gl;
    for (const l of this.layers) freeTarget(gl, l.target);
    this.history.clear();
    for (const t of [this.stroke, this.comp, this.s1, this.s2, this.snapshot]) if (t) freeTarget(gl, t);
    this.snapshot = null;
    this.w = w; this.h = h; this.bg = bg; this.bgVisible = true;
    this.stroke = this.strokeFloat
      ? makeTarget(gl, w, h, { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT })
      : makeTarget(gl, w, h);
    this.comp = makeTarget(gl, w, h);
    this.s1 = makeTarget(gl, w, h); this.s2 = makeTarget(gl, w, h);
    this.layers = [new Layer('Layer 1', makeTarget(gl, w, h))];
    this.active = 0;
    this.warmup();
    this.markDirty();
    this.onLayersChanged();
  }

  /** run every stroke-path shader once on an invisible dab so the first real stroke does not hitch on compilation */
  private warmup() {
    const b = { id: 'warm', name: '', group: '', shape: 'hard', grain: 'paper', mode: 'paint', size: 2, minSize: 1, opacity: 1, flow: 0, spacing: 1,
      sizeJitter: 0, opacityJitter: 0, scatter: 0, rotJitter: 0, followDir: false, roundness: 1, angle: 0, taperStart: 0, taperEnd: 0,
      pressSize: 0, pressOpacity: 0, tiltSize: 0, grainScale: 1, grainDepth: 0.5, wetEdges: 0.5, smoothing: 0, smudge: 0 } as Brush;
    this.beginStroke('brush', b, [0, 0, 0]);
    this.addDabs([{ x: 1, y: 1, r: 1, a: 0, angle: 0, aspect: 1 }]);
    this.composite({ x: 0, y: 0, w: 4, h: 4 });
    this.endStroke();
    this.history.clear();
  }

  get activeLayer() { return this.layers[this.active]; }

  markDirty(r?: Rect) {
    const full = { x: 0, y: 0, w: this.w, h: this.h };
    this.dirty = r ? unionRect(this.dirty, r) : full;
    this.needsPresent = true;
  }

  // ---------------------------------------------------------------- compositing
  private drawQuad() {
    const gl = this.gl;
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private setStrokeUniforms(p: Program, layer: Layer | null) {
    const c = this.cur;
    const live = !!(c && layer && c.layer === layer && c.tool !== 'smudge');
    p.tex('uStroke', 3, this.stroke.tex);
    p.i('uStrokeMode', live ? (c!.tool === 'eraser' ? 2 : 1) : 0);
    if (live) {
      const b = c!.brush;
      p.f('uColor', ...c!.color).f('uStrokeOpacity', b.opacity)
        .f('uWet', c!.tool === 'eraser' ? 0 : b.wetEdges).f('uWetR', Math.max(2, b.size * 0.15))
        .i('uAlphaLock', layer!.alphaLock ? 1 : 0);
    } else p.f('uWet', 0).i('uAlphaLock', 0).f('uStrokeOpacity', 0).f('uColor', 0, 0, 0).f('uWetR', 1);
    p.f('uTexel', 1 / this.w, 1 / this.h);
  }

  private clampRect(r: Rect): Rect | null {
    const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
    const x2 = Math.min(this.w, Math.ceil(r.x + r.w)), y2 = Math.min(this.h, Math.ceil(r.y + r.h));
    if (x2 <= x || y2 <= y) return null;
    return { x, y, w: x2 - x, h: y2 - y };
  }

  /** composite all layers into this.comp within rect */
  private composite(rect: Rect, withBg = this.bgVisible) {
    const gl = this.gl;
    const r = this.clampRect(rect);
    if (!r) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r.x, r.y, r.w, r.h);
    gl.disable(gl.BLEND);
    let src = this.s1, dst = this.s2;
    bindTarget(gl, src);
    if (withBg) gl.clearColor(this.bg[0], this.bg[1], this.bg[2], 1); else gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const p = this.pComposite.use();
    this.setStrokeUniforms(p, null);
    let clipBase: Layer | null = null;
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      if (!l.clip) clipBase = l;
      const clipped = l.clip && clipBase && clipBase !== l;
      if (!l.visible || l.opacity <= 0) continue;
      if (clipped && !clipBase!.visible) continue;
      bindTarget(gl, dst);
      this.setStrokeUniforms(p, l);
      p.i('uActive', this.cur && this.cur.layer === l ? 1 : 0);
      p.tex('uPrev', 0, src.tex).tex('uLayer', 1, l.target.tex);
      p.i('uMode', l.blend).f('uOpacity', l.opacity);
      if (clipped) {
        p.tex('uClip', 2, clipBase!.target.tex);
        p.i('uClipMode', this.cur && this.cur.layer === clipBase && this.cur.tool !== 'smudge' ? 2 : 1);
        if (this.cur && this.cur.layer === clipBase && this.cur.layer !== l) {
          // the shared stroke uniforms belong to the base when the base is being painted
          this.setStrokeUniforms(p, clipBase);
          p.i('uActive', 0);
        }
      } else { p.i('uClipMode', 0); p.tex('uClip', 2, null); }
      this.drawQuad();
      const t = src; src = dst; dst = t;
    }
    this.stats.compositePx += r.w * r.h * Math.max(1, this.layers.length);
    this.mipStale = true;
    // copy result into comp
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.comp.fb);
    gl.blitFramebuffer(r.x, r.y, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y + r.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.disable(gl.SCISSOR_TEST);
  }

  viewMatrix(cw: number, ch: number): Float32Array {
    // doc -> css px: rotate+scale then translate; css -> clip
    const { x, y, scale, rot } = this.view;
    const c = Math.cos(rot) * scale, s = Math.sin(rot) * scale;
    // clip = [2/cw, 0, -1; 0, -2/ch, 1] * [c -s x; s c y]
    const a = 2 / cw, b = -2 / ch;
    return new Float32Array([a * c, b * s, 0, a * -s, b * c, 0, a * x - 1, b * y + 1, 1]);
  }
  docToScreen(dx: number, dy: number) {
    const { x, y, scale, rot } = this.view;
    const c = Math.cos(rot) * scale, s = Math.sin(rot) * scale;
    return { x: c * dx - s * dy + x, y: s * dx + c * dy + y };
  }
  screenToDoc(sx: number, sy: number) {
    const { x, y, scale, rot } = this.view;
    const px = sx - x, py = sy - y;
    const c = Math.cos(-rot) / scale, s = Math.sin(-rot) / scale;
    return { x: c * px - s * py, y: s * px + c * py };
  }

  /** poll background readbacks; migrate the oldest GPU stashes when over budget */
  private maintainStashes() {
    let gpu = 0;
    for (const s of this.stashes) { s.poll(); if (s.onGpu && !s.migrating) gpu += s.bytes; }
    if (gpu <= this.gpuStashBudget) return;
    for (const s of this.stashes) {          // insertion order = oldest first
      if (gpu <= this.gpuStashBudget * 0.75) break;
      if (s.onGpu && !s.migrating) { s.migrate(); gpu -= s.bytes; }
    }
  }

  render() {
    const gl = this.gl;
    if (!this.comp) return; // no document yet (boot is still reading storage)
    if (!this.cur) this.maintainStashes();
    if (this.dirty) {
      this.composite(this.dirty);
      this.dirty = null;
      this.needsPresent = true;
    }
    if (!this.needsPresent) return;
    this.needsPresent = false;
    const cw = this.canvas.width, ch = this.canvas.height;
    bindTarget(gl, null, cw, ch);
    gl.disable(gl.BLEND);
    gl.clearColor(0.13, 0.12, 0.12, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const dpr = cw / this.canvas.clientWidth || 1;
    const p = this.pScreen.use();
    const m = this.viewMatrix(cw / dpr, ch / dpr);
    p.m3('uM', m).f('uDocSize', this.w, this.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.comp.tex);
    const zoomedOut = this.view.scale * dpr < 0.8;
    // regenerate mips only when the composite actually changed (not on pan/zoom-only frames)
    if (zoomedOut && this.mipStale) { gl.generateMipmap(gl.TEXTURE_2D); this.mipStale = false; }
    this.stats.presents++; this.stats.presentPx += cw * ch;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, zoomedOut ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.view.scale * dpr > 3 ? gl.NEAREST : gl.LINEAR);
    p.i('uComp', 0);
    this.drawQuad();
  }

  // ---------------------------------------------------------------- strokes
  beginStroke(tool: Tool, brush: Brush, color: [number, number, number]) {
    if (this.cur) this.cancelStroke();
    const layer = this.activeLayer;
    if (!layer) return false;
    this.cur = { layer, tool, brush, color, bbox: null, dabs: [], smudgeInit: false };
    const gl = this.gl;
    if (tool === 'smudge') {
      if (!this.snapshot) this.snapshot = makeTarget(gl, this.w, this.h);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.target.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.snapshot.fb);
      gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    } else {
      bindTarget(gl, this.stroke);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return true;
  }

  get stroking() { return !!this.cur; }

  private dabRect(d: Dab, pad = 2): Rect {
    const r = d.r * 1.42 + pad;
    return { x: d.x - r, y: d.y - r, w: r * 2, h: r * 2 };
  }

  addDabs(dabs: Dab[]) {
    const c = this.cur;
    if (!c || !dabs.length) return;
    c.dabs.push(...dabs);
    this.stats.dabs += dabs.length;
    let rect: Rect | null = null;
    for (const d of dabs) rect = unionRect(rect, this.dabRect(d));
    c.bbox = unionRect(c.bbox, rect!);
    if (c.tool === 'smudge') this.smudgeDabs(dabs);
    else this.drawDabs(dabs, c.brush);
    const wet = c.tool === 'eraser' ? 0 : c.brush.wetEdges > 0 ? Math.max(2, c.brush.size * 0.15) + 2 : 0;
    this.markDirty({ x: rect!.x - wet, y: rect!.y - wet, w: rect!.w + wet * 2, h: rect!.h + wet * 2 });
  }

  private drawDabs(dabs: Dab[], brush: Brush) {
    const gl = this.gl;
    bindTarget(gl, this.stroke);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const shape = this.shapeTex(brush.shape), grain = this.grainTex(brush.grain);
    const p = this.pDab.use();
    p.f('uDocSize', this.w, this.h).tex('uShape', 0, shape)
      .tex('uGrain', 1, grain).f('uGrainScale', brush.grainScale).f('uGrainDepth', brush.grain === 'none' ? 0 : brush.grainDepth);
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuf);
    const max = this.dabData.length / 6;
    for (let o = 0; o < dabs.length; o += max) {
      const n = Math.min(max, dabs.length - o);
      for (let i = 0; i < n; i++) {
        const d = dabs[o + i], k = i * 6;
        let r = d.r, a = d.a;
        if (r < 1) { a *= r; r = 1; }
        this.dabData[k] = d.x; this.dabData[k + 1] = d.y; this.dabData[k + 2] = r; this.dabData[k + 3] = a;
        this.dabData[k + 4] = d.angle; this.dabData[k + 5] = d.aspect;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dabData, 0, n * 6);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  private smudgeDabs(dabs: Dab[]) {
    const gl = this.gl, c = this.cur!, layer = c.layer;
    gl.disable(gl.BLEND);
    const shape = this.shapeTex(c.brush.shape);
    for (const d of dabs) {
      const R = Math.max(2, d.r);
      if (!c.smudgeInit) {
        bindTarget(gl, this.pick[0]);
        this.pPickup.use().tex('uPick', 0, this.pick[1].tex).tex('uLayer', 1, layer.target.tex)
          .f('uDocSize', this.w, this.h).f('uDabPos', d.x, d.y).f('uDabR', R).f('uRate', 1);
        this.drawQuad();
        c.smudgeInit = true;
        continue;
      }
      const rr = this.clampRect({ x: d.x - R - 1, y: d.y - R - 1, w: R * 2 + 2, h: R * 2 + 2 });
      if (!rr) continue;
      // apply carried paint into s1, then copy rect back to layer
      bindTarget(gl, this.s1);
      gl.enable(gl.SCISSOR_TEST); gl.scissor(rr.x, rr.y, rr.w, rr.h);
      this.pSmudge.use().tex('uLayer', 0, layer.target.tex).tex('uPick', 1, this.pick[0].tex).tex('uShape', 2, shape)
        .f('uDocSize', this.w, this.h).f('uDabPos', d.x, d.y).f('uDabR', R).f('uK', Math.min(1, d.a));
      this.drawQuad();
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.s1.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, layer.target.fb);
      gl.blitFramebuffer(rr.x, rr.y, rr.x + rr.w, rr.y + rr.h, rr.x, rr.y, rr.x + rr.w, rr.y + rr.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      // update pickup: keep most of what we carry, pick up a little of what's underneath
      bindTarget(gl, this.pick[1]);
      this.pPickup.use().tex('uPick', 0, this.pick[0].tex).tex('uLayer', 1, layer.target.tex)
        .f('uDocSize', this.w, this.h).f('uDabPos', d.x, d.y).f('uDabR', R).f('uRate', 1 - c.brush.smudge * 0.97);
      this.drawQuad();
      const t = this.pick[0]; this.pick[0] = this.pick[1]; this.pick[1] = t;
    }
  }

  /** Replace all dabs of the live stroke (used to apply end taper). */
  redrawStroke(dabs: Dab[]) {
    const c = this.cur;
    if (!c || c.tool === 'smudge') return;
    const gl = this.gl;
    bindTarget(gl, this.stroke);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    c.dabs = dabs;
    this.drawDabs(dabs, c.brush);
    if (c.bbox) this.markDirty(this.padRect(c.bbox));
  }

  private padRect(r: Rect) {
    const c = this.cur;
    const wet = c && c.tool !== 'eraser' && c.brush.wetEdges > 0 ? Math.max(2, c.brush.size * 0.15) + 2 : 0;
    return { x: r.x - wet, y: r.y - wet, w: r.w + wet * 2, h: r.h + wet * 2 };
  }

  cancelStroke() {
    const c = this.cur;
    if (!c) return;
    if (c.tool === 'smudge' && this.snapshot) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.snapshot.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, c.layer.target.fb);
      gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    const bb = c.bbox;
    this.cur = null;
    this.markDirty(bb ? this.padRectFor(c, bb) : undefined);
  }
  private padRectFor(c: StrokeState, r: Rect) {
    const wet = c.tool !== 'eraser' && c.brush.wetEdges > 0 ? Math.max(2, c.brush.size * 0.15) + 2 : 0;
    return { x: r.x - wet, y: r.y - wet, w: r.w + wet * 2, h: r.h + wet * 2 };
  }

  /** copy a rect of a target into a new GPU stash */
  stashRect(src: Target, r: Rect): Stash {
    const gl = this.gl, t = makeTarget(gl, r.w, r.h);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fb);
    gl.blitFramebuffer(r.x, r.y, r.x + r.w, r.y + r.h, 0, 0, r.w, r.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    return new Stash(gl, t, this.stashes);
  }

  /**
   * Undoable rect edit with swap semantics: the entry always holds the pixels of the state it is not in,
   * so one buffer per step serves both undo and redo (half the memory of before+after copies).
   */
  pushRectEdit(layer: Layer, rect: Rect, before: Stash, label: string) {
    let held = before;
    const swap = () => {
      const now = this.stashRect(layer.target, rect);
      held.writeTo(layer.target, rect.x, rect.y);
      held.dispose();
      held = now;
      layer.version++;
      this.markDirty(rect);
      this.onLayersChanged();
    };
    this.history.push({ label, bytes: rect.w * rect.h * 4, undo: swap, redo: swap, dispose: () => held.dispose() });
  }

  endStroke() {
    const c = this.cur;
    if (!c) return;
    if (!c.bbox) { this.cur = null; return; }
    const gl = this.gl;
    const rect = this.clampRect(this.padRectFor(c, c.bbox));
    if (!rect) { this.cancelStroke(); return; }
    const layer = c.layer;
    let before: Stash;
    if (c.tool === 'smudge') {
      before = this.stashRect(this.snapshot!, rect);
    } else {
      before = this.stashRect(layer.target, rect);
      // bake layer+stroke into s1 inside the stroke rect only, then copy that rect back into the layer
      bindTarget(gl, this.s1);
      gl.disable(gl.BLEND);
      gl.enable(gl.SCISSOR_TEST); gl.scissor(rect.x, rect.y, rect.w, rect.h);
      const p = this.pBake.use();
      this.setStrokeUniforms(p, layer);
      p.tex('uLayer', 0, layer.target.tex);
      this.drawQuad();
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.s1.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, layer.target.fb);
      gl.blitFramebuffer(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    this.cur = null;
    layer.version++;
    this.markDirty(rect);
    const label = c.tool === 'eraser' ? 'Erase' : c.tool === 'smudge' ? 'Smudge' : 'Stroke';
    this.pushRectEdit(layer, rect, before, label);
    this.onStrokeCommitted();
  }
  onStrokeCommitted: () => void = () => {};

  readRect(t: Target, r: Rect): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(r.w * r.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }
  writeRect(layer: Layer, r: Rect, data: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, layer.target.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    layer.version++;
    this.markDirty(r);
    this.onLayersChanged();
  }

  // ---------------------------------------------------------------- sampling / export
  /** sample the composite colour (straight RGB 0..1) at a doc position */
  sample(dx: number, dy: number): [number, number, number] | null {
    const x = Math.floor(dx), y = Math.floor(dy);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    this.render();
    const px = this.readRect(this.comp, { x, y, w: 1, h: 1 });
    const a = px[3] / 255;
    return [0, 1, 2].map((i) => Math.min(1, px[i] / 255 + (1 - a) * this.bg[i])) as [number, number, number];
  }

  /** full-resolution composite as straight-alpha RGBA rows (top row first) */
  compositePixels(withBg = this.bgVisible): Uint8ClampedArray {
    this.composite({ x: 0, y: 0, w: this.w, h: this.h }, withBg);
    const raw = this.readRect(this.comp, { x: 0, y: 0, w: this.w, h: this.h });
    this.markDirty();
    const out = new Uint8ClampedArray(raw.buffer);
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (a > 0 && a < 255) { const k = 255 / a; out[i] *= k; out[i + 1] *= k; out[i + 2] *= k; }
    }
    return out;
  }

  async exportPNG(withBg = this.bgVisible): Promise<Blob> {
    const px = this.compositePixels(withBg);
    const c = document.createElement('canvas');
    c.width = this.w; c.height = this.h;
    c.getContext('2d')!.putImageData(new ImageData(px as unknown as Uint8ClampedArray<ArrayBuffer>, this.w, this.h), 0, 0);
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
  }

  /** small preview of one layer, drawn into a 2D canvas */
  thumbnail(layer: Layer, out: HTMLCanvasElement) {
    const gl = this.gl;
    const tw = out.width, th = out.height;
    if (!this.thumbT || this.thumbT.w !== tw || this.thumbT.h !== th) {
      if (this.thumbT) freeTarget(gl, this.thumbT);
      this.thumbT = makeTarget(gl, tw, th);
    }
    // two-step downsample for quality
    const scale = Math.max(this.w / tw, this.h / th);
    bindTarget(gl, this.thumbT);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    this.pDown.use().tex('uSrc', 0, layer.target.tex).f('uStep', scale / this.w, scale / this.h);
    this.drawQuad();
    const px = this.readRect(this.thumbT, { x: 0, y: 0, w: tw, h: th });
    const img = new ImageData(tw, th);
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      const k = a ? 255 / a : 0;
      img.data[i] = px[i] * k; img.data[i + 1] = px[i + 1] * k; img.data[i + 2] = px[i + 2] * k; img.data[i + 3] = a;
    }
    out.getContext('2d')!.putImageData(img, 0, 0);
  }

  // ---------------------------------------------------------------- layer ops (all undoable)
  private newTarget() { return makeTarget(this.gl, this.w, this.h); }
  private copyTarget(src: Target): Target {
    const gl = this.gl, t = this.newTarget();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fb);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    return t;
  }
  private changed() { this.markDirty(); this.onLayersChanged(); }
  private bytesPerLayer() { return this.w * this.h * 4; }

  private insertLayer(layer: Layer, index: number, label: string) {
    const prevActive = this.active;
    const doIt = () => { this.layers.splice(index, 0, layer); this.active = index; this.changed(); };
    doIt();
    this.history.push({
      label, bytes: this.bytesPerLayer(),
      undo: () => { this.layers.splice(this.layers.indexOf(layer), 1); this.active = Math.min(prevActive, this.layers.length - 1); this.changed(); },
      redo: doIt,
      dispose: (done) => { if (!done) freeTarget(this.gl, layer.target); },
    });
  }

  addLayer(): Layer | null {
    if (this.layers.length >= this.maxLayersFor(this.w, this.h)) return null;
    const l = new Layer('Layer ' + (Math.max(0, ...this.layers.map((x) => +(x.name.match(/^Layer (\d+)$/)?.[1] ?? 0))) + 1), this.newTarget());
    this.insertLayer(l, this.active + 1, 'New layer');
    return l;
  }

  duplicateLayer(): Layer | null {
    if (this.layers.length >= this.maxLayersFor(this.w, this.h)) return null;
    const src = this.activeLayer;
    const l = new Layer(src.name + ' copy', this.copyTarget(src.target));
    Object.assign(l, { opacity: src.opacity, blend: src.blend, alphaLock: src.alphaLock, clip: src.clip, visible: src.visible });
    this.insertLayer(l, this.active + 1, 'Duplicate layer');
    return l;
  }

  deleteLayer() {
    if (this.layers.length <= 1) return false;
    const idx = this.active, layer = this.layers[idx];
    const doIt = () => { this.layers.splice(idx, 1); this.active = Math.max(0, idx - 1); this.changed(); };
    doIt();
    this.history.push({
      label: 'Delete layer', bytes: this.bytesPerLayer(),
      undo: () => { this.layers.splice(idx, 0, layer); this.active = idx; this.changed(); },
      redo: doIt,
      dispose: (done) => { if (done) freeTarget(this.gl, layer.target); },
    });
    return true;
  }

  moveLayer(from: number, to: number) {
    if (to < 0 || to >= this.layers.length || from === to) return;
    const apply = (a: number, b: number) => { const [l] = this.layers.splice(a, 1); this.layers.splice(b, 0, l); this.active = b; this.changed(); };
    apply(from, to);
    this.history.push({ label: 'Move layer', bytes: 64, undo: () => apply(to, from), redo: () => apply(from, to) });
  }

  /** swap a layer's pixels for a newly rendered target, undoably (old pixels held as a migratable stash) */
  private replaceTarget(layer: Layer, next: Target, label: string) {
    let held = new Stash(this.gl, layer.target, this.stashes);
    layer.target = next; layer.version++;
    this.changed();
    const swap = () => {
      const cur = new Stash(this.gl, layer.target, this.stashes);
      layer.target = held.take();
      held = cur;
      layer.version++; this.changed();
    };
    this.history.push({ label, bytes: this.bytesPerLayer(), undo: swap, redo: swap, dispose: () => held.dispose() });
  }

  clearLayer() { this.replaceTarget(this.activeLayer, this.newTarget(), 'Clear layer'); }

  fillLayer(rgb: [number, number, number]) {
    const layer = this.activeLayer;
    const gl = this.gl;
    const t = this.newTarget();
    bindTarget(gl, t);
    gl.disable(gl.BLEND);
    this.pFill.use().tex('uLayer', 0, layer.target.tex).f('uColor', ...rgb).i('uLock', layer.alphaLock ? 1 : 0);
    this.drawQuad();
    this.replaceTarget(layer, t, 'Fill layer');
  }

  mergeDown() {
    const i = this.active;
    if (i <= 0) return false;
    const upper = this.layers[i], lower = this.layers[i - 1];
    const gl = this.gl;
    const t = this.newTarget();
    bindTarget(gl, t);
    gl.disable(gl.BLEND);
    let src = upper.target.tex;
    if (upper.clip) {
      // apply clipping against the lower layer's alpha first (lower is its base when directly below)
      const tmp = this.s2;
      bindTarget(gl, tmp);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const p = this.pComposite.use(); this.setStrokeUniforms(p, null);
      p.tex('uPrev', 0, null).tex('uLayer', 1, upper.target.tex).tex('uClip', 2, lower.target.tex)
        .i('uMode', 0).f('uOpacity', 1).i('uClipMode', 1).i('uActive', 0);
      // uPrev null samples (0,0,0,0) on most drivers; bind cleared s1 to be safe
      bindTarget(gl, this.s1); gl.clear(gl.COLOR_BUFFER_BIT);
      bindTarget(gl, tmp); p.tex('uPrev', 0, this.s1.tex);
      this.drawQuad();
      src = tmp.tex;
      bindTarget(gl, t);
    }
    const p = this.pMerge.use();
    p.tex('uPrev', 0, lower.target.tex).tex('uLayer', 1, src).i('uMode', upper.blend).f('uOpacity', upper.opacity * (upper.visible ? 1 : 0));
    this.drawQuad();
    const old = lower.target;
    const doIt = () => { lower.target = t; this.layers.splice(this.layers.indexOf(upper), 1); this.active = this.layers.indexOf(lower); lower.version++; this.changed(); };
    doIt();
    this.history.push({
      label: 'Merge down', bytes: this.bytesPerLayer() * 2,
      undo: () => { lower.target = old; this.layers.splice(this.layers.indexOf(lower) + 1, 0, upper); this.active = this.layers.indexOf(upper); lower.version++; this.changed(); },
      redo: doIt,
      dispose: (done) => { if (done) { freeTarget(gl, old); freeTarget(gl, upper.target); } else freeTarget(gl, t); },
    });
    return true;
  }

  setProp<K extends 'opacity' | 'blend' | 'alphaLock' | 'clip' | 'visible' | 'name'>(layer: Layer, key: K, value: Layer[K], prev?: Layer[K]) {
    const before = prev !== undefined ? prev : layer[key];
    layer[key] = value;
    this.changed();
    if (before === value) return;
    this.history.push({
      label: 'Layer ' + key, bytes: 32,
      undo: () => { layer[key] = before; this.changed(); },
      redo: () => { layer[key] = value; this.changed(); },
    });
  }
  /** live preview of a property without recording history */
  previewProp<K extends 'opacity' | 'blend'>(layer: Layer, key: K, value: Layer[K]) { layer[key] = value; this.markDirty(); }

  setBackground(rgb: [number, number, number] | null, visible?: boolean) {
    const before = { bg: [...this.bg] as [number, number, number], vis: this.bgVisible };
    if (rgb) this.bg = rgb;
    if (visible !== undefined) this.bgVisible = visible;
    const after = { bg: [...this.bg] as [number, number, number], vis: this.bgVisible };
    this.changed();
    this.history.push({
      label: 'Background', bytes: 32,
      undo: () => { this.bg = before.bg; this.bgVisible = before.vis; this.changed(); },
      redo: () => { this.bg = after.bg; this.bgVisible = after.vis; this.changed(); },
    });
  }

  /** insert an image as a new layer, fitted inside the canvas */
  importImage(img: TexImageSource & { width: number; height: number }, name = 'Image') {
    if (this.layers.length >= this.maxLayersFor(this.w, this.h)) return null;
    const gl = this.gl;
    const src = textureFromCanvas(gl, img, false, true);
    const k = Math.min(1, this.w / img.width, this.h / img.height);
    const iw = img.width * k, ih = img.height * k;
    const t = this.newTarget();
    bindTarget(gl, t);
    gl.disable(gl.BLEND);
    this.pPremul.use().tex('uSrc', 0, src).f('uRect', (this.w - iw) / 2 / this.w, (this.h - ih) / 2 / this.h, iw / this.w, ih / this.h);
    this.drawQuad();
    gl.deleteTexture(src);
    const l = new Layer(name, t);
    this.insertLayer(l, this.active + 1, 'Import image');
    return l;
  }

  // ---------------------------------------------------------------- persistence
  /** full layer pixels (premultiplied RGBA, GL row order) without stalling the pipeline */
  readLayerAsync(layer: Layer): Promise<Uint8Array> {
    return new Readback(this.gl, layer.target.fb, 0, 0, this.w, this.h).wait();
  }

  /** replace the whole document (no undo history) */
  loadDocument(w: number, h: number, bg: [number, number, number], bgVisible: boolean,
    layers: { props: LayerProps; data?: Uint8Array | null; image?: ImageBitmap; x?: number; y?: number }[], active: number) {
    this.newDocument(w, h, bg);
    const gl = this.gl;
    freeTarget(gl, this.layers[0].target);
    this.layers = layers.map(({ props, data, image, x = 0, y = 0 }) => {
      const t = makeTarget(gl, w, h);
      if (image) {
        // straight-alpha image -> premultiplied layer, placed at its offset
        const src = textureFromCanvas(gl, image, false, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        bindTarget(gl, t); gl.disable(gl.BLEND);
        this.pPremul.use().tex('uSrc', 0, src).f('uRect', x / w, y / h, image.width / w, image.height / h);
        this.drawQuad();
        gl.deleteTexture(src);
      } else if (data && data.byteLength === w * h * 4) {
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      }
      const l = new Layer(props.name, t);
      Object.assign(l, { uid: props.uid || l.uid, visible: props.visible, opacity: props.opacity, blend: props.blend, alphaLock: props.alphaLock, clip: props.clip });
      return l;
    });
    if (!this.layers.length) this.layers = [new Layer('Layer 1', makeTarget(gl, w, h))];
    this.bgVisible = bgVisible;
    this.active = Math.max(0, Math.min(this.layers.length - 1, active));
    this.markDirty();
    this.onLayersChanged();
  }

  /** composite preview scaled to fit maxSide, as a 2D canvas (straight alpha) */
  compositeThumbnail(maxSide = 320, withBg = this.bgVisible): HTMLCanvasElement {
    const gl = this.gl;
    const k = Math.min(1, maxSide / Math.max(this.w, this.h));
    const tw = Math.max(1, Math.round(this.w * k)), th = Math.max(1, Math.round(this.h * k));
    this.composite({ x: 0, y: 0, w: this.w, h: this.h }, withBg);
    const t = makeTarget(gl, tw, th);
    bindTarget(gl, t);
    gl.disable(gl.BLEND);
    // generate mips on the composite for a clean minified sample, then 4x4 supersample on top
    gl.bindTexture(gl.TEXTURE_2D, this.comp.tex); gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.pDown.use().tex('uSrc', 0, this.comp.tex).f('uStep', 1 / tw, 1 / th);
    this.drawQuad();
    const px = this.readRect(t, { x: 0, y: 0, w: tw, h: th });
    freeTarget(gl, t);
    this.markDirty();
    const out = document.createElement('canvas'); out.width = tw; out.height = th;
    const img = new ImageData(tw, th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const i = (y * tw + x) * 4, o = i, a = px[i + 3], f = a ? 255 / a : 0;
      img.data[o] = px[i] * f; img.data[o + 1] = px[i + 1] * f; img.data[o + 2] = px[i + 2] * f; img.data[o + 3] = a;
    }
    out.getContext('2d')!.putImageData(img, 0, 0);
    return out;
  }

  /** debugging/testing helper: average alpha of a layer region */
  layerPixels(layer: Layer, r: Rect) { return this.readRect(layer.target, r); }
  // keep makeTexture referenced for tree-shaking stability
  static _mt = makeTexture;
}
export type { Entry };

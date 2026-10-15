import { GL, Program, Target, makeTarget, freeTarget, bindTarget, textureFromCanvas, makeTexture, Readback } from './gl';
import * as S from './shaders';
import { Brush, ShapeId, GrainId, makeShape, makeGrain } from './brushes';
import { History, Entry } from './history';
import { TilePool, TiledLayer, TileRef, TILE } from './tiles';

export const BLEND_MODES = ['Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten', 'Colour Dodge', 'Colour Burn',
  'Hard Light', 'Soft Light', 'Difference', 'Exclusion', 'Add', 'Linear Burn', 'Hue', 'Saturation', 'Colour', 'Luminosity'];

export interface Rect { x: number; y: number; w: number; h: number; }
export interface Dab { x: number; y: number; r: number; a: number; angle: number; aspect: number; }

let layerSeq = 1;
const newUid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export interface LayerProps { uid: string; name: string; visible: boolean; opacity: number; blend: number; alphaLock: boolean; clip: boolean;
  /** layer groups: this entry is a group / uid of the group it sits in / collapsed in the layers panel */
  group?: boolean; parent?: string | null; collapsed?: boolean;
  /** editable text (texttool.TextSpec) while the layer holds exactly the rendered text */
  text?: unknown; }
export class Layer implements TiledLayer {
  /** set by the engine: where every layer's pixels live */
  static pool: TilePool;
  id = layerSeq++;
  /** stable identity across sessions (storage key) */
  uid = newUid();
  visible = true;
  opacity = 1;
  blend = 0;
  alphaLock = false;
  clip = false;
  version = 0;
  /** layer groups: a group holds no pixels; its members sit directly below it in the stack (contiguous) */
  group = false;
  parent: Layer | null = null;
  collapsed = false;
  /** text layers: the spec it was rendered from, and the version it matches (edits after that make it plain pixels) */
  text: unknown = null;
  textVersion = -1;
  // storage (see tiles.ts): sparse atlas tiles, plus a full working texture while the layer is being edited
  res: Target | null = null;
  tiles = new Map<number, TileRef>();
  tilesVersion = -1;
  lastUse = 0;
  /** a new layer: empty (no memory at all) unless given a full-size texture to adopt */
  constructor(public name: string, t?: Target | null) { if (t) Layer.pool.adopt(this, t); }
  /** full-size texture of the layer's pixels; makes the layer resident (cheap when it already is) */
  get target(): Target { return Layer.pool.materialise(this); }
  /** replace the pixels with this texture (the previous resident texture now belongs to the caller) */
  set target(t: Target) { Layer.pool.adopt(this, t); }
  props(): LayerProps {
    const p: LayerProps = { uid: this.uid, name: this.name, visible: this.visible, opacity: this.opacity, blend: this.blend, alphaLock: this.alphaLock, clip: this.clip };
    if (this.group) { p.group = true; p.collapsed = this.collapsed; }
    if (this.parent) p.parent = this.parent.uid;
    if (this.text && this.textVersion === this.version) p.text = this.text;
    return p;
  }
}

export type Tool = 'brush' | 'eraser' | 'smudge';
/** one compositing step: a layer drawn with an opacity, optional tint (rgb + amount) and clipping base */
export interface DrawItem { layer: Layer; opacity: number; blend?: number; tint?: [number, number, number, number]; clipBase?: Layer | null;
  /** an isolated group: these items are composited on their own, then drawn with this item's opacity/blend/tint */
  children?: DrawItem[]; }

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
  private pSmudge!: Program; private pPickup!: Program; private pScreen!: Program; private pDown!: Program; private pPremul!: Program; private pFill!: Program; private pXform!: Program; private pMaskOp!: Program; private pBlur!: Program; private pSelop!: Program; private pMesh!: Program; private pJfaInit!: Program; private pJfaStep!: Program; private pGrow!: Program;
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
  /** selection mask (red channel 0..1); null = everything selected */
  sel: Target | null = null;
  onSelectionChanged: () => void = () => {};
  onLayersChanged: () => void = () => {};

  // view: doc px -> screen css px
  view = { x: 0, y: 0, scale: 1, rot: 0 };

  pool!: TilePool;
  /** layers that must stay resident besides the active one (tools in progress) */
  keepResident = new Set<Layer>();
  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false, desynchronized: true, powerPreference: 'high-performance' } as WebGLContextAttributes);
    if (!gl) throw new Error('WebGL2 is not available on this device/browser.');
    this.gl = gl;
    this.strokeFloat = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    this.initGL();
    this.pool = new TilePool(gl, () => this.drawQuad(), () => ({ w: this.w, h: this.h }));
    this.history.before = () => this.settleWet();
    Layer.pool = this.pool;
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
    this.pXform = new Program(gl, S.XFORM_VS, S.XFORM_FS);
    this.pMaskOp = new Program(gl, S.QUAD_VS, S.MASKOP_FS);
    this.pBlur = new Program(gl, S.QUAD_VS, S.BLUR_FS);
    this.pSelop = new Program(gl, S.QUAD_VS, S.SELOP_FS);
    this.pMesh = new Program(gl, S.MESH_VS, S.XFORM_FS);
    this.pJfaInit = new Program(gl, S.QUAD_VS, S.JFA_INIT_FS);
    this.pJfaStep = new Program(gl, S.QUAD_VS, S.JFA_STEP_FS);
    this.pGrow = new Program(gl, S.QUAD_VS, S.GROW_FS);
    gl.bindAttribLocation(this.pMesh.prog, 0, 'aPos'); gl.bindAttribLocation(this.pMesh.prog, 1, 'aUv'); gl.linkProgram(this.pMesh.prog);

    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    // all quad programs bind aPos at location 0
    for (const p of [this.pComposite, this.pBake, this.pMerge, this.pSmudge, this.pPickup, this.pScreen, this.pDown, this.pPremul, this.pFill, this.pXform, this.pMaskOp, this.pBlur, this.pSelop, this.pJfaInit, this.pJfaStep, this.pGrow]) {
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
  /** GPU memory allowed for layer pixels (atlas tiles + resident layers) */
  layerBudget = 560 * 1024 * 1024;
  /** layer cap: with sparse tiles an empty layer costs nothing, so the real limit is memory (see canGrow) */
  maxLayersFor(w: number, h: number) { return this.canGrow() ? 999 : this.layers.length; }
  /** is there room for more painted pixels? (fixed buffers + tiles + resident layers within the budget) */
  canGrow() {
    const fixed = this.w * this.h * (4 * 3 + (this.strokeFloat ? 2 : 4));
    // resident layers are transient (evicted when idle, at most pool.maxResident): count two working layers
    return fixed + this.pool.atlasBytes + 2 * this.w * this.h * 4 < this.layerBudget;
  }
  /** memory report for the gallery/settings and tests */
  memoryStats() {
    const fixed = this.w * this.h * (4 * 4 + (this.strokeFloat ? 2 : 4));
    return { tiles: this.pool.tileCount, pages: this.pool.pages.filter(Boolean).length, resident: this.pool.residentCount, layerBytes: this.pool.bytes, fixedBytes: fixed,
      wholeLayerBytes: this.layers.length * this.w * this.h * 4 };
  }

  newDocument(w: number, h: number, bg: [number, number, number] = [1, 1, 1]) {
    const gl = this.gl;
    this.drying = null; this.cur = null;
    if (this.wetF) { for (const t of this.wetF) freeTarget(gl, t); this.wetF = null; }
    this.history.clear();
    for (const l of this.layers) this.pool.releaseLayer(l);
    this.pool.dispose();
    for (const t of [this.stroke, this.comp, this.s1, this.s2, this.snapshot, ...this.gbuf.flat()]) if (t) freeTarget(gl, t);
    this.gbuf = [];
    this.snapshot = null;
    if (this.sel) { freeTarget(gl, this.sel); this.sel = null; }
    this.w = w; this.h = h; this.bg = bg; this.bgVisible = true;
    this.stroke = this.strokeFloat
      ? makeTarget(gl, w, h, { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT })
      : makeTarget(gl, w, h);
    this.comp = makeTarget(gl, w, h);
    this.s1 = makeTarget(gl, w, h); this.s2 = makeTarget(gl, w, h);
    this.layers = [new Layer('Layer 1')];
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
        .f('uWet', c!.tool === 'eraser' ? 0 : b.wet ? b.wetEdges * 0.3 : b.wetEdges).f('uWetR', Math.max(2, b.size * 0.15))
        .i('uAlphaLock', layer!.alphaLock ? 1 : 0);
    } else p.f('uWet', 0).i('uAlphaLock', 0).f('uStrokeOpacity', 0).f('uColor', 0, 0, 0).f('uWetR', 1);
    p.f('uTexel', 1 / this.w, 1 / this.h);
    p.tex('uSel', 4, this.sel ? this.sel.tex : null).i('uUseSel', this.sel ? 1 : 0);
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
    const items = this.drawItems();
    src = this.compositeItems(items, r, src, dst, 0);
    this.stats.compositePx += r.w * r.h * Math.max(1, items.length);
    this.mipStale = true;
    // copy result into comp
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.comp.fb);
    gl.blitFramebuffer(r.x, r.y, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y + r.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.disable(gl.SCISSOR_TEST);
  }

  private compositeItems(items: DrawItem[], r: Rect, src: Target, dst: Target, depth: number): Target {
    const gl = this.gl;
    const p = this.pComposite.use();
    this.setStrokeUniforms(p, null);
    const pool = this.pool;
    type Region = { x: number; y: number; w: number; h: number; lr?: TileRef; cr?: TileRef };
    const groupClips = new Map<Layer, Target>();
    for (const it of items) {
      const l = it.layer, clipBase = it.clipBase;
      // clipping onto a group: render the group's members (isolated, 100 %) inside this rect, once per pass
      let clipTex: Target | null = null;
      if (clipBase && clipBase.group) {
        clipTex = groupClips.get(clipBase) ?? null;
        if (!clipTex) {
          const [ca, cb] = this.groupBuffers(20 + depth * 2);
          bindTarget(gl, ca); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          clipTex = this.compositeItems(this.buildItems(clipBase), r, ca, cb, 21 + depth * 2);
          groupClips.set(clipBase, clipTex);
          p.use(); this.setStrokeUniforms(p, null);
        }
      }
      if (it.children) {
        // isolated group: its members composited into a transparent buffer pair, then drawn as one layer
        const [ga, gb] = this.groupBuffers(depth);
        bindTarget(gl, ga); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        const res = this.compositeItems(it.children, r, ga, gb, depth + 1);
        bindTarget(gl, dst);
        p.use(); this.setStrokeUniforms(p, null);
        p.i('uActive', 0).i('uClipMode', 0).tex('uClip', 2, null).tex('uPrev', 0, src.tex).tex('uLayer', 1, res.tex).f('uLayerMap', 1, 1, 0, 0)
          .i('uMode', it.blend ?? l.blend).f('uOpacity', it.opacity);
        const t = it.tint; p.f('uTint', t ? t[0] : 0, t ? t[1] : 0, t ? t[2] : 0, t ? t[3] : 0);
        this.drawQuad();
        const tt = src; src = dst; dst = tt;
        continue;
      }
      // resident layers draw in one pass; tiled ones only where they (and their clipping base) have tiles
      const lt = l.res ? null : l.tiles, ct = clipBase && !clipTex && !clipBase.res ? clipBase.tiles : null;
      let regions: Region[] | null = null;
      if (lt || ct) {
        regions = [];
        const src2 = lt ?? ct!;
        for (const [i, ref] of src2) {
          const tr = pool.tileRect(i);
          const x = Math.max(tr.x, r.x), y = Math.max(tr.y, r.y), x2 = Math.min(tr.x + tr.w, r.x + r.w), y2 = Math.min(tr.y + tr.h, r.y + r.h);
          if (x2 <= x || y2 <= y) continue;
          const lr = lt ? ref : undefined, cr = ct ? (lt ? ct.get(i) : ref) : undefined;
          if (ct && !cr) continue;
          regions.push({ x, y, w: x2 - x, h: y2 - y, lr, cr });
        }
        if (!regions.length) continue;   // nothing of this layer here: no pass at all
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
        gl.blitFramebuffer(r.x, r.y, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y + r.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      bindTarget(gl, dst);
      this.setStrokeUniforms(p, l);
      p.i('uActive', this.cur && this.cur.layer === l ? 1 : 0);
      p.tex('uPrev', 0, src.tex);
      if (l.res) p.tex('uLayer', 1, l.res.tex).f('uLayerMap', 1, 1, 0, 0);
      p.i('uMode', it.blend ?? l.blend).f('uOpacity', it.opacity);
      const t = it.tint; p.f('uTint', t ? t[0] : 0, t ? t[1] : 0, t ? t[2] : 0, t ? t[3] : 0);
      if (clipTex) { p.tex('uClip', 2, clipTex.tex).f('uClipMap', 1, 1, 0, 0).i('uClipMode', 1); }
      else if (clipBase) {
        if (clipBase.res) p.tex('uClip', 2, clipBase.res.tex).f('uClipMap', 1, 1, 0, 0);
        p.i('uClipMode', this.cur && this.cur.layer === clipBase && this.cur.tool !== 'smudge' ? 2 : 1);
        if (this.cur && this.cur.layer === clipBase && this.cur.layer !== l) {
          // the shared stroke uniforms belong to the base when the base is being painted
          this.setStrokeUniforms(p, clipBase);
          p.i('uActive', 0);
        }
      } else { p.i('uClipMode', 0); p.tex('uClip', 2, null); }
      if (!regions) this.drawQuad();
      else {
        const P = pool.page, W = this.w, H = this.h;
        for (const g of regions) {
          gl.scissor(g.x, g.y, g.w, g.h);
          const ti = Math.floor(g.x / TILE), tj = Math.floor(g.y / TILE);
          if (g.lr) { const s = pool.slotXY(g.lr); p.tex('uLayer', 1, pool.pageTex(g.lr)).f('uLayerMap', W / P, H / P, (s.x - ti * TILE) / P, (s.y - tj * TILE) / P); }
          if (g.cr) { const s = pool.slotXY(g.cr); p.tex('uClip', 2, pool.pageTex(g.cr)).f('uClipMap', W / P, H / P, (s.x - ti * TILE) / P, (s.y - tj * TILE) / P); }
          this.drawQuad();
        }
        gl.scissor(r.x, r.y, r.w, r.h);
      }
      const tt = src; src = dst; dst = tt;
    }
    return src;
  }
  private gbuf: Target[][] = [];
  /** a full-size buffer pair per group nesting depth (allocated on first use) */
  private groupBuffers(depth: number): Target[] {
    if (!this.gbuf[depth]) this.gbuf[depth] = [makeTarget(this.gl, this.w, this.h), makeTarget(this.gl, this.w, this.h)];
    return this.gbuf[depth];
  }

  /**
   * What the compositor draws, bottom to top. Normally every visible layer (clipping masks resolved);
   * animation mode replaces it with the current frame, onion skins and background/foreground layers.
   */
  drawList: DrawItem[] | null = null;
  drawItems(): DrawItem[] {
    if (this.drawList) return this.drawList;
    return this.buildItems(null);
  }
  /** draw items for the members of a group (null = top level), clipping resolved among siblings */
  buildItems(parent: Layer | null): DrawItem[] {
    const out: DrawItem[] = [];
    let clipBase: Layer | null = null;
    for (const l of this.layers) {
      if (l.parent !== parent) continue;
      // a group is a clipping base too (M5): layers clipped onto it are masked by the group's combined alpha
      if (l.group) { clipBase = l; if (l.visible && l.opacity > 0) out.push(...this.groupItems(l)); continue; }
      if (!l.clip) clipBase = l;
      const clipped = l.clip && clipBase && clipBase !== l;
      if (!l.visible || l.opacity <= 0) continue;
      if (clipped && !clipBase!.visible) continue;
      out.push({ layer: l, opacity: l.opacity, clipBase: clipped ? clipBase : null });
    }
    return out;
  }
  /**
   * A group as draw items. At Normal 100 % (and untinted) it passes through: its members blend straight onto
   * what is below, exactly as if ungrouped. Any other opacity, blend or tint isolates it: members are
   * composited on their own and the result is drawn as one layer (so 50 % fades the group as a whole).
   */
  groupItems(g: Layer, opacity = g.opacity, blend = g.blend, tint?: [number, number, number, number]): DrawItem[] {
    const children = this.buildItems(g);
    if (!children.length) return [];
    if (opacity >= 1 && blend === 0 && !tint) return children;
    return [{ layer: g, opacity, blend, tint, children }];
  }
  /** draw items for one layer or group (animation frames, onion skins) */
  itemsFor(l: Layer, opacity: number, blend: number, tint?: [number, number, number, number], clipBase?: Layer | null): DrawItem[] {
    if (l.group) return this.groupItems(l, opacity, blend, tint);
    return [{ layer: l, opacity, blend, tint, clipBase: clipBase ?? null }];
  }
  /** members of a group, bottom to top (direct only unless deep) */
  membersOf(g: Layer, deep = false): Layer[] { return this.layers.filter((l) => deep ? this.isInside(l, g) : l.parent === g); }
  isInside(l: Layer, g: Layer) { for (let p = l.parent; p; p = p.parent) if (p === g) return true; return false; }
  depthOf(l: Layer) { let d = 0; for (let p = l.parent; p; p = p.parent) d++; return d; }
  /** hidden because it or a containing group is hidden */
  hiddenInTree(l: Layer) { for (let p: Layer | null = l; p; p = p.parent) if (!p.visible) return true; return false; }
  /** changes whenever anything inside a group (or a layer itself) changes: for thumbnails */
  contentVersion(l: Layer): number {
    if (!l.group) return l.version;
    let v = 7 + this.structVersion * 131;
    for (const m of this.membersOf(l, true)) v = (v * 31 + m.version + (m.visible ? 1 : 0) + Math.round(m.opacity * 100) * 3 + m.blend * 7) | 0;
    return v;
  }
  structVersion = 0;

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

  private maintainTiles() {
    const keep = new Set<Layer>(this.keepResident);
    if (this.activeLayer) keep.add(this.activeLayer);
    this.pool.maintain(keep);
  }
  render() {
    const gl = this.gl;
    if (!this.comp) return; // no document yet (boot is still reading storage)
    if (this.drying) this.advanceDrying(2);
    if (!this.cur) { this.maintainStashes(); this.maintainTiles(); }
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
    p.tex('uSel', 1, this.sel ? this.sel.tex : null).i('uUseSel', this.sel ? 1 : 0).f('uTime', (performance.now() / 1000) % 1000).f('uDpr', dpr);
    this.drawQuad();
    if (this.sel) this.animateSel();
  }
  private selAnim = 0;
  /** keep the marching ants moving (~30 fps) */
  private animateSel() {
    if (this.selAnim) return;
    this.selAnim = window.setTimeout(() => { this.selAnim = 0; if (this.sel) this.needsPresent = true; }, 33);
  }

  // ---------------------------------------------------------------- strokes
  beginStroke(tool: Tool, brush: Brush, color: [number, number, number]) {
    this.settleWet();
    if (this.cur) this.cancelStroke();
    const layer = this.activeLayer;
    if (!layer || layer.group) return false;
    void layer.target;   // resident while painted
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

  /** a stroke is being drawn (not counting a watercolour stroke that is still drying on its own) */
  get stroking() { return !!this.cur && !this.drying; }

  // ---------------------------------------------------------------- wet media: drying simulation after a wet stroke
  private drying: { left: number; total: number; rect: Rect; dried?: boolean } | null = null;
  private wetF: Target[] | null = null;
  private pWet: Record<string, Program> | null = null;
  /** setting: run the drying simulation for wet brushes */
  wetMedia = true;
  get isDrying() { return !!this.drying; }
  private startDrying(c: StrokeState) {
    const gl = this.gl, b = c.brush, wet = Math.min(1, b.wet ?? 0);
    const off = Math.max(1, b.size / 48);
    const total = Math.round(26 + 26 * wet);
    const bleed = Math.ceil(off * Math.sqrt(total) * 1.2 + 4);
    const base = this.padRectFor(c, c.bbox!);
    const rect = this.clampRect({ x: base.x - bleed, y: base.y - bleed, w: base.w + bleed * 2, h: base.h + bleed * 2 });
    if (!rect) return false;
    if (!this.pWet) this.pWet = { init: this.program(S.WET_INIT_FS), step: this.program(S.WET_STEP_FS), out: this.program(S.WET_OUT_FS) };
    if (!this.wetF) {
      const fl = this.strokeFloat ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT } : {};
      this.wetF = [makeTarget(gl, this.w, this.h, fl), makeTarget(gl, this.w, this.h, fl)];
    }
    c.bbox = { ...rect };
    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(rect.x, rect.y, rect.w, rect.h);
    bindTarget(gl, this.wetF[0]);
    this.pWet.init.use().tex('uStroke', 0, this.stroke.tex).f('uWet', 0.35 + 0.65 * wet);
    this.drawQuad();
    gl.disable(gl.SCISSOR_TEST);
    this.drying = { left: total, total, rect };
    this.markDirty(rect);
    return true;
  }
  /** advance the drying by n steps; bakes the stroke when the paint is dry */
  private advanceDrying(n: number) {
    const d = this.drying, c = this.cur;
    if (!d || !c || !this.wetF || !this.pWet) { this.drying = null; return; }
    const gl = this.gl, b = c.brush, r = d.rect;
    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(r.x, r.y, r.w, r.h);
    const off = Math.max(1, b.size / 48);
    const p = this.pWet.step;
    for (let i = 0; i < n && d.left > 0; i++, d.left--) {
      bindTarget(gl, this.wetF[1]);
      p.use().tex('uF', 0, this.wetF[0].tex).tex('uGrain', 1, this.grainTex(b.grain === 'none' ? 'paper' : b.grain))
        .f('uTexel', 1 / this.w, 1 / this.h).f('uOff', off).f('uEvap', 0.9 / d.total).f('uFlow', 0.85).f('uGran', b.granulation ?? 0.4)
        .f('uGrainScale', b.grainScale || 1).f('uLast', d.left === 1 ? 1 : 0).f('uDocSize', this.w, this.h);
      this.drawQuad();
      const t = this.wetF[0]; this.wetF[0] = this.wetF[1]; this.wetF[1] = t;
    }
    bindTarget(gl, this.stroke);
    this.pWet.out.use().tex('uF', 0, this.wetF[0].tex);
    this.drawQuad();
    gl.disable(gl.SCISSOR_TEST);
    this.markDirty(r);
    if (d.left <= 0) { d.dried = true; this.endStroke(); }
  }
  /** finish any drying stroke now (before undo, a new stroke, export…) */
  settleWet() { if (this.drying) this.advanceDrying(this.drying.left); }

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
        .f('uDocSize', this.w, this.h).f('uDabPos', d.x, d.y).f('uDabR', R).f('uK', Math.min(1, d.a))
        .tex('uSel', 4, this.sel ? this.sel.tex : null).i('uUseSel', this.sel ? 1 : 0);
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
    // the new dab set can be larger or smaller than before: dirty the union, keep the new bbox for the bake
    const old = c.bbox;
    let bb: Rect | null = null;
    for (const d of dabs) bb = unionRect(bb, this.dabRect(d));
    c.bbox = bb;
    const u = old && bb ? unionRect(old, bb) : old || bb;
    if (u) this.markDirty(this.padRect(u));
  }

  private padRect(r: Rect) {
    const c = this.cur;
    const wet = c && c.tool !== 'eraser' && c.brush.wetEdges > 0 ? Math.max(2, c.brush.size * 0.15) + 2 : 0;
    return { x: r.x - wet, y: r.y - wet, w: r.w + wet * 2, h: r.h + wet * 2 };
  }

  cancelStroke() {
    if (this.drying) { this.settleWet(); return; }
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
    if (!this.drying && this.wetMedia && c.tool === 'brush' && (c.brush.wet ?? 0) > 0 && this.startDrying(c)) return;
    this.drying = null;
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
    this.pDown.use().tex('uSrc', 0, (layer.group ? this.renderGroup(layer) : this.pool.readable(layer)).tex).f('uStep', scale / this.w, scale / this.h).f('uOver', 0, 0, 0, 0).i('uTaps', 4);
    bindTarget(gl, this.thumbT);
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

  /** like thumbnail(), but read back asynchronously (no pipeline stall); resolves when drawn */
  async thumbnailAsync(layer: Layer, out: HTMLCanvasElement) {
    const gl = this.gl, tw = out.width, th = out.height;
    const t = makeTarget(gl, tw, th);
    const scale = Math.max(this.w / tw, this.h / th);
    const srcT = layer.group ? this.renderGroup(layer) : this.pool.readable(layer);
    bindTarget(gl, t); gl.disable(gl.BLEND);
    this.pDown.use().tex('uSrc', 0, srcT.tex).f('uStep', scale / this.w, scale / this.h).f('uOver', 0, 0, 0, 0).i('uTaps', 4);
    this.drawQuad();
    const rb = new Readback(gl, t.fb, 0, 0, tw, th);
    freeTarget(gl, t); // the copy into the pack buffer is already queued
    const px = await rb.wait();
    const img = new ImageData(tw, th);
    for (let i = 0; i < px.length; i += 4) { const a = px[i + 3], k = a ? 255 / a : 0; img.data[i] = px[i] * k; img.data[i + 1] = px[i + 1] * k; img.data[i + 2] = px[i + 2] * k; img.data[i + 3] = a; }
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
    // membership follows the position: the same group as the layer below (a group header below = beside it)
    if (!layer.group && !(layer.parent && this.layers[index] === layer.parent)) layer.parent = index > 0 ? this.layers[index - 1]?.parent ?? null : null;
    const doIt = () => { this.layers.splice(index, 0, layer); this.active = index; this.changed(); };
    doIt();
    this.history.push({
      label, bytes: this.bytesPerLayer(),
      undo: () => { this.layers.splice(this.layers.indexOf(layer), 1); this.active = Math.min(prevActive, this.layers.length - 1); this.changed(); },
      redo: doIt,
      dispose: (done) => { if (!done) this.pool.releaseLayer(layer); },
    });
  }

  addLayer(): Layer | null {
    if (this.layers.length >= this.maxLayersFor(this.w, this.h)) return null;
    const l = new Layer('Layer ' + (Math.max(0, ...this.layers.map((x) => +(x.name.match(/^Layer (\d+)$/)?.[1] ?? 0))) + 1));
    const a = this.activeLayer;
    // above the active layer, in the same group; on a group: inside it, at the top
    if (a) l.parent = a.group && !a.collapsed ? a : a.parent;
    this.insertLayer(l, a && a.group && a.collapsed ? this.blockOf(a)[1] + 1 : this.active + (a && a.group && !a.collapsed ? 0 : 1), 'New layer');
    return l;
  }

  duplicateLayer(): Layer | null {
    if (this.layers.length >= this.maxLayersFor(this.w, this.h)) return null;
    const src = this.activeLayer;
    if (src.group) return this.duplicateGroup(src);
    const l = new Layer(src.name + ' copy', this.copyTarget(src.target));
    l.parent = src.parent;
    Object.assign(l, { opacity: src.opacity, blend: src.blend, alphaLock: src.alphaLock, clip: src.clip, visible: src.visible });
    this.insertLayer(l, this.active + 1, 'Duplicate layer');
    return l;
  }

  /** copy a group and everything in it, placed above the original */
  private duplicateGroup(g: Layer): Layer {
    const [s0, e0] = this.blockOf(g);
    const map = new Map<Layer, Layer>();
    const copies = this.layers.slice(s0, e0 + 1).map((x) => {
      const c = new Layer(x === g ? x.name + ' copy' : x.name, x.group ? null : this.copyTarget(this.pool.readable(x)));
      Object.assign(c, { opacity: x.opacity, blend: x.blend, alphaLock: x.alphaLock, clip: x.clip, visible: x.visible, group: x.group, collapsed: x.collapsed });
      map.set(x, c); return c;
    });
    for (const [x, c] of map) c.parent = x === g ? g.parent : map.get(x.parent!)!;
    this.structEdit('Duplicate group', () => { this.layers.splice(e0 + 1, 0, ...copies); this.active = e0 + copies.length; });
    return map.get(g)!;
  }
  deleteLayer() {
    if (this.activeLayer.group) return this.deleteBlock(this.activeLayer);
    if (this.layers.length <= 1) return false;
    const idx = this.active, layer = this.layers[idx];
    const doIt = () => { this.layers.splice(idx, 1); this.active = Math.max(0, idx - 1); this.changed(); };
    doIt();
    this.history.push({
      label: 'Delete layer', bytes: this.bytesPerLayer(),
      undo: () => { this.layers.splice(idx, 0, layer); this.active = idx; this.changed(); },
      redo: doIt,
      dispose: (done) => { if (done) this.pool.releaseLayer(layer); },
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

  /**
   * Whole-layer edit whose undo holds only the tiles that had paint (M5): the layer's pixels are detached as a
   * sparse tile map (pointer move, no copy when the tiles are in sync), the new pixels are rendered from it,
   * and undo/redo swap tile maps. Clearing a layer with a small sketch on a 4096² canvas keeps a few 256²
   * tiles instead of a 64 MB full-canvas copy. make(src) returns the new texture, or null for an empty layer.
   */
  tileEdit(layer: Layer, label: string, make: (src: Target) => Target | null) {
    this.settleWet();
    const pool = this.pool;
    const before = pool.takeTiles(layer);
    const next = make(pool.readableTiles(before));
    if (next) layer.target = next;
    layer.version++;
    this.changed();
    let held = before;
    const tileBytes = (m: Map<number, TileRef>) => m.size * TILE * TILE * 4;
    const swap = () => {
      const now = pool.takeTiles(layer);
      layer.version++;
      pool.putTiles(layer, held);
      held = now;
      this.changed();
    };
    this.history.push({ label, bytes: Math.max(64, tileBytes(before)), undo: swap, redo: swap, dispose: () => pool.freeTiles(held) });
  }

  private pPaint: Program | null = null;
  /**
   * Paint a solid fill, a gradient or a recolour onto the active layer through optional coverage bytes
   * (row 0 = top, cov.rect in doc px) and the selection; one undo step holding only the painted tiles.
   */
  paintLayer(o: { mode: 0 | 1 | 2 | 3; c0: [number, number, number, number]; c1?: [number, number, number, number]; p0?: { x: number; y: number }; p1?: { x: number; y: number };
    seed?: [number, number, number]; cov?: { data: Uint8Array; rect: Rect }; opacity?: number; label: string }) {
    const layer = this.activeLayer;
    if (!layer || layer.group) return false;
    const gl = this.gl;
    if (!this.pPaint) this.pPaint = this.program(S.PAINT_FS);
    let ct: WebGLTexture | null = null;
    if (o.cov) {
      ct = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, ct);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, o.cov.rect.w, o.cov.rect.h, 0, gl.RED, gl.UNSIGNED_BYTE, o.cov.data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    const r = o.cov ? o.cov.rect : { x: 0, y: 0, w: this.w, h: this.h };
    this.tileEdit(layer, o.label, (src) => {
      const t = this.newTarget();
      bindTarget(gl, t); gl.disable(gl.BLEND);
      const c1 = o.c1 ?? o.c0, p0 = o.p0 ?? { x: 0, y: 0 }, p1 = o.p1 ?? { x: 1, y: 0 }, sd = o.seed ?? [0, 0, 0];
      this.pPaint!.use().tex('uLayer', 0, src.tex).tex('uSel', 1, this.sel ? this.sel.tex : null).i('uUseSel', this.sel ? 1 : 0)
        .tex('uCov', 2, ct).i('uUseCov', ct ? 1 : 0).i('uLock', layer.alphaLock ? 1 : 0).i('uMode', o.mode)
        .f('uRect', r.x, r.y, r.w, r.h).f('uDoc', this.w, this.h).f('uC0', ...o.c0).f('uC1', ...c1).f('uP0', p0.x, p0.y).f('uP1', p1.x, p1.y)
        .f('uSeed', ...sd).f('uOpacity', o.opacity ?? 1);
      this.drawQuad();
      return t;
    });
    if (ct) gl.deleteTexture(ct);
    this.onStrokeCommitted();
    return true;
  }

  /** clear the layer, or only the selected pixels when there is a selection */
  clearLayer() {
    if (this.activeLayer.group) return;
    if (this.sel) { this.tileEdit(this.activeLayer, 'Clear selection', (src) => this.selop(src, 1)); return; }
    this.tileEdit(this.activeLayer, 'Clear layer', () => null);
  }

  /** fill the layer (or the selection) with a colour, honouring alpha lock */
  fillLayer(rgb: [number, number, number]) {
    const layer = this.activeLayer;
    if (layer.group) return;
    this.tileEdit(layer, this.sel ? 'Fill selection' : 'Fill layer', (src) => this.selop(src, 0, rgb, layer.alphaLock));
  }

  /** run SELOP on a layer (or a texture of its pixels) into a new target */
  private selop(layer: Layer | Target, mode: 0 | 1 | 2 | 3, rgb: [number, number, number] = [0, 0, 0], lock = layer instanceof Layer ? layer.alphaLock : false): Target {
    const gl = this.gl, t = this.newTarget();
    const tex = layer instanceof Layer ? layer.target.tex : layer.tex;
    bindTarget(gl, t); gl.disable(gl.BLEND);
    this.pSelop.use().tex('uLayer', 0, tex).tex('uSel', 1, this.sel ? this.sel.tex : null)
      .i('uUseSel', this.sel ? 1 : 0).i('uMode', mode).i('uLock', lock ? 1 : 0).f('uColor', ...rgb);
    this.drawQuad();
    return t;
  }

  // ---------------------------------------------------------------- selection
  /** replace the selection mask (null = none), undoably */
  setSelection(next: Target | null, label: string) {
    let held: Stash | null = this.sel ? new Stash(this.gl, this.sel, this.stashes) : null;
    this.sel = next;
    const swap = () => {
      const cur = this.sel ? new Stash(this.gl, this.sel, this.stashes) : null;
      this.sel = held ? held.take() : null;
      held = cur;
      this.needsPresent = true; this.onSelectionChanged();
    };
    this.history.push({ label, bytes: this.w * this.h * 4, undo: swap, redo: swap, dispose: () => held?.dispose() });
    this.needsPresent = true; this.onSelectionChanged();
  }
  /** combine a coverage texture (alpha, or red when red=true) into the selection */
  combineSelection(cover: WebGLTexture, mode: 0 | 1 | 2 | 4, label: string, red = false) {
    const gl = this.gl, t = this.newTarget();
    bindTarget(gl, t); gl.disable(gl.BLEND);
    this.pMaskOp.use().tex('uOld', 0, this.sel ? this.sel.tex : null).i('uHasOld', this.sel ? 1 : 0)
      .tex('uNew', 1, cover).i('uMode', mode).i('uNewRed', red ? 1 : 0);
    this.drawQuad();
    this.setSelection(t, label);
  }
  /** selection from a 2D canvas the size of the document (white = selected, alpha = coverage) */
  selectFromCanvas(c: HTMLCanvasElement | OffscreenCanvas, mode: 0 | 1 | 2, label: string) {
    const gl = this.gl;
    const tex = textureFromCanvas(gl, c as unknown as TexImageSource, false, false);
    this.combineSelection(tex, mode, label);
    gl.deleteTexture(tex);
  }
  /** selection from per-pixel coverage bytes (w*h, row 0 = top) */
  selectFromBytes(cov: Uint8Array, mode: 0 | 1 | 2, label: string) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.w, this.h, 0, gl.RED, gl.UNSIGNED_BYTE, cov);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.combineSelection(tex, mode, label, true);
    gl.deleteTexture(tex);
  }
  invertSelection() {
    const gl = this.gl, t = this.newTarget();
    bindTarget(gl, t); gl.disable(gl.BLEND);
    this.pMaskOp.use().tex('uOld', 0, this.sel ? this.sel.tex : null).i('uHasOld', this.sel ? 1 : 0).tex('uNew', 1, null).i('uMode', 3).i('uNewRed', 0);
    this.drawQuad();
    this.setSelection(t, 'Invert selection');
  }
  deselect() { if (this.sel) this.setSelection(null, 'Deselect'); }
  selectAll() {
    const gl = this.gl, t = this.newTarget();
    bindTarget(gl, t); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    this.setSelection(t, 'Select all');
  }
  /** soften the selection edge by a gaussian of the given radius (doc px) */
  featherSelection(radius: number) {
    if (!this.sel || radius <= 0) return;
    const b = this.newTarget(), tmp = this.newTarget();
    this.blurMask(this.sel, b, tmp, radius);
    freeTarget(this.gl, tmp);
    this.setSelection(b, 'Feather selection');
  }
  /** separable gaussian of a mask (src → dst, tmp as scratch) */
  private blurMask(src: Target, dst: Target, tmp: Target, radius: number) {
    const gl = this.gl;
    const sigma = radius / 2;
    const step = Math.max(1, (sigma * 3) / 48), taps = Math.min(64, Math.ceil((sigma * 3) / step));
    gl.disable(gl.BLEND);
    bindTarget(gl, tmp);
    this.pBlur.use().tex('uSrc', 0, src.tex).f('uDir', step / this.w, 0).f('uSigma', sigma / step).i('uTaps', taps);
    this.drawQuad();
    bindTarget(gl, dst);
    this.pBlur.use().tex('uSrc', 0, tmp.tex).f('uDir', 0, step / this.h).f('uSigma', sigma / step).i('uTaps', taps);
    this.drawQuad();
  }
  /** nearest-seed field of the selection: inside = seeds where mask ≥ 0.5, else where it is < 0.5 */
  private jumpFlood(inside: boolean): Target {
    const gl = this.gl;
    let a = this.newTarget(), b = this.newTarget();
    for (const t of [a, b]) { gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); }
    gl.disable(gl.BLEND);
    bindTarget(gl, a);
    this.pJfaInit.use().tex('uSel', 0, this.sel!.tex).i('uInside', inside ? 1 : 0);
    this.drawQuad();
    let step = 1; while (step * 2 < Math.max(this.w, this.h)) step *= 2;
    const steps: number[] = []; for (let k = step; k >= 1; k = k >> 1) steps.push(k);
    steps.push(1); // JFA+1 pass removes most of the remaining errors
    const p = this.pJfaStep.use();
    gl.uniform2i(p.u('uSize'), this.w, this.h);
    for (const k of steps) {
      bindTarget(gl, b);
      p.tex('uSrc', 0, a.tex).i('uStep', k);
      this.drawQuad();
      const t = a; a = b; b = t;
    }
    freeTarget(gl, b);
    return a;
  }
  /**
   * Live edge refinement of the selection: grow/shrink (signed px) then feather. Distance fields are built once,
   * so each preview is one cheap pass (+ the blur). The preview replaces the displayed mask until commit/cancel.
   */
  beginEdgeAdjust(): { preview(grow: number, feather: number): void; commit(): void; cancel(): void } | null {
    if (!this.sel) return null;
    const gl = this.gl, orig = this.sel;
    // distance fields are built on first use: growing needs the inside field, shrinking the outside one
    let fIn: Target | null = null, fOut: Target | null = null;
    const grown = this.newTarget(), out = this.newTarget(), tmp = this.newTarget();
    let shown: Target = orig;
    const free = () => { for (const t of [fIn, fOut, grown, tmp]) if (t) freeTarget(gl, t); };
    return {
      preview: (g, f) => {
        if (g > 0 && !fIn) { this.sel = orig; fIn = this.jumpFlood(true); }
        if (g < 0 && !fOut) { this.sel = orig; fOut = this.jumpFlood(false); }
        gl.disable(gl.BLEND);
        bindTarget(gl, grown);
        this.pGrow.use().tex('uSel', 0, orig.tex).tex('uIn', 1, (fIn || orig).tex).tex('uOut', 2, (fOut || orig).tex).f('uR', g);
        this.drawQuad();
        if (f > 0) this.blurMask(grown, out, tmp, f);
        else { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, grown.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, out.fb); gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST); }
        shown = g || f ? out : orig;
        this.sel = shown; this.needsPresent = true;
      },
      commit: () => {
        this.sel = orig; free();
        if (shown === out) this.setSelection(out, 'Refine selection edge'); else freeTarget(gl, out);
      },
      cancel: () => { this.sel = orig; free(); freeTarget(gl, out); this.needsPresent = true; },
    };
  }
  /** new layer holding the selected pixels of the active layer */
  copySelectionToLayer(): Layer | null {
    if (this.layers.length >= this.maxLayersFor(this.w, this.h)) return null;
    const src = this.activeLayer;
    const l = new Layer(src.name + ' (copy)', this.selop(src, 2));
    this.insertLayer(l, this.active + 1, 'Copy & paste');
    return l;
  }
  /** layer pixels kept outside the selection, and the selected pixels, as new full-size targets */
  splitBySelection(layer: Layer): { inside: Target; outside: Target | null } {
    if (!this.sel) return { inside: this.copyTarget(layer.target), outside: null };
    return { inside: this.selop(layer, 2), outside: this.selop(layer, 3) };
  }
  /** bounding box of alpha > 0 in a target (async readback) */
  async contentBounds(t: Target): Promise<Rect | null> {
    const px = await new Readback(this.gl, t.fb, 0, 0, this.w, this.h).wait();
    let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
    const W = this.w;
    for (let y = 0; y < this.h; y++) {
      const row = y * W * 4;
      let any = false;
      for (let x = 0; x < W; x++) if (px[row + x * 4 + 3] > 1 || px[row + x * 4] > 1) { any = true; if (x < x0) x0 = x; break; }
      if (!any) continue;
      for (let x = W - 1; x >= 0; x--) if (px[row + x * 4 + 3] > 1 || px[row + x * 4] > 1) { if (x > x1) x1 = x; break; }
      if (y < y0) y0 = y; y1 = y;
    }
    if (x1 < 0) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  /** a cropped, mipmapped copy of a rect of any target */
  sourceFromTarget(t: Target, r: Rect): Target {
    const gl = this.gl, out = makeTarget(gl, r.w, r.h);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, out.fb);
    gl.blitFramebuffer(r.x, r.y, r.x + r.w, r.y + r.h, 0, 0, r.w, r.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.mipify(out);
    return out;
  }
  /** full-size empty target (public for tools) */
  blankTarget() { return this.newTarget(); }
  /** replace a layer's target without history (live previews); returns the old one */
  swapTarget(layer: Layer, t: Target): Target { const old = layer.target; layer.target = t; layer.version++; this.markDirty(); return old; }
  freeTarget(t: Target) { freeTarget(this.gl, t); }

  mergeDown() {
    const i = this.active;
    if (i <= 0) return false;
    const upper = this.layers[i], lower = this.layers[i - 1];
    if (upper.group || lower.group || lower.parent !== upper.parent) return false;
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
      p.f('uLayerMap', 1, 1, 0, 0).f('uClipMap', 1, 1, 0, 0).f('uTint', 0, 0, 0, 0);
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
    // swap semantics (the entry holds the pixels of the state it is not in) so no texture is ever owned twice
    let held = new Stash(gl, lower.target, this.stashes);
    lower.target = t;
    const swapLower = () => { const cur = new Stash(gl, lower.target, this.stashes); lower.target = held.take(); held = cur; lower.version++; };
    this.layers.splice(this.layers.indexOf(upper), 1); this.active = this.layers.indexOf(lower); lower.version++; this.changed();
    this.history.push({
      label: 'Merge down', bytes: this.bytesPerLayer() * 2,
      undo: () => { swapLower(); this.layers.splice(this.layers.indexOf(lower) + 1, 0, upper); this.active = this.layers.indexOf(upper); this.changed(); },
      redo: () => { swapLower(); this.layers.splice(this.layers.indexOf(upper), 1); this.active = this.layers.indexOf(lower); this.changed(); },
      dispose: (done) => { held.dispose(); if (done) this.pool.releaseLayer(upper); },
    });
    return true;
  }

  // ---------------------------------------------------------------- layer groups (structure edits are undoable snapshots)
  private structSnap() { return { order: [...this.layers], parents: new Map(this.layers.map((l) => [l, l.parent] as [Layer, Layer | null])), active: this.layers[this.active] }; }
  private structRestore(s: ReturnType<Engine['structSnap']>) {
    this.layers = [...s.order];
    for (const [l, p] of s.parents) l.parent = p;
    this.active = Math.max(0, this.layers.indexOf(s.active));
    this.structVersion++;
    this.changed();
  }
  /** apply a structural change (order / membership) as one undo step; removed layers are freed when the step is dropped */
  structEdit(label: string, fn: () => void) {
    const before = this.structSnap();
    fn();
    this.structVersion++;
    const after = this.structSnap();
    this.changed();
    const gone = before.order.filter((l) => !after.order.includes(l)), added = after.order.filter((l) => !before.order.includes(l));
    this.history.push({
      label, bytes: 64 + gone.length * 32,
      undo: () => this.structRestore(before), redo: () => this.structRestore(after),
      dispose: (done) => { for (const l of done ? gone : added) this.pool.releaseLayer(l); },
    });
  }
  /** index range [start, end] (inclusive) of a layer or a whole group block in the stack */
  blockOf(l: Layer): [number, number] {
    const end = this.layers.indexOf(l);
    if (!l.group) return [end, end];
    let start = end;
    while (start > 0 && this.isInside(this.layers[start - 1], l)) start--;
    return [start, end];
  }
  /** put the active layer (or group) into a new group in its place */
  groupActive(): Layer | null {
    const a = this.activeLayer; if (!a) return null;
    if (this.depthOf(a) >= 4) return null;
    const g = new Layer('Group ' + (this.layers.filter((l) => l.group).length + 1));
    g.group = true;
    this.structEdit('New group', () => {
      g.parent = a.parent;
      a.parent = g;
      const at = this.layers.indexOf(a);
      this.layers.splice(at + 1, 0, g);
      this.active = at + 1;
    });
    return g;
  }
  /** dissolve a group: its members stay where they are */
  ungroup(g: Layer) {
    if (!g.group) return;
    this.structEdit('Ungroup', () => {
      for (const m of this.membersOf(g)) m.parent = g.parent;
      const i = this.layers.indexOf(g);
      this.layers.splice(i, 1);
      this.active = Math.max(0, i - 1);
    });
  }
  /** delete a layer or a whole group with its contents */
  deleteBlock(l: Layer) {
    const [s0, e0] = this.blockOf(l);
    if (e0 - s0 + 1 >= this.layers.length) return false;
    this.structEdit(l.group ? 'Delete group' : 'Delete layer', () => { this.layers.splice(s0, e0 - s0 + 1); this.active = Math.max(0, Math.min(this.layers.length - 1, s0 - 1)); });
    return true;
  }
  /**
   * Move a layer or group block one step up (+1) or down (-1) among the visible structure: past a sibling, into
   * an expanded sibling group (as its nearest member), or out of its group when it is at the group's edge.
   */
  moveBlock(l: Layer, dir: 1 | -1) {
    const [s0, e0] = this.blockOf(l);
    const block = this.layers.slice(s0, e0 + 1);
    this.structEdit('Move layer', () => {
      const rest = this.layers.filter((x) => !block.includes(x));
      let at: number;  // insertion index in rest
      if (dir > 0) {
        const above = this.layers[e0 + 1];
        if (!above) return;
        if (above === l.parent) { l.parent = above.parent; at = rest.indexOf(above) + 1; }               // leave the group upwards
        else {
          let unit = above; while (unit.parent !== l.parent) unit = unit.parent!;                         // the sibling (block) above
          if (unit.group && !unit.collapsed && this.depthOf(unit) < 4) { l.parent = unit; at = rest.indexOf(above); } // enter it as its bottom member
          else at = rest.indexOf(unit) + 1;                                                                // hop over it
        }
      } else {
        const below = this.layers[s0 - 1];
        if (!below) return;
        if (below.parent !== l.parent) {                                                                        // bottom member: leave the group downwards
          const g = l.parent!; const [gs] = this.blockOf(g); l.parent = g.parent; at = rest.indexOf(this.layers[gs]);
        } else {
          // the sibling unit below ends at `below`; find its top (the group header if below is inside a group block)
          let unit = below; while (unit.parent && unit.parent !== l.parent) unit = unit.parent;
          if (unit.group && !unit.collapsed && this.depthOf(unit) < 4) { l.parent = unit; at = rest.indexOf(unit); }  // enter as its top member
          else { const [us] = this.blockOf(unit); at = rest.indexOf(this.layers[us]); }
        }
      }
      rest.splice(at, 0, ...block);
      this.layers = rest;
      this.active = this.layers.indexOf(l);
    });
  }
  /** flatten a group into one layer holding exactly what the group shows */
  flattenGroup(g: Layer): Layer | null {
    if (!g.group) return null;
    const gl = this.gl, t = this.newTarget();
    const res = this.renderGroup(g);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, res.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fb);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    const flat = new Layer(g.name, t);
    Object.assign(flat, { opacity: g.opacity, blend: g.blend, visible: g.visible });
    const [s0, e0] = this.blockOf(g);
    this.structEdit('Flatten group', () => { flat.parent = g.parent; this.layers.splice(s0, e0 - s0 + 1, flat); this.active = s0; });
    return flat;
  }
  /** a group's contents composited on their own at 100 % (valid until the next composite) */
  renderGroup(g: Layer): Target {
    const gl = this.gl, r = { x: 0, y: 0, w: this.w, h: this.h };
    const [ga, gb] = this.groupBuffers(0);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, this.w, this.h); gl.disable(gl.BLEND);
    bindTarget(gl, ga); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const res = this.compositeItems(this.buildItems(g), r, ga, gb, 1);
    gl.disable(gl.SCISSOR_TEST);
    return res;
  }
  setCollapsed(g: Layer, c: boolean) { g.collapsed = c; this.onLayersChanged(); }

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
  /** split full-layer pixels (GL row order) into the layer's tiles, skipping empty ones */
  private writeTilesFromFull(l: Layer, data: Uint8Array) {
    const pool = this.pool, n = pool.tilesX * pool.tilesY, w = this.w;
    for (let i = 0; i < n; i++) {
      const r = pool.tileRect(i);
      const t = new Uint8Array(r.w * r.h * 4);
      let any = false;
      for (let y = 0; y < r.h; y++) {
        const o = ((r.y + y) * w + r.x) * 4;
        const row = data.subarray(o, o + r.w * 4);
        if (!any) { const u = new Uint32Array(row.buffer, row.byteOffset, r.w); for (let x = 0; x < r.w; x++) if (u[x]) { any = true; break; } }
        t.set(row, y * r.w * 4);
      }
      if (any) pool.writeTile(l, i, t);
    }
  }
  /** a layer's non-empty tiles (index → premultiplied RGBA of the clipped tile), read asynchronously */
  readLayerTiles(layer: Layer) { return this.pool.readTiles(layer); }
  /** full layer pixels (premultiplied RGBA, GL row order) without stalling the pipeline */
  readLayerAsync(layer: Layer): Promise<Uint8Array> {
    return new Readback(this.gl, this.pool.readable(layer).fb, 0, 0, this.w, this.h).wait();
  }

  /** replace the whole document (no undo history) */
  loadDocument(w: number, h: number, bg: [number, number, number], bgVisible: boolean,
    layers: { props: LayerProps; data?: Uint8Array | null; tiles?: Map<number, Uint8Array> | null; image?: ImageBitmap; x?: number; y?: number }[], active: number) {
    this.newDocument(w, h, bg);
    const gl = this.gl;
    this.pool.releaseLayer(this.layers[0]);
    this.layers = layers.map(({ props, data, image, tiles, x = 0, y = 0 }) => {
      if (tiles || props.group || (data && data.byteLength === w * h * 4)) {
        // straight into atlas tiles: opening a long animation never needs a full texture per frame
        const l = new Layer(props.name);
        if (tiles) for (const [i, d] of tiles) this.pool.writeTile(l, i, d);
        else if (data) this.writeTilesFromFull(l, data);
        l.tilesVersion = l.version;
        Object.assign(l, { uid: props.uid || l.uid, visible: props.visible, opacity: props.opacity, blend: props.blend, alphaLock: props.alphaLock, clip: props.clip });
        return l;
      }
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
    if (!this.layers.length) this.layers = [new Layer('Layer 1')];
    // groups: flags and membership by uid
    const byUid = new Map(this.layers.map((l) => [l.uid, l]));
    layers.forEach(({ props }, i) => { const l = this.layers[i]; if (!l) return; if (props.text) { l.text = props.text; l.textVersion = l.version; } l.group = !!props.group; l.collapsed = !!props.collapsed; l.parent = (props.parent && byUid.get(props.parent)) || null; });
    for (const l of this.layers) if (l.parent && !l.parent.group) l.parent = null;
    this.bgVisible = bgVisible;
    this.active = Math.max(0, Math.min(this.layers.length - 1, active));
    this.markDirty();
    this.onLayersChanged();
  }

  /**
   * composite preview scaled to fit maxSide, as a 2D canvas (straight alpha). Reuses the live composite
   * (only dirty regions are recomposited) and reads the small result back asynchronously.
   */
  async compositeThumbnail(maxSide = 320, withBg = this.bgVisible): Promise<HTMLCanvasElement> {
    const gl = this.gl;
    const k = Math.min(1, maxSide / Math.max(this.w, this.h));
    const tw = Math.max(1, Math.round(this.w * k)), th = Math.max(1, Math.round(this.h * k));
    let src = this.comp;
    if (withBg === this.bgVisible) { if (this.dirty) { this.composite(this.dirty); this.dirty = null; this.needsPresent = true; } }
    else { this.composite({ x: 0, y: 0, w: this.w, h: this.h }, withBg); this.markDirty(); src = this.comp; }
    const t = makeTarget(gl, tw, th);
    bindTarget(gl, t);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.generateMipmap(gl.TEXTURE_2D); this.mipStale = false;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.pDown.use().tex('uSrc', 0, src.tex).f('uStep', 1 / tw, 1 / th).f('uOver', 0, 0, 0, 0).i('uTaps', 4);
    this.drawQuad();
    const px = await new Readback(gl, t.fb, 0, 0, tw, th).wait();
    freeTarget(gl, t);
    const out = document.createElement('canvas'); out.width = tw; out.height = th;
    const img = new ImageData(tw, th);
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3], f = a ? 255 / a : 0;
      img.data[i] = px[i] * f; img.data[i + 1] = px[i + 1] * f; img.data[i + 2] = px[i + 2] * f; img.data[i + 3] = a;
    }
    out.getContext('2d')!.putImageData(img, 0, 0);
    return out;
  }

  private capT: Target | null = null;
  /**
   * The composite (or a custom draw list, e.g. one animation frame) scaled to ow×oh, as RGBA top row first,
   * read back asynchronously. flatten: composite onto that colour so the result is opaque (video frames);
   * otherwise premultiplied. The live display composite is restored on the next frame when it was replaced.
   */
  captureScaled(ow: number, oh: number, opts: { list?: DrawItem[] | null; withBg?: boolean; flatten?: [number, number, number] | null } = {}): Promise<Uint8Array> {
    const gl = this.gl;
    const withBg = opts.withBg ?? this.bgVisible;
    const custom = opts.list !== undefined || withBg !== this.bgVisible;
    if (custom) {
      const keep = this.drawList;
      if (opts.list !== undefined) this.drawList = opts.list;
      this.composite({ x: 0, y: 0, w: this.w, h: this.h }, withBg);
      this.drawList = keep;
      this.markDirty();
    } else if (this.dirty) { this.composite(this.dirty); this.dirty = null; this.needsPresent = true; }
    const flat = opts.flatten;
    if (ow === this.w && oh === this.h && !flat) return new Readback(gl, this.comp.fb, 0, 0, ow, oh).wait();
    if (!this.capT || this.capT.w !== ow || this.capT.h !== oh) { if (this.capT) freeTarget(gl, this.capT); this.capT = makeTarget(gl, ow, oh); }
    bindTarget(gl, this.capT);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, this.comp.tex);
    // down to 1/2 scale four bilinear taps are an exact box filter (cheap enough to run on every step);
    // below that, mips + the 4×4 grid
    const small = ow * 2 < this.w || oh * 2 < this.h;
    if (small) { if (this.mipStale) { gl.generateMipmap(gl.TEXTURE_2D); this.mipStale = false; } gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    this.pDown.use().tex('uSrc', 0, this.comp.tex).f('uStep', 1 / ow, 1 / oh).f('uOver', flat ? flat[0] : 0, flat ? flat[1] : 0, flat ? flat[2] : 0, flat ? 1 : 0).i('uTaps', small ? 4 : 2);
    this.drawQuad();
    return new Readback(gl, this.capT.fb, 0, 0, ow, oh).wait();
  }
  /** the background colour (or white when hidden), for flattening video frames */
  get flattenColour(): [number, number, number] { return this.bgVisible ? this.bg : [1, 1, 1]; }

  /** full composite, premultiplied RGBA (top row first), read back asynchronously */
  async compositePixelsAsync(withBg = this.bgVisible): Promise<Uint8Array> {
    if (withBg === this.bgVisible) { if (this.dirty) { this.composite(this.dirty); this.dirty = null; this.needsPresent = true; } }
    else this.composite({ x: 0, y: 0, w: this.w, h: this.h }, withBg);
    const p = new Readback(this.gl, this.comp.fb, 0, 0, this.w, this.h).wait();
    if (withBg !== this.bgVisible) this.markDirty(); // restore the display composite on the next frame
    return p;
  }

  // ---------------------------------------------------------------- transform support
  /** premultiplied, mipmapped copy of a straight-alpha image, to be placed with renderTransformed */
  sourceFromImage(img: TexImageSource & { width: number; height: number }): Target {
    const gl = this.gl;
    const raw = textureFromCanvas(gl, img, false, false);
    const t = makeTarget(gl, img.width, img.height);
    bindTarget(gl, t); gl.disable(gl.BLEND);
    this.pPremul.use().tex('uSrc', 0, raw).f('uRect', 0, 0, 1, 1);
    this.drawQuad();
    gl.deleteTexture(raw);
    this.mipify(t);
    return t;
  }
  /** copy of a rect of a layer as a mipmapped source */
  sourceFromLayer(layer: Layer, r: Rect = { x: 0, y: 0, w: this.w, h: this.h }): Target {
    const gl = this.gl, t = makeTarget(gl, r.w, r.h);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.target.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fb);
    gl.blitFramebuffer(r.x, r.y, r.x + r.w, r.y + r.h, 0, 0, r.w, r.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.mipify(t);
    return t;
  }
  private mipify(t: Target) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }
  /**
   * Clear dst and draw src through m = [a, b, c, d, e, f] (doc = [a c e; b d f] * src px).
   * filter: 'sharp' = nearest; 'smooth' = trilinear when shrinking, bicubic when enlarging.
   */
  renderTransformed(dst: Target, src: Target, m: number[], filter: 'smooth' | 'sharp', keep?: Target | null) {
    const gl = this.gl;
    bindTarget(gl, dst);
    gl.disable(gl.BLEND);
    if (keep) { // start from existing pixels (transforming a selection inside a layer)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, keep.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
      gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      bindTarget(gl, dst);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const mode = filter === 'sharp' ? 0 : scale < 0.999 ? 1 : 2;
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mode === 0 ? gl.NEAREST : mode === 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mode === 0 ? gl.NEAREST : gl.LINEAR);
    const grow = 1.5 / Math.max(1e-3, scale);
    this.pXform.use().tex('uSrc', 0, src.tex).m3('uM', [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1])
      .f('uSrcSize', src.w, src.h).f('uDocSize', this.w, this.h).f('uGrow', grow / src.w, grow / src.h).i('uFilter', mode);
    this.drawQuad();
    gl.disable(gl.BLEND);
    this.markDirty();
  }
  private meshVao: WebGLVertexArrayObject | null = null;
  private meshBuf: WebGLBuffer | null = null;
  private meshIdx: WebGLBuffer | null = null;
  private meshN = 0;
  /**
   * Clear dst and draw src through a deformation mesh: verts = (n+1)² × [docX, docY, u, v], row-major.
   * minScale/maxScale: local magnification range, used to choose the filter.
   */
  renderMesh(dst: Target, src: Target, verts: Float32Array, n: number, filter: 'smooth' | 'sharp', minScale: number, keep?: Target | null) {
    const gl = this.gl;
    if (!this.meshVao) {
      this.meshVao = gl.createVertexArray()!; this.meshBuf = gl.createBuffer()!; this.meshIdx = gl.createBuffer()!;
      gl.bindVertexArray(this.meshVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuf);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIdx);
      gl.bindVertexArray(null);
    }
    gl.bindVertexArray(this.meshVao);
    if (this.meshN !== n) {
      const idx = new Uint16Array(n * n * 6); let k = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        idx.set([a, b, c, b, d, c], k); k += 6;
      }
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      this.meshN = n;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    bindTarget(gl, dst);
    gl.disable(gl.BLEND);
    if (keep) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, keep.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
      gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      bindTarget(gl, dst);
    } else { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    // overlapping folds of a warp would double-cover: draw with premultiplied "over" so they stack like paper
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const mode = filter === 'sharp' ? 0 : minScale < 0.999 ? 1 : 2;
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mode === 0 ? gl.NEAREST : mode === 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mode === 0 ? gl.NEAREST : gl.LINEAR);
    this.pMesh.use().tex('uSrc', 0, src.tex).f('uSrcSize', src.w, src.h).f('uDocSize', this.w, this.h).i('uFilter', mode);
    gl.drawElements(gl.TRIANGLES, n * n * 6, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this.markDirty();
  }

  /** add a layer above the active one without recording history (a pending transform) */
  addLayerRaw(name: string): Layer | null {
    if (this.layers.length >= this.maxLayersFor(this.w, this.h)) return null;
    const l = new Layer(name);
    l.parent = this.activeLayer?.parent ?? null;
    this.layers.splice(this.active + 1, 0, l); this.active++;
    this.changed();
    return l;
  }
  removeLayerRaw(layer: Layer) {
    const i = this.layers.indexOf(layer); if (i < 0) return;
    this.layers.splice(i, 1); this.pool.releaseLayer(layer);
    this.active = Math.max(0, Math.min(this.active, this.layers.length - 1)); this.changed();
  }
  /** record a layer that is already in the stack as an undoable insertion */
  recordInsert(layer: Layer, label: string) {
    const index = this.layers.indexOf(layer), prevActive = Math.max(0, index - 1);
    const doIt = () => { this.layers.splice(index, 0, layer); this.active = index; this.changed(); };
    this.history.push({
      label, bytes: this.bytesPerLayer(),
      undo: () => { this.layers.splice(this.layers.indexOf(layer), 1); this.active = Math.min(prevActive, this.layers.length - 1); this.changed(); },
      redo: doIt,
      dispose: (done) => { if (!done) this.pool.releaseLayer(layer); },
    });
  }
  /** record that a layer's pixels changed from `before` (a full-layer stash) to what it holds now */
  recordReplace(layer: Layer, before: Stash, label: string) {
    let held = before;
    layer.version++;
    const swap = () => {
      const cur = new Stash(this.gl, layer.target, this.stashes);
      layer.target = held.take();
      held = cur;
      layer.version++; this.changed();
    };
    this.history.push({ label, bytes: this.bytesPerLayer(), undo: swap, redo: swap, dispose: () => held.dispose() });
    this.changed();
  }
  stashLayer(layer: Layer): Stash { return this.stashRect(layer.target, { x: 0, y: 0, w: this.w, h: this.h }); }
  freeSource(t: Target) { freeTarget(this.gl, t); }

  // ---------------------------------------------------------------- helpers for filter modules (adjust.ts)
  quad() { this.drawQuad(); }
  /** replace a layer's pixels with a straight-alpha canvas placed at doc (x, y) (no history; null = clear) */
  drawCanvasToLayer(l: Layer, c: OffscreenCanvas | HTMLCanvasElement | null, x: number, y: number) {
    const gl = this.gl, t = this.newTarget();
    if (c) {
      const src = textureFromCanvas(gl, c as unknown as TexImageSource, false, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      bindTarget(gl, t); gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
      this.pPremul.use().tex('uSrc', 0, src).f('uRect', x / this.w, y / this.h, c.width / this.w, c.height / this.h);
      this.drawQuad();
      gl.deleteTexture(src);
    }
    const old = l.res;
    l.target = t;
    if (old && old !== t) freeTarget(gl, old);
    this.layerChanged(l);
  }
  /** put a full-layer stash back (cancelled edits); consumes the stash */
  restoreStash(l: Layer, st: Stash) { st.writeTo(l.target, 0, 0); st.dispose(); this.layerChanged(l); }
  program(fs: string, vs = S.QUAD_VS): Program {
    const p = new Program(this.gl, vs, fs);
    this.gl.bindAttribLocation(p.prog, 0, 'aPos'); this.gl.linkProgram(p.prog);
    return p;
  }
  copyOfLayer(l: Layer): Target { return this.copyTarget(l.target); }
  newStash(t: Target): Stash { return new Stash(this.gl, t, this.stashes); }
  layerChanged(l: Layer) { l.version++; this.markDirty(); }
  /** debugging/testing helper: average alpha of a layer region */
  layerPixels(layer: Layer, r: Rect) { return this.readRect(layer.target, r); }
  // keep makeTexture referenced for tree-shaking stability
  static _mt = makeTexture;
}
export type { Entry };

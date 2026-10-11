// Sparse tiled layer storage.
//
// Every layer's pixels live as 256×256 tiles in shared atlas pages (2048² RGBA8 = 64 slots, 16 MB each). A tile
// exists only where the layer has ever been painted and is not empty, so a blank layer or an animation frame
// with one small drawing costs a handful of tiles instead of a whole canvas. Layers that are being edited are
// made "resident": a full-size working texture that every existing GPU op (bake, smudge, selection ops,
// transforms, merges, undo stashes) can use unchanged. The compositor reads resident layers directly and
// everything else straight from the atlas (one scissored draw per tile), so showing 200 animation frames or
// onion skins never materialises them. When a resident layer has not been used for a while it is evicted: a
// GPU reduction finds which tiles hold anything (read back asynchronously, never stalling), those tiles are
// copied into the atlas, empty ones are freed, and the full texture is released.
import { GL, Program, Target, makeTarget, freeTarget, bindTarget, Readback } from './gl';

export const TILE = 256;

export interface TileRef { page: number; slot: number; }

/** what the pool needs to know about a layer (implemented by engine.Layer) */
export interface TiledLayer {
  res: Target | null;
  tiles: Map<number, TileRef>;
  /** layer.version at the time the tiles were last brought in sync with the resident texture (-1 = never) */
  tilesVersion: number;
  version: number;
  lastUse: number;
}

const REDUCE_VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos*2.0-1.0, 0.0, 1.0); }`;
// max |rgba| over a 16×16 block of the source (bounds-checked), written to r
const REDUCE_FS = `#version 300 es
precision highp float; out vec4 o;
uniform sampler2D uSrc; uniform ivec2 uSize;
void main(){
  ivec2 b = ivec2(gl_FragCoord.xy) * 16;
  float m = 0.0;
  for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) {
    ivec2 p = b + ivec2(x, y);
    if (p.x < uSize.x && p.y < uSize.y) { vec4 c = texelFetch(uSrc, p, 0); m = max(m, max(max(c.r, c.g), max(c.b, c.a))); }
  }
  o = vec4(m);
}`;

interface PendingEvict { layer: TiledLayer; version: number; rb: Readback; tx: number; ty: number; }

export class TilePool {
  readonly page: number;
  readonly perRow: number;
  readonly perPage: number;
  pages: (Target | null)[] = [];
  private free: number[][] = [];        // per page: free slot numbers
  private resident = new Set<TiledLayer>();
  private pending = new Map<TiledLayer, PendingEvict>();
  private reduce: Program;
  private r1: Target | null = null; private r2: Target | null = null;
  private scratch: Target | null = null;
  frame = 0;
  /** keep a layer resident this many maintain() calls after its last use */
  idleFrames = 45;
  /** most layers allowed resident at once (beyond it the least recently used are evicted first) */
  maxResident = 3;
  stats = { materialised: 0, evicted: 0, fastEvicted: 0, tilesWritten: 0 };

  constructor(private gl: GL, private quad: () => void, private size: () => { w: number; h: number }) {
    this.page = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.perRow = Math.floor(this.page / TILE);
    this.perPage = this.perRow * this.perRow;
    this.reduce = new Program(gl, REDUCE_VS, REDUCE_FS);
    gl.bindAttribLocation(this.reduce.prog, 0, 'aPos'); gl.linkProgram(this.reduce.prog);
  }

  get tilesX() { return Math.ceil(this.size().w / TILE); }
  get tilesY() { return Math.ceil(this.size().h / TILE); }
  /** doc-space rect of tile i (clipped to the document) */
  tileRect(i: number) {
    const { w, h } = this.size(), tx = i % this.tilesX, ty = Math.floor(i / this.tilesX);
    const x = tx * TILE, y = ty * TILE;
    return { x, y, w: Math.min(TILE, w - x), h: Math.min(TILE, h - y) };
  }
  slotXY(ref: TileRef) { return { x: (ref.slot % this.perRow) * TILE, y: Math.floor(ref.slot / this.perRow) * TILE }; }

  // ------------------------------------------------------------------ slots
  alloc(): TileRef {
    for (let p = 0; p < this.pages.length; p++) {
      const f = this.free[p];
      if (this.pages[p] && f.length) return { page: p, slot: f.pop()! };
    }
    let p = this.pages.indexOf(null);
    if (p < 0) { p = this.pages.length; this.pages.push(null); this.free.push([]); }
    this.pages[p] = makeTarget(this.gl, this.page, this.page, { filter: this.gl.NEAREST });
    this.free[p] = [];
    for (let s = this.perPage - 1; s >= 1; s--) this.free[p].push(s);
    return { page: p, slot: 0 };
  }
  release(ref: TileRef) {
    const f = this.free[ref.page];
    f.push(ref.slot);
    if (f.length === this.perPage && this.pages[ref.page]) {   // page empty: give the memory back
      freeTarget(this.gl, this.pages[ref.page]!); this.pages[ref.page] = null; this.free[ref.page] = [];
    }
  }
  pageTex(ref: TileRef) { return this.pages[ref.page]!.tex; }
  get tileCount() { let n = 0; for (let p = 0; p < this.pages.length; p++) if (this.pages[p]) n += this.perPage - this.free[p].length; return n; }

  /** GPU bytes held by layer pixels: atlas pages plus resident full textures */
  get bytes() {
    const { w, h } = this.size();
    return this.pages.filter(Boolean).length * this.page * this.page * 4 + this.resident.size * w * h * 4;
  }
  get atlasBytes() { return this.pages.filter(Boolean).length * this.page * this.page * 4; }
  get residentCount() { return this.resident.size; }

  // ------------------------------------------------------------------ residency
  dropTiles(l: TiledLayer) { for (const r of l.tiles.values()) this.release(r); l.tiles.clear(); l.tilesVersion = -1; }

  /** full-size texture for a layer, creating it from the tiles if needed */
  materialise(l: TiledLayer): Target {
    l.lastUse = this.frame;
    if (l.res) return l.res;
    this.cancelEvict(l);
    const gl = this.gl, { w, h } = this.size();
    // callers fetch layer.target in the middle of setting up a draw: leave every binding as it was
    const st = this.saveState();
    this.relievePressure();
    const t = makeTarget(gl, w, h);
    this.copyTilesInto(l, t);
    this.restoreState(st);
    l.res = t;
    l.tilesVersion = l.version;
    this.resident.add(l);
    this.stats.materialised++;
    return t;
  }
  /** adopt a texture as the layer's pixels (the previous resident texture now belongs to the caller) */
  adopt(l: TiledLayer, t: Target) {
    this.cancelEvict(l);
    if (l.res === t) return;
    this.dropTiles(l);
    l.res = t; l.lastUse = this.frame;
    this.resident.add(l);
  }
  /** forget a layer for good: free its texture and tiles */
  releaseLayer(l: TiledLayer) {
    this.cancelEvict(l);
    if (l.res) { freeTarget(this.gl, l.res); l.res = null; }
    this.resident.delete(l);
    this.dropTiles(l);
  }
  private cancelEvict(l: TiledLayer) { const p = this.pending.get(l); if (p) { p.rb.dispose(); this.pending.delete(l); } }

  private saveState() {
    const gl = this.gl;
    return {
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      vp: gl.getParameter(gl.VIEWPORT) as Int32Array, sc: gl.isEnabled(gl.SCISSOR_TEST), tex: gl.getParameter(gl.TEXTURE_BINDING_2D),
      cc: gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array,
    };
  }
  private restoreState(s: ReturnType<TilePool['saveState']>) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, s.draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.read);
    gl.viewport(s.vp[0], s.vp[1], s.vp[2], s.vp[3]);
    if (s.sc) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.clearColor(s.cc[0], s.cc[1], s.cc[2], s.cc[3]);
  }
  private copyTilesInto(l: TiledLayer, t: Target) {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fb);
    for (const [i, ref] of l.tiles) {
      const r = this.tileRect(i), s = this.slotXY(ref);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.pages[ref.page]!.fb);
      gl.blitFramebuffer(s.x, s.y, s.x + r.w, s.y + r.h, r.x, r.y, r.x + r.w, r.y + r.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
  }

  /**
   * A readable full-size texture of the layer without making it resident: its own texture when resident,
   * otherwise a shared scratch texture filled from the tiles (valid until the next call).
   */
  private scratchUse = 0;
  readable(l: TiledLayer): Target {
    if (l.res) return l.res;
    this.scratchUse = this.frame;
    const { w, h } = this.size();
    if (!this.scratch || this.scratch.w !== w || this.scratch.h !== h) {
      if (this.scratch) freeTarget(this.gl, this.scratch);
      this.scratch = makeTarget(this.gl, w, h);
    }
    const gl = this.gl, st = this.saveState();
    bindTarget(gl, this.scratch); gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    this.copyTilesInto(l, this.scratch);
    this.restoreState(st);
    return this.scratch;
  }

  /**
   * Hard cap: when a burst of operations has made many layers resident before the idle-time evictions could
   * run, evict the least recently used ones right now (a tiny synchronous readback — only under pressure).
   */
  private relievePressure() {
    if (this.resident.size < this.maxResident * 2) return;
    const lru = [...this.resident].filter((x) => x.lastUse < this.frame).sort((a, b) => a.lastUse - b.lastUse);
    for (const x of lru) {
      if (this.resident.size < this.maxResident * 2) break;
      if (!this.evict(x)) continue;
      const e = this.pending.get(x);
      if (!e) continue; // fast path already freed it
      const gl = this.gl, px = new Uint8Array(e.tx * e.ty * 4);
      e.rb.dispose(); this.pending.delete(x);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.r2!.fb);
      gl.readPixels(0, 0, e.tx, e.ty, gl.RGBA, gl.UNSIGNED_BYTE, px);
      this.finishEvict(e, px);
    }
  }

  /** start evicting a resident layer (async). Returns false when it is not resident. */
  evict(l: TiledLayer): boolean {
    if (!l.res || this.pending.has(l)) return false;
    if (l.tilesVersion === l.version) {          // tiles already hold exactly these pixels
      freeTarget(this.gl, l.res); l.res = null; this.resident.delete(l);
      this.stats.evicted++; this.stats.fastEvicted++;
      return true;
    }
    const gl = this.gl, { w, h } = this.size();
    const tx = this.tilesX, ty = this.tilesY;
    const bw = Math.ceil(w / 16), bh = Math.ceil(h / 16);
    if (!this.r1 || this.r1.w !== bw || this.r1.h !== bh) { if (this.r1) freeTarget(gl, this.r1); this.r1 = makeTarget(gl, bw, bh, { filter: gl.NEAREST }); }
    if (!this.r2 || this.r2.w !== tx || this.r2.h !== ty) { if (this.r2) freeTarget(gl, this.r2); this.r2 = makeTarget(gl, tx, ty, { filter: gl.NEAREST }); }
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    const p = this.reduce.use();
    bindTarget(gl, this.r1); p.tex('uSrc', 0, l.res.tex).i2('uSize', w, h); this.quad();
    bindTarget(gl, this.r2); p.tex('uSrc', 0, this.r1.tex).i2('uSize', bw, bh); this.quad();
    this.pending.set(l, { layer: l, version: l.version, rb: new Readback(gl, this.r2.fb, 0, 0, tx, ty), tx, ty });
    return true;
  }

  private finishEvict(e: PendingEvict, data: Uint8Array) {
    const l = e.layer, gl = this.gl;
    if (!l.res || l.version !== e.version || e.tx !== this.tilesX) return; // changed meanwhile: try again later
    const n = e.tx * e.ty;
    gl.disable(gl.SCISSOR_TEST);
    for (let i = 0; i < n; i++) {
      const used = data[i * 4] > 0;
      let ref = l.tiles.get(i);
      if (!used) { if (ref) { this.release(ref); l.tiles.delete(i); } continue; }
      if (!ref) { ref = this.alloc(); l.tiles.set(i, ref); }
      const r = this.tileRect(i), s = this.slotXY(ref);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, l.res.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.pages[ref.page]!.fb);
      gl.blitFramebuffer(r.x, r.y, r.x + r.w, r.y + r.h, s.x, s.y, s.x + r.w, s.y + r.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      this.stats.tilesWritten++;
    }
    freeTarget(gl, l.res); l.res = null; l.tilesVersion = l.version;
    this.resident.delete(l);
    this.stats.evicted++;
  }

  /**
   * Called once per idle frame. Finishes evictions whose reduction has arrived and starts new ones for layers
   * unused for idleFrames (or the least recently used beyond maxResident). keep: layers that must stay.
   */
  maintain(keep: Set<TiledLayer>) {
    this.frame++;
    // the read-only scratch copy is a full canvas of memory: give it back when thumbnails/exports are done
    if (this.scratch && this.frame - this.scratchUse > this.idleFrames * 4) { freeTarget(this.gl, this.scratch); this.scratch = null; }
    for (const [l, e] of this.pending) {
      if (keep.has(l)) { this.cancelEvict(l); continue; }
      if (e.rb.poll()) { this.pending.delete(l); this.finishEvict(e, e.rb.data!); }
    }
    const cands = [...this.resident].filter((l) => !keep.has(l) && !this.pending.has(l)).sort((a, b) => a.lastUse - b.lastUse);
    let over = this.resident.size - this.maxResident;
    for (const l of cands) {
      if (over > 0 || this.frame - l.lastUse > this.idleFrames) { this.evict(l); over--; }
    }
  }
  /** evict everything not kept, synchronously waiting for the reductions (tests, memory pressure) */
  async flushAll(keep: Set<TiledLayer> = new Set()) {
    for (const l of [...this.resident]) if (!keep.has(l)) this.evict(l);
    while (this.pending.size) {
      for (const [l, e] of this.pending) if (e.rb.poll()) { this.pending.delete(l); this.finishEvict(e, e.rb.data!); }
      if (this.pending.size) await new Promise((r) => setTimeout(r, 4));
    }
    for (const l of [...this.resident]) if (!keep.has(l) && l.tilesVersion === l.version) this.evict(l);
  }

  // ------------------------------------------------------------------ direct tile I/O (persistence)
  /** upload one tile's pixels (premultiplied RGBA, tile-local rows, r.w×r.h) into a layer's tile i */
  writeTile(l: TiledLayer, i: number, data: Uint8Array) {
    const gl = this.gl, r = this.tileRect(i);
    let ref = l.tiles.get(i);
    if (!ref) { ref = this.alloc(); l.tiles.set(i, ref); }
    const s = this.slotXY(ref);
    gl.bindTexture(gl.TEXTURE_2D, this.pages[ref.page]!.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, s.x, s.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }
  /**
   * Read a layer as non-empty tiles (index → premultiplied RGBA of the tile's clipped size). Resident layers
   * are read in one async readback and split; tiled layers read only their tiles.
   */
  async readTiles(l: TiledLayer): Promise<Map<number, Uint8Array>> {
    const out = new Map<number, Uint8Array>();
    const gl = this.gl, { w } = this.size();
    if (l.res) {
      const { h } = this.size();
      const px = await new Readback(gl, l.res.fb, 0, 0, w, h).wait();
      const n = this.tilesX * this.tilesY;
      for (let i = 0; i < n; i++) {
        const r = this.tileRect(i);
        let any = false;
        for (let y = 0; y < r.h && !any; y++) {
          const row = new Uint32Array(px.buffer, ((r.y + y) * w + r.x) * 4, r.w);
          for (let x = 0; x < r.w; x++) if (row[x]) { any = true; break; }
        }
        if (!any) continue;
        const t = new Uint8Array(r.w * r.h * 4);
        for (let y = 0; y < r.h; y++) t.set(px.subarray(((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4), y * r.w * 4);
        out.set(i, t);
      }
      return out;
    }
    const jobs = [...l.tiles].map(([i, ref]) => {
      const r = this.tileRect(i), s = this.slotXY(ref);
      return { i, p: new Readback(gl, this.pages[ref.page]!.fb, s.x, s.y, r.w, r.h).wait() };
    });
    for (const j of jobs) {
      const d = await j.p;
      const u = new Uint32Array(d.buffer);
      let any = false;
      for (let k = 0; k < u.length; k++) if (u[k]) { any = true; break; }
      if (any) out.set(j.i, d);
    }
    return out;
  }

  dispose() {
    for (const p of this.pages) if (p) freeTarget(this.gl, p);
    this.pages = []; this.free = [];
    for (const l of this.resident) if (l.res) { freeTarget(this.gl, l.res); l.res = null; }
    this.resident.clear();
    for (const e of this.pending.values()) e.rb.dispose();
    this.pending.clear();
  }
}


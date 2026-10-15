import { Engine, Tool, BLEND_MODES, Layer } from './engine';
import { brushFile, parseBrushFile, addCustomBrushes, BRUSHES, Brush, SHAPES, GRAINS, makeShape, ShapeId } from './brushes';
import { StrokeBuilder, Sample, PressureCurve } from './stroke';
import { Input, StylusMode } from './input';
import { pressureSection } from './pressureui';
import { store, newDocId, DocMeta } from './store';
import { Autosave, loadDocPixels } from './autosave';
import { AdjustUI } from './adjustui';
import { openStylusTest } from './stylustest';
import { TextTool } from './texttool';
import { ReferenceWindow } from './reference';
import { Gallery, ask } from './gallery';
import { $, h } from './dom';
import { dragSort, DRAG_STATS } from './dragsort';
import { TimelapseRecorder, TimelapseView, loadClip, exportClip, selectFrames } from './timelapse';
import { Animator, AnimState } from './animation';
import { exportSheet, exportAnimation } from './animexport';
import { GifSession, buildPalette } from './gif';
import { readGesso, writeGesso } from './gessofile';
import { pngEncode } from './workerclient';
import { ShapeTool } from './shapetool';
import { TransformTool, homography } from './transformtool';
import { SelectTool, SelKind } from './selecttool';
import type { Target } from './gl';
import { Symmetry, SymMode, defaultSymmetry, expandDabs, drawGuide, guideHandles } from './symmetry';
import { FillTool, FillSettings, FillRef, defaultFill } from './filltool';
import { Guides, GuideKind, GUIDE_LABEL, defaultGuides, GuideAssist, GuideHandle, guideHandleAt, dragGuideHandle, drawGuides, rulerAngle } from './guides';
import type { Shape } from './quickshape';
import { dabsAlong } from './stroke';
import type { Dab } from './engine';
import { RGB, HSV, hsvToRgb, rgbToHsv, toHex, fromHex } from './color';

// ------------------------------------------------------------------ helpers
const svg = (d: string, extra = '') => {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  return t.content.firstChild as SVGElement;
};
const ICON = {
  brush: '<path d="M14.5 4.5l5 5-7.5 7.5-5-5z"/><path d="M7 12c-2 .2-3.5 1.6-3.6 3.6-.1 1.4-.6 2.6-1.4 3.4 3 .5 6.2-.4 7.4-2.4"/>',
  smudge: '<path d="M8 20c-2.2-1.2-3-3.4-3-5.5V9a1.5 1.5 0 013 0v3"/><path d="M8 11V5a1.5 1.5 0 013 0v6"/><path d="M11 10V6.5a1.5 1.5 0 013 0V11"/><path d="M14 10.5a1.5 1.5 0 013 0V15c0 3-2 5.5-5.5 5.5"/>',
  eraser: '<path d="M4 15.5l9-9a2 2 0 012.8 0l3.7 3.7a2 2 0 010 2.8L12 20.5H8.5z"/><path d="M9 10.5l6 6"/><path d="M12 20.5h8"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 16.5l9 5 9-5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
  drop: '<path d="M13.5 6.5l4 4"/><path d="M15.5 4.5a2.1 2.1 0 013 3l-2 2-3-3z"/><path d="M14.5 8.5L6 17v3h3l8.5-8.5"/>',
  menu: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7 15.5l3.5-4 2.5 3 2-2 2.5 3"/><circle cx="9" cy="9" r="1.2"/>',
  share: '<path d="M12 3v12"/><path d="M7.5 7.5L12 3l4.5 4.5"/><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A9.9 9.9 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 01-2.8 3.6M6.5 7.2C4 8.9 2.5 12 2.5 12S6 18.5 12 18.5a9.6 9.6 0 004.4-1"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  clip: '<path d="M9 7l-4 5 4 5"/><path d="M5 12h9a5 5 0 005-5V4"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  merge: '<path d="M7 4v5a5 5 0 005 5 5 5 0 005-5V4"/><path d="M12 14v6M9 17l3 3 3-3"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  folder: '<path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>',
  folderPlus: '<path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/><path d="M12 10.5v6M9 13.5h6"/>',
  chevDown: '<path d="M7 10l5 5 5-5"/>', chevRight: '<path d="M10 7l5 5-5 5"/>',
  ungroup: '<path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z" stroke-dasharray="2.5 2"/>',
  flatten: '<path d="M4 9l8-4 8 4-8 4z"/><path d="M4 15h16"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  fill: '<path d="M5 12l7-7 7 7-7 7z"/><path d="M19.5 15.5s1.5 2 1.5 3a1.5 1.5 0 01-3 0c0-1 1.5-3 1.5-3z"/>',
  clear: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8l8 8M16 8l-8 8"/>',
  gallery: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  select: '<path d="M4 8V5.5A1.5 1.5 0 015.5 4H8M12 4h2M18 4h.5A1.5 1.5 0 0120 5.5V8M20 12v2M20 18v.5a1.5 1.5 0 01-1.5 1.5H16M12 20h-2M6 20h-.5A1.5 1.5 0 014 18.5V16M4 12v-2"/>',
  transform: '<path d="M12 3v18M3 12h18"/><path d="M9.5 5.5L12 3l2.5 2.5M9.5 18.5L12 21l2.5-2.5M5.5 9.5L3 12l2.5 2.5M18.5 9.5L21 12l-2.5 2.5"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/>',
  guide: '<path d="M3 21L21 3"/><path d="M3 9h6M3 15h12M9 3v6M15 3v12" stroke-dasharray="2 2.2"/><path d="M14 21h7v-7"/>',
  symmetry: '<path d="M12 3v18" stroke-dasharray="2 2.2"/><path d="M9 6.5C5.5 7.5 4 10 4 12.5S6 18 9 17.5z"/><path d="M15 6.5c3.5 1 5 3.5 5 6s-2 5.5-5 5z"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
  adjust: '<path d="M4 20l10-10"/><path d="M15.5 4.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/><path d="M19.5 11l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z"/><path d="M14 10l-2-2"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
};

// ------------------------------------------------------------------ persisted state
interface Settings { stylus: StylusMode; curve: [number, number, number, number]; leftRail: boolean; snapShapes: boolean; snapDelay: number; selKind?: string; predict: boolean; wetMedia: boolean; harmony?: string; }
interface State {
  toolBrush: Record<Tool, string>;
  color: RGB; recent: string[];
  settings: Settings;
  overrides: Record<string, Partial<Brush>>;
}
const DEFAULT_STATE: State = {
  toolBrush: { brush: 'ink-studio', eraser: 'air-hard', smudge: 'smudge-soft' },
  color: [0.12, 0.11, 0.1], recent: [],
  settings: { stylus: 'auto', curve: [0.25, 0.25, 0.75, 0.75], leftRail: true, snapShapes: true, snapDelay: 500, predict: true, wetMedia: true },
  overrides: {},
};
/** colour harmony modes: hue offsets (turns) of the partners */
const HARMONY: Record<string, number[]> = { off: [], comp: [0.5], analog: [-1 / 12 + 1, 1 / 12], triad: [1 / 3, 2 / 3], split: [5 / 12, 7 / 12], tetrad: [0.25, 0.5, 0.75], shades: [] };
const HARMONY_LABEL: Record<string, string> = { off: 'Off', comp: 'Complementary', analog: 'Analogous', triad: 'Triadic', split: 'Split', tetrad: 'Tetradic', shades: 'Shades' };
const prefs = {
  load(): State {
    try { const s = JSON.parse(localStorage.getItem('gesso.v1') || '{}'); return { ...DEFAULT_STATE, ...s, settings: { ...DEFAULT_STATE.settings, ...(s.settings || {}) }, toolBrush: { ...DEFAULT_STATE.toolBrush, ...(s.toolBrush || {}) } }; }
    catch { return structuredClone(DEFAULT_STATE); }
  },
  timer: 0 as number,
  save(s: State) {
    // debounced: sliders call this on every move
    clearTimeout(prefs.timer);
    prefs.timer = window.setTimeout(() => { try { localStorage.setItem('gesso.v1', JSON.stringify(s)); } catch { /* quota */ } }, 250);
  },
};

const PALETTE = ['#1d1b19', '#4a4038', '#8c7b6b', '#d9cbb8', '#f6f0e6', '#ffffff',
  '#7a1f1f', '#c0392b', '#e8734a', '#f2a65a', '#f5d06f', '#a8b545',
  '#4f7c3a', '#2f6b5f', '#3c8dad', '#28477a', '#5b3f8c', '#b5578f'];

// ------------------------------------------------------------------ app
class App {
  engine: Engine;
  input: Input;
  state = prefs.load();
  tool: Tool = 'brush';
  builder: StrokeBuilder | null = null;
  curve = new PressureCurve();
  strokeTool: Tool = 'brush';
  eyedropOnce = false;
  pop: HTMLElement | null = null;
  popKind = '';
  thumbVersions = new Map<number, number>();
  thumbTimer = 0;
  loupe: HTMLElement;
  canvas: HTMLCanvasElement;
  installEvt: any = null;
  autosave: Autosave;
  gallery: Gallery | null = null;
  ov: HTMLCanvasElement;
  ovDirty = true;
  shapes: ShapeTool;
  /** an on-canvas handle grabbed by the current pointer */
  capture: { kind: 'shape'; i: number } | { kind: 'symC' | 'symR' } | { kind: 'guide'; h: GuideHandle; prev: { x: number; y: number } } | null = null;
  sym: Symmetry = defaultSymmetry(1, 1);
  symBar: HTMLElement | null = null;
  /** drawing guides (grid / isometric / perspective / ruler) and the current stroke's assist */
  guides: Guides = defaultGuides(1, 1);
  guideBar: HTMLElement | null = null;
  assist: GuideAssist | null = null;
  /** fill / gradient / recolour tool (also serves ColorDrop from the colour button) */
  fill!: FillTool;
  fillBar: HTMLElement | null = null;
  fillOn = false;
  fillSet: FillSettings = { ...defaultFill(), ...(JSON.parse(localStorage.getItem('gesso.fill') || '{}') as Partial<FillSettings>) };
  /** uid of the layer marked as the fill reference (per artwork) */
  refUid: string | null = null;
  private assistPending = false;
  xform: TransformTool | null = null;
  selTool: SelectTool | null = null;
  adj!: AdjustUI;
  text!: TextTool;
  ref!: ReferenceWindow;
  selBar: HTMLElement | null = null;
  strokeBrush: Brush | null = null;
  tl: TimelapseRecorder;
  tlView: TimelapseView | null = null;
  anim!: Animator;

  constructor() {
    this.canvas = $('#view') as HTMLCanvasElement;
    try { this.engine = new Engine(this.canvas); }
    catch (err) { this.fatal(String((err as Error).message || err)); throw err; }
    this.input = new Input(this.canvas, this.engine, {
      strokeStart: (s, t, er) => this.strokeStart(s, t, er),
      strokeMove: (s) => this.strokeMove(s),
      strokeEnd: () => this.strokeEnd(),
      strokeCancel: () => { this.engine.cancelStroke(); this.builder = null; this.clearPrediction(); },
      strokePredict: (s) => this.strokePredict(s),
      undo: () => this.undo(), redo: () => this.redo(),
      eyedrop: (x, y, done, sx, sy) => this.eyedrop(x, y, done, sx, sy),
      viewChanged: () => { this.engine.needsPresent = true; this.ovDirty = true; },
      eyedropArmed: () => this.eyedropOnce,
      captureAt: (sx, sy) => this.captureAt(sx, sy),
      secondaryTouch: () => this.shapes.secondary(),
    });
    this.ov = h('canvas', { id: 'ov' }) as HTMLCanvasElement;
    this.canvas.after(this.ov);
    this.shapes = new ShapeTool({
      engine: this.engine,
      dabsFor: (sh) => this.shapeDabs(sh),
      freehandDabs: () => this.expand(this.lastBuilder ? this.lastBuilder.finishedDabs() : []),
      overlayChanged: () => { this.ovDirty = true; },
      committed: () => this.pushRecent(),
    });
    this.shapes.delay = this.state.settings.snapDelay;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { this.settle(); void this.autosave.flush(); void this.tl.flush(); } });
    this.input.stylusMode = this.state.settings.stylus;
    this.curve.set(...this.state.settings.curve);
    this.engine.history.maxSteps = 250;
    this.engine.wetMedia = this.state.settings.wetMedia !== false;
    this.loupe = h('div', { class: 'loupe' });
    document.body.append(this.loupe);
    this.buildUI();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.engine.onLayersChanged = () => { if (this.anim?.on) this.anim.apply(); if (this.popKind === 'layers') this.renderLayers(); this.scheduleThumbs(); };
    this.autosave = new Autosave(this.engine);
    this.autosave.onState = (st) => { $('#bGallery')?.setAttribute('data-save', st); };
    this.autosave.extra = () => this.docExtra();
    this.fill = new FillTool({
      engine: this.engine, settings: () => this.fillSet, colour: () => this.state.color, previous: () => this.previousColour(),
      pixels: (ref: FillRef) => {
        const e = this.engine, rl = this.refUid ? e.layers.find((l) => l.uid === this.refUid && !l.group) : null;
        if (ref === 'layer') return e.readLayerAsync(e.activeLayer);
        if (ref === 'reference' && rl) return e.readLayerAsync(rl);
        return e.compositePixelsAsync(false);
      },
      overlayChanged: () => { this.ovDirty = true; }, toast: (m) => this.toast(m), changed: () => { this.pushRecent(); },
    });
    this.adj = new AdjustUI({ engine: this.engine, input: this.input, toast: (m) => this.toast(m), overlayChanged: () => { this.ovDirty = true; },
      changed: () => { $('#bAdjust')?.classList.toggle('on', this.adj.active); this.updateUndoButtons(); } });
    this.text = new TextTool({ engine: this.engine, input: this.input, toast: (m) => this.toast(m), color: () => [...this.state.color] as [number, number, number],
      changed: () => { $('#bText')?.classList.toggle('on', this.text.active); this.updateUndoButtons(); }, overlayChanged: () => { this.ovDirty = true; } });
    this.ref = new ReferenceWindow({ engine: this.engine, setColor: (c) => this.setColor(c), toast: (m) => this.toast(m) });
    this.autosave.blocked = () => !!this.xform || this.shapes.active || this.adj.active || !!this.text.layer;
    this.anim = new Animator({
      engine: this.engine,
      toast: (m) => this.toast(m),
      changed: () => { this.autosave.touch(); $('#bAnim')?.classList.toggle('on', this.anim.on); },
      openExport: () => this.showAnimExport(),
      layerLimit: () => this.toast('Frame limit reached for this canvas size'),
      layout: () => this.fit(),
    });
    this.tl = new TimelapseRecorder(this.engine);
    this.tl.list = () => this.anim.captureList();
    this.tl.blocked = () => !!this.xform || this.shapes.active || this.adj.active;
    this.autosave.onAttach = (meta, clean) => {
      const x = (meta.extra?.timelapse || {}) as { on?: boolean };
      this.tl.attach(meta.id, x.on !== false);
      if (!clean) this.tl.request(1); // a new or imported artwork: its starting state is frame 0
    };
    this.autosave.onDetach = () => this.tl.detach();
    window.addEventListener('paste', (ev) => {
      const f = [...(ev.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
      if (f) { ev.preventDefault(); void this.placeImage(f, 'Pasted image'); }
    });
    this.engine.history.onChange = () => {
      const hs = this.engine.history;
      if (hs.lastTouched && (hs.canUndo || hs.canRedo)) this.tl.request(hs.lastTouched.bytes <= 64 ? 0.3 : Math.min(1, hs.lastTouched.bytes / (this.engine.w * this.engine.h * 4)));
      this.updateUndoButtons(); this.autosave.touch(); this.selTool?.invalidateWand(); if (this.selBar) this.renderSelBar(); };
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); this.installEvt = e; });
    this.keys();
    const loop = () => { this.engine.render(); if (this.ovDirty) this.drawOverlay(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const q = new URLSearchParams(location.search);
    if (q.get('w') && q.get('h')) this.newCanvas(+q.get('w')!, +q.get('h')!);
    else void this.boot();
  }

  /** open the last artwork, else the gallery, else the new-canvas sheet */
  async boot() {
    try {
      const last = localStorage.getItem('gesso.last');
      if (last && (await this.openDoc(last, true))) return;
      const docs = await store.list();
      if (docs.length) { this.showGallery(); return; }
    } catch (err) { console.info('storage unavailable', err); }
    this.showNewCanvas(true);
  }

  async openDoc(id: string, quiet = false): Promise<boolean> {
    if (this.autosave.docId === id) { this.closeGallery(); return true; }
    const meta = await store.get(id);
    if (!meta) return false;
    if (Math.max(meta.w, meta.h) > this.engine.maxTex) { this.toast(`This canvas (${meta.w}×${meta.h}) is too large for this device`); return false; }
    await this.autosave.flush();
    const layers = await loadDocPixels(meta);
    this.autosave.detach();
    this.engine.loadDocument(meta.w, meta.h, meta.bg, meta.bgVisible, layers, meta.active);
    this.applyDocExtra(meta.extra || {});
    this.autosave.attach(meta, true);
    localStorage.setItem('gesso.last', id);
    this.thumbVersions.clear();
    this.fit();
    this.updateUndoButtons();
    this.closeGallery();
    if (!quiet) this.toast(meta.name);
    return true;
  }

  /** per-document state beyond layers (filled in by later features) */
  docExtra(): Record<string, unknown> { return { fillRef: this.refUid, symmetry: { ...this.sym }, guides: JSON.parse(JSON.stringify(this.guides)), timelapse: { on: this.tl.enabled }, anim: { ...this.anim.st } }; }
  applyDocExtra(x: Record<string, unknown>) {
    this.anim.load(x.anim as Partial<AnimState> | undefined);
    $('#bAnim')?.classList.toggle('on', this.anim.on);
    const s = x.symmetry as Partial<Symmetry> | undefined;
    this.sym = { ...defaultSymmetry(this.engine.w, this.engine.h), ...(s || {}) };
    this.updateSymButton(); if (this.symBar) this.renderSymBar(); this.ovDirty = true;
    this.refUid = typeof x.fillRef === 'string' ? x.fillRef : null;
    const gd = x.guides as Partial<Guides> | undefined;
    this.guides = { ...defaultGuides(this.engine.w, this.engine.h), ...(gd || {}) };
    this.guidesChanged(false);
  }

  showGallery() {
    this.settle();
    this.closePop();
    void this.autosave.flush().then(() => {
      this.closeGallery();
      this.gallery = new Gallery({
        open: (id) => void this.openDoc(id),
        newCanvas: () => this.showNewCanvas(false),
        importFile: () => this.importGessoFile(),
        exportFile: (id) => void this.exportGessoFile(id),
        duplicate: async (id) => { if (this.tl.docId === id) await this.tl.flush(); const m = await store.get(id); if (m) await store.duplicate(id, newDocId(), m.name + ' copy'); },
        remove: async (id) => {
          // stop recording first so no time-lapse pack lands after the delete
          if (this.autosave.docId === id) { this.autosave.detach(); localStorage.removeItem('gesso.last'); await this.tl.idle(); }
          await store.remove(id);
        },
        rename: async (id, name) => {
          if (this.autosave.docId === id && this.autosave.meta) { this.autosave.meta.name = name; await this.autosave.flush(); }
          const m = await store.get(id); if (m) { m.name = name; await store.putMeta(m); }
          if (this.autosave.meta?.id === id) this.autosave.meta.name = name;
        },
        currentId: () => this.autosave.docId,
        close: () => this.closeGallery(),
      });
    });
  }
  closeGallery() { this.gallery?.close(); this.gallery = null; }

  async renameCurrent() {
    const m = this.autosave.meta; if (!m) return;
    const n = await ask('Rename artwork', { input: m.name, okLabel: 'Rename' });
    if (n) { m.name = n; this.autosave.touch(); }
  }

  /** pick a .gesso (or OpenRaster .ora) file and add it to the gallery as a new artwork */
  importGessoFile() {
    const inp = h('input', { type: 'file', accept: '.gesso,.ora,application/zip,application/octet-stream' }) as HTMLInputElement;
    inp.onchange = () => { const f = inp.files?.[0]; if (f) void this.importGessoBlob(f, f.name.replace(/\.(gesso|ora|zip)$/i, '')); };
    inp.click();
  }
  async importGessoBlob(blob: Blob, name: string) {
    this.toast('Opening ' + name + '…');
    try {
      const doc = await readGesso(blob, name);
      if (!doc.w || !doc.h) throw new Error('File has no canvas size');
      if (Math.max(doc.w, doc.h) > this.engine.maxTex) throw new Error(`Canvas ${doc.w}×${doc.h} is larger than this device supports (${this.engine.maxTex}px)`);
      const layers = await Promise.all(doc.layers.map(async (l) => ({
        props: l.props, x: l.offset?.x || 0, y: l.offset?.y || 0,
        image: l.png.byteLength ? await createImageBitmap(new Blob([l.png as unknown as BlobPart], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }) : undefined,
      })));
      await this.autosave.flush();
      this.autosave.detach();
      this.engine.loadDocument(doc.w, doc.h, doc.bg, doc.bgVisible, layers, doc.active);
      layers.forEach((l) => l.image?.close());
      this.applyDocExtra(doc.extra || {});
      const now = Date.now();
      const meta: DocMeta = { id: newDocId(), name: doc.name, w: doc.w, h: doc.h, bg: doc.bg, bgVisible: doc.bgVisible, layers: [], active: doc.active, created: now, modified: now };
      this.autosave.attach(meta, false);
      localStorage.setItem('gesso.last', meta.id);
      await this.autosave.flush();
      this.thumbVersions.clear(); this.fit(); this.updateUndoButtons(); this.closeGallery();
      this.toast('Imported ' + doc.name);
    } catch (err) { this.toast('Could not open file: ' + (err as Error).message); }
  }

  /** build the .gesso file for the open artwork */
  async buildGesso(): Promise<Blob> {
    const e = this.engine;
    // issue every GPU readback first (in GL order), then encode them in the worker as they arrive
    const ls = [...e.layers];
    const reads = ls.map((l) => (l.group ? Promise.resolve(new Uint8Array(0)) : e.readLayerAsync(l)));
    const mergedP = e.compositePixelsAsync(e.bgVisible);
    const thumbP = e.compositeThumbnail(256);
    const layers = await Promise.all(ls.map(async (l, i) => ({ props: l.props(), png: l.group ? new Uint8Array(0) : await pngEncode(await reads[i], e.w, e.h, true) })));
    const merged = await pngEncode(await mergedP, e.w, e.h, true);
    const tc = await thumbP;
    const tpx = tc.getContext('2d')!.getImageData(0, 0, tc.width, tc.height).data;
    const thumb = await pngEncode(new Uint8Array(tpx.buffer), tc.width, tc.height, false);
    return writeGesso({ name: this.autosave.meta?.name || 'Untitled', w: e.w, h: e.h, bg: e.bg, bgVisible: e.bgVisible, active: e.active, layers, merged, thumb, extra: this.docExtra() }, (px, w, h) => pngEncode(px, w, h, false));
  }

  async exportGessoFile(id?: string) {
    if (id && id !== this.autosave.docId && !(await this.openDoc(id, true))) return;
    this.toast('Packing .gesso file…');
    try {
      const blob = await this.buildGesso();
      const base = (this.autosave.meta?.name || 'artwork').replace(/[\\/:*?"<>|]+/g, '').trim() || 'artwork';
      this.download(blob, base + '.gesso', 'application/octet-stream');
    } catch (err) { this.toast('Export failed: ' + (err as Error).message); }
  }

  download(blob: Blob, name: string, type: string) {
    const file = new File([blob], name, { type });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    this.toast('Saved ' + name, nav.canShare?.({ files: [file] }) ? { label: 'Share', fn: () => navigator.share({ files: [file], title: name }).catch(() => {}) } : undefined);
  }


  fatal(msg: string) {
    document.body.append(h('div', { class: 'fatal' }, h('h2', {}, 'Gesso can\'t start'), h('p', {}, msg), h('p', {}, 'Gesso needs WebGL2. In Brave, check Settings → System → "Use graphics acceleration".')));
  }

  // ---------------------------------------------------------------- brushes
  /** download the active brush (with the user's tweaks) as a .gessobrush file */
  exportBrush() {
    const b = this.brushFor(this.tool);
    const blob = new Blob([brushFile([b])], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: b.name.replace(/[^\w -]/g, '').trim().replace(/\s+/g, '-') + '.gessobrush' }) as HTMLAnchorElement;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    this.toast('Exported ' + b.name);
  }
  importBrushes() {
    const inp = h('input', { type: 'file', accept: '.gessobrush,application/json,.json', multiple: true }) as HTMLInputElement;
    inp.onchange = async () => {
      let n = 0;
      for (const f of [...(inp.files || [])]) {
        try { n += addCustomBrushes(parseBrushFile(await f.text())).length; } catch (err) { this.toast(f.name + ': ' + (err as Error).message); }
      }
      if (n) { this.toast(`Imported ${n} brush${n > 1 ? 'es' : ''}`); if (this.popKind.startsWith('brushes') && this.pop) this.renderBrushes(this.pop); }
    };
    inp.click();
  }
  brushFor(tool: Tool): Brush {
    const id = this.state.toolBrush[tool];
    const base = BRUSHES.find((b) => b.id === id) || BRUSHES[0];
    return { ...base, ...(this.state.overrides[base.id] || {}) };
  }
  setBrushProp<K extends keyof Brush>(key: K, val: Brush[K]) {
    const id = this.brushFor(this.tool).id;
    this.state.overrides[id] = { ...(this.state.overrides[id] || {}), [key]: val };
    this.save();
  }
  save() { prefs.save(this.state); }

  // ---------------------------------------------------------------- strokes
  /** finish any pending on-canvas edit (shape handles) before another action */
  settle() { this.shapes.commit(); this.xform?.finish(true); this.selTool?.closePoly(); if (this.adj?.active) this.adj.close(true); }

  captureAt(sx: number, sy: number) {
    if (this.guideBar) {
      const hd = guideHandleAt(this.guides, this.engine, sx, sy);
      if (hd) { const d = this.engine.screenToDoc(sx, sy); this.capture = { kind: 'guide', h: hd, prev: d }; return true; }
    }
    if (this.symBar && this.sym.mode !== 'off') {
      const hd = guideHandles(this.sym, this.engine);
      const c = this.engine.docToScreen(hd.c.x, hd.c.y), r = this.engine.docToScreen(hd.r.x, hd.r.y);
      if (Math.hypot(sx - c.x, sy - c.y) < 30) { this.capture = { kind: 'symC' }; return true; }
      if (Math.hypot(sx - r.x, sy - r.y) < 30) { this.capture = { kind: 'symR' }; return true; }
    }
    const i = this.shapes.handleAt(sx, sy);
    if (i >= 0) { this.capture = { kind: 'shape', i }; return true; }
    return false;
  }

  lastBuilder: StrokeBuilder | null = null;
  strokeStart(s: Sample, _type: string, eraserEnd = false) {
    this.closePop();
    if (this.anim.playing) this.anim.stop();
    this.anim.closePop();
    if (this.capture?.kind === 'shape') { this.shapes.beginDrag(this.capture.i); return true; }
    if (this.capture) return true; // guide handle drag
    this.settle();
    const layer = this.engine.activeLayer;
    if (!layer) return false;
    if (!layer.visible) { this.toast('This layer is hidden'); return false; }
    const tool: Tool = eraserEnd ? 'eraser' : this.tool;
    this.strokeTool = tool;
    const brush = this.brushFor(tool);
    if (!this.engine.beginStroke(tool, brush, this.state.color)) return false;
    this.strokeBrush = brush;
    const preset = BRUSHES.find((b) => b.id === brush.id);
    this.builder = new StrokeBuilder(brush, { curve: this.curve, viewScale: this.engine.view.scale, sizeRatio: preset ? brush.size / preset.size : 1 });
    this.lastBuilder = this.builder;
    // drawing assist holds the first few px back until the stroke's direction picks a guide line
    this.assist = new GuideAssist(this.guides, this.engine);
    const first = tool === 'smudge' ? [s] : this.assist.begin(s);
    if (tool === 'smudge') this.assist = null;
    this.assistPending = !first.length;
    if (first.length) this.engine.addDabs(this.expand(this.builder.start(first[0])));
    const b = this.builder;
    if (tool !== 'smudge' && this.state.settings.snapShapes) this.shapes.strokeBegan(() => b.raw);
    return true;
  }
  strokeMove(samples: Sample[]) {
    const last = samples[samples.length - 1];
    if (this.capture?.kind === 'symC') { this.sym.cx = Math.max(0, Math.min(this.engine.w, last.x)); this.sym.cy = Math.max(0, Math.min(this.engine.h, last.y)); this.symChanged(); return; }
    if (this.capture?.kind === 'symR') {
      let a = Math.atan2(last.y - this.sym.cy, last.x - this.sym.cx) - (this.sym.mode === 'vertical' ? Math.PI / 2 : 0);
      const st = Math.PI / 12, sa = Math.round(a / st) * st; if (Math.abs(sa - a) < 0.05) a = sa; // detents every 15°
      this.sym.angle = a; this.symChanged(); return;
    }
    if (this.capture?.kind === 'guide') { dragGuideHandle(this.guides, this.capture.h, last, this.capture.prev); this.capture.prev = { x: last.x, y: last.y }; this.guidesChanged(); return; }
    if (this.shapes.dragging) { this.shapes.dragTo(last); return; }
    if (this.shapes.phase === 'hold') { this.shapes.holdMove(last); return; }
    if (!this.builder) return;
    if (this.assist) {
      const wasLocked = !!this.assist.line;
      samples = this.assist.add(samples);
      if (!wasLocked && this.assist.line) this.ovDirty = true;
      if (!samples.length) return;
      if (this.assistPending) { this.assistPending = false; this.engine.addDabs(this.expand(this.builder.start(samples[0]))); samples = samples.slice(1); }
    }
    const dabs: Dab[] = [];
    for (const s of samples) dabs.push(...this.builder.add(s));
    this.engine.addDabs(this.expand(dabs));
    if (dabs.length) this.lastDab = dabs[dabs.length - 1];
    this.lastRaw = last;
    if (this.strokeTool !== 'smudge' && this.state.settings.snapShapes) { const sp = this.engine.docToScreen(last.x, last.y); this.shapes.pen(sp.x, sp.y); }
  }
  // ---------------------------------------------------------------- predicted tip
  // A provisional tip on the overlay: from the last dab actually drawn, through the pen's latest raw position
  // (closing the gap smoothing leaves) to the browser's predicted positions. Replaced every move, gone on lift.
  pred: Sample[] | null = null;
  lastDab: Dab | null = null;
  lastRaw: Sample | null = null;
  predStats = { moves: 0, withPrediction: 0, aheadPx: 0 };
  strokePredict(s: Sample[]) {
    const st = this.state.settings;
    this.predStats.moves++;
    if (!st.predict || !this.builder || this.strokeTool !== 'brush' || this.shapes.phase === 'hold' || this.sym.mode !== 'off' && this.sym.assist || (this.assist && !this.assist.free)) { if (this.pred) this.clearPrediction(); return; }
    if (s.length) { this.predStats.withPrediction++; const a = this.lastRaw, b = s[s.length - 1]; if (a) this.predStats.aheadPx += Math.hypot(b.x - a.x, b.y - a.y) * this.engine.view.scale; }
    this.pred = s; this.ovDirty = true;
  }
  clearPrediction() { if (this.pred || this.lastDab) { this.pred = null; this.lastDab = null; this.lastRaw = null; this.ovDirty = true; } }
  drawPrediction(g: CanvasRenderingContext2D) {
    if (!this.pred || !this.lastDab || !this.lastRaw || !this.strokeBrush) return;
    const e = this.engine, b = this.strokeBrush;
    const pts = [this.lastDab, this.lastRaw, ...this.pred].map((p) => e.docToScreen(p.x, p.y));
    const p = this.lastRaw.p || 1, k = b.minSize + (1 - b.minSize) * (1 - b.pressSize + b.pressSize * Math.max(0.05, p));
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = Math.max(1, Math.max(1, this.lastDab.r * 2) * e.view.scale * 0.9 || b.size * k * e.view.scale);
    const [r, gg, bb] = this.state.color.map((v) => Math.round(v * 255));
    g.strokeStyle = `rgba(${r},${gg},${bb},${Math.min(1, b.opacity * Math.max(0.35, b.flow * 2))})`;
    g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) g.lineTo(q.x, q.y); g.stroke();
    g.restore();
  }

  strokeEnd() {
    this.clearPrediction();
    if (this.capture) { const k = this.capture.kind; this.capture = null; if (k === 'shape') this.shapes.endDrag(); return; }
    if (this.shapes.phase === 'hold') { this.shapes.holdEnd(); this.builder = null; return; }
    this.shapes.strokeEnded();
    if (!this.builder) return;
    if (this.assist) {
      // lifted before the direction was read: a dot or a tiny mark, drawn as it was
      const rest = this.assist.flush();
      if (this.assistPending && rest.length) { this.engine.addDabs(this.expand(this.builder.start(rest[0]))); for (const r of rest.slice(1)) this.engine.addDabs(this.expand(this.builder.add(r))); }
      this.assistPending = false;
      if (this.assist.line) this.ovDirty = true;
      this.assist = null;
    }
    const { added, full } = this.builder.finish();
    this.engine.addDabs(this.expand(added));
    if (full) this.engine.redrawStroke(this.expand(full));
    this.engine.endStroke();
    this.builder = null;
    this.pushRecent();
  }

  /** replicate dabs through the symmetry guide (not for smudge: its pickup is order-dependent) */
  expand(dabs: Dab[]): Dab[] {
    if (this.sym.mode === 'off' || !this.sym.assist || this.strokeTool === 'smudge') return dabs;
    return expandDabs(dabs, this.sym);
  }

  // ---------------------------------------------------------------- drawing guides
  guidesChanged(save = true) {
    this.ovDirty = true; if (save) this.autosave.touch();
    $('#bGuide')?.classList.toggle('on', this.guides.kind !== 'off');
    if (this.guideBar) this.renderGuideBar();
  }
  toggleGuideBar() {
    this.settle(); this.closePop();
    if (this.guideBar) { this.guideBar.remove(); this.guideBar = null; this.ovDirty = true; return; }
    if (this.symBar) this.toggleSymBar();
    this.guideBar = h('div', { id: 'guidebar', class: 'toolbar-float' });
    document.body.append(this.guideBar);
    if (this.guides.kind === 'off') this.guides.kind = 'grid';
    this.guidesChanged();
  }
  renderGuideBar() {
    const bar = this.guideBar!; const gd = this.guides, e = this.engine;
    bar.innerHTML = '';
    const chip = (label: string, on: boolean, fn: () => void, title?: string) => h('button', { class: 'chip' + (on ? ' on' : ''), title: title || label, onClick: fn }, label);
    const kinds: GuideKind[] = ['off', 'grid', 'iso', 'persp', 'ruler'];
    bar.append(h('div', { class: 'chips' }, ...kinds.map((k) => chip(GUIDE_LABEL[k], gd.kind === k, () => { gd.kind = k; this.guidesChanged(); }))));
    const row = h('div', { class: 'chips' });
    const op = h('input', { type: 'range', min: 15, max: 100, value: Math.round(gd.opacity * 100), class: 'edge-range', 'aria-label': 'Guide opacity' }) as HTMLInputElement;
    op.oninput = () => { gd.opacity = +op.value / 100; this.ovDirty = true; };
    op.onchange = () => this.guidesChanged();
    if (gd.kind === 'grid' || gd.kind === 'iso') {
      const r = h('input', { type: 'range', min: 8, max: Math.round(Math.min(e.w, e.h) / 3), value: gd.size, class: 'edge-range', 'aria-label': 'Grid size' }) as HTMLInputElement;
      const out = h('b', { class: 'edge-val' }, gd.size + ' px');
      r.oninput = () => { gd.size = +r.value; out.textContent = gd.size + ' px'; this.ovDirty = true; };
      r.onchange = () => this.guidesChanged();
      row.append(h('label', { class: 'edge-row' }, h('span', { class: 'muted' }, 'Size'), r, out));
    }
    if (gd.kind !== 'off') row.append(h('label', { class: 'edge-row' }, h('span', { class: 'muted' }, 'Opacity'), op));
    if (gd.kind === 'persp') row.append(...([1, 2, 3] as const).map((n) => chip(n + '-point', gd.points === n, () => { gd.points = n; this.guidesChanged(); })));
    if (gd.kind === 'ruler') row.append(chip('Parallel', gd.parallel, () => { gd.parallel = !gd.parallel; this.guidesChanged(); }, 'Every stroke runs parallel to the ruler'), h('span', { class: 'muted small' }, rulerAngle(gd) + '°'));
    if (row.childNodes.length) bar.append(row);
    bar.append(h('div', { class: 'chips' },
      chip('Drawing assist', gd.assist, () => { gd.assist = !gd.assist; this.guidesChanged(); }, 'Strokes snap to the guide (starts more than 35° off any guide line stay free)'),
      chip('Reset', false, () => { const d = defaultGuides(e.w, e.h); Object.assign(gd, { ...d, kind: gd.kind, assist: gd.assist }); this.guidesChanged(); }),
      h('button', { class: 'btn small', onClick: () => this.toggleGuideBar() }, 'Done')));
    if (gd.kind === 'persp') bar.append(h('div', { class: 'muted small' }, 'Drag the numbered points (zoom out to reach ones off the canvas)'));
    if (gd.kind === 'ruler') bar.append(h('div', { class: 'muted small' }, 'Drag the ends or ✥; strokes started on its edge run along it'));
  }

  symChanged() { this.ovDirty = true; this.autosave.touch(); this.updateSymButton(); if (this.symBar) this.renderSymBar(); }
  updateSymButton() { $('#bSym')?.classList.toggle('on', this.sym.mode !== 'off'); }
  toggleSymBar() {
    this.settle(); this.closePop();
    if (this.symBar) { this.symBar.remove(); this.symBar = null; this.ovDirty = true; return; }
    if (this.guideBar) this.toggleGuideBar();
    this.symBar = h('div', { id: 'symbar' });
    document.body.append(this.symBar);
    if (this.sym.mode === 'off') { this.sym.mode = 'vertical'; this.symChanged(); }
    this.renderSymBar();
    this.ovDirty = true;
  }
  renderSymBar() {
    const bar = this.symBar!; const sy = this.sym;
    bar.innerHTML = '';
    const modes: [SymMode, string][] = [['off', 'Off'], ['vertical', 'Vertical'], ['horizontal', 'Horizontal'], ['quadrant', 'Quadrant'], ['radial', 'Radial']];
    const chip = (label: string, on: boolean, fn: () => void) => h('button', { class: 'chip' + (on ? ' on' : ''), onClick: fn }, label);
    bar.append(h('div', { class: 'chips' }, ...modes.map(([m, l]) => chip(l, sy.mode === m, () => { sy.mode = m; this.symChanged(); }))));
    if (sy.mode === 'radial') {
      bar.append(h('div', { class: 'symn' },
        h('button', { class: 'ib small', 'aria-label': 'Fewer segments', onClick: () => { sy.n = Math.max(2, sy.n - 1); this.symChanged(); } }, '−'),
        h('b', {}, String(sy.n)),
        h('button', { class: 'ib small', 'aria-label': 'More segments', onClick: () => { sy.n = Math.min(32, sy.n + 1); this.symChanged(); } }, '+'),
        chip('Mirror', sy.mirror, () => { sy.mirror = !sy.mirror; this.symChanged(); })));
    }
    bar.append(h('div', { class: 'chips' },
      chip('Assisted drawing', sy.assist, () => { sy.assist = !sy.assist; this.symChanged(); }),
      chip('Show guide', sy.show, () => { sy.show = !sy.show; this.symChanged(); }),
      chip('Centre', false, () => { sy.cx = this.engine.w / 2; sy.cy = this.engine.h / 2; sy.angle = 0; this.symChanged(); }),
      h('button', { class: 'btn small', onClick: () => this.toggleSymBar() }, 'Done')));
  }

  shapeDabs(sh: Shape): Dab[] {
    const b = this.strokeBrush || this.brushFor(this.tool);
    const raw = this.lastBuilder?.raw || [];
    const ps = raw.map((r) => r.p).sort((x, y) => x - y);
    const p = ps.length ? ps[Math.floor(ps.length * 0.6)] : 1;
    const preset = BRUSHES.find((x) => x.id === b.id);
    return this.expand(dabsAlong(b, sh.path(), p, { curve: this.curve, viewScale: this.engine.view.scale, sizeRatio: preset ? b.size / preset.size : 1 }, sh.closed));
  }

  // ---------------------------------------------------------------- selection
  toggleSelectTool() { if (this.selTool) this.exitSelectTool(); else this.enterSelectTool(); }
  // ---------------------------------------------------------------- fill tool
  previousColour(): [number, number, number] {
    const cur = toHex(this.state.color), h = this.state.recent.find((x) => x !== cur);
    return (h && fromHex(h)) || [1, 1, 1];
  }
  saveFill() { localStorage.setItem('gesso.fill', JSON.stringify(this.fillSet)); }
  toggleFillTool() { if (this.fillOn) this.exitFillTool(); else this.enterFillTool(); }
  enterFillTool() {
    this.settle(); this.closePop();
    if (this.selTool) this.exitSelectTool();
    if (this.guideBar) this.toggleGuideBar();
    if (this.symBar) this.toggleSymBar();
    this.fillOn = true; this.input.grab = this.fill;
    this.fillBar = h('div', { id: 'fillbar' }); document.body.append(this.fillBar);
    this.renderFillBar(); $('#bFill')?.classList.add('on');
  }
  exitFillTool() {
    if (!this.fillOn) return;
    this.fill.cancel(); this.fillOn = false;
    if (this.input.grab === this.fill) this.input.grab = null;
    this.fillBar?.remove(); this.fillBar = null; $('#bFill')?.classList.remove('on'); this.ovDirty = true;
  }
  renderFillBar() {
    const bar = this.fillBar; if (!bar) return;
    const f = this.fillSet, e = this.engine;
    bar.innerHTML = '';
    const chip = (label: string, on: boolean, fn: () => void, title?: string) => h('button', { class: 'chip' + (on ? ' on' : ''), title: title || label, onClick: () => { fn(); this.saveFill(); this.renderFillBar(); } }, label);
    const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const r = h('input', { type: 'range', min, max, step, value: get(), class: 'edge-range', 'aria-label': label }) as HTMLInputElement;
      const out = h('b', { class: 'edge-val' }, fmt(get()));
      r.oninput = () => { set(+r.value); out.textContent = fmt(+r.value); }; r.onchange = () => this.saveFill();
      return h('label', { class: 'edge-row' }, h('span', { class: 'muted' }, label), r, out);
    };
    bar.append(h('div', { class: 'chips' }, chip('Fill', f.mode === 'fill', () => { f.mode = 'fill'; }), chip('Gradient', f.mode === 'gradient', () => { f.mode = 'gradient'; }), chip('Recolour', f.mode === 'recolour', () => { f.mode = 'recolour'; })));
    const row = h('div', { class: 'chips' });
    if (f.mode === 'fill') {
      const rl = this.refUid ? e.layers.find((l) => l.uid === this.refUid) : null;
      row.append(chip('Canvas', f.ref === 'canvas', () => { f.ref = 'canvas'; }, 'Regions from everything visible'), chip('Layer', f.ref === 'layer', () => { f.ref = 'layer'; }, 'Regions from the active layer'),
        chip(rl ? 'Ref: ' + rl.name : 'Reference', f.ref === 'reference', () => { f.ref = 'reference'; if (!rl) this.toast('Mark a layer as Reference in the Layers panel'); }, 'Regions from the reference layer (line art), filled on the active layer'));
      row.append(slider('Threshold', 0, 100, 1, () => Math.round(f.threshold * 100), (v) => { f.threshold = v / 100; }, (v) => v + '%'),
        slider('Close gaps', 0, 12, 1, () => f.gap, (v) => { f.gap = v; }, (v) => v ? v * 2 + ' px' : 'off'),
        slider('Expand', 0, 4, 0.5, () => f.expand, (v) => { f.expand = v; }, (v) => v + ' px'));
    } else if (f.mode === 'gradient') {
      row.append(chip('Linear', f.grad === 'linear', () => { f.grad = 'linear'; }), chip('Radial', f.grad === 'radial', () => { f.grad = 'radial'; }),
        chip('→ Transparent', f.gradTo === 'transparent', () => { f.gradTo = 'transparent'; }), chip('→ Previous colour', f.gradTo === 'previous', () => { f.gradTo = 'previous'; }));
    } else {
      row.append(chip('Connected', !f.global, () => { f.global = false; }), chip('Everywhere', f.global, () => { f.global = true; }, 'Every similar colour on the layer'),
        slider('Threshold', 0, 100, 1, () => Math.round(f.threshold * 100), (v) => { f.threshold = v / 100; }, (v) => v + '%'));
    }
    bar.append(row);
    bar.append(h('div', { class: 'chips' }, h('span', { class: 'muted small' }, f.mode === 'gradient' ? 'Drag across the canvas' : 'Touch to fill · slide sideways before lifting to change the threshold'),
      h('button', { class: 'btn small', onClick: () => this.exitFillTool() }, 'Done')));
  }
  /** ColorDrop: drag the colour button onto the canvas to fill there (no tool switch) */
  private colorDrop(btn: HTMLElement) {
    btn.addEventListener('pointerdown', (ev) => {
      const id = ev.pointerId, x0 = ev.clientX, y0 = ev.clientY; let dot: HTMLElement | null = null;
      const move = (m: PointerEvent) => {
        if (m.pointerId !== id) return;
        if (!dot && Math.hypot(m.clientX - x0, m.clientY - y0) > 24) { dot = h('div', { class: 'cdrop', style: `background:${toHex(this.state.color)}` }); document.body.append(dot); }
        if (dot) { dot.style.left = m.clientX + 'px'; dot.style.top = m.clientY + 'px'; }
      };
      const up = (u: PointerEvent) => {
        if (u.pointerId !== id) return;
        window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true);
        if (!dot) return;
        dot.remove();
        const eat = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener('click', eat, { capture: true, once: true }); setTimeout(() => window.removeEventListener('click', eat, true), 400);
        if (u.type !== 'pointerup') return;
        const cv = $('#view') as HTMLElement, r = cv.getBoundingClientRect();
        const under = document.elementFromPoint(u.clientX, u.clientY);
        if (under !== cv && under !== this.ov) return;
        const keep = this.fillSet.mode; this.fillSet.mode = 'fill';
        void this.fill.drop(u.clientX - r.left, u.clientY - r.top).finally(() => { this.fillSet.mode = keep; });
      };
      window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
    });
  }

  enterSelectTool() {
    this.settle(); this.closePop();
    this.exitFillTool();
    if (this.symBar) this.toggleSymBar();
    this.selTool = new SelectTool({
      engine: this.engine,
      overlayChanged: () => { this.ovDirty = true; },
      toast: (m) => this.toast(m),
      wandPixels: (all) => (all ? this.engine.compositePixelsAsync(false) : this.engine.readLayerAsync(this.engine.activeLayer)),
    });
    this.selTool.kind = (this.state.settings.selKind as SelKind) || 'free';
    this.input.grab = this.selTool;
    this.selBar = h('div', { id: 'selbar' });
    document.body.append(this.selBar);
    this.renderSelBar();
    $('#bSelect').classList.add('on');
  }
  exitSelectTool() {
    if (this.edgeAdj) this.closeEdgeAdjust(false);
    this.selTool?.closePoly();
    if (this.input.grab === this.selTool) this.input.grab = null;
    this.selTool = null;
    this.selBar?.remove(); this.selBar = null;
    $('#bSelect')?.classList.remove('on');
    this.ovDirty = true;
  }
  edgeAdj: { api: NonNullable<ReturnType<Engine['beginEdgeAdjust']>>; grow: number; feather: number; raf: number } | null = null;
  openEdgeAdjust() {
    const api = this.engine.beginEdgeAdjust(); if (!api) return;
    this.edgeAdj = { api, grow: 0, feather: 0, raf: 0 };
    this.renderSelBar();
  }
  closeEdgeAdjust(commit: boolean) {
    const a = this.edgeAdj; if (!a) return;
    cancelAnimationFrame(a.raf); this.edgeAdj = null;
    if (commit) a.api.commit(); else a.api.cancel();
    this.renderSelBar();
  }
  renderEdgeBar(bar: HTMLElement) {
    const a = this.edgeAdj!;
    const big = Math.max(this.engine.w, this.engine.h);
    const maxGrow = Math.round(Math.min(400, Math.max(40, big / 20)));
    const upd = () => { cancelAnimationFrame(a.raf); a.raf = requestAnimationFrame(() => a.api.preview(a.grow, a.feather)); };
    const slider = (label: string, min: number, max: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const out = h('b', { class: 'edge-val' }, fmt(get()));
      const r = h('input', { type: 'range', min: String(min), max: String(max), step: '1', value: String(get()), class: 'edge-range', 'aria-label': label }) as HTMLInputElement;
      r.oninput = () => { set(+r.value); out.textContent = fmt(+r.value); upd(); };
      return h('label', { class: 'edge-row' }, h('span', { class: 'muted' }, label), r, out);
    };
    bar.append(
      slider('Shrink / Grow', -maxGrow, maxGrow, () => a.grow, (v) => { a.grow = v; }, (v) => (v > 0 ? '+' : '') + v + ' px'),
      slider('Feather', 0, Math.round(maxGrow / 2), () => a.feather, (v) => { a.feather = v; }, (v) => v + ' px'),
      h('div', { class: 'chips' }, h('button', { class: 'btn ghost small', onClick: () => this.closeEdgeAdjust(false) }, 'Cancel'), h('button', { class: 'btn small', onClick: () => this.closeEdgeAdjust(true) }, 'Apply')));
  }
  renderSelBar() {
    const bar = this.selBar, st = this.selTool; if (!bar || !st) return;
    const e = this.engine;
    bar.innerHTML = '';
    if (this.edgeAdj) { this.renderEdgeBar(bar); return; }
    const chip = (label: string, on: boolean, fn: () => void, disabled = false) => h('button', { class: 'chip' + (on ? ' on' : ''), disabled, onClick: () => { fn(); this.renderSelBar(); } }, label);
    const kinds: [SelKind, string][] = [['auto', 'Automatic'], ['free', 'Freehand'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse']];
    bar.append(h('div', { class: 'chips' }, ...kinds.map(([k, l]) => chip(l, st.kind === k, () => { st.cancelPoly(); st.kind = k; this.state.settings.selKind = k; this.save(); }))));
    bar.append(h('div', { class: 'chips' }, chip('New', st.mode === 0, () => { st.mode = 0; }), chip('Add', st.mode === 1, () => { st.mode = 1; }), chip('Subtract', st.mode === 2, () => { st.mode = 2; }),
      ...(st.kind === 'auto' ? [chip('All layers', st.sampleAll, () => { st.sampleAll = !st.sampleAll; st.invalidateWand(); })] : []),
      ...(st.kind === 'free' && st.polyOpen ? [chip('Close shape', false, () => st.closePoly())] : [])));
    const has = !!e.sel;
    bar.append(h('div', { class: 'chips' },
      chip('Invert', false, () => e.invertSelection()),
      chip('Refine edge', false, () => this.openEdgeAdjust(), !has),
      chip('Copy & paste', false, () => { if (!e.copySelectionToLayer()) this.toast('Layer limit reached'); }, !has),
      chip('Fill', false, () => e.fillLayer(this.state.color), !has),
      chip('Clear', false, () => e.clearLayer(), !has),
      chip('Transform', false, () => void this.startLayerTransform(), !has),
      chip('Deselect', false, () => e.deselect(), !has),
      h('button', { class: 'btn small', onClick: () => this.exitSelectTool() }, 'Done')));
  }
  /** lift the selection (or the whole layer) into the transform box */
  async startLayerTransform() {
    this.exitFillTool();
    this.settle(); this.closePop();
    const e = this.engine, layer = e.activeLayer;
    if (!layer.visible) { this.toast('This layer is hidden'); return; }
    const wasSelecting = !!this.selTool;
    if (wasSelecting) this.exitSelectTool();
    const { inside, outside } = e.splitBySelection(layer);
    const bb = await e.contentBounds(inside);
    if (!bb) { e.freeTarget(inside); if (outside) e.freeTarget(outside); this.toast(e.sel ? 'Nothing selected on this layer' : 'This layer is empty'); return; }
    const src = e.sourceFromTarget(inside, bb);
    e.freeTarget(inside);
    const maskSrc = e.sel ? e.sourceFromTarget(e.sel, bb) : null;
    const before = e.stashLayer(layer);
    const keep = outside;
    const init = { cx: bb.x + bb.w / 2, cy: bb.y + bb.h / 2, sx: 1, sy: 1, rot: 0 };
    this.startTransform(layer, src, 'replace', (commit, tool) => {
      if (commit) {
        e.history.beginGroup();
        e.recordReplace(layer, before, 'Transform');
        if (maskSrc) {
          const m = e.blankTarget();
          tool.renderTo(m, maskSrc, null, 'smooth');
          e.setSelection(m, 'Transform');
        }
        e.history.endGroup('Transform');
      } else {
        const t = before.take();
        const old = e.swapTarget(layer, t); e.freeTarget(old);
      }
      if (keep) e.freeTarget(keep);
      if (maskSrc) e.freeTarget(maskSrc);
      if (wasSelecting) this.enterSelectTool();
    }, init, keep);
  }

  drawOverlay() {
    this.ovDirty = false;
    const c = this.ov, g = c.getContext('2d')!;
    const dpr = c.width / (c.clientWidth || 1);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGuide(g, this.engine, this.sym, !!this.symBar);
    drawGuides(g, this.engine, this.guides, !!this.guideBar, this.assist?.line ?? null);
    this.shapes.drawOverlay(g);
    this.xform?.drawOverlay(g);
    this.selTool?.drawOverlay(g);
    this.fill?.drawOverlay(g);
    this.adj?.drawOverlay(g);
    this.drawPrediction(g);
    this.text?.drawOverlay(g);
  }

  undo() {
    if (this.adj.active) { this.adj.close(false); this.toast('Adjustment cancelled'); return; }
    if (this.edgeAdj) this.closeEdgeAdjust(false);
    if (this.shapes.active) { this.shapes.cancel(); this.toast('Undo shape'); return; }
    if (this.engine.stroking) return; const l = this.engine.history.undo(); this.toast(l ? 'Undo ' + l.toLowerCase() : 'Nothing to undo'); }
  redo() { if (this.edgeAdj) this.closeEdgeAdjust(false); this.settle(); if (this.engine.stroking) return; const l = this.engine.history.redo(); this.toast(l ? 'Redo ' + l.toLowerCase() : 'Nothing to redo'); }

  eyedrop(x: number, y: number, done: boolean, sx: number, sy: number) {
    const c = this.engine.sample(x, y);
    if (c) {
      this.loupe.style.display = done ? 'none' : 'block';
      const r = this.canvas.getBoundingClientRect();
      this.loupe.style.left = r.left + sx + 'px';
      this.loupe.style.top = r.top + sy - 70 + 'px';
      this.loupe.style.setProperty('--new', toHex(c));
      this.loupe.style.setProperty('--old', toHex(this.state.color));
      if (done) { this.setColor(c); this.eyedropOnce = false; $('#bDrop').classList.remove('on'); }
    } else if (done) this.loupe.style.display = 'none';
  }

  // ---------------------------------------------------------------- canvas lifecycle
  /** start a new artwork (the open one is saved first) */
  newCanvas(w: number, h: number, name?: string): Promise<void> {
    if (this.autosave.docId) return this.autosave.flush().then(() => this.newCanvasNow(w, h, name));
    this.newCanvasNow(w, h, name);
    return Promise.resolve();
  }
  private newCanvasNow(w: number, h: number, name?: string) {
    w = Math.max(16, Math.min(this.engine.maxTex, Math.round(w)));
    h = Math.max(16, Math.min(this.engine.maxTex, Math.round(h)));
    this.autosave.detach();
    this.engine.newDocument(w, h, [1, 1, 1]);
    const now = Date.now();
    const meta: DocMeta = { id: newDocId(), name: name || 'Untitled ' + new Date(now).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), w, h, bg: [1, 1, 1], bgVisible: true, layers: [], active: 0, created: now, modified: now };
    this.applyDocExtra({});
    this.autosave.attach(meta, false);
    try { localStorage.setItem('gesso.last', meta.id); } catch { /* private mode */ }
    void this.autosave.flush();
    this.closeGallery();
    this.thumbVersions.clear();
    this.fit();
    this.updateUndoButtons();
  }
  fit() {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const e = this.engine;
    // leave room for the top bar, and for the timeline when animating
    const top = 70, bottom = this.anim?.on ? 140 : 50;
    const s = Math.min((cw - 40) / e.w, (ch - top - bottom) / e.h);
    e.view = { scale: s, rot: 0, x: (cw - e.w * s) / 2, y: top + (ch - top - bottom - e.h * s) / 2 };
    e.needsPresent = true;
  }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.canvas;
    const oldW = c.clientWidth;
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    if (this.ov) { this.ov.width = c.width; this.ov.height = c.height; this.ovDirty = true; }
    if (oldW) this.engine.needsPresent = true;
  }

  // ---------------------------------------------------------------- UI
  buildUI() {
    const top = $('#top');
    const tb = (id: string, icon: string, title: string, on: () => void) => {
      const b = h('button', { id, class: 'ib', title, 'aria-label': title, onClick: on });
      b.append(svg(icon));
      return b;
    };
    const left = h('div', { class: 'grp' },
      tb('bGallery', ICON.gallery, 'Gallery', () => this.showGallery()),
      h('button', { id: 'bMenu', class: 'brand', onClick: () => this.togglePop('menu', this.renderMenu) }, h('span', { class: 'logo' }), 'Gesso'),
      tb('bExport', ICON.share, 'Export PNG', () => this.exportPNG()),
      tb('bSelect', ICON.select, 'Select', () => this.toggleSelectTool()),
      tb('bTransform', ICON.transform, 'Transform', () => void this.startLayerTransform()),
      tb('bFill', ICON.fill, 'Fill, gradient, recolour', () => this.toggleFillTool()),
      tb('bText', ICON.text, 'Text', () => { this.settle(); this.closePop(); if (this.text.active) this.text.disarm(); else { if (this.selTool) this.exitSelectTool(); this.text.arm(); } }),
      tb('bAdjust', ICON.adjust, 'Adjustments', () => this.togglePop('adjust', (el) => this.adj.renderMenu(el, () => this.closePop()))),
    );
    const right = h('div', { class: 'grp' },
      tb('tBrush', ICON.brush, 'Paint', () => this.pickTool('brush')),
      tb('tSmudge', ICON.smudge, 'Smudge', () => this.pickTool('smudge')),
      tb('tEraser', ICON.eraser, 'Erase', () => this.pickTool('eraser')),
      tb('bAnim', ICON.film, 'Animation', () => { this.closePop(); this.anim.toggle(); $('#bAnim').classList.toggle('on', this.anim.on); }),
      tb('bSym', ICON.symmetry, 'Symmetry', () => this.toggleSymBar()),
      tb('bGuide', ICON.guide, 'Drawing guides', () => this.toggleGuideBar()),
      tb('bLayers', ICON.layers, 'Layers', () => this.togglePop('layers', this.renderLayers)),
      (() => { const b = h('button', { id: 'bColor', class: 'swatch', title: 'Colour (drag onto the canvas to fill)', 'aria-label': 'Colour', onClick: () => this.togglePop('color', this.renderColor) }); this.colorDrop(b); return b; })(),
    );
    top.append(left, right);

    // side rail
    const rail = $('#rail');
    rail.classList.toggle('right', !this.state.settings.leftRail);
    const sizeS = this.vslider('size', (t) => {
      const b = this.brushFor(this.tool);
      this.setBrushProp('size', Math.round((1 + 499 * t * t) * 10) / 10);
      this.bubble(sizeS, Math.round(this.brushFor(this.tool).size) + ' px', b);
    });
    const opS = this.vslider('opacity', (t) => {
      this.setBrushProp('opacity', Math.max(0.01, t));
      this.bubble(opS, Math.round(t * 100) + '%');
    });
    rail.append(sizeS,
      tb('bDrop', ICON.drop, 'Eyedropper', () => { this.eyedropOnce = !this.eyedropOnce; $('#bDrop').classList.toggle('on', this.eyedropOnce); }),
      opS,
      tb('bUndo', ICON.undo, 'Undo', () => this.undo()),
      tb('bRedo', ICON.redo, 'Redo', () => this.redo()));

    // close popovers when tapping the canvas (and swallow that touch)
    $('#app').addEventListener('pointerdown', (e) => {
      if (this.pop && e.target === this.canvas) { this.closePop(); e.stopImmediatePropagation(); e.preventDefault(); }
    }, true);
    this.pickTool('brush', true);
    this.updateColorButton();
  }

  vslider(kind: 'size' | 'opacity', onSet: (t: number) => void) {
    const el = h('div', { class: 'vs', 'data-kind': kind }, h('div', { class: 'fillbar' }), h('div', { class: 'thumb' }));
    const setFrom = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      onSet(t); this.syncSliders();
    };
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); setFrom(e); el.classList.add('drag'); });
    el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) setFrom(e); });
    const end = () => { el.classList.remove('drag'); $('.bubble', el)?.remove(); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    return el;
  }
  bubble(el: HTMLElement, text: string, b?: Brush) {
    let bub = $('.bubble', el);
    if (!bub) { bub = h('div', { class: 'bubble' }); el.append(bub); }
    bub.textContent = text;
    if (b) {
      const d = Math.min(120, Math.max(4, b.size * this.engine.view.scale));
      bub.style.setProperty('--d', d + 'px');
      bub.classList.add('dot');
    }
  }
  syncSliders() {
    const b = this.brushFor(this.tool);
    const st = Math.sqrt(Math.max(0, (b.size - 1) / 499));
    const set = (kind: string, t: number) => {
      const el = $(`.vs[data-kind="${kind}"]`);
      ($('.fillbar', el) as HTMLElement).style.height = t * 100 + '%';
      ($('.thumb', el) as HTMLElement).style.bottom = `calc(${t * 100}% - 10px)`;
    };
    set('size', st); set('opacity', b.opacity);
  }

  pickTool(t: Tool, silent = false) {
    this.settle();
    if (this.text?.active) this.text.disarm();
    if (this.selTool && !silent) this.exitSelectTool();
    const same = this.tool === t;
    this.tool = t;
    for (const [id, tt] of [['tBrush', 'brush'], ['tSmudge', 'smudge'], ['tEraser', 'eraser']] as const) $('#' + id).classList.toggle('on', tt === t);
    this.syncSliders();
    if (silent) return;
    if (same || !this.pop || this.popKind.startsWith('brushes')) this.togglePop('brushes-' + t, this.renderBrushes, same ? undefined : true);
  }

  togglePop(kind: string, render: (this: App, el: HTMLElement) => void, forceOpen?: boolean) {
    this.settle();
    if (this.popKind === kind && !forceOpen) { this.closePop(); return; }
    this.closePop();
    const el = h('div', { class: 'pop pop-' + kind.split('-')[0] });
    $('#app').append(el);
    this.pop = el; this.popKind = kind;
    render.call(this, el);
  }
  closePop() { this.pop?.remove(); this.pop = null; this.popKind = ''; }

  // ---------------------------------------------------------------- brush library
  renderBrushes(el: HTMLElement) {
    el.innerHTML = '';
    const tool = this.tool;
    const groups = [...new Set(BRUSHES.map((b) => b.group))];
    const cur = this.brushFor(tool);
    let group = cur.group;
    if (!groups.includes(group)) group = groups[0];
    const head = h('div', { class: 'pop-head' }, h('b', {}, tool === 'brush' ? 'Brushes' : tool === 'smudge' ? 'Smudge with' : 'Erase with'),
      h('button', { class: 'chip small', title: 'Import .gessobrush', onClick: () => this.importBrushes() }, 'Import'),
      h('button', { class: 'chip small', title: 'Export this brush with your settings', onClick: () => this.exportBrush() }, 'Export'),
      h('button', { class: 'chip', onClick: () => this.openStudio() }, svg(ICON.sliders), 'Brush studio'));
    const side = h('div', { class: 'groups' });
    const list = h('div', { class: 'blist' });
    const drawList = () => {
      side.innerHTML = '';
      for (const g of groups) side.append(h('button', { class: 'gbtn' + (g === group ? ' on' : ''), onClick: () => { group = g; drawList(); } }, g));
      list.innerHTML = '';
      for (const b0 of BRUSHES.filter((b) => b.group === group)) {
        const b = { ...b0, ...(this.state.overrides[b0.id] || {}) };
        const cv = h('canvas', { width: 360, height: 70 }) as HTMLCanvasElement;
        drawBrushPreview(cv, b);
        const on = b.id === this.state.toolBrush[tool];
        list.append(h('button', {
          class: 'brow' + (on ? ' on' : ''),
          onClick: () => {
            if (on) { this.openStudio(); return; }
            this.state.toolBrush[tool] = b.id; this.save(); this.syncSliders(); drawList();
          },
        }, h('span', { class: 'bname' }, b.name), cv));
      }
    };
    drawList();
    el.append(head, h('div', { class: 'bwrap' }, side, list));
  }

  openStudio() {
    this.closePop();
    const b0 = BRUSHES.find((b) => b.id === this.state.toolBrush[this.tool])!;
    const sheet = this.sheet('Brush studio · ' + b0.name);
    const preview = h('canvas', { width: 720, height: 140, class: 'studio-prev' }) as HTMLCanvasElement;
    const redraw = () => drawBrushPreview(preview, this.brushFor(this.tool));
    const body = h('div', { class: 'studio' });
    const sec = (title: string) => { const s = h('section', {}, h('h4', {}, title)); body.append(s); return s; };
    const slider = (parent: HTMLElement, label: string, key: keyof Brush, min: number, max: number, step: number, fmt: (v: number) => string = (v) => String(Math.round(v * 100) / 100)) => {
      const b = this.brushFor(this.tool);
      const val = h('span', { class: 'sv' }, fmt((b[key] as number) ?? 0));
      const inp = h('input', { type: 'range', min, max, step, value: (b[key] as number) ?? 0 }) as HTMLInputElement;
      inp.oninput = () => { this.setBrushProp(key, +inp.value as never); val.textContent = fmt(+inp.value); redraw(); this.syncSliders(); };
      parent.append(h('label', { class: 'srow' }, h('span', {}, label), inp, val));
    };
    const pct = (v: number) => Math.round(v * 100) + '%';
    const chips = <T extends string>(parent: HTMLElement, label: string, key: keyof Brush, opts: readonly T[], thumbs?: (o: T) => HTMLElement) => {
      const row = h('div', { class: 'chips' });
      const draw = () => {
        row.innerHTML = '';
        const cur = this.brushFor(this.tool)[key];
        for (const o of opts) row.append(h('button', { class: 'chip' + (cur === o ? ' on' : ''), onClick: () => { this.setBrushProp(key, o as never); draw(); redraw(); } }, thumbs ? thumbs(o) : null, o));
      };
      draw();
      parent.append(h('div', { class: 'srow col' }, h('span', {}, label), row));
    };
    const toggle = (parent: HTMLElement, label: string, key: keyof Brush) => {
      const inp = h('input', { type: 'checkbox' }) as HTMLInputElement;
      inp.checked = !!this.brushFor(this.tool)[key];
      inp.onchange = () => { this.setBrushProp(key, inp.checked as never); redraw(); };
      parent.append(h('label', { class: 'srow' }, h('span', {}, label), inp));
    };
    let s = sec('Properties');
    slider(s, 'Max size', 'size', 1, 500, 0.5, (v) => Math.round(v) + ' px');
    slider(s, 'Opacity', 'opacity', 0.01, 1, 0.01, pct);
    slider(s, 'Flow', 'flow', 0.01, 1, 0.01, pct);
    if (this.tool === 'smudge') slider(s, 'Smudge strength', 'smudge', 0, 1, 0.01, pct);
    s = sec('Stroke');
    slider(s, 'Spacing', 'spacing', 0.01, 1, 0.01, pct);
    slider(s, 'Smoothing', 'smoothing', 0, 1, 0.01, pct);
    slider(s, 'Size jitter', 'sizeJitter', 0, 1, 0.01, pct);
    slider(s, 'Opacity jitter', 'opacityJitter', 0, 1, 0.01, pct);
    slider(s, 'Scatter', 'scatter', 0, 1.5, 0.01, pct);
    s = sec('Taper');
    slider(s, 'Start taper', 'taperStart', 0, 300, 1, (v) => Math.round(v) + ' px');
    slider(s, 'End taper', 'taperEnd', 0, 300, 1, (v) => Math.round(v) + ' px');
    s = sec('Shape');
    chips(s, 'Tip', 'shape', SHAPES, (o) => { const c = makeShape(o as ShapeId); c.className = 'tipimg'; return c; });
    slider(s, 'Roundness', 'roundness', 0.05, 1, 0.01, pct);
    slider(s, 'Angle', 'angle', 0, 180, 1, (v) => Math.round(v) + '°');
    slider(s, 'Rotation jitter', 'rotJitter', 0, 1, 0.01, pct);
    toggle(s, 'Follow stroke direction', 'followDir');
    s = sec('Grain');
    chips(s, 'Texture', 'grain', GRAINS);
    slider(s, 'Scale', 'grainScale', 0.2, 4, 0.05, (v) => v.toFixed(2) + '×');
    slider(s, 'Depth', 'grainDepth', 0, 1, 0.01, pct);
    s = sec('Pencil & stylus');
    slider(s, 'Pressure → size', 'pressSize', 0, 1, 0.01, pct);
    slider(s, 'Minimum size', 'minSize', 0, 1, 0.01, pct);
    slider(s, 'Pressure → opacity', 'pressOpacity', 0, 1, 0.01, pct);
    slider(s, 'Tilt shading', 'tiltSize', 0, 3, 0.05, (v) => v.toFixed(2));
    s = sec('Wet paint');
    slider(s, 'Wet edges', 'wetEdges', 0, 1, 0.01, pct);
    slider(s, 'Drying flow (watercolour)', 'wet' as keyof Brush, 0, 1, 0.01, pct);
    slider(s, 'Granulation', 'granulation' as keyof Brush, 0, 1, 0.01, pct);
    s.append(h('button', { class: 'btn ghost', onClick: () => { delete this.state.overrides[b0.id]; this.save(); this.syncSliders(); sheet.close(); this.openStudio(); } }, 'Reset brush to default'));
    sheet.body.append(preview, body);
    redraw();
  }

  // ---------------------------------------------------------------- colour
  setColor(c: RGB) {
    this.state.color = c;
    this.save();
    this.updateColorButton();
    if (this.popKind === 'color' && this.pop) this.renderColor(this.pop);
  }
  pushRecent() {
    const hex = toHex(this.state.color);
    const r = this.state.recent.filter((x) => x !== hex);
    r.unshift(hex);
    this.state.recent = r.slice(0, 18);
    this.save();
  }
  updateColorButton() { $('#bColor').style.background = toHex(this.state.color); }

  renderColor(el: HTMLElement) {
    el.innerHTML = '';
    let hsv: HSV = rgbToHsv(this.state.color);
    const old = toHex(this.state.color);
    const S = 260, dpr = Math.min(2, devicePixelRatio || 1);
    const cv = h('canvas', { width: S * dpr, height: S * dpr, class: 'wheel', style: `width:${S}px;height:${S}px` }) as HTMLCanvasElement;
    const g = cv.getContext('2d')!;
    const R = S / 2, ringIn = R - 26, sq = ringIn * Math.SQRT2 - 10;
    const ringImg = (() => {
      const W = S * dpr, img = g.createImageData(W, W);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const dx = x / dpr - R, dy = y / dpr - R, d = Math.hypot(dx, dy);
        if (d > R - 1 || d < ringIn) continue;
        const hue = (Math.atan2(dy, dx) / (2 * Math.PI) + 1.25) % 1;
        const c = hsvToRgb({ h: hue, s: 1, v: 1 });
        const a = Math.min(1, R - 1 - d, d - ringIn);
        const i = (y * W + x) * 4;
        img.data[i] = c[0] * 255; img.data[i + 1] = c[1] * 255; img.data[i + 2] = c[2] * 255; img.data[i + 3] = 255 * Math.max(0, Math.min(1, a));
      }
      return img;
    })();
    const draw = () => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      g.putImageData(ringImg, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const x0 = R - sq / 2, y0 = R - sq / 2;
      const base = hsvToRgb({ h: hsv.h, s: 1, v: 1 });
      const gx = g.createLinearGradient(x0, 0, x0 + sq, 0);
      gx.addColorStop(0, '#fff'); gx.addColorStop(1, toHex(base));
      g.fillStyle = gx; g.fillRect(x0, y0, sq, sq);
      const gy = g.createLinearGradient(0, y0, 0, y0 + sq);
      gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(1, '#000');
      g.fillStyle = gy; g.fillRect(x0, y0, sq, sq);
      // markers
      const a = hsv.h * 2 * Math.PI - Math.PI / 2, rm = (R + ringIn) / 2;
      const mark = (x: number, y: number, fill: string) => { g.beginPath(); g.arc(x, y, 9, 0, 7); g.fillStyle = fill; g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke(); g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,.4)'; g.stroke(); };
      // harmony partners on the ring
      for (const o of HARMONY[this.state.settings.harmony || 'off'] || []) {
        const ha = ((hsv.h + o) % 1) * 2 * Math.PI - Math.PI / 2;
        g.beginPath(); g.arc(R + Math.cos(ha) * rm, R + Math.sin(ha) * rm, 6, 0, 7); g.fillStyle = toHex(hsvToRgb({ h: (hsv.h + o) % 1, s: 1, v: 1 })); g.fill();
        g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.85)'; g.stroke();
      }
      mark(R + Math.cos(a) * rm, R + Math.sin(a) * rm, toHex(base));
      mark(x0 + hsv.s * sq, y0 + (1 - hsv.v) * sq, toHex(hsvToRgb(hsv)));
    };
    let mode: 'ring' | 'sq' | null = null;
    const pick = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (!mode) mode = Math.hypot(x - R, y - R) >= ringIn - 4 ? 'ring' : 'sq';
      if (mode === 'ring') hsv.h = (Math.atan2(y - R, x - R) / (2 * Math.PI) + 1.25) % 1;
      else { hsv.s = Math.max(0, Math.min(1, (x - (R - sq / 2)) / sq)); hsv.v = Math.max(0, Math.min(1, 1 - (y - (R - sq / 2)) / sq)); }
      this.state.color = hsvToRgb(hsv); this.updateColorButton(); draw(); cur.style.background = toHex(this.state.color); hex.value = toHex(this.state.color); fillHarmony();
    };
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); mode = null; pick(e); });
    cv.addEventListener('pointermove', (e) => { if (cv.hasPointerCapture(e.pointerId)) pick(e); });
    cv.addEventListener('pointerup', () => { mode = null; this.save(); });
    const cur = h('span', { class: 'cnew', style: `background:${old}` });
    const prev = h('button', { class: 'cold', style: `background:${old}`, title: 'Previous colour', onClick: () => this.setColor(fromHex(old)!) });
    const hex = h('input', { class: 'hex', value: old, maxlength: 7, spellcheck: false }) as HTMLInputElement;
    hex.onchange = () => { const c = fromHex(hex.value); if (c) this.setColor(c); };
    const sw = (list: string[], cls: string) => h('div', { class: cls }, ...list.map((c) => h('button', { class: 'sw', style: `background:${c}`, title: c, onClick: () => this.setColor(fromHex(c)!) })));
    // colour harmony: partners of the current colour (same saturation and brightness, related hues)
    const harmSw = h('div', { class: 'swatches harm' });
    const fillHarmony = () => {
      harmSw.innerHTML = '';
      const offs = HARMONY[this.state.settings.harmony || 'off'] || [];
      for (const o of [0, ...offs]) {
        const c = toHex(hsvToRgb({ h: (hsv.h + o) % 1, s: hsv.s, v: hsv.v }));
        harmSw.append(h('button', { class: 'sw' + (o === 0 ? ' base' : ''), style: `background:${c}`, title: c, onClick: () => this.setColor(fromHex(c)!) }));
      }
      // tints and shades of the current hue for value studies
      if (this.state.settings.harmony === 'shades') { harmSw.innerHTML = ''; for (const v of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) { const c = toHex(hsvToRgb({ h: hsv.h, s: hsv.s, v })); harmSw.append(h('button', { class: 'sw', style: `background:${c}`, title: c, onClick: () => this.setColor(fromHex(c)!) })); } }
    };
    const harmChips = h('div', { class: 'chips harm-modes' }, ...Object.entries(HARMONY_LABEL).map(([k, label]) => h('button', {
      class: 'chip small' + ((this.state.settings.harmony || 'off') === k ? ' on' : ''),
      onClick: () => { this.state.settings.harmony = k; this.save(); this.renderColor(el); } }, label)));
    fillHarmony();
    el.append(...[
      h('div', { class: 'pop-head' }, h('b', {}, 'Colour'), h('div', { class: 'cpair' }, prev, cur), hex),
      cv,
      h('div', { class: 'lbl' }, 'Harmony'), harmChips,
      (this.state.settings.harmony || 'off') !== 'off' ? harmSw : null,
      this.state.recent.length ? h('div', { class: 'lbl' }, 'History · colours you painted with') : null,
      this.state.recent.length ? sw(this.state.recent, 'swatches') : null,
      h('div', { class: 'lbl' }, 'Palette'),
      sw(PALETTE, 'swatches'),
    ].filter(Boolean) as HTMLElement[]);
    draw();
  }

  // ---------------------------------------------------------------- layers
  /**
   * Long-press drop in the layers list: move a layer (or a whole group) so that it sits just above the row
   * `below` (null = the bottom). Done as single steps of moveBlock, so group membership follows the same rules
   * as the arrows (entering an expanded group, leaving at its edge); one undo step.
   */
  dropLayer(l: Layer, below: Layer | null) {
    const e = this.engine;
    const rows = () => { const out: Layer[] = []; const f = (x: Layer) => { for (let p = x.parent; p; p = p.parent) if (p.collapsed) return true; return false; };
      for (let i = e.layers.length - 1; i >= 0; i--) if (!f(e.layers[i])) out.push(e.layers[i]); return out; };
    // the row directly below l's block in display order
    const rowBelow = () => { const r = rows();
      const idx = r.indexOf(l); let k = idx + 1; while (k < r.length && e.isInside(r[k], l)) k++; return r[k] ?? null; };
    const pos = (x: Layer | null) => x ? rows().indexOf(x) : rows().length;
    if (below && (below === l || e.isInside(below, l))) return;
    e.history.beginGroup();
    let first: 1 | -1 | 0 = 0;
    for (let n = 0; n < e.layers.length * 3 && rowBelow() !== below; n++) {
      const dir: 1 | -1 = pos(below) <= pos(l) ? 1 : -1;
      if (first && dir !== first) break;   // overshot an unreachable spot (group edge): stay at the nearest
      first = dir;
      const before = e.layers.map((x) => x.id + ':' + (x.parent?.id ?? '')).join();
      e.moveBlock(l, dir);
      if (e.layers.map((x) => x.id + ':' + (x.parent?.id ?? '')).join() === before) break;
    }
    e.history.endGroup('Move layer');
    e.active = e.layers.indexOf(l);
    this.renderLayers();
  }

  renderLayers(el: HTMLElement = this.pop!) {
    if (!el) return;
    const e = this.engine;
    el.innerHTML = '';
    const max = e.maxLayersFor(e.w, e.h);
    void max;
    const mem = e.memoryStats();
    el.append(h('div', { class: 'pop-head' }, h('b', {}, 'Layers'), h('span', { class: 'muted', title: 'GPU memory used by layer pixels' }, `${e.layers.filter((x) => !x.group).length} · ${Math.round(mem.layerBytes / 1048576)} MB`),
      h('button', { class: 'ib small', title: 'New group', 'aria-label': 'New group', onClick: () => { if (!e.groupActive()) this.toast('Groups nest up to 4 deep'); } }, svg(ICON.folderPlus)),
      h('button', { class: 'ib small', title: 'New layer', onClick: () => { if (!e.addLayer()) this.toast('Not enough memory for another layer'); } }, svg(ICON.plus))));
    const list = h('div', { class: 'llist' });
    const folded = (l: Layer) => { for (let p = l.parent; p; p = p.parent) if (p.collapsed) return true; return false; };
    const shown: Layer[] = [];   // rows in display order (top first), for long-press reordering
    for (let i = e.layers.length - 1; i >= 0; i--) {
      const l = e.layers[i];
      if (folded(l)) continue;
      shown.push(l);
      const depth = e.depthOf(l);
      if (l.group) {
        const n = e.membersOf(l, true).filter((x) => !x.group).length;
        const eyeG = h('button', { class: 'ib small', title: l.visible ? 'Hide' : 'Show', onClick: (ev: Event) => { ev.stopPropagation(); e.setProp(l, 'visible', !l.visible); } }, svg(l.visible ? ICON.eye : ICON.eyeOff));
        const chev = h('button', { class: 'ib small chev', title: l.collapsed ? 'Expand' : 'Collapse', 'aria-label': l.collapsed ? 'Expand group' : 'Collapse group', onClick: (ev: Event) => { ev.stopPropagation(); e.setCollapsed(l, !l.collapsed); this.autosave.touch(); } }, svg(l.collapsed ? ICON.chevRight : ICON.chevDown));
        list.append(h('div', { class: 'lrow group' + (i === e.active ? ' on' : '') + (e.hiddenInTree(l) ? ' dim' : ''), style: `padding-left:${6 + depth * 16}px`, onClick: () => { e.active = i; this.renderLayers(); } },
          chev, h('span', { class: 'gicon' }, svg(ICON.folder)),
          h('div', { class: 'lmeta' }, h('span', { class: 'lname' }, l.name), h('span', { class: 'muted' }, `${n} layer${n === 1 ? '' : 's'}` + (l.blend ? ' · ' + BLEND_MODES[l.blend] : '') + (l.opacity < 1 ? ` · ${Math.round(l.opacity * 100)}%` : ''))), eyeG));
        continue;
      }
      const thumb = h('canvas', { width: 72, height: Math.max(24, Math.round(72 * e.h / e.w)), class: 'lthumb', 'data-id': l.id }) as HTMLCanvasElement;
      this.thumbVersions.delete(l.id);
      const eye = h('button', { class: 'ib small', title: l.visible ? 'Hide' : 'Show', onClick: (ev: Event) => { ev.stopPropagation(); e.setProp(l, 'visible', !l.visible); } }, svg(l.visible ? ICON.eye : ICON.eyeOff));
      const tags = h('span', { class: 'tags' }, l.alphaLock ? svg(ICON.lock) : null, l.clip ? svg(ICON.clip) : null);
      const row = h('div', { class: 'lrow' + (i === e.active ? ' on' : '') + (l.clip ? ' clipped' : '') + (e.hiddenInTree(l) ? ' dim' : ''), style: depth ? `padding-left:${6 + depth * 16}px` : '', onClick: () => { e.active = i; this.renderLayers(); } },
        thumb, h('div', { class: 'lmeta' }, h('span', { class: 'lname' }, l.name), h('span', { class: 'muted' }, BLEND_MODES[l.blend] + (l.opacity < 1 ? ` · ${Math.round(l.opacity * 100)}%` : ''))), tags, eye);
      list.append(row);
    }
    const bgRow = h('div', { class: 'lrow bg' },
      h('label', { class: 'bgsw', style: `background:${toHex(e.bg)}` }, (() => { const inp = h('input', { type: 'color', value: toHex(e.bg) }) as HTMLInputElement; inp.onchange = () => e.setBackground(fromHex(inp.value)); return inp; })()),
      h('div', { class: 'lmeta' }, h('span', { class: 'lname' }, 'Background colour'), h('span', { class: 'muted' }, e.bgVisible ? 'Visible' : 'Transparent')),
      h('button', { class: 'ib small', onClick: () => e.setBackground(null, !e.bgVisible) }, svg(e.bgVisible ? ICON.eye : ICON.eyeOff)));
    list.append(bgRow);
    el.append(list);
    dragSort({ scroller: list, axis: 'y', items: () => [...list.querySelectorAll<HTMLElement>('.lrow:not(.bg)')],
      onDrop: (from, to) => { this.dropLayer(shown[from], shown[to] ?? null); } });
    // active layer controls
    const l = e.activeLayer;
    const op = h('input', { type: 'range', min: 0, max: 100, value: Math.round(l.opacity * 100) }) as HTMLInputElement;
    let opStart = l.opacity;
    op.onpointerdown = () => { opStart = l.opacity; };
    op.oninput = () => { e.previewProp(l, 'opacity', +op.value / 100); opv.textContent = op.value + '%'; };
    op.onchange = () => { e.setProp(l, 'opacity', +op.value / 100, opStart); };
    const opv = h('span', { class: 'sv' }, Math.round(l.opacity * 100) + '%');
    const blend = h('select', {}, ...BLEND_MODES.map((m, i) => h('option', { value: i, selected: i === l.blend }, m))) as HTMLSelectElement;
    blend.onchange = () => e.setProp(l, 'blend', +blend.value);
    const tog = (label: string, icon: string, on: boolean, fn: () => void) => h('button', { class: 'chip' + (on ? ' on' : ''), onClick: fn }, svg(icon), label);
    const act = (title: string, icon: string, fn: () => void, disabled = false) => h('button', { class: 'ib small', title, 'aria-label': title, disabled, onClick: fn }, svg(icon));
    const name = h('input', { class: 'lname-in', value: l.name }) as HTMLInputElement;
    name.onchange = () => e.setProp(l, 'name', name.value.trim() || l.name);
    if (l.group) {
      el.append(h('div', { class: 'lctl' }, name,
        h('label', { class: 'srow' }, h('span', {}, 'Opacity'), op, opv),
        h('label', { class: 'srow' }, h('span', {}, 'Blend'), blend),
        h('div', { class: 'muted small' }, l.opacity >= 1 && !l.blend ? 'Normal 100 %: members blend with everything below' : 'Members are combined first, then blended as one'),
        h('div', { class: 'acts' },
          act('Move up', ICON.up, () => e.moveBlock(l, 1), e.blockOf(l)[1] >= e.layers.length - 1 && !l.parent),
          act('Move down', ICON.down, () => e.moveBlock(l, -1), e.blockOf(l)[0] <= 0 && !l.parent),
          act('Duplicate group', ICON.copy, () => e.duplicateLayer()),
          act('Ungroup', ICON.ungroup, () => e.ungroup(l)),
          act('Flatten group', ICON.flatten, () => e.flattenGroup(l)),
          act('Delete group', ICON.trash, () => e.deleteBlock(l), e.blockOf(l)[1] - e.blockOf(l)[0] + 1 >= e.layers.length))));
      this.updateThumbs();
      return;
    }
    const below = e.layers[e.active - 1];
    el.append(h('div', { class: 'lctl' },
      name,
      h('label', { class: 'srow' }, h('span', {}, 'Opacity'), op, opv),
      h('label', { class: 'srow' }, h('span', {}, 'Blend'), blend),
      h('div', { class: 'chips' },
        tog('Alpha lock', ICON.lock, l.alphaLock, () => e.setProp(l, 'alphaLock', !l.alphaLock)),
        tog('Clipping mask', ICON.clip, l.clip, () => e.setProp(l, 'clip', !l.clip)),
        tog('Reference', ICON.fill, this.refUid === l.uid, () => { this.refUid = this.refUid === l.uid ? null : l.uid; if (this.refUid) { this.fillSet.ref = 'reference'; this.saveFill(); } this.fill.invalidate(); this.autosave.touch(); this.renderLayers(); this.renderFillBar(); })),
      h('div', { class: 'acts' },
        act('Move up', ICON.up, () => e.moveBlock(l, 1), e.active >= e.layers.length - 1),
        act('Move down', ICON.down, () => e.moveBlock(l, -1), e.active <= 0 && !l.parent),
        act('Duplicate', ICON.copy, () => { if (!e.duplicateLayer()) this.toast('Not enough memory for another layer'); }),
        act('Merge down', ICON.merge, () => e.mergeDown(), !below || below.group || below.parent !== l.parent),
        ...(l.text && l.textVersion === l.version ? [act('Edit text', ICON.text, () => { this.closePop(); this.text.edit(l); })] : []),
        act('Fill with colour', ICON.fill, () => e.fillLayer(this.state.color)),
        act('Clear', ICON.clear, () => e.clearLayer()),
        act('Delete', ICON.trash, () => e.deleteLayer(), e.layers.length <= 1)),
    ));
    this.updateThumbs();
  }
  scheduleThumbs() {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => this.updateThumbs(), 200);
  }
  updateThumbs() {
    if (this.popKind !== 'layers' || !this.pop) return;
    for (const l of this.engine.layers) {
      if (this.thumbVersions.get(l.id) === l.version) continue;
      const cv = this.pop.querySelector(`canvas[data-id="${l.id}"]`) as HTMLCanvasElement | null;
      if (!cv) continue;
      this.engine.thumbnail(l as Layer, cv);
      this.thumbVersions.set(l.id, l.version);
    }
  }

  // ---------------------------------------------------------------- menu, sheets, export
  renderMenu(el: HTMLElement) {
    const item = (label: string, fn: () => void, sub = '') => h('button', { class: 'mitem', onClick: () => { this.closePop(); fn(); } }, h('span', {}, label), sub ? h('span', { class: 'muted' }, sub) : null);
    const e = this.engine;
    el.append(...[
      h('div', { class: 'pop-head' }, h('b', {}, this.autosave.meta?.name || 'Canvas'), h('span', { class: 'muted' }, `${e.w} × ${e.h}`)),
      item('Gallery', () => this.showGallery(), { saved: 'Saved', pending: 'Saving soon', saving: 'Saving…', error: 'Not saved' }[this.autosave.state]),
      item('Rename…', () => void this.renameCurrent()),
      item('New canvas…', () => this.showNewCanvas(false)),
      item('Insert a photo', () => this.importPhoto(), 'move · scale · rotate'),
      item(this.ref.open ? 'Reference: on' : 'Reference window', () => this.ref.toggle(), 'whole canvas or an image · pick colours'),
      item('Add text', () => { if (!this.text.active) this.text.arm(); }, 'system and bundled fonts'),
      item('Export PNG', () => this.exportPNG()),
      item('Export PNG (transparent)', () => this.exportPNG(false)),
      item(this.anim.on ? 'Animation: on' : 'Animation', () => { this.anim.toggle(); $('#bAnim').classList.toggle('on', this.anim.on); }, 'frames, onion skin, playback'),
      this.anim.on ? item('Export animation…', () => this.showAnimExport(), 'GIF · MP4 · WebM · PNG frames') : null,
      item('Time-lapse', () => this.openTimelapse(), this.tl.enabled ? `${this.tl.frames} steps recorded` : 'recording paused'),
      item('Export .gesso file', () => void this.exportGessoFile(), 'layers kept · opens in Krita as .ora'),
      item('Import .gesso / .ora…', () => this.importGessoFile()),
      item('Fit canvas to screen', () => this.fit()),
      item('Full screen', () => document.documentElement.requestFullscreen?.().catch(() => {})),
      this.installEvt ? item('Install Gesso app', () => this.installEvt.prompt()) : null,
      item('Settings', () => this.showSettings()),
      item('Gestures & help', () => this.showHelp()),
    ].filter(Boolean) as HTMLElement[]);
  }

  showAnimExport() {
    this.settle(); this.anim.stop();
    const { body, close } = this.sheet('Export animation');
    exportSheet(body, this.anim, this.engine, (b, n, t) => this.download(b, n, t), (m) => this.toast(m), () => this.autosave.meta?.name || 'Gesso animation', close);
  }

  openTimelapse() {
    this.settle();
    if (this.tlView) return;
    this.tlView = new TimelapseView({
      engine: this.engine, recorder: this.tl,
      docName: () => this.autosave.meta?.name || 'Gesso',
      download: (b, n, t) => this.download(b, n, t),
      toast: (m) => this.toast(m),
      closed: () => { this.tlView = null; this.autosave.touch(); },
    });
  }

  sheet(title: string) {
    const body = h('div', { class: 'sheet-body' });
    const close = () => wrap.remove();
    const wrap = h('div', { class: 'sheet-wrap', onClick: (ev: Event) => { if (ev.target === wrap) close(); } },
      h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('b', {}, title), h('button', { class: 'btn ghost', onClick: close }, 'Done')), body));
    document.body.append(wrap);
    return { body, close };
  }

  showNewCanvas(first: boolean) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const sw = Math.round(screen.width * dpr), sh = Math.round(screen.height * dpr);
    const landscape = innerWidth > innerHeight;
    const scr = landscape ? [Math.max(sw, sh), Math.min(sw, sh)] : [Math.min(sw, sh), Math.max(sw, sh)];
    const presets: [string, number, number][] = [
      ['Screen size', scr[0], scr[1]],
      ['Square', 2048, 2048],
      ['HD 1080p', 1920, 1080],
      ['4K', 3840, 2160],
      ['A4 · 300 dpi', 2480, 3508],
      ['Instagram post', 1080, 1350],
      ['Phone wallpaper', 1440, 3120],
    ];
    const s = this.sheet(first ? 'Welcome to Gesso — new canvas' : 'New canvas');
    const w = h('input', { type: 'number', value: 2048, min: 16, max: this.engine.maxTex }) as HTMLInputElement;
    const hh = h('input', { type: 'number', value: 2048, min: 16, max: this.engine.maxTex }) as HTMLInputElement;
    const info = h('div', { class: 'muted' });
    const upd = () => { info.textContent = `Layers and frames use memory only where painted · max side ${this.engine.maxTex}px`; };
    w.oninput = hh.oninput = upd; upd();
    const go = (W: number, H: number) => {
      s.close(); this.newCanvas(W, H);
    };
    s.body.append(
      h('div', { class: 'presets' }, ...presets.map(([n, W, H]) => h('button', { class: 'preset', onClick: () => go(W, H) },
        h('span', { class: 'pv', style: `aspect-ratio:${W}/${H}` }), h('b', {}, n), h('span', { class: 'muted' }, `${W} × ${H}`)))),
      h('div', { class: 'custom' }, h('span', {}, 'Custom'), w, h('span', {}, '×'), hh, h('button', { class: 'btn', onClick: () => go(+w.value, +hh.value) }, 'Create')),
      info,
    );
  }

  showSettings() {
    const s = this.sheet('Settings');
    const st = this.state.settings;
    const seg = h('div', { class: 'chips' });
    const drawSeg = () => {
      seg.innerHTML = '';
      for (const [v, label] of [['auto', 'Auto (stylus found → fingers navigate)'], ['pen', 'Stylus only'], ['any', 'Fingers draw too']] as const)
        seg.append(h('button', { class: 'chip' + (st.stylus === v ? ' on' : ''), onClick: () => { st.stylus = v; this.input.stylusMode = v; this.save(); drawSeg(); } }, label));
    };
    drawSeg();
    const pres = pressureSection(this.curve, st.curve, (c) => { st.curve = c; this.save(); });
    const rail = h('input', { type: 'checkbox' }) as HTMLInputElement;
    rail.checked = !st.leftRail;
    rail.onchange = () => { st.leftRail = !rail.checked; $('#rail').classList.toggle('right', rail.checked); this.save(); };
    s.body.append(
      h('section', {}, h('h4', {}, 'Touch & stylus'), seg, h('p', { class: 'muted' }, 'Palm rejection: in Auto, once Gesso sees your stylus, fingers only pan, zoom, rotate, undo and pick colours. Large contact patches (a resting palm) are always ignored.')),
      pres,
      (() => {
        const on = h('input', { type: 'checkbox' }) as HTMLInputElement; on.checked = st.snapShapes;
        on.onchange = () => { st.snapShapes = on.checked; this.save(); };
        const d = h('input', { type: 'range', min: 250, max: 1200, step: 50, value: st.snapDelay }) as HTMLInputElement;
        const dv = h('span', { class: 'sv' }, st.snapDelay + ' ms');
        d.oninput = () => { st.snapDelay = +d.value; this.shapes.delay = st.snapDelay; dv.textContent = d.value + ' ms'; this.save(); };
        return h('section', {}, h('h4', {}, 'Shape snapping'),
          h('label', { class: 'srow' }, h('span', {}, 'Hold at the end of a stroke to snap it to a shape'), on),
          h('label', { class: 'srow' }, h('span', {}, 'Hold time'), d, dv),
          h('p', { class: 'muted' }, 'Lines, arcs, polylines, ellipses, circles, rectangles and polygons. Keep holding and move to resize; touch the screen with a finger for a perfect circle, square or 15° line.'));
      })(),
      (() => {
        const pr = h('input', { type: 'checkbox' }) as HTMLInputElement; pr.checked = st.predict;
        pr.onchange = () => { st.predict = pr.checked; this.save(); };
        const wm = h('input', { type: 'checkbox' }) as HTMLInputElement; wm.checked = st.wetMedia;
        wm.onchange = () => { st.wetMedia = wm.checked; this.engine.wetMedia = wm.checked; this.save(); };
        return h('section', {}, h('h4', {}, 'Brush feel'),
          h('label', { class: 'srow' }, h('span', {}, 'Predicted tip — draw slightly ahead of the pen to hide display latency'), pr),
          h('label', { class: 'srow' }, h('span', {}, 'Watercolour dries on the paper (pigment flows to the edges and settles in the grain)'), wm),
          h('div', { class: 'chips' }, h('button', { class: 'chip', onClick: () => { s.close(); this.openStylusTest(); } }, 'Stylus & palm test…')));
      })(),
      h('section', {}, h('h4', {}, 'Layout'), h('label', { class: 'srow' }, h('span', {}, 'Sidebar on the right'), rail)),
    );
  }

  openStylusTest() { this.closePop(); return openStylusTest(); }

  showHelp() {
    const s = this.sheet('Gestures');
    const rows: [string, string][] = [
      ['Two-finger tap', 'Undo'], ['Three-finger tap', 'Redo'], ['Pinch / twist with two fingers', 'Zoom, pan and rotate the canvas'],
      ['Touch & hold', 'Eyedropper (lift to pick)'], ['Two-finger touch & hold', 'Undo repeatedly'],
      ['Hold the pen still at the end of a stroke', 'Snap to a line, arc, ellipse, rectangle or polygon; add a finger for a perfect one'], ['Tap the active brush', 'Open Brush studio'],
      ['Tap the canvas with a panel open', 'Close the panel'],
      ['Keyboard', 'Ctrl+Z / Ctrl+Shift+Z, B E S tools, [ ] size, Space+drag pan, wheel zoom'],
    ];
    s.body.append(h('div', { class: 'help' }, ...rows.map(([a, b]) => h('div', { class: 'hrow' }, h('b', {}, a), h('span', {}, b)))),
      h('p', { class: 'muted' }, 'Gesso works offline once loaded. Add it to your home screen from the Brave menu → "Add to Home screen" / "Install app".'));
  }

  async exportPNG(withBg?: boolean) {
    this.toast('Exporting…');
    try {
      const e = this.engine;
      const png = await pngEncode(await e.compositePixelsAsync(withBg ?? e.bgVisible), e.w, e.h, true);
      const blob = new Blob([png as unknown as BlobPart], { type: 'image/png' });
      const name = `gesso-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
      const file = new File([blob], name, { type: 'image/png' });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 20000);
      this.toast('Saved ' + name, nav.canShare?.({ files: [file] }) ? { label: 'Share', fn: () => navigator.share({ files: [file], title: 'Gesso painting' }).catch(() => {}) } : undefined);
    } catch (err) { this.toast('Export failed: ' + (err as Error).message); }
  }

  importPhoto() {
    const inp = h('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
    inp.onchange = () => { const f = inp.files?.[0]; if (f) void this.placeImage(f, f.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Photo'); };
    inp.click();
  }

  /** decode an image and open the transform box on a new layer */
  async placeImage(blob: Blob, name: string) {
    this.settle(); this.closePop();
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
      const max = this.engine.maxTex;
      if (Math.max(bmp.width, bmp.height) > max) {
        const k = max / Math.max(bmp.width, bmp.height);
        const big = bmp;
        bmp = await createImageBitmap(big, { resizeWidth: Math.floor(big.width * k), resizeHeight: Math.floor(big.height * k), resizeQuality: 'high', premultiplyAlpha: 'none' });
        big.close();
      }
    } catch { this.toast('Could not read that image'); return; }
    const layer = this.engine.addLayerRaw(name);
    if (!layer) { bmp.close(); this.toast('Layer limit reached for this canvas size'); return; }
    const src = this.engine.sourceFromImage(bmp);
    bmp.close();
    this.startTransform(layer, src, 'insert', (commit) => {
      if (commit) this.engine.recordInsert(layer, 'Insert image'); else this.engine.removeLayerRaw(layer);
    });
  }

  startTransform(layer: Layer, src: Target, mode: 'insert' | 'replace', finish: (commit: boolean, tool: TransformTool) => void, init?: ConstructorParameters<typeof TransformTool>[5], keep: Target | null = null) {
    this.input.grab = this.xform = new TransformTool({
      engine: this.engine,
      overlayChanged: () => { this.ovDirty = true; },
      done: () => { this.input.grab = null; this.xform = null; this.ovDirty = true; },
      toast: (m) => this.toast(m),
    }, layer, src, mode, (commit, tool) => { finish(commit, tool); this.engine.freeSource(src); }, init, keep);
    this.ovDirty = true;
  }


  toast(msg: string, action?: { label: string; fn: () => void }) {
    const t = $('#toast');
    t.innerHTML = '';
    t.append(h('span', {}, msg));
    if (action) t.append(h('button', { class: 'btn small', onClick: action.fn }, action.label));
    t.classList.add('show');
    clearTimeout((t as any)._h);
    (t as any)._h = setTimeout(() => t.classList.remove('show'), action ? 5000 : 1300);
  }
  updateUndoButtons() {
    $('#bUndo')?.toggleAttribute('disabled', !this.engine.history.canUndo);
    $('#bRedo')?.toggleAttribute('disabled', !this.engine.history.canRedo);
  }

  keys() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).matches('input, select, textarea')) return;
      const k = e.key.toLowerCase();
      if (this.xform && (k === 'enter' || k === 'escape')) { e.preventDefault(); this.xform.finish(k === 'enter'); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); this.redo(); }
      else if (this.anim.on && (k === ',' || k === '.')) { this.anim.stop(); this.anim.step(k === ',' ? -1 : 1); }
      else if (this.anim.on && k === '/') this.anim.togglePlay();
      else if (k === 'b') this.pickTool('brush', true);
      else if (k === 'e') this.pickTool('eraser', true);
      else if (k === 's') this.pickTool('smudge', true);
      else if (k === '[' || k === ']') { const b = this.brushFor(this.tool); this.setBrushProp('size', Math.max(1, Math.min(500, b.size * (k === ']' ? 1.15 : 1 / 1.15)))); this.syncSliders(); }
      else if (k === ' ') { this.input.spaceDown = true; }
      else if (k === '0' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.fit(); }
    });
    window.addEventListener('keyup', (e) => { if (e.key === ' ') this.input.spaceDown = false; });
  }
}

// Canvas2D approximation of a brush, for library thumbnails
const shapeCache = new Map<string, HTMLCanvasElement>();
function drawBrushPreview(cv: HTMLCanvasElement, b: Brush) {
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, cv.width, cv.height);
  let shape = shapeCache.get(b.shape);
  if (!shape) { shape = makeShape(b.shape); shapeCache.set(b.shape, shape); }
  const W = cv.width, H = cv.height;
  const maxD = H * 0.55;
  const scale = Math.min(1, maxD / b.size);
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
  const t = tmp.getContext('2d')!;
  const N = 220;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const x = W * 0.08 + u * W * 0.84;
    const y = H / 2 + Math.sin(u * Math.PI * 2) * H * 0.2;
    const p = Math.sin(u * Math.PI);
    let d = b.size * scale * (1 - b.pressSize * (1 - (b.minSize + (1 - b.minSize) * p)));
    if (b.taperStart) d *= Math.min(1, (u * 300) / b.taperStart + 0.1);
    if (b.taperEnd) d *= Math.min(1, ((1 - u) * 300) / b.taperEnd + 0.1);
    d *= 1 - b.sizeJitter * rnd();
    const a = b.flow * (1 - b.pressOpacity * (1 - p)) * (1 - b.opacityJitter * rnd());
    const step = Math.max(1, d * b.spacing);
    if (i % Math.max(1, Math.round(step / (W * 0.84 / N))) !== 0) continue;
    t.save();
    t.globalAlpha = Math.min(1, a * 1.3);
    t.translate(x + (b.scatter ? (rnd() - 0.5) * d * b.scatter : 0), y + (b.scatter ? (rnd() - 0.5) * d * b.scatter : 0));
    const dir = b.followDir ? Math.atan(Math.cos(u * Math.PI * 2) * H * 0.4 * Math.PI / (W * 0.84)) : 0;
    t.rotate(b.angle * Math.PI / 180 + dir + (b.rotJitter ? rnd() * Math.PI * 2 * b.rotJitter : 0));
    t.scale(1, b.roundness);
    t.drawImage(shape, -d / 2, -d / 2, d, d);
    t.restore();
  }
  g.globalAlpha = b.opacity;
  g.drawImage(tmp, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#efe6d8';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

// ------------------------------------------------------------------ boot
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
(window as any).gesso = new App();
(window as any).gessoTest = { DRAG_STATS, brushes: { brushFile, parseBrushFile, addCustomBrushes, BRUSHES }, loadClip, exportClip, selectFrames, homography, exportAnimation, GifSession, buildPalette };

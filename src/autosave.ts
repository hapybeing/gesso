// Debounced autosave of the open document. Pixels are stored as 256 px tiles: only layers whose pixels changed
// since the last save are read (async PBO, no stall; tiled layers read only their tiles), and of those only the
// tiles whose content hash changed are compressed and written — a stroke on a 4K canvas writes a few tiles,
// not whole layers. Empty tiles are never stored. Properties and the thumbnail are cheap and always written.
import type { Engine } from './engine';
import { store, DocMeta, deflate, inflate } from './store';

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export class Autosave {
  docId: string | null = null;
  meta: DocMeta | null = null;
  private saved = new Map<string, number>(); // layer uid -> version stored
  private hashes = new Map<string, Map<number, number>>(); // layer uid -> tile index -> content hash stored
  /** what the last save wrote (tests / settings) */
  lastSave = { tiles: 0, bytes: 0, deleted: 0, ms: 0 };
  private timer = 0;
  state: SaveState = 'saved';
  onState: (s: SaveState) => void = () => {};
  /** extra per-document state supplied by the app at save time */
  extra: () => Record<string, unknown> = () => ({});
  /** a modal edit is in progress (transform box, shape handles): wait */
  blocked: () => boolean = () => false;
  delay = 1200;
  lastError = '';

  constructor(private engine: Engine) {
    const flush = () => { if (document.visibilityState === 'hidden') void this.flush(); };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', () => void this.flush());
  }

  private set(s: SaveState) { if (this.state !== s) { this.state = s; this.onState(s); } }

  /** something changed: save soon */
  touch() {
    if (!this.docId) return;
    this.set('pending');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), this.delay);
  }

  /** start tracking a document that was just created or loaded */
  /** hooks for per-document companions (time-lapse recorder) */
  onAttach: (meta: DocMeta, loadedClean: boolean) => void = () => {};
  onDetach: () => void = () => {};
  attach(meta: DocMeta, loadedClean: boolean) {
    this.docId = meta.id; this.meta = meta;
    this.onAttach(meta, loadedClean);
    this.saved.clear(); this.hashes.clear();
    // a document loaded from tiles knows its stored hashes; older whole-layer documents are rewritten as tiles once
    const known = loadedHashes && loadedHashes.id === meta.id ? loadedHashes.h : null;
    if (loadedClean && known) for (const l of this.engine.layers) { this.saved.set(l.uid, l.version); this.hashes.set(l.uid, known.get(l.uid) ?? new Map()); }
    loadedClean = loadedClean && !!known;
    this.set(loadedClean ? 'saved' : 'pending');
    if (!loadedClean) this.touch();
  }
  detach() { if (this.docId) this.onDetach(); clearTimeout(this.timer); this.docId = null; this.meta = null; this.saved.clear(); }

  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  /** save now. Saves are serialised; calls made while one is waiting share it. Resolves when saved. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.docId) return this.chain;
    if (this.queued) return this.queued;
    const id = this.docId;
    const p = this.chain.then(() => { this.queued = null; return this.run(id); });
    this.queued = p;
    this.chain = p.catch(() => {});
    return p;
  }

  private async run(id: string) {
    const e = this.engine;
    while (e.stroking || this.blocked()) await new Promise((r) => setTimeout(r, 150));
    if (this.docId !== id || !this.meta) return;
    const meta = this.meta;
    this.set('saving');
    try {
      // capture synchronously: layer list, versions, props, and issue all readbacks in GL order
      const layers = [...e.layers];
      const jobs = layers.filter((l) => this.saved.get(l.uid) !== l.version).map((l) => ({ l, v: l.version, p: e.readLayerTiles(l) }));
      const thumbP = e.compositeThumbnail(360);
      const m: DocMeta = { ...meta, storage: 'tiles', w: e.w, h: e.h, bg: [...e.bg] as [number, number, number], bgVisible: e.bgVisible, layers: layers.map((l) => l.props()), active: e.active, modified: Date.now(), extra: this.extra() };
      const t0 = performance.now();
      const stat = { tiles: 0, bytes: 0, deleted: 0, ms: 0 };
      for (const j of jobs) {
        const tiles = await j.p;
        const old = this.hashes.get(j.l.uid) ?? new Map<number, number>();
        const next = new Map<number, number>(), puts: [number, Blob][] = [];
        for (const [i, d] of tiles) {
          const hsh = tileHash(d);
          next.set(i, hsh);
          if (old.get(i) !== hsh) { const b = await deflate(d); puts.push([i, b]); stat.bytes += b.size; }
        }
        const dels = [...old.keys()].filter((i) => !next.has(i));
        if (this.docId !== id) return; // switched documents mid-save
        if (puts.length || dels.length) await store.putTiles(id, j.l.uid, puts, dels);
        stat.tiles += puts.length; stat.deleted += dels.length;
        this.hashes.set(j.l.uid, next);
        this.saved.set(j.l.uid, j.v);
      }
      stat.ms = Math.round(performance.now() - t0);
      this.lastSave = stat;
      const thumb = await thumbP;
      const tb = await new Promise<Blob | null>((res) => thumb.toBlob(res, 'image/webp', 0.86));
      if (tb) await store.putThumb(id, tb);
      await store.putMeta(m);
      this.meta = m;
      const uids = new Set(layers.map((l) => l.uid));
      await store.pruneTiles(id, uids);
      if (meta.storage !== 'tiles') await store.pruneLayers(id, new Set()); // converted: drop the whole-layer blobs
      for (const k of [...this.saved.keys()]) if (!uids.has(k)) { this.saved.delete(k); this.hashes.delete(k); }
      const dirty = e.layers.some((l) => this.saved.get(l.uid) !== l.version);
      this.set(dirty ? 'pending' : 'saved');
      if (dirty) this.touch();
      if (navigator.storage?.persist && !(await navigator.storage.persisted?.())) navigator.storage.persist().catch(() => {});
    } catch (err) {
      this.lastError = String((err as Error)?.message || err);
      console.info('autosave failed', this.lastError);
      this.set('error');
    }
  }
}

/** content hash of a tile (two FNV-style lanes folded into 53 bits) */
export function tileHash(d: Uint8Array): number {
  const u = new Uint32Array(d.buffer, d.byteOffset, d.byteLength >> 2);
  let a = 2166136261, b = 0x9e3779b9 ^ u.length;
  for (let i = 0; i < u.length; i++) { const x = u[i]; a = Math.imul(a ^ x, 16777619); b = Math.imul(b ^ (x >>> 7 | x << 25), 0x85ebca6b) + i; }
  return (a >>> 0) * 2097152 + ((b >>> 0) & 0x1fffff);
}
let loadedHashes: { id: string; h: Map<string, Map<number, number>> } | null = null;

/** load a stored document's pixels: tiles (current format) or whole layers (documents saved before M4) */
export async function loadDocPixels(meta: DocMeta) {
  if (meta.storage === 'tiles') {
    const all = await store.getTiles(meta.id);
    const h = new Map<string, Map<number, number>>();
    const layers = await Promise.all(meta.layers.map(async (props) => {
      const blobs = all.get(props.uid) ?? new Map<number, Blob>();
      const tiles = new Map<number, Uint8Array>(), hh = new Map<number, number>();
      await Promise.all([...blobs].map(async ([i, b]) => { const d = await inflate(b); tiles.set(i, d); hh.set(i, tileHash(d)); }));
      h.set(props.uid, hh);
      return { props, tiles, data: null };
    }));
    loadedHashes = { id: meta.id, h };
    return layers;
  }
  loadedHashes = null;
  return Promise.all(meta.layers.map(async (props) => {
    const b = await store.getLayer(meta.id, props.uid);
    return { props, data: b ? await inflate(b) : null, tiles: null };
  }));
}

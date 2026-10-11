// Debounced autosave of the open document. Only layers whose pixels changed since the last save are read
// back (async PBO, no stall) and re-compressed; properties and the thumbnail are cheap and always written.
import type { Engine } from './engine';
import { store, DocMeta, deflate, inflate } from './store';

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export class Autosave {
  docId: string | null = null;
  meta: DocMeta | null = null;
  private saved = new Map<string, number>(); // layer uid -> version stored
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
  attach(meta: DocMeta, loadedClean: boolean) {
    this.docId = meta.id; this.meta = meta;
    this.saved.clear();
    if (loadedClean) for (const l of this.engine.layers) this.saved.set(l.uid, l.version);
    this.set(loadedClean ? 'saved' : 'pending');
  }
  detach() { clearTimeout(this.timer); this.docId = null; this.meta = null; this.saved.clear(); }

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
      const jobs = layers.filter((l) => this.saved.get(l.uid) !== l.version).map((l) => ({ l, v: l.version, p: e.readLayerAsync(l) }));
      const thumbP = e.compositeThumbnail(360);
      const m: DocMeta = { ...meta, w: e.w, h: e.h, bg: [...e.bg] as [number, number, number], bgVisible: e.bgVisible, layers: layers.map((l) => l.props()), active: e.active, modified: Date.now(), extra: this.extra() };
      for (const j of jobs) {
        const data = await j.p;
        const blob = await deflate(data);
        if (this.docId !== id) return; // switched documents mid-save
        await store.putLayer(id, j.l.uid, blob);
        this.saved.set(j.l.uid, j.v);
      }
      const thumb = await thumbP;
      const tb = await new Promise<Blob | null>((res) => thumb.toBlob(res, 'image/webp', 0.86));
      if (tb) await store.putThumb(id, tb);
      await store.putMeta(m);
      this.meta = m;
      await store.pruneLayers(id, new Set(layers.map((l) => l.uid)));
      for (const k of [...this.saved.keys()]) if (!layers.some((l) => l.uid === k)) this.saved.delete(k);
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

/** load a stored document's pixels */
export async function loadDocPixels(meta: DocMeta) {
  return Promise.all(meta.layers.map(async (props) => {
    const b = await store.getLayer(meta.id, props.uid);
    return { props, data: b ? await inflate(b) : null };
  }));
}

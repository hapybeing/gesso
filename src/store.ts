// IndexedDB persistence: document metadata, per-layer pixel blobs (deflated premultiplied RGBA), thumbnails.
import type { LayerProps } from './engine';

export interface DocMeta {
  id: string;
  name: string;
  w: number; h: number;
  bg: [number, number, number];
  bgVisible: boolean;
  layers: LayerProps[];
  active: number;
  created: number;
  modified: number;
  /** extra per-document state (symmetry guide etc.) */
  extra?: Record<string, unknown>;
  /** 'tiles': pixels stored as 256 px tiles (docId/uid/index); absent: one blob per layer (before M4) */
  storage?: 'tiles';
}

/** a batch of recorded time-lapse frames (one encoder segment can span many packs) */
export interface TlPack {
  seg: number;
  /** WebCodecs decoder config of the segment (description as bytes), or kind 'img' for the image fallback */
  config: { codec: string; codedWidth: number; codedHeight: number; description?: Uint8Array } | null;
  w: number; h: number;
  frames: { key: boolean; data: ArrayBuffer; area: number }[];
}

const DB = 'gesso', VER = 4;
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('layers')) d.createObjectStore('layers');
      if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs');
      if (!d.objectStoreNames.contains('tiles')) d.createObjectStore('tiles'); // docId/uid/tileIndex -> deflated RGBA
      if (!d.objectStoreNames.contains('tl')) d.createObjectStore('tl'); // time-lapse packs: docId/seq
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets'); // v4: per-document blobs (audio): docId/name
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const d = await db();
  const t = d.transaction(stores, mode);
  const done = new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); });
  const out = await fn(t);
  await done;
  return out;
}
const range = (docId: string) => IDBKeyRange.bound(docId + '/', docId + '/\uffff');

export const store = {
  async list(): Promise<DocMeta[]> {
    const all = await tx(['docs'], 'readonly', (t) => req(t.objectStore('docs').getAll() as IDBRequest<DocMeta[]>));
    return all.sort((a, b) => b.modified - a.modified);
  },
  get: (id: string) => tx(['docs'], 'readonly', (t) => req(t.objectStore('docs').get(id) as IDBRequest<DocMeta | undefined>)),
  putMeta: (m: DocMeta) => tx(['docs'], 'readwrite', (t) => req(t.objectStore('docs').put(m))).then(() => {}),
  putLayer: (docId: string, uid: string, blob: Blob) => tx(['layers'], 'readwrite', (t) => req(t.objectStore('layers').put(blob, docId + '/' + uid))).then(() => {}),
  getLayer: (docId: string, uid: string) => tx(['layers'], 'readonly', (t) => req(t.objectStore('layers').get(docId + '/' + uid) as IDBRequest<Blob | undefined>)),
  /** write and delete tiles of one layer in a single transaction */
  putTiles: (docId: string, uid: string, puts: [number, Blob][], dels: number[]) => tx(['tiles'], 'readwrite', (t) => {
    const os = t.objectStore('tiles'), k = docId + '/' + uid + '/';
    for (const [i, b] of puts) os.put(b, k + i);
    for (const i of dels) os.delete(k + i);
  }).then(() => {}),
  /** every stored tile of a document, grouped by layer uid */
  async getTiles(docId: string): Promise<Map<string, Map<number, Blob>>> {
    const out = new Map<string, Map<number, Blob>>();
    await tx(['tiles'], 'readonly', async (t) => {
      const os = t.objectStore('tiles');
      const [keys, vals] = await Promise.all([req(os.getAllKeys(range(docId))), req(os.getAll(range(docId)) as IDBRequest<Blob[]>)]);
      keys.forEach((k, j) => {
        const [, uid, idx] = String(k).split('/');
        let m = out.get(uid); if (!m) out.set(uid, (m = new Map()));
        m.set(+idx, vals[j]);
      });
    });
    return out;
  },
  /** remove tiles of layers that are not in keep */
  async pruneTiles(docId: string, keep: Set<string>) {
    await tx(['tiles'], 'readwrite', async (t) => {
      const os = t.objectStore('tiles');
      const keys = await req(os.getAllKeys(range(docId)));
      for (const k of keys) if (!keep.has(String(k).split('/')[1])) os.delete(k);
    });
  },
  putThumb: (docId: string, blob: Blob) => tx(['thumbs'], 'readwrite', (t) => req(t.objectStore('thumbs').put(blob, docId))).then(() => {}),
  getThumb: (docId: string) => tx(['thumbs'], 'readonly', (t) => req(t.objectStore('thumbs').get(docId) as IDBRequest<Blob | undefined>)),
  /** remove layer blobs of a document that are not in keep */
  async pruneLayers(docId: string, keep: Set<string>) {
    await tx(['layers'], 'readwrite', async (t) => {
      const os = t.objectStore('layers');
      const keys = await req(os.getAllKeys(range(docId)));
      for (const k of keys) if (!keep.has(String(k).slice(docId.length + 1))) os.delete(k);
    });
  },
  /** time-lapse: packs of encoded frames, keyed docId/00000001 */
  putTl: (docId: string, seq: number, pack: TlPack) => tx(['tl'], 'readwrite', (t) => req(t.objectStore('tl').put(pack, docId + '/' + String(seq).padStart(8, '0')))).then(() => {}),
  getTl: (docId: string) => tx(['tl'], 'readonly', (t) => req(t.objectStore('tl').getAll(range(docId)) as IDBRequest<TlPack[]>)),
  countTl: (docId: string) => tx(['tl'], 'readonly', (t) => req(t.objectStore('tl').count(range(docId)))),
  /** next pack number and the last segment id recorded for a document */
  async lastTl(docId: string): Promise<{ next: number; seg: number }> {
    return tx(['tl'], 'readonly', (t) => new Promise((res, rej) => {
      const r = t.objectStore('tl').openCursor(range(docId), 'prev');
      r.onsuccess = () => { const c = r.result; if (!c) res({ next: 0, seg: -1 }); else res({ next: parseInt(String(c.key).slice(docId.length + 1), 10) + 1, seg: (c.value as TlPack).seg }); };
      r.onerror = () => rej(r.error);
    }));
  },
  /** per-document blobs (the animation's audio): docId/name */
  putAsset: (docId: string, name: string, b: Blob) => tx(['assets'], 'readwrite', (t) => req(t.objectStore('assets').put(b, docId + '/' + name))).then(() => {}),
  getAsset: (docId: string, name: string) => tx(['assets'], 'readonly', (t) => req(t.objectStore('assets').get(docId + '/' + name) as IDBRequest<Blob | undefined>)),
  deleteAsset: (docId: string, name: string) => tx(['assets'], 'readwrite', (t) => req(t.objectStore('assets').delete(docId + '/' + name))).then(() => {}),
  clearTl: (docId: string) => tx(['tl'], 'readwrite', (t) => req(t.objectStore('tl').delete(range(docId)))).then(() => {}),
  async remove(docId: string) {
    await tx(['docs', 'layers', 'tiles', 'thumbs', 'tl', 'assets'], 'readwrite', (t) => {
      t.objectStore('assets').delete(range(docId));
      t.objectStore('tiles').delete(range(docId));
      t.objectStore('tl').delete(range(docId));
      t.objectStore('docs').delete(docId);
      t.objectStore('layers').delete(range(docId));
      t.objectStore('thumbs').delete(docId);
    });
  },
  async duplicate(docId: string, newId: string, name: string): Promise<DocMeta | null> {
    const m = await store.get(docId);
    if (!m) return null;
    const now = Date.now();
    const copy: DocMeta = { ...structuredClone(m), id: newId, name, created: now, modified: now };
    await tx(['docs', 'layers', 'tiles', 'thumbs', 'tl', 'assets'], 'readwrite', async (t) => {
      const as = t.objectStore('assets');
      const ak = await req(as.getAllKeys(range(docId)));
      const av = await req(as.getAll(range(docId)));
      ak.forEach((k, i) => as.put(av[i], newId + String(k).slice(docId.length)));
      const ts = t.objectStore('tiles');
      const tik = await req(ts.getAllKeys(range(docId)));
      const tiv = await req(ts.getAll(range(docId)));
      tik.forEach((k, i) => ts.put(tiv[i], newId + String(k).slice(docId.length)));
      const tl = t.objectStore('tl');
      const tk = await req(tl.getAllKeys(range(docId)));
      const tv = await req(tl.getAll(range(docId)));
      tk.forEach((k, i) => tl.put(tv[i], newId + String(k).slice(docId.length)));
      const ls = t.objectStore('layers');
      const keys = await req(ls.getAllKeys(range(docId)));
      const vals = await req(ls.getAll(range(docId)));
      keys.forEach((k, i) => ls.put(vals[i], newId + String(k).slice(docId.length)));
      const th = await req(t.objectStore('thumbs').get(docId));
      if (th) t.objectStore('thumbs').put(th, newId);
      t.objectStore('docs').put(copy);
    });
    return copy;
  },
  async usage(): Promise<{ used: number; quota: number; persisted: boolean } | null> {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    const persisted = (await navigator.storage.persisted?.()) ?? false;
    return { used: e.usage || 0, quota: e.quota || 0, persisted };
  },
};

export const newDocId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ------------------------------------------------------------------ compression helpers
export async function deflate(data: Uint8Array): Promise<Blob> {
  const cs = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return await new Response(cs).blob();
}
export async function inflate(blob: Blob): Promise<Uint8Array> {
  const ds = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}

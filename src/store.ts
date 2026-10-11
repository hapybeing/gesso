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
}

const DB = 'gesso', VER = 1;
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('layers')) d.createObjectStore('layers');
      if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs');
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
  async remove(docId: string) {
    await tx(['docs', 'layers', 'thumbs'], 'readwrite', (t) => {
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
    await tx(['docs', 'layers', 'thumbs'], 'readwrite', async (t) => {
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

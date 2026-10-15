// Saved selections (M5.6): name and keep any selection with the artwork, load it back later (one undo step).
// Bar: the leading iPad app's selection toolbar has "Save & Load" with a list of thumbnails per document;
// Krita keeps selection masks as layers; Photoshop has Save/Load Selection (alpha channels). Gesso: the mask is
// read back once, deflated (a hard-edged mask is mostly runs, ~1–3 % of its raw size) and stored per artwork in
// IndexedDB and inside .gesso (gesso/selections/<id>); the list keeps a 64 px thumbnail.
import { store } from './store';

export interface SavedSel { id: string; name: string; w: number; h: number; thumb: string; bytes: number; }

export async function deflate(u: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([u as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function inflate(u: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([u as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
/** 64 px thumbnail of a mask (GL rows are bottom-up: drawn flipped so it reads upright) */
export function maskThumb(m: Uint8Array, w: number, h: number): string {
  const k = 64 / Math.max(w, h), tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas'); c.width = tw; c.height = th;
  const g = c.getContext('2d')!, img = g.createImageData(tw, th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const sx = Math.min(w - 1, Math.floor((x + 0.5) / k)), sy = Math.min(h - 1, Math.floor((th - 1 - y + 0.5) / k));
    const v = m[sy * w + sx], i = (y * tw + x) * 4;
    img.data[i] = 232; img.data[i + 1] = 165; img.data[i + 2] = 75; img.data[i + 3] = Math.max(28, v);
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}
export async function putSel(docId: string, id: string, m: Uint8Array) { const z = await deflate(m); await store.putAsset(docId, 'sel-' + id, new Blob([z as BlobPart])); return z.length; }
export async function getSel(docId: string, id: string): Promise<Uint8Array | null> { const b = await store.getAsset(docId, 'sel-' + id); return b ? inflate(new Uint8Array(await b.arrayBuffer())) : null; }
export async function delSel(docId: string, id: string) { await store.deleteAsset(docId, 'sel-' + id); }

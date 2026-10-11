// Promise wrapper around worker.js, with a main-thread fallback if workers are unavailable.
import { encodePNG, unpremultiply } from './gessofile';

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, { res: (b: Uint8Array) => void; rej: (e: Error) => void }>();
function get(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const v = (document.querySelector('script[src*="app.js"]') as HTMLScriptElement | null)?.src.split('?')[1] || '';
    worker = new Worker('worker.js' + (v ? '?' + v : ''));
    worker.onmessage = (ev) => { const p = pending.get(ev.data.id); if (!p) return; pending.delete(ev.data.id); ev.data.error ? p.rej(new Error(ev.data.error)) : p.res(ev.data.png); };
    worker.onerror = () => { for (const p of pending.values()) p.rej(new Error('worker failed')); pending.clear(); worker = null; };
  } catch { worker = null; }
  return worker;
}
/** PNG-encode RGBA pixels (top row first). premul = input is premultiplied. The input buffer is transferred. */
export function pngEncode(px: Uint8Array, w: number, h: number, premul: boolean): Promise<Uint8Array> {
  const wk = get();
  if (!wk) return encodePNG(premul ? unpremultiply(px) : px, w, h);
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej: (e) => { encodePNG(premul ? unpremultiply(px) : px, w, h).then(res, () => rej(e)); } });
    wk.postMessage({ id, op: 'png', px, w, h, premul }, [px.buffer]);
  });
}

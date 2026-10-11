// Promise wrapper around worker.js, with a main-thread fallback if workers are unavailable.
import { encodePNG, unpremultiply } from './gessofile';
import { GifSession, GifOpts } from './gif';

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

function call(op: string, payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<Uint8Array> {
  const wk = get()!;
  return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); wk.postMessage({ id, op, ...payload }, transfer); });
}
/** GIF encoder in the worker (or on the main thread when workers are unavailable) */
export function gifEncoder(opts: GifOpts) {
  const wk = get();
  if (!wk) {
    const s = new GifSession(opts);
    return { sample: async (px: Uint8Array, premul: boolean) => s.sample(px, premul), frame: async (px: Uint8Array, premul: boolean, delay: number) => s.frame(px, premul, delay), end: async () => s.end() };
  }
  const begun = call('gif-begin', { opts });
  return {
    sample: async (px: Uint8Array, premul: boolean) => { await begun; await call('gif-sample', { px, premul }, [px.buffer]); },
    frame: async (px: Uint8Array, premul: boolean, delay: number) => { await begun; await call('gif-frame', { px, premul, delay }, [px.buffer]); },
    end: async () => { await begun; return call('gif-end', {}); },
  };
}

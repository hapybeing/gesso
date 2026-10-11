// Background worker: un-premultiply + PNG encode, and animated GIF encoding, off the main thread.
import { encodePNG, unpremultiply } from './gessofile';
import { GifSession } from './gif';

let gif: GifSession | null = null;
self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  const post = (x: Record<string, unknown>, tr: Transferable[] = []) => (self as unknown as Worker).postMessage({ id: m.id, ...x }, tr);
  try {
    if (m.op === 'png') { const png = await encodePNG(m.premul ? unpremultiply(m.px) : m.px, m.w, m.h); post({ png }, [png.buffer]); }
    else if (m.op === 'gif-begin') { gif = new GifSession(m.opts); post({}); }
    else if (m.op === 'gif-sample') { gif!.sample(m.px, m.premul); post({}); }
    else if (m.op === 'gif-frame') { gif!.frame(m.px, m.premul, m.delay); post({}); }
    else if (m.op === 'gif-end') { const out = gif!.end(); gif = null; post({ png: out }, [out.buffer]); }
  } catch (err) {
    post({ error: String((err as Error)?.message || err) });
  }
};

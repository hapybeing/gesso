// Background worker: un-premultiply + PNG encode off the main thread (export, .gesso packing).
import { encodePNG, unpremultiply } from './gessofile';

interface Req { id: number; op: 'png'; px: Uint8Array; w: number; h: number; premul: boolean; }
self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, px, w, h, premul } = ev.data;
  try {
    const png = await encodePNG(premul ? unpremultiply(px) : px, w, h);
    (self as unknown as Worker).postMessage({ id, png }, [png.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message || err) });
  }
};

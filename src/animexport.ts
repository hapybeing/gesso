// Animation export: GIF (own encoder in the worker), MP4 / WebM (WebCodecs + own muxers; one encoded cycle repeated
// by reusing its samples), and a PNG sequence in a zip (holds expanded into repeated files for frame-exact import).
import type { Engine } from './engine';
import type { Animator } from './animation';
import { evenFit, pickEncoder, VideoWriter, mux, hasWebCodecs } from './video';
import { gifEncoder, pngEncode } from './workerclient';
import { gifDelays } from './gif';
import { zipWrite } from './gessofile';
import { h } from './dom';
import { encodeAudio } from './animaudio';

export type AnimFormat = 'gif' | 'mp4' | 'webm' | 'png';
export interface AnimExportOpts { format: AnimFormat; maxSide: number; repeat: number; dither: boolean; transparent: boolean; /** mux the audio track into MP4/WebM (default on when there is one) */ audio?: boolean; }
export interface AnimExportResult { blob: Blob; ext: string; w: number; h: number; frames: number; seconds: number; ms: number; codec?: string; audioCodec?: string; }

export async function exportAnimation(anim: Animator, e: Engine, o: AnimExportOpts, progress: (t: number) => void = () => {}): Promise<AnimExportResult> {
  const t0 = performance.now();
  const fr = anim.frames();
  if (!fr.length) throw new Error('No frames to export');
  const runs = anim.runs(fr);
  const fps = anim.st.fps;
  const durs = runs.map(([, n]) => (n * 1e6) / fps);
  const seconds = durs.reduce((a, b) => a + b, 0) / 1e6;
  const k = Math.min(1, o.maxSide / Math.max(e.w, e.h));
  let w = Math.max(1, Math.round(e.w * k)), hh = Math.max(1, Math.round(e.h * k));
  const transparent = o.transparent && (o.format === 'gif' || o.format === 'png');
  const render = (i: number, W = w, H = hh) => e.captureScaled(W, H, transparent ? { list: anim.list(i, false, fr), withBg: false, flatten: null } : { list: anim.list(i, false, fr), flatten: e.flattenColour });
  const done = (blob: Blob, ext: string, frames: number, codec?: string): AnimExportResult => ({ blob, ext, w, h: hh, frames, seconds: seconds * (o.format === 'mp4' || o.format === 'webm' ? Math.max(1, o.repeat) : 1), ms: performance.now() - t0, codec });

  if (o.format === 'gif') {
    const loop = anim.st.mode !== 'oneshot';
    const enc = gifEncoder({ w, h: hh, dither: o.dither, transparent, loop });
    // pass 1: small renders of each distinct frame for one shared palette
    const uniq = [...new Set(runs.map(([i]) => i))];
    const sk = Math.min(1, 220 / Math.max(w, hh)), sw = Math.max(1, Math.round(w * sk)), sh = Math.max(1, Math.round(hh * sk));
    for (const [n, i] of uniq.entries()) { await enc.sample(await render(i, sw, sh), transparent); progress((0.2 * (n + 1)) / uniq.length); }
    // pass 2: full frames, one GIF frame per run (holds become longer delays)
    const delays = gifDelays(durs);
    for (const [n, [i]] of runs.entries()) { await enc.frame(await render(i), transparent, delays[n]); progress(0.2 + (0.8 * (n + 1)) / runs.length); }
    const bytes = await enc.end();
    return done(new Blob([bytes as BlobPart], { type: 'image/gif' }), 'gif', runs.length);
  }
  if (o.format === 'png') {
    const entries: { name: string; data: Uint8Array; deflate?: boolean }[] = [];
    const cache = new Map<number, Uint8Array>();
    const total = runs.reduce((s, [, n]) => s + n, 0);
    let t = 0;
    for (const [i, n] of runs) {
      let png = cache.get(i);
      if (!png) { png = await pngEncode(await render(i), w, hh, transparent); cache.set(i, png); }
      for (let r = 0; r < n; r++) entries.push({ name: `frame_${String(++t).padStart(4, '0')}.png`, data: png });
      progress(t / total);
    }
    return done(await zipWrite(entries), 'zip', total);
  }
  // video
  if (!hasWebCodecs()) throw new Error('Video export needs a browser with WebCodecs — try GIF');
  ({ w, h: hh } = evenFit(e.w * k, e.h * k, 4096, 4096));
  const cfg = await pickEncoder(w, hh, o.format === 'mp4' ? ['avc', 'vp9'] : ['vp9', 'vp8']);
  if (!cfg) throw new Error(`This device cannot encode ${o.format.toUpperCase()} at ${w}×${hh}`);
  const writer = new VideoWriter(cfg, Math.max(1, Math.round(fps * 2)));
  try {
    for (const [n, [i]] of runs.entries()) { await writer.addRGBA(await render(i), w, hh, durs[n], n === 0); progress((n + 1) / runs.length); }
    const { track, samples } = await writer.finish();
    // the cycle starts on a keyframe, so repeats can reuse its samples unchanged
    const all = Array.from({ length: Math.max(1, o.repeat) }, () => samples).flat();
    // audio as heard in playback: restarted every cycle, rendered for every repeat, then encoded once
    let at = null;
    if (o.audio !== false && anim.audio?.ready) {
      const buf = await anim.audio.render(seconds, Math.max(1, o.repeat));
      at = buf ? await encodeAudio(buf, o.format) : null;
    }
    const r = done(mux(o.format, track, all, at ?? undefined), o.format, all.length, cfg.codec);
    r.audioCodec = at?.info.codec;
    return r;
  } catch (err) { writer.close(); throw err; }
}

/** export sheet: format, size, repeat / dither / transparency, then progress */
export function exportSheet(body: HTMLElement, anim: Animator, e: Engine, save: (b: Blob, name: string, type: string) => void, toast: (m: string) => void, name: () => string, close: () => void) {
  const o: AnimExportOpts = { format: (localStorage.getItem('gesso.animfmt') as AnimFormat) || 'gif', maxSide: 720, repeat: 1, dither: true, transparent: false };
  const big = Math.max(e.w, e.h);
  const draw = () => {
    body.innerHTML = '';
    const seg = <T extends string | number>(opts: [T, string][], cur: T, fn: (v: T) => void) => h('div', { class: 'chips' }, ...opts.map(([v, l]) => h('button', { class: 'chip' + (v === cur ? ' on' : ''), onClick: () => { fn(v); draw(); } }, l)));
    const fr = anim.frames(), runs = anim.runs(fr), secs = runs.reduce((s, [, n]) => s + n, 0) / anim.st.fps;
    const sizes = [[big, `Full · ${e.w}×${e.h}`], [1080, '1080'], [720, '720'], [480, '480'], [320, '320']].filter(([v], i) => i === 0 || (v as number) < big) as [number, string][];
    if (!sizes.some(([v]) => v === o.maxSide)) o.maxSide = sizes[Math.min(2, sizes.length - 1)][0];
    body.append(...[
      h('p', { class: 'muted' }, `${fr.length} frames · ${anim.st.fps} fps · ${secs.toFixed(2)} s per cycle · ${({ loop: 'loops', pingpong: 'ping-pong', oneshot: 'plays once' } as const)[anim.st.mode]}`),
      h('section', {}, h('h4', {}, 'Format'), seg<AnimFormat>([['gif', 'GIF'], ['mp4', 'MP4'], ['webm', 'WebM'], ['png', 'PNG frames (.zip)']], o.format, (v) => { o.format = v; try { localStorage.setItem('gesso.animfmt', v); } catch { /* */ } })),
      h('section', {}, h('h4', {}, 'Size (longest side)'), seg<number>(sizes, o.maxSide, (v) => { o.maxSide = v; })),
      o.format === 'mp4' || o.format === 'webm' ? h('section', {}, h('h4', {}, 'Repeat'), seg<number>([[1, 'Once'], [2, '×2'], [4, '×4'], [8, '×8']], o.repeat, (v) => { o.repeat = v; }), h('p', { class: 'muted' }, 'Short loops play better on social apps when repeated. Repeats cost no extra encoding.')) : null,
      (o.format === 'mp4' || o.format === 'webm') && anim.audio?.ready ? h('section', {}, h('h4', {}, 'Audio'), seg<number>([[1, 'Include “' + anim.audio.meta!.name + '”'], [0, 'Silent']], o.audio === false ? 0 : 1, (v) => { o.audio = !!v; })) : null,
      o.format === 'gif' ? h('section', {}, h('h4', {}, 'Colours'), seg<number>([[1, 'Dithered (smooth gradients)'], [0, 'Flat (crisp, smaller)']], o.dither ? 1 : 0, (v) => { o.dither = !!v; }), anim.st.fps > 50 ? h('p', { class: 'muted' }, 'GIF timing tops out at 50 fps; faster animations will play at 50.') : null) : null,
      o.format === 'gif' || o.format === 'png' ? h('section', {}, h('h4', {}, 'Background'), seg<number>([[0, 'Include background'], [1, 'Transparent']], o.transparent ? 1 : 0, (v) => { o.transparent = !!v; })) : null,
    ].filter(Boolean) as HTMLElement[]);
    const bar = h('div', { class: 'tl-progress' }, h('i', {}));
    const go = h('button', { class: 'btn', onClick: async () => {
      go.setAttribute('disabled', ''); body.append(bar);
      try {
        const r = await exportAnimation(anim, e, o, (t) => { (bar.firstChild as HTMLElement).style.width = Math.round(t * 100) + '%'; });
        (window as any).__lastAnimExport = r;
        save(r.blob, `${name()}.${r.ext}`, r.blob.type);
        close();
      } catch (err) { toast(String((err as Error).message || err)); go.removeAttribute('disabled'); bar.remove(); }
    } }, 'Export');
    body.append(h('div', { class: 'dlg-acts' }, go));
  };
  draw();
}

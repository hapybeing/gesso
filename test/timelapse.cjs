// Time-lapse: a frame per committed step, persisted across reloads, replay with scrubbing, MP4/WebM export
// (direct mux and transcode), short-version frame selection. Output files are checked with ffprobe.
const { start } = require('./lib.cjs');
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const helpers = () => {
  const cv = document.querySelector('#view');
  window.__ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
  window.__stroke = (pts) => {
    __ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: pts[0][0], clientY: pts[0][1], pressure: 0.7, buttons: 1 });
    for (const [x, y, p] of pts.slice(1)) __ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: x, clientY: y, pressure: p ?? 0.7, buttons: 1 });
    const l = pts[pts.length - 1]; __ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: l[0], clientY: l[1], pressure: 0, buttons: 0 });
  };
  window.__wave = (x0, y0, len, amp, n = 30) => { const p = []; for (let i = 0; i <= n; i++) { const t = i / n; p.push([x0 + t * len, y0 + Math.sin(t * Math.PI * 2) * amp, 0.3 + 0.6 * Math.sin(Math.PI * t)]); } return p; };
  window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__paint = async (n, seed = 0) => { const g = window.gesso; g.state.toolBrush.brush = 'marker-felt'; g.tool = 'brush';
    for (let i = 0; i < n; i++) { const k = i + seed; g.state.color = [(k * 0.37) % 1, (k * 0.61) % 1, (k * 0.23) % 1]; __stroke(__wave(80 + (k * 37) % 500, 80 + (k * 53) % 520, 200 + (k * 29) % 300, 30 + (k % 5) * 12)); await __sleep(140); } };
  window.__b64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
};
const probe = (f) => JSON.parse(execSync(`ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,nb_read_frames:format=duration,format_name -of json "${f}"`).toString());
(async () => {
  const T = await start({ port: 8140, dsf: 1.5 });
  const { page } = T;
  const out = {};
  await page.goto(T.url + '?w=1600&h=1000');
  await page.waitForTimeout(900);
  await page.evaluate(helpers);
  await page.evaluate(() => __paint(24));
  await page.evaluate(async () => { window.gesso.undo(); await __sleep(300); await window.gesso.tl.flush(); });
  out.session1 = await page.evaluate(() => { const t = window.gesso.tl; return { frames: t.frames, captures: t.stats.captures, avgMainMs: +(t.stats.mainMs / t.stats.captures).toFixed(2), bytes: t.stats.bytes, kb_per_frame: +(t.stats.bytes / t.frames / 1024).toFixed(1) }; });
  // reload: the same artwork reopens and recording continues in a new segment
  await page.goto(T.url);
  await page.waitForTimeout(1500);
  await page.evaluate(helpers);
  await page.evaluate(() => __paint(6, 40));
  await page.evaluate(() => { window.__firstDoc = window.gesso.tl.docId; });
  await page.evaluate(() => window.gesso.tl.flush());
  out.session2 = await page.evaluate(async () => { const c = await window.gessoTest.loadClip(window.gesso.tl.docId); return { frames: c.frames.length, segments: c.configs.size, codec: [...c.configs.values()][0].codec, size: [c.w, c.h], keys: c.frames.filter((f) => f.key).length }; });
  // exports
  const dir = path.join(__dirname, '..', 'shots');
  for (const [name, short, fmt, force] of [['full.webm', false, 'webm', false], ['full.mp4', false, 'mp4', false], ['transcoded.webm', false, 'webm', true], ['transcoded.mp4', false, 'mp4', true]]) {
    const r = await page.evaluate(async ([short, fmt, force]) => { const c = await window.gessoTest.loadClip(window.gesso.tl.docId); const r = await window.gessoTest.exportClip(c, short, fmt, () => {}, force); return { b64: await __b64(r.blob), ms: Math.round(r.ms), frames: r.frames, seconds: r.seconds, transcoded: r.transcoded, codec: r.codec }; }, [short, fmt, force]);
    const f = path.join(dir, 'tl-' + name); fs.writeFileSync(f, Buffer.from(r.b64, 'base64'));
    const p = probe(f);
    out[name] = { ms: r.ms, transcoded: r.transcoded, codec: r.codec, bytes: fs.statSync(f).size, probe: { codec: p.streams[0].codec_name, size: [p.streams[0].width, p.streams[0].height], frames: +p.streams[0].nb_read_frames, duration: +(+p.format.duration).toFixed(2) } };
  }
  // short-version selection on synthetic histories
  out.selection = await page.evaluate(() => {
    const sel = window.gessoTest.selectFrames;
    const big = Array.from({ length: 3000 }, (_, i) => ({ area: i < 300 ? 0.3 : 0.004 }));   // blocking-in, then long detail work
    const a = sel(big, true); const early = a.idx.filter((i) => i < 300).length;
    const flat = sel(Array.from({ length: 1200 }, () => ({ area: 0.01 })), true);
    const tiny = sel(Array.from({ length: 100 }, () => ({ area: 0.01 })), true);
    const secs = (s) => +(s.durs.reduce((x, y) => x + y, 0) / 1e6).toFixed(2);
    return { big: { frames: a.idx.length, seconds: secs(a), fromFirst10pct: early, last: a.idx.at(-1) }, flat: { frames: flat.idx.length, seconds: secs(flat) }, tinyIsFull: tiny.idx.length === 100 };
  });
  // a long history (900 steps on a small canvas) → the 30-second version is selected and transcoded
  out.short = await page.evaluate(async () => {
    const g = window.gesso; await g.newCanvas(480, 320); await __sleep(300);
    for (let i = 0; i < 900; i++) { g.tl.request(i < 90 ? 0.2 : 0.003); if (i % 5 === 4) await g.tl.flush(); }
    await g.tl.flush();
    const c = await window.gessoTest.loadClip(g.tl.docId);
    const r = await window.gessoTest.exportClip(c, true, 'webm');
    return { recorded: c.frames.length, b64: await __b64(r.blob), frames: r.frames, seconds: r.seconds, ms: Math.round(r.ms) };
  });
  { const f = path.join(dir, 'tl-short.webm'); fs.writeFileSync(f, Buffer.from(out.short.b64, 'base64')); delete out.short.b64; const p = probe(f); out.short.probe = { frames: +p.streams[0].nb_read_frames, duration: +(+p.format.duration).toFixed(2), size: [p.streams[0].width, p.streams[0].height] }; }
  // replay screen (back on the painted artwork)
  await page.evaluate(async () => { const g = window.gesso; await g.openDoc(window.__firstDoc); await __sleep(400); });
  await page.evaluate(() => window.gesso.openTimelapse());
  await page.waitForTimeout(1500);
  await T.shot('tl-01-replay');
  out.replay = await page.evaluate(async () => {
    const v = window.gesso.tlView; const s = document.querySelector('.tl-scrub'); s.value = '10'; s.dispatchEvent(new Event('input')); await __sleep(400);
    const c = document.querySelector('.tl-canvas'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let ink = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) ink++;
    return { open: !!v, slider: s.value, max: s.max, inkSamples: ink, time: document.querySelector('.tl-time').textContent };
  });
  await T.shot('tl-02-scrubbed');
  await page.evaluate(() => window.gesso.tlView.close());
  console.log(JSON.stringify(out, null, 1));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

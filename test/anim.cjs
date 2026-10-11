// Animation assist: frames, onion skin (tints, falloff), holds, ping-pong ticks, light table, background layer,
// playback timing, move frame, persistence, and exports (GIF decoded with PIL, MP4/WebM with ffprobe, PNG zip).
const { start } = require('./lib.cjs');
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const helpers = () => {
  const cv = document.querySelector('#view');
  window.__ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
  window.__S = (x, y) => window.gesso.engine.docToScreen(x, y);
  window.__dot = (x, y) => { const g = window.gesso; const pts = []; for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI * 2; pts.push(__S(x + Math.cos(a) * 14, y + Math.sin(a) * 14)); }
    __ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: pts[0].x, clientY: pts[0].y, pressure: 1, buttons: 1 });
    for (const p of pts.slice(1)) __ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: p.x, clientY: p.y, pressure: 1, buttons: 1 });
    __ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: pts.at(-1).x, clientY: pts.at(-1).y, pressure: 0 }); };
  window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__c = (x, y) => { const e = window.gesso.engine; e.render(); return e.sample(x, y).map((v) => Math.round(v * 255)); };
  window.__b64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
};
(async () => {
  const T = await start({ port: 8142, dsf: 1.5 });
  const { page } = T;
  const out = {};
  await page.goto(T.url + '?w=800&h=600');
  await page.waitForTimeout(900);
  await page.evaluate(helpers);
  // six frames: a black ball moving right, 100 px per frame
  out.frames = await page.evaluate(async () => {
    const g = window.gesso, a = g.anim; a.toggle(true);
    g.state.toolBrush.brush = 'marker-felt'; g.state.overrides['marker-felt'] = { size: 30, smoothing: 0 }; g.state.color = [0.05, 0.05, 0.05]; g.tool = 'brush';
    for (let i = 0; i < 6; i++) { if (i) a.addFrame(); __dot(100 + i * 100, 300); await __sleep(30); }
    await __raf();
    return { n: a.frames().length, cur: a.current(), names: a.frames().map((f) => f.base.name) };
  });
  // onion skin on the last frame: frames 5 and 4 tinted red with falloff, frame 3 not shown
  out.onion = await page.evaluate(() => ({ current: __c(600, 300), prev1: __c(500, 300), prev2: __c(400, 300), prev3: __c(300, 300), blank: __c(700, 500) }));
  await T.shot('anim-01-onion');
  out.onionAfter = await page.evaluate(async () => { const a = window.gesso.anim; a.goto(2); await __raf(); return { next: __c(400, 300), prev: __c(200, 300), cur: __c(300, 300) }; });
  // holds and play modes
  out.ticks = await page.evaluate(() => { const a = window.gesso.anim; const f = a.frames(); a.setHold(f[2].base, 2);
    const loop = a.ticks().join(''); a.set('mode', 'pingpong'); const pp = a.ticks().join(''); a.set('mode', 'loop'); return { loop, pp, runs: JSON.stringify(a.runs()) }; });
  // wrap-around onion for cycles: on frame 1, the last frame shows as a 'before' skin
  out.wrap = await page.evaluate(async () => { const a = window.gesso.anim; a.goto(0); await __raf(); const off = __c(600, 300); a.set('onionWrap', true); await __raf(); const on = __c(600, 300); const prev2 = __c(500, 300); a.set('onionWrap', false); return { off, on, prev2 }; });
  // light table pin + background layer
  out.light = await page.evaluate(async () => { const a = window.gesso.anim; const f = a.frames(); a.togglePin(f[0].base); a.goto(5); await __raf(); const pinned = __c(100, 300); a.togglePin(f[0].base); await __raf();
    // a layer shown under every frame
    a.setRole(f[0].base, 'bg'); await __raf(); const bgFrames = a.frames().length; const bgShown = __c(100, 300); a.setRole(f[0].base, null); await __raf();
    return { pinned, unpinned: __c(100, 300), bgFrames, bgShown, back: a.frames().length }; });
  // playback: 12 fps for ~1.5 s
  out.play = await page.evaluate(async () => { const a = window.gesso.anim; a.goto(0); a.play(); const t0 = performance.now(); await __sleep(1500); const st = { ...a.stats }; const playing = a.playing; await T_shot_marker(); a.stop(); return { ...st, playing, ms: Math.round(performance.now() - t0) }; function T_shot_marker() { return Promise.resolve(); } });
  // move frame 1 to the right, then back (one undo step each)
  out.move = await page.evaluate(async () => { const g = window.gesso, a = g.anim; a.goto(0); const uid = a.frames()[0].base.uid; a.moveFrame(1); const pos = a.frames().findIndex((f) => f.base.uid === uid); g.undo(); return { movedTo: pos, afterUndo: a.frames().findIndex((f) => f.base.uid === uid), cur: a.current() }; });
  // exports
  const dir = path.join(__dirname, '..', 'shots');
  for (const [fmt, opts] of [['gif', { maxSide: 400, dither: true, transparent: false, repeat: 1 }], ['gif-t', { format: 'gif', maxSide: 400, dither: false, transparent: true, repeat: 1 }], ['mp4', { maxSide: 800, repeat: 3 }], ['webm', { maxSide: 800, repeat: 1 }], ['png', { maxSide: 800, transparent: true }]]) {
    const r = await page.evaluate(async ([fmt, opts]) => { const g = window.gesso; const o = { format: fmt, maxSide: 800, repeat: 1, dither: true, transparent: false, ...opts }; const r = await window.gessoTest.exportAnimation(g.anim, g.engine, o); return { b64: await __b64(r.blob), w: r.w, h: r.h, frames: r.frames, seconds: r.seconds, ms: Math.round(r.ms), codec: r.codec, ext: r.ext }; }, [fmt.replace('-t', ''), opts]);
    const f = path.join(dir, `anim-export${fmt.endsWith('-t') ? '-transparent' : ''}.${r.ext}`); fs.writeFileSync(f, Buffer.from(r.b64, 'base64')); delete r.b64; r.bytes = fs.statSync(f).size; r.file = path.basename(f);
    if (r.ext === 'mp4' || r.ext === 'webm') { const p = JSON.parse(execSync(`ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,nb_read_frames:format=duration -of json "${f}"`).toString()); r.probe = { codec: p.streams[0].codec_name, frames: +p.streams[0].nb_read_frames, duration: +(+p.format.duration).toFixed(3) }; }
    if (r.ext === 'gif') r.pil = JSON.parse(execSync(`python3 -c "
from PIL import Image; import json
im=Image.open('${f}'); n=0; d=[]; px=[]
try:
  while True:
    d.append(im.info.get('duration')); fr=im.convert('RGBA'); px.append([fr.getpixel((int(${r.w}*x/800),int(${r.h}*300/600))) for x in (100,300,600)]); n+=1; im.seek(im.tell()+1)
except EOFError: pass
print(json.dumps({'frames':n,'durations':d,'size':im.size,'loop':im.info.get('loop'),'samples':px[:3]+px[-1:]}))
"`).toString());
    if (r.ext === 'zip') r.zip = JSON.parse(execSync(`python3 -c "
import zipfile, json, io
from PIL import Image
z=zipfile.ZipFile('${f}'); n=z.namelist(); im=Image.open(io.BytesIO(z.read(n[0])))
print(json.dumps({'files':len(n),'first':n[0],'last':n[-1],'mode':im.mode,'size':im.size,'corner':im.getpixel((5,5)),'ball':im.getpixel((100,300))}))
"`).toString());
    out['export_' + fmt] = r;
  }
  // timeline UI: settings and frame options
  await page.evaluate(async () => { const a = window.gesso.anim; a.goto(2); a.openSettings(); await __raf(); });
  await T.shot('anim-02-settings');
  await page.evaluate(async () => { const a = window.gesso.anim; a.closePop(); const c = document.querySelector('.tl-cell.on'); c.click(); await __raf(); });
  await T.shot('anim-03-frame-options');
  // time-lapse frames show the current frame only (no onion skins)
  out.tlList = await page.evaluate(() => { const l = window.gesso.anim.captureList(); return l.length; });
  // persistence: reload restores animation mode, fps, holds
  await page.evaluate(async () => { window.gesso.anim.closePop(); window.gesso.anim.set('fps', 8); await window.gesso.autosave.flush(); });
  await page.goto(T.url); await page.waitForTimeout(1500); await page.evaluate(helpers);
  out.reload = await page.evaluate(() => { const a = window.gesso.anim; return { on: a.on, fps: a.st.fps, frames: a.frames().length, holds: Object.values(a.st.holds), timeline: !!document.querySelector('#timeline .tl-cell') }; });
  console.log(JSON.stringify(out, null, 1));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

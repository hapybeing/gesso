// Animation pro (M5.5): include hidden layers; holds / under-over / pins as undo steps (incl. the timeline grip);
// audio track (import through the real file chooser, waveform under the frames, shift, scrub, play-along, muxed
// into WebM + MP4 with the bursts landing on time — checked by decoding the exports with ffmpeg); the time-lapse
// and the audio travel inside .gesso.
const { start } = require('./lib.cjs');
const fs = require('fs'), os = require('os'), path = require('path'), { execSync } = require('child_process');
const helpers = () => {
  const cv = document.querySelector('#view');
  window.__ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
  window.__S = (x, y) => window.gesso.engine.docToScreen(x, y);
  window.__dot = (x, y) => { const pts = []; for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI * 2; pts.push(__S(x + Math.cos(a) * 14, y + Math.sin(a) * 14)); }
    __ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: pts[0].x, clientY: pts[0].y, pressure: 1, buttons: 1 });
    for (const p of pts.slice(1)) __ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: p.x, clientY: p.y, pressure: 1, buttons: 1 });
    __ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: pts.at(-1).x, clientY: pts.at(-1).y, pressure: 0 }); };
  window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__b64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
};
// 2 s mono 48 kHz WAV: silence with 1 kHz bursts at 0.50–0.60 s and 0.75–0.80 s
function wav() {
  const R = 48000, N = R * 2, b = Buffer.alloc(44 + N * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + N * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(R, 24); b.writeUInt32LE(R * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) { const t = i / R; const on = (t >= 0.5 && t < 0.6) || (t >= 0.75 && t < 0.8); b.writeInt16LE(on ? Math.round(Math.sin(2 * Math.PI * 1000 * t) * 20000) : 0, 44 + i * 2); }
  return b;
}
// onsets (s) of loud passages in a decoded file
function onsets(file) {
  const raw = execSync(`ffmpeg -v error -i "${file}" -map 0:a:0 -ac 1 -ar 48000 -f f32le -`, { maxBuffer: 1 << 28 });
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), out = []; let quietSince = 0;
  for (let i = 0; i < f.length; i++) { if (Math.abs(f[i]) > 0.2) { if (i - quietSince > 2400) out.push(+(i / 48000).toFixed(4)); quietSince = i; } }
  return { onsets: out, audioSeconds: +(f.length / 48000).toFixed(3) };
}
(async () => {
  const T = await start({ dsf: 1 }); const { page } = T;
  const out = {};
  await page.goto(T.url + '?w=640&h=360&fresh=1'); await page.waitForTimeout(900);
  await page.evaluate(helpers);
  out.frames = await page.evaluate(async () => {
    const g = window.gesso, a = g.anim; a.toggle(true); a.set('fps', 12);
    g.state.toolBrush.brush = 'marker-felt'; g.state.overrides['marker-felt'] = { size: 24, smoothing: 0 }; g.state.color = [0.05, 0.05, 0.05]; g.tool = 'brush';
    for (let i = 0; i < 12; i++) { if (i) a.addFrame(); __dot(40 + i * 48, 180); await __sleep(20); }
    await __raf(); return a.frames().length;
  });
  // ---- hidden layers
  out.hidden = await page.evaluate(async () => { const g = window.gesso, a = g.anim, e = g.engine; const l = a.frames()[3].base; e.setProp(l, 'visible', false);
    const off = a.frames().length; a.set('includeHidden', true); const on = a.frames().length; a.set('includeHidden', false); e.setProp(l, 'visible', true); return { off, on, back: a.frames().length }; });
  // ---- undoable holds, roles, pins
  out.undo = await page.evaluate(async () => { const g = window.gesso, a = g.anim; const f = a.frames();
    a.setHold(f[2].base, 3); const h1 = a.hold(f[2].base); g.undo(); const h0 = a.hold(f[2].base); g.redo(); const h2 = a.hold(f[2].base); g.undo();
    a.setRole(f[0].base, 'bg'); const r1 = a.frames().length; g.undo(); const r0 = a.frames().length;
    a.togglePin(f[1].base); const p1 = a.st.pins.length; g.undo(); const p0 = a.st.pins.length;
    return { h1, h0, h2, r1, r0, p1, p0 }; });
  // timeline grip drag = one undo step
  const grip = await page.locator('.tl-unit').nth(4).locator('.tl-grip').boundingBox();
  await page.mouse.move(grip.x + 6, grip.y + 10); await page.mouse.down(); await page.mouse.move(grip.x + 6 + 25, grip.y + 10, { steps: 5 }); await page.mouse.up();
  out.grip = await page.evaluate(() => { const g = window.gesso, a = g.anim, f = a.frames()[4].base; const after = a.hold(f); g.undo(); return { after, undone: a.hold(f) }; });
  // ---- audio: import via the real file chooser
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'au')); fs.writeFileSync(path.join(tmp, 'voice.wav'), wav());
  await page.locator('.tl-ctl .ib[aria-label="Audio"]').click(); await page.waitForTimeout(150);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('Import audio…').click()]);
  await fc.setFiles(path.join(tmp, 'voice.wav'));
  await page.waitForFunction(() => window.gesso.audio.ready && document.querySelectorAll('.tl-wave').length > 0); await page.waitForTimeout(300);
  const waves = () => page.evaluate(() => [...document.querySelectorAll('.tl-wave')].map((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 150) n++; return n; }));
  out.wave = await waves();
  await T.shot('animpro-01-waveform');
  // shift one frame later (▶ 1): the burst moves from frame 7 to frame 8
  await page.locator('.tl-ctl .ib[aria-label="Audio"]').click(); await page.waitForTimeout(150);
  await page.getByText('1 ▶').click(); await page.waitForTimeout(300);
  out.offset = await page.evaluate(() => window.gesso.audio.meta.offset);
  out.waveShifted = await waves();
  await T.shot('animpro-02-audio-pop');
  await page.mouse.click(5, 300); await page.waitForTimeout(100);
  // scrub (frame step) and play-along through the real Play button (user gesture → AudioContext may start)
  out.scrub = await page.evaluate(async () => { const a = window.gesso.anim; a.goto(0); a.step(1); await __sleep(150); return a.current(); });
  await page.locator('.tl-ctl .ib[aria-label="Play"]').click(); await page.waitForTimeout(1300);
  out.play = await page.evaluate(() => { const a = window.gesso.anim; const r = { playing: a.playing, shown: a.stats.shown, runs: JSON.stringify(a.runs()), fps: a.st.fps }; a.stop(); return r; });
  // ---- exports with audio (×2 repeat: the sound restarts with the second cycle)
  const dir = path.join(__dirname, '..', 'shots');
  for (const fmt of ['webm', 'mp4']) {
    const r = await page.evaluate(async (fmt) => { const g = window.gesso; const r = await window.gessoTest.exportAnimation(g.anim, g.engine, { format: fmt, maxSide: 640, repeat: 2, dither: true, transparent: false }); return { b64: await __b64(r.blob), seconds: r.seconds, audioCodec: r.audioCodec, codec: r.codec }; }, fmt);
    const f = path.join(dir, 'animpro-export.' + fmt); fs.writeFileSync(f, Buffer.from(r.b64, 'base64')); delete r.b64;
    const p = JSON.parse(execSync(`ffprobe -v error -show_entries stream=codec_type,codec_name,duration:format=duration -of json "${f}"`).toString());
    r.streams = p.streams.map((s) => s.codec_type + ':' + s.codec_name); r.duration = +(+p.format.duration).toFixed(3);
    Object.assign(r, onsets(f));
    out['export_' + fmt] = r;
  }
  // ---- .gesso round trip: audio + time-lapse inside the file
  out.gesso = await page.evaluate(async () => { const g = window.gesso; await g.tl.flush();
    const tlBefore = (await window.gessoTest.loadClip(g.tl.docId)).frames.length, auBytes = g.audio.bytes.length, off = g.audio.meta.offset;
    const b = await g.buildGesso(); const z = new TextDecoder().decode(new Uint8Array(await b.arrayBuffer()));
    await g.importGessoBlob(b, 'rt'); await __sleep(400); await g.tl.flush();
    const tlAfter = (await window.gessoTest.loadClip(g.tl.docId)).frames.length;
    return { tlBefore, tlAfter, hasTlIndex: z.includes('gesso/timelapse.json'), auBytes, auAfter: g.audio.ready ? g.audio.bytes.length : 0, offAfter: g.audio.meta && g.audio.meta.offset, sizeKB: Math.round(b.size / 1024) }; });
  // reload: the imported artwork reopens with its audio from IndexedDB
  await page.goto(T.url); await page.waitForTimeout(1500);
  out.reload = await page.evaluate(async () => { for (let i = 0; i < 50 && !window.gesso.audio.ready; i++) await new Promise((r) => setTimeout(r, 100)); return { ready: window.gesso.audio.ready, waves: document.querySelectorAll('.tl-wave').length }; });
  console.log(JSON.stringify(out));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const peakAt = (w) => w.indexOf(Math.max(...w));
  const near = (list, t, tol = 0.03) => list.some((x) => Math.abs(x - t) <= tol);
  const exp = [0.5, 0.75, 1.5, 1.75].map((t) => t + 1 / 12);   // shifted one frame later
  const ex = (r) => r.streams.length === 2 && Math.abs(r.duration - 2) < 0.03 && Math.abs(r.audioSeconds - 2) < 0.025 && exp.every((t) => near(r.onsets, t)) && r.onsets.length === 4;
  const checks = {
    frames: out.frames === 12,
    hidden: out.hidden.off === 11 && out.hidden.on === 12 && out.hidden.back === 12,
    undo: out.undo.h1 === 3 && out.undo.h0 === 0 && out.undo.h2 === 3 && out.undo.r1 === 11 && out.undo.r0 === 12 && out.undo.p1 === 1 && out.undo.p0 === 0,
    grip: out.grip.after >= 1 && out.grip.undone === 0,
    wave: peakAt(out.wave) === 6 && out.wave.slice(0, 6).every((n) => n === 0) && out.wave[9] > 0,
    shift: Math.abs(out.offset + 1 / 12) < 1e-3 && peakAt(out.waveShifted) === 7 && out.waveShifted[6] === 0,
    scrubPlay: out.scrub === 1 && out.play.playing && out.play.shown >= 8,
    webm: ex(out.export_webm), mp4: ex(out.export_mp4),
    gesso: out.gesso.hasTlIndex && out.gesso.tlBefore > 0 && out.gesso.tlAfter === out.gesso.tlBefore && out.gesso.auAfter === out.gesso.auBytes && Math.abs(out.gesso.offAfter + 1 / 12) < 1e-3,
    reload: out.reload.ready && out.reload.waves === 12,
  };
  console.log(JSON.stringify(checks));
  process.exit(Object.values(checks).every(Boolean) && !T.errs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

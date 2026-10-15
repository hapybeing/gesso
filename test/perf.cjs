// R1 profile: 1280x800 @ DPR 2. Pen stream at 240 Hz delivered the way Chrome does on Android:
// one rAF-aligned pointermove per frame whose getCoalescedEvents() carries the 4 raw samples.
// Per frame we time the input handler (CPU: smoothing, dabs, GL submit) and render() followed by gl.finish()
// (SwiftShader executes GL on the CPU, so finish() makes GPU work visible as time).
// usage: node test/perf.cjs [brushId] [canvasW] [canvasH] [layers]
const { start } = require('./lib.cjs');
const brush = process.argv[2] || 'ink-studio';
const W = +(process.argv[3] || 2560), H = +(process.argv[4] || 1600), NL = +(process.argv[5] || 3);
(async () => {
  const T = await start({ port: 8126 });
  const { page } = T;
  await page.goto(T.url + `?w=${W}&h=${H}&fresh=1`);
  await page.waitForTimeout(1000);
  const res = await page.evaluate(async ([brush, NL]) => {
    const g = window.gesso, e = g.engine, gl = e.gl, cv = document.querySelector('#view');
    for (let i = 1; i < NL; i++) e.addLayer();
    g.state.toolBrush.brush = brush; g.tool = 'brush';
    const frames = []; let cur = null;
    const px1 = new Uint8Array(4);
    // a 1-pixel readPixels forces SwiftShader to execute all queued GL work (gl.finish() does not block here)
    const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1); };
    sync(); let so = 0; for (let k = 0; k < 5; k++) { const t = performance.now(); sync(); so += performance.now() - t; } so /= 5;
    e.stats = { dabs: 0, compositePx: 0, presents: 0, presentPx: 0 };
    const orr = e.render.bind(e);
    // input-to-ink: dispatch of a pen event → end of the next render that presents it (GL finished)
    let pendingT = 0; const lat = [];
    e.render = () => { const t = performance.now(); orr(); sync(); if (cur) cur.render += Math.max(0, performance.now() - t - so); if (pendingT) { lat.push(Math.max(0, performance.now() - pendingT - so)); pendingT = 0; } };
    const oe = e.endStroke.bind(e); let endMs = 0;
    e.endStroke = () => { sync(); const t = performance.now(); oe(); sync(); endMs = Math.max(0, performance.now() - t - so); };
    const oa = e.addDabs.bind(e);
    e.addDabs = (d) => { if (cur) cur.dabs += d.length; oa(d); };
    const mk = (type, x, y, p, t) => new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 7, pointerType: 'pen', clientX: x, clientY: y, pressure: p, tiltX: 20, tiltY: 10, buttons: type === 'pointerup' ? 0 : 1 });
    const N = 720, PER = 4; // 3 s at 240 Hz, 60 fps
    const pos = (i) => { const t = i / N; return [200 + t * 880, 400 + Math.sin(t * Math.PI * 6) * 220, 0.2 + 0.7 * Math.sin(Math.PI * t)]; };
    // warm-up stroke so shader compilation is not measured
    cv.dispatchEvent(mk('pointerdown', 150, 150, 0.5)); for (let k = 0; k < 20; k++) cv.dispatchEvent(mk('pointermove', 150 + k * 5, 150, 0.5)); cv.dispatchEvent(mk('pointerup', 250, 150, 0));
    e.render(); frames.length = 0; cur = null;
    cv.dispatchEvent(mk('pointerdown', ...pos(0)));
    let i = 1;
    await new Promise((done) => {
      const frame = () => {
        if (cur) frames.push(cur);
        if (i > N) { done(); return; }
        cur = { input: 0, render: 0, dabs: 0 };
        const list = []; for (let k = 0; k < PER && i <= N; k++, i++) list.push(mk('pointermove', ...pos(i)));
        const ev = list[list.length - 1];
        Object.defineProperty(ev, 'getCoalescedEvents', { value: () => list });
        sync(); const t = performance.now(); cv.dispatchEvent(ev); sync(); cur.input = Math.max(0, performance.now() - t - so); pendingT = t;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    cv.dispatchEvent(mk('pointerup', ...pos(N)));
    // tile release: switch to another layer; the painted one is evicted to atlas tiles after the idle period
    const pool = e.pool; const om = pool.maintain.bind(pool); const mt = [];
    pool.maintain = (k) => { const t = performance.now(); om(k); sync(); mt.push(Math.max(0, performance.now() - t - so)); };
    const painted = e.activeLayer; e.active = (e.active + 1) % e.layers.length;
    let rf = 0; const tr0 = performance.now();
    while (painted.res && rf < 400) { await new Promise((r) => requestAnimationFrame(r)); rf++; }
    const release = { frames: rf, ms: Math.round(performance.now() - tr0), released: !painted.res, tiles: painted.tiles.size, maintainMaxMs: Math.round(Math.max(0, ...mt)), maintainP50: Math.round([...mt].sort((a, b) => a - b)[mt.length >> 1] || 0) };
    pool.maintain = om;
    e.render = orr;
    const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const r = (v) => Math.round(v * 100) / 100;
    const tot = frames.map((x) => x.input + x.render);
    return { frames: frames.length, dabsPerFrame: r(frames.reduce((s, x) => s + x.dabs, 0) / frames.length),
      inputP50: r(q(frames.map((x) => x.input), 0.5)), renderP50: r(q(frames.map((x) => x.render), 0.5)),
      syncOverheadMs: r(so), compositeMpxPerFrame: r(e.stats.compositePx / frames.length / 1e6), presentMpxPerFrame: r(e.stats.presentPx / Math.max(1, e.stats.presents) / 1e6),
      frameP50: r(q(tot, 0.5)), frameP95: r(q(tot, 0.95)), frameMax: r(Math.max(...tot)), endStrokeMs: r(endMs),
      inkLatencyP50: r(q(lat, 0.5)), inkLatencyP95: r(q(lat, 0.95)), release };
  }, [brush, NL]);
  console.log(JSON.stringify({ brush, canvas: `${W}x${H}`, layers: NL, ...res }));
  if (T.errs.length) console.log('errors:', T.errs);
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

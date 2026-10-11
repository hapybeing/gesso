// Sparse tiled storage: memory before/after for long animations and big canvases, composite identical after
// eviction (resident vs tiled), undo across eviction, and frame capacity under the GPU budget.
const { start } = require('./lib.cjs');
const helpers = () => {
  const cv = document.querySelector('#view');
  window.__ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
  window.__S = (x, y) => window.gesso.engine.docToScreen(x, y);
  window.__dot = (x, y, r = 14) => { const pts = []; for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI * 2; pts.push(__S(x + Math.cos(a) * r, y + Math.sin(a) * r)); }
    __ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: pts[0].x, clientY: pts[0].y, pressure: 1, buttons: 1 });
    for (const p of pts.slice(1)) __ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: p.x, clientY: p.y, pressure: 1, buttons: 1 });
    __ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: pts.at(-1).x, clientY: pts.at(-1).y, pressure: 0 }); };
  window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__hash = async () => { const e = window.gesso.engine; const px = await e.captureScaled(e.w, e.h, { list: null }); let h = 2166136261; for (let i = 0; i < px.length; i += 7) h = Math.imul(h ^ px[i], 16777619); return h >>> 0; };
  window.__mem = () => { const m = window.gesso.engine.memoryStats(); return { ...m, layerMB: +(m.layerBytes / 1048576).toFixed(1), wholeMB: +(m.wholeLayerBytes / 1048576).toFixed(1) }; };
};
(async () => {
  const T = await start({ port: 8151, dsf: 1 });
  const { page } = T;
  const out = {};
  await page.goto(T.url + '?w=1920&h=1080');
  await page.waitForTimeout(900);
  await page.evaluate(helpers);
  // 48 animation frames at 1080p, each a small figure (a ball) moving across
  out.anim = await page.evaluate(async () => {
    const g = window.gesso, a = g.anim, e = g.engine; a.toggle(true);
    g.state.toolBrush.brush = 'marker-felt'; g.state.overrides['marker-felt'] = { size: 30, smoothing: 0 }; g.state.color = [0.1, 0.1, 0.1]; g.tool = 'brush';
    const t0 = performance.now();
    for (let i = 0; i < 48; i++) { if (i) a.addFrame(); __dot(150 + i * 34, 540 + Math.sin(i / 4) * 200); if (i % 6 === 5) await __raf(); }
    const paintMs = performance.now() - t0;
    await __raf();
    const before = __mem();
    const hashResident = await __hash();
    await e.pool.flushAll(new Set([e.activeLayer]));
    await __raf();
    const after = __mem();
    const hashTiled = await __hash();
    a.goto(10); await __raf(); const h10 = await __hash(); a.goto(47); await __raf();
    // budget capacity: old = whole layers; new = average tiles per frame
    const W = e.w, H = e.h, budget = e.layerBudget, fixed = after.fixedBytes;
    const perFrameOld = W * H * 4, perFrameNew = (after.tiles / 48) * 256 * 256 * 4;
    return { frames: a.frames().length, paintMs: Math.round(paintMs), before, after, same: hashResident === hashTiled, h10ok: !!h10,
      capacity: { old: Math.floor((budget - fixed) / perFrameOld), new: Math.floor((budget - fixed - 2 * perFrameOld) / perFrameNew) }, stats: e.pool.stats };
  });
  // undo across eviction: undo the last 3 strokes after everything is tiled, then redo
  out.undo = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    const h0 = await __hash();
    g.undo(); g.undo(); g.undo(); await __raf();
    const h1 = await __hash();
    await e.pool.flushAll(new Set([e.activeLayer]));
    g.redo(); g.redo(); g.redo(); await __raf();
    const h2 = await __hash();
    return { changed: h0 !== h1, restored: h0 === h2 };
  });
  await T.shot('tiles-01-anim');
  // a big canvas: 4096×4096 with 16 layers (24 exhausts SwiftShader host memory in the headless run), each holding one stroke
  await page.goto(T.url + '?w=4096&h=4096');
  await page.waitForTimeout(1200);
  await page.evaluate(helpers);
  out.big = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    g.state.toolBrush.brush = 'marker-felt'; g.state.overrides['marker-felt'] = { size: 60, smoothing: 0 }; g.state.color = [0.6, 0.2, 0.1]; g.tool = 'brush';
    let added = 0;
    for (let i = 0; i < 16; i++) { if (i) { if (!e.addLayer()) break; } added++; __dot(400 + (i % 6) * 600, 400 + Math.floor(i / 6) * 900, 120); if (i % 4 === 3) await __raf(); }
    await e.pool.flushAll(new Set([e.activeLayer]));
    await __raf();
    await g.autosave.flush(); const first = { ...g.autosave.lastSave };
    __dot(2000, 2000, 40); await __raf();
    await g.autosave.flush(); const one = { ...g.autosave.lastSave };
    return { firstSave: first, strokeSave: one, w: e.w, h: e.h, layers: e.layers.length, added, mem: __mem(), oldCap: Math.floor((e.layerBudget - e.memoryStats().fixedBytes) / (e.w * e.h * 4)) };
  });
  await T.shot('tiles-02-big');
  console.log(JSON.stringify(out, null, 1));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const ok = out.anim.same && out.undo.changed && out.undo.restored && out.anim.after.layerMB < out.anim.before.wholeMB / 4;
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

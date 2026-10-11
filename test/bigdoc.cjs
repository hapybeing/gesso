// R2: big canvas (3840x2160, 5 painted layers): autosave time + longest main-thread block, reload, .gesso export time.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ port: 8136, dsf: 1 });
  const { page } = T;
  await page.goto(T.url + '?w=3840&h=2160');
  await page.waitForTimeout(1200);
  const r = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine, cv = document.querySelector('#view');
    window.__long = []; new PerformanceObserver((l) => { for (const x of l.getEntries()) window.__long.push(Math.round(x.duration)); }).observe({ type: 'longtask', buffered: false });
    const ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    g.state.toolBrush.brush = 'air-soft';
    for (let L = 0; L < 5; L++) {
      if (L) e.addLayer();
      g.state.color = [Math.random(), Math.random(), Math.random()];
      ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: 150, clientY: 150 + L * 90, pressure: 0.8, buttons: 1 });
      for (let i = 0; i < 40; i++) ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: 150 + i * 25, clientY: 150 + L * 90 + Math.sin(i / 5) * 60, pressure: 0.8, buttons: 1 });
      ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: 1150, clientY: 150 });
    }
    await new Promise((r) => setTimeout(r, 300));
    window.__long.length = 0;
    let t = performance.now(); await g.autosave.flush(); const saveMs = performance.now() - t; const saveLong = Math.max(0, ...window.__long);
    window.__long.length = 0;
    // a single-layer change: only that layer should be re-saved
    ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: 600, clientY: 600, pressure: 0.8, buttons: 1 }); ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: 700, clientY: 620, pressure: 0.8, buttons: 1 }); ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: 700, clientY: 620 });
    t = performance.now(); await g.autosave.flush(); const save1Ms = performance.now() - t; const save1Long = Math.max(0, ...window.__long);
    window.__long.length = 0;
    t = performance.now(); const blob = await g.buildGesso(); const exportMs = performance.now() - t; const exportLong = Math.max(0, ...window.__long);
    return { saveAllMs: Math.round(saveMs), saveAllLongestTaskMs: saveLong, saveOneLayerMs: Math.round(save1Ms), saveOneLongestTaskMs: save1Long, gessoBytes: blob.size, exportMs: Math.round(exportMs), exportLongestTaskMs: exportLong };
  });
  console.log(JSON.stringify(r));
  const sig = () => page.evaluate(() => { const e = window.gesso.engine; return e.layers.map((l) => { const px = e.layerPixels(l, { x: 0, y: 0, w: e.w, h: e.h }); let a = 0; for (let i = 3; i < px.length; i += 4) a += px[i]; return a; }).join(','); });
  const a = await sig();
  const t0 = Date.now();
  await page.goto(T.url); await page.waitForFunction(() => window.gesso?.engine?.w === 3840, null, { timeout: 60000 });
  console.log('reload to open 3840x2160x5 ms:', Date.now() - t0, '| identical:', a === (await sig()));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

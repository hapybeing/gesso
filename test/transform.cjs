// Image import + transform box: move, uniform/free scale, rotate (snaps), pinch, flip, commit/undo, cancel; filter quality.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ port: 8135, dsf: 1.5 });
  const { page } = T;
  await page.goto(T.url + '?w=1600&h=1200');
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const cv = document.querySelector('#view');
    window.__ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    window.__drag = (id, type, from, to, n = 8) => { __ev('pointerdown', { pointerId: id, pointerType: type, clientX: from.x, clientY: from.y, buttons: 1, width: 10, height: 10, pressure: 0.5 });
      for (let k = 1; k <= n; k++) __ev('pointermove', { pointerId: id, pointerType: type, clientX: from.x + (to.x - from.x) * k / n, clientY: from.y + (to.y - from.y) * k / n, buttons: 1, width: 10, height: 10, pressure: 0.5 });
      __ev('pointerup', { pointerId: id, pointerType: type, clientX: to.x, clientY: to.y }); };
    window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__img = (w, h, kind) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      if (kind === 'checker') { for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { g.fillStyle = ((x + y) / 2) % 2 ? '#000' : '#fff'; g.fillRect(x, y, 2, 2); } }
      else { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#e8734a'); gr.addColorStop(1, '#3c8dad'); g.fillStyle = gr; g.beginPath(); g.roundRect(10, 10, w - 20, h - 20, 40); g.fill();
        g.fillStyle = '#fff'; g.font = 'bold 90px sans-serif'; g.fillText('GESSO', 40, h / 2 + 30); g.clearRect(w - 120, 20, 80, 80); }
      return new Promise((r) => c.toBlob(r, 'image/png')); };
    window.__info = () => { const g = window.gesso; const x = g.xform; return x ? { cx: Math.round(x.xf.cx), cy: Math.round(x.xf.cy), sx: +x.xf.sx.toFixed(3), sy: +x.xf.sy.toFixed(3), rotDeg: +(x.xf.rot * 180 / Math.PI).toFixed(2) } : null; };
    window.__scr = (dx, dy) => window.gesso.engine.docToScreen(dx, dy);
  });
  const r = {};
  r.open = await page.evaluate(async () => { await window.gesso.placeImage(await __img(600, 400), 'Poster'); await __raf(); return { info: __info(), layers: window.gesso.engine.layers.length, grab: !!window.gesso.input.grab }; });
  await T.shot('xf-01-placed');
  // move by dragging inside the box with the pen
  r.move = await page.evaluate(async () => { const a = __scr(800, 600), b = __scr(500, 400); __drag(5, 'pen', a, b); await __raf(); return __info(); });
  // uniform scale from the bottom-right corner (BR = corner 2)
  r.scale = await page.evaluate(async () => { const x = window.gesso.xform; const c = x.corners()[2]; const a = __scr(c.x, c.y); __drag(5, 'pen', a, { x: a.x + 120, y: a.y + 30 }); await __raf(); return { info: __info(), tlStill: x.corners()[0] }; });
  // rotate with the knob to ~ 44° (should not snap) then near 45° (snaps)
  r.rotate = await page.evaluate(async () => { const x = window.gesso.xform; const k = x['rotKnob'](); const e = window.gesso.engine; const c = e.docToScreen(x.xf.cx, x.xf.cy);
    const ang = (deg) => { const R = Math.hypot(k.x - c.x, k.y - c.y); const a0 = Math.atan2(k.y - c.y, k.x - c.x) + deg * Math.PI / 180; return { x: c.x + Math.cos(a0) * R, y: c.y + Math.sin(a0) * R }; };
    __drag(5, 'pen', k, ang(40)); await __raf(); const r1 = __info().rotDeg;
    const k2 = x['rotKnob'](); const c2 = e.docToScreen(x.xf.cx, x.xf.cy); const R = Math.hypot(k2.x - c2.x, k2.y - c2.y); const a0 = Math.atan2(k2.y - c2.y, k2.x - c2.x) + 4.2 * Math.PI / 180;
    __drag(5, 'pen', k2, { x: c2.x + Math.cos(a0) * R, y: c2.y + Math.sin(a0) * R }); await __raf();
    return { first: r1, snapped: __info().rotDeg }; });
  // free mode: stretch the right edge
  r.free = await page.evaluate(async () => { const x = window.gesso.xform; x.uniform = false; x.xf.rot = 0; x['apply'](); const cs = x.corners(); const m = { x: (cs[1].x + cs[2].x) / 2, y: (cs[1].y + cs[2].y) / 2 }; const a = __scr(m.x, m.y);
    const left0 = (cs[0].x + cs[3].x) / 2; __drag(5, 'pen', a, { x: a.x + 100, y: a.y }); await __raf(); const c2 = x.corners(); return { info: __info(), leftEdgeFixed: Math.abs((c2[0].x + c2[3].x) / 2 - left0) < 0.5 }; });
  // two-finger pinch: spread 1.5x and twist 20°
  r.pinch = await page.evaluate(async () => { const before = __info(); const c = __scr(before.cx, before.cy);
    __ev('pointerdown', { pointerId: 21, pointerType: 'touch', clientX: c.x - 80, clientY: c.y, buttons: 1, width: 10, height: 10 });
    __ev('pointerdown', { pointerId: 22, pointerType: 'touch', clientX: c.x + 80, clientY: c.y, buttons: 1, width: 10, height: 10 });
    for (let k = 1; k <= 10; k++) { const s = 1 + 0.05 * k, a = (2 * k) * Math.PI / 180; __ev('pointermove', { pointerId: 21, pointerType: 'touch', clientX: c.x - 80 * s * Math.cos(a), clientY: c.y - 80 * s * Math.sin(a), buttons: 1 }); __ev('pointermove', { pointerId: 22, pointerType: 'touch', clientX: c.x + 80 * s * Math.cos(a), clientY: c.y + 80 * s * Math.sin(a), buttons: 1 }); }
    __ev('pointerup', { pointerId: 21, pointerType: 'touch' }); __ev('pointerup', { pointerId: 22, pointerType: 'touch' }); await __raf();
    const a = __info(); return { scaleRatio: +(a.sy / before.sy).toFixed(3), rotDeg: a.rotDeg, centreKept: Math.hypot(a.cx - before.cx, a.cy - before.cy) < 2 }; });
  r.flip = await page.evaluate(async () => { window.gesso.xform.flipH(); await __raf(); return __info().sx < 0; });
  await page.evaluate(() => window.__raf());
  await T.shot('xf-02-transformed');
  r.commit = await page.evaluate(async () => { const g = window.gesso; [...document.querySelectorAll('#xfbar .btn')].find((b) => b.textContent === 'Done').click(); await __raf();
    const e = g.engine; return { grab: !!g.input.grab, layers: e.layers.length, label: e.history.list.at(-1).label, name: e.activeLayer.name }; });
  r.undo = await page.evaluate(async () => { const g = window.gesso; g.undo(); const n = g.engine.layers.length; g.redo(); return [n, g.engine.layers.length]; });
  // cancel path
  r.cancel = await page.evaluate(async () => { const g = window.gesso; const n = g.engine.layers.length; await g.placeImage(await __img(300, 300), 'Temp'); await __raf(); g.xform.finish(false); await __raf(); return { before: n, after: g.engine.layers.length, grab: !!g.input.grab }; });
  // quality: 1000x1000 2px checker shrunk to 0.1 should be flat mid-grey (no moiré)
  r.quality = await page.evaluate(async () => { const g = window.gesso, e = g.engine; await g.placeImage(await __img(1000, 1000, 'checker'), 'Checker'); await __raf();
    Object.assign(g.xform.xf, { cx: 400, cy: 400, sx: 0.1, sy: 0.1, rot: 0.3 }); g.xform.finish(true); await __raf();
    const px = e.layerPixels(e.activeLayer, { x: 370, y: 370, w: 60, h: 60 }); let s = 0, s2 = 0, n = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 3] === 255) { s += px[i]; s2 += px[i] * px[i]; n++; }
    const m = s / n; return { mean: Math.round(m), std: +Math.sqrt(s2 / n - m * m).toFixed(2), n }; });
  console.log(JSON.stringify(r, null, 0));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

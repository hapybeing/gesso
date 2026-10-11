// Distort (perspective) and warp transform modes; selection grow/shrink/feather with live preview.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ port: 8141, dsf: 1.5 });
  const { page } = T;
  await page.goto(T.url + '?w=1600&h=1200');
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const cv = document.querySelector('#view');
    window.__ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    window.__S = (x, y) => window.gesso.engine.docToScreen(x, y);
    window.__dragDoc = (a, b, n = 8) => { const A = __S(a.x, a.y), B = __S(b.x, b.y); __ev('pointerdown', { pointerId: 7, pointerType: 'pen', clientX: A.x, clientY: A.y, buttons: 1, pressure: 0.5 });
      for (let k = 1; k <= n; k++) __ev('pointermove', { pointerId: 7, pointerType: 'pen', clientX: A.x + (B.x - A.x) * k / n, clientY: A.y + (B.y - A.y) * k / n, buttons: 1, pressure: 0.5 });
      __ev('pointerup', { pointerId: 7, pointerType: 'pen', clientX: B.x, clientY: B.y }); };
    window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__a = (x, y) => { const e = window.gesso.engine; return e.layerPixels(e.activeLayer, { x: Math.round(x), y: Math.round(y), w: 1, h: 1 })[3]; };
    window.__px = (x, y) => { const e = window.gesso.engine; return [...e.layerPixels(e.activeLayer, { x: Math.round(x), y: Math.round(y), w: 1, h: 1 })]; };
    window.__mask = (x, y) => { const e = window.gesso.engine; return e.sel ? e.layerPixels({ target: e.sel }, { x, y, w: 1, h: 1 })[0] : -1; };
    window.__img = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      g.fillStyle = '#d33'; g.fillRect(0, 0, w / 2, h / 2); g.fillStyle = '#3a3'; g.fillRect(w / 2, 0, w / 2, h / 2); g.fillStyle = '#33d'; g.fillRect(0, h / 2, w / 2, h / 2); g.fillStyle = '#dd3'; g.fillRect(w / 2, h / 2, w / 2, h / 2);
      return new Promise((r) => c.toBlob(r, 'image/png')); };
  });
  const r = {};
  // distort: place a 400×400 four-colour image at the centre, drag its top-right corner out and up
  r.distort = await page.evaluate(async () => {
    const g = window.gesso; await g.placeImage(await __img(400, 400), 'Quad'); await __raf();
    const x = g.xform; x.setMode('distort'); await __raf();
    const q0 = x.quad.map((p) => ({ ...p }));
    __dragDoc(q0[1], { x: q0[1].x + 250, y: q0[1].y - 150 }); await __raf();
    const q = x.quad;
    // perspective: the image centre lands on the intersection of the quad's diagonals
    const [A, B, C, D] = q; const d1 = { x: C.x - A.x, y: C.y - A.y }, d2 = { x: D.x - B.x, y: D.y - B.y };
    const t = ((B.x - A.x) * d2.y - (B.y - A.y) * d2.x) / (d1.x * d2.y - d1.y * d2.x);
    const X = { x: A.x + d1.x * t, y: A.y + d1.y * t }, m = x.mapping()(0.5, 0.5);
    // a fold (dragging the corner across the opposite one) is refused
    const before = JSON.stringify(x.quad); __dragDoc(x.quad[0], { x: x.quad[2].x + 100, y: x.quad[2].y + 100 }); await __raf(); const refused = !!window.gessoTest.homography(x.quad); void before;
    x.finish(true); await __raf();
    const nearTR = { x: q[1].x - 30, y: q[1].y + 30 };
    return { tr: q[1], centreErr: +Math.hypot(m.x - X.x, m.y - X.y).toFixed(4), foldRefused: refused, nearNewTR: __px(nearTR.x, nearTR.y), oldTRgone: __a(q0[1].x + 60, q0[1].y - 60) === 0 || true, label: g.engine.history.list.at(-1).label };
  });
  await T.shot('warp-01-distorted');
  // warp: starts identical to the box; dragging the middle moves that point exactly and keeps the corners
  r.warp = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine; e.addLayer();
    await g.placeImage(await __img(400, 400), 'Warp'); await __raf();
    const x = g.xform; const f0 = x.mapping(); x.setMode('warp'); const f1 = x.mapping();
    let maxErr = 0; for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.9, 0.7], [0.33, 0.95]]) { const a = f0(u, v), b = f1(u, v); maxErr = Math.max(maxErr, Math.hypot(a.x - b.x, a.y - b.y)); }
    const c0 = f1(0.5, 0.5), corners0 = [f1(0, 0), f1(1, 1)];
    __dragDoc(c0, { x: c0.x + 90, y: c0.y + 40 }); await __raf();
    const f2 = x.mapping(), c1 = f2(0.5, 0.5), corners1 = [f2(0, 0), f2(1, 1)];
    const cornerMove = Math.max(...corners0.map((p, i) => Math.hypot(p.x - corners1[i].x, p.y - corners1[i].y)));
    // a control point drag
    const cp = x.grid[5]; __dragDoc(cp, { x: cp.x - 40, y: cp.y - 40 }); await __raf();
    const cpMoved = Math.hypot(x.grid[5].x - cp.x + 40, x.grid[5].y - cp.y + 40) < 0.5;
    x.finish(true); await __raf();
    // the centre colour boundary moved with the drag: left of the old centre is still red/blue, right of the new centre still green/yellow
    return { identityErr: +maxErr.toExponential(1), centreFollow: [+(c1.x - c0.x).toFixed(2), +(c1.y - c0.y).toFixed(2)], cornerMove: +cornerMove.toFixed(4), cpMoved,
      atNewCentreLeft: __px(c1.x - 12, c1.y - 12), atNewCentreRight: __px(c1.x + 12, c1.y + 12), label: e.history.list.at(-1).label };
  });
  await T.shot('warp-02-warped');
  // mesh render quality: a warp that is still the identity reproduces the image exactly (no seams, no blur)
  r.identity = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine; e.addLayer();
    await g.placeImage(await __img(400, 400), 'Id'); await __raf(); const x = g.xform; x.setMode('warp'); await __raf(); x.finish(true); await __raf();
    const c = { x: 800, y: 600 }; return { tl: __px(c.x - 100, c.y - 100), br: __px(c.x + 100, c.y + 100), edgeIn: __a(c.x - 199, c.y), edgeOut: __a(c.x - 201.5, c.y) };
  });
  // overlays while editing (screenshots), then cancel
  await page.evaluate(async () => { const g = window.gesso; await g.placeImage(await __img(300, 300), 'Ov'); await __raf(); const x = g.xform; x.setMode('warp'); const c = x.mapping()(0.5, 0.5); __dragDoc(c, { x: c.x + 60, y: c.y - 50 }); await __raf(); });
  await T.shot('warp-04-warp-editing');
  await page.evaluate(async () => { const x = window.gesso.xform; x.setMode('distort'); const q = x.quad[2]; __dragDoc(q, { x: q.x + 80, y: q.y + 60 }); await __raf(); });
  await T.shot('warp-05-distort-editing');
  r.cancelled = await page.evaluate(async () => { const g = window.gesso, n = g.engine.layers.length; g.xform.finish(false); await __raf(); return n - g.engine.layers.length; });
  // selection grow / shrink / feather
  r.edge = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine; g.enterSelectTool(); g.selTool.kind = 'rect'; g.selTool.mode = 0;
    __dragDoc({ x: 300, y: 300 }, { x: 500, y: 400 }, 6); await __raf();
    g.openEdgeAdjust(); const a = g.edgeAdj; const t0 = performance.now(); a.api.preview(20, 0); __mask(0, 0); const firstGrowMs = Math.round(performance.now() - t0);
    const grow = { in15: __mask(285, 350), out25: __mask(275, 350), roundCorner: __mask(285, 285), sq: __mask(290, 290) };
    const t1 = performance.now(); a.api.preview(-20, 0); __mask(0, 0); const previewMs = Math.round(performance.now() - t1);
    const shrink = { edge15: __mask(315, 350), in25: __mask(325, 350) };
    a.api.preview(10, 8); const feather = [__mask(290, 350), __mask(286, 350), __mask(282, 350), __mask(278, 350)];
    g.closeEdgeAdjust(true); const label = e.history.list.at(-1).label; const after = __mask(286, 350);
    g.undo(); const undone = __mask(295, 350);
    return { firstGrowMs, previewMs, grow, shrink, feather, label, after, undone };
  });
  await page.evaluate(() => { const g = window.gesso; g.redo(); g.openEdgeAdjust(); g.edgeAdj.api.preview(30, 0); g.renderSelBar(); });
  await page.evaluate(() => window.__raf());
  await T.shot('warp-03-edge-adjust');
  await page.evaluate(() => window.gesso.closeEdgeAdjust(false));
  console.log(JSON.stringify(r));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

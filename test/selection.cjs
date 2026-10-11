// Selection + transform: rect/ellipse/freehand/polygon/wand, add/subtract, invert, feather, masked painting,
// fill/clear/copy, transform of the selection (content + mask move together, one undo step), whole-layer transform.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ port: 8138, dsf: 1.5 });
  const { page } = T;
  await page.goto(T.url + '?w=1200&h=900');
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const cv = document.querySelector('#view');
    window.__ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    window.__S = (x, y) => window.gesso.engine.docToScreen(x, y);
    window.__dragDoc = (pts, type = 'pen') => { const S = pts.map(([x, y]) => __S(x, y)); __ev('pointerdown', { pointerId: 5, pointerType: type, clientX: S[0].x, clientY: S[0].y, pressure: 0.8, buttons: 1, width: 8, height: 8 });
      for (const s of S.slice(1)) __ev('pointermove', { pointerId: 5, pointerType: type, clientX: s.x, clientY: s.y, pressure: 0.8, buttons: 1, width: 8, height: 8 });
      __ev('pointerup', { pointerId: 5, pointerType: type, clientX: S.at(-1).x, clientY: S.at(-1).y }); };
    window.__tap = (x, y) => __dragDoc([[x, y]]);
    window.__mask = (x, y) => { const e = window.gesso.engine; return e.sel ? e.layerPixels({ target: e.sel }, { x, y, w: 1, h: 1 })[0] : -1; };
    window.__a = (x, y, l) => { const e = window.gesso.engine; return e.layerPixels(l || e.activeLayer, { x, y, w: 1, h: 1 })[3]; };
    window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__line = (n) => Array.from({ length: n + 1 }, (_, i) => i / n);
  });
  const r = {};
  r.rect = await page.evaluate(async () => { const g = window.gesso; g.enterSelectTool(); g.selTool.kind = 'rect'; __dragDoc(__line(10).map((t) => [100 + t * 300, 100 + t * 200])); await __raf();
    return { inside: __mask(250, 200), outside: __mask(500, 200), grab: g.input.grab === g.selTool }; });
  r.addEllipse = await page.evaluate(async () => { const g = window.gesso; g.selTool.kind = 'ellipse'; g.selTool.mode = 1; __dragDoc(__line(10).map((t) => [500 + t * 300, 400 + t * 300])); await __raf();
    return { rectStill: __mask(250, 200), ellipseCentre: __mask(650, 550), ellipseCornerOut: __mask(505, 405) }; });
  r.subtract = await page.evaluate(async () => { const g = window.gesso; g.selTool.kind = 'rect'; g.selTool.mode = 2; __dragDoc(__line(4).map((t) => [150 + t * 60, 150 + t * 60])); await __raf();
    return { hole: __mask(180, 180), rest: __mask(350, 250) }; });
  // freehand drag that closes near the start; then polygon by taps
  r.freehand = await page.evaluate(async () => { const g = window.gesso; g.selTool.kind = 'free'; g.selTool.mode = 0;
    const pts = __line(60).map((t) => [900 + Math.cos(t * Math.PI * 2) * 120, 200 + Math.sin(t * Math.PI * 2) * 80]); __dragDoc(pts); await __raf();
    const a = { centre: __mask(900, 200), out: __mask(700, 200) };
    __tap(100, 600); __tap(300, 600); __tap(200, 800); __tap(101, 601); await __raf();
    return { ...a, poly: __mask(200, 660), ellipseGone: __mask(900, 200) }; });
  // masked painting: brush across the triangle selection only paints inside
  r.masked = await page.evaluate(async () => { const g = window.gesso; g.exitSelectTool(); g.state.toolBrush.brush = 'marker-felt'; g.state.overrides['marker-felt'] = { size: 40, smoothing: 0 }; g.state.color = [0.8, 0.2, 0.2];
    __dragDoc(__line(30).map((t) => [50 + t * 400, 680])); await __raf(); return { inTri: __a(200, 680), outTri: __a(60, 680) }; });
  await page.evaluate(() => window.__raf());
  await T.shot('sel-01-masked-paint');
  // invert + fill; clear; feather
  r.ops = await page.evaluate(async () => { const g = window.gesso, e = g.engine; e.addLayer(); e.deselect();
    g.enterSelectTool(); g.selTool.kind = 'rect'; g.selTool.mode = 0; __dragDoc([[600, 100], [700, 150], [800, 200]]); await __raf();
    e.fillLayer([0.1, 0.4, 0.8]); const filled = [__a(700, 150), __a(900, 150)];
    e.invertSelection(); const inv = [__mask(700, 150), __mask(900, 150)]; e.invertSelection();
    e.featherSelection(20); const fe = [__mask(700, 150), __mask(600, 150), __mask(590, 150)];
    const copy = e.copySelectionToLayer(); const copied = __a(700, 150, copy); e.setProp(copy, 'visible', false); e.active = e.layers.indexOf(copy) - 1;
    return { filled, inv, featherInsideEdgeOutside: fe, copied }; });
  // magic wand on the blue rect (layer pixels)
  r.wand = await page.evaluate(async () => { const g = window.gesso, e = g.engine; e.deselect(); g.selTool.kind = 'auto'; g.selTool.mode = 0; g.selTool.invalidateWand();
    __tap(700, 150); await new Promise((res) => setTimeout(res, 300)); await __raf(); return { inBlue: __mask(700, 150), outside: __mask(900, 150), edgeSoft: __mask(599, 150) }; });
  // transform the selected blue rect: move it right by 200 doc px via the box
  r.xform = await page.evaluate(async () => { const g = window.gesso, e = g.engine; const histBefore = e.history['list'].length;
    await g.startLayerTransform(); await __raf(); const x = g.xform; if (!x) return 'no xform';
    const c = __S(x.xf.cx, x.xf.cy), c2 = __S(x.xf.cx + 200, x.xf.cy); __ev('pointerdown', { pointerId: 7, pointerType: 'pen', clientX: c.x, clientY: c.y, buttons: 1, pressure: 0.5 });
    for (let k = 1; k <= 6; k++) __ev('pointermove', { pointerId: 7, pointerType: 'pen', clientX: c.x + (c2.x - c.x) * k / 6, clientY: c.y, buttons: 1, pressure: 0.5 }); __ev('pointerup', { pointerId: 7, pointerType: 'pen', clientX: c2.x, clientY: c2.y });
    await __raf(); x.finish(true); await __raf();
    const res = { oldPlace: __a(650, 150), newPlace: __a(900, 150), maskMoved: [__mask(650, 150), __mask(900, 150)], steps: e.history['list'].length - histBefore, selectToolBack: !!g.selTool };
    g.undo(); await __raf(); res.afterUndo = [__a(700, 150), __a(950, 150), __mask(700, 150)]; g.redo(); return res; });
  await page.evaluate(() => window.__raf());
  await T.shot('sel-02-after-transform');
  // whole-layer transform without selection: scale the triangle layer 50 % from its centre
  r.layerXform = await page.evaluate(async () => { const g = window.gesso, e = g.engine; g.exitSelectTool(); e.deselect(); e.active = 0;
    await g.startLayerTransform(); await __raf(); const x = g.xform; const b = { ...x.xf }; x.xf.sx = 0.5; x.xf.sy = 0.5; x['apply'](); await __raf(); x.finish(true); await __raf();
    return { srcSize: [x.src.w, x.src.h], centre: [Math.round(b.cx), Math.round(b.cy)], label: e.history.list.at(-1).label }; });
  console.log(JSON.stringify(r));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

// Symmetry: each mode mirrors exactly; radial N with/without mirror; guide drag; assist off; saved with the artwork.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ port: 8134, dsf: 1.5 });
  const { page } = T;
  await page.goto(T.url + '?w=1200&h=1200');
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const cv = document.querySelector('#view');
    window.__ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    window.__strokeDoc = (pts, p = 0.8) => { const e = window.gesso.engine; const S = pts.map(([x, y]) => e.docToScreen(x, y));
      __ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: S[0].x, clientY: S[0].y, pressure: p, buttons: 1 });
      for (const s of S.slice(1)) __ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: s.x, clientY: s.y, pressure: p, buttons: 1 });
      __ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: S.at(-1).x, clientY: S.at(-1).y }); };
    window.__a = (x, y) => window.gesso.engine.layerPixels(window.gesso.engine.activeLayer, { x: Math.round(x), y: Math.round(y), w: 1, h: 1 })[3];
    const g = window.gesso; g.state.toolBrush.brush = 'marker-felt'; g.state.color = [0.1, 0.2, 0.6];
    g.state.overrides['marker-felt'] = { size: 20, smoothing: 0 };
  });
  const r = {};
  r.vertical = await page.evaluate(() => { const g = window.gesso; g.sym.mode = 'vertical'; g.symChanged();
    __strokeDoc([[200, 300], [400, 330], [500, 360]]); return { orig: __a(300, 315), mirror: __a(900, 315), off: __a(300, 700) }; });
  r.horizontal = await page.evaluate(() => { const g = window.gesso; g.engine.addLayer(); g.sym.mode = 'horizontal'; g.symChanged();
    __strokeDoc([[700, 200], [800, 220], [900, 240]]); return { orig: __a(800, 220), mirror: __a(800, 980), off: __a(300, 980) }; });
  r.quadrant = await page.evaluate(() => { const g = window.gesso; g.engine.addLayer(); g.sym.mode = 'quadrant'; g.symChanged();
    __strokeDoc([[150, 150], [250, 180], [350, 210]]); return [__a(250, 180), __a(950, 180), __a(250, 1020), __a(950, 1020)]; });
  r.radialRot = await page.evaluate(() => { const g = window.gesso; g.engine.addLayer(); Object.assign(g.sym, { mode: 'radial', n: 6, mirror: false }); g.symChanged();
    __strokeDoc([[600, 400], [610, 300], [640, 200]]); // near 12 o'clock
    const pts = []; for (let k = 0; k < 6; k++) { const t = k * Math.PI / 3, x = 10, y = -300; pts.push(__a(600 + x * Math.cos(t) - y * Math.sin(t), 600 + x * Math.sin(t) + y * Math.cos(t))); } return pts; });
  r.assistOff = await page.evaluate(() => { const g = window.gesso; g.engine.addLayer(); g.sym.mode = 'vertical'; g.sym.assist = false; g.symChanged();
    __strokeDoc([[100, 1100], [300, 1100]]); const o = { orig: __a(200, 1100), mirror: __a(1000, 1100) }; g.sym.assist = true; g.symChanged(); return o; });
  // kaleidoscope pattern for the screenshot
  await page.evaluate(() => {
    const g = window.gesso; const e = g.engine; e.addLayer(); Object.assign(g.sym, { mode: 'radial', n: 8, mirror: true }); g.symChanged();
    const cols = [[0.85, 0.3, 0.2], [0.95, 0.7, 0.2], [0.2, 0.55, 0.5]];
    g.state.toolBrush.brush = 'ink-brushpen'; g.state.overrides['ink-brushpen'] = { size: 22 };
    for (let k = 0; k < 3; k++) { g.state.color = cols[k]; const pts = []; for (let i = 0; i <= 30; i++) { const t = i / 30; pts.push([600 + 60 + t * 380 * (k + 1) / 3, 600 - 30 - Math.sin(t * Math.PI) * 120 * (k + 1) / 3]); } __strokeDoc(pts, 0.7); }
  });
  await page.evaluate(() => window.gesso.toggleSymBar());
  await page.waitForTimeout(150);
  await T.shot('sym-01-radial-kaleidoscope');
  // drag the centre handle with a finger
  r.drag = await page.evaluate(() => { const g = window.gesso, e = g.engine; const c = e.docToScreen(g.sym.cx, g.sym.cy);
    __ev('pointerdown', { pointerId: 40, pointerType: 'touch', clientX: c.x, clientY: c.y, width: 20, height: 20, buttons: 1 });
    for (let k = 1; k <= 5; k++) __ev('pointermove', { pointerId: 40, pointerType: 'touch', clientX: c.x + k * 20, clientY: c.y + k * 10, width: 20, height: 20, buttons: 1 });
    __ev('pointerup', { pointerId: 40, pointerType: 'touch', clientX: c.x + 100, clientY: c.y + 50 });
    return { cx: Math.round(g.sym.cx), cy: Math.round(g.sym.cy), hist: e.history['list'].length }; });
  await page.evaluate(() => window.gesso.toggleSymBar());
  // snapped shape is mirrored too
  r.shape = await page.evaluate(async () => { const g = window.gesso; g.engine.addLayer(); Object.assign(g.sym, { mode: 'vertical', cx: 600, cy: 600, angle: 0 }); g.symChanged();
    g.state.toolBrush.brush = 'marker-felt'; const e = g.engine;
    const pts = Array.from({ length: 30 }, (_, i) => [150 + i * 8, 800 + (i % 2) * 2]); const S = pts.map(([x, y]) => e.docToScreen(x, y));
    __ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: S[0].x, clientY: S[0].y, pressure: 0.8, buttons: 1 }); for (const s of S.slice(1)) __ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: s.x, clientY: s.y, pressure: 0.8, buttons: 1 });
    await new Promise((r) => setTimeout(r, 700)); __ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: S.at(-1).x, clientY: S.at(-1).y }); g.settle();
    return { kind: 'line', orig: __a(250, 800), mirror: __a(950, 800) }; });
  // persistence
  await page.evaluate(() => new Promise((res) => { const t = () => (window.gesso.autosave.state === 'saved' ? res() : setTimeout(t, 50)); window.gesso.autosave.flush().then(t); }));
  await page.goto(T.url); await page.waitForTimeout(1500);
  r.reloaded = await page.evaluate(() => { const s = window.gesso.sym; return { mode: s.mode, cx: s.cx, button: document.querySelector('#bSym').classList.contains('on') }; });
  console.log(JSON.stringify(r, null, 0));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

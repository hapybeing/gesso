// R1 checks: pen eraser end, two-finger hold rapid undo, pressure settings UI, swap-undo integrity.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ port: 8128, dsf: 1.5 });
  const { page } = T;
  await page.goto(T.url + '?w=1600&h=1000');
  await page.waitForTimeout(800);
  const out = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine, cv = document.querySelector('#view');
    const ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    const stroke = (pts, o = {}) => { ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: pts[0][0], clientY: pts[0][1], pressure: 0.7, buttons: o.buttons || 1 }); for (const p of pts.slice(1)) ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: p[0], clientY: p[1], pressure: 0.7, buttons: o.buttons || 1 }); ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: pts.at(-1)[0], clientY: pts.at(-1)[1] }); };
    const alphaSum = () => { const px = e.layerPixels(e.layers[0], { x: 0, y: 0, w: e.w, h: e.h }); let a = 0; for (let i = 3; i < px.length; i += 4) a += px[i]; return a; };
    const r = {};
    g.state.toolBrush.brush = 'marker-felt'; g.tool = 'brush';
    for (let k = 0; k < 6; k++) stroke([[300, 200 + k * 40], [900, 220 + k * 40]]);
    r.afterDraw = alphaSum();
    stroke([[600, 150], [600, 500]], { buttons: 33 }); // eraser end
    r.afterEraserEnd = alphaSum();
    r.toolStillBrush = g.tool === 'brush';
    r.lastLabel = e.history.list.at(-1).label;
    // undo the erase then redo it: swap undo must restore exactly
    e.history.undo(); r.undoErase = alphaSum() === r.afterDraw; e.history.redo(); r.redoErase = alphaSum() === r.afterEraserEnd;
    // two-finger hold: rapid undo
    ev('pointerdown', { pointerId: 21, pointerType: 'touch', clientX: 600, clientY: 600, width: 20, height: 20, buttons: 1 });
    ev('pointerdown', { pointerId: 22, pointerType: 'touch', clientX: 700, clientY: 600, width: 20, height: 20, buttons: 1 });
    await new Promise((res) => setTimeout(res, 1500));
    ev('pointerup', { pointerId: 21, pointerType: 'touch', clientX: 600, clientY: 600 });
    ev('pointerup', { pointerId: 22, pointerType: 'touch', clientX: 700, clientY: 600 });
    r.undosLeft = e.history['idx'];
    r.afterRapid = alphaSum();
    return r;
  });
  console.log(JSON.stringify(out));
  await page.evaluate(() => window.gesso.showSettings());
  await page.waitForTimeout(200);
  // calibrate with a light-handed synthetic scribble
  await page.evaluate(() => {
    const pad = document.querySelector('.ppad'); const r = pad.getBoundingClientRect();
    const ev = (t, x, y, p) => pad.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 9, pointerType: 'pen', clientX: r.left + x, clientY: r.top + y, pressure: p, buttons: t === 'pointerup' ? 0 : 1 }));
    ev('pointerdown', 20, 75, 0.1);
    for (let i = 0; i < 200; i++) ev('pointermove', 20 + i * 1.6, 75 + Math.sin(i / 8) * 40, 0.08 + 0.3 * Math.abs(Math.sin(i / 23)));
    ev('pointerup', 340, 75, 0);
  });
  await page.waitForTimeout(200);
  console.log('curve after calibration', JSON.stringify(await page.evaluate(() => window.gesso.state.settings.curve)), 'map(0.25)=', await page.evaluate(() => window.gesso.curve.map(0.25).toFixed(2)));
  await T.shot('r1-pressure-settings');
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

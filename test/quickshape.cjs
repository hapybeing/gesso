// Shape snapping end to end: draw, hold still, rubber-band, lift, drag a handle, commit; second finger = perfect.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ port: 8132, dsf: 1.5 });
  const { page } = T;
  await page.goto(T.url + '?w=1600&h=1000');
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const cv = document.querySelector('#view');
    window.__ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    const pen = (t, x, y, p = 0.6) => __ev(t, { pointerId: 5, pointerType: 'pen', clientX: x, clientY: y, pressure: t === 'pointerup' ? 0 : p, buttons: t === 'pointerup' ? 0 : 1 });
    window.__pen = pen;
    window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let s = 7; window.__n = () => { s = (s * 16807) % 2147483647; return (s / 2147483647 - 0.5) * 3; };
    window.__draw = async (pts) => { pen('pointerdown', ...pts[0]); for (const p of pts.slice(1)) pen('pointermove', p[0] + __n(), p[1] + __n()); };
    window.__state = () => { const g = window.gesso; return { phase: g.shapes.phase, kind: g.shapes.shape?.kind, hist: g.engine.history['list'].length, stroking: g.engine.stroking }; };
    window.gesso.state.toolBrush.brush = 'ink-studio'; window.gesso.state.color = [0.1, 0.1, 0.12];
  });
  const r = {};
  // 1. rough ellipse, hold, rubber-band bigger, lift
  r.ellipse = await page.evaluate(async () => {
    const pts = Array.from({ length: 90 }, (_, i) => { const t = (i / 86) * Math.PI * 2; return [400 + Math.cos(t) * 160, 300 + Math.sin(t) * 90]; });
    await __draw(pts);
    await __sleep(700);
    const a = __state();
    const last = pts[pts.length - 1];
    for (let k = 1; k <= 10; k++) __pen('pointermove', last[0] + k * 4, last[1] + k * 1);
    await __sleep(50);
    const rx = window.gesso.shapes.shape?.ex.rx;
    __pen('pointerup', last[0] + 40, last[1] + 10);
    await __sleep(50);
    return { afterHold: a, afterLift: __state(), rx: Math.round(rx) };
  });
  await T.shot('qs-01-ellipse-edit');
  // 2. drag the right axis handle outwards with the pen, then Done
  r.drag = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    const hnd = g.shapes.shape.handles()[1];
    const s = e.docToScreen(hnd.x, hnd.y);
    __pen('pointerdown', s.x, s.y);
    for (let k = 1; k <= 8; k++) __pen('pointermove', s.x + k * 8, s.y);
    __pen('pointerup', s.x + 64, s.y);
    await __sleep(30);
    const st = __state();
    document.querySelector('#qsbar .btn:not(.ghost)').click();
    return { duringEdit: st, afterDone: __state() };
  });
  // 3. sloppy line + second finger => perfect 15° line
  r.line = await page.evaluate(async () => {
    const pts = Array.from({ length: 40 }, (_, i) => [300 + i * 12, 600 - i * 3.4]); // ~16° not on a step
    await __draw(pts);
    await __sleep(700);
    __ev('pointerdown', { pointerId: 31, pointerType: 'touch', clientX: 900, clientY: 700, width: 20, height: 20, buttons: 1 });
    __ev('pointerup', { pointerId: 31, pointerType: 'touch', clientX: 900, clientY: 700 });
    const sh = window.gesso.shapes.shape; const a = sh && Math.atan2(sh.pts[1].y - sh.pts[0].y, sh.pts[1].x - sh.pts[0].x) * 180 / Math.PI;
    __pen('pointerup', ...pts[pts.length - 1]);
    await __sleep(30);
    const st = __state();
    // a new stroke elsewhere commits the shape
    __pen('pointerdown', 1000, 200); __pen('pointermove', 1010, 205); __pen('pointerup', 1012, 206);
    return { kind: st.kind, angleDeg: a && +a.toFixed(2), phase: st.phase, afterNewStroke: __state() };
  });
  // 4. rectangle then "Freehand" keeps the hand-drawn stroke
  r.rect = await page.evaluate(async () => {
    const seg = (a, b, n) => Array.from({ length: n }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
    const pts = [...seg([700, 380], [1000, 380], 25), ...seg([1000, 380], [1000, 560], 18), ...seg([1000, 560], [700, 560], 25), ...seg([700, 560], [702, 390], 18)];
    await __draw(pts); await __sleep(700); __pen('pointerup', ...pts[pts.length - 1]); await __sleep(30);
    const st = __state();
    await new Promise((r) => setTimeout(r, 30));
    return { kind: st.kind, phase: st.phase };
  });
  await T.shot('qs-02-rect-edit');
  r.freehand = await page.evaluate(async () => { document.querySelector('#qsbar .btn.ghost').click(); await __sleep(30); return __state(); });
  // 5. undo while editing removes the shape
  r.undoCancel = await page.evaluate(async () => {
    const pts = Array.from({ length: 30 }, (_, i) => [200 + i * 10, 850]);
    await __draw(pts); await __sleep(700); __pen('pointerup', ...pts[pts.length - 1]); await __sleep(20);
    const before = __state(); window.gesso.undo(); return { before, after: __state() };
  });
  // 6. a scribble held still stays freehand
  r.scribble = await page.evaluate(async () => {
    const pts = Array.from({ length: 80 }, (_, i) => [300 + i * 6, 750 + Math.sin(i / 4) * 30 + Math.sin(i / 11) * 25]);
    await __draw(pts); await __sleep(700); const st = __state(); __pen('pointerup', ...pts[pts.length - 1]); return st;
  });
  await page.waitForTimeout(100);
  await T.shot('qs-03-final');
  console.log(JSON.stringify(r, null, 1));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

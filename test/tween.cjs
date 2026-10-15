// Transform tween: a 40 px square tweened to 2× size, half a turn and 300 px right with 3 in-betweens. Checks
// in-between sizes (angle-wise interpolation keeps the square square and growing by an equal ratio per frame; a
// matrix lerp would shrink it to 20 px mid-way), centres for linear and ease-in-out, frame order, one undo step, cancel.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ dsf: 1 }); const { page } = T;
  await page.goto(T.url + '?w=640&h=360&fresh=1'); await page.waitForTimeout(900);
  const out = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine, a = g.anim;
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = new OffscreenCanvas(e.w, e.h), x = c.getContext('2d'); x.fillStyle = '#c03020'; x.fillRect(100, 100, 40, 40);
    e.drawCanvasToLayer(e.activeLayer, c, 0, 0); e.activeLayer.name = 'Ball';
    a.toggle(true); await raf();
    const measure = (l) => { const d = e.layerPixels(l, { x: 0, y: 0, w: e.w, h: e.h }); let n = 0, sx = 0, sy = 0; for (let y = 0; y < e.h; y++) for (let xx = 0; xx < e.w; xx++) if (d[(y * e.w + xx) * 4 + 3] > 127) { n++; sx += xx; sy += y; } return { area: n, cx: n ? Math.round(sx / n) : -1, cy: n ? Math.round(sy / n) : -1 }; };
    const run = async (ease) => {
      a.goto(0); await g.tweenFrame(3, ease); await raf();
      const tool = g.xform; if (!tool) return null;
      tool.xf = { cx: 420, cy: 120, sx: 2, sy: 2, rot: Math.PI }; tool.finish(true); await raf();
      return a.frames().map((f) => ({ name: f.base.name, ...measure(f.base) }));
    };
    const res = {};
    res.linear = await run('linear');
    res.undoSteps = 0; const n0 = a.frames().length; g.undo(); res.afterUndo = a.frames().length; res.before = n0;
    res.inout = await run('inout'); g.undo();
    // cancel leaves nothing behind
    a.goto(0); await g.tweenFrame(2, 'linear'); g.xform.finish(false); await raf(); res.afterCancel = a.frames().length;
    return res;
  });
  await T.shot('tween-01');
  console.log(JSON.stringify(out));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const L = out.linear, I = out.inout;
  const side = (f) => Math.sqrt(f.area);
  const checks = {
    count: L && L.length === 5 && out.before === 5 && out.afterUndo === 1 && out.afterCancel === 1,
    order: L.map((f) => f.name).join('|') === 'Ball|Ball · 1/4|Ball · 2/4|Ball · 3/4|Ball end',
    sizes: [0, 1, 2, 3, 4].every((k) => Math.abs(side(L[k]) - 40 * 2 ** (k / 4)) < 2),   // equal zoom ratio per frame
    centresLinear: [120, 195, 270, 345, 420].every((cx, k) => Math.abs(L[k].cx - cx) <= 1 && Math.abs(L[k].cy - 120) <= 1),
    centresEase: [0, 0.15625, 0.5, 0.84375, 1].every((t, k) => Math.abs(I[k].cx - (120 + 300 * t)) <= 1),
  };
  console.log(JSON.stringify(checks));
  process.exit(Object.values(checks).every(Boolean) && !T.errs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

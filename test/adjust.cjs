// Adjustments: each filter's live preview, cancel = exact restore, apply = one undo step, selection-limited,
// liquify push/twirl/pinch by pen, curves monotone LUT, gradient map, blur profile, sharpen, noise statistics.
const { start } = require('./lib.cjs');
const helpers = () => {
  const cv = document.querySelector('#view');
  window.__ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
  window.__S = (x, y) => window.gesso.engine.docToScreen(x, y);
  window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__c = (x, y) => { const e = window.gesso.engine; e.render(); return e.sample(x, y).map((v) => Math.round(v * 255)); };
  window.__px = (x, y) => { const e = window.gesso.engine; return [...e.layerPixels(e.activeLayer, { x, y, w: 1, h: 1 })]; };
  window.__sig = () => { const e = window.gesso.engine; const d = e.layerPixels(e.activeLayer, { x: 0, y: 0, w: e.w, h: e.h }); let h = 2166136261; for (let i = 0; i < d.length; i += 3) h = Math.imul(h ^ d[i], 16777619); return h >>> 0; };
};
(async () => {
  const T = await start({ port: 8153, dsf: 1 });
  const { page } = T;
  const out = {};
  await page.goto(T.url + '?w=600&h=400');
  await page.waitForTimeout(900);
  await page.evaluate(helpers);
  // test image: left half orange (230,120,40), right half a grey ramp; a black vertical bar at x 300..310
  await page.evaluate(() => {
    const e = window.gesso.engine, W = e.w, H = e.h, d = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; let c;
      if (x >= 300 && x < 310) c = [0, 0, 0]; else if (x < 300) c = [230, 120, 40]; else { const v = Math.round((x - 310) / 289 * 255); c = [v, v, v]; }
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
    e.writeRect(e.activeLayer, { x: 0, y: 0, w: W, h: H }, d);
  });
  out.base = await page.evaluate(() => ({ orange: __px(100, 200), ramp: __px(455, 200), bar: __px(305, 200), sig: __sig() }));
  const run = (fn) => page.evaluate(fn);
  out.hsb = await run(async () => { const g = window.gesso; g.adj.open('hsb'); g.adj.s.preview({ hue: 180, sat: 0, bri: 0 }); const hue = __px(100, 200);
    g.adj.s.preview({ hue: 0, sat: -100, bri: 0 }); const desat = __px(100, 200); g.adj.s.preview({ hue: 0, sat: 0, bri: 50 }); const bri = __px(100, 200);
    g.adj.close(false); return { hue, desat, bri, restored: __sig() }; });
  out.balance = await run(async () => { const g = window.gesso; g.adj.open('balance'); g.adj.s.preview({ shadows: [0, 0, 0], mid: [0, 0, 100], hi: [0, 0, 0], keepLum: false }); const mid = __px(455, 200); const dark = __px(312, 200);
    g.adj.close(false); return { mid, dark }; });
  out.curves = await run(async () => { const g = window.gesso; g.adj.open('curves'); g.adj.s.preview({ curves: [[[0, 1], [1, 0]], [[0, 0], [1, 1]], [[0, 0], [1, 1]], [[0, 0], [1, 1]]] }); const inv = __px(100, 200);
    g.adj.s.preview({ curves: [[[0, 0], [0.5, 0.75], [1, 1]], [[0, 0], [1, 1]], [[0, 0], [1, 1]], [[0, 0], [1, 1]]] }); const lift = __px(455, 200);
    g.adj.close(true); const undoLabel = g.engine.history.canUndo; const after = __px(100, 200); g.undo(); return { inv, lift, applied: after, undone: __px(100, 200), undoLabel }; });
  out.gradmap = await run(async () => { const g = window.gesso; g.adj.open('gradmap'); g.adj.s.preview({ gradient: 0, amount: 100 }); const noir = __px(100, 200); const black = __px(305, 200); g.adj.close(false); return { noir, black }; });
  out.blur = await run(async () => { const g = window.gesso; g.adj.open('blur'); g.adj.s.preview({ radius: 20 }); const prof = [290, 295, 300, 305, 310, 315, 320].map((x) => __px(x, 200)[0]); g.adj.close(false); return { prof, restored: __sig() }; });
  out.sharpen = await run(async () => { const g = window.gesso; g.adj.open('sharpen'); g.adj.s.preview({ amount: 150, radius: 3 }); const edge = [297, 299, 311, 313].map((x) => __px(x, 200)[0]); g.adj.close(false); return { edge }; });
  out.noise = await run(async () => { const g = window.gesso, e = g.engine; g.adj.open('noise'); g.adj.s.preview({ amount: 40, mono: true, scale: 1 });
    const d = e.layerPixels(e.activeLayer, { x: 50, y: 50, w: 100, h: 100 }); let s = 0, s2 = 0, n = 0, mono = 0; for (let i = 0; i < d.length; i += 4) { const v = d[i]; s += v; s2 += v * v; n++; if (d[i + 1] - d[i] === 120 - 230 || Math.abs((d[i + 1] - d[i]) - (120 - 230)) < 3) mono++; }
    const mean = s / n, sd = Math.sqrt(s2 / n - mean * mean); g.adj.close(false); return { mean: Math.round(mean), sd: Math.round(sd), monoFrac: +(mono / n).toFixed(2) }; });
  // selection-limited: only the rectangle changes
  out.sel = await run(async () => { const g = window.gesso, e = g.engine;
    const c = new OffscreenCanvas(e.w, e.h), x = c.getContext('2d'); x.fillStyle = '#f00'; x.fillRect(0, 0, 150, e.h); e.selectFromCanvas(c, 0, 'Select');
    g.adj.open('hsb'); g.adj.s.preview({ hue: 0, sat: -100, bri: 0 }); const inside = __px(50, 200), outside = __px(200, 200); g.adj.close(true); g.undo(); g.undo(); return { inside, outside, sel: !!e.sel }; });
  await T.shot('adjust-00-before-liquify');
  // liquify: push the bar sideways with the pen
  out.liquify = await run(async () => { const g = window.gesso, e = g.engine; g.adj.open('liquify'); g.adj.s.params.size = 120; g.adj.s.params.strength = 100; g.adj.s.params.mode = 'push';
    const before = __px(330, 200);
    const a = __S(305, 200), b = __S(345, 200);
    __ev('pointerdown', { pointerId: 7, pointerType: 'pen', clientX: a.x, clientY: a.y, pressure: 1, buttons: 1 });
    for (let i = 1; i <= 10; i++) __ev('pointermove', { pointerId: 7, pointerType: 'pen', clientX: a.x + (b.x - a.x) * i / 10, clientY: a.y, pressure: 1, buttons: 1 });
    __ev('pointerup', { pointerId: 7, pointerType: 'pen', clientX: b.x, clientY: b.y, pressure: 0 });
    await __raf();
    const after = Math.min(...[325, 330, 335, 340, 345, 350, 355].map((x) => __px(x, 200)[0])), was = __px(304, 200), far = __px(305, 20);
    // pinch held in place for a moment
    g.adj.s.params.mode = 'pinch'; const p = __S(150, 300);
    __ev('pointerdown', { pointerId: 7, pointerType: 'pen', clientX: p.x, clientY: p.y, pressure: 1, buttons: 1 }); await new Promise((r) => setTimeout(r, 200)); __ev('pointerup', { pointerId: 7, pointerType: 'pen', clientX: p.x, clientY: p.y, pressure: 0 });
    return { before, after, was, far, grab: e && g.input.grab === g.adj };
  });
  await page.waitForTimeout(100);
  await T.shot('adjust-01-liquify');
  out.liquifyEnd = await run(async () => { const g = window.gesso; g.adj.close(true); const applied = __px(330, 200); g.undo(); return { applied, undone: __px(330, 200), restored: __sig() }; });
  await page.evaluate(() => { const g = window.gesso; g.adj.open('curves'); });
  await page.waitForTimeout(200);
  await T.shot('adjust-02-curves');
  await page.evaluate(() => { const g = window.gesso; g.adj.close(false); g.adj.open('gradmap'); g.adj.s.preview({ gradient: 2 }); });
  await page.waitForTimeout(200);
  await T.shot('adjust-03-gradmap');
  await page.evaluate(() => window.gesso.adj.close(false));
  console.log(JSON.stringify(out));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const B = out.base.sig;
  const ok = out.hsb.restored === B && out.hsb.desat[0] === out.hsb.desat[1] && Math.abs(out.hsb.desat[0] - 144) < 4 && out.hsb.hue[2] > out.hsb.hue[0] && out.blur.restored === B
    && out.curves.inv[0] === 255 - 230 && out.curves.undone[0] === 230 && out.gradmap.black[0] === 0 && out.sel.inside[0] === out.sel.inside[1] && out.sel.outside[0] === 230
    && out.liquify.after < 40 && out.liquify.was[0] > 100 && out.liquify.far[0] === 0 && out.liquifyEnd.restored === B && out.blur.prof[0] > out.blur.prof[3];
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

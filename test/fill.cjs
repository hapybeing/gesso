// Fill tool: reference-layer fill with gap closing + expand under the line art, ColorDrop threshold slide,
// linear/radial gradients (premultiplied, dithered), recolour keeping shading, ColorDrop from the colour button.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ dsf: 1 });
  const { page } = T; page.on('console', (m) => { if (m.type() === 'log') console.log('PAGE', m.text()); }); page.on('crash', () => console.log('CRASH'));
  await page.goto(T.url + '?w=1000&h=700&fresh=1');
  await page.waitForTimeout(900);
  await page.exposeFunction('T_shot', (n) => T.shot(n));
  const out = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine, cv = document.querySelector('#view');
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 9, pointerType: 'pen', ...o }));
    const tap = (x, y) => { const p = e.docToScreen(x, y); ev('pointerdown', { clientX: p.x, clientY: p.y, pressure: 0.5, buttons: 1 }); ev('pointerup', { clientX: p.x, clientY: p.y, pressure: 0 }); };
    const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await raf(); };
    const px = (l, x, y) => Array.from(e.layerPixels(l, { x, y, w: 1, h: 1 }));
    const count = (l) => { const d = e.layerPixels(l, { x: 0, y: 0, w: e.w, h: e.h }); let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 127) n++; return n; };
    const res = {};
    // line art: a square outline (3 px, anti-aliased) with a 6 px gap in its top edge
    const lines = e.activeLayer; lines.name = 'Lines';
    const c = new OffscreenCanvas(e.w, e.h), x = c.getContext('2d');
    x.strokeStyle = '#000'; x.lineWidth = 3; x.beginPath(); x.moveTo(306, 200); x.lineTo(500, 200); x.lineTo(500, 400); x.lineTo(200, 400); x.lineTo(200, 200); x.lineTo(300, 200); x.stroke();
    e.drawCanvasToLayer(lines, c, 0, 0);
    e.addLayer(); const flats = e.activeLayer; flats.name = 'Flats';
    g.refUid = lines.uid;
    g.enterFillTool(); const f = g.fillSet; f.mode = 'fill'; f.ref = 'reference'; f.threshold = 0.1; f.expand = 0; f.gap = 0;
    g.state.color = [0.9, 0.6, 0.1];
    // 1. no gap closing: leaks out through the gap (fills nearly everything)
    tap(350, 300); await until(() => g.fill.stats.fills >= 1); await raf(); console.log('step1');
    res.leak = count(flats); g.undo();
    // 2. close gaps (4 → closes up to 8 px): stays inside the square; expand 0 leaves the line's inner AA edge uncovered
    f.gap = 4; tap(350, 300); await until(() => g.fill.stats.fills >= 2); await raf(); console.log('step2');
    res.closed = count(flats); res.closedMs = g.fill.stats.lastMs;
    res.insideA = px(flats, 350, 300)[3]; res.outsideA = px(flats, 600, 300)[3]; res.gapA = px(flats, 303, 190)[3];
    res.cornerA = px(flats, 203, 203)[3];        // corner reached by the geodesic regrow
    res.edge0 = px(flats, 200, 300)[3];          // the line's core (it spans 198.5–201.5): not filled without expand
    g.undo();
    // 3. expand 2: the fill tucks under the line (no halo), still not outside it
    f.expand = 2; tap(350, 300); await until(() => g.fill.stats.fills >= 3); await raf(); console.log('step3');
    res.edge2 = px(flats, 200, 300)[3]; res.outside2 = px(flats, 196, 300)[3]; res.linesUntouched = px(lines, 350, 300)[3] === 0;
    const h0 = count(flats); g.undo(); res.undone = count(flats) === 0; g.redo(); res.redone = count(flats) === h0;
    await T_shot('fill-01-gap-expand');
    // 4. slide to change the threshold while holding (ColorDrop behaviour): a soft radial blob on a new layer
    e.addLayer(); const blob = e.activeLayer;
    const c2 = new OffscreenCanvas(e.w, e.h), y = c2.getContext('2d'); const gr = y.createRadialGradient(750, 450, 10, 750, 450, 200); gr.addColorStop(0, '#203080'); gr.addColorStop(1, '#a0b0f0'); y.fillStyle = gr; y.fillRect(550, 250, 400, 400);
    e.drawCanvasToLayer(blob, c2, 0, 0);
    e.addLayer(); const tgt = e.activeLayer; f.ref = 'canvas'; f.gap = 0; f.expand = 0; f.threshold = 0.05;
    const p = e.docToScreen(750, 450);
    ev('pointerdown', { clientX: p.x, clientY: p.y, pressure: 0.5, buttons: 1 });
    await until(() => g.fill['session'] && g.fill['session'].res);
    const a1 = g.fill['session'].res.area;
    for (let i = 1; i <= 10; i++) ev('pointermove', { clientX: p.x + i * 15, clientY: p.y, pressure: 0.5, buttons: 1 });
    await raf(); await raf();
    const a2 = g.fill['session'] && g.fill['session'].res ? g.fill['session'].res.area : -1;
    await T_shot('fill-02-threshold-slide');
    ev('pointerup', { clientX: p.x + 150, clientY: p.y, pressure: 0 });
    await until(() => g.fill.stats.fills >= 4); await raf(); console.log('step4');
    res.slide = { a1, a2, threshold: +f.threshold.toFixed(3), filled: count(tgt) };
    // 5. gradients
    e.addLayer(); const gl = e.activeLayer; f.mode = 'gradient'; f.grad = 'linear'; f.gradTo = 'transparent'; g.renderFillBar();
    const drag = (a, b) => { const s = e.docToScreen(...a), t = e.docToScreen(...b); ev('pointerdown', { clientX: s.x, clientY: s.y, pressure: 0.5, buttons: 1 }); for (let i = 1; i <= 6; i++) ev('pointermove', { clientX: s.x + (t.x - s.x) * i / 6, clientY: s.y + (t.y - s.y) * i / 6, pressure: 0.5, buttons: 1 }); ev('pointerup', { clientX: t.x, clientY: t.y, pressure: 0 }); };
    g.state.color = [0.2, 0.4, 1];
    drag([100, 100], [700, 100]); await raf();
    const row = e.layerPixels(gl, { x: 0, y: 100, w: e.w, h: 1 });
    const A = (xx) => row[xx * 4 + 3], straight = (xx) => [0, 1, 2].map((k) => Math.round(row[xx * 4 + k] / row[xx * 4 + 3] * 255));
    let mono = 0; for (let xx = 101; xx < 700; xx++) if (A(xx) > A(xx - 1) + 2) mono++;
    res.linear = { a50: A(50), a100: A(100), a400: A(400), a700: A(700), a900: A(900), col400: straight(400), backsteps: mono };
    g.undo();
    f.grad = 'radial'; f.gradTo = 'previous'; drag([500, 350], [700, 350]); await raf();
    res.radial = { centre: px(gl, 500, 350), mid: px(gl, 600, 350), out: px(gl, 900, 350) };
    // 6. recolour keeps shading and anti-aliasing: two-tone red disc → blue
    e.addLayer(); const rc = e.activeLayer;
    const c3 = new OffscreenCanvas(e.w, e.h), z = c3.getContext('2d'); z.fillStyle = '#c03030'; z.beginPath(); z.arc(300, 550, 60, 0, 7); z.fill(); z.fillStyle = '#902020'; z.fillRect(300, 520, 40, 40);
    e.drawCanvasToLayer(rc, c3, 0, 0);
    const before = { light: px(rc, 270, 550), dark: px(rc, 320, 540) };
    f.mode = 'recolour'; f.global = false; f.threshold = 0.3; g.state.color = [0.19, 0.19, 0.75];
    tap(270, 550); await until(() => g.fill.stats.fills >= 5); await raf(); console.log('step5');
    res.recolour = { before, light: px(rc, 270, 550), dark: px(rc, 320, 540), edgeA: [before.light[3], px(rc, 359, 550)[3]] };
    g.exitFillTool();
    // 7. ColorDrop from the colour button onto the canvas (pen events on the real DOM)
    e.addLayer(); g.state.color = [0.1, 0.8, 0.3]; g.updateColorButton(); g.fillSet.threshold = 0.1; g.fillSet.ref = 'layer';
    const btn = document.querySelector('#bColor').getBoundingClientRect();
    return { res, btn: { x: btn.left + btn.width / 2, y: btn.top + btn.height / 2 }, drop: e.docToScreen(800, 150), fills: g.fill.stats.fills };
  });
  await page.mouse.move(out.btn.x, out.btn.y); await page.mouse.down();
  await page.mouse.move(out.btn.x - 60, out.btn.y + 60, { steps: 4 }); await page.mouse.move(out.drop.x, out.drop.y, { steps: 8 });
  await page.mouse.up(); await page.waitForTimeout(600);
  out.res.colorDrop = await page.evaluate(async () => { const g = window.gesso, e = g.engine; for (let i = 0; i < 100 && g.fill.stats.fills < 6; i++) await new Promise((r) => requestAnimationFrame(r)); return { fills: g.fill.stats.fills, a: Array.from(e.layerPixels(e.activeLayer, { x: 800, y: 150, w: 1, h: 1 })), pop: !!document.querySelector('.pop') }; });
  console.log(JSON.stringify(out.res));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const r = out.res, W = 1000 * 700;
  const checks = {
    leak: r.leak > W * 0.9, closed: r.closed > 290 * 190 && r.closed < 300 * 200 && r.insideA === 255 && r.outsideA === 0 && r.gapA === 0 && r.cornerA > 0,
    expand: r.edge0 < 128 && r.edge2 > 128 && r.outside2 === 0 && r.linesUntouched, undo: r.undone && r.redone,
    slide: r.slide.a2 > r.slide.a1 * 1.5 && r.slide.threshold > 0.25 && r.slide.filled > 0,
    linear: r.linear.a50 > 250 && r.linear.a100 > 250 && Math.abs(r.linear.a400 - 128) < 6 && r.linear.a700 < 3 && r.linear.a900 === 0 && Math.abs(r.linear.col400[2] - 255) < 6 && r.linear.backsteps === 0,
    radial: r.radial.centre[3] === 255 && r.radial.out[3] === 255 && r.radial.mid[3] === 255,
    recolour: r.recolour.light[2] > r.recolour.light[0] && r.recolour.dark[2] > r.recolour.dark[0] && r.recolour.light[2] - r.recolour.dark[2] > 20 && r.recolour.edgeA[0] === r.recolour.before.light[3],
    colorDrop: r.colorDrop.fills >= 6 && r.colorDrop.a[1] > 150 && !r.colorDrop.pop,
  };
  console.log(JSON.stringify(checks));
  process.exit(Object.values(checks).every(Boolean) && !T.errs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

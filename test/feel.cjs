// Brush feel round 2: predicted tip (overlay drawn ahead of the pen from getPredictedEvents, gone on lift),
// brush file export → import round trip (validated, clamped), colour harmony swatches, history palette,
// and the stylus & palm test page (stats from a pen stroke + a palm-sized touch).
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ port: 8155, dsf: 1 });
  const { page } = T;
  const out = {};
  await page.goto(T.url + '?w=900&h=700');
  await page.waitForTimeout(900);
  out.predict = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine, cv = document.querySelector('#view'), ov = document.querySelector('#ov');
    g.state.toolBrush.brush = 'marker-felt'; g.state.overrides['marker-felt'] = { size: 24, smoothing: 0.5 }; g.state.color = [0.9, 0.1, 0.1]; g.tool = 'brush';
    const mk = (t, x, y, pred) => { const ev = new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 9, pointerType: 'pen', clientX: x, clientY: y, pressure: 0.8, buttons: t === 'pointerup' ? 0 : 1 });
      if (pred) Object.defineProperty(ev, 'getPredictedEvents', { value: () => pred.map(([px, py]) => new PointerEvent('pointermove', { pointerType: 'pen', clientX: px, clientY: py, pressure: 0.8 })) }); return ev; };
    const a = e.docToScreen(200, 350);
    cv.dispatchEvent(mk('pointerdown', a.x, a.y));
    for (let i = 1; i <= 12; i++) cv.dispatchEvent(mk('pointermove', a.x + i * 15, a.y, [[a.x + i * 15 + 20, a.y], [a.x + i * 15 + 40, a.y]]));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // overlay pixels: ahead of the last real sample (predicted region) vs far away
    const dpr = ov.width / ov.clientWidth;
    const px = (x, y) => { const c = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true }); c.drawImage(ov, Math.round(x * dpr), Math.round(y * dpr), 1, 1, 0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data]; };
    const lastX = a.x + 180;
    const ahead = px(lastX + 30, a.y), beyond = px(lastX + 120, a.y);
    const stats = { ...g.predStats };
    cv.dispatchEvent(mk('pointerup', lastX, a.y));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const afterLift = px(lastX + 30, a.y);
    // the canvas itself never contains the predicted part
    const canvasAhead = e.sample(e.screenToDoc(lastX + 35, a.y).x, 350).map((v) => Math.round(v * 255));
    return { ahead, beyond, afterLift, canvasAhead, stats: { ...stats, aheadPx: Math.round(stats.aheadPx / Math.max(1, stats.withPrediction)) } };
  });
  await T.shot('feel-01-after');
  out.brushFile = await page.evaluate(async () => {
    const g = window.gesso;
    const { brushFile, parseBrushFile, addCustomBrushes, BRUSHES } = window.gessoTest.brushes;
    const b = g.brushFor('brush');
    const txt = brushFile([{ ...b, size: 77, opacity: 0.5, name: 'My Marker' }]);
    const parsed = parseBrushFile(txt);
    const evil = parseBrushFile(JSON.stringify({ format: 'gesso-brush', version: 1, brushes: [{ name: 'x', size: 1e9, shape: 'nope', grain: 'paper', opacity: -3, onload: 'alert(1)' }] }))[0];
    const added = addCustomBrushes(parsed);
    let bad = ''; try { parseBrushFile('{"format":"other"}'); } catch (e) { bad = e.message; }
    return { roundTrip: parsed[0].size === 77 && parsed[0].opacity === 0.5 && parsed[0].name === 'My Marker' && parsed[0].shape === b.shape, clamped: [evil.size, evil.shape, evil.opacity, 'onload' in evil], imported: added[0].id, group: added[0].group, inLib: BRUSHES.some((x) => x.id === added[0].id), bytes: txt.length, bad };
  });
  out.colour = await page.evaluate(async () => {
    const g = window.gesso; g.state.color = [0.9, 0.2, 0.1]; g.state.settings.harmony = 'triad'; g.togglePop('color', g.renderColor);
    await new Promise((r) => setTimeout(r, 100));
    const harm = [...document.querySelectorAll('.swatches.harm .sw')].map((b) => b.title);
    const hist = [...document.querySelectorAll('.pop-color .swatches')].length;
    return { harm, hist, painted: g.state.recent.slice(0, 3) };
  });
  await T.shot('feel-02-harmony');
  await page.evaluate(() => window.gesso.closePop());
  out.stylus = await page.evaluate(async () => {
    const g = window.gesso; const t = g.openStylusTest();
    const pad = document.querySelector('.stest-pad'), r = pad.getBoundingClientRect();
    const ev = (type, o) => pad.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...o }));
    let ts = 0;
    ev('pointerdown', { pointerId: 2, pointerType: 'pen', clientX: r.left + 50, clientY: r.top + 100, pressure: 0.2, buttons: 1 });
    for (let i = 0; i < 60; i++) ev('pointermove', { pointerId: 2, pointerType: 'pen', clientX: r.left + 50 + i * 8, clientY: r.top + 100 + Math.sin(i / 6) * 40, pressure: 0.2 + 0.6 * (i / 60), tiltX: 30, tiltY: 10, buttons: 1 });
    ev('pointerup', { pointerId: 2, pointerType: 'pen', clientX: r.left + 530, clientY: r.top + 100, pressure: 0 });
    ev('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: r.left + 300, clientY: r.top + 300, width: 90, height: 70, buttons: 1 });
    ev('pointerup', { pointerId: 3, pointerType: 'touch', clientX: r.left + 300, clientY: r.top + 300, width: 90, height: 70 });
    t.render();
    const rows = Object.fromEntries([...document.querySelectorAll('.stest-stats .srow')].map((d) => [d.children[0].textContent, d.children[1].textContent]));
    return { records: t.log.length, rows, tips: document.querySelector('.stest-tips').textContent };
  });
  await page.waitForTimeout(150);
  await T.shot('feel-03-stylus-test');
  await page.evaluate(() => document.querySelector('.stest .btn.small').click());
  console.log(JSON.stringify(out));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const p = out.predict;
  const ok = p.ahead[3] > 100 && p.beyond[3] === 0 && p.afterLift[3] === 0 && p.canvasAhead[1] > 200 && out.brushFile.roundTrip && out.brushFile.clamped[0] === 1000 && out.brushFile.clamped[3] === false
    && out.brushFile.inLib && out.colour.harm.length === 3 && out.stylus.records > 60 && out.stylus.rows['Touches / rejected as palm'] === '1 / 1';
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

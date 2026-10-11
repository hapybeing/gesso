// Text tool (place by tap, type, fonts incl. bundled, align, drag to move, one undo step, editable later,
// persisted) and the reference window (live canvas preview, image mode, colour pick).
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ port: 8156, dsf: 1 });
  const { page } = T;
  const out = {};
  await page.goto(T.url + '?w=1000&h=700');
  await page.waitForTimeout(900);
  out.text = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine, cv = document.querySelector('#view');
    const ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const alphaIn = (l, x, y, w, h) => { const d = e.layerPixels(l, { x, y, w, h }); let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++; return n; };
    g.state.color = [0.1, 0.2, 0.6];
    const n0 = e.layers.length;
    document.querySelector('#bText').click();
    const p = e.docToScreen(100, 200);
    ev('pointerdown', { pointerId: 4, pointerType: 'mouse', clientX: p.x, clientY: p.y, buttons: 1 }); ev('pointerup', { pointerId: 4, pointerType: 'mouse', clientX: p.x, clientY: p.y });
    const ta = document.querySelector('#textbar textarea');
    ta.value = 'Hello Gesso\nsecond line'; ta.dispatchEvent(new Event('input'));
    await raf();
    const L = g.text.layer;
    const inBox = alphaIn(L, 90, 190, 500, 200), outBox = alphaIn(L, 700, 500, 200, 150);
    // bundled font: Bebas
    [...document.querySelectorAll('#textbar .chip')].find((b) => b.textContent === 'Bebas Neue').click();
    await window.document.fonts.ready; await new Promise((r) => setTimeout(r, 300)); g.text.preview(); await raf();
    const bebasLoaded = document.fonts.check('40px "Gesso Bebas"');
    // drag to move by +200, +150
    const a = e.docToScreen(150, 230), b = e.docToScreen(350, 380);
    ev('pointerdown', { pointerId: 4, pointerType: 'mouse', clientX: a.x, clientY: a.y, buttons: 1 }); ev('pointermove', { pointerId: 4, pointerType: 'mouse', clientX: b.x, clientY: b.y, buttons: 1 }); ev('pointerup', { pointerId: 4, pointerType: 'mouse', clientX: b.x, clientY: b.y });
    await raf();
    const moved = { oldPlace: alphaIn(L, 90, 190, 150, 60), newPlace: alphaIn(L, 290, 340, 400, 200) };
    [...document.querySelectorAll('#textbar .btn')].find((x) => x.textContent === 'Done').click();
    await raf();
    const committed = { layers: e.layers.length - n0, name: L.name, editable: !!L.text && L.textVersion === L.version, label: e.history.canUndo };
    // edit later: change the text, done, then undo restores the old pixels
    g.text.edit(L); const ta2 = document.querySelector('#textbar textarea'); ta2.value = 'Bye'; ta2.dispatchEvent(new Event('input')); await raf();
    [...document.querySelectorAll('#textbar .btn')].find((x) => x.textContent === 'Done').click(); await raf();
    const afterEdit = alphaIn(L, 290, 340, 600, 300);
    g.undo(); await raf(); const afterUndo = alphaIn(L, 290, 340, 600, 300);
    g.undo(); await raf(); const layersAfter2 = e.layers.length - n0;
    g.redo(); await raf();
    g.text.disarm();
    return { inBox, outBox, bebasLoaded, moved, committed, afterEdit, afterUndo, layersAfter2 };
  });
  await T.shot('text-01');
  out.ref = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    g.ref.show(); await new Promise((r) => setTimeout(r, 700));
    const cv = document.querySelector('.ref-cv'); const c = cv.getContext('2d');
    const r = cv.getBoundingClientRect(), d = cv.width / r.width;
    let ink = 0; const data = c.getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
    // image mode with a generated image, then pick a colour from it
    const oc = new OffscreenCanvas(200, 100), x = oc.getContext('2d'); x.fillStyle = '#20c060'; x.fillRect(0, 0, 200, 100);
    await g.ref.setImage(await oc.convertToBlob());
    [...document.querySelectorAll('.ref-head .chip')].find((b) => b.textContent === 'Pick colour').click();
    const ev = (t) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, buttons: t === 'pointerdown' ? 1 : 0 }));
    ev('pointerdown'); ev('pointerup');
    return { open: g.ref.open, canvasPixels: ink, picked: g.state.color.map((v) => Math.round(v * 255)) };
  });
  await page.waitForTimeout(200);
  await T.shot('text-02-reference');
  // persistence of the editable text through autosave
  out.persist = await page.evaluate(async () => { const g = window.gesso; g.ref.close(); await g.autosave.flush(); return g.engine.layers.map((l) => !!l.text); });
  await page.goto(T.url); await page.waitForTimeout(1500);
  out.reload = await page.evaluate(() => window.gesso.engine.layers.map((l) => !!l.text && l.textVersion === l.version));
  console.log(JSON.stringify(out));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const t = out.text;
  const ok = t.inBox > 500 && t.outBox === 0 && t.moved.newPlace > 300 && t.committed.layers === 1 && t.committed.editable && t.afterEdit !== t.afterUndo && t.layersAfter2 === 0
    && out.ref.canvasPixels > 1000 && out.ref.picked[1] > 180 && out.reload.includes(true);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

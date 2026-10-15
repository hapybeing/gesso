// Productivity (M5.6): brush favourites / recent / duplicate / reset (+ persistence), left-handed layout, gestures
// (4-finger tap → quick menu, remapped 2-finger tap, touch & hold → quick menu with a flick), quick menu button,
// full screen, saved selections (save/load exact, reload, .gesso), grow/shrink by exact pixels.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ dsf: 1 }); const { page } = T;
  await page.goto(T.url + '?w=800&h=600&fresh=1'); await page.waitForTimeout(900);
  await page.evaluate(() => {
    const cv = document.querySelector('#view');
    window.__ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__taps = async (n, cx, cy) => { const r = cv.getBoundingClientRect(); for (let i = 0; i < n; i++) __ev('pointerdown', { pointerId: 60 + i, pointerType: 'touch', clientX: r.left + cx + i * 30, clientY: r.top + cy, isPrimary: i === 0 }); await __sleep(60); for (let i = 0; i < n; i++) __ev('pointerup', { pointerId: 60 + i, pointerType: 'touch', clientX: r.left + cx + i * 30, clientY: r.top + cy }); await __raf(); };
    window.__line = () => { const g = window.gesso, e = g.engine; const a = e.docToScreen(100, 100), b = e.docToScreen(500, 300); __ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: a.x, clientY: a.y, pressure: 0.6, buttons: 1 }); for (let i = 1; i <= 10; i++) __ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: a.x + (b.x - a.x) * i / 10, clientY: a.y + (b.y - a.y) * i / 10, pressure: 0.6, buttons: 1 }); __ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: b.x, clientY: b.y, pressure: 0 }); };
  });
  const r = {};
  // ---- brushes
  await page.evaluate(async () => { __line(); await __raf(); });
  r.recent = await page.evaluate(() => window.gesso.state.recentBrushes.slice());
  await page.click('#tBrush'); await page.waitForTimeout(200);   // active tool → library
  r.groups = await page.locator('.gbtn').allTextContents();
  await page.locator('.brow.on .bmore').click(); await page.getByText('☆ Favourite').click(); await page.waitForTimeout(100);
  r.favs = await page.evaluate(() => window.gesso.state.favBrushes.slice());
  r.groups2 = await page.locator('.gbtn').allTextContents();
  await page.evaluate(() => { const g = window.gesso; g.setBrushProp('size', 77); g.renderBrushes(g.pop); });
  await page.locator('.brow.on .bmore').click(); await page.locator('.bmenu').getByText('Reset').click(); await page.waitForTimeout(100);
  r.reset = await page.evaluate(() => { const g = window.gesso; return { size: g.brushFor('brush').size, ov: !!g.state.overrides[g.state.toolBrush.brush] }; });
  await page.locator('.brow.on .bmore').click(); await page.locator('.bmenu').getByText('Duplicate').click(); await page.waitForTimeout(150);
  r.dup = await page.evaluate(() => { const g = window.gesso; const b = g.brushFor('brush'); return { id: b.id, name: b.name, group: b.group }; });
  await T.shot('prod-01-brushes');
  await page.evaluate(() => window.gesso.closePop());
  // ---- left-handed
  r.lefty = await page.evaluate(async () => { const g = window.gesso; g.setHanded('left'); await __raf();
    const x = (s) => document.querySelector(s).getBoundingClientRect().left; const out = { body: document.body.classList.contains('lefty'), colourLeftOfGallery: x('#bColor') < x('#bGallery'), railRight: x('#rail') > innerWidth / 2 }; return out; });
  await T.shot('prod-02-lefthanded');
  await page.evaluate(() => window.gesso.setHanded('right'));
  // ---- gestures: 4-finger tap → quick menu; tap the Erase slot
  await page.evaluate(() => __taps(4, 400, 300));
  r.qmOpen = await page.locator('.qm-wrap').count();
  await T.shot('prod-03-quickmenu');
  await page.locator('.qm-slot[aria-label="Erase"]').click();
  r.afterSlot = await page.evaluate(() => ({ tool: window.gesso.tool, open: !!document.querySelector('.qm-wrap') }));
  // remap two-finger tap to "Fit canvas": no undo happens
  r.remap = await page.evaluate(async () => { const g = window.gesso, e = g.engine; const log = []; const o = g.onGesture.bind(g); g.onGesture = (...a) => { log.push(a[0] + ':' + g.gestureMap()[a[0]]); return o(...a); }; g.state.settings.gestures = { ...g.gestureMap(), tap2: 'fit' }; e.view.scale *= 0.5; const n0 = e.history['idx']; await __taps(2, 300, 300); const fitScale = e.view.scale; g.fit(); const res = { undone: e.history['idx'] !== n0, scaleRestored: Math.abs(fitScale - e.view.scale) < 1e-6, log, fitScale, s: e.view.scale }; delete g.onGesture; return res; });
  // touch & hold → quick menu at the finger, slide onto the right-hand slot (index 2 = Eyedropper) and lift
  r.flick = await page.evaluate(async () => { const g = window.gesso; g.pickTool('brush', true); g.state.settings.gestures = { ...g.gestureMap(), hold1: 'quickmenu' };
    const cv = document.querySelector('#view'), rc = cv.getBoundingClientRect(); const x = rc.left + 400, y = rc.top + 300;
    __ev('pointerdown', { pointerId: 70, pointerType: 'touch', clientX: x, clientY: y }); await __sleep(600);
    const open = !!document.querySelector('.qm-wrap');
    const ring = document.querySelector('.qm-ring').getBoundingClientRect();
    for (let i = 1; i <= 6; i++) window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 70, pointerType: 'touch', clientX: ring.left + i * 18, clientY: ring.top }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 70, pointerType: 'touch', clientX: ring.left + 108, clientY: ring.top }));
    __ev('pointerup', { pointerId: 70, pointerType: 'touch', clientX: x, clientY: y });
    await __raf(); return { open, armed: g.eyedropOnce, closed: !document.querySelector('.qm-wrap'), strokes: g.engine.history['idx'] }; });
  await page.evaluate(() => { const g = window.gesso; g.eyedropOnce = false; g.state.settings.gestures = {}; });
  // quick menu button + full screen
  await page.click('#bQuick'); await page.locator('.qm-slot[aria-label="Full screen"]').click(); await page.waitForTimeout(100);
  r.full = await page.evaluate(() => ({ noui: document.body.classList.contains('noui'), top: getComputedStyle(document.querySelector('#top')).display }));
  await page.click('#bUnhide'); r.unhidden = await page.evaluate(() => !document.body.classList.contains('noui'));
  // ---- saved selections + grow by exact pixels
  await page.click('#bSelect'); await page.waitForTimeout(150);
  r.sel = await page.evaluate(async () => { const g = window.gesso, e = g.engine; const m = new Uint8Array(e.w * e.h); for (let y = 200; y < 300; y++) for (let x = 100; x < 300; x++) m[y * e.w + x] = 255; e.loadSelection(m, 'test'); g.renderSelBar(); await __raf(); return m.reduce((s, v) => s + (v > 127), 0); });
  await page.locator('#selbar').getByText(/^Saved/).click(); await page.locator('#selbar').getByText('+ Save selection').click(); await page.waitForFunction(() => window.gesso.savedSels.length > 0);
  r.savedN = await page.evaluate(() => window.gesso.savedSels.length);
  await T.shot('prod-04-saved-selection');
  await page.evaluate(() => window.gesso.engine.deselect());
  await page.locator('.selitem .chip').first().click(); await page.waitForTimeout(300);
  r.loaded = await page.evaluate(async () => { const m = await window.gesso.engine.readSelection(); return m ? m.reduce((s, v) => s + (v > 127), 0) : 0; });
  // grow by exactly 3 px with the stepper
  await page.locator('#selbar').getByText('Refine edge').click(); await page.waitForTimeout(100);
  for (let i = 0; i < 3; i++) await page.locator('#selbar .edge-row').first().locator('button[aria-label="Plus one pixel"]').click();
  await page.waitForTimeout(200); await page.locator('#selbar').getByText('Apply').click(); await page.waitForTimeout(300);
  r.grown = await page.evaluate(async () => { const m = await window.gesso.engine.readSelection(); return m.reduce((s, v) => s + (v > 127), 0); });
  // persistence
  await page.evaluate(() => window.gesso.autosave.flush());
  await page.goto(T.url); await page.waitForTimeout(1500);
  r.reload = await page.evaluate(async () => { const g = window.gesso; const b = window.gessoTest.brushes.BRUSHES.find((x) => x.group === 'My brushes'); return { saved: g.savedSels.length, favs: g.state.favBrushes.length, myBrush: b ? b.name : null }; });
  r.gesso = await page.evaluate(async () => { const g = window.gesso; const blob = await g.buildGesso(); await g.importGessoBlob(blob, 'rt'); await new Promise((r) => setTimeout(r, 300)); if (!g.savedSels.length) return 0; await g.loadSaved(g.savedSels[0]); const m = await g.engine.readSelection(); return m ? m.reduce((s, v) => s + (v > 127), 0) : 0; });
  console.log(JSON.stringify(r));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const checks = {
    recent: r.recent.length === 1 && r.groups[0] === 'Recent',
    fav: r.favs.length === 1 && r.groups2[0] === '★ Favourites',
    reset: r.reset.size !== 77 && !r.reset.ov,
    dup: r.dup.group === 'My brushes' && / copy$/.test(r.dup.name) && r.dup.id.startsWith('my-'),
    lefty: r.lefty.body && r.lefty.colourLeftOfGallery && r.lefty.railRight,
    quick: r.qmOpen === 1 && r.afterSlot.tool === 'eraser' && !r.afterSlot.open,
    remap: !r.remap.undone && r.remap.scaleRestored,
    flick: r.flick.open && r.flick.armed && r.flick.closed,
    full: r.full.noui && r.full.top === 'none' && r.unhidden,
    saved: r.sel === 20000 && r.savedN === 1 && r.loaded === 20000,
    grow: Math.abs(r.grown - 206 * 106) < 120,
    persist: r.reload.saved === 1 && r.reload.favs === 1 && / copy$/.test(r.reload.myBrush || '') && r.gesso === 20000,
  };
  console.log(JSON.stringify(checks));
  process.exit(Object.values(checks).every(Boolean) && !T.errs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

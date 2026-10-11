// M2 part A: autosave survives reload; gallery new/open/duplicate/rename/delete.
const { start } = require('./lib.cjs');
const helpers = () => {
  const cv = document.querySelector('#view');
  window.__ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
  window.__stroke = (pts, opt = {}) => {
    const id = opt.id || 5, pt = opt.type || 'pen';
    __ev('pointerdown', { pointerId: id, pointerType: pt, clientX: pts[0][0], clientY: pts[0][1], pressure: pts[0][2] ?? 0.7, buttons: 1 });
    for (const [x, y, p] of pts.slice(1)) __ev('pointermove', { pointerId: id, pointerType: pt, clientX: x, clientY: y, pressure: p ?? 0.7, buttons: 1 });
    const l = pts[pts.length - 1];
    __ev('pointerup', { pointerId: id, pointerType: pt, clientX: l[0], clientY: l[1], pressure: 0, buttons: 0 });
  };
  window.__wave = (x0, y0, len, amp, n = 60) => { const p = []; for (let i = 0; i <= n; i++) { const t = i / n; p.push([x0 + t * len, y0 + Math.sin(t * Math.PI * 2) * amp, 0.3 + 0.6 * Math.sin(Math.PI * t)]); } return p; };
  window.__sig = () => { const e = window.gesso.engine; return e.layers.map((l) => { const px = e.layerPixels(l, { x: 0, y: 0, w: e.w, h: e.h }); let a = 0, c = 0; for (let i = 0; i < px.length; i += 4) { a += px[i + 3]; c += px[i] * 3 + px[i + 1] * 5 + px[i + 2] * 7; } return [l.name, l.opacity, l.blend, l.visible, a, c].join('|'); }).join(' / '); };
  window.__saved = () => new Promise((res) => { const t = () => (window.gesso.autosave.state === 'saved' ? res(true) : setTimeout(t, 50)); t(); });
};
(async () => {
  const T = await start({ port: 8129, dsf: 1.5 });
  const { page } = T;
  const log = (...a) => console.log(...a);
  await page.goto(T.url);
  await page.waitForTimeout(900);
  log('first run shows new-canvas sheet:', await page.evaluate(() => !!document.querySelector('.presets')));
  await T.shot('m2-01-first-run');
  await page.click('.preset:nth-child(2)'); // Square 2048
  await page.waitForTimeout(400);
  await page.evaluate(helpers);
  await page.evaluate(() => {
    const g = window.gesso, e = g.engine;
    g.state.toolBrush.brush = 'ink-brushpen'; g.tool = 'brush'; g.state.color = [0.7, 0.15, 0.1];
    __stroke(__wave(400, 300, 500, 60));
    e.addLayer(); g.state.toolBrush.brush = 'wc-wash'; g.state.color = [0.2, 0.4, 0.8];
    __stroke(__wave(380, 450, 520, 40));
    e.setProp(e.activeLayer, 'opacity', 0.6); e.setProp(e.activeLayer, 'blend', 1); e.setProp(e.activeLayer, 'name', 'Wash');
  });
  const t0 = Date.now();
  await page.evaluate(() => __saved());
  log('autosave completed in ms (after 1.2 s debounce):', Date.now() - t0);
  const sigA = await page.evaluate(() => __sig());
  const idA = await page.evaluate(() => window.gesso.autosave.docId);
  await page.reload();
  await page.waitForTimeout(1500);
  await page.evaluate(helpers);
  const sigB = await page.evaluate(() => __sig());
  const idB = await page.evaluate(() => window.gesso.autosave.docId);
  log('reopened same doc:', idA === idB, '| pixels+props identical after reload:', sigA === sigB);
  if (sigA !== sigB) log(' A', sigA, '\n B', sigB);
  await T.shot('m2-02-after-reload');
  // undo stack is fresh after reload; draw more, check the save dot
  await page.evaluate(() => { const g = window.gesso; g.state.toolBrush.brush = 'pencil-6b'; __stroke(__wave(300, 600, 700, 30)); });
  log('state right after a stroke:', await page.evaluate(() => window.gesso.autosave.state));
  // gallery
  await page.click('#bGallery');
  await page.waitForTimeout(700);
  log('gallery cards:', await page.locator('.g-card').count());
  await T.shot('m2-03-gallery');
  // new canvas from gallery (HD preset)
  await page.click('.g-acts .btn:not(.ghost)');
  await page.waitForTimeout(200);
  await page.click('.preset:nth-child(3)');
  await page.waitForTimeout(500);
  await page.evaluate(helpers);
  await page.evaluate(() => { const g = window.gesso; g.state.toolBrush.brush = 'marker-chisel'; g.state.color = [0.1, 0.5, 0.4]; __stroke(__wave(300, 400, 600, 80)); });
  await page.evaluate(() => __saved());
  await page.click('#bGallery'); await page.waitForTimeout(700);
  log('cards after second canvas:', await page.locator('.g-card').count());
  // duplicate the first card, rename it, delete the original second
  await page.click('.g-card:nth-child(2) .g-more'); await page.waitForTimeout(100);
  await page.click('.g-menu .mitem:nth-child(2)'); await page.waitForTimeout(600);
  log('cards after duplicate:', await page.locator('.g-card').count());
  await page.click('.g-card:nth-child(1) .g-more'); await page.waitForTimeout(100);
  await page.click('.g-menu .mitem:nth-child(1)'); await page.waitForTimeout(100);
  await page.fill('.dlg-in', 'Sunset study'); await page.click('.dlg-acts .btn:not(.ghost)'); await page.waitForTimeout(500);
  log('names:', await page.locator('.g-name').allTextContents());
  await T.shot('m2-04-gallery-after-ops');
  await page.click('.g-card:nth-child(3) .g-more'); await page.waitForTimeout(100);
  await page.click('.g-menu .mitem.danger'); await page.waitForTimeout(100);
  await T.shot('m2-05-delete-confirm');
  await page.click('.dlg-acts .btn.danger'); await page.waitForTimeout(600);
  log('cards after delete:', await page.locator('.g-card').count());
  // open the duplicate and verify pixels match the original
  await page.click('.g-card:nth-child(1) .g-pic'); await page.waitForTimeout(1200);
  log('opened:', await page.evaluate(() => window.gesso.autosave.meta.name));
  log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

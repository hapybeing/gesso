const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.map': 'application/json' };
const srv = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(root, p); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); }).listen(8123);
const shot = (page, n) => page.screenshot({ path: path.join(__dirname, '..', 'shots', n + '.png') });
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto('http://localhost:8123/?w=1600&h=1100');
  await page.waitForTimeout(800);
  // helpers in page
  await page.evaluate(() => {
    const cv = document.querySelector('#view');
    window.__ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    window.__stroke = (pts, opt = {}) => {
      const id = opt.id || 5, pt = opt.type || 'pen';
      const [x0, y0, p0] = pts[0];
      __ev('pointerdown', { pointerId: id, pointerType: pt, clientX: x0, clientY: y0, pressure: p0, tiltX: opt.tx || 0, tiltY: opt.ty || 0, buttons: 1, button: 0 });
      for (const [x, y, p] of pts.slice(1)) __ev('pointermove', { pointerId: id, pointerType: pt, clientX: x, clientY: y, pressure: p, tiltX: opt.tx || 0, tiltY: opt.ty || 0, buttons: 1 });
      const [x1, y1] = pts[pts.length - 1];
      __ev('pointerup', { pointerId: id, pointerType: pt, clientX: x1, clientY: y1, pressure: 0, buttons: 0 });
    };
    window.__wave = (x0, y0, len, amp, n = 80, pf = (t) => Math.sin(Math.PI * t)) => {
      const pts = []; for (let i = 0; i <= n; i++) { const t = i / n; pts.push([x0 + t * len, y0 + Math.sin(t * Math.PI * 2) * amp, Math.max(0.05, pf(t))]); } return pts;
    };
    window.__use = (tool, id, color) => { const g = window.gesso; g.state.toolBrush[tool] = id; g.tool = tool; if (color) g.state.color = color; };
  });
  const brushes = [['ink-studio', [0.1, 0.1, 0.12]], ['ink-brushpen', [0.6, 0.12, 0.1]], ['pencil-hb', [0.15, 0.15, 0.15]], ['pencil-6b', [0.2, 0.2, 0.25]],
    ['charcoal', [0.1, 0.08, 0.08]], ['air-soft', [0.9, 0.5, 0.2]], ['air-spatter', [0.2, 0.4, 0.7]], ['wc-wash', [0.2, 0.45, 0.75]], ['wc-round', [0.75, 0.25, 0.4]],
    ['wc-bleed', [0.3, 0.6, 0.35]], ['marker-chisel', [0.95, 0.75, 0.2]], ['marker-felt', [0.1, 0.5, 0.5]], ['paint-bristle', [0.55, 0.2, 0.45]], ['paint-gouache', [0.85, 0.35, 0.2]]];
  const t0 = Date.now();
  for (let i = 0; i < brushes.length; i++) {
    const [id, col] = brushes[i];
    const col2 = i % 2, row = Math.floor(i / 2);
    await page.evaluate(([id, col, x, y]) => { __use('brush', id, col); __stroke(__wave(x, y, 380, 14, 90)); }, [id, col, 200 + col2 * 470, 110 + row * 88]);
  }
  await page.waitForTimeout(300);
  console.log('14 strokes ms', Date.now() - t0);
  await shot(page, '01-brushes');
  // tilt pencil shading
  await page.evaluate(() => { __use('brush', 'pencil-6b', [0.2, 0.2, 0.2]); for (let k = 0; k < 6; k++) __stroke(__wave(1100, 150 + k * 10, 120, 3, 30, () => 0.6), { tx: 55, ty: 10 }); });
  // smudge across the watercolour + airbrush
  await page.evaluate(() => { __use('smudge', 'smudge-soft'); __stroke(__wave(260, 400, 300, 40, 80, () => 0.9)); });
  // eraser
  await page.evaluate(() => { __use('eraser', 'ink-gel'); window.gesso.state.overrides['ink-gel'] = { size: 20 }; __stroke([[150, 300, 1], [1100, 320, 1]]); });
  await page.waitForTimeout(200);
  await shot(page, '02-tilt-smudge-erase');
  // undo by two-finger tap
  const before = await page.evaluate(() => window.gesso.engine.history.canRedo);
  await page.evaluate(() => {
    __ev('pointerdown', { pointerId: 21, pointerType: 'touch', clientX: 600, clientY: 600, pressure: 1, width: 20, height: 20, buttons: 1 });
    __ev('pointerdown', { pointerId: 22, pointerType: 'touch', clientX: 700, clientY: 600, pressure: 1, width: 20, height: 20, buttons: 1 });
    __ev('pointerup', { pointerId: 21, pointerType: 'touch', clientX: 600, clientY: 600 });
    __ev('pointerup', { pointerId: 22, pointerType: 'touch', clientX: 700, clientY: 600 });
  });
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => window.gesso.engine.history.canRedo);
  console.log('two-finger undo -> canRedo', before, after);
  await shot(page, '03-after-undo');
  // three-finger redo
  await page.evaluate(() => {
    for (const [i, x] of [[31, 500], [32, 600], [33, 700]]) __ev('pointerdown', { pointerId: i, pointerType: 'touch', clientX: x, clientY: 600, pressure: 1, width: 20, height: 20, buttons: 1 });
    for (const [i, x] of [[31, 500], [32, 600], [33, 700]]) __ev('pointerup', { pointerId: i, pointerType: 'touch', clientX: x, clientY: 600 });
  });
  console.log('three-finger redo -> canRedo', await page.evaluate(() => window.gesso.engine.history.canRedo));
  // layers: new layer multiply, clipping mask, alpha lock
  await page.evaluate(() => {
    const e = window.gesso.engine;
    e.addLayer(); __use('brush', 'wc-wash', [0.95, 0.6, 0.1]); __stroke(__wave(300, 640, 700, 30, 80, () => 0.9));
    e.setProp(e.activeLayer, 'blend', 1);
    e.addLayer(); e.setProp(e.activeLayer, 'clip', true); __use('brush', 'air-soft', [0.8, 0.1, 0.5]); __stroke([[300, 650, 1], [1000, 650, 1]]);
    e.addLayer(); __use('brush', 'marker-chisel', [0.1, 0.1, 0.1]); __stroke(__wave(250, 740, 600, 10));
    e.setProp(e.activeLayer, 'alphaLock', true); __use('brush', 'air-soft', [0.9, 0.2, 0.2]); __stroke([[200, 740, 1], [900, 740, 1]]);
  });
  await page.waitForTimeout(200);
  await shot(page, '04-layers');
  // pinch zoom-rotate
  await page.evaluate(() => {
    __ev('pointerdown', { pointerId: 41, pointerType: 'touch', clientX: 500, clientY: 400, width: 20, height: 20, buttons: 1 });
    __ev('pointerdown', { pointerId: 42, pointerType: 'touch', clientX: 700, clientY: 400, width: 20, height: 20, buttons: 1 });
    for (let k = 1; k <= 10; k++) {
      const a = k * 0.03, s = 1 + k * 0.08;
      __ev('pointermove', { pointerId: 41, pointerType: 'touch', clientX: 600 - 100 * s * Math.cos(a), clientY: 400 - 100 * s * Math.sin(a), buttons: 1 });
      __ev('pointermove', { pointerId: 42, pointerType: 'touch', clientX: 600 + 100 * s * Math.cos(a), clientY: 400 + 100 * s * Math.sin(a), buttons: 1 });
    }
    __ev('pointerup', { pointerId: 41, pointerType: 'touch' }); __ev('pointerup', { pointerId: 42, pointerType: 'touch' });
  });
  await page.waitForTimeout(150);
  console.log('view after pinch', JSON.stringify(await page.evaluate(() => window.gesso.engine.view)));
  await shot(page, '05-pinch');
  // palm rejection: pen seen -> finger should not draw
  const hist0 = await page.evaluate(() => window.gesso.engine.history['list'].length);
  await page.evaluate(() => __stroke([[300, 300, 1], [500, 320, 1]], { id: 51, type: 'touch' }));
  const hist1 = await page.evaluate(() => window.gesso.engine.history['list'].length);
  console.log('finger stroke after pen (should not draw):', hist0 === hist1);
  // panels
  await page.evaluate(() => window.gesso.fit());
  await page.click('#bLayers'); await page.waitForTimeout(400); await shot(page, '06-layers-panel');
  await page.click('#bColor'); await page.waitForTimeout(200); await shot(page, '07-colour');
  await page.click('#tBrush'); await page.waitForTimeout(200); await shot(page, '08-brushes-panel');
  await page.evaluate(() => window.gesso.closePop());
  await page.evaluate(() => window.gesso.openStudio()); await page.waitForTimeout(200); await shot(page, '09-studio');
  await page.evaluate(() => document.querySelector('.sheet-wrap')?.remove());
  // eyedropper
  const picked = await page.evaluate(() => { const g = window.gesso; const p = g.engine.docToScreen(800, 640); const r = g.canvas.getBoundingClientRect(); g.eyedrop(800, 640, true, p.x, p.y); return g.state.color; });
  console.log('eyedrop', picked.map((v) => v.toFixed(2)).join(','));
  // export
  const ex = await page.evaluate(async () => { const b = await window.gesso.engine.exportPNG(); const bmp = await createImageBitmap(b); return [b.size, bmp.width, bmp.height]; });
  console.log('export png bytes,w,h', ex);
  // perf: long stroke timing
  const perf = await page.evaluate(() => { __use('brush', 'wc-wash', [0.2, 0.3, 0.6]); const t = performance.now(); __stroke(__wave(100, 400, 1000, 200, 600)); window.gesso.engine.render(); window.gesso.engine.gl.finish(); return performance.now() - t; });
  console.log('600-sample wet stroke ms (swiftshader CPU):', perf.toFixed(1));
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });

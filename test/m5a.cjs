// M5 / R4 open items: tile-based Clear/Fill undo, clipping onto a group, nested ORA import, curves histogram,
// long-press drag to reorder layers and frames (with auto-scroll).
const { start } = require('./lib.cjs');
const fs = require('fs'), path = require('path');
(async () => {
  const T = await start({ dsf: 1 });
  const { page } = T;
  const out = {};
  await page.goto(T.url + '?w=2048&h=2048&fresh=1');
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const cv = document.querySelector('#view');
    window.__ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    window.__S = (x, y) => window.gesso.engine.docToScreen(x, y);
    // a ring of radius r (sample ON the ring, not at its centre)
    window.__dot = (x, y, r = 14) => { const pts = []; for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI * 2; pts.push(__S(x + Math.cos(a) * r, y + Math.sin(a) * r)); }
      __ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: pts[0].x, clientY: pts[0].y, pressure: 1, buttons: 1 });
      for (const p of pts.slice(1)) __ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: p.x, clientY: p.y, pressure: 1, buttons: 1 });
      __ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: pts.at(-1).x, clientY: pts.at(-1).y, pressure: 0 }); };
    window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__hash = (l) => { const e = window.gesso.engine; const d = e.layerPixels(l, { x: 0, y: 0, w: e.w, h: e.h }); let h = 0, n = 0; for (let i = 0; i < d.length; i += 4) { h = (h * 31 + d[i] + d[i + 3] * 7) | 0; if (d[i + 3]) n++; } return h + ':' + n; };
  });

  // 1. Clear / Fill undo holds only the painted tiles
  out.tiles = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    g.state.toolBrush.brush = 'marker-felt'; g.state.overrides['marker-felt'] = { size: 40, smoothing: 0 }; g.tool = 'brush'; g.state.color = [0.8, 0.1, 0.1];
    __dot(300, 300, 30); __dot(1500, 1500, 30); await __raf();
    const L = e.activeLayer, h0 = __hash(L);
    const last = () => e.history['list'][e.history['list'].length - 1];
    e.clearLayer(); const ent = last();
    const cleared = __hash(L);
    g.undo(); const back = __hash(L);
    g.redo(); const again = __hash(L);
    g.undo(); const back2 = __hash(L);
    const c = new OffscreenCanvas(e.w, e.h), x = c.getContext('2d'); x.fillStyle = '#f00'; x.fillRect(200, 200, 300, 300); e.selectFromCanvas(c, 0, 'Select');
    e.fillLayer([0, 0, 1]); const filled = __hash(L); const fe = last();
    g.undo(); const back3 = __hash(L);
    e.setSelection(null, 'Deselect');
    e.fillLayer([0, 1, 0]); const fe2 = last(); g.undo(); const back4 = __hash(L);
    return { full: e.w * e.h * 4, clearBytes: ent.bytes, fillSelBytes: fe.bytes, fillBytes: fe2.bytes, h0, cleared, back, again, back2, filled: filled !== h0, back3, back4 };
  });

  // 2. clipping onto a group: masked by the group's combined alpha
  out.clip = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    while (e.layers.length > 1) { e.active = e.layers.length - 1; e.deleteLayer(); }
    e.clearLayer();
    e.addLayer(); g.state.color = [1, 0, 0]; __dot(600, 600, 60); await __raf();
    const A = e.activeLayer; const G = e.groupActive();
    e.addLayer(); const C = e.activeLayer;
    if (C.parent) e.moveBlock(C, 1);
    e.fillLayer([0, 0, 1]); e.setProp(C, 'clip', true);
    await __raf();
    const px = (x, y) => { e.render(); return e.sample(x, y).map((v) => Math.round(v * 255)); };
    const inside = px(660, 600), outside = px(900, 900);
    e.setProp(G, 'visible', false); await __raf(); const hidden = px(660, 600); e.setProp(G, 'visible', true);
    return { grouped: A.parent === G && !C.parent, inside, outside, hidden };
  });

  // 3. nested OpenRaster stacks import as groups
  const b64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'nested.ora')).toString('base64');
  out.ora = await page.evaluate(async (b64) => {
    const g = window.gesso, e = g.engine;
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await g.importGessoBlob(new Blob([bin]), 'nested');
    await __raf();
    const L = e.layers.map((l) => ({ n: l.name, g: l.group, p: l.parent ? l.parent.name : null, v: l.visible, o: l.opacity, b: l.blend }));
    const mid = e.layers.find((l) => l.name === 'Mid'), deep = e.layers.find((l) => l.name === 'Deep');
    const at = (l, x, y) => Array.from(e.layerPixels(l, { x, y, w: 1, h: 1 }));
    return { w: e.w, h: e.h, L, midAt: at(mid, 12, 7), midBefore: at(mid, 8, 7), deepAt: at(deep, 31, 26), deepBefore: at(deep, 29, 24) };
  }, b64);

  // 4. curves histogram (input + output) from the layer's own pixels
  await page.goto(T.url + '?w=800&h=600&fresh=1'); await page.waitForTimeout(800);
  await page.evaluate(() => { window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
  out.hist = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    const c = new OffscreenCanvas(e.w, e.h), x = c.getContext('2d'); x.fillStyle = 'rgb(64,64,64)'; x.fillRect(0, 0, 400, 600); x.fillStyle = 'rgb(200,200,200)'; x.fillRect(400, 0, 400, 300);
    e.drawCanvasToLayer(e.activeLayer, c, 0, 0);
    g.adj.open('curves');
    for (let i = 0; i < 60 && !g.adj.hist; i++) await __raf();
    const H = g.adj.hist; const peak = (a) => { let m = 0; for (let i = 1; i < 256; i++) if (a[i] > a[m]) m = i; return m; };
    const tot = H ? H[0].reduce((s, v) => s + v, 0) : 0;
    return H ? { lumaPeak: peak(H[0]), redPeak: peak(H[1]), share64: +(H[0][64] / tot).toFixed(3), share200: +(H[0][200] / tot).toFixed(3) } : null;
  });
  await T.shot('m5a-01-curves-histogram');
  await page.evaluate(() => window.gesso.adj.close(false));

  // 5. long-press drag to reorder layers (auto-scroll in a long list) and frames
  out.drag = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    for (let i = 0; i < 11; i++) e.addLayer();
    e.layers.forEach((l, i) => { l.name = 'L' + i; });
    e.active = 0;
    document.querySelector('#bLayers').click(); await __raf();
    const list = document.querySelector('.llist');
    return { rows: list.querySelectorAll('.lrow:not(.bg)').length, scrollable: list.scrollHeight > list.clientHeight };
  });
  const rowBox = async (name) => page.evaluate((n) => { const r = [...document.querySelectorAll('.llist .lrow')].find((x) => x.querySelector('.lname')?.textContent === n).getBoundingClientRect(); return { x: r.left + r.width / 2 - 40, y: r.top + r.height / 2 }; }, name);
  {
    // drag the top row (L11) down past the visible end: auto-scroll brings the bottom rows into reach
    const a = await rowBox('L11');
    const lb = await page.evaluate(() => { const r = document.querySelector('.llist').getBoundingClientRect(); return { bottom: r.bottom, top: r.top }; });
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.waitForTimeout(500);
    await page.mouse.move(a.x, a.y + 30, { steps: 3 });
    await page.mouse.move(a.x, lb.bottom - 6, { steps: 6 });
    await page.waitForFunction(() => { const l = document.querySelector('.llist'); return l.scrollTop >= l.scrollHeight - l.clientHeight - 1; }, null, { timeout: 30000 });
    await T.shot('m5a-02-layer-drag');
    const tgt = await rowBox('L1');                                          // drop in L1's upper half → just above L1
    await page.mouse.move(a.x, tgt.y - 14, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  out.drag2 = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    const order = e.layers.map((l) => l.name).join(',');
    const steps = e.history['list'].length; const lab = e.history['list'][steps - 1].label;
    g.undo(); const undone = e.layers.map((l) => l.name).join(',');
    g.redo();
    return { order, lab, undone, stats: window.gessoTest.DRAG_STATS };
  });
  {
    // a quick tap still selects (no lift)
    const b = await rowBox('L5'); await page.mouse.click(b.x, b.y); await page.waitForTimeout(150);
    out.tap = await page.evaluate(() => window.gesso.engine.activeLayer.name);
  }
  await page.evaluate(async () => { const g = window.gesso; g.closePop(); g.anim.toggle(true); await __raf(); });
  const cells = await page.evaluate(() => [...document.querySelectorAll('.tl-unit')].map((u) => { const r = u.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; }));
  {
    // frames: drag frame 1 past frame 4
    const a = cells[0], b = cells[3];
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.waitForTimeout(500);
    await page.mouse.move(a.x + 20, a.y, { steps: 2 }); await page.mouse.move(b.x + b.w * 0.3, b.y, { steps: 6 });
    await T.shot('m5a-03-frame-drag');
    await page.mouse.up(); await page.waitForTimeout(300);
  }
  out.frames = await page.evaluate(() => window.gesso.anim.frames().map((f) => f.base.name).slice(0, 6).join(','));
  console.log(JSON.stringify(out));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const t = out.tiles, c = out.clip, o = out.ora, hs = out.hist;
  const checks = {
    clearSmall: t.clearBytes <= 8 * 256 * 256 * 4 && t.clearBytes > 0, fillSmall: t.fillBytes <= 8 * 256 * 256 * 4,
    clearExact: t.back === t.h0 && t.back2 === t.h0 && t.cleared.endsWith(':0') && t.again === t.cleared, fillSel: t.filled && t.back3 === t.h0 && t.back4 === t.h0,
    clip: c.grouped && c.inside[2] > 200 && c.inside[0] < 60 && c.outside[1] > 200 && c.outside[0] > 200 && c.hidden[1] > 200 && c.hidden[0] > 200,
    ora: o.L.map((x) => x.n).join() === 'Bottom,Deep,Inner,Mid,Outer,Top' && o.L[2].g && o.L[1].p === 'Inner' && o.L[2].p === 'Outer' && o.L[4].g && !o.L[2].v && o.L[4].o === 0.5 && o.L[4].b === 1 && o.midAt[3] === 255 && o.midBefore[3] === 0 && o.deepAt[3] === 255 && o.deepBefore[3] === 0,
    hist: hs && hs.lumaPeak === 64 && Math.abs(hs.share64 - 0.667) < 0.03 && Math.abs(hs.share200 - 0.333) < 0.03,
    drag: out.drag.scrollable && out.drag2.order.startsWith('L0,L1,L11,L2') && out.drag2.lab === 'Move layer' && out.drag2.undone.endsWith('L10,L11'),
    tap: out.tap === 'L5',
    frames: out.frames.startsWith('L1,L11,L2,L0'),
  };
  console.log(JSON.stringify(checks));
  process.exit(Object.values(checks).every(Boolean) && !T.errs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

// .gesso export -> download -> validate as zip/ORA -> import round trip.
const { start } = require('./lib.cjs');
const fs = require('fs');
(async () => {
  const T = await start({ port: 8130, dsf: 1.5 });
  const { page } = T;
  await page.goto(T.url + '?w=1200&h=900');
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const g = window.gesso, e = g.engine, cv = document.querySelector('#view');
    const ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    const stroke = (pts) => { ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: pts[0][0], clientY: pts[0][1], pressure: 0.7, buttons: 1 }); for (const p of pts.slice(1)) ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: p[0], clientY: p[1], pressure: p[2], buttons: 1 }); ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: pts.at(-1)[0], clientY: pts.at(-1)[1] }); };
    const wave = (x0, y0) => Array.from({ length: 50 }, (_, i) => [x0 + i * 10, y0 + Math.sin(i / 8) * 40, 0.3 + 0.6 * Math.sin(Math.PI * i / 49)]);
    g.state.toolBrush.brush = 'ink-brushpen'; g.state.color = [0.8, 0.2, 0.1]; stroke(wave(300, 250));
    e.addLayer(); g.state.toolBrush.brush = 'air-soft'; g.state.color = [0.1, 0.3, 0.9]; stroke(wave(300, 400));
    e.setProp(e.activeLayer, 'blend', 2); e.setProp(e.activeLayer, 'opacity', 0.55); e.setProp(e.activeLayer, 'name', 'Glow & <haze>');
    e.addLayer(); e.setProp(e.activeLayer, 'clip', true); e.setProp(e.activeLayer, 'alphaLock', true); e.setProp(e.activeLayer, 'visible', false);
    e.setBackground([0.95, 0.92, 0.85]);
  });
  const sig = () => page.evaluate(() => { const e = window.gesso.engine; return e.layers.map((l) => { const px = e.layerPixels(l, { x: 0, y: 0, w: e.w, h: e.h }); let a = 0, c = 0; for (let i = 0; i < px.length; i += 4) { a += px[i + 3]; c += px[i] + px[i + 1] * 3 + px[i + 2] * 5; } return JSON.stringify([l.name, l.opacity, l.blend, l.visible, l.clip, l.alphaLock, a, c]); }).join('\n') + '\nbg ' + e.bg.map((v) => v.toFixed(3)) + ' ' + e.w + 'x' + e.h; });
  const before = await sig();
  const dl = page.waitForEvent('download');
  const t0 = Date.now();
  await page.evaluate(() => window.gesso.exportGessoFile());
  const d = await dl;
  const path = '/tmp/test.gesso';
  await d.saveAs(path);
  console.log('exported', d.suggestedFilename(), fs.statSync(path).size, 'bytes in', Date.now() - t0, 'ms');
  // import the same bytes back as a new artwork
  const b64 = fs.readFileSync(path).toString('base64');
  await page.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await window.gesso.importGessoBlob(new Blob([bin]), 'roundtrip'); }, b64);
  await page.waitForTimeout(400);
  const after = await sig();
  console.log('round trip bit-exact (pixels+props):', before === after, '| props identical:', before.split('\n').map((l) => l.replace(/,\d+,\d+\]$/, ']')).join() === after.split('\n').map((l) => l.replace(/,\d+,\d+\]$/, ']')).join());
  const la = before.split('\n'), lb = after.split('\n');
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) console.log('  diff', la[i], '->', lb[i]);
  await T.shot('gessofile-roundtrip');
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
})().catch((e) => { console.error(e); process.exit(1); });

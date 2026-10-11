// Wet media: a watercolour stroke dries on its own after the pen lifts (pigment diffuses, rides the water to the
// drying rim, deposits into the paper grain). Compared with the same stroke with drying off: darker rim vs
// centre, a little bleed past the dry footprint, more texture (granulation); undo during drying settles first.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ port: 8154, dsf: 1 });
  const { page } = T;
  await page.goto(T.url + '?w=900&h=700');
  await page.waitForTimeout(900);
  const out = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine, cv = document.querySelector('#view');
    const ev = (t, o) => cv.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
    const S = (x, y) => e.docToScreen(x, y);
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    g.state.toolBrush.brush = 'wc-wash'; g.state.overrides['wc-wash'] = { size: 110, smoothing: 0 }; g.state.color = [0.12, 0.3, 0.75]; g.tool = 'brush';
    const stroke = (y) => { const a = S(150, y); ev('pointerdown', { pointerId: 3, pointerType: 'pen', clientX: a.x, clientY: a.y, pressure: 0.7, buttons: 1 });
      for (let i = 1; i <= 30; i++) { const p = S(150 + i * 20, y + Math.sin(i / 5) * 10); ev('pointermove', { pointerId: 3, pointerType: 'pen', clientX: p.x, clientY: p.y, pressure: 0.7, buttons: 1 }); }
      const b = S(750, y); ev('pointerup', { pointerId: 3, pointerType: 'pen', clientX: b.x, clientY: b.y, pressure: 0 }); };
    const prof = (y) => { const d = e.layerPixels(e.activeLayer, { x: 450, y: y - 110, w: 1, h: 220 }); const a = []; for (let i = 3; i < d.length; i += 4) a.push(d[i]); return a; };
    const tex = (y) => { const d = e.layerPixels(e.activeLayer, { x: 300, y: y - 20, w: 300, h: 40 }); let s = 0, s2 = 0, n = 0; for (let i = 3; i < d.length; i += 4) { s += d[i]; s2 += d[i] * d[i]; n++; } const m = s / n; return { mean: Math.round(m), sd: +Math.sqrt(s2 / n - m * m).toFixed(1) }; };
    const stats = (a) => { const nz = a.map((v, i) => [v, i]).filter(([v]) => v > 3); if (!nz.length) return null; const lo = nz[0][1], hi = nz[nz.length - 1][1]; const mid = a[Math.round((lo + hi) / 2)];
      const rim = Math.max(...a.slice(lo, lo + Math.round((hi - lo) * 0.25)), ...a.slice(hi - Math.round((hi - lo) * 0.25), hi + 1)); return { width: hi - lo + 1, mid, rim }; };
    // dry reference
    e.wetMedia = false; stroke(200); await raf();
    const dry = { prof: stats(prof(200)), tex: tex(200) };
    // wet
    e.wetMedia = true; stroke(480);
    const dryingAfterLift = e.isDrying;
    const t0 = performance.now(); let frames = 0; while (e.isDrying && frames < 400) { await new Promise((r) => requestAnimationFrame(r)); frames++; }
    const dryMs = Math.round(performance.now() - t0);
    const wet = { prof: stats(prof(480)), tex: tex(480) };
    // undo while drying: settles then undoes the wet stroke itself
    stroke(620); const mid = e.isDrying; const n0 = e.history.canUndo; g.undo(); const settledByUndo = !e.isDrying;
    const gone = Math.max(...prof(620).slice(95, 130));
    return { dry, wet, dryingAfterLift, frames, dryMs, mid, n0, settledByUndo, goneAfterUndo: gone };
  });
  await page.waitForTimeout(200);
  await T.shot('wet-01-dry-vs-wet');
  console.log(JSON.stringify(out));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const ok = out.dryingAfterLift && out.wet.prof && out.dry.prof && out.wet.prof.rim / out.wet.prof.mid > out.dry.prof.rim / Math.max(1, out.dry.prof.mid)
    && out.wet.prof.width >= out.dry.prof.width && out.settledByUndo && out.goneAfterUndo === 0;
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

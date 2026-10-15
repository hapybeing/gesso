// Drawing guides + assist: 2D grid, isometric, 2-point perspective, ruler (edge + parallel); free starts stay
// free; handle drag; saved per artwork. Strokes are wobbly on purpose: assisted ones must come out straight.
const { start } = require('./lib.cjs');
(async () => {
  const T = await start({ dsf: 1 });
  const { page } = T;
  await page.goto(T.url + '?w=1000&h=700&fresh=1');
  await page.waitForTimeout(900);
  await page.exposeFunction('T_shot', (n) => T.shot(n));
  const out = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine, cv = document.querySelector('#view');
    let clock = 1000; window.__gessoSeed = 7;
    const ev = (t, o) => { const x = new PointerEvent(t, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 4, pointerType: 'pen', ...o }); clock += 8; Object.defineProperty(x, 'timeStamp', { value: clock }); cv.dispatchEvent(x); };
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    g.state.toolBrush.brush = 'marker-felt'; g.state.overrides['marker-felt'] = { size: 6, smoothing: 0 }; g.tool = 'brush'; g.state.color = [0, 0, 0];
    g.state.settings.snapShapes = false;
    /** stroke from a towards b (doc px) with a sideways wobble of amp px */
    const stroke = (a, b, amp = 6) => {
      const n = 40, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
      for (let i = 0; i <= n; i++) {
        const t = i / n, w = Math.sin(t * 9) * amp * Math.min(1, t * 4), p = e.docToScreen(a[0] + dx * t + nx * w, a[1] + dy * t + ny * w);
        ev(i ? 'pointermove' : 'pointerdown', { clientX: p.x, clientY: p.y, pressure: 0.8, buttons: 1 });
      }
      const p = e.docToScreen(b[0], b[1]); ev('pointerup', { clientX: p.x, clientY: p.y, pressure: 0 });
    };
    /** alpha-weighted centroid of each column x in [x0,x1] (step) → points; then the max distance from the best line through them */
    const centroids = (x0, x1, step = 10) => {
      const d = e.layerPixels(e.activeLayer, { x: 0, y: 0, w: e.w, h: e.h }); const pts = [];
      for (let x = x0; x <= x1; x += step) { let s = 0, sy = 0; for (let y = 0; y < e.h; y++) { const a = d[(y * e.w + x) * 4 + 3]; s += a; sy += a * y; } if (s > 0) pts.push([x, sy / s]); }
      return pts;
    };
    const fit = (pts) => { const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
      let sxx = 0, sxy = 0; for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); } const k = sxy / sxx;
      const dev = Math.max(...pts.map(([x, y]) => Math.abs(y - (my + k * (x - mx))) / Math.sqrt(1 + k * k)));
      return { slopeDeg: +(Math.atan(k) * 180 / Math.PI).toFixed(2), dev: +dev.toFixed(2), n, mx, my }; };
    const res = {};
    const fresh = () => { e.clearLayer(); };
    g.toggleGuideBar(); g.guides.kind = 'grid'; g.guidesChanged(); await raf();
    // 1. grid: wobbly 4° stroke → horizontal and straight
    fresh(); stroke([200, 300], [700, 335]); await raf(); res.grid = fit(centroids(260, 640));
    // 2. grid: a 45° start is outside the 35° capture → free (keeps its wobble)
    fresh(); stroke([200, 150], [550, 500]); await raf(); res.gridFree = fit(centroids(260, 500));
    // 3. isometric: a 24° stroke snaps to 30°
    g.guides.kind = 'iso'; g.guidesChanged(); fresh(); stroke([200, 200], [650, 400]); await raf(); res.iso = fit(centroids(260, 600));
    await T_shot('guides-01-iso');
    // 4. 2-point perspective: a stroke aimed roughly away from VP1 follows the exact ray through its start
    g.guides.kind = 'persp'; g.guides.points = 2; g.guides.vps[0] = { x: 100, y: 250 }; g.guidesChanged();
    fresh(); stroke([400, 330], [800, 440]); await raf();
    const pp = centroids(460, 760); res.persp = fit(pp);
    res.perspExpected = +(Math.atan((330 - 250) / (400 - 100)) * 180 / Math.PI).toFixed(2);
    await T_shot('guides-02-persp');
    // 5. ruler: start on the edge → drawn exactly along it; start far away → free
    g.guides.kind = 'ruler'; g.guides.ra = { x: 150, y: 500 }; g.guides.rb = { x: 850, y: 500 }; g.guides.parallel = false; g.guidesChanged();
    fresh(); stroke([250, 512], [700, 520]); await raf(); res.ruler = fit(centroids(300, 650));
    fresh(); stroke([250, 200], [700, 230]); await raf(); res.rulerFar = fit(centroids(300, 650));
    g.guides.parallel = true; g.guidesChanged(); fresh(); stroke([250, 200], [700, 230]); await raf(); res.rulerPar = fit(centroids(300, 650));
    await T_shot('guides-03-ruler');
    // 6. drag a vanishing point by its knob (guide bar open), then persistence through docExtra
    g.guides.kind = 'persp'; g.guidesChanged(); await raf();
    const v = e.docToScreen(g.guides.vps[1].x, g.guides.vps[1].y), to = e.docToScreen(g.guides.vps[1].x - 100, g.guides.vps[1].y + 40);
    ev('pointerdown', { clientX: v.x, clientY: v.y, pressure: 0.5, buttons: 1 }); for (let i = 1; i <= 8; i++) ev('pointermove', { clientX: v.x + (to.x - v.x) * i / 8, clientY: v.y + (to.y - v.y) * i / 8, pressure: 0.5, buttons: 1 }); ev('pointerup', { clientX: to.x, clientY: to.y, pressure: 0 });
    res.vp1 = { ...g.guides.vps[1] };
    res.inked = e.layerPixels(e.activeLayer, { x: Math.round(res.vp1.x), y: Math.round(res.vp1.y), w: 1, h: 1 })[3];
    res.extra = g.docExtra().guides.kind;
    res.button = document.querySelector('#bGuide').getBoundingClientRect().width;
    return res;
  });
  console.log(JSON.stringify(out));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const o = out;
  const checks = {
    grid: Math.abs(o.grid.slopeDeg) < 0.2 && o.grid.dev < 0.6,
    gridFree: o.gridFree.dev > 2 && o.gridFree.slopeDeg > 30,
    iso: Math.abs(o.iso.slopeDeg - 30) < 0.3 && o.iso.dev < 0.6,
    persp: Math.abs(o.persp.slopeDeg - o.perspExpected) < 0.3 && o.persp.dev < 0.6,
    ruler: Math.abs(o.ruler.slopeDeg) < 0.2 && Math.abs(o.ruler.my - 500) < 0.6,
    rulerFar: o.rulerFar.dev > 2, rulerPar: Math.abs(o.rulerPar.slopeDeg) < 0.2 && Math.abs(o.rulerPar.my - 200) < 1,
    vp: Math.abs(o.vp1.x - 780) < 3 && Math.abs(o.vp1.y - 334) < 3 && o.inked === 0, extra: o.extra === 'persp', touch: o.button >= 44,
  };
  console.log(JSON.stringify(checks));
  process.exit(Object.values(checks).every(Boolean) && !T.errs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

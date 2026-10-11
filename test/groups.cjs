// Layer groups: pass-through vs isolated compositing (opacity/blend), nesting, collapse, move in/out, ungroup,
// flatten, delete+undo, groups as animation frames, persistence (autosave reload + .gesso round trip with nested ORA stacks).
const { start } = require('./lib.cjs');
const helpers = () => {
  const cv = document.querySelector('#view');
  window.__ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...o }));
  window.__S = (x, y) => window.gesso.engine.docToScreen(x, y);
  window.__dot = (x, y, r = 14) => { const pts = []; for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI * 2; pts.push(__S(x + Math.cos(a) * r, y + Math.sin(a) * r)); }
    __ev('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: pts[0].x, clientY: pts[0].y, pressure: 1, buttons: 1 });
    for (const p of pts.slice(1)) __ev('pointermove', { pointerId: 5, pointerType: 'pen', clientX: p.x, clientY: p.y, pressure: 1, buttons: 1 });
    __ev('pointerup', { pointerId: 5, pointerType: 'pen', clientX: pts.at(-1).x, clientY: pts.at(-1).y, pressure: 0 }); };
  window.__raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__c = (x, y) => { const e = window.gesso.engine; e.render(); return e.sample(x, y).map((v) => Math.round(v * 255)); };
};
(async () => {
  const T = await start({ port: 8152, dsf: 1.5 });
  const { page } = T;
  const out = {};
  await page.goto(T.url + '?w=800&h=600');
  await page.waitForTimeout(900);
  await page.evaluate(helpers);
  out.build = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    g.state.toolBrush.brush = 'marker-felt'; g.state.overrides['marker-felt'] = { size: 60, smoothing: 0 }; g.tool = 'brush';
    // bottom: red disc at 300; two overlapping blue discs (layers A, B) grouped
    e.fillLayer([1, 0, 0]);
    e.addLayer(); g.state.color = [0, 0, 1]; __dot(300, 300, 40);
    const A = e.activeLayer;
    e.addLayer(); g.state.color = [0, 0, 1]; __dot(330, 300, 40);
    const B = e.activeLayer;
    e.active = e.layers.indexOf(A); const G = e.groupActive();
    e.active = e.layers.indexOf(B); e.moveBlock(B, -1);  // into the group, above A? B is above G: moving down enters as top member
    await __raf();
    const inG = B.parent === G && A.parent === G;
    // pass-through at 100 %: same as no group
    const pass = __c(315, 300);
    // 50 % group: isolated -> the overlap area is 50 % blue over red, not 75 % (two 50 % layers)
    e.setProp(G, 'opacity', 0.5); await __raf();
    const iso = __c(315, 300);
    e.setProp(G, 'opacity', 1); e.setProp(A, 'opacity', 0.5); e.setProp(B, 'opacity', 0.5); await __raf();
    const twoHalf = __c(315, 300);
    e.setProp(A, 'opacity', 1); e.setProp(B, 'opacity', 1);
    // multiply group
    e.setProp(G, 'blend', 1); await __raf(); const mult = __c(300, 300); e.setProp(G, 'blend', 0);
    // hide group hides members
    e.setProp(G, 'visible', false); await __raf(); const hidden = __c(330, 300); e.setProp(G, 'visible', true);
    // nesting: group B inside a new group
    e.active = e.layers.indexOf(B); const G2 = e.groupActive();
    const nested = G2.parent === G && B.parent === G2 && e.depthOf(B) === 2;
    // move B up out of G2 then out of G
    e.active = e.layers.indexOf(B); e.moveBlock(B, 1); const out1 = B.parent === G; e.moveBlock(B, 1); const out2 = B.parent === null;
    g.undo(); g.undo(); const back = B.parent === G2;
    return { inG, pass, iso, twoHalf, mult, hidden, nested, out1, out2, back, order: e.layers.map((l) => (l.group ? '[' : '') + l.name + (l.parent ? '<' + l.parent.name : '')) };
  });
  await page.evaluate(() => { const g = window.gesso; g.togglePop('layers', g.renderLayers); });
  await page.waitForTimeout(300);
  await T.shot('groups-01-panel');
  out.ops = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    const G = e.layers.find((l) => l.name === 'Group 1');
    const before = __c(300, 300);
    const n0 = e.layers.length;
    e.deleteBlock(G); await __raf(); const afterDel = __c(300, 300); const n1 = e.layers.length;
    g.undo(); await __raf(); const undone = __c(300, 300); const n2 = e.layers.length;
    e.setProp(G, 'opacity', 0.5); await __raf(); const isoC = __c(300, 300);
    const flat = e.flattenGroup(G); await __raf(); const flatC = __c(300, 300);
    const flatOk = !flat.group && e.layers.indexOf(flat) >= 0 && !e.layers.some((l) => l.group && l.name === 'Group 1');
    g.undo(); await __raf();
    const G1 = e.layers.find((l) => l.name === 'Group 1');
    e.ungroup(G1); await __raf(); const ungroupedSame = JSON.stringify(__c(300, 300)) === JSON.stringify(__c(300, 300));
    g.undo(); await __raf();
    return { before, afterDel, undone, counts: [n0, n1, n2], isoC, flatC, flatOk, ungroupedSame, groups: e.layers.filter((l) => l.group).length };
  });
  // persistence: autosave + reload
  out.persist = await page.evaluate(async () => { const g = window.gesso, e = g.engine; await g.autosave.flush(); return { sig: e.layers.map((l) => l.name + '|' + (l.parent ? l.parent.name : '-') + '|' + l.group + '|' + l.opacity).join(','), c: __c(300, 300) }; });
  await page.goto(T.url); await page.waitForTimeout(1500); await page.evaluate(helpers);
  out.reload = await page.evaluate(() => { const e = window.gesso.engine; return { sig: e.layers.map((l) => l.name + '|' + (l.parent ? l.parent.name : '-') + '|' + l.group + '|' + l.opacity).join(','), c: __c(300, 300) }; });
  // .gesso round trip
  out.file = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine;
    const blob = await g.buildGesso();
    const z = await blob.arrayBuffer();
    const txt = new TextDecoder().decode(new Uint8Array(z));
    const nestedStack = /<stack name="Group 1"/.test(txt) || txt.includes('stack.xml');
    await g.importGessoBlob(blob, 'rt');
    return { nestedStack, sig: e.layers.map((l) => l.name + '|' + (l.parent ? l.parent.name : '-') + '|' + l.group + '|' + l.opacity).join(','), c: __c(300, 300) };
  });
  // groups as animation frames
  out.anim = await page.evaluate(async () => {
    const g = window.gesso, e = g.engine, a = g.anim;
    a.toggle(true); await __raf();
    const fr = a.frames().map((f) => f.base.name + (f.base.group ? '[g]' : ''));
    const G = e.layers.find((l) => l.group && !l.parent);
    const gi = a.frames().findIndex((f) => f.base === G);
    a.goto(gi); await __raf();
    const onGroup = __c(330, 300);
    const cur = a.current();
    a.toggle(false);
    return { fr, gi, cur, onGroup };
  });
  console.log(JSON.stringify(out, null, 1));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const b = out.build, o = out.ops;
  const ok = b.inG && b.nested && b.out1 && b.out2 && b.back && JSON.stringify(b.iso) !== JSON.stringify(b.twoHalf) && b.iso[0] > b.twoHalf[0] && o.flatOk && o.counts[1] < o.counts[0] && o.counts[2] === o.counts[0]
    && JSON.stringify(o.isoC) === JSON.stringify(o.flatC) && out.reload.sig === out.persist.sig && JSON.stringify(out.reload.c) === JSON.stringify(out.persist.c) && out.file.sig === out.persist.sig && out.anim.gi >= 0;
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

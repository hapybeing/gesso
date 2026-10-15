// Palettes UI: strip in the colour panel (+ adds, tap uses, hold → set/move/delete), Palettes sheet (new, import .gpl and
// .ase through the real file chooser, from artwork with live count, export .ase download parsed back), per-artwork
// palette surviving autosave reload and the .gesso round trip, library surviving reload.
const { start } = require('./lib.cjs');
const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const T = await start({ dsf: 1 }); const { page } = T;
  await page.goto(T.url + '?w=800&h=600&fresh=1'); await page.waitForTimeout(900);
  const r = {};
  // paint three colour blocks so "From artwork" has something to find
  await page.evaluate(() => { const e = window.gesso.engine, c = new OffscreenCanvas(e.w, e.h), x = c.getContext('2d');
    x.fillStyle = '#e04020'; x.fillRect(0, 0, 400, 600); x.fillStyle = '#2050c0'; x.fillRect(400, 0, 400, 300); x.fillStyle = '#30a050'; x.fillRect(400, 300, 400, 300); x.fillStyle = '#f0d020'; x.fillRect(100, 100, 30, 30);
    e.drawCanvasToLayer(e.activeLayer, c, 0, 0); });
  await page.click('#bColor'); await page.waitForTimeout(200);
  r.defaultCount = await page.locator('.swatches.pal .sw').count();
  await page.evaluate(() => window.gesso.setColor([0.5, 0.25, 0.75]));
  await page.locator('.palhead .chip[aria-label="Add colour"]').click();
  r.afterAdd = await page.locator('.swatches.pal .sw').count();
  r.lastHex = await page.locator('.swatches.pal .sw').last().getAttribute('title');
  await page.locator('.swatches.pal .sw').first().click();
  r.tapped = await page.evaluate(() => window.gesso.state.color.map((v) => Math.round(v * 255)).join(','));
  // touch & hold the new swatch → menu → Delete
  const box = await page.locator('.swatches.pal .sw').last().boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up();
  r.menu = await page.locator('.palmenu').count();
  await T.shot('palette-01-strip-menu');
  await page.locator('.palmenu .chip.danger').click(); await page.waitForTimeout(100);
  r.afterDelete = await page.locator('.swatches.pal .sw').count();
  // Palettes sheet
  await page.locator('.palhead .palname').click(); await page.waitForTimeout(200);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pal'));
  fs.writeFileSync(path.join(tmp, 'Sunset.gpl'), 'GIMP Palette\nName: Sunset\n#\n255  94  77 Coral\n255 176  59\n 46  41  78 Night\n');
  // .ase made by the app's own encoder is checked in the unit test; here a hand-made one with a group
  const ase = Buffer.from('41534546000100000000000300' + '00c00100000000'.slice(0, 0), 'hex');
  const mk = () => { const b = []; const u16 = (v) => b.push(v >> 8 & 255, v & 255), u32 = (v) => { u16(v >>> 16); u16(v & 65535); };
    const blk = (t, body) => { u16(t); u32(body.length); b.push(...body); };
    const nm = (s) => { const o = []; o.push(0, s.length + 1); for (const c of s) o.push(0, c.charCodeAt(0)); o.push(0, 0); return o; };
    const f = (v) => { const x = Buffer.alloc(4); x.writeFloatBE(v); return [...x]; };
    blk(0xc001, nm('Inks'));
    blk(1, [...nm('Teal'), ...Buffer.from('RGB '), ...f(0), ...f(0.5), ...f(0.5), 0, 2]);
    blk(1, [...nm('Black'), ...Buffer.from('CMYK'), ...f(0), ...f(0), ...f(0), ...f(1), 0, 2]);
    blk(0xc002, []);
    return Buffer.from([0x41, 0x53, 0x45, 0x46, 0, 1, 0, 0, 0, 0, 0, 4, ...b]); };
  fs.writeFileSync(path.join(tmp, 'inks.ase'), mk());
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('Import .ase / .gpl / .hex').click()]);
  await fc.setFiles([path.join(tmp, 'Sunset.gpl'), path.join(tmp, 'inks.ase')]); await page.waitForTimeout(400);
  r.rows = await page.locator('.palrow').count();
  r.names = await page.locator('.palrow-head b').allTextContents();
  // From artwork: count slider, add
  await page.getByText('From artwork').click(); await page.waitForSelector('.swatches.pal.big .sw');
  r.extracted = await page.locator('.swatches.pal.big .sw').evaluateAll((els) => els.map((e) => e.title));
  await T.shot('palette-02-from-artwork');
  await page.getByText('Add palette').click(); await page.waitForTimeout(200);
  // keep the artwork palette with the document
  const rowA = page.locator('.palrow', { hasText: 'artwork' }).last();
  await rowA.getByText('Keep with artwork').click(); await page.waitForTimeout(200);
  r.docRow = await page.locator('.palrow').first().textContent();
  await T.shot('palette-03-sheet');
  // export .ase of the Sunset palette and parse it back with the unit-tested parser
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.palrow', { hasText: 'Sunset' }).getByText('.ase').click()]);
  const dp = path.join(tmp, 'out.ase'); await dl.saveAs(dp);
  require('child_process').execSync('npx esbuild src/palette.ts --bundle --format=cjs --platform=node --outfile=/tmp/palette-unit.cjs --log-level=error', { cwd: __dirname + '/..' });
  const P = require('/tmp/palette-unit.cjs'); const back = P.parseASE(new Uint8Array(fs.readFileSync(dp)).buffer, 'x');
  r.aseBack = back.map((p) => p.name + ':' + p.colors.map((c) => (c.name || '') + c.hex).join('/')).join(';');
  await page.locator('.sheet-head .btn').click();
  // persistence: autosave reload and .gesso round trip
  r.saved = await page.evaluate(async () => { const g = window.gesso; await g.autosave.flush(); return g.docPalette && g.docPalette.colors.length; });
  await page.goto(T.url); await page.waitForTimeout(1500);
  r.reload = await page.evaluate(() => { const g = window.gesso; return { doc: g.docPalette && g.docPalette.colors.length, active: g.palettes.activeId, lib: g.palettes.list.map((p) => p.name) }; });
  r.gesso = await page.evaluate(async () => { const g = window.gesso; const n = g.docPalette.colors.length; const b = await g.buildGesso(); g.docPalette = null; await g.importGessoBlob(b, 'rt'); return g.docPalette ? g.docPalette.colors.length === n : false; });
  console.log(JSON.stringify(r));
  console.log('errors:', T.errs.length ? T.errs : 'none');
  await T.close();
  const ex = r.extracted.map((x) => x.toLowerCase());
  const checks = {
    strip: r.defaultCount === 18 && r.afterAdd === 19 && r.lastHex === '#8040bf' && r.tapped === '29,27,25' && r.menu === 1 && r.afterDelete === 18,
    imported: r.names.includes('Sunset') && r.names.includes('Inks'),
    extracted: ['#e04020', '#2050c0', '#30a050', '#f0d020'].every((c) => ex.includes(c)),
    docRow: /This artwork/.test(r.docRow),
    aseBack: r.aseBack === 'Sunset:Coral#ff5e4d/#ffb03b/Night#2e294e',
    persist: r.saved >= 4 && r.reload.doc === r.saved && r.reload.active === 'doc' && r.reload.lib.includes('Sunset') && r.gesso,
  };
  console.log(JSON.stringify(checks));
  process.exit(Object.values(checks).every(Boolean) && !T.errs.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

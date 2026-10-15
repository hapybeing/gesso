// Palette formats + extraction (node; bundles src/palette.ts).
require('child_process').execSync('npx esbuild src/palette.ts --bundle --format=cjs --platform=node --outfile=/tmp/palette-unit.cjs --log-level=error', { cwd: __dirname + '/..' });
const P = require('/tmp/palette-unit.cjs');
const ok = {};
// ---- hand-built .ase (independent encoder): a loose CMYK colour, then a group with RGB, LAB and Gray
const be = []; const u16 = (v) => be.push(v >> 8 & 255, v & 255), u32 = (v) => { u16(v >>> 16); u16(v & 65535); }, f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); be.push(...b); };
const blk = (type, fill) => { const save = be.splice(0); fill(); const body = be.splice(0); be.push(...save); u16(type); u32(body.length); be.push(...body); };
const nm = (s) => { u16(s.length + 1); for (const c of s) u16(c.charCodeAt(0)); u16(0); };
const colour = (name, model, vals) => blk(1, () => { nm(name); for (const c of model) be.push(c.charCodeAt(0)); vals.forEach(f32); u16(2); });
const blocks = []; const out = [];
const body = []; be.length = 0;
colour('Cyan ink', 'CMYK', [1, 0, 0, 0]);
blk(0xc001, () => nm('Skin'));
colour('Peach', 'RGB ', [1, 0.8, 0.6]);
colour('Lab grey', 'LAB ', [0.5, 0, 0]);
colour('Half', 'Gray', [0.5]);
blk(0xc002, () => {});
const ase = Buffer.from([0x41, 0x53, 0x45, 0x46, 0, 1, 0, 0, 0, 0, 0, 6, ...be]);
const pals = P.parseASE(ase.buffer.slice(ase.byteOffset, ase.byteOffset + ase.length), 'file');
ok.aseParse = pals.length === 2 && pals[0].name === 'file' && pals[0].colors[0].hex === '#00ffff' && pals[0].colors[0].name === 'Cyan ink'
  && pals[1].name === 'Skin' && pals[1].colors.map((c) => c.hex).join() === '#ffcc99,#777777,#808080';
// L*=50 → sRGB 119 (0x77) is the textbook value
const rt = P.parseASE(P.toASE(pals[1]).buffer, 'x');
ok.aseRoundTrip = rt.length === 1 && rt[0].name === 'Skin' && JSON.stringify(rt[0].colors) === JSON.stringify(pals[1].colors);
// ---- .gpl
const gpl = 'GIMP Palette\nName: Test pal\nColumns: 4\n#\n255   0   0\tRed\n  0 128 255 Untitled\n# comment\n 10  20  30\n';
const g = P.parseGPL(gpl);
ok.gpl = g.name === 'Test pal' && g.colors.length === 3 && g.colors[0].name === 'Red' && g.colors[1].hex === '#0080ff' && !g.colors[1].name && g.colors[2].hex === '#0a141e';
const g2 = P.parseGPL(P.toGPL(g)); ok.gplRoundTrip = g2.name === g.name && JSON.stringify(g2.colors) === JSON.stringify(g.colors);
// ---- hex lists (Lospec .hex, paint.net .txt with AARRGGBB and ; comments, CSS-ish)
ok.hex = P.parseHexList('ff0000\n00ff00\n').colors.length === 2 && P.parseHexList('; paint.net\nFF112233\nFFAABBCC').colors[1].hex === '#aabbcc' && P.parseHexList('#abc, #123456').colors[0].hex === '#aabbcc';
ok.clean = P.cleanPalette({ name: 'x', colors: [{ hex: 'zz' }, { hex: '#ABCDEF', name: 5 }] }).colors.length === 1 && P.cleanPalette('nope') === null;
// ---- extraction: a muted beige gradient (≈75 %), dark brown (≈20 %), a small red accent (1.6 %) and a tiny blue one (0.6 %)
const W = 200, H = 200, px = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4; let c = [200 + x / 10, 180 + x / 12, 150 + y / 20];
  if (y > 160) c = [70, 50, 40];
  if ((x - 60) ** 2 + (y - 60) ** 2 < 8 * 8) c = [210, 30, 40];
  if ((x - 140) ** 2 + (y - 80) ** 2 < 5 * 5) c = [30, 70, 200];
  c = c.map((v, k) => v + ((x * 7 + y * 13 + k * 5) % 9) - 4);   // a little noise
  px.set([...c, 255], i);
}
const dist = (hex, rgb) => { const a = P.toOklab(...P.hexRgb(hex)), b = P.toOklab(...rgb.map((v) => v / 255)); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
const recall = (sw) => ({ red: Math.min(...sw.map((s) => dist(s.hex, [210, 30, 40]))) < 0.08, blue: Math.min(...sw.map((s) => dist(s.hex, [30, 70, 200]))) < 0.08, brown: Math.min(...sw.map((s) => dist(s.hex, [70, 50, 40]))) < 0.06, n: sw.length });
const plain = P.extractPalette(px, W, H, { count: 5, power: 1, snap: false });
const tuned = P.extractPalette(px, W, H, { count: 5 });
const t0 = performance.now(); const big = new Uint8ClampedArray(512 * 512 * 4); for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24; P.extractPalette(big, 512, 512, { count: 12 }); const ms = Math.round(performance.now() - t0);
ok.extract = recall(tuned).red && recall(tuned).blue && recall(tuned).brown;
console.log('palette-unit', JSON.stringify({ plain: recall(plain), tuned: recall(tuned), tunedHex: tuned.map((s) => s.hex), noise512ms: ms }));
console.log('palette-unit checks', JSON.stringify(ok));
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);

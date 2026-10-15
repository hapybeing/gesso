// Fill maths (node): exact EDT and capped nearDist2 against brute force; regionFill timing on 2560×1600 line art.
require('child_process').execSync('npx esbuild src/filltool.ts --bundle --format=cjs --platform=node --outfile=/tmp/fill-unit.cjs --log-level=error', { cwd: __dirname + '/..' });
const { edt, nearDist2, regionFill, seedDistance } = require('/tmp/fill-unit.cjs');
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
let bad = 0;
for (let t = 0; t < 60; t++) {
  const W = 5 + (t * 7) % 40, H = 3 + (t * 11) % 30, C = 1 + t % 9, N = W * H, m = new Uint8Array(N), f = new Float32Array(N), pts = [];
  for (let i = 0; i < N; i++) { m[i] = rnd() < (t % 4) * 0.05 + (t % 3 === 0 ? 0.5 : 0) ? 1 : 0; f[i] = m[i] ? 0 : 1e20; if (m[i]) pts.push(i); }
  edt(f, W, H); const d = nearDist2(m, W, H, C), cap = (C + 1) ** 2;
  for (let i = 0; i < N; i++) {
    let b = 1e20; const x = i % W, y = (i - x) / W; for (const p of pts) { const px = p % W, py = (p - px) / W; b = Math.min(b, (x - px) ** 2 + (y - py) ** 2); }
    if (!(b >= 1e19 ? f[i] >= 1e19 : Math.abs(b - f[i]) < 1e-3)) bad++;
    if ((b <= C * C ? b : cap) !== (d[i] <= C * C ? d[i] : cap)) bad++;
  }
}
const W = 2560, H = 1600, px = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x % 200 < 3 && y % 97 > 5) || (y % 200 < 3 && x % 113 > 5)) px[(y * W + x) * 4 + 3] = 255;
const dist = seedDistance(px, W, H, 1100, 950), ms = {};
for (const [k, o] of [['plain', { gap: 0, expand: 0 }], ['gap4', { gap: 4, expand: 0 }], ['gap4+expand2', { gap: 4, expand: 2 }], ['wholeCanvas+expand2', { gap: 0, expand: 2 }]]) {
  let best = 1e9, r; for (let i = 0; i < 3; i++) { const t0 = performance.now(); r = regionFill(px, W, H, 1100, 950, { threshold: 0.1, ...o }, dist); best = Math.min(best, performance.now() - t0); }
  ms[k] = Math.round(best) + ' ms (' + r.area + ' px)';
}
console.log('fill-unit: distance mismatches', bad, JSON.stringify(ms));
process.exit(bad ? 1 : 0);

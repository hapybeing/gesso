// Recognition accuracy on noisy synthetic strokes (node; bundles src/quickshape.ts with esbuild).
require('child_process').execSync('npx esbuild src/quickshape.ts --bundle --format=cjs --outfile=/tmp/qs.cjs --log-level=error', { cwd: __dirname + '/..' });
const { recognise } = require('/tmp/qs.cjs');
let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const wob = (pts, amp) => { let ox = 0, oy = 0; return pts.map((p) => { ox = ox * 0.85 + rnd() * amp; oy = oy * 0.85 + rnd() * amp; return { x: p.x + ox, y: p.y + oy }; }); };
const seg = (a, b, n) => Array.from({ length: n }, (_, i) => ({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }));
const gens = {
  line: () => seg({ x: 100, y: 100 }, { x: 500, y: 260 }, 80).concat([{ x: 500, y: 260 }]),
  arc: () => Array.from({ length: 80 }, (_, i) => { const t = Math.PI * 0.1 + (i / 79) * Math.PI * 0.9; return { x: 300 + Math.cos(t) * 200, y: 300 - Math.sin(t) * 200 }; }),
  polyline: () => [...seg({ x: 100, y: 300 }, { x: 250, y: 100 }, 40), ...seg({ x: 250, y: 100 }, { x: 400, y: 300 }, 40), ...seg({ x: 400, y: 300 }, { x: 550, y: 100 }, 40), { x: 550, y: 100 }],
  ellipse: () => Array.from({ length: 120 }, (_, i) => { const t = (i / 116) * Math.PI * 2, c = Math.cos(0.4), s = Math.sin(0.4); const x = Math.cos(t) * 220, y = Math.sin(t) * 110; return { x: 400 + x * c - y * s, y: 300 + x * s + y * c }; }),
  circle: () => Array.from({ length: 120 }, (_, i) => { const t = (i / 116) * Math.PI * 2; return { x: 400 + Math.cos(t) * 150, y: 300 + Math.sin(t) * 156 }; }),
  rect: () => [...seg({ x: 100, y: 100 }, { x: 500, y: 100 }, 40), ...seg({ x: 500, y: 100 }, { x: 500, y: 330 }, 30), ...seg({ x: 500, y: 330 }, { x: 100, y: 330 }, 40), ...seg({ x: 100, y: 330 }, { x: 104, y: 112 }, 30)],
  square: () => [...seg({ x: 100, y: 100 }, { x: 400, y: 100 }, 40), ...seg({ x: 400, y: 100 }, { x: 400, y: 395 }, 40), ...seg({ x: 400, y: 395 }, { x: 100, y: 395 }, 40), ...seg({ x: 100, y: 395 }, { x: 100, y: 108 }, 40)],
  polygon: () => [...seg({ x: 300, y: 80 }, { x: 520, y: 400 }, 50), ...seg({ x: 520, y: 400 }, { x: 80, y: 400 }, 50), ...seg({ x: 80, y: 400 }, { x: 296, y: 90 }, 50)],
};
const scribble = () => Array.from({ length: 150 }, (_, i) => ({ x: 100 + i * 3, y: 200 + Math.sin(i / 5) * 60 + Math.sin(i / 17) * 40 }));
let ok = 0, total = 0;
for (const [name, g] of Object.entries(gens)) {
  const res = {};
  for (let k = 0; k < 20; k++) { const s = recognise(wob(g(), +(process.env.AMP || 2.2)), 1); const r = s ? s.kind : 'none'; res[r] = (res[r] || 0) + 1; total++; if (r === name || (name === 'polygon' && r === 'polygon')) ok++; }
  console.log(name.padEnd(9), JSON.stringify(res));
}
const wavy = () => Array.from({ length: 80 }, (_, i) => ({ x: 300 + i * 6, y: 750 + Math.sin(i / 4) * 30 + Math.sin(i / 11) * 25 }));
const fr = {}; for (let k = 0; k < 40; k++) { const s = recognise(wob(k % 2 ? scribble() : wavy(), 2), 1); const r = s ? s.kind : 'none'; fr[r] = (fr[r] || 0) + 1; }
console.log('scribble ', JSON.stringify(fr), '(should stay freehand)');
console.log(`accuracy ${ok}/${total}`);

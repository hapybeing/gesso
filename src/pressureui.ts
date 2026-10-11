// Pressure curve editor + draw-to-calibrate pad.
// Most apps ask you to drag a curve blind. Here you draw a few natural strokes; Gesso records the pressures
// your hand actually produces and fits the curve so your light touch maps to thin lines, your normal touch
// to the middle of the range and your firm touch to full size, then you can fine-tune the handles.
import { PressureCurve } from './stroke';

type Curve4 = [number, number, number, number];
const bz = (a: number, b: number, t: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;

/** evaluate y at x on the bezier (bisection on t; x(t) is monotonic for control x in [0,1]) */
function yAt(c: Curve4, x: number) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (bz(c[0], c[2], m) < x) lo = m; else hi = m; }
  return bz(c[1], c[3], (lo + hi) / 2);
}

/** fit control points so the recorded pressure quantiles land on target outputs */
export function fitCurve(pressures: number[]): Curve4 {
  const s = [...pressures].filter((p) => p > 0.001).sort((a, b) => a - b);
  if (s.length < 20) return [0.25, 0.25, 0.75, 0.75];
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  const targets: [number, number][] = [[q(0.05), 0.08], [q(0.3), 0.32], [q(0.5), 0.5], [q(0.75), 0.72], [q(0.97), 0.97]];
  let best: Curve4 = [0.25, 0.25, 0.75, 0.75], bestE = Infinity;
  const G = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const err = (c: Curve4) => targets.reduce((e, [x, y]) => e + (yAt(c, x) - y) ** 2, 0) + 0.002 * ((c[0] - c[1]) ** 2 + (c[2] - c[3]) ** 2);
  // handles stay ordered (x1 <= x2, y1 <= y2) so the result is a gentle S/arc a person can still fine-tune by hand
  const ok = (c: Curve4) => c[0] <= c[2] && c[1] <= c[3];
  for (const x1 of G) for (const y1 of G) for (const x2 of G) for (const y2 of G) {
    const c: Curve4 = [x1, y1, x2, y2];
    if (!ok(c)) continue;
    const e = err(c);
    if (e < bestE) { bestE = e; best = c; }
  }
  // local refinement
  let step = 0.05;
  for (let it = 0; it < 60; it++) {
    let improved = false;
    for (let k = 0; k < 4; k++) for (const d of [-step, step]) {
      const c = [...best] as Curve4; c[k] = Math.max(0, Math.min(1, c[k] + d));
      if (!ok(c)) continue;
      const e = err(c);
      if (e < bestE) { bestE = e; best = c; improved = true; }
    }
    if (!improved) step /= 2;
    if (step < 0.002) break;
  }
  return best.map((v) => Math.round(v * 1000) / 1000) as Curve4;
}

const h = (tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

/** Builds the pressure section. onChange receives new control points (already applied to `curve`). */
export function pressureSection(curve: PressureCurve, init: Curve4, onChange: (c: Curve4) => void): HTMLElement {
  let c: Curve4 = [...init];
  const recorded: number[] = [];
  let live = -1;
  const S = 220, P = 14, dpr = Math.min(2, devicePixelRatio || 1);
  const cv = h('canvas', { class: 'pcurve', width: String(S * dpr), height: String(S * dpr), style: `width:${S}px;height:${S}px` }) as HTMLCanvasElement;
  const g = cv.getContext('2d')!;
  const X = (x: number) => P + x * (S - 2 * P), Y = (y: number) => S - P - y * (S - 2 * P);
  const draw = () => {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, S, S);
    g.fillStyle = '#151312'; g.fillRect(0, 0, S, S);
    // recorded-pressure histogram behind the curve
    if (recorded.length) {
      const bins = new Array(32).fill(0);
      for (const p of recorded) bins[Math.min(31, Math.floor(p * 32))]++;
      const mx = Math.max(...bins);
      g.fillStyle = 'rgba(232,165,75,.18)';
      bins.forEach((n, i) => { const hh = (n / mx) * (S - 2 * P) * 0.6; g.fillRect(X(i / 32), S - P - hh, (S - 2 * P) / 32 - 1, hh); });
    }
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(X(i / 4), Y(0)); g.lineTo(X(i / 4), Y(1)); g.moveTo(X(0), Y(i / 4)); g.lineTo(X(1), Y(i / 4)); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,.25)'; g.strokeRect(X(0), Y(1), S - 2 * P, S - 2 * P);
    g.strokeStyle = 'rgba(255,255,255,.3)'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(c[0]), Y(c[1])); g.moveTo(X(1), Y(1)); g.lineTo(X(c[2]), Y(c[3])); g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#e8a54b'; g.lineWidth = 2.5; g.beginPath();
    for (let i = 0; i <= 64; i++) { const x = i / 64; g.lineTo(X(x), Y(curve.map(x))); }
    g.stroke();
    for (const [x, y] of [[c[0], c[1]], [c[2], c[3]]]) { g.beginPath(); g.arc(X(x), Y(y), 9, 0, 7); g.fillStyle = '#f1e9dd'; g.fill(); g.strokeStyle = '#1c1a19'; g.lineWidth = 2; g.stroke(); }
    if (live >= 0) { g.beginPath(); g.arc(X(live), Y(curve.map(live)), 6, 0, 7); g.fillStyle = '#c9603d'; g.fill(); }
  };
  const apply = () => { curve.set(...c); onChange([...c]); draw(); };
  let drag = -1;
  cv.addEventListener('pointerdown', (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const d0 = Math.hypot(x - X(c[0]), y - Y(c[1])), d1 = Math.hypot(x - X(c[2]), y - Y(c[3]));
    drag = Math.min(d0, d1) < 34 ? (d0 < d1 ? 0 : 1) : -1;
    if (drag >= 0) try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  });
  cv.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const r = cv.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left - P) / (S - 2 * P))), y = Math.max(0, Math.min(1, (S - P - (e.clientY - r.top)) / (S - 2 * P)));
    c[drag * 2] = Math.round(x * 1000) / 1000; c[drag * 2 + 1] = Math.round(y * 1000) / 1000;
    apply();
  });
  cv.addEventListener('pointerup', () => { drag = -1; });

  // calibration pad: draw here with the stylus
  const pad = h('canvas', { class: 'ppad', width: String(360 * dpr), height: String(150 * dpr) }) as HTMLCanvasElement;
  const pg = pad.getContext('2d')!;
  const padHint = () => { pg.setTransform(dpr, 0, 0, dpr, 0, 0); pg.clearRect(0, 0, 360, 150); pg.fillStyle = 'rgba(241,233,221,.35)'; pg.font = '14px system-ui'; pg.textAlign = 'center'; pg.fillText('Scribble here with your stylus, the way you normally draw', 180, 80); };
  padHint();
  let lastPt: { x: number; y: number } | null = null;
  const status = h('span', { class: 'muted' }, 'No samples yet');
  pad.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') { status.textContent = 'Use your stylus here'; return; }
    try { pad.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    if (!recorded.length) pg.clearRect(0, 0, 360, 150);
    const r = pad.getBoundingClientRect(); lastPt = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  pad.addEventListener('pointermove', (e) => {
    if (!lastPt) { if (e.pointerType === 'pen') { live = e.pressure; draw(); } return; }
    const evs = (e.getCoalescedEvents?.() || []) as PointerEvent[];
    const r = pad.getBoundingClientRect();
    for (const ev of evs.length ? evs : [e]) {
      const p = ev.pointerType === 'pen' ? ev.pressure : 0.5;
      if (p > 0) recorded.push(p);
      const pt = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      pg.strokeStyle = '#f1e9dd'; pg.lineCap = 'round'; pg.lineWidth = 1 + 9 * curve.map(p);
      pg.beginPath(); pg.moveTo(lastPt.x, lastPt.y); pg.lineTo(pt.x, pt.y); pg.stroke();
      lastPt = pt; live = p;
    }
    status.textContent = `${recorded.length} samples`;
    draw();
  });
  const end = () => {
    lastPt = null;
    if (recorded.length >= 60) { c = fitCurve(recorded); apply(); status.textContent = `${recorded.length} samples · curve fitted to your hand`; }
  };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);

  const presets: [string, Curve4][] = [['Soft', [0.1, 0.45, 0.45, 0.95]], ['Linear', [0.25, 0.25, 0.75, 0.75]], ['Firm', [0.55, 0.05, 0.9, 0.55]]];
  const chips = h('div', { class: 'chips' }, ...presets.map(([n, v]) => {
    const b = h('button', { class: 'chip' }, n);
    b.onclick = () => { c = [...v]; apply(); };
    return b;
  }), (() => { const b = h('button', { class: 'chip' }, 'Clear samples'); b.onclick = () => { recorded.length = 0; padHint(); status.textContent = 'No samples yet'; draw(); }; return b; })());
  curve.set(...c);
  draw();
  return h('section', {}, h('h4', {}, 'Pressure'),
    h('div', { class: 'prow' }, cv, h('div', { class: 'pcol' }, pad, status, chips,
      h('p', { class: 'muted' }, 'Draw in the pad and the curve fits itself to your natural pressure. Drag the two handles to fine-tune. Left = light touch, right = firm.'))));
}

// Stylus & palm test: a scratch pad that logs raw pointer data so feel can be tuned on the real tablet.
// Shows event and coalesced sample rates, input latency (event age when handled), pressure range and
// histogram, tilt and twist, contact sizes (what a resting palm measures) and whether Gesso's palm rule
// would reject each touch. The log can be copied or downloaded as JSON.
import { h } from './dom';

/** Gesso's palm rule (input.ts): a touch whose contact area exceeds this (CSS px²) is ignored */
export const PALM_AREA = 4200;

interface Rec { t: number; type: string; id: number; ev: string; x: number; y: number; p: number; tx: number; ty: number; tw: number; w: number; h: number; btn: number; co: number; pr: number; age: number; palm: boolean; }

export function openStylusTest(onClose: () => void = () => {}) {
  const log: Rec[] = [];
  const wrap = h('div', { class: 'stest' });
  const cv = h('canvas', { class: 'stest-pad' }) as HTMLCanvasElement;
  const stats = h('div', { class: 'stest-stats' });
  const tips = h('div', { class: 'stest-tips' });
  const close = () => { wrap.remove(); removeEventListener('resize', size); onClose(); };
  const json = () => JSON.stringify({ ua: navigator.userAgent, dpr: devicePixelRatio, screen: [screen.width, screen.height], records: log }, null, 0);
  wrap.append(
    h('div', { class: 'stest-head' }, h('b', {}, 'Stylus & palm test'), h('span', { class: 'muted' }, 'Draw with the pen, rest your palm, try light and hard strokes and tilt'),
      h('div', { class: 'chips' },
        h('button', { class: 'chip', onClick: () => { log.length = 0; g.clearRect(0, 0, cv.width, cv.height); render(); } }, 'Clear'),
        h('button', { class: 'chip', onClick: () => { void navigator.clipboard?.writeText(json()).then(() => { tips.textContent = 'Log copied (' + log.length + ' records)'; }); } }, 'Copy log'),
        h('button', { class: 'chip', onClick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([json()], { type: 'application/json' })), download: 'gesso-stylus-log.json' }) as HTMLAnchorElement; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } }, 'Download'),
        h('button', { class: 'btn small', onClick: close }, 'Done'))),
    h('div', { class: 'stest-body' }, cv, h('div', { class: 'stest-side' }, stats, tips)));
  document.body.append(wrap);
  const g = cv.getContext('2d')!;
  const size = () => { const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d); g.setTransform(d, 0, 0, d, 0, 0); };
  size(); addEventListener('resize', size);

  const last = new Map<number, { x: number; y: number }>();
  const rec = (e: PointerEvent, kind: string) => {
    const r = cv.getBoundingClientRect();
    const co = (e.getCoalescedEvents?.() ?? []) as PointerEvent[];
    const pr = (e.getPredictedEvents?.() ?? []) as PointerEvent[];
    const list = kind === 'move' && co.length ? co : [e];
    const palm = e.pointerType === 'touch' && e.width * e.height > PALM_AREA;
    const age = Math.max(0, performance.now() - e.timeStamp);
    for (const c of list) {
      const x = c.clientX - r.left, y = c.clientY - r.top;
      log.push({ t: +c.timeStamp.toFixed(2), type: e.pointerType, id: e.pointerId, ev: kind, x: +x.toFixed(1), y: +y.toFixed(1), p: +c.pressure.toFixed(4), tx: c.tiltX || 0, ty: c.tiltY || 0, tw: c.twist || 0,
        w: +(c.width || 0).toFixed(1), h: +(c.height || 0).toFixed(1), btn: c.buttons, co: co.length, pr: pr.length, age: +age.toFixed(1), palm });
      // draw: pen blue, touch orange, mouse grey; width follows pressure; rejected palms as red ellipses
      const l = last.get(e.pointerId);
      if (palm) { g.strokeStyle = 'rgba(220,40,40,.6)'; g.lineWidth = 1; g.beginPath(); g.ellipse(x, y, Math.max(2, c.width / 2), Math.max(2, c.height / 2), 0, 0, Math.PI * 2); g.stroke(); }
      else if (l && kind !== 'down') {
        g.strokeStyle = e.pointerType === 'pen' ? 'rgba(40,110,230,.9)' : e.pointerType === 'touch' ? 'rgba(230,140,40,.9)' : 'rgba(120,120,120,.9)';
        g.lineWidth = 0.5 + 9 * (e.pointerType === 'pen' ? c.pressure : 0.4); g.lineCap = 'round';
        g.beginPath(); g.moveTo(l.x, l.y); g.lineTo(x, y); g.stroke();
      }
      last.set(e.pointerId, { x, y });
    }
    if (kind === 'up' || kind === 'cancel') last.delete(e.pointerId);
    if (pr.length && kind === 'move') {   // predicted positions as faint dots
      g.fillStyle = 'rgba(40,180,120,.5)';
      for (const p of pr) { g.beginPath(); g.arc(p.clientX - r.left, p.clientY - r.top, 2, 0, Math.PI * 2); g.fill(); }
    }
    schedule();
  };
  for (const [ev, kind] of [['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up'], ['pointercancel', 'cancel']] as const)
    cv.addEventListener(ev, (e) => { e.preventDefault(); if (kind === 'down') { try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic or already gone */ } } rec(e as PointerEvent, kind); });
  cv.style.touchAction = 'none';

  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  const render = () => {
    const pen = log.filter((r) => r.type === 'pen' && r.ev === 'move');
    const touch = log.filter((r) => r.type === 'touch');
    const span = (a: Rec[]) => (a.length > 1 ? (a[a.length - 1].t - a[0].t) / 1000 : 0);
    const rate = (a: Rec[]) => { // samples per second over continuous runs (gaps > 100 ms split)
      let n = 0, s = 0; for (let i = 1; i < a.length; i++) { const d = a[i].t - a[i - 1].t; if (d > 0 && d < 100) { n++; s += d; } } return n ? 1000 / (s / n) : 0; };
    const events = new Set(pen.map((r) => r.t + ':' + r.co)).size;
    const ps = pen.map((r) => r.p).filter((p) => p > 0).sort((a, b) => a - b);
    const q = (k: number) => (ps.length ? ps[Math.min(ps.length - 1, Math.floor(k * ps.length))] : 0);
    const ages = pen.map((r) => r.age).sort((a, b) => a - b);
    const maxTilt = pen.reduce((m, r) => Math.max(m, Math.hypot(r.tx, r.ty)), 0);
    const areas = touch.map((r) => r.w * r.h).sort((a, b) => a - b);
    const palms = new Set(touch.filter((r) => r.palm).map((r) => r.id)).size, touches = new Set(touch.map((r) => r.id)).size;
    const predicted = pen.filter((r) => r.pr > 0).length;
    const hist = new Array(10).fill(0); for (const p of ps) hist[Math.min(9, Math.floor(p * 10))]++;
    const hmax = Math.max(1, ...hist);
    stats.innerHTML = '';
    const row = (k: string, v: string) => stats.append(h('div', { class: 'srow' }, h('span', { class: 'muted' }, k), h('b', {}, v)));
    row('Pen samples', String(pen.length) + (span(pen) ? ` · ${span(pen).toFixed(1)} s` : ''));
    row('Sample rate', pen.length > 2 ? Math.round(rate(pen)) + ' Hz' : '—');
    row('Samples per event', events ? (pen.length / events).toFixed(1) : '—');
    row('Event age (median / p95)', ages.length ? `${ages[ages.length >> 1].toFixed(1)} / ${ages[Math.floor(ages.length * 0.95)].toFixed(1)} ms` : '—');
    row('Predicted events', pen.length ? Math.round(100 * predicted / pen.length) + '% of moves' : '—');
    row('Pressure (5% / 50% / 95%)', ps.length ? `${q(0.05).toFixed(2)} / ${q(0.5).toFixed(2)} / ${q(0.95).toFixed(2)}` : '—');
    row('Max tilt', pen.length ? Math.round(maxTilt) + '°' : '—');
    row('Touches / rejected as palm', `${touches} / ${palms}`);
    row('Touch contact (median / max)', areas.length ? `${Math.round(areas[areas.length >> 1])} / ${Math.round(areas[areas.length - 1])} px²` : '—');
    stats.append(h('div', { class: 'stest-hist', title: 'Pressure histogram' }, ...hist.map((n) => h('i', { style: `height:${Math.round(4 + 56 * n / hmax)}px` }))));
    // advice
    const tipsList: string[] = [];
    if (ps.length > 50 && q(0.95) < 0.6) tipsList.push('Your hardest strokes stay below 0.6 pressure: use a Soft curve or "Draw to calibrate" in Pressure.');
    if (ps.length > 50 && q(0.05) > 0.3) tipsList.push('Light strokes start high (above 0.3): a Firm curve gives you more range at the light end.');
    if (pen.length > 50 && rate(pen) < 100) tipsList.push('Sample rate under 100 Hz: raise Smoothing a little for cleaner lines.');
    if (areas.length && touches > palms && areas[areas.length - 1] > PALM_AREA * 0.6 && palms === 0) tipsList.push('A touch came close to the palm threshold without being rejected; tell me the max contact number so I can tune it.');
    if (pen.length && !predicted) tipsList.push('This browser gives no predicted events, so the predicted tip has nothing to draw.');
    tips.textContent = tipsList.join(' ') || (log.length ? 'Looks healthy.' : 'Waiting for input…');
  };
  render();
  return { wrap, log, close, render };
}

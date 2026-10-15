// Radial quick menu + gesture customisation (M5.6).
// Bar (research): the leading iPad app has a QuickMenu (a ring of six actions, chosen per slot, opened by a
// gesture or a button, tap or flick to pick) and Gesture controls that map touch & hold, □+touch, Apple Pencil
// double-tap and squeeze, 3/4-finger taps to undo/redo/eyedropper/QuickMenu/clear layer/full screen…; Clip Studio
// and Infinite Painter offer radial "pie" menus. Gesso: a ring of eight slots, each set to any action, opened by a
// four-finger tap (or any gesture you assign) at the fingers, or by its button; pick by tapping a slot or by
// pressing, sliding onto a slot and lifting (a flick). Gestures (2/3/4-finger tap, touch & hold, two-finger hold,
// stylus side button) each map to any action.
import { h } from './dom';

export type ActionId = 'none' | 'undo' | 'redo' | 'repeatUndo' | 'quickmenu' | 'eyedrop' | 'brush' | 'eraser' | 'smudge' | 'swapTool' | 'fill' | 'select' | 'transform' | 'text'
  | 'newLayer' | 'duplicateLayer' | 'clearLayer' | 'layers' | 'colour' | 'brushes' | 'fit' | 'hideUI' | 'play' | 'anim' | 'guides' | 'symmetry' | 'deselect' | 'exportPNG';
export const ACTIONS: Record<Exclude<ActionId, 'repeatUndo'>, { label: string; icon: string }> = {
  none: { label: 'Nothing', icon: '' },
  undo: { label: 'Undo', icon: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3' },
  redo: { label: 'Redo', icon: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3' },
  quickmenu: { label: 'Quick menu', icon: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 12h.01' },
  eyedrop: { label: 'Eyedropper', icon: 'M14 4l6 6-9 9H5v-6zM12 6l6 6' },
  brush: { label: 'Paint', icon: 'M4 20c3 0 5-2 5-4.5S6.5 12 4 14.5 4 20 4 20zM9 15L19.5 4.5a1.5 1.5 0 012 2L11 17' },
  eraser: { label: 'Erase', icon: 'M7 20h10M4 15l8-8 6 6-5 5H8z' },
  smudge: { label: 'Smudge', icon: 'M8 21V11a2 2 0 014 0v4-6a2 2 0 014 0v6-4a2 2 0 014 0v5c0 4-3 6-6 6h-2c-3 0-5-2-6-4l-2-4a2 2 0 013-2l1 2' },
  swapTool: { label: 'Paint ↔ erase', icon: 'M7 7h12l-3-3M17 17H5l3 3' },
  fill: { label: 'Fill tool', icon: 'M5 12l7-7 7 7-7 7zM19.5 15.5s1.5 2 1.5 3a1.5 1.5 0 01-3 0c0-1 1.5-3 1.5-3z' },
  select: { label: 'Select', icon: 'M4 4h4M12 4h4M20 4v4M20 12v4M20 20h-4M12 20H8M4 20v-4M4 12V8' },
  transform: { label: 'Transform', icon: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3' },
  text: { label: 'Text', icon: 'M5 6V4h14v2M12 4v16M9 20h6' },
  newLayer: { label: 'New layer', icon: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M18 17v6M15 20h6' },
  duplicateLayer: { label: 'Duplicate layer', icon: 'M8 8h12v12H8zM4 16V4h12' },
  clearLayer: { label: 'Clear layer', icon: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' },
  layers: { label: 'Layers', icon: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5' },
  colour: { label: 'Colour', icon: 'M12 3a9 9 0 100 18c1 0 2-1 2-2s-1-2 0-3 3 0 4-1 3-3 3-5c0-4-4-7-9-7zM7.5 11h.01M10 7h.01M15 7.5h.01' },
  brushes: { label: 'Brushes', icon: 'M4 20c3 0 5-2 5-4.5S6.5 12 4 14.5 4 20 4 20zM9 15L19.5 4.5a1.5 1.5 0 012 2L11 17' },
  fit: { label: 'Fit canvas', icon: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5' },
  hideUI: { label: 'Full screen', icon: 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5' },
  play: { label: 'Play / pause', icon: 'M7 4.5v15l12.5-7.5z' },
  anim: { label: 'Animation', icon: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4' },
  guides: { label: 'Drawing guides', icon: 'M3 3l18 18M3 12h18M12 3v18' },
  symmetry: { label: 'Symmetry', icon: 'M12 3v18M8 7l-4 5 4 5M16 7l4 5-4 5' },
  deselect: { label: 'Deselect', icon: 'M4 4l16 16M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4' },
  exportPNG: { label: 'Export PNG', icon: 'M12 3v12M8 11l4 4 4-4M5 21h14' },
};
export type GestureKind = 'tap2' | 'tap3' | 'tap4' | 'hold1' | 'hold2' | 'penButton';
export const GESTURES: [GestureKind, string][] = [['tap2', 'Two-finger tap'], ['tap3', 'Three-finger tap'], ['tap4', 'Four-finger tap'], ['hold1', 'Touch & hold'], ['hold2', 'Two-finger hold'], ['penButton', 'Stylus side button']];
export const DEFAULT_GESTURES: Record<GestureKind, ActionId> = { tap2: 'undo', tap3: 'redo', tap4: 'quickmenu', hold1: 'eyedrop', hold2: 'repeatUndo', penButton: 'none' };
export const DEFAULT_SLOTS: ActionId[] = ['brush', 'eraser', 'eyedrop', 'newLayer', 'layers', 'fill', 'transform', 'hideUI'];
export const label = (a: ActionId) => a === 'repeatUndo' ? 'Undo repeatedly' : ACTIONS[a]?.label ?? a;

/** the action choices offered for a gesture (repeat-undo only makes sense for holds) */
export const choicesFor = (g: GestureKind | 'slot'): ActionId[] => {
  const all = Object.keys(ACTIONS) as ActionId[];
  if (g === 'hold2') return ['repeatUndo', ...all];
  if (g === 'slot') return all.filter((a) => a !== 'quickmenu');
  return all;
};

export interface QuickHost { run(a: ActionId): void; slots(): ActionId[]; }
/**
 * Ring of slots around (x, y) (clamped on screen). A tap on a slot runs it; a press that slides onto a slot and
 * lifts runs it too (flick); anything else closes the ring.
 */
export class QuickMenu {
  el: HTMLElement | null = null;
  private hover = -1;
  constructor(private host: QuickHost) {}
  get open() { return !!this.el; }
  show(x: number, y: number, pointerId?: number) {
    this.close();
    const slots = this.host.slots(), n = slots.length, R = 104, S = 60;
    const cx = Math.max(R + S / 2 + 8, Math.min(innerWidth - R - S / 2 - 8, x)), cy = Math.max(R + S / 2 + 8, Math.min(innerHeight - R - S / 2 - 8, y));
    const ring = h('div', { class: 'qm-ring', style: `left:${cx}px;top:${cy}px` });
    const wrap = h('div', { class: 'qm-wrap' }, ring);
    const btns: HTMLElement[] = [];
    slots.forEach((a, i) => {
      const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const meta = ACTIONS[a as Exclude<ActionId, 'repeatUndo'>] || ACTIONS.none;
      const b = h('button', { class: 'qm-slot' + (a === 'none' ? ' empty' : ''), style: `left:${Math.cos(ang) * R}px;top:${Math.sin(ang) * R}px`, 'aria-label': label(a), 'data-i': String(i) },
        meta.icon ? svgIcon(meta.icon) : '', h('span', {}, a === 'none' ? '—' : meta.label));
      b.onclick = (ev) => { ev.stopPropagation(); this.pick(i); };
      btns.push(b); ring.append(b);
    });
    ring.append(h('button', { class: 'qm-centre', 'aria-label': 'Close', onClick: (ev: Event) => { ev.stopPropagation(); this.close(); } }, '×'));
    // flick: slide from the press point onto a slot and lift
    wrap.onpointerdown = (ev) => { if (ev.target === wrap) this.close(); };
    const track = (ev: PointerEvent) => {
      const dx = ev.clientX - cx, dy = ev.clientY - cy, d = Math.hypot(dx, dy);
      let k = -1;
      if (d > 44 && d < R + 70) k = ((Math.round(((Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI * 2)) * n) % n) + n) % n;
      if (k !== this.hover) { btns.forEach((b, i) => b.classList.toggle('hot', i === k)); this.hover = k; }
    };
    if (pointerId !== undefined) {
      const mv = (ev: PointerEvent) => { if (ev.pointerId === pointerId) track(ev); };
      const up = (ev: PointerEvent) => { if (ev.pointerId !== pointerId) return; removeEventListener('pointermove', mv, true); removeEventListener('pointerup', up, true); if (this.hover >= 0) this.pick(this.hover); };
      addEventListener('pointermove', mv, true); addEventListener('pointerup', up, true);
    }
    document.body.append(wrap);
    this.el = wrap;
  }
  private pick(i: number) { const a = this.host.slots()[i]; this.close(); if (a && a !== 'none') this.host.run(a); }
  close() { this.el?.remove(); this.el = null; this.hover = -1; }
}

function svgIcon(d: string) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  return t.content.firstChild as SVGElement;
}

/** settings sheet body: slots of the quick menu and the gesture map */
export function quickSettings(body: HTMLElement, slots: ActionId[], gestures: Record<GestureKind, ActionId>, save: () => void) {
  const sel = (choices: ActionId[], cur: ActionId, fn: (a: ActionId) => void) => {
    const s = h('select', { class: 'qm-select' }, ...choices.map((a) => { const o = h('option', { value: a }, label(a)); if (a === cur) o.selected = true; return o; })) as HTMLSelectElement;
    s.onchange = () => { fn(s.value as ActionId); save(); };
    return s;
  };
  body.append(
    h('section', {}, h('h4', {}, 'Gestures'),
      ...GESTURES.map(([g, l]) => h('label', { class: 'srow' }, h('span', {}, l), sel(choicesFor(g), gestures[g], (a) => { gestures[g] = a; }))),
      h('p', { class: 'muted' }, 'Taps are quick touches without moving. The stylus side button only works with pens that report it (S Pen and most USI pens).')),
    h('section', {}, h('h4', {}, 'Quick menu'),
      h('p', { class: 'muted' }, 'Eight slots, clockwise from the top. Open it with its button or a gesture; tap a slot, or press, slide onto a slot and lift.'),
      ...slots.map((a, i) => h('label', { class: 'srow' }, h('span', {}, 'Slot ' + (i + 1)), sel(choicesFor('slot'), a, (x) => { slots[i] = x; })))),
  );
}

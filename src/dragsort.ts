// Long-press drag to reorder (layers list, animation timeline). Hold an item still for `hold` ms and it lifts:
// a ghost follows the pointer, an insertion bar shows where it will land, and the list auto-scrolls when the
// pointer nears either end (speed grows with depth into the edge zone). Moving before the hold fires cancels
// the lift, so ordinary scrolling and taps keep working. Release drops; Escape or pointercancel aborts.
export interface DragSortOpts {
  /** the scrolling container */
  scroller: HTMLElement;
  /** draggable items, in visual order (top→bottom or left→right) */
  items: () => HTMLElement[];
  axis: 'x' | 'y';
  /** from = item index, to = insertion slot (0..n, in the same visual order; from and from+1 mean no move) */
  onDrop(from: number, to: number): void;
  /** items that may not be lifted */
  canLift?(i: number): boolean;
  hold?: number;
}

export const DRAG_STATS = { lifts: 0, drops: 0, scrolled: 0, last: [-1, -1] };

export function dragSort(o: DragSortOpts) {
  const holdMs = o.hold ?? 340;
  o.scroller.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0) return;
    const items = o.items();
    const from = items.findIndex((it) => it.contains(ev.target as Node));
    if (from < 0 || (o.canLift && !o.canLift(from))) return;
    // controls inside a row (eye toggle, chevron) keep their own taps
    if ((ev.target as HTMLElement).closest('button,input,select,label,.tl-grip')) return;
    const id = ev.pointerId, x0 = ev.clientX, y0 = ev.clientY;
    let px = x0, py = y0, lifted = false, slot = from, raf = 0;
    let ghost: HTMLElement | null = null, bar: HTMLElement | null = null, offX = 0, offY = 0, gx = 0, gy = 0;
    const timer = window.setTimeout(lift, holdMs);
    const along = (r: DOMRect) => o.axis === 'y' ? [r.top, r.bottom] : [r.left, r.right];
    function lift() {
      lifted = true; DRAG_STATS.lifts++;
      const it = items[from], r = it.getBoundingClientRect();
      offX = px - r.left; offY = py - r.top; gx = r.left; gy = r.top;
      ghost = it.cloneNode(true) as HTMLElement;
      ghost.classList.add('drag-ghost');
      Object.assign(ghost.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: '0', zIndex: '9999', pointerEvents: 'none' });
      // canvases do not clone their pixels
      const srcC = it.querySelectorAll('canvas'), dstC = ghost.querySelectorAll('canvas');
      srcC.forEach((c, k) => { try { (dstC[k] as HTMLCanvasElement).getContext('2d')?.drawImage(c, 0, 0); } catch { /* tainted/empty */ } });
      document.body.append(ghost);
      it.classList.add('drag-src');
      bar = document.createElement('div'); bar.className = 'drag-bar ' + o.axis;
      document.body.append(bar);
      navigator.vibrate?.(12);
      update(); loop();
    }
    function computeSlot() {
      let s = items.length;
      for (let i = 0; i < items.length; i++) {
        const [a, b] = along(items[i].getBoundingClientRect());
        if ((o.axis === 'y' ? py : px) < (a + b) / 2) { s = i; break; }
      }
      return s;
    }
    function update() {
      if (!ghost || !bar) return;
      // the ghost slides along the list axis only (re-reading its scaled rect made it drift sideways)
      ghost.style.left = (o.axis === 'x' ? px - offX : gx) + 'px';
      ghost.style.top = (o.axis === 'y' ? py - offY : gy) + 'px';
      slot = computeSlot();
      const sr = o.scroller.getBoundingClientRect();
      const ref = items[Math.min(slot, items.length - 1)].getBoundingClientRect();
      const pos = slot < items.length ? along(ref)[0] : along(ref)[1];
      if (o.axis === 'y') Object.assign(bar.style, { left: sr.left + 4 + 'px', width: sr.width - 8 + 'px', top: Math.max(sr.top, Math.min(sr.bottom, pos)) - 2 + 'px' });
      else Object.assign(bar.style, { top: sr.top + 4 + 'px', height: sr.height - 8 + 'px', left: Math.max(sr.left, Math.min(sr.right, pos)) - 2 + 'px' });
    }
    // auto-scroll near the ends: up to ~14 px per frame, proportional to how deep into the 48 px zone
    function loop() {
      raf = requestAnimationFrame(loop);
      const r = o.scroller.getBoundingClientRect();
      const [a, b] = o.axis === 'y' ? [r.top, r.bottom] : [r.left, r.right];
      const p = o.axis === 'y' ? py : px, Z = 48;
      let v = 0;
      if (p < a + Z) v = -Math.min(1, (a + Z - p) / Z); else if (p > b - Z) v = Math.min(1, (p - (b - Z)) / Z);
      if (v) {
        const before = o.axis === 'y' ? o.scroller.scrollTop : o.scroller.scrollLeft;
        if (o.axis === 'y') o.scroller.scrollTop += v * 14; else o.scroller.scrollLeft += v * 14;
        const after = o.axis === 'y' ? o.scroller.scrollTop : o.scroller.scrollLeft;
        if (after !== before) { DRAG_STATS.scrolled += Math.abs(after - before); update(); }
      }
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      px = e.clientX; py = e.clientY;
      if (!lifted) { if (Math.hypot(px - x0, py - y0) > 9) end(false); return; }
      e.preventDefault(); update();
    };
    // once lifted, stop the browser from turning the drag into a native scroll
    const tmove = (e: TouchEvent) => { if (lifted) e.preventDefault(); };
    const up = (e: PointerEvent) => { if (e.pointerId === id) end(e.type === 'pointerup'); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') end(false); };
    // a lift swallows the click that follows the release
    const eat = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
    function end(drop: boolean) {
      clearTimeout(timer); cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true); window.removeEventListener('touchmove', tmove);
      window.removeEventListener('keydown', key, true);
      if (!lifted) return;
      ghost?.remove(); bar?.remove();
      items[from]?.classList.remove('drag-src');
      window.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', eat, true), 400);
      DRAG_STATS.last = [from, slot];
      if (drop && slot !== from && slot !== from + 1) { DRAG_STATS.drops++; o.onDrop(from, slot); }
    }
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('touchmove', tmove, { passive: false });
    window.addEventListener('keydown', key, true);
  });
}

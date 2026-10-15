// Palette UI (M5.4): the palette strip in the colour panel and the Palettes sheet.
import { h } from './dom';
import { Palette, PaletteLibrary, Swatch, extractPalette, hexRgb, newId, parsePaletteFile, rgbHex, toASE, toGPL } from './palette';

type RGB = [number, number, number];
export interface PaletteHost {
  lib: PaletteLibrary;
  /** the palette stored in the open artwork (null = none) */
  doc(): Palette | null;
  setDoc(p: Palette | null): void;
  colour(): RGB;
  setColour(c: RGB): void;
  sheet(title: string): { body: HTMLElement; close: () => void };
  download(b: Blob, name: string, type: string): void;
  toast(m: string): void;
  /** the artwork, downscaled, as straight-alpha RGBA */
  canvasPixels(): Promise<{ px: Uint8ClampedArray; w: number; h: number }>;
  /** re-render the colour panel if open */
  refresh(): void;
}
export const DOC = 'doc';

export function activePalette(H: PaletteHost): Palette {
  const d = H.doc();
  if (H.lib.activeId === DOC && d) return d;
  return H.lib.get(H.lib.activeId) || H.lib.list[0];
}
const isDoc = (H: PaletteHost, p: Palette) => p === H.doc();
/** persist a change to palette p (library → localStorage, artwork palette → autosave via setDoc) */
function saved(H: PaletteHost, p: Palette) { if (isDoc(H, p)) H.setDoc(p); else H.lib.save(); H.refresh(); }

/** the strip in the colour panel: name button (opens the sheet), + adds the current colour, swatches */
export function paletteSection(H: PaletteHost): HTMLElement {
  const p = activePalette(H);
  const wrap = h('div', { class: 'palsec' });
  const head = h('div', { class: 'palhead' },
    h('button', { class: 'chip palname', title: 'Palettes', onClick: () => openPalettes(H) }, (isDoc(H, p) ? 'This artwork · ' : '') + p.name + ' ▾'),
    h('button', { class: 'chip', title: 'Add the current colour', 'aria-label': 'Add colour', onClick: () => {
      const hex = rgbHex(...H.colour());
      if (p.colors.some((c) => c.hex === hex)) { H.toast('Already in ' + p.name); return; }
      p.colors.push({ hex }); saved(H, p);
    } }, '+'));
  const grid = h('div', { class: 'swatches pal' });
  let menu: HTMLElement | null = null;
  p.colors.forEach((c, i) => {
    let timer = 0, held = false;
    const b = h('button', { class: 'sw', style: `background:${c.hex}`, title: c.name ? `${c.name} ${c.hex}` : c.hex });
    b.onpointerdown = () => { held = false; timer = window.setTimeout(() => { held = true; showMenu(i, b); }, 450); };
    b.onpointerup = b.onpointerleave = b.onpointercancel = () => clearTimeout(timer);
    b.oncontextmenu = (ev) => { ev.preventDefault(); held = true; showMenu(i, b); };
    b.onclick = () => { if (!held) H.setColour(hexRgb(c.hex)); };
    grid.append(b);
  });
  if (!p.colors.length) grid.append(h('span', { class: 'muted small palempty' }, 'Empty · tap + to add the current colour'));
  // touch & hold a swatch: replace with the current colour, move, or delete
  const showMenu = (i: number, at: HTMLElement) => {
    menu?.remove();
    const c = p.colors[i];
    const act = (label: string, fn: () => void, cls = 'chip') => h('button', { class: cls, onClick: () => { fn(); saved(H, p); } }, label);
    menu = h('div', { class: 'palmenu chips' },
      h('span', { class: 'sw solo', style: `background:${c.hex}` }), h('span', { class: 'muted small' }, c.name || c.hex),
      act('Set to current', () => { p.colors[i] = { hex: rgbHex(...H.colour()) }; }),
      i > 0 ? act('◀', () => { [p.colors[i - 1], p.colors[i]] = [p.colors[i], p.colors[i - 1]]; }) : null,
      i < p.colors.length - 1 ? act('▶', () => { [p.colors[i + 1], p.colors[i]] = [p.colors[i], p.colors[i + 1]]; }) : null,
      act('Delete', () => { p.colors.splice(i, 1); }, 'chip danger'));
    at.closest('.palsec')?.append(menu);
  };
  wrap.append(head, grid);
  return wrap;
}

function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((res) => {
    const inp = h('input', { type: 'file', accept, multiple }) as HTMLInputElement;
    inp.onchange = () => res([...(inp.files || [])]);
    inp.click();
  });
}
const fileBase = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '').trim() || 'palette';

/** image (or the artwork) → palette, with a count slider and live re-extraction */
async function fromPixels(H: PaletteHost, src: Promise<{ px: Uint8ClampedArray; w: number; h: number }>, name: string, done: () => void) {
  let img: { px: Uint8ClampedArray; w: number; h: number };
  try { img = await src; } catch (err) { H.toast('Could not read the image: ' + (err as Error).message); return; }
  const s = H.sheet('New palette from ' + name);
  let count = 10, sw: Swatch[] = [];
  const strip = h('div', { class: 'swatches pal big' });
  const lbl = h('b', {}, '10');
  const run = () => { sw = extractPalette(img.px, img.w, img.h, { count }); strip.innerHTML = ''; for (const c of sw) strip.append(h('span', { class: 'sw', style: `background:${c.hex}`, title: c.hex })); lbl.textContent = String(sw.length); };
  const r = h('input', { type: 'range', min: 3, max: 30, value: count, 'aria-label': 'Colours' }) as HTMLInputElement;
  r.oninput = () => { count = +r.value; run(); };
  s.body.append(h('label', { class: 'edge-row' }, h('span', { class: 'muted' }, 'Colours'), r, lbl), strip,
    h('p', { class: 'muted small' }, 'Real colours from the picture, chosen so small accents get a swatch too. Near-identical colours are merged.'),
    h('div', { class: 'dlg-acts' }, h('button', { class: 'btn', onClick: () => { H.lib.add({ id: newId(), name, colors: sw }); s.close(); done(); H.toast('Palette added · ' + sw.length + ' colours'); } }, 'Add palette')));
  run();
}
export async function imagePixels(f: Blob, max = 256): Promise<{ px: Uint8ClampedArray; w: number; h: number }> {
  const bmp = await createImageBitmap(f);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * k)), hh = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, hh), g = c.getContext('2d')!; g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, hh); bmp.close();
  return { px: g.getImageData(0, 0, w, hh).data, w, h: hh };
}

/** the Palettes sheet: choose, create, import, export, rename, duplicate, attach to the artwork, delete */
export function openPalettes(H: PaletteHost) {
  const s = H.sheet('Palettes');
  const render = () => {
    s.body.innerHTML = '';
    const top = h('div', { class: 'chips' },
      h('button', { class: 'chip', onClick: () => { H.lib.add({ id: newId(), name: 'Palette ' + (H.lib.list.length + 1), colors: [{ hex: rgbHex(...H.colour()) }] }); render(); H.refresh(); } }, '+ New'),
      h('button', { class: 'chip', onClick: async () => { const [f] = await pickFile('image/*'); if (f) await fromPixels(H, imagePixels(f), f.name.replace(/\.[^.]+$/, '').slice(0, 30) || 'Photo', () => { render(); H.refresh(); }); } }, 'From photo…'),
      h('button', { class: 'chip', onClick: () => fromPixels(H, H.canvasPixels(), 'artwork', () => { render(); H.refresh(); }) }, 'From artwork'),
      h('button', { class: 'chip', onClick: async () => {
        const fs = await pickFile('.ase,.gpl,.hex,.txt,application/octet-stream,text/plain', true); let n = 0;
        for (const f of fs) { try { for (const p of await parsePaletteFile(f)) { H.lib.add(p); n++; } } catch (err) { H.toast(f.name + ': ' + (err as Error).message); } }
        if (n) { H.toast(`Imported ${n} palette${n > 1 ? 's' : ''}`); render(); H.refresh(); }
      } }, 'Import .ase / .gpl / .hex'));
    s.body.append(top);
    const d = H.doc();
    const rows: Palette[] = d ? [d, ...H.lib.list] : H.lib.list;
    const act = activePalette(H);
    for (const p of rows) {
      const doc = p === d;
      const strip = h('div', { class: 'palstrip' }, ...p.colors.slice(0, 40).map((c) => h('span', { style: `background:${c.hex}` })));
      const btn = (label: string, fn: () => void, cls = 'chip small') => h('button', { class: cls, onClick: (ev: Event) => { ev.stopPropagation(); fn(); } }, label);
      const row = h('div', { class: 'palrow' + (p === act ? ' on' : ''), onClick: () => { H.lib.activeId = doc ? DOC : p.id; H.lib.save(); render(); H.refresh(); } },
        h('div', { class: 'palrow-head' }, h('b', {}, p.name), h('span', { class: 'muted small' }, (doc ? 'This artwork · ' : '') + p.colors.length + ' colours' + (p === act ? ' · in use' : ''))),
        strip,
        h('div', { class: 'chips' },
          btn('Rename', () => { const n = prompt('Palette name', p.name); if (n && n.trim()) { p.name = n.trim().slice(0, 60); saved(H, p); render(); } }),
          btn('Duplicate', () => { H.lib.add({ id: newId(), name: p.name + ' copy', colors: p.colors.map((c) => ({ ...c })) }, false); render(); }),
          btn('.ase', () => H.download(new Blob([toASE(p) as BlobPart], { type: 'application/octet-stream' }), fileBase(p.name) + '.ase', 'application/octet-stream')),
          btn('.gpl', () => H.download(new Blob([toGPL(p)], { type: 'text/plain' }), fileBase(p.name) + '.gpl', 'text/plain')),
          doc ? btn('Detach from artwork', () => { H.setDoc(null); if (H.lib.activeId === DOC) H.lib.activeId = H.lib.list[0].id; H.lib.save(); render(); H.refresh(); })
            : btn('Keep with artwork', () => { H.setDoc({ id: newId(), name: p.name, colors: p.colors.map((c) => ({ ...c })) }); H.lib.activeId = DOC; H.lib.save(); render(); H.refresh(); H.toast('Saved with this artwork (and its .gesso file)'); }),
          !doc && H.lib.list.length > 1 ? btn('Delete', () => { if (confirm(`Delete palette “${p.name}”?`)) { H.lib.remove(p.id); render(); H.refresh(); } }, 'chip small danger') : null));
      s.body.append(row);
    }
  };
  render();
}

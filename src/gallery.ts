// Gallery screen: every artwork as a card. Tap opens; the ⋯ button renames, duplicates, exports or deletes.
import { store, DocMeta } from './store';

export interface GalleryHooks {
  open(id: string): void;
  newCanvas(): void;
  importFile(): void;
  exportFile(id: string): void;
  duplicate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  currentId(): string | null;
  close(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: (Node | string)[]) => {
  const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e;
};
const fmtBytes = (n: number) => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? Math.round(n / 1e6) + ' MB' : Math.round(n / 1e3) + ' KB';
function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: s > 3e7 ? 'numeric' : undefined });
}

/** small modal used for rename/delete confirmation (no blocking browser dialogs) */
export function ask(title: string, opts: { input?: string; okLabel?: string; danger?: boolean; body?: string }): Promise<string | null> {
  return new Promise((res) => {
    const wrap = el('div', 'sheet-wrap');
    const box = el('div', 'dialog');
    const inp = opts.input !== undefined ? Object.assign(el('input', 'dlg-in'), { value: opts.input, maxLength: 60 }) as HTMLInputElement : null;
    const done = (v: string | null) => { wrap.remove(); res(v); };
    const ok = el('button', 'btn' + (opts.danger ? ' danger' : ''), opts.okLabel || 'OK');
    const cancel = el('button', 'btn ghost', 'Cancel');
    ok.onclick = () => done(inp ? inp.value.trim() : 'ok');
    cancel.onclick = () => done(null);
    wrap.onclick = (e) => { if (e.target === wrap) done(null); };
    if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') ok.click(); if (e.key === 'Escape') cancel.click(); };
    box.append(el('b', '', title), ...(opts.body ? [el('p', 'muted', opts.body)] : []), ...(inp ? [inp] : []), el('div', 'dlg-acts', cancel, ok));
    wrap.append(box);
    document.body.append(wrap);
    inp?.focus(); inp?.select();
  });
}

export class Gallery {
  root: HTMLElement;
  private grid: HTMLElement;
  private urls: string[] = [];
  private foot: HTMLElement;
  constructor(private hooks: GalleryHooks) {
    this.root = el('div', 'gallery');
    const head = el('div', 'g-head');
    const title = el('div', 'g-title', el('span', 'logo'), el('b', '', 'Gallery'));
    const acts = el('div', 'g-acts');
    const imp = el('button', 'btn ghost', 'Import');
    imp.onclick = () => this.hooks.importFile();
    const nw = el('button', 'btn', '+ New canvas');
    nw.onclick = () => this.hooks.newCanvas();
    acts.append(imp, nw);
    if (this.hooks.currentId()) {
      const back = el('button', 'btn ghost', 'Back to canvas');
      back.onclick = () => this.hooks.close();
      acts.prepend(back);
    }
    head.append(title, acts);
    this.grid = el('div', 'g-grid');
    this.foot = el('div', 'g-foot muted');
    this.root.append(head, this.grid, this.foot);
    document.body.append(this.root);
    void this.render();
  }

  close() { this.root.remove(); this.urls.forEach((u) => URL.revokeObjectURL(u)); }

  async render() {
    const docs = await store.list();
    this.urls.forEach((u) => URL.revokeObjectURL(u)); this.urls = [];
    this.grid.innerHTML = '';
    if (!docs.length) {
      const empty = el('div', 'g-empty', el('b', '', 'No artwork yet'), el('p', 'muted', 'Start a new canvas — everything you paint is saved on this device automatically.'));
      this.grid.append(empty);
    }
    for (const d of docs) this.grid.append(await this.card(d));
    const u = await store.usage();
    this.foot.textContent = `${docs.length} artwork${docs.length === 1 ? '' : 's'}` + (u ? ` · ${fmtBytes(u.used)} used on this device${u.persisted ? ' · protected from automatic clean-up' : ''}` : '');
  }

  private async card(d: DocMeta) {
    const c = el('div', 'g-card' + (d.id === this.hooks.currentId() ? ' cur' : ''));
    c.dataset.id = d.id;
    const pic = el('button', 'g-pic');
    pic.setAttribute('aria-label', 'Open ' + d.name);
    const th = await store.getThumb(d.id);
    if (th) {
      const u = URL.createObjectURL(th); this.urls.push(u);
      const img = el('img'); img.src = u; img.alt = ''; img.draggable = false;
      if (!d.bgVisible) img.classList.add('transparent');
      pic.append(img);
    }
    pic.onclick = () => this.hooks.open(d.id);
    const more = el('button', 'ib small g-more', '⋯');
    more.setAttribute('aria-label', 'More actions');
    more.onclick = (e) => { e.stopPropagation(); this.menu(d, more); };
    const meta = el('div', 'g-meta', el('div', 'g-name', d.name), el('div', 'muted', `${d.w} × ${d.h} · ${d.layers.length} layer${d.layers.length === 1 ? '' : 's'} · ${ago(d.modified)}`));
    c.append(pic, el('div', 'g-row', meta, more));
    return c;
  }

  private menu(d: DocMeta, anchor: HTMLElement) {
    document.querySelector('.g-menu')?.remove();
    const m = el('div', 'g-menu');
    const item = (label: string, fn: () => void, danger = false) => {
      const b = el('button', 'mitem' + (danger ? ' danger' : ''), label);
      b.onclick = () => { m.remove(); fn(); };
      m.append(b);
    };
    item('Rename', async () => { const n = await ask('Rename artwork', { input: d.name, okLabel: 'Rename' }); if (n) { await this.hooks.rename(d.id, n); void this.render(); } });
    item('Duplicate', async () => { await this.hooks.duplicate(d.id); void this.render(); });
    item('Export .gesso file', () => this.hooks.exportFile(d.id));
    item('Delete', async () => {
      const ok = await ask(`Delete “${d.name}”?`, { body: 'This removes it from this device. It cannot be undone.', okLabel: 'Delete', danger: true });
      if (ok) { await this.hooks.remove(d.id); void this.render(); }
    }, true);
    const r = anchor.getBoundingClientRect();
    m.style.top = Math.min(innerHeight - 230, r.bottom + 4) + 'px';
    m.style.left = Math.max(8, Math.min(innerWidth - 228, r.right - 220)) + 'px';
    document.body.append(m);
    setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!m.contains(e.target as Node)) { m.remove(); document.removeEventListener('pointerdown', off, true); } }, true));
  }
}

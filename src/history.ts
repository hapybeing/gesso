export interface Entry {
  label: string;
  bytes: number;
  undo(): void;
  redo(): void;
  /** called when the entry is dropped; done = whether its effect is currently applied */
  dispose?(done: boolean): void;
}

export class History {
  private list: Entry[] = [];
  private idx = 0; // number of applied entries
  maxBytes = 512 * 1024 * 1024;
  maxSteps = 120;
  onChange: () => void = () => {};
  /** the entry most recently pushed, undone or redone (null after clear) */
  lastTouched: Entry | null = null;

  private group: Entry[] | null = null;
  /** collect the following pushes into one undo step */
  beginGroup() { this.group = []; }
  endGroup(label: string) {
    const g = this.group; this.group = null;
    if (!g || !g.length) return;
    if (g.length === 1) { this.push({ ...g[0], label }); return; }
    this.push({
      label, bytes: g.reduce((s, e) => s + e.bytes, 0),
      undo: () => { for (let i = g.length - 1; i >= 0; i--) g[i].undo(); },
      redo: () => { for (const e of g) e.redo(); },
      dispose: (done) => { for (const e of g) e.dispose?.(done); },
    });
  }

  push(e: Entry) {
    if (this.group) { this.group.push(e); return; }
    // drop redo branch
    for (const x of this.list.splice(this.idx)) x.dispose?.(false);
    this.list.push(e);
    this.lastTouched = e;
    this.idx = this.list.length;
    this.trim();
    this.onChange();
  }
  private trim() {
    let total = this.list.reduce((s, e) => s + e.bytes, 0);
    while (this.list.length > 1 && (total > this.maxBytes || this.list.length > this.maxSteps)) {
      const e = this.list.shift()!;
      this.idx--;
      total -= e.bytes;
      e.dispose?.(true);
    }
  }
  get canUndo() { return this.idx > 0; }
  get canRedo() { return this.idx < this.list.length; }
  undo(): string | null {
    if (!this.canUndo) return null;
    const e = this.list[--this.idx];
    this.lastTouched = e;
    e.undo(); this.onChange();
    return e.label;
  }
  redo(): string | null {
    if (!this.canRedo) return null;
    const e = this.list[this.idx++];
    this.lastTouched = e;
    e.redo(); this.onChange();
    return e.label;
  }
  clear() {
    this.list.forEach((e, i) => e.dispose?.(i < this.idx));
    this.list = []; this.idx = 0; this.lastTouched = null; this.onChange();
  }
}

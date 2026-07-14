/** Binary min-heap. Generic over the payload; ordering supplied by the caller. */
export class Heap<T> {
  private items: T[] = [];

  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    this.items.push(item);
    this.up(this.items.length - 1);
  }

  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      this.down(0);
    }
    return top;
  }

  /** Rebuild after external mutation of ordering keys. O(n). */
  rebuild(): void {
    for (let i = (this.items.length >> 1) - 1; i >= 0; i--) this.down(i);
  }

  toArray(): readonly T[] {
    return this.items;
  }

  private up(i: number): void {
    const items = this.items;
    const item = items[i]!;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(item, items[parent]!)) break;
      items[i] = items[parent]!;
      i = parent;
    }
    items[i] = item;
  }

  private down(i: number): void {
    const items = this.items;
    const n = items.length;
    const item = items[i]!;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const child = r < n && this.less(items[r]!, items[l]!) ? r : l;
      if (!this.less(items[child]!, item)) break;
      items[i] = items[child]!;
      i = child;
    }
    items[i] = item;
  }
}

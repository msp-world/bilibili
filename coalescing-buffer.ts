export interface CoalescingGroup<T> {
  key: string;
  items: readonly T[];
}

interface PendingGroup<T> {
  key: string;
  items: T[];
}

export class CoalescingBuffer<T> {
  private readonly emit: (groups: readonly CoalescingGroup<T>[]) => void;
  private groups: PendingGroup<T>[] = [];
  private sameKeyGroups = new Map<string, PendingGroup<T>>();
  private runGroups = new Map<string, PendingGroup<T>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingItems = 0;
  private inputs = 0;
  private outputs = 0;
  private flushes = 0;

  constructor(emit: (groups: readonly CoalescingGroup<T>[]) => void) {
    this.emit = emit;
  }

  add(
    key: string,
    item: T,
    opts: {
      windowMs: number;
      maxItems: number;
      runScope?: string;
    },
  ): void {
    const first = this.pendingItems === 0;
    let group: PendingGroup<T> | undefined;
    if (opts.runScope) {
      const active = this.runGroups.get(opts.runScope);
      if (active?.key === key) group = active;
      else {
        group = { key, items: [] };
        this.groups.push(group);
        this.runGroups.set(opts.runScope, group);
      }
    } else {
      group = this.sameKeyGroups.get(key);
      if (!group) {
        group = { key, items: [] };
        this.groups.push(group);
        this.sameKeyGroups.set(key, group);
      }
    }
    group.items.push(item);
    this.pendingItems += 1;
    this.inputs += 1;

    if (this.pendingItems >= opts.maxItems) {
      this.flush();
      return;
    }
    if (!first) return;
    if (opts.windowMs === 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => this.flush(), opts.windowMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.pendingItems === 0) return;
    if (this.timer) clearTimeout(this.timer);
    const groups = this.groups;
    const outputCount = groups.length;
    this.groups = [];
    this.sameKeyGroups = new Map();
    this.runGroups = new Map();
    this.timer = null;
    this.pendingItems = 0;
    this.outputs += outputCount;
    this.flushes += 1;
    this.emit(groups);
  }

  breakRun(scope: string): void {
    this.runGroups.delete(scope);
  }

  stats(): { inputs: number; outputs: number; flushes: number; pendingItems: number } {
    return {
      inputs: this.inputs,
      outputs: this.outputs,
      flushes: this.flushes,
      pendingItems: this.pendingItems,
    };
  }
}

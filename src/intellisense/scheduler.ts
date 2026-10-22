interface Running<T> {
  item: T;
  controller: AbortController;
}

/**
 * A pool of workers over a queue: at most `workers` runs at once, prioritized ids first. `pause` aborts what runs and
 * puts it back at the front (a build takes the machine); `cancel` aborts and forgets everything (a new pass).
 * A run that throws does not stop the others; the run itself reports its failure.
 */
export class Scheduler<T> {
  private queue: T[] = [];
  private readonly running = new Map<string, Running<T>>();
  private paused = false;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly workers: number,
    private readonly run: (item: T, signal: AbortSignal) => Promise<void>,
    private readonly id: (item: T) => string,
  ) {}

  private has(id: string): boolean {
    return this.running.has(id) || this.queue.some(q => this.id(q) === id);
  }

  enqueue(items: T[]): void {
    for (const item of items) if (!this.has(this.id(item))) this.queue.push(item);
    this.pump();
  }

  /** Moves the queued items with these ids to the front, in the given order. */
  prioritize(ids: string[]): void {
    const first = ids.flatMap(id => this.queue.filter(q => this.id(q) === id));
    if (first.length === 0) return;
    this.queue = [...first, ...this.queue.filter(q => !first.includes(q))];
  }

  /**
   * Runs these items again, first: a running one is aborted (its inputs may have changed under it), a queued one moves
   * to the front, others are queued at the front.
   */
  restart(items: T[]): void {
    const ids = items.map(this.id);
    const aborted = ids.flatMap(id => {
      const running = this.running.get(id);
      if (running) this.running.delete(id);
      return running ? [running] : [];
    });
    this.queue = [...items, ...this.queue.filter(q => !ids.includes(this.id(q)))];
    for (const r of aborted) r.controller.abort();
    this.pump();
  }

  pause(): void {
    this.paused = true;
    const aborted = [...this.running.values()];
    this.running.clear();
    this.queue = [...aborted.map(r => r.item), ...this.queue];
    for (const r of aborted) r.controller.abort();
  }

  resume(): void {
    this.paused = false;
    this.pump();
  }

  cancel(): void {
    const aborted = [...this.running.values()];
    this.running.clear();
    this.queue = [];
    for (const r of aborted) r.controller.abort();
    this.settle();
  }

  /** The ids of the items running now. */
  get active(): string[] {
    return [...this.running.keys()];
  }

  /** Resolves when nothing is queued or running (at once if that is so now). */
  get idle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }

  private settle(): void {
    if (this.queue.length > 0 || this.running.size > 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private pump(): void {
    while (!this.paused && this.running.size < this.workers && this.queue.length > 0) {
      const item = this.queue.shift()!;
      const entry: Running<T> = { item, controller: new AbortController() };
      const id = this.id(item);
      this.running.set(id, entry);
      const done = () => {
        // A paused or cancelled run was already taken out (and maybe requeued); its end changes nothing.
        if (this.running.get(id) !== entry) return;
        this.running.delete(id);
        this.pump();
        this.settle();
      };
      // Through a promise, so a run that throws at once counts as finished too.
      Promise.resolve()
        .then(() => this.run(item, entry.controller.signal))
        .then(done, done);
    }
    this.settle();
  }
}

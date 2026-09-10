export class ProcessingQueue {
  private readonly pending: Array<{ id: string; task: () => Promise<void> }> = [];
  private readonly known = new Set<string>();
  private active = 0;

  constructor(private readonly concurrency: number) {}

  enqueue(id: string, task: () => Promise<void>): boolean {
    if (this.known.has(id)) return false;
    this.known.add(id);
    this.pending.push({ id, task });
    this.drain();
    return true;
  }

  get size(): number { return this.pending.length + this.active; }

  private drain(): void {
    while (this.active < this.concurrency) {
      const item = this.pending.shift();
      if (!item) return;
      this.active++;
      void item.task().catch(() => undefined).finally(() => {
        this.active--;
        this.known.delete(item.id);
        this.drain();
      });
    }
  }
}

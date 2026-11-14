/**
 * One at a time, a pause between: the hub's restarts of accounts after a gap (remote.ts). A manager that went without
 * handing over gives every account a gap at once (dither-accounts docs/supervisor.md); restarting them all together
 * would relaunch every browser and reconnect every network at the same moment, the pattern the manager's adoption is
 * there to avoid. An account already waiting, or being restarted, is not queued again.
 */
export class Stagger {
  private queue: string[] = [];
  private running = false;
  private now: string | null = null;
  private stopped = false;

  constructor(
    private run: (key: string) => Promise<unknown>,
    private pauseMs = 15_000,
    private sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  add(key: string) {
    if (this.stopped || this.queue.includes(key) || this.now === key) return;
    this.queue.push(key);
    void this.drain();
  }

  get waiting(): readonly string[] {
    return this.queue;
  }

  stop() {
    this.stopped = true;
    this.queue = [];
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      let first = true;
      while (this.queue.length && !this.stopped) {
        if (!first) await this.sleep(this.pauseMs);
        first = false;
        const key = this.queue.shift();
        if (key === undefined || this.stopped) break;
        this.now = key;
        try {
          await this.run(key);
        } catch {
        } finally {
          this.now = null;
        }
      }
    } finally {
      this.running = false;
    }
  }
}

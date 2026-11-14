/**
 * The hub's restarts of accounts after a gap (remote.ts), one at a time per group (the account's kind: its network),
 * a pause between; different groups side by side. A manager that went without handing over gives every account a gap
 * at once (dither-accounts docs/supervisor.md); restarting them all together, or two of one network together, would
 * relaunch browsers and reconnect a network the way the manager's adoption is there to avoid. An account already
 * waiting, or being restarted, is not queued again.
 */
export class Stagger {
  private queues = new Map<string, string[]>();
  /** The job under way in each group. */
  private busy = new Map<string, string>();
  /** Groups whose loop runs, pauses included: one loop per group, so never two jobs of a group at once. */
  private draining = new Set<string>();
  private stopped = false;

  constructor(
    private run: (key: string) => Promise<unknown>,
    private pauseMs = 5000,
    private sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  add(key: string, group = '') {
    if (this.stopped || [...this.busy.values()].includes(key) || [...this.queues.values()].some((q) => q.includes(key))) return;
    const q = this.queues.get(group) ?? this.queues.set(group, []).get(group)!;
    q.push(key);
    if (!this.draining.has(group)) void this.drain(group);
  }

  /** Waiting or under way: what the hub's health reports, and the deployer waits for. */
  get size(): number {
    let n = this.busy.size;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  stop() {
    this.stopped = true;
    this.queues.clear();
  }

  private async drain(group: string) {
    this.draining.add(group);
    try {
      let first = true;
      for (;;) {
        const q = this.queues.get(group);
        if (!q?.length || this.stopped) break;
        if (!first) await this.sleep(this.pauseMs);
        first = false;
        const key = this.queues.get(group)?.shift();
        if (key === undefined || this.stopped) break;
        this.busy.set(group, key);
        try {
          await this.run(key);
        } catch {
        } finally {
          this.busy.delete(group);
        }
      }
    } finally {
      this.draining.delete(group);
    }
  }
}

/**
 * How long each part of the hub's start took, logged as one line once it answers requests (docs/deploy.md, "How long
 * a start takes"). Restarts have taken minutes to come up; the line says where that went. Nothing waits on it.
 */
export class StartupTrace {
  readonly phases: [string, number][] = [];
  /** performance.now() counts from the process's start, so the first phase is loading the code. */
  private last = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** The phase that ends now. */
  mark(name: string) {
    const t = this.now();
    this.phases.push([name, t - this.last]);
    this.last = t;
  }

  /** Phases timed elsewhere (the store's own steps), as they were: they end now. */
  add(phases: [string, number][]) {
    for (const p of phases) this.phases.push(p);
    this.last = this.now();
  }

  /** `startup: ready in 2.4 s (code 310 ms, db open 4 ms, ...)` */
  line(): string {
    const ms = (x: number) => `${Math.round(x)} ms`;
    return `startup: ready in ${(this.last / 1000).toFixed(1)} s (${this.phases.map(([n, x]) => `${n} ${ms(x)}`).join(', ')})`;
  }
}

/** Times each step of a sequence: `step('migrations')` ends the one before it. */
export function stepTimer(now: () => number = () => performance.now()) {
  const out: [string, number][] = [];
  let t = now();
  return {
    out,
    step(name: string) {
      const x = now();
      out.push([name, x - t]);
      t = x;
    },
  };
}

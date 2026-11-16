/**
 * One call tried again later, waiting longer each time: `first` ms, then doubling up to `most`. `later` (setTimeout)
 * and `cancel` (clearTimeout) are passed in by tests. Scheduling again while one is waiting replaces it.
 */
export class RetryLater {
  private wait: number;
  private timer: unknown;

  constructor(
    private readonly first: number,
    private readonly most: number,
    private readonly later: (f: () => void, ms: number) => unknown = setTimeout,
    private readonly cancel: (t: unknown) => void = (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  ) {
    this.wait = first;
  }

  /** Run `f` after the current wait, and wait twice as long next time. */
  schedule(f: () => void): void {
    this.cancel(this.timer);
    const ms = this.wait;
    this.wait = Math.min(this.wait * 2, this.most);
    this.timer = this.later(() => {
      this.timer = undefined;
      f();
    }, ms);
  }

  /** It worked: nothing waiting, and the next failure starts from `first` again. */
  reset(): void {
    this.cancel(this.timer);
    this.timer = undefined;
    this.wait = this.first;
  }
}

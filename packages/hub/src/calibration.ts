/**
 * How good a chance is (docs/inbox.md, "Needs a reply"): ranking (AUC), log loss, Brier score, and a reliability table
 * (predicted against what happened, in bins). Shared by the hub's daily calibration record (needsreply.ts) and the
 * backtest (scripts/needs-reply-backtest.ts). Numbers only.
 */

export interface Pred {
  /** The chance given, 0..1. */
  p: number;
  /** What happened. */
  y: boolean;
}

/** The chance a random yes is ranked above a random no (ties count half); NaN without both. */
export function auc(xs: readonly Pred[]): number {
  const sorted = [...xs].sort((a, b) => a.p - b.p);
  let sumPos = 0;
  let pos = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].p === sorted[i].p) j++;
    const mid = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (sorted[k].y) (sumPos += mid), pos++;
    i = j;
  }
  const neg = sorted.length - pos;
  return pos && neg ? (sumPos - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
}

const clip = (p: number) => Math.min(1 - 1e-3, Math.max(1e-3, p));

/** Mean negative log likelihood (nats); chances are clipped to 0.001..0.999. */
export function logLoss(xs: readonly Pred[]): number {
  return xs.reduce((a, x) => a - Math.log(x.y ? clip(x.p) : 1 - clip(x.p)), 0) / Math.max(1, xs.length);
}

/** Mean squared distance between the chance and what happened: 0 is perfect, 0.25 is a coin. */
export function brier(xs: readonly Pred[]): number {
  return xs.reduce((a, x) => a + (x.p - (x.y ? 1 : 0)) ** 2, 0) / Math.max(1, xs.length);
}

interface Bin {
  lo: number;
  hi: number;
  n: number;
  /** The mean chance given in the bin. */
  predicted: number;
  /** The share that happened. */
  actual: number;
}

/** Predictions in `bins` equal-width bins of the chance given: how many, the mean chance, and the share that happened. */
export function reliability(xs: readonly Pred[], bins = 10): Bin[] {
  const out: Bin[] = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, predicted: 0, actual: 0 }));
  for (const x of xs) {
    const b = out[Math.min(bins - 1, Math.max(0, Math.floor(x.p * bins)))];
    b.n++;
    b.predicted += x.p;
    b.actual += x.y ? 1 : 0;
  }
  for (const b of out) if (b.n) (b.predicted /= b.n), (b.actual /= b.n);
  return out;
}

/**
 * Events whose message the hub does not hold (docs/tracing.md, "Dropped targets"): a reaction, a pin, a delete, a poll
 * vote or a moderator's clear for a message id with no row, and a message replying to one. The hub has nothing to put
 * them on, so they are dropped; this counts them, per network and kind, and says so in the trace. A few are normal (a
 * reaction on a message older than what backfill fetched); many, or a sudden rise, mean the hub and the network disagree
 * about which id a message has (the Signal edit chains of 2026-11, whose reactions were all dropped like this).
 *
 * What is kept and traced is ids and counts only: never the message, the emoji or anything a person wrote.
 */
import { startSpan } from './trace.ts';

export type DroppedKind = 'reaction' | 'pin' | 'delete' | 'pollUpdate' | 'reactionsCleared' | 'replyTo';

interface DroppedCount {
  network: string;
  kind: DroppedKind;
  count: number;
  /** ms epoch of the latest. */
  lastAt: number;
}

/** At most one `dropped target` span per account and kind in this long; the ones between fold into the next one's count. */
export const DROPPED_TRACE_MS = 10_000;

export class DroppedTargets {
  private counts = new Map<string, DroppedCount>();
  /** Per account and kind: when its last span was written, and how many came since. */
  private traced = new Map<string, { at: number; since: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  note(acc: { id: string; network: string }, kind: DroppedKind) {
    const at = this.now();
    const key = `${acc.network}\0${kind}`;
    const c = this.counts.get(key) ?? this.counts.set(key, { network: acc.network, kind, count: 0, lastAt: at }).get(key)!;
    c.count++;
    c.lastAt = at;
    const tkey = `${acc.id}\0${kind}`;
    const t = this.traced.get(tkey);
    if (t && at - t.at < DROPPED_TRACE_MS) {
      t.since++;
      return;
    }
    const count = (t?.since ?? 0) + 1;
    this.traced.set(tkey, { at, since: 0 });
    startSpan('dropped target', { network: acc.network, account: acc.id, kind, count }).end();
  }

  /** Every (network, kind) with a drop since the hub started, the most first. */
  list(): DroppedCount[] {
    return [...this.counts.values()].map((c) => ({ ...c })).sort((a, b) => b.count - a.count || a.network.localeCompare(b.network) || a.kind.localeCompare(b.kind));
  }
}

/**
 * Typing, both ways (docs/typing.md). Nothing here touches the database or the journal: it is all of the moment.
 */
import { TYPING_MIN_GAP, TYPING_TTL } from '@dither-chat/protocol';

/**
 * Who is typing where, as far as the hub has been told. Clients expire a start by its TTL themselves; the hub keeps
 * this only to know whether a stop is news: a network's "stopped", or the typer's message arriving.
 */
export class TypingRelay {
  private active = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  start(conversationId: string, identityId: string, ttl: number) {
    if (this.active.size > 2000) this.prune();
    this.active.set(`${conversationId} ${identityId}`, this.now() + ttl);
  }

  /** True when they were still typing, so clients need telling. */
  stop(conversationId: string, identityId: string): boolean {
    const key = `${conversationId} ${identityId}`;
    const until = this.active.get(key);
    this.active.delete(key);
    return until !== undefined && until > this.now();
  }

  typing(conversationId: string, identityId: string): boolean {
    return (this.active.get(`${conversationId} ${identityId}`) ?? 0) > this.now();
  }

  private prune() {
    const now = this.now();
    for (const [k, until] of this.active) if (until <= now) this.active.delete(k);
  }
}

/** Bounds a start's TTL from an adapter: never under a second, never over a minute. */
export const typingTtl = (ttl: number | undefined) => Math.min(60_000, Math.max(1_000, ttl ?? TYPING_TTL));

/**
 * The hub's own guard on outgoing typing, whatever its clients do (two devices typing at once, an old client): at
 * most one start per account and conversation every TYPING_MIN_GAP, and a stop only after a start.
 */
export class TypingGate {
  private started = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  allow(accountId: string, conversationId: string, stop: boolean): boolean {
    const key = `${accountId} ${conversationId}`;
    const now = this.now();
    const last = this.started.get(key);
    if (stop) {
      this.started.delete(key);
      return last !== undefined && now - last < 3 * TYPING_TTL;
    }
    if (last !== undefined && now - last < TYPING_MIN_GAP) return false;
    if (this.started.size > 500) for (const [k, t] of this.started) if (now - t > 3 * TYPING_TTL) this.started.delete(k);
    this.started.set(key, now);
    return true;
  }
}

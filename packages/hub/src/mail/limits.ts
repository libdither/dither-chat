/**
 * Mail's numbers in one place (docs/mail-design.md §2.5, §3.3), so the slices that come later read the same ones.
 * The DITHER_MAIL_* variables override them.
 */
const env = (name: string, d: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const DAY = 86_400_000;

export const MAIL_LIMITS = {
  /**
   * How far back summaries are kept: this many days, plus all of Inbox; older mail is fetched when you scroll or
   * search (§14 Q2, decided). Slice 1 lists only the newest `firstSync` of Inbox and Sent; slice 2 backfills to this.
   */
  syncDays: env('DITHER_MAIL_SYNC_DAYS', 365),
  /** Summaries per account at most (slice 2). */
  maxPerAccount: env('DITHER_MAIL_MAX', 150_000),
  /** The body cache (slice 2). */
  cacheMb: env('DITHER_MAIL_CACHE_MB', 500),
  /** The search text (slice 7). */
  indexMb: env('DITHER_MAIL_INDEX_MB', 300),
  /** The first sync: Inbox's newest page, broadcast at once, then Inbox and Sent down to this many each. */
  firstPage: 50,
  firstSync: 500,
  /** A page of mail.list after the first. */
  page: 150,
  /** After access to an account ends, its mail stays this long, then goes (§14 Q6, decided). */
  goneMs: 24 * 3_600_000,
  /** Keep-up timers, insurance against a missed event (§3.4). */
  inboxEveryMs: 5 * 60_000,
  otherEveryMs: 15 * 60_000,
  /** The bootstrap's live window. */
  windowPerAccount: 50,
  windowMax: 300,
  /** How long a send waits for Undo before it goes (slice 5, §8). */
  holdMs: env('DITHER_MAIL_HOLD_MS', 10_000),
};

/** The oldest receivedAt slice 2 backfills to, from now. */
export const syncHorizon = (now = Date.now()) => now - MAIL_LIMITS.syncDays * DAY;

/**
 * Keeps every attachment's bytes. Media a network serves by a link that expires (Discord's signed CDN links last
 * about a day, WhatsApp's not much longer) is fetched into the media cache soon after its message arrives, live or
 * backfilled, so it can still be shown years later. The cache is kept indefinitely (housekeeping.ts), and it is
 * what server.ts serves the attachment from.
 *
 * Attachments are walked by rowid from a cursor kept in meta, so a restart carries on and the first run goes
 * through every attachment the hub already has. One fetch at a time; one that fails is tried again later, up to
 * three times, then left (media_archive_fail). A Discord link already past its expiry is marked 'expired' at once, and
 * then asked to be signed again through the account that saw it (Discord's attachments/refresh-urls, as its own client
 * does when it shows an old attachment), fifty at a time. The bytes from the new link are kept under the old link,
 * which is what the message keeps. A link Discord won't sign again is 'gone' (deleted on Discord).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.ts';

type Row = Record<string, any>;
const BATCH = 200;
const MAX_TRIES = 3;
const RETRY_MS = 6 * 3_600_000;
/** Links in one refresh-urls request, as Discord's client sends them. */
export const REFRESH_BATCH = 50;
/** After the account could not refresh (offline, an older extractor), wait this long before asking again. */
const REFRESH_PAUSE_MS = 10 * 60_000;

/** New links for old ones, keyed by the old link; empty when the account knows none. Throws when it can't ask. */
export type Refresh = (accountId: string, urls: string[]) => Promise<Map<string, string>>;

/** The part of a Discord link its signature leaves alone: where the file is. */
export const linkPath = (url: string) => {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
};

export class MediaArchiver {
  private timer?: Timer;
  private busy = false;
  stopped = false;
  /** Kept since start, for the log. */
  kept = 0;
  /** Kept from a link signed again, since start. */
  refreshed = 0;
  private refreshPausedUntil = 0;
  /** Accounts that could not refresh lately, until when. */
  private accountPausedUntil = new Map<string, number>();

  constructor(
    private store: Store,
    private cacheDir: string,
    /** Fetch one URL into the cache, as serving it would (from `from` when given); true when it is there afterwards. */
    private fetchOne: (url: string, accountId: string | null, from?: string) => Promise<boolean>,
    private log: (msg: string) => void = () => {},
    private refresh?: Refresh,
  ) {}

  start(everyMs = 60_000) {
    this.timer = setInterval(() => void this.tick(), everyMs);
    void this.tick();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private get cursor(): number {
    return Number((this.store.db.query(`SELECT value FROM meta WHERE key = 'media_archive_cursor'`).get() as Row | null)?.value ?? 0);
  }
  private set cursor(n: number) {
    this.store.db.query(`INSERT INTO meta (key, value) VALUES ('media_archive_cursor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(String(n));
  }

  /** A Discord CDN link whose signature ran out (the `ex` parameter, hex seconds). */
  static expired(url: string, now = Date.now()): boolean {
    try {
      const u = new URL(url);
      const ex = u.searchParams.get('ex');
      return /(^|\.)discord(app)?\.(com|net)$/.test(u.hostname) && !!ex && /^[0-9a-f]+$/i.test(ex) && parseInt(ex, 16) * 1000 < now;
    } catch {
      return false;
    }
  }

  /** Whether a URL is one the cache can hold: not a local file or inline data. */
  static remote(url: string): boolean {
    return !/^(file:|data:)/.test(url);
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (;;) {
        const rows = this.store.db
          .query(
            `SELECT a.rowid AS rid, a.url, (SELECT account_id FROM message_seen s WHERE s.message_id = a.message_id LIMIT 1) AS account
             FROM attachment a WHERE a.rowid > ? ORDER BY a.rowid LIMIT ?`,
          )
          .all(this.cursor, BATCH) as Row[];
        if (!rows.length) break;
        for (const r of rows) {
          if (this.stopped) return;
          if (MediaArchiver.remote(r.url)) await this.keep(r.url, r.account);
          this.cursor = r.rid;
        }
      }
      await this.retry();
      await this.refreshExpired();
    } catch (e: any) {
      this.log(`media archive: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  private async keep(url: string, account: string | null) {
    const key = new Bun.CryptoHasher('sha256').update(url).digest('hex');
    if (existsSync(join(this.cacheDir, key))) return;
    const fail = this.store.db.query('SELECT tries FROM media_archive_fail WHERE key = ?').get(key) as Row | null;
    if (fail) return; // retry() takes these
    let ok = false;
    let error: string | null = null;
    const markExpired = () =>
      this.store.db.query('INSERT INTO media_archive_fail (key, tries, last_at, error) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET tries = excluded.tries, last_at = excluded.last_at, error = excluded.error').run(key, MAX_TRIES, Date.now(), 'expired');
    // Signed again with others in a batch (refreshExpired), not one request each.
    if (this.refresh && MediaArchiver.expired(url)) return markExpired();
    try {
      ok = await this.fetchOne(url, account);
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 200);
    }
    if (ok) this.kept++;
    else if (MediaArchiver.expired(url))
      // A signed link past its expiry won't work on a retry; only a refreshed link could (error 'expired' marks them).
      markExpired();
    else this.store.db.query('INSERT INTO media_archive_fail (key, tries, last_at, error) VALUES (?, 1, ?, ?) ON CONFLICT (key) DO UPDATE SET tries = tries + 1, last_at = excluded.last_at, error = excluded.error').run(key, Date.now(), error);
  }

  /**
   * Expired Discord links, signed again through the account that saw them and fetched from the new link. A pass takes
   * a few batches; the next tick carries on.
   */
  async refreshExpired(maxBatches = 10): Promise<void> {
    if (!this.refresh || Date.now() < this.refreshPausedUntil) return;
    const want = new Set((this.store.db.query(`SELECT key FROM media_archive_fail WHERE error IS NULL OR error = 'expired'`).all() as Row[]).map((r) => r.key as string));
    if (!want.size) return;
    const now = Date.now();
    const paused = (a: string) => (this.accountPausedUntil.get(a) ?? 0) > now;
    const byAccount = new Map<string, { key: string; url: string }[]>();
    let n = 0;
    let waiting = 0;
    for (const r of this.store.db.query(`SELECT a.url, (SELECT group_concat(account_id, ' ') FROM message_seen s WHERE s.message_id = a.message_id) AS accounts FROM attachment a`).iterate() as Iterable<Row>) {
      if (!want.size || n >= maxBatches * REFRESH_BATCH) break;
      if (!r.accounts || !MediaArchiver.expired(r.url)) continue;
      const key = new Bun.CryptoHasher('sha256').update(r.url).digest('hex');
      if (!want.delete(key)) continue;
      // Any account that saw it can ask; one that couldn't lately waits.
      const account = (r.accounts as string).split(' ').find((a) => !paused(a));
      if (!account) {
        waiting++;
        continue;
      }
      const list = byAccount.get(account) ?? [];
      list.push({ key, url: r.url });
      byAccount.set(account, list);
      n++;
    }
    const mark = this.store.db.query('UPDATE media_archive_fail SET tries = ?, last_at = ?, error = ? WHERE key = ?');
    accounts: for (const [account, list] of byAccount) {
      for (let i = 0; i < list.length; i += REFRESH_BATCH) {
        if (this.stopped) return;
        const batch = list.slice(i, i + REFRESH_BATCH);
        let fresh: Map<string, string>;
        try {
          fresh = await this.refresh(account, batch.map((b) => b.url));
        } catch (e: any) {
          this.log(`media archive: refreshing links through ${account} failed (${e?.message ?? e}); trying again later`);
          this.accountPausedUntil.set(account, Date.now() + REFRESH_PAUSE_MS);
          continue accounts;
        }
        const byPath = new Map([...fresh].map(([o, f]) => [linkPath(o), f]));
        for (const b of batch) {
          if (this.stopped) return;
          const from = fresh.get(b.url) ?? byPath.get(linkPath(b.url));
          if (!from) {
            mark.run(MAX_TRIES, Date.now(), 'gone', b.key);
            continue;
          }
          let ok = false;
          try {
            ok = await this.fetchOne(b.url, account, from);
          } catch {}
          if (ok) {
            this.refreshed++;
            this.kept++;
            this.store.db.query('DELETE FROM media_archive_fail WHERE key = ?').run(b.key);
          } else mark.run(MAX_TRIES, Date.now(), 'refreshed, still failed', b.key);
        }
      }
    }
    if (n) this.log(`media archive: ${this.refreshed} kept from links signed again so far`);
    // Nothing to ask for now (none expired, or only through accounts that can't): look again in a while.
    else this.refreshPausedUntil = Date.now() + (waiting ? REFRESH_PAUSE_MS / 2 : REFRESH_PAUSE_MS);
  }

  /** Failures from a while ago, once more each, until they have had their tries. */
  private async retry() {
    const due = this.store.db.query('SELECT key FROM media_archive_fail WHERE tries < ? AND last_at < ? LIMIT 50').all(MAX_TRIES, Date.now() - RETRY_MS) as Row[];
    if (!due.length) return;
    const keys = new Set(due.map((d) => d.key as string));
    // Find their URLs again: a failure keeps only the key.
    for (const r of this.store.db.query(`SELECT a.url, (SELECT account_id FROM message_seen s WHERE s.message_id = a.message_id LIMIT 1) AS account FROM attachment a`).iterate() as Iterable<Row>) {
      if (!keys.size || this.stopped) break;
      if (!MediaArchiver.remote(r.url)) continue;
      const key = new Bun.CryptoHasher('sha256').update(r.url).digest('hex');
      if (!keys.delete(key)) continue;
      if (MediaArchiver.expired(r.url)) {
        this.store.db.query(`UPDATE media_archive_fail SET tries = ?, last_at = ?, error = 'expired' WHERE key = ?`).run(MAX_TRIES, Date.now(), key);
        continue;
      }
      let ok = false;
      try {
        ok = await this.fetchOne(r.url, r.account);
      } catch {}
      if (ok) {
        this.kept++;
        this.store.db.query('DELETE FROM media_archive_fail WHERE key = ?').run(key);
      } else this.store.db.query('UPDATE media_archive_fail SET tries = tries + 1, last_at = ? WHERE key = ?').run(Date.now(), key);
    }
  }
}

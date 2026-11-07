/**
 * Keeps every attachment's bytes. Media a network serves by a link that expires (Discord's signed CDN links last
 * about a day, WhatsApp's not much longer) is fetched into the media cache soon after its message arrives, live or
 * backfilled, so it can still be shown years later. The cache is kept indefinitely (housekeeping.ts), and it is
 * what server.ts serves the attachment from.
 *
 * Attachments are walked by rowid from a cursor kept in meta, so a restart carries on and the first run goes
 * through every attachment the hub already has. One fetch at a time; one that fails is tried again later, up to
 * three times, then left (media_archive_fail). A Discord link already past its expiry is left at once, marked
 * 'expired': only asking Discord to sign it again (attachments/refresh-urls, through the account) could bring it back.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.ts';

type Row = Record<string, any>;
const BATCH = 200;
const MAX_TRIES = 3;
const RETRY_MS = 6 * 3_600_000;

export class MediaArchiver {
  private timer?: Timer;
  private busy = false;
  stopped = false;
  /** Kept since start, for the log. */
  kept = 0;

  constructor(
    private store: Store,
    private cacheDir: string,
    /** Fetch one URL into the cache, as serving it would; true when it is there afterwards. */
    private fetchOne: (url: string, accountId: string | null) => Promise<boolean>,
    private log: (msg: string) => void = () => {},
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
    try {
      ok = await this.fetchOne(url, account);
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 200);
    }
    if (ok) this.kept++;
    else if (MediaArchiver.expired(url))
      // A signed link past its expiry won't work on a retry; only a refreshed link could (error 'expired' marks them).
      this.store.db.query('INSERT INTO media_archive_fail (key, tries, last_at, error) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET tries = excluded.tries, last_at = excluded.last_at, error = excluded.error').run(key, MAX_TRIES, Date.now(), 'expired');
    else this.store.db.query('INSERT INTO media_archive_fail (key, tries, last_at, error) VALUES (?, 1, ?, ?) ON CONFLICT (key) DO UPDATE SET tries = tries + 1, last_at = excluded.last_at, error = excluded.error').run(key, Date.now(), error);
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

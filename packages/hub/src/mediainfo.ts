/**
 * Looks at every kept file once (fileinfo.ts) and records what it is, so the app can show the true type, size, pages
 * or lines on a file's card and pick a viewer (docs/files.md).
 *
 * Attachments are walked by rowid from a cursor kept in meta, like the media archive (mediaarchive.ts), so a restart
 * carries on. On a hub that archives media the walk stays behind the archive's cursor, so a file is looked at once its
 * bytes are kept; a demo hub, which keeps nothing ahead of time, fetches its files (all local) first. One file at a
 * time with a pause between, at most a few seconds' work a tick. Inline media (data:) is left alone.
 *
 * What it found is keyed like the media cache, by the SHA-256 of the stored URL, so it follows the bytes: an edited
 * message's attachments are new rows with the same URLs. A newer sniffer (SNIFF_VERSION) starts the walk over.
 */
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { analyze, fileSource, SNIFF_VERSION } from './fileinfo.ts';
import { noteWork } from './stalls.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;
const BATCH = 200;
/** Work in one tick before it yields to the next. */
const TICK_MS = 4000;
/** Between two files. */
const PAUSE_MS = 5;
/** Messages newer than this get their new info sent to the apps that show them. */
const FRESH_MS = 2 * 86_400_000;

export const mediaKey = (url: string) => new Bun.CryptoHasher('sha256').update(url).digest('hex');

/** What the hub has found for these URLs, by URL. */
export function infoFor(db: Database, urls: string[]): Map<string, P.FileInfo> {
  const keyed = new Map<string, string>();
  for (const u of urls) if (u && !u.startsWith('data:') && !keyed.has(u)) keyed.set(u, mediaKey(u));
  const out = new Map<string, P.FileInfo>();
  if (!keyed.size) return out;
  const keys = [...new Set(keyed.values())];
  const rows = db.query(`SELECT * FROM media_info WHERE key IN (${keys.map(() => '?').join(',')})`).all(...keys) as Row[];
  const byKey = new Map(rows.map((r) => [r.key as string, view(r)]));
  for (const [u, k] of keyed) {
    const v = byKey.get(k);
    if (v) out.set(u, v);
  }
  return out;
}

function view(r: Row): P.FileInfo {
  const list = r.list ? (JSON.parse(r.list) as P.ArchiveEntry[]) : undefined;
  return {
    mime: r.mime,
    kind: r.kind,
    size: r.size,
    ...(r.pages != null ? { pages: r.pages } : {}),
    ...(r.encoding != null ? { encoding: r.encoding } : {}),
    ...(r.lines != null ? { lines: r.lines } : {}),
    ...(r.language != null ? { language: r.language } : {}),
    ...(r.entries != null ? { entries: r.entries } : {}),
    ...(list ? { list } : {}),
    ...(r.width != null ? { width: r.width } : {}),
    ...(r.height != null ? { height: r.height } : {}),
    ...(r.duration != null ? { duration: r.duration } : {}),
    ...(r.partial ? { partial: true } : {}),
  };
}

export class MediaInfo {
  private timer?: Timer;
  private busy = false;
  stopped = false;
  /** Files looked at since start, for the log and tests. */
  looked = 0;

  constructor(
    private store: Store,
    private dataDir: string,
    private opts: {
      /** Walk only as far as the media archive has got (a hub that archives). */
      behindArchive: boolean;
      /** Put a file's bytes in the cache when they aren't there (a demo hub): true when they are afterwards. */
      fetch?: (url: string, accountId: string | null) => Promise<boolean>;
      log?: (msg: string) => void;
    },
  ) {
    if (this.meta('media_info_version') !== String(SNIFF_VERSION)) {
      this.setMeta('media_info_cursor', '0');
      this.setMeta('media_info_version', String(SNIFF_VERSION));
    }
  }

  private get cacheDir() {
    return join(this.dataDir, 'media-cache');
  }
  private meta(k: string): string | null {
    return ((this.store.db.query(`SELECT value FROM meta WHERE key = ?`).get(k) as Row | null)?.value as string) ?? null;
  }
  private setMeta(k: string, v: string) {
    this.store.db.query(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(k, v);
  }

  start(everyMs = 30_000, firstAfterMs = 15_000) {
    this.timer = setInterval(() => void this.tick(), everyMs);
    setTimeout(() => void this.tick(), firstAfterMs);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /** Where the bytes behind a stored URL are on disk, if they are. */
  pathOf(url: string): string | null {
    if (url.startsWith('data:')) return null;
    if (url.startsWith('file://')) {
      const p = normalize(decodeURIComponent(url.slice('file://'.length)));
      const root = resolve(this.dataDir);
      return resolve(p).startsWith(root + '/') && existsSync(p) && statSync(p).isFile() ? p : null;
    }
    const p = join(this.cacheDir, mediaKey(url));
    return existsSync(p) ? p : null;
  }

  /**
   * Looks at one attachment's file now, if its bytes are here, and records it. `fetch`: put them here first if they
   * aren't (the app asked for this one). Null when there are no bytes to look at.
   */
  async lookAt(a: { url: string; name: string | null; mime: string | null; account: string | null }, fetch?: (url: string, accountId: string | null) => Promise<boolean>): Promise<P.FileInfo | null> {
    if (a.url.startsWith('data:')) return null;
    let path = this.pathOf(a.url);
    if (!path && fetch && !a.url.startsWith('file://')) {
      if (await fetch(a.url, a.account).catch(() => false)) path = this.pathOf(a.url);
    }
    if (!path) return null;
    const info = await analyze(fileSource(path), { name: a.name, mime: a.mime });
    this.save(mediaKey(a.url), info);
    this.looked++;
    return info;
  }

  private save(key: string, i: P.FileInfo) {
    this.store.db
      .query(
        `INSERT INTO media_info (key, mime, kind, size, pages, encoding, lines, language, entries, list, width, height, duration, partial, version, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET mime = excluded.mime, kind = excluded.kind, size = excluded.size, pages = excluded.pages, encoding = excluded.encoding,
           lines = excluded.lines, language = excluded.language, entries = excluded.entries, list = excluded.list, width = excluded.width, height = excluded.height,
           duration = excluded.duration, partial = excluded.partial, version = excluded.version, at = excluded.at`,
      )
      .run(key, i.mime, i.kind, i.size, i.pages ?? null, i.encoding ?? null, i.lines ?? null, i.language ?? null, i.entries ?? null, i.list ? JSON.stringify(i.list) : null, i.width ?? null, i.height ?? null, i.duration ?? null, i.partial ? 1 : 0, SNIFF_VERSION, Date.now());
  }

  private known(key: string): boolean {
    return !!this.store.db.query('SELECT 1 FROM media_info WHERE key = ? AND version = ?').get(key, SNIFF_VERSION);
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    noteWork('media info');
    const until = Date.now() + TICK_MS;
    try {
      for (;;) {
        const cursor = Number(this.meta('media_info_cursor') ?? 0);
        const limit = this.opts.behindArchive ? Number(this.meta('media_archive_cursor') ?? 0) : Number.MAX_SAFE_INTEGER;
        // Inline media is skipped in the query, so a hub full of it (a demo world) passes it in one quick range scan.
        const rows = this.store.db
          .query(`SELECT a.rowid AS rid, a.url, a.name, a.mime, a.message_id FROM attachment a WHERE a.rowid > ? AND a.rowid <= ? AND substr(a.url, 1, 5) != 'data:' ORDER BY a.rowid LIMIT ?`)
          .all(cursor, limit, BATCH) as Row[];
        if (!rows.length) {
          // Only inline media (or nothing) is left: the cursor goes past it.
          const last = Number((this.store.db.query('SELECT MAX(rowid) AS m FROM attachment WHERE rowid <= ?').get(limit) as Row | null)?.m ?? 0);
          if (last > cursor) this.setMeta('media_info_cursor', String(last));
          break;
        }
        // The cursor is written after each file looked at and at the end of the batch, not for every row passed.
        let at = cursor;
        try {
          for (const r of rows) {
            if (this.stopped || Date.now() > until) return;
            if (!this.known(mediaKey(r.url))) {
              try {
                const account = this.opts.fetch ? ((this.store.db.query('SELECT account_id FROM message_seen WHERE message_id = ? LIMIT 1').get(r.message_id) as Row | null)?.account_id ?? null) : null;
                const info = await this.lookAt({ url: r.url, name: r.name, mime: r.mime, account }, this.opts.fetch);
                // A recent message's card shows it straight away; older ones get it when next loaded.
                const m = info && (this.store.db.query('SELECT ts FROM message WHERE id = ?').get(r.message_id) as Row | null);
                if (m && m.ts > Date.now() - FRESH_MS) this.store.dirty.messages.set(r.message_id, this.store.dirty.messages.get(r.message_id) ?? false);
              } catch (e: any) {
                this.opts.log?.(`media info: ${e?.message ?? e}`);
              }
              this.setMeta('media_info_cursor', String((at = r.rid)));
              await Bun.sleep(PAUSE_MS);
            }
            at = r.rid;
          }
        } finally {
          if (at !== cursor) this.setMeta('media_info_cursor', String(at));
        }
        // Between batches, the hub answers whatever came in meanwhile.
        await Bun.sleep(PAUSE_MS);
      }
    } catch (e: any) {
      this.opts.log?.(`media info: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * A file the archive just kept (mediaarchive.ts): looked at now rather than when the walk gets to it, and a recent
   * message's card shows it straight away.
   */
  async kept(a: { url: string; name: string | null; mime: string | null; messageId: string }) {
    if (this.stopped || a.url.startsWith('data:') || this.known(mediaKey(a.url))) return;
    try {
      const info = await this.lookAt({ ...a, account: null });
      const m = info && (this.store.db.query('SELECT ts FROM message WHERE id = ?').get(a.messageId) as Row | null);
      if (m && m.ts > Date.now() - FRESH_MS) this.store.dirty.messages.set(a.messageId, this.store.dirty.messages.get(a.messageId) ?? false);
    } catch (e: any) {
      this.opts.log?.(`media info: ${e?.message ?? e}`);
    }
  }
}

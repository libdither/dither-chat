/**
 * Runs an import of one source (docs/import.md): read it into cached facts in a worker, then apply them through
 * Store.importBatch a slice at a time, yielding between slices so the hub keeps answering. A dry run does the same
 * and writes nothing. One run at a time, whole hub.
 *
 * Facts are cached at <data>/imports/work/<sourceId>/<reader>/facts.ndjson, keyed by the source's sha256 and the
 * account's own id (manifest.json); a new reader version or a changed source reads again.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { Store } from '../store.ts';
import { DCE_HTML_READER } from './discord-html.ts';
import type { ReadStats } from './read-worker.ts';
import type { ImportSources } from './sources.ts';

const SLICE = 150;
const READERS: Partial<Record<P.ImportSourceKind, string>> = { 'dce-html': DCE_HTML_READER };

export const importable = (kind: P.ImportSourceKind) => kind in READERS;

const zero = (): P.ImportCounts => ({ conversations: 0, conversationsNew: 0, messages: 0, new: 0, same: 0, filled: 0, conflicts: 0, duplicates: 0 });
const add = (a: P.ImportCounts, b: P.ImportCounts) => {
  for (const k of Object.keys(a) as (keyof P.ImportCounts)[]) a[k] += b[k];
};

export class ImportRunner {
  private current: { sourceId: string; stop: boolean } | null = null;

  constructor(
    private store: Store,
    private sources: ImportSources,
    private dataDir: string,
    private log: (msg: string) => void = () => {},
  ) {}

  get busy(): string | null {
    return this.current?.sourceId ?? null;
  }

  stop() {
    if (this.current) this.current.stop = true;
  }

  /** Start an import (or a dry run) of a ready source. Resolves when it has started; progress is in the source's view. */
  start(sourceId: string, o: { dryRun: boolean }): P.ImportSourceView {
    if (this.current) throw Object.assign(new Error('another import is running'), { status: 409 });
    const v = this.sources.view(sourceId);
    if (!v) throw Object.assign(new Error('no such source'), { status: 404 });
    if (v.status !== 'ready' || !v.sha256) throw Object.assign(new Error('the source is not ready'), { status: 409 });
    if (!READERS[v.kind]) throw new Error(`${v.kind} sources can't be imported yet`);
    if (!v.accountId) throw new Error('say which account this history belongs to first');
    const acc = this.store.account(v.accountId);
    if (!acc) throw new Error('that account is gone');
    if (acc.network !== v.network) throw new Error(`this is ${v.network} history, and that is a ${acc.network} account`);
    const self = acc.self_identity ? ((this.store.db.query('SELECT native_id FROM identity WHERE id = ?').get(acc.self_identity) as { native_id: string } | null)?.native_id ?? null) : null;
    if (!self) throw new Error('the account has not said who it is yet; wait until it is online');

    const runId = `imp_${randomBytes(8).toString('hex')}`;
    const run: P.ImportRunView = { id: runId, dryRun: o.dryRun, stage: 'reading', progress: 0, counts: null, startedAt: Date.now(), finishedAt: null, error: null };
    this.current = { sourceId, stop: false };
    this.sources.setRun(sourceId, run);
    this.store.db
      .query('INSERT INTO import_run (id, source_id, source_sha, account_id, reader, dry_run, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, sourceId, v.sha256, acc.id, READERS[v.kind]!, o.dryRun ? 1 : 0, run.startedAt, 'running');
    void this.go(sourceId, v, acc.id, self, run).finally(() => (this.current = null));
    return this.sources.view(sourceId)!;
  }

  private async go(sourceId: string, v: P.ImportSourceView, accountId: string, self: string, run: P.ImportRunView) {
    const finish = (patch: Partial<P.ImportRunView>, status: string) => {
      Object.assign(run, patch, { finishedAt: Date.now() });
      this.sources.setRun(sourceId, run);
      this.store.db.query('UPDATE import_run SET finished_at = ?, status = ?, counts = ?, error = ? WHERE id = ?').run(run.finishedAt, status, JSON.stringify(run.counts), run.error, run.id);
    };
    try {
      const facts = await this.read(sourceId, v, self, run);
      if (this.current?.stop) return finish({ stage: 'stopped' }, 'stopped');
      run.stage = 'applying';
      run.progress = 0;
      this.sources.setRun(sourceId, run);
      run.counts = await this.apply(facts.path, facts.stats, accountId, v.sha256!, run);
      if (this.current?.stop) return finish({ stage: 'stopped' }, 'stopped');
      finish({ stage: 'done', progress: 1 }, 'done');
    } catch (e: any) {
      this.log(`import ${sourceId}: ${e?.stack ?? e}`);
      finish({ stage: 'error', error: String(e?.message ?? e) }, 'error');
    }
  }

  /** Facts for this source and account, from the cache when it still matches. */
  private async read(sourceId: string, v: P.ImportSourceView, self: string, run: P.ImportRunView): Promise<{ path: string; stats: ReadStats }> {
    const reader = READERS[v.kind]!;
    const dir = join(this.dataDir, 'imports', 'work', sourceId, reader);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = join(dir, 'facts.ndjson');
    const manifestPath = join(dir, 'manifest.json');
    const want = { sourceSha: v.sha256, reader, self };
    if (existsSync(out) && existsSync(manifestPath)) {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (m.sourceSha === want.sourceSha && m.reader === want.reader && m.self === want.self) {
        run.files = m.stats.files;
        return { path: out, stats: m.stats };
      }
    }
    const rawDir = this.sources.rawDir(sourceId)!;
    const mediaDir = join(this.dataDir, 'imports', 'media');
    mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    const stats = await new Promise<ReadStats>((resolve, reject) => {
      const w = new Worker(new URL('./read-worker.ts', import.meta.url).href);
      w.onmessage = (e: MessageEvent<any>) => {
        if (typeof e.data.progress === 'number') {
          run.progress = e.data.progress;
          if (this.current?.stop) (w.terminate(), reject(new Error('stopped')));
        } else if (e.data.done) (w.terminate(), resolve(e.data.stats));
        else if (e.data.error) (w.terminate(), reject(new Error(e.data.error)));
      };
      w.onerror = (e) => (w.terminate(), reject(new Error(e.message || 'reader failed')));
      w.postMessage({ kind: v.kind, rawDir, selfId: self, mediaDir, out });
    });
    if (!stats.selfMessages) throw new Error('this account wrote nothing in this export: it looks like someone else’s history');
    run.files = stats.files;
    writeFileSync(manifestPath, JSON.stringify({ ...want, stats, at: Date.now() }, null, 2), { mode: 0o600 });
    return { path: out, stats };
  }

  private async apply(path: string, stats: ReadStats, accountId: string, sourceSha: string, run: P.ImportRunView): Promise<P.ImportCounts> {
    const acc = this.store.account(accountId)!;
    const total = zero();
    total.duplicates = stats.duplicates;
    let header: { conversation: P.ConversationFact; identities: P.IdentityFact[] } | null = null;
    let slice: P.MessageFact[] = [];
    let first = true;
    let done = 0;
    const flush = async () => {
      if (!header) return;
      if (!slice.length && !first) return;
      add(total, this.store.importBatch(acc, { conversation: header.conversation, identities: first ? header.identities : [], messages: slice }, { sourceSha, runId: run.id, dryRun: run.dryRun, archiveNew: true, first }));
      done += slice.length;
      first = false;
      slice = [];
      run.progress = stats.messages ? done / stats.messages : 1;
      run.counts = { ...total };
      // Room for everything else the hub does between slices.
      await Bun.sleep(1);
    };
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of Bun.file(path).stream()) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const lineText = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!lineText) continue;
        const x = JSON.parse(lineText);
        if (x.t === 'conversation') {
          await flush();
          header = { conversation: x.conversation, identities: x.identities };
          first = true;
        } else {
          slice.push(x.m);
          if (slice.length >= SLICE) await flush();
        }
        if (this.current?.stop) return total;
      }
    }
    await flush();
    return total;
  }
}

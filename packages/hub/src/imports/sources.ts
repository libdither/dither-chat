/**
 * Raw history sources (docs/import.md). Each is a directory under <data>/imports/sources/<id>/:
 *
 *   source.json   where it came from: network, kind, label, account, who added it. Written once by whoever
 *                 added it (an upload here, or by hand next to an rsync'd raw/); the hub only edits label/account.
 *   raw/          the bytes as they came: one uploaded file, or an export's own tree. Never modified.
 *   state.json    what the hub worked out: hash, size, census, errors. Derived; deleting it redoes the work.
 *   passphrase    a backup's passphrase, if given (0600).
 *
 * The directory is the truth and needs no database row, so a source copied in by rsync appears on the
 * next listing, and the import itself can be redone from sources alone.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { MAX_IMPORT } from '@dither-chat/protocol';
import { cleanFileName } from '../uploads.ts';
import { importable } from './engine.ts';
import { isPassphrase, normalizePassphrase, sniffLegacy } from './signal-backup.ts';

interface SourceFile {
  v: 1;
  network: P.Network | null;
  kind: P.ImportSourceKind;
  label: string;
  account: string | null;
  addedAt: number;
  addedBy: string;
  /**
   * Uploads: the files as the client named them, relative to raw/, and how big each will be. One file, or a folder
   * picked whole (a Molly backup folder: SignalBackups/ and .backup files). Older sources say { name, size }.
   */
  upload?: { files?: { path: string; size: number }[]; name?: string; size?: number };
  notes?: string;
  [k: string]: unknown;
}

interface StateFile {
  status: P.ImportSourceStatus;
  size: number;
  files: number;
  sha256: string | null;
  census: P.ImportCensus | null;
  error: string | null;
  kind?: P.ImportSourceKind;
  checkedAt?: number;
  run?: P.ImportRunView;
}

const ID = /^[\w][\w.-]{0,100}$/;

export class ImportSources {
  readonly root: string;
  /** Live progress of jobs, so a listing mid-census shows it without rewriting state.json. */
  private progress = new Map<string, number>();
  /** Runs in progress, updated in place by the runner; state.json gets each stage. */
  private runs = new Map<string, P.ImportRunView>();
  private jobs = new Map<string, Promise<void>>();
  private workers = new Map<string, Worker>();
  private writing = new Set<string>();

  constructor(dataDir: string, private log: (msg: string) => void = () => {}) {
    const imports = join(dataDir, 'imports');
    this.root = join(imports, 'sources');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(imports, 0o700);
    chmodSync(this.root, 0o700);
  }

  /** Pick up work a restart interrupted. */
  resume() {
    for (const id of this.ids()) {
      const st = this.readState(id);
      if (!st || st.status === 'checking' || st.status === 'counting') this.check(id);
      if (st?.run && !st.run.finishedAt) this.setState(id, { run: { ...st.run, stage: 'stopped', finishedAt: Date.now(), error: 'The hub restarted during it; run it again (it carries on where it was).' } });
    }
  }

  stop() {
    for (const w of this.workers.values()) w.terminate();
    this.workers.clear();
  }

  // ---------------------------------------------------------------- reading

  private ids(): string[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && ID.test(d.name) && existsSync(join(this.root, d.name, 'source.json')))
      .map((d) => d.name)
      .sort();
  }

  private dir(id: string): string | null {
    if (!ID.test(id)) return null;
    const d = resolve(this.root, id);
    return d.startsWith(this.root + '/') && existsSync(join(d, 'source.json')) ? d : null;
  }

  private readSource(id: string): SourceFile | null {
    try {
      return JSON.parse(readFileSync(join(this.root, id, 'source.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  private readState(id: string): StateFile | null {
    try {
      return JSON.parse(readFileSync(join(this.root, id, 'state.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  private writeJson(path: string, value: unknown) {
    writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(path + '.tmp', path);
  }

  private setState(id: string, patch: Partial<StateFile>) {
    const cur = this.readState(id) ?? { status: 'checking', size: 0, files: 0, sha256: null, census: null, error: null };
    this.writeJson(join(this.root, id, 'state.json'), { ...cur, ...patch });
  }

  /** An import run's state, kept with the source so it survives a restart. */
  setRun(id: string, run: P.ImportRunView) {
    if (!this.dir(id)) return;
    if (run.finishedAt) this.runs.delete(id);
    else this.runs.set(id, run);
    this.setState(id, { run: { ...run } });
  }

  /** An upload's files, relative to raw/. */
  private uploadFiles(src: SourceFile): { path: string; size: number }[] | null {
    const u = src.upload;
    if (!u) return null;
    if (u.files) return u.files;
    return u.name ? [{ path: cleanFileName(u.name), size: u.size ?? 0 }] : null;
  }

  /** The uploaded file, for single-file sources. */
  private uploadPath(id: string, src: SourceFile): string | null {
    const files = this.uploadFiles(src);
    return files?.length === 1 ? join(this.root, id, 'raw', files[0].path) : null;
  }

  private received(id: string, src: SourceFile): number {
    let n = 0;
    for (const f of this.uploadFiles(src) ?? []) {
      try {
        n += statSync(join(this.root, id, 'raw', f.path)).size;
      } catch {}
    }
    return n;
  }

  /** Each file of an upload and how much of it has arrived, so a client can carry on. */
  uploadState(id: string): { path: string; size: number; received: number }[] {
    const src = this.dir(id) ? this.readSource(id) : null;
    if (!src) throw Object.assign(new Error('no such source'), { status: 404 });
    return (this.uploadFiles(src) ?? []).map((f) => {
      let received = 0;
      try {
        received = statSync(join(this.root, id, 'raw', f.path)).size;
      } catch {}
      return { ...f, received };
    });
  }

  view(id: string): P.ImportSourceView | null {
    const src = this.dir(id) ? this.readSource(id) : null;
    if (!src) return null;
    const st = this.readState(id);
    const files = this.uploadFiles(src);
    const total = files ? files.reduce((n, f) => n + f.size, 0) : null;
    const received = files ? (st?.status === 'uploading' ? this.received(id, src) : (total ?? 0)) : (st?.size ?? 0);
    return {
      id,
      network: src.network ?? null,
      accountId: src.account ?? null,
      kind: st?.kind ?? src.kind ?? 'unknown',
      label: src.label || id,
      status: st?.status ?? 'checking',
      size: total ?? st?.size ?? 0,
      received,
      files: files?.length ?? st?.files ?? 0,
      sha256: st?.sha256 ?? null,
      addedAt: src.addedAt ?? 0,
      addedBy: src.addedBy ?? 'unknown',
      hasPassphrase: existsSync(join(this.root, id, 'passphrase')),
      progress: this.progress.get(id) ?? null,
      census: st?.census ?? null,
      error: st?.error ?? null,
      notes: typeof src.notes === 'string' ? src.notes : null,
      run: this.runs.get(id) ?? st?.run ?? null,
      importable: importable(st?.kind ?? src.kind ?? 'unknown'),
    };
  }

  list(): P.ImportSourceView[] {
    const out: P.ImportSourceView[] = [];
    for (const id of this.ids()) {
      // A folder copied in since the last look: work out what it is.
      if (!this.readState(id) && !this.jobs.has(id)) this.check(id);
      const v = this.view(id);
      if (v) out.push(v);
    }
    return out.sort((a, b) => b.addedAt - a.addedAt);
  }

  // ---------------------------------------------------------------- uploads

  /**
   * A new upload: one file ({ name, size }) or several with their paths in a picked folder ({ files }). Nothing is
   * written into raw/ but what these name, each under its own cleaned path.
   */
  create(o: { network: P.Network; accountId: string; name?: string; size?: number; files?: { path: string; size: number }[]; label?: string }): P.ImportSourceView {
    const files = (o.files ?? [{ path: o.name ?? '', size: o.size ?? 0 }]).map((f) => ({ path: cleanRelPath(f.path), size: Number(f.size) }));
    if (!files.length || files.length > MAX_FILES) throw new Error(`between 1 and ${MAX_FILES} files`);
    if (files.some((f) => !f.path || !Number.isSafeInteger(f.size) || f.size < 0)) throw new Error('a file without a name or size');
    if (new Set(files.map((f) => f.path)).size !== files.length) throw new Error('the same file twice');
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total <= 0) throw new Error('nothing to upload');
    if (total > MAX_IMPORT) throw new Error('that is too large');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const id = `${o.network}-${stamp}-${randomBytes(2).toString('hex')}`;
    const d = join(this.root, id);
    for (const f of files) {
      mkdirSync(dirname(join(d, 'raw', f.path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(d, 'raw', f.path), '', { mode: 0o600 });
    }
    const first = files[0].path;
    const top = first.split('/')[0];
    const kind: P.ImportSourceKind =
      o.network === 'signal' && files.length === 1 && /\.backup$/i.test(first)
        ? 'signal-backup'
        : o.network === 'signal'
          ? 'signal-folder'
          : o.network === 'discord' && files.length === 1 && /\.zip$/i.test(first)
            ? 'discord-package'
            : 'unknown';
    const label = o.label?.trim() || (files.length === 1 ? first : `${top} (${files.length} files)`);
    const src: SourceFile = { v: 1, network: o.network, kind, label, account: o.accountId, addedAt: Date.now(), addedBy: 'upload', upload: { files } };
    this.writeJson(join(d, 'source.json'), src);
    this.setState(id, { status: 'uploading', size: total, files: files.length });
    return this.view(id)!;
  }

  /** Append one piece of file `file` at `offset`, which must be exactly what has arrived of it so far. */
  async put(id: string, offset: number, body: ReadableStream<Uint8Array> | null, file = 0): Promise<P.ImportSourceView> {
    const src = this.dir(id) ? this.readSource(id) : null;
    const f = src ? this.uploadFiles(src)?.[file] : undefined;
    if (!src || !f) throw Object.assign(new Error('no such upload'), { status: 404 });
    const path = join(this.root, id, 'raw', f.path);
    if (this.readState(id)?.status !== 'uploading') throw Object.assign(new Error('this upload is already complete'), { status: 409 });
    const key = `${id}#${file}`;
    if (this.writing.has(key)) throw Object.assign(new Error('another piece is still being written'), { status: 409 });
    const have = statSync(path).size;
    if (offset !== have) throw Object.assign(new Error(`expected offset ${have}`), { status: 409, received: have });
    this.writing.add(key);
    const fd = openSync(path, 'a');
    let written = 0;
    try {
      if (body) {
        for await (const chunk of body) {
          if (have + written + chunk.length > f.size) throw Object.assign(new Error('more bytes than the file has'), { status: 400 });
          writeSync(fd, chunk);
          written += chunk.length;
        }
      }
    } finally {
      closeSync(fd);
      this.writing.delete(key);
    }
    if (this.received(id, src) === this.uploadFiles(src)!.reduce((n, x) => n + x.size, 0) && ![...this.writing].some((k) => k.startsWith(id + '#'))) {
      this.setState(id, { status: 'checking' });
      this.check(id);
    }
    return this.view(id)!;
  }

  // ---------------------------------------------------------------- after upload: hash, sniff, count

  /** Hash it, see what it is, and count it if it can be. Safe to call again. */
  check(id: string): Promise<void> {
    const running = this.jobs.get(id);
    if (running) return running;
    const job = this.runCheck(id)
      .catch((e) => {
        this.log(`import ${id}: ${e?.message ?? e}`);
        if (this.dir(id)) this.setState(id, { status: 'error', error: String(e?.message ?? e) });
      })
      .finally(() => {
        this.jobs.delete(id);
        this.progress.delete(id);
      });
    this.jobs.set(id, job);
    return job;
  }

  private async runCheck(id: string) {
    const src = this.readSource(id);
    if (!src) return;
    const d = join(this.root, id);
    const up = this.uploadPath(id, src);
    const want = this.uploadFiles(src);
    if (want && this.received(id, src) < want.reduce((n, f) => n + f.size, 0)) return this.setState(id, { status: 'uploading' });
    this.setState(id, { status: 'checking', error: null });

    let kind: P.ImportSourceKind = src.kind ?? 'unknown';
    const { size, files, sha256 } = await hashInWorker(up ? { file: up } : { dir: join(d, 'raw') });
    if (up) {
      const legacy = sniffLegacy(up);
      if (legacy) kind = 'signal-backup';
      else if (kind === 'signal-backup') throw new Error('this is not a Signal backup: it does not start with a backup header');
    }
    this.setState(id, { size, files, sha256, kind, checkedAt: Date.now() });

    if (kind === 'signal-backup' && up) {
      const pass = this.passphrase(id);
      if (!pass) return this.setState(id, { status: 'needs-passphrase' });
      return this.count(id, up, pass);
    }
    if (kind === 'signal-folder' || (src.network === 'signal' && !up)) {
      // A Molly backup folder: new-format snapshots under SignalBackups/, and with "Include kept messages", .backup
      // files beside it. The newest .backup is the one counted.
      const folder = signalFolder(join(d, 'raw'));
      this.setState(id, { kind: 'signal-folder', census: folder.census });
      if (folder.newestBackup) {
        const pass = this.passphrase(id);
        if (!pass) return this.setState(id, { status: 'needs-passphrase' });
        return this.count(id, folder.newestBackup, pass, folder.census);
      }
    }
    this.setState(id, { status: 'ready' });
  }

  private passphrase(id: string): string | null {
    const p = join(this.root, id, 'passphrase');
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
  }

  /** Read the whole backup through in a worker; a wrong passphrase is forgotten and asked for again. */
  private count(id: string, path: string, passphrase: string, base?: P.ImportCensus): Promise<void> {
    this.setState(id, { status: 'counting', error: null });
    this.progress.set(id, 0);
    return new Promise((done) => {
      const w = new Worker(new URL('./census-worker.ts', import.meta.url).href);
      this.workers.set(id, w);
      const finish = (patch: Partial<StateFile>) => {
        w.terminate();
        this.workers.delete(id);
        if (this.dir(id)) this.setState(id, patch);
        done();
      };
      w.onmessage = (e: MessageEvent<any>) => {
        if (typeof e.data.progress === 'number') this.progress.set(id, e.data.progress);
        else if (e.data.census) finish({ status: 'ready', census: base ? { ...base, legacy: e.data.census } : e.data.census, error: null });
        else if (e.data.badPassphrase) {
          rmSync(join(this.root, id, 'passphrase'), { force: true });
          finish({ status: 'needs-passphrase', error: 'That passphrase does not open this backup.' });
        } else finish({ status: 'error', error: e.data.error ?? 'census failed' });
      };
      w.onerror = (e) => finish({ status: 'error', error: e.message || 'census failed' });
      w.postMessage({ path, passphrase });
    });
  }

  setPassphrase(id: string, passphrase: string): P.ImportSourceView {
    const d = this.dir(id);
    if (!d) throw Object.assign(new Error('no such source'), { status: 404 });
    if (!isPassphrase(passphrase)) throw new Error('A backup passphrase is 30 digits.');
    const st = this.readState(id);
    if (st?.status === 'uploading') throw Object.assign(new Error('the upload is not complete yet'), { status: 409 });
    if (st?.kind !== 'signal-backup' && st?.kind !== 'signal-folder') throw new Error('only a Signal .backup has a passphrase');
    if (this.jobs.has(id)) throw Object.assign(new Error('still checking this source'), { status: 409 });
    writeFileSync(join(d, 'passphrase'), normalizePassphrase(passphrase), { mode: 0o600 });
    this.check(id);
    return this.view(id)!;
  }

  // ---------------------------------------------------------------- edits

  patch(id: string, p: { label?: string; accountId?: string | null; network?: P.Network }): P.ImportSourceView {
    const src = this.dir(id) ? this.readSource(id) : null;
    if (!src) throw Object.assign(new Error('no such source'), { status: 404 });
    if (typeof p.label === 'string' && p.label.trim()) src.label = p.label.trim().slice(0, 200);
    if (p.accountId !== undefined) src.account = p.accountId;
    if (p.network) src.network = p.network;
    this.writeJson(join(this.root, id, 'source.json'), src);
    return this.view(id)!;
  }

  /** Forget a source and its bytes. Anything already imported from it stays (docs/import.md: undo is separate). */
  remove(id: string) {
    const d = this.dir(id);
    if (!d) throw Object.assign(new Error('no such source'), { status: 404 });
    this.workers.get(id)?.terminate();
    this.workers.delete(id);
    rmSync(d, { recursive: true, force: true });
  }

  /** Where an import reads a source from. */
  rawDir(id: string): string | null {
    const d = this.dir(id);
    return d ? join(d, 'raw') : null;
  }
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name));
  }
  return out.sort();
}

/** Hash a file or a folder in a worker (hash-worker.ts). */
function hashInWorker(what: { file: string } | { dir: string }): Promise<{ size: number; files: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./hash-worker.ts', import.meta.url).href);
    w.onmessage = (e: MessageEvent<any>) => {
      w.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data);
    };
    w.onerror = (e) => (w.terminate(), reject(new Error(e.message || 'hashing failed')));
    w.postMessage(what);
  });
}

const MAX_FILES = 200_000;

/** A path inside a picked folder, each part cleaned like a file name; never absolute, never "..". */
export function cleanRelPath(p: string): string {
  return p
    .split(/[\\/]+/)
    .filter((x) => x && x !== '.' && x !== '..')
    .map((x) => cleanFileName(x))
    .join('/');
}

/** What a Molly backup folder holds, by names and sizes only. */
export function signalFolder(raw: string): { census: P.ImportCensus; newestBackup: string | null } {
  const files = walk(raw);
  const snapshots = new Set<string>();
  let attachments = 0;
  let attachmentBytes = 0;
  const backups: { path: string; bytes: number; version: number | null }[] = [];
  for (const p of files) {
    const rel = relative(raw, p);
    const parts = rel.split('/');
    const snap = parts.findIndex((x) => /^signal-backup-/.test(x));
    if (snap >= 0 && snap < parts.length - 1) snapshots.add(parts[snap]);
    if (parts.includes('files') && parts.indexOf('files') < parts.length - 1) {
      attachments++;
      attachmentBytes += statSync(p).size;
    }
    if (/\.backup$/i.test(rel)) backups.push({ path: rel, bytes: statSync(p).size, version: sniffLegacy(p)?.version ?? null });
  }
  const valid = backups.filter((b) => b.version !== null).sort((a, b) => (a.path < b.path ? 1 : -1));
  const snaps = [...snapshots].sort();
  return {
    census: { format: 'signal-folder', snapshots: snaps.length, newestSnapshot: snaps.at(-1) ?? null, attachments, attachmentBytes, backups: backups.map((b) => ({ name: b.path.split('/').pop(), bytes: b.bytes, legacy: b.version !== null })) },
    newestBackup: valid[0] ? join(raw, valid[0].path) : null,
  };
}

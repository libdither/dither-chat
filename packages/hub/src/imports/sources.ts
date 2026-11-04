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
import { join, relative, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { MAX_IMPORT } from '@dither-chat/protocol';
import { cleanFileName } from '../uploads.ts';
import { isPassphrase, normalizePassphrase, sniffLegacy } from './signal-backup.ts';

interface SourceFile {
  v: 1;
  network: P.Network | null;
  kind: P.ImportSourceKind;
  label: string;
  account: string | null;
  addedAt: number;
  addedBy: string;
  /** Uploads: the file as the client named it, and how big it will be. */
  upload?: { name: string; size: number };
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
}

const ID = /^[\w][\w.-]{0,100}$/;

export class ImportSources {
  readonly root: string;
  /** Live progress of jobs, so a listing mid-census shows it without rewriting state.json. */
  private progress = new Map<string, number>();
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

  /** The uploaded file, for single-file sources. */
  private uploadPath(id: string, src: SourceFile): string | null {
    return src.upload ? join(this.root, id, 'raw', cleanFileName(src.upload.name)) : null;
  }

  view(id: string): P.ImportSourceView | null {
    const src = this.dir(id) ? this.readSource(id) : null;
    if (!src) return null;
    const st = this.readState(id);
    const up = this.uploadPath(id, src);
    const received = up && existsSync(up) ? statSync(up).size : (st?.size ?? 0);
    return {
      id,
      network: src.network ?? null,
      accountId: src.account ?? null,
      kind: st?.kind ?? src.kind ?? 'unknown',
      label: src.label || id,
      status: st?.status ?? 'checking',
      size: src.upload?.size ?? st?.size ?? 0,
      received,
      files: st?.files ?? (up ? 1 : 0),
      sha256: st?.sha256 ?? null,
      addedAt: src.addedAt ?? 0,
      addedBy: src.addedBy ?? 'unknown',
      hasPassphrase: existsSync(join(this.root, id, 'passphrase')),
      progress: this.progress.get(id) ?? null,
      census: st?.census ?? null,
      error: st?.error ?? null,
      notes: typeof src.notes === 'string' ? src.notes : null,
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

  create(o: { network: P.Network; accountId: string; name: string; size: number; label?: string }): P.ImportSourceView {
    if (!Number.isSafeInteger(o.size) || o.size <= 0) throw new Error('empty file');
    if (o.size > MAX_IMPORT) throw new Error('that file is too large');
    const name = cleanFileName(o.name);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const id = `${o.network}-${stamp}-${randomBytes(2).toString('hex')}`;
    const d = join(this.root, id);
    mkdirSync(join(d, 'raw'), { recursive: true, mode: 0o700 });
    writeFileSync(join(d, 'raw', name), '', { mode: 0o600 });
    const kind: P.ImportSourceKind = o.network === 'signal' && /\.backup$/i.test(name) ? 'signal-backup' : o.network === 'discord' && /\.zip$/i.test(name) ? 'discord-package' : 'unknown';
    const src: SourceFile = { v: 1, network: o.network, kind, label: o.label?.trim() || name, account: o.accountId, addedAt: Date.now(), addedBy: 'upload', upload: { name, size: o.size } };
    this.writeJson(join(d, 'source.json'), src);
    this.setState(id, { status: 'uploading', size: o.size, files: 1 });
    return this.view(id)!;
  }

  /** Append one piece at `offset`, which must be exactly what has arrived so far. */
  async put(id: string, offset: number, body: ReadableStream<Uint8Array> | null): Promise<P.ImportSourceView> {
    const src = this.dir(id) ? this.readSource(id) : null;
    const path = src && this.uploadPath(id, src);
    if (!src || !path || !src.upload) throw Object.assign(new Error('no such upload'), { status: 404 });
    if (this.readState(id)?.status !== 'uploading') throw Object.assign(new Error('this upload is already complete'), { status: 409 });
    if (this.writing.has(id)) throw Object.assign(new Error('another piece is still being written'), { status: 409 });
    const have = statSync(path).size;
    if (offset !== have) throw Object.assign(new Error(`expected offset ${have}`), { status: 409, received: have });
    this.writing.add(id);
    const fd = openSync(path, 'a');
    let written = 0;
    try {
      if (body) {
        for await (const chunk of body) {
          if (have + written + chunk.length > src.upload.size) throw Object.assign(new Error('more bytes than the file has'), { status: 400 });
          writeSync(fd, chunk);
          written += chunk.length;
        }
      }
    } finally {
      closeSync(fd);
      this.writing.delete(id);
    }
    if (have + written === src.upload.size) {
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
    if (up && src.upload && (!existsSync(up) || statSync(up).size < src.upload.size)) return this.setState(id, { status: 'uploading' });
    this.setState(id, { status: 'checking', error: null });

    let kind: P.ImportSourceKind = src.kind ?? 'unknown';
    let size = 0;
    let files = 0;
    let sha256: string;
    if (up) {
      size = statSync(up).size;
      files = 1;
      sha256 = await hashFile(up);
      const legacy = sniffLegacy(up);
      if (legacy) kind = 'signal-backup';
      else if (kind === 'signal-backup') throw new Error('this is not a Signal backup: it does not start with a backup header');
    } else {
      // A folder: its identity is the hash of its sorted (path, size, sha256) lines.
      const list = walk(join(d, 'raw'));
      const lines: string[] = [];
      for (const p of list) {
        const s = statSync(p).size;
        size += s;
        files++;
        lines.push(`${relative(join(d, 'raw'), p)}\t${s}\t${await hashFile(p)}`);
      }
      sha256 = new Bun.CryptoHasher('sha256').update(lines.join('\n')).digest('hex');
    }
    this.setState(id, { size, files, sha256, kind, checkedAt: Date.now() });

    if (kind === 'signal-backup' && up) {
      const pass = this.passphrase(id);
      if (!pass) return this.setState(id, { status: 'needs-passphrase' });
      return this.count(id, up, pass);
    }
    this.setState(id, { status: 'ready' });
  }

  private passphrase(id: string): string | null {
    const p = join(this.root, id, 'passphrase');
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
  }

  /** Read the whole backup through in a worker; a wrong passphrase is forgotten and asked for again. */
  private count(id: string, path: string, passphrase: string): Promise<void> {
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
        else if (e.data.census) finish({ status: 'ready', census: e.data.census, error: null });
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

async function hashFile(path: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest('hex');
}

/**
 * History sources: the backup reader on synthetic backups, and uploads over real HTTP — in pieces, resumed,
 * hashed, sniffed, counted with the passphrase, and forgotten. Also a folder copied in by hand.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { BadPassphrase, censusLegacy, censusV2, isPassphrase, sniffLegacy } from '../src/imports/signal-backup.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { SYNTHETIC_PASSPHRASE, syntheticBackup, syntheticV2 } from './fixtures/synthetic-backup.ts';
import { makeZip } from './fixtures/zip.ts';
import { unzip, zipEntries } from '../src/imports/zip.ts';
import { cleanRelPath } from '../src/uploads.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-imports-'));
const backup = syntheticBackup();
const backupPath = join(dir, 'synthetic.backup');
writeFileSync(backupPath, backup);

describe('legacy backup reader', () => {
  test('the header needs no passphrase', () => {
    expect(sniffLegacy(backupPath)).toEqual({ version: 1, salt: true, ivBytes: 16 });
    const notBackup = join(dir, 'not.backup');
    writeFileSync(notBackup, 'PK\x03\x04 a zip, not a backup');
    expect(sniffLegacy(notBackup)).toBeNull();
  });

  test('a census counts and never returns content', () => {
    const c = censusLegacy(backupPath, SYNTHETIC_PASSPHRASE);
    expect(c.version).toBe(1);
    expect(c.databaseVersion).toBe(300);
    expect(c.rows).toEqual({ message: 5, recipient: 1 });
    expect(c.messages).toEqual({ total: 5, keepmsgExpired: 1, deleted: 1, editRevisions: 1, firstMonth: '2023-06', lastMonth: '2023-11' });
    expect(c.blobs.attachment).toEqual({ count: 1, bytes: 1000 });
    expect(c.keyValueNamespaces).toEqual(['account']);
    expect(c.schema.message).toContain('keepmsg_expired');
    expect(JSON.stringify(c)).not.toContain('synthetic');
  });

  test('a wrong passphrase is told apart from a damaged file', () => {
    expect(() => censusLegacy(backupPath, '111111111111111111111111111111')).toThrow(BadPassphrase);
    const damaged = Buffer.from(backup);
    damaged[damaged.length - 12] ^= 0xff; // inside the end frame (blob bytes are skipped, not checked)
    const p = join(dir, 'damaged.backup');
    writeFileSync(p, damaged);
    expect(() => censusLegacy(p, SYNTHETIC_PASSPHRASE)).toThrow(/damaged/);
  });

  test('passphrases are 30 digits, spaces allowed', () => {
    expect(isPassphrase('12345 67890 12345 67890 12345 67890')).toBe(true);
    expect(isPassphrase('1234567890')).toBe(false);
  });

  test('backup v2 frames are counted by kind', () => {
    const c = censusV2(syntheticV2());
    expect(c.version).toBe(1);
    expect(c.writtenMonth).toBe('2025-01');
    expect(c.frames).toEqual({ 'recipient.self': 1, 'recipient.contact': 1, chat: 1, chatItem: 1 });
    expect(c.chatItems).toEqual({ standard: 1 });
    expect(c.standard.reactions).toBe(1);
  });
});

describe('zip reader', () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);
  for (const zip64 of [false, true])
    test(`unpacks stored and deflated entries${zip64 ? ', Zip64' : ''}, paths cleaned`, async () => {
      const z = join(dir, `t${zip64 ? 64 : 32}.zip`);
      writeFileSync(z, makeZip([{ name: 'Backups/', bytes: new Uint8Array() }, { name: 'Backups/a.txt', bytes: enc('hello'), store: true }, { name: 'Backups/files/ab/big', bytes: big }, { name: '../../escape', bytes: enc('x') }, { name: 'empty', bytes: new Uint8Array() }], { zip64 }));
      expect(zipEntries(z).map((e) => e.name)).toEqual(['Backups/', 'Backups/a.txt', 'Backups/files/ab/big', '../../escape', 'empty']);
      const out = join(dir, `out${zip64 ? 64 : 32}`);
      const r = await unzip(z, out, { clean: cleanRelPath, maxBytes: 1 << 30 });
      expect(r).toEqual({ files: 4, bytes: 5 + big.length + 1 });
      expect(readFileSync(join(out, 'Backups/a.txt'), 'utf8')).toBe('hello');
      expect(new Uint8Array(readFileSync(join(out, 'Backups/files/ab/big')))).toEqual(big);
      expect(readFileSync(join(out, 'escape'), 'utf8')).toBe('x');
      expect(statSync(join(out, 'empty')).size).toBe(0);
    });

  test('refuses links, a damaged entry, too much, and what is not a zip', async () => {
    const z = join(dir, 'bad.zip');
    writeFileSync(z, makeZip([{ name: 'l', bytes: enc('/etc/passwd'), mode: 0o120777 }]));
    await expect(unzip(z, join(dir, 'o1'), { clean: cleanRelPath, maxBytes: 1 << 30 })).rejects.toThrow(/link/);
    const ok = makeZip([{ name: 'a', bytes: enc('hello hello hello'), store: true }]);
    ok[30 + 1 + 2] ^= 1; // a byte of the data
    writeFileSync(z, ok);
    await expect(unzip(z, join(dir, 'o2'), { clean: cleanRelPath, maxBytes: 1 << 30 })).rejects.toThrow(/checksum/);
    writeFileSync(z, makeZip([{ name: 'a', bytes: big }]));
    await expect(unzip(z, join(dir, 'o3'), { clean: cleanRelPath, maxBytes: 1000 })).rejects.toThrow(/more than/);
    writeFileSync(z, 'not a zip at all');
    expect(() => zipEntries(z)).toThrow(/not a zip/);
  });
});

describe('import sources over HTTP', () => {
  let port = 0;
  let base = '';
  let server: HubServer;
  let store: Store;
  const hubDir = join(dir, 'hub');

  beforeAll(() => {
    mkdirSync(hubDir);
    store = new Store(join(hubDir, 'hub.sqlite'), mediaSigner('s'));
    store.createAccount({ id: 'acc_sig', network: 'signal', label: 'test', color: '#000', adapter: 'signal', token: 't' } as any);
    const sup = { authorize: () => null, online: () => false } as any;
    server = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: hubDir, webDist: hubDir, secret: 's' });
    port = server.start().port!;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => {
    server.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const json = async <T = any>(path: string, init?: RequestInit & { body?: any }) => {
    const res = await fetch(base + path, init?.body !== undefined && !(init.body instanceof Uint8Array) ? { ...init, body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : init);
    return { status: res.status, data: (await res.json()) as T };
  };
  const until = async (id: string, done: (v: P.ImportSourceView) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const v = (await json<P.ImportSourceView>(`/api/imports/${id}`)).data;
      if (done(v)) return v;
      await Bun.sleep(25);
    }
    throw new Error('timed out');
  };

  test('an upload arrives in pieces, resumes at its offset, and asks for the passphrase', async () => {
    const created = await json<P.ImportSourceView>('/api/imports', { method: 'POST', body: { accountId: 'acc_sig', name: '../signal-2026.backup', size: backup.length } });
    expect(created.status).toBe(200);
    const id = created.data.id;
    expect(id).toMatch(/^signal-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(created.data).toMatchObject({ status: 'uploading', received: 0, kind: 'signal-backup', accountId: 'acc_sig', network: 'signal' });

    const half = 700;
    const put = (offset: number, bytes: Uint8Array) => json(`/api/imports/${id}/data?offset=${offset}`, { method: 'PUT', body: bytes });
    expect((await put(0, backup.subarray(0, half))).data.received).toBe(half);
    // A piece sent again after a lost answer is refused with where to carry on from.
    const again = await put(0, backup.subarray(0, half));
    expect(again.status).toBe(409);
    expect(again.data.received).toBe(half);
    expect((await put(half, backup.subarray(half))).data.received).toBe(backup.length);

    const v = await until(id, (v) => v.status !== 'checking' && v.status !== 'uploading');
    expect(v.status).toBe('needs-passphrase');
    expect(v.sha256).toBe(new Bun.CryptoHasher('sha256').update(backup).digest('hex'));
    // The client's path never becomes ours.
    expect(statSync(join(hubDir, 'imports/sources', id, 'raw/signal-2026.backup')).size).toBe(backup.length);
    expect(statSync(join(hubDir, 'imports')).mode & 0o077).toBe(0);
  });

  test('a wrong passphrase is forgotten; the right one counts the backup', async () => {
    const id = (await json<{ sources: P.ImportSourceView[] }>('/api/imports')).data.sources[0].id;
    expect((await json(`/api/imports/${id}/passphrase`, { method: 'POST', body: { passphrase: '123' } })).status).toBe(400);
    await json(`/api/imports/${id}/passphrase`, { method: 'POST', body: { passphrase: '111111111111111111111111111111' } });
    let v = await until(id, (v) => v.status === 'needs-passphrase' && !!v.error);
    expect(v.hasPassphrase).toBe(false);

    await json(`/api/imports/${id}/passphrase`, { method: 'POST', body: { passphrase: '00000 00000 00000 00000 00000 00000' } });
    v = await until(id, (v) => v.status === 'ready');
    expect(v.hasPassphrase).toBe(true);
    expect(v.error).toBeNull();
    expect((v.census as any).messages.total).toBe(5);
    expect(statSync(join(hubDir, 'imports/sources', id, 'passphrase')).mode & 0o077).toBe(0);
  });

  test('a folder copied in by hand shows up and gets a stable identity', async () => {
    const d = join(hubDir, 'imports/sources/discord-main-dce-html');
    mkdirSync(join(d, 'raw/Documents/export'), { recursive: true });
    writeFileSync(join(d, 'raw/Documents/export/a.html'), '<html></html>');
    writeFileSync(join(d, 'raw/Documents/export/b.html'), '<html><body></body></html>');
    writeFileSync(join(d, 'source.json'), JSON.stringify({ v: 1, network: 'discord', kind: 'dce-html', label: 'Discord main', account: null, addedAt: 1, addedBy: 'rsync' }));
    await json('/api/imports');
    const v = await until('discord-main-dce-html', (v) => v.status === 'ready');
    expect(v).toMatchObject({ files: 2, kind: 'dce-html', accountId: null, size: 13 + 26 });
    const first = v.sha256;
    rmSync(join(d, 'state.json'));
    await json('/api/imports');
    expect((await until('discord-main-dce-html', (v) => v.status === 'ready')).sha256).toBe(first);
  });

  test('a Molly backup folder goes up file by file and its .backup is counted', async () => {
    const meta = new TextEncoder().encode('metadata bytes');
    const main = new TextEncoder().encode('encrypted main');
    const att = new TextEncoder().encode('an attachment');
    const files = [
      { path: 'Backups/SignalBackups/signal-backup-2026-11-06-10-00-00/main', bytes: main },
      { path: 'Backups/SignalBackups/signal-backup-2026-11-06-10-00-00/metadata', bytes: meta },
      { path: 'Backups/SignalBackups/files/ab/abcdef', bytes: att },
      { path: 'Backups/signal-2026-11-06-10-00-00.backup', bytes: backup },
      { path: '../../../escape.txt', bytes: att },
    ];
    const created = await json<P.ImportSourceView>('/api/imports', { method: 'POST', body: { accountId: 'acc_sig', files: files.map((f) => ({ path: f.path, size: f.bytes.length })) } });
    expect(created.status).toBe(200);
    const id = created.data.id;
    expect(created.data).toMatchObject({ kind: 'signal-folder', files: 5, label: 'Backups (5 files)' });
    const state = (await json<{ files: { path: string; received: number }[] }>(`/api/imports/${id}/files`)).data.files;
    expect(state.map((f) => f.path)).toContain('escape.txt');
    for (let i = 0; i < files.length; i++) await json(`/api/imports/${id}/data?file=${i}&offset=0`, { method: 'PUT', body: files[i].bytes });
    let v = await until(id, (v) => v.status !== 'uploading' && v.status !== 'checking');
    expect(v.status).toBe('needs-passphrase');
    expect(v.census).toMatchObject({ format: 'signal-folder', snapshots: 1, newestSnapshot: 'signal-backup-2026-11-06-10-00-00', attachments: 1, backups: [{ name: 'signal-2026-11-06-10-00-00.backup', legacy: true }] });
    expect((v.census as any).needs).toBe('recovery-key');
    await json(`/api/imports/${id}/passphrase`, { method: 'POST', body: { passphrase: SYNTHETIC_PASSPHRASE } });
    // The .backup is counted; the snapshot beside it (made-up bytes here) still waits for a recovery key.
    v = await until(id, (v) => v.status === 'needs-passphrase' && !!(v.census as any)?.legacy);
    expect((v.census as any).legacy.messages.total).toBe(5);
    expect((v.census as any).needs).toBe('recovery-key');
    expect(statSync(join(hubDir, 'imports/sources', id, 'raw/escape.txt')).size).toBe(att.length);
  });

  test('a zipped Molly folder is unpacked beside the zip and counted as the folder', async () => {
    const zip = makeZip(
      [
        { name: 'Backups/SignalBackups/signal-backup-2026-11-06-10-00-00/main', bytes: new TextEncoder().encode('encrypted main') },
        { name: 'Backups/SignalBackups/signal-backup-2026-11-06-10-00-00/metadata', bytes: new TextEncoder().encode('metadata') },
        { name: 'Backups/SignalBackups/files/ab/abcdef', bytes: new TextEncoder().encode('an attachment') },
        { name: 'Backups/signal-2026-11-06-10-00-00.backup', bytes: backup, store: true },
      ],
      { zip64: true },
    );
    const created = await json<P.ImportSourceView>('/api/imports', { method: 'POST', body: { accountId: 'acc_sig', name: 'Backups.zip', size: zip.length } });
    const id = created.data.id;
    expect(created.data.kind).toBe('signal-folder');
    await json(`/api/imports/${id}/data?offset=0`, { method: 'PUT', body: zip });
    let v = await until(id, (v) => v.status !== 'uploading' && v.status !== 'checking');
    expect(v.status).toBe('needs-passphrase');
    expect(v.sha256).toBe(new Bun.CryptoHasher('sha256').update(zip).digest('hex'));
    expect(v.census).toMatchObject({ format: 'signal-folder', zip: true, snapshots: 1, attachments: 1, backups: [{ name: 'signal-2026-11-06-10-00-00.backup', legacy: true }] });
    expect((v.census as any).needs).toBe('recovery-key');
    await json(`/api/imports/${id}/passphrase`, { method: 'POST', body: { passphrase: SYNTHETIC_PASSPHRASE } });
    // The .backup is counted; the snapshot beside it (made-up bytes here) still waits for a recovery key.
    v = await until(id, (v) => v.status === 'needs-passphrase' && !!(v.census as any)?.legacy);
    expect((v.census as any).legacy.messages.total).toBe(5);
    expect((v.census as any).needs).toBe('recovery-key');
    // raw/ keeps the zip as it came; checking again doesn't unpack again.
    const src = join(hubDir, 'imports/sources', id);
    expect(statSync(join(src, 'raw/Backups.zip')).size).toBe(zip.length);
    const before = statSync(join(src, 'unpacked')).mtimeMs;
    await json(`/api/imports/${id}/check`, { method: 'POST', body: {} });
    await until(id, (v) => v.status === 'needs-passphrase' && !!(v.census as any)?.legacy);
    expect(statSync(join(src, 'unpacked')).mtimeMs).toBe(before);
  });

  test('a source can be given an account, and forgotten', async () => {
    store.createAccount({ id: 'acc_dc', network: 'discord', label: 'main', color: '#000', adapter: 'discord', token: 't' } as any);
    const p = await json<P.ImportSourceView>('/api/imports/discord-main-dce-html', { method: 'PATCH', body: { accountId: 'acc_dc' } });
    expect(p.data.accountId).toBe('acc_dc');
    expect(JSON.parse(readFileSync(join(hubDir, 'imports/sources/discord-main-dce-html/source.json'), 'utf8')).account).toBe('acc_dc');
    expect((await json('/api/imports/discord-main-dce-html', { method: 'DELETE' })).status).toBe(200);
    expect((await json('/api/imports/discord-main-dce-html')).status).toBe(404);
    expect((await json('/api/imports/..%2F..%2Fhub.sqlite')).status).toBe(404);
  });
});

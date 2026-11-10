/**
 * Signal's new backup format: key derivation against libsignal's own output, group ids, and a synthetic Molly
 * backup read end to end (decrypted, mapped to the live adapter's ids, attachments unsealed), then uploaded, unlocked
 * with the recovery key and imported over HTTP.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { backupIdFor, backupKeyFromRecoveryKey, groupIdFromMasterKey, localMetadataKey, messageBackupKeys, parseRecoveryKey } from '../src/imports/signal-keys.ts';
import { BadBackupKey, countSnapshot, readSignalV2 } from '../src/imports/signal-v2.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { ALICE, BOB, MASTER_KEY, PICTURE, RECOVERY_KEY, SELF, T, writeSyntheticV2 } from './fixtures/signal-v2.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-signal-v2-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('keys', () => {
  test('match libsignal (values from libsignal-client 0.103 for its example pool and a made-up ACI)', () => {
    // As Molly shows it: upper case, grouped, '#' for O and '=' for 0.
    const pool = parseRecoveryKey('DTJS 858A SJ6T V=JZ SQRS MJ=U BP33 5PIS J98E 9SSN SS8M Y#C= 8DRH TCKT YAWV X45L')!;
    expect(pool).toBe(RECOVERY_KEY.replace(/ /g, ''));
    const bk = backupKeyFromRecoveryKey(pool);
    expect(hex(bk)).toBe('ea26a2ddb5dba5ef9e34e1b8dea1f5ae7f255306a6d2d883e542306eaa9fe985');
    const id = backupIdFor(bk, '659aa5f4-a28d-4b67-b6ad-f0f7a0b6e20d');
    expect(hex(id)).toBe('5e2921b08816de2be7a8663f8cd2bd04');
    expect(hex(localMetadataKey(bk))).toBe('68a14417a1167e55fdb17b24fb223b34752ba4d2bb6294c991acaebf4ec90472');
    const k = messageBackupKeys(bk, id);
    expect(hex(k.hmacKey)).toBe('d80f568eec301658b3975028b2562d54c208c498877cbf7c40019eefd6a85571');
    expect(hex(k.aesKey)).toBe('94a0085bbafcfd3119eec5009a6257698eefad50ba2feba131caa8942c680d9b');
    expect(parseRecoveryKey('too short')).toBeNull();
  });

  test('group ids from master keys (checked against all 75 of a real signal-cli account’s groups; pinned here)', () => {
    expect(groupIdFromMasterKey(Buffer.alloc(32, 0)).toString('base64')).toMatchSnapshot();
    expect(groupIdFromMasterKey(MASTER_KEY)).toHaveLength(32);
  });
});

describe('reading a snapshot', () => {
  const src = join(dir, 'src');
  let made: ReturnType<typeof writeSyntheticV2>;
  beforeAll(() => (made = writeSyntheticV2(src)));
  const key = () => backupKeyFromRecoveryKey(parseRecoveryKey(RECOVERY_KEY)!);

  test('counts with the right key, and refuses a wrong one', () => {
    expect(() => countSnapshot(made.snapshot, backupKeyFromRecoveryKey('a'.repeat(64)))).toThrow(BadBackupKey);
    expect(countSnapshot(made.snapshot, key())).toMatchObject({ format: 'signal-v2', recipients: { self: 1, contact: 3, group: 1 }, chats: 4, chatItems: 10, firstMonth: '2024-03' });
  });

  test('maps to the live adapter’s ids and wording, and unseals the attachment', () => {
    const media = join(dir, 'media');
    const lines: any[] = [];
    const stats = readSignalV2({ dir: src, backupKey: key(), selfId: SELF, mediaDir: media }, (l) => lines.push(l));
    expect(stats).toMatchObject({ conversations: 3, messages: 7, selfMessages: 3, duplicates: 0, files: { linked: 3, missing: 0 } });
    expect(stats.skipped).toEqual({ deleted: 1, sms: 1, 'chat not kept': 1 });
    const convs = lines.filter((l) => l.t === 'conversation').map((l) => l.conversation);
    const group = `group:${groupIdFromMasterKey(MASTER_KEY).toString('base64')}`;
    expect(convs.map((c) => c.nativeId)).toEqual([`dm:${SELF}:${ALICE}`, group, `dm:${SELF}:${SELF}`]);
    expect(convs[1]).toMatchObject({ shape: 'group', name: 'Tea club', participants: [SELF, ALICE, BOB] });
    expect(convs[2]).toMatchObject({ shape: 'self', name: 'Note to Self' });
    const alice = lines.find((l) => l.t === 'conversation').identities.find((i: P.IdentityFact) => i.nativeId === ALICE);
    expect(alice).toEqual({ nativeId: ALICE, displayName: 'Alice Liddell', handle: '+15550100001' });
    const msgs = lines.filter((l) => l.t === 'message').map((l) => l.m as P.MessageFact);
    const by = (ts: number) => msgs.find((m) => m.ts === ts)!;
    expect(by(T + 1000)).toMatchObject({ nativeId: `${ALICE}:${T + 1000}`, author: ALICE, body: `**hey** <@${SELF}>, look`, mentionsSelf: true, kind: 'text' });
    const reply = by(T + 2000);
    expect(reply).toMatchObject({ author: SELF, body: 'a cat', kind: 'media', replyTo: `${ALICE}:${T + 1000}`, reactions: [{ key: '❤️', authors: [ALICE] }] });
    expect(reply.attachments![0]).toMatchObject({ nativeId: made.attachmentSha, kind: 'image', mime: 'image/png', name: 'cat.png', size: PICTURE.length, width: 64, height: 48 });
    expect(readFileSync(new URL(reply.attachments![0].url))).toEqual(PICTURE);
    // An edit keeps the original's id and says when it was edited.
    expect(by(T + 3000)).toMatchObject({ nativeId: `${ALICE}:${T + 3000}`, body: 'the', editedTs: T + 3500 });
    expect(by(T + 5000)).toMatchObject({ author: BOB, conversation: group, body: 'hello club' });
    expect(by(T + 6000)).toMatchObject({ kind: 'call', body: '📞 Missed voice call' });
    expect(by(T + 7000)).toMatchObject({ kind: 'system', body: 'You updated the group.' });
    expect(by(T + 8000)).toMatchObject({ conversation: `dm:${SELF}:${SELF}`, body: 'remember milk' });
    expect(by(T + 8000).attachments!.map((a) => a.nativeId)).toEqual([made.attachmentSha, `${made.attachmentSha}#1`]);
  });
});

describe('a Molly folder over HTTP', () => {
  let port = 0;
  let base = '';
  let server: HubServer;
  let store: Store;
  const hubDir = join(dir, 'hub');
  const json = async <T = any>(path: string, init?: RequestInit & { body?: any }) => {
    const res = await fetch(base + path, init?.body !== undefined && !(init.body instanceof Uint8Array) ? { ...init, body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : init);
    return { status: res.status, data: (await res.json()) as T };
  };
  const until = async (id: string, done: (v: P.ImportSourceView) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const v = (await json<P.ImportSourceView>(`/api/imports/${id}`)).data;
      if (done(v)) return v;
      await Bun.sleep(25);
    }
    throw new Error('timed out');
  };

  beforeAll(() => {
    mkdirSync(hubDir);
    store = new Store(join(hubDir, 'hub.sqlite'), mediaSigner('s'));
    const acc = store.createAccount({ id: 'acc_sig', network: 'signal', label: 'me', color: '#000', adapter: 'signal', token: 't' } as any);
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: SELF, isSelf: true } });
    // Live sync already has Alice's first message, worded the same.
    store.ingest(store.account('acc_sig')!, { t: 'message', message: { nativeId: `${ALICE}:${T + 1000}`, conversation: `dm:${SELF}:${ALICE}`, author: ALICE, ts: T + 1000, body: `**hey** <@${SELF}>, look` }, live: false });
    const sup = { authorize: () => null, online: () => false } as any;
    server = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: hubDir, webDist: hubDir, secret: 's' });
    port = server.start().port!;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => {
    server.stop();
    store.db.close();
  });

  test('uploads, asks for the recovery key, keeps only the backup key, imports, and a second run adds nothing', async () => {
    const folder = join(dir, 'upload');
    writeSyntheticV2(folder);
    const paths = readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(folder, join(e.parentPath, e.name)));
    const created = await json<P.ImportSourceView>('/api/imports', { method: 'POST', body: { accountId: 'acc_sig', files: paths.map((p) => ({ path: `Backups/${p}`, size: statSync(join(folder, p)).size })) } });
    const id = created.data.id;
    for (let i = 0; i < paths.length; i++) await json(`/api/imports/${id}/data?file=${i}&offset=0`, { method: 'PUT', body: new Uint8Array(readFileSync(join(folder, paths[i]))) });
    let v = await until(id, (v) => v.status !== 'uploading' && v.status !== 'checking');
    expect(v).toMatchObject({ status: 'needs-passphrase', kind: 'signal-folder', importable: true, census: { needs: 'recovery-key', snapshots: 1 } });

    expect((await json(`/api/imports/${id}/passphrase`, { method: 'POST', body: { passphrase: 'nope' } })).status).toBe(400);
    await json(`/api/imports/${id}/passphrase`, { method: 'POST', body: { passphrase: 'b'.repeat(64) } });
    v = await until(id, (v) => v.status === 'needs-passphrase' && !!v.error);
    expect(v.error).toContain('recovery key');
    await json(`/api/imports/${id}/passphrase`, { method: 'POST', body: { passphrase: RECOVERY_KEY.toUpperCase() } });
    v = await until(id, (v) => v.status === 'ready');
    expect((v.census as any).v2).toMatchObject({ chatItems: 10, chats: 4 });
    const sdir = join(hubDir, 'imports/sources', id);
    expect(existsSync(join(sdir, 'passphrase'))).toBe(false);
    expect(readFileSync(join(sdir, 'backup-key'), 'utf8')).toBe(backupKeyFromRecoveryKey(parseRecoveryKey(RECOVERY_KEY)!).toString('hex'));
    expect(statSync(join(sdir, 'backup-key')).mode & 0o077).toBe(0);

    await json(`/api/imports/${id}/run`, { method: 'POST', body: { dryRun: false } });
    v = await until(id, (v) => !!v.run?.finishedAt);
    expect(v.run).toMatchObject({ stage: 'done', counts: { messages: 7, new: 6, same: 1, conflicts: 0 }, files: { linked: 3, missing: 0 } });
    const n = (store.db.query(`SELECT COUNT(*) AS n FROM message WHERE network = 'signal'`).get() as any).n;
    expect(n).toBe(7);
    expect((store.db.query(`SELECT COUNT(*) AS n FROM attachment`).get() as any).n).toBe(3);
    const att = store.db.query(`SELECT url FROM attachment`).get() as any;
    expect(att.url).toStartWith(`file://${join(hubDir, 'imports/media')}`);

    await json(`/api/imports/${id}/run`, { method: 'POST', body: { dryRun: false } });
    v = await until(id, (v) => !!v.run?.finishedAt && v.run.counts?.new === 0);
    expect(v.run!.counts).toMatchObject({ new: 0, same: 7 });
  }, 30_000);
});

describe('comparing with what live sync has', () => {
  test('a placeholder for a file the hub has is the same message; words the hub never had are filled in', () => {
    const store = new Store(join(dir, 'cmp.sqlite'), mediaSigner('s'));
    let acc = store.createAccount({ id: 'acc_s', network: 'signal', label: 'me', color: '#000', adapter: 'signal' } as any);
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: SELF, isSelf: true } });
    acc = store.account('acc_s')!;
    const conversation = `dm:${SELF}:${ALICE}`;
    store.ingest(acc, { t: 'message', message: { nativeId: `${ALICE}:1`, conversation, author: ALICE, ts: 1, kind: 'media', body: '', attachments: [{ kind: 'image', url: 'file:///x.png' }] }, live: false });
    store.ingest(acc, { t: 'message', message: { nativeId: `${ALICE}:2`, conversation, author: ALICE, ts: 2, kind: 'sticker', body: '' }, live: false });
    const counts = store.importBatch(
      acc,
      {
        conversation: { nativeId: conversation, shape: 'direct', participants: [SELF, ALICE] },
        identities: [],
        messages: [
          { nativeId: `${ALICE}:1`, conversation, author: ALICE, ts: 1, kind: 'media', body: '📎 Attachment (not in the backup)' },
          { nativeId: `${ALICE}:2`, conversation, author: ALICE, ts: 2, kind: 'sticker', body: '🐱' },
        ],
      },
      { sourceSha: 'x', runId: 'r', dryRun: false, archiveNew: true, first: true },
    );
    expect(counts).toMatchObject({ same: 1, filled: 1, conflicts: 0 });
    expect((store.db.query(`SELECT body FROM message WHERE ts = 2`).get() as any).body).toBe('🐱');
    expect((store.db.query(`SELECT body FROM message WHERE ts = 1`).get() as any).body).toBe('');
    store.db.close();
  });
});

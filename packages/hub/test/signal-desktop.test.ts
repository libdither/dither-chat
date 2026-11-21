/**
 * Reading a Signal Desktop profile (made up; fixtures/signal-desktop): SQLCipher 4 opened without SQLCipher, rows
 * only in the write-ahead log included; the key from config.json (plain, or wrapped by Electron's basic_text store) or
 * given by hand; attachments sealed at rest; the mapping to the live adapter's facts; then the whole run through the
 * hub, where what live sync already has comes out the same and only the rest is new.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { ImportRunner } from '../src/imports/engine.ts';
import { desktopKey, desktopProfile, mapDesktop, openLocalAttachment, unpackDesktop } from '../src/imports/signal-desktop.ts';
import { ImportSources } from '../src/imports/sources.ts';
import { decryptSqlcipher, WrongKey } from '../src/imports/sqlcipher.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { ATTACHMENTS, GROUP_ID, KEY, OTHER, PEER, SELF, seal, sha256, T, wrapBasicText, writeProfile } from './fixtures/signal-desktop/profile.ts';

const dir = mkdtempSync(join(tmpdir(), 'sigdesk-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Signal Desktop profile reader', () => {
  const profile = join(dir, 'profile');
  const media = join(dir, 'media');
  const plain = join(dir, 'work', 'desktop.sqlite');
  let facts: { conversations: P.ConversationFact[]; identities: P.IdentityFact[]; messages: Map<string, P.MessageFact> };
  let stats: ReturnType<typeof mapDesktop>;

  beforeAll(() => {
    writeProfile(profile);
    unpackDesktop({ profile, key: KEY, dbPath: plain, sourceSha: 'test' });
    facts = { conversations: [], identities: [], messages: new Map() };
    stats = mapDesktop(plain, { selfId: SELF, profile, mediaDir: media }, (x: any) => {
      if (x.t === 'conversation') (facts.conversations.push(x.conversation), facts.identities.push(...x.identities));
      else facts.messages.set(x.m.nativeId, x.m);
    });
  });

  test('a wrong key is told apart and writes nothing', () => {
    const out = join(dir, 'wrong.sqlite');
    expect(() => decryptSqlcipher(join(profile, 'sql/db.sqlite'), Buffer.alloc(32, 1), out)).toThrow(WrongKey);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(out + '.tmp')).toBe(false);
  });

  test('decrypts every page, with what only the write-ahead log holds', () => {
    const db = new Database(plain, { readonly: true });
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.query(`SELECT body FROM messages WHERE id = 'm14'`).get()).toEqual({ body: 'only in the log' });
    expect(JSON.parse((db.query(`SELECT json FROM conversations WHERE id = 'c-grp'`).get() as any).json).name).toBe('Renamed group');
    db.close();
  });

  test('finds the key: plain, wrapped by basic_text, or not in the profile', () => {
    const p = join(dir, 'keys');
    mkdirSync(join(p, 'sql'), { recursive: true });
    writeFileSync(join(p, 'sql/db.sqlite'), '');
    expect(desktopProfile(dir + '/keys')).toBe(p);
    const cfg = (c: unknown) => (writeFileSync(join(p, 'config.json'), JSON.stringify(c)), desktopKey(p));
    expect(cfg({ key: KEY.toString('hex') })).toEqual({ key: KEY });
    expect(cfg({ encryptedKey: wrapBasicText(KEY.toString('hex')), safeStorageBackend: 'basic_text' })).toEqual({ key: KEY });
    // A keyring's own secret, which only that machine has.
    expect(cfg({ encryptedKey: '763131' + 'ab'.repeat(80), safeStorageBackend: 'gnome_libsecret' })).toEqual({ missing: 'keyring' });
    expect(cfg({})).toEqual({ missing: 'config' });
  });

  test('a sealed attachment opens only with its own key', () => {
    const a = ATTACHMENTS[0];
    expect(openLocalAttachment(seal(a.bytes, a.localKey), a.localKey, a.bytes.length, sha256(a.bytes))).toEqual(a.bytes);
    expect(() => openLocalAttachment(seal(a.bytes, a.localKey), Buffer.alloc(64, 8), a.bytes.length)).toThrow();
  });

  test('maps rows to the facts live sync makes', () => {
    const m = (at: number, who = PEER) => facts.messages.get(`${who}:${T + at}`)!;
    expect(stats).toMatchObject({ messages: 10, selfMessages: 3, duplicates: 0, files: { linked: 2, missing: 0 } });
    expect(stats.skipped).toEqual({ deleted: 1, 'group change': 1, story: 1, 'chat without an ACI or a new-style group id': 1, 'safety number': 1 });
    expect(facts.conversations.map((c) => c.nativeId).sort()).toEqual([`dm:${SELF}:${PEER}`, `dm:${SELF}:${SELF}`, `group:${GROUP_ID}`].sort());
    expect(facts.conversations.find((c) => c.shape === 'group')).toMatchObject({ name: 'Renamed group', participants: [SELF, PEER, OTHER] });
    expect(facts.identities.find((i) => i.nativeId === PEER)).toMatchObject({ displayName: 'Pat', handle: '+15550101' });

    expect(m(1000)).toMatchObject({ conversation: `dm:${SELF}:${PEER}`, author: PEER, kind: 'text', body: '**hello** there' });
    const photo = m(2000, SELF);
    expect(photo).toMatchObject({ author: SELF, kind: 'media', body: 'a photo back', replyTo: `${PEER}:${T + 1000}`, reactions: [{ key: '👍', authors: [PEER], at: { [PEER]: T + 2500 } }] });
    // The picture, not the link preview's.
    expect(photo.attachments).toHaveLength(1);
    expect(photo.attachments![0]).toMatchObject({ kind: 'image', mime: 'image/jpeg', name: 'photo.jpg', size: ATTACHMENTS[0].bytes.length, width: 640, height: 480 });
    expect(readFileSync(new URL(photo.attachments![0].url))).toEqual(ATTACHMENTS[0].bytes);
    expect((photo.extra as any).quote).toEqual({ author: PEER, ts: T + 1000, text: 'hello there' });
    expect(m(3000)).toMatchObject({ body: 'final words', editedTs: T + 3500 });
    expect(m(4000)).toMatchObject({ conversation: `group:${GROUP_ID}`, body: `<@${SELF}> look at this`, mentionsSelf: true });
    expect(m(7000)).toMatchObject({ kind: 'sticker', body: '🙂', extra: { sticker: { packId: 'deadbeef', stickerId: 3 } } });
    expect(m(7000).attachments![0]).toMatchObject({ nativeId: 'sticker:deadbeef:3', kind: 'image', name: 'sticker' });
    expect(m(8000, SELF)).toMatchObject({ body: ATTACHMENTS[3].bytes.toString(), extra: { expiresInSeconds: 3600 } });
    expect(m(8000, SELF).attachments).toBeUndefined();
    expect(m(11_000)).toMatchObject({ kind: 'system', body: 'Pat pinned a message.', replyTo: `${PEER}:${T + 4000}` });
    expect(m(12_000)).toMatchObject({ kind: 'media', extra: { viewOnce: true } });
    expect(m(14_000, OTHER)).toMatchObject({ conversation: `group:${GROUP_ID}`, body: 'only in the log' });
    expect(m(15_000, SELF)).toMatchObject({ conversation: `dm:${SELF}:${SELF}`, body: 'a note to myself' });
  });

  test('refuses a Desktop linked to another account', () => {
    expect(() => mapDesktop(plain, { selfId: OTHER, profile, mediaDir: media }, () => {})).toThrow('linked to another account');
  });
});

describe('a Desktop profile through the hub', () => {
  const data = join(dir, 'data');
  const id = 'signal-desktop-test';
  let store: Store;
  let sources: ImportSources;
  let runner: ImportRunner;
  const mid = (at: number, who = PEER) => hubId('msg', 'signal', `${who}:${T + at}`);
  const row = (at: number, who = PEER) => store.db.query('SELECT body, edited_ts, imported FROM message WHERE id = ?').get(mid(at, who)) as any;

  const run = async (dryRun: boolean) => {
    runner.start(id, { dryRun });
    await runner.idle();
    return sources.view(id)!.run!;
  };

  beforeAll(async () => {
    const src = join(data, 'imports/sources', id);
    // Copied in: the profile folder under raw/, and a source.json beside it.
    writeProfile(join(src, 'raw', 'Signal'));
    writeFileSync(join(src, 'source.json'), JSON.stringify({ v: 1, network: 'signal', kind: 'signal-desktop', label: 'Signal Desktop', account: 'acc_sig', addedAt: Date.now(), addedBy: 'copy' }));
    store = new Store(join(data, 'hub.sqlite'), mediaSigner('s'));
    store.createAccount({ id: 'acc_sig', network: 'signal', label: 'signal', color: '#000', adapter: 'signal' });
    let acc = store.account('acc_sig')!;
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: SELF, isSelf: true, displayName: 'Me' } });
    acc = store.account('acc_sig')!;
    const dm = `dm:${SELF}:${PEER}`;
    // Live sync had the first message, and the edited one before its edit.
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: dm, shape: 'direct', participants: [SELF, PEER] } });
    store.ingest(acc, { t: 'message', live: true, message: { nativeId: `${PEER}:${T + 1000}`, conversation: dm, author: PEER, ts: T + 1000, body: '**hello** there' } });
    store.ingest(acc, { t: 'message', live: true, message: { nativeId: `${PEER}:${T + 3000}`, conversation: dm, author: PEER, ts: T + 3000, body: 'first words' } });
    store.flush();
    sources = new ImportSources(data);
    await sources.check(id);
    runner = new ImportRunner(store, sources, data);
  });
  afterAll(() => store.db.close());

  test('the profile is opened with config.json’s key and counted', () => {
    expect(sources.view(id)).toMatchObject({ kind: 'signal-desktop', status: 'ready', importable: true });
    expect(sources.view(id)!.census).toMatchObject({ format: 'signal-desktop', linked: true, messages: 11, firstMonth: '2026-01', conversations: { direct: 4, group: 1 }, attachments: { count: 3, onDisk: 3 } });
    expect(existsSync(join(data, 'imports/work', id, 'desktop.sqlite'))).toBe(true);
  });

  test('an upload holding sql/db.sqlite is a Desktop profile', () => {
    const v = sources.create({ network: 'signal', accountId: 'acc_sig', files: [{ path: 'Signal/config.json', size: 10 }, { path: 'Signal/sql/db.sqlite', size: 10 }] });
    expect(v.kind).toBe('signal-desktop');
    sources.remove(v.id);
  });

  test('a dry run finds what the hub lacks and writes nothing', async () => {
    const r = await run(true);
    expect(r.error).toBeNull();
    expect(r.counts).toMatchObject({ messages: 10, new: 8, same: 1, filled: 1, conflicts: 0 });
    expect(row(14_000, OTHER)).toBeNull();
  });

  test('the import fills the gaps, and running it again changes nothing', async () => {
    const r = await run(false);
    expect(r.counts).toMatchObject({ new: 8, same: 1, filled: 1, conflicts: 0 });
    expect(row(14_000, OTHER)).toMatchObject({ body: 'only in the log', imported: 1 });
    expect(row(3000)).toMatchObject({ body: 'final words', edited_ts: T + 3500, imported: 0 });
    expect(row(1000)).toMatchObject({ body: '**hello** there', imported: 0 });
    const again = await run(false);
    expect(again.counts).toMatchObject({ new: 0, same: 10, filled: 0, conflicts: 0 });
    sources.remove(id);
    expect(existsSync(join(data, 'imports/work', id))).toBe(false);
  });

  test('a key wrapped by a keyring is asked for, and a wrong one forgotten', async () => {
    const kid = 'signal-desktop-keyring';
    const src = join(data, 'imports/sources', kid);
    writeProfile(join(src, 'raw'), { encryptedKey: '763131' + 'ab'.repeat(80), safeStorageBackend: 'gnome_libsecret' });
    writeFileSync(join(src, 'source.json'), JSON.stringify({ v: 1, network: 'signal', kind: 'unknown', label: 'copied in', account: 'acc_sig', addedAt: Date.now(), addedBy: 'copy' }));
    await sources.check(kid);
    expect(sources.view(kid)).toMatchObject({ kind: 'signal-desktop', status: 'needs-passphrase', census: { needs: 'desktop-key' } });
    expect(() => sources.setPassphrase(kid, 'not a key')).toThrow('64 hex digits');
    sources.setPassphrase(kid, `x'${'01'.repeat(32)}'`);
    await sources.check(kid);
    expect(sources.view(kid)).toMatchObject({ status: 'needs-passphrase', error: 'That key does not open this database.', hasPassphrase: false });
    sources.setPassphrase(kid, KEY.toString('hex'));
    await sources.check(kid);
    expect(sources.view(kid)).toMatchObject({ status: 'ready', hasPassphrase: true, census: { messages: 11 } });
  });
});

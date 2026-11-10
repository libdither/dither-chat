/**
 * Reading a legacy Signal `.backup` (made up, written with Molly's framing): the unpack into a private database and the
 * media store, the mapping to the live adapter's facts (edits, quotes, reactions, styles, timers, SMS left out), and
 * Molly keepmsg's kept messages: disappeared and deleted ones come in kept as gone, a message you deleted yourself
 * does not, and a message the hub has as deleted and emptied gets its words back, still deleted. Then the whole run
 * through the hub.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { ImportRunner } from '../src/imports/engine.ts';
import { BadPassphrase } from '../src/imports/signal-backup.ts';
import { type ImportMessageFact, mapLegacy, unpackLegacy } from '../src/imports/signal-legacy.ts';
import { ImportSources } from '../src/imports/sources.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { legacyWriter, SYNTHETIC_PASSPHRASE } from './fixtures/synthetic-backup.ts';

const SELF = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const GROUP_ID = Buffer.alloc(32, 0xab);
const T = Date.UTC(2024, 2, 1);
const PHOTO = Buffer.from('synthetic photo bytes');
const SECURE_IN = 0xa00014; // BASE_INBOX | SECURE | PUSH
const SECURE_OUT = 0xa00017; // BASE_SENT | SECURE | PUSH

/** Bold over the first five characters (BodyRangeList, style BOLD = 0). */
const BOLD5 = Buffer.from([0x0a, 0x06, 0x08, 0x00, 0x10, 0x05, 0x20, 0x00]);

function backup(): Buffer {
  const w = legacyWriter();
  w.sql('CREATE TABLE recipient (_id INTEGER PRIMARY KEY, type INTEGER, e164 TEXT, aci TEXT, username TEXT, group_id TEXT, profile_given_name TEXT, profile_family_name TEXT, nickname_given_name TEXT, nickname_family_name TEXT, system_nickname TEXT, system_given_name TEXT, system_family_name TEXT, system_joined_name TEXT)');
  w.sql('CREATE TABLE thread (_id INTEGER PRIMARY KEY, recipient_id INTEGER, archived INTEGER)');
  w.sql('CREATE TABLE groups (_id INTEGER PRIMARY KEY, group_id TEXT, recipient_id INTEGER, title TEXT, master_key BLOB)');
  w.sql('CREATE TABLE group_membership (_id INTEGER PRIMARY KEY, group_id TEXT, recipient_id INTEGER)');
  w.sql(
    'CREATE TABLE message (_id INTEGER PRIMARY KEY, date_sent INTEGER, thread_id INTEGER, from_recipient_id INTEGER, type INTEGER, body TEXT, expires_in INTEGER, expire_started INTEGER, quote_id INTEGER, quote_author INTEGER, quote_body TEXT, shared_contacts TEXT, view_once INTEGER, remote_deleted INTEGER, mentions_self INTEGER, message_ranges BLOB, story_type INTEGER, parent_story_id INTEGER, latest_revision_id INTEGER, original_message_id INTEGER, deleted_by INTEGER, keepmsg_expired INTEGER, keepmsg_deleted_at INTEGER)',
  );
  w.sql('CREATE TABLE attachment (_id INTEGER PRIMARY KEY, message_id INTEGER, content_type TEXT, file_name TEXT, data_size INTEGER, width INTEGER, height INTEGER, quote INTEGER, sticker_pack_id TEXT, sticker_id INTEGER, sticker_emoji TEXT, display_order INTEGER)');
  w.sql('CREATE TABLE reaction (_id INTEGER PRIMARY KEY, message_id INTEGER, author_id INTEGER, emoji TEXT, date_sent INTEGER, date_received INTEGER)');
  w.sql('CREATE TABLE mention (_id INTEGER PRIMARY KEY, thread_id INTEGER, message_id INTEGER, recipient_id INTEGER, range_start INTEGER, range_length INTEGER)');
  w.sql('CREATE TABLE sessions (_id INTEGER PRIMARY KEY, secret TEXT)');
  w.insert('sessions', [1, 'never written down']);

  const r = (id: number, type: number, aci: string | null, groupId: string | null, given: string | null) => w.insert('recipient', [id, type, null, aci, null, groupId, given, null, null, null, null, null, null, null]);
  r(1, 0, SELF, null, 'Me');
  r(2, 0, PEER, null, 'Pat');
  r(3, 3, null, `__signal_group__v2__!${GROUP_ID.toString('hex')}`, null);
  r(4, 0, null, null, 'SMS only');
  w.insert('groups', [1, `__signal_group__v2__!${GROUP_ID.toString('hex')}`, 3, 'Synthetic group', null]);
  w.insert('group_membership', [1, `__signal_group__v2__!${GROUP_ID.toString('hex')}`, 1]);
  w.insert('group_membership', [2, `__signal_group__v2__!${GROUP_ID.toString('hex')}`, 2]);
  w.insert('thread', [1, 2, 0]);
  w.insert('thread', [2, 3, 1]);
  w.insert('thread', [3, 4, 0]);

  // _id, date_sent, thread, from, type, body, expires_in, expire_started, quote_id, quote_author, quote_body, shared_contacts,
  // view_once, remote_deleted, mentions_self, message_ranges, story_type, parent_story_id, latest_revision_id,
  // original_message_id, deleted_by, keepmsg_expired, keepmsg_deleted_at
  const m = (id: number, at: number, thread: number, from: number, type: number, body: string | null, more: Partial<Record<string, number | string | Uint8Array | null>> = {}) =>
    w.insert('message', [
      id, T + at, thread, from, type, body, more.expires_in ?? 0, more.expire_started ?? 0, more.quote_id ?? 0, more.quote_author ?? 0, more.quote_body ?? null, null,
      0, 0, 0, more.message_ranges ?? null, more.story_type ?? 0, 0, more.latest_revision_id ?? null, more.original_message_id ?? null, more.deleted_by ?? null, more.keepmsg_expired ?? 0, more.keepmsg_deleted_at ?? null,
    ]);
  m(1, 1000, 1, 2, SECURE_IN, 'hello there', { message_ranges: BOLD5 });
  m(2, 2000, 1, 1, SECURE_OUT, 'a photo back', { quote_id: T + 1000, quote_author: 2, quote_body: 'hello there' });
  m(3, 3000, 1, 2, SECURE_IN, 'this one disappeared', { expires_in: 60_000, expire_started: T + 3500, keepmsg_expired: 1 });
  m(4, 4000, 1, 2, SECURE_IN, 'they deleted this', { deleted_by: 2, keepmsg_deleted_at: T + 4500 });
  m(5, 5000, 1, 1, SECURE_OUT, 'I deleted this', { deleted_by: 1, keepmsg_deleted_at: T + 5500 });
  // An edit chain: the original, a middle revision, and the latest, which is what shows.
  m(6, 6000, 1, 2, SECURE_IN, 'first words', { latest_revision_id: 8 });
  m(7, 6500, 1, 2, SECURE_IN, 'second words', { latest_revision_id: 8, original_message_id: 6 });
  m(8, 7000, 1, 2, SECURE_IN, 'final words', { original_message_id: 6 });
  m(9, 8000, 1, 2, 20, 'an sms');
  m(10, 9000, 2, 2, SECURE_IN, 'in the group');
  m(11, 10_000, 1, 2, SECURE_IN | 0x40000, null, { expires_in: 86_400_000 });
  m(12, 11_000, 1, 2, SECURE_IN, '', { deleted_by: 2 });
  m(13, 12_000, 1, 2, SECURE_IN, 'the hub saw this before it disappeared', { expires_in: 60_000, expire_started: T + 12_500, keepmsg_expired: 1 });
  m(14, 13_000, 3, 4, 20, 'sms thread');
  m(15, 14_000, 1, 2, SECURE_IN, 'story', { story_type: 1 });
  w.insert('attachment', [1, 2, 'image/png', 'photo.png', PHOTO.length, 4, 3, 0, null, null, null, 0]);
  w.attachment(1, PHOTO);
  w.insert('attachment', [2, 2, 'image/jpeg', null, 99, 0, 0, 1, null, null, null, 0]); // the quote's thumbnail
  w.insert('reaction', [1, 10, 1, '👍', T + 9500, T + 9500]);
  w.insert('reaction', [2, 6, 1, '🎉', T + 6100, T + 6100]);
  w.keyValue('account.aci');
  return w.done();
}

const dir = mkdtempSync(join(tmpdir(), 'dither-legacy-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'synthetic.backup');
const media = join(dir, 'media');
const dbPath = join(dir, 'legacy.sqlite');
let facts: { conversation: P.ConversationFact; identities: P.IdentityFact[]; messages: ImportMessageFact[] }[] = [];
let mapped: ReturnType<typeof mapLegacy>;

beforeAll(() => {
  writeFileSync(file, backup());
});

describe('legacy .backup reader', () => {
  test('a wrong passphrase is told apart and leaves nothing behind', () => {
    expect(() => unpackLegacy(file, '111111111111111111111111111111', dbPath, media)).toThrow(BadPassphrase);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(dbPath + '.tmp')).toBe(false);
  });

  test('unpacks the tables an import reads, and files by their hash', () => {
    const s = unpackLegacy(file, SYNTHETIC_PASSPHRASE, dbPath, media);
    expect(s.rows.message).toBe(15);
    expect(s.rows.sessions).toBeUndefined();
    expect(s.attachments).toEqual({ count: 1, bytes: PHOTO.length, stored: 1 });
    expect((statSync(dbPath).mode & 0o777).toString(8)).toBe('600');
    const sha = createHash('sha256').update(PHOTO).digest('hex');
    expect(readFileSync(join(media, sha.slice(0, 2), sha + '.png'))).toEqual(PHOTO);
    // Again: the same file is not written twice.
    expect(unpackLegacy(file, SYNTHETIC_PASSPHRASE, dbPath, media).attachments.stored).toBe(0);
  });

  test('maps rows to the facts live sync makes', () => {
    facts = [];
    mapped = mapLegacy(dbPath, { selfId: SELF, mediaDir: media }, (x: any) => {
      if (x.t === 'conversation') facts.push({ conversation: x.conversation, identities: x.identities, messages: [] });
      else facts.at(-1)!.messages.push(x.m);
    });
    const [dm, group] = facts;
    expect(dm.conversation).toMatchObject({ nativeId: `dm:${SELF}:${PEER}`, shape: 'direct' });
    expect(group.conversation).toMatchObject({ nativeId: `group:${GROUP_ID.toString('base64')}`, shape: 'group', name: 'Synthetic group', archived: true, participants: [SELF, PEER] });
    expect(dm.identities.find((i) => i.nativeId === PEER)?.displayName).toBe('Pat');
    const by = new Map(dm.messages.map((m) => [m.ts - T, m]));

    expect(by.get(1000)).toMatchObject({ nativeId: `${PEER}:${T + 1000}`, author: PEER, body: '**hello** there', kind: 'text' });
    const photo = by.get(2000)!;
    expect(photo).toMatchObject({ author: SELF, replyTo: `${PEER}:${T + 1000}`, kind: 'media' });
    expect(photo.attachments).toHaveLength(1);
    expect(photo.attachments![0]).toMatchObject({ kind: 'image', mime: 'image/png', name: 'photo.png', width: 4, height: 3 });
    expect((photo.extra as any).quote).toMatchObject({ author: PEER, ts: T + 1000, attachments: [{ mime: 'image/jpeg' }] });

    expect(by.get(3000)).toMatchObject({ body: 'this one disappeared', gone: { how: 'disappeared', at: T + 3500 + 60_000 } });
    expect(by.get(4000)).toMatchObject({ body: 'they deleted this', gone: { how: 'deleted', at: T + 4500 } });
    expect(by.has(5000)).toBe(false);

    // The edit: named by the original, worded by the latest, reactions on the original carried.
    expect(by.get(6000)).toMatchObject({ nativeId: `${PEER}:${T + 6000}`, editedTs: T + 7000, body: 'final words', reactions: [{ key: '🎉', authors: [SELF] }] });
    expect(by.has(6500) || by.has(7000)).toBe(false);
    expect(by.get(10_000)).toMatchObject({ kind: 'system', body: 'Pat set disappearing messages to 1 day.' });
    expect(group.messages).toMatchObject([{ body: 'in the group', reactions: [{ key: '👍', authors: [SELF] }] }]);

    expect(mapped.gone).toEqual({ deleted: 1, disappeared: 2 });
    expect(mapped.skipped).toMatchObject({ sms: 1, 'deleted by you': 1, 'deleted, nothing kept': 1, story: 1, 'chat not kept': 1 });
    expect(mapped.files).toEqual({ linked: 1, missing: 0 });
    expect(mapped.selfMessages).toBe(1);
  });
});

describe('a .backup through the hub', () => {
  const data = join(dir, 'data');
  const id = 'signal-legacy-test';
  let store: Store;
  let acc: any;
  let sources: ImportSources;
  let runner: ImportRunner;
  const mid = (at: number, who = PEER) => hubId('msg', 'signal', `${who}:${T + at}`);
  const row = (at: number) => store.db.query('SELECT body, deleted, gone_how, gone_at, imported FROM message WHERE id = ?').get(mid(at)) as any;

  const run = async (dryRun: boolean) => {
    runner.start(id, { dryRun });
    for (let i = 0; i < 500; i++) {
      const r = sources.view(id)!.run!;
      if (r.finishedAt) return r;
      await Bun.sleep(10);
    }
    throw new Error('timed out');
  };

  beforeAll(async () => {
    const src = join(data, 'imports/sources', id);
    mkdirSync(join(src, 'raw'), { recursive: true });
    const bytes = readFileSync(file);
    writeFileSync(join(src, 'raw/synthetic.backup'), bytes);
    writeFileSync(join(src, 'passphrase'), SYNTHETIC_PASSPHRASE);
    writeFileSync(join(src, 'source.json'), JSON.stringify({ v: 1, network: 'signal', kind: 'signal-backup', label: 'synthetic.backup', addedAt: Date.now(), addedBy: 'upload', upload: { files: [{ path: 'synthetic.backup', size: bytes.length }] } }));
    store = new Store(join(data, 'hub.sqlite'), mediaSigner('s'));
    acc = store.createAccount({ id: 'acc_sig', network: 'signal', label: 'signal', color: '#000', adapter: 'signal' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: SELF, isSelf: true, displayName: 'Me' } });
    acc = store.account('acc_sig');
    const dm = `dm:${SELF}:${PEER}`;
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: dm, shape: 'direct', participants: [SELF, PEER] } });
    // Live sync saw the deleted message and its delete (emptied: deleted messages aren't kept here), and saw a
    // disappearing one but never its timer running out.
    store.ingest(acc, { t: 'message', live: true, message: { nativeId: `${PEER}:${T + 4000}`, conversation: dm, author: PEER, ts: T + 4000, body: 'they deleted this' } });
    store.ingest(acc, { t: 'delete', conversation: dm, nativeId: `${PEER}:${T + 4000}` });
    store.ingest(acc, { t: 'message', live: true, message: { nativeId: `${PEER}:${T + 12_000}`, conversation: dm, author: PEER, ts: T + 12_000, body: 'the hub saw this before it disappeared' } });
    // And the edited message before its edits.
    store.ingest(acc, { t: 'message', live: true, message: { nativeId: `${PEER}:${T + 6000}`, conversation: dm, author: PEER, ts: T + 6000, body: 'first words' } });
    store.flush();
    expect(row(4000)).toMatchObject({ body: '', deleted: 1, gone_how: 'deleted' });
    sources = new ImportSources(data);
    await sources.check(id);
    sources.patch(id, { accountId: 'acc_sig' });
    runner = new ImportRunner(store, sources, data);
  });
  afterAll(() => store.db.close());

  test('the source is read with its passphrase', () => {
    const v = sources.view(id)!;
    expect(v).toMatchObject({ kind: 'signal-backup', status: 'ready', importable: true });
  });

  test('a dry run counts the kept messages and writes nothing', async () => {
    const r = await run(true);
    expect(r.stage).toBe('done');
    expect(r.counts).toMatchObject({ messages: 8, new: 5, filled: 3, kept: 3, conflicts: 0 });
    expect(row(3000)).toBeNull();
  });

  test('kept messages come in as gone, and the hub’s emptied copy gets its words back', async () => {
    const r = await run(false);
    expect(r.counts).toMatchObject({ new: 5, filled: 3, kept: 3, conflicts: 0 });
    expect(row(1000)).toMatchObject({ body: '**hello** there', deleted: 0, imported: 1 });
    expect(row(3000)).toMatchObject({ body: 'this one disappeared', deleted: 1, gone_how: 'disappeared', gone_at: T + 63_500, imported: 1 });
    expect(row(4000)).toMatchObject({ body: 'they deleted this', deleted: 1, gone_how: 'deleted', imported: 0 });
    expect(row(12_000)).toMatchObject({ body: 'the hub saw this before it disappeared', deleted: 1, gone_how: 'disappeared', gone_at: T + 72_500 });
        expect(store.db.query('SELECT 1 FROM message WHERE id = ?').get(mid(5000, SELF))).toBeNull();
    // A later edit than the hub has is taken, the hub's words kept as the earlier version.
    expect(store.db.query('SELECT body, edited_ts FROM message WHERE id = ?').get(mid(6000))).toEqual({ body: 'final words', edited_ts: T + 7000 });
    expect(store.db.query(`SELECT data FROM message_event WHERE message_id = ? AND kind = 'edit'`).all(mid(6000))).toEqual([{ data: JSON.stringify({ body: 'first words' }) }]);
    // Out of sight while adversarial features are hidden.
    expect(store.retention().adversarial).toBe(false);
    const views = store.messages(hubId('cnv', 'signal', `dm:${SELF}:${PEER}`), null, 50).messages;
    const kept = views.find((v) => v.id === mid(3000))!;
    expect(kept).toMatchObject({ body: '', deleted: true, gone: { how: 'disappeared', kept: false } });
    // The unpacked database stays with the source's work, and goes with it.
    expect(existsSync(join(data, 'imports/work', id, 'legacy.sqlite'))).toBe(true);
    sources.remove(id);
    expect(existsSync(join(data, 'imports/work', id))).toBe(false);
  });
});

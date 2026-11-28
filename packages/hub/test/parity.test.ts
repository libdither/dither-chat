/**
 * Events for messages the hub does not hold are counted and traced, never silently dropped (dropped.ts), and the parity
 * audit (parity.ts) finds what a wrong message id leaves in a database: edits stored as messages, replies to rows not
 * there, reactions missing from edited messages, rows whose message is gone; and, against a Signal Desktop profile
 * (the made-up one in fixtures/signal-desktop), the reactions and edit rows the hub got wrong. Counts only, nothing a
 * person wrote.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { DroppedTargets, DROPPED_TRACE_MS } from '../src/dropped.ts';
import { mapDesktop, unpackDesktop } from '../src/imports/signal-desktop.ts';
import { anonId, auditHubInvariants, diffSignalDesktop } from '../src/parity.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { setTraceSink, type SpanRecord } from '../src/trace.ts';
import { KEY, PEER, SELF, T, writeProfile } from './fixtures/signal-desktop/profile.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-parity-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SECRET = 'a private sentence nobody should see';
const EMOJI = '🦑';

function newStore(name: string) {
  const store = new Store(join(dir, `${name}.sqlite`), (raw) => raw ?? null);
  const acc = store.createAccount({ network: 'signal', label: 'signal', color: '#000', adapter: 'signal' });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'c1', shape: 'group', name: 'c1' } });
  return { store, acc: store.account(acc.id)! };
}

const msg = (store: Store, acc: AccountRow, nativeId: string, ts: number, more: Partial<P.MessageFact> = {}) =>
  store.ingest(acc, { t: 'message', live: false, message: { nativeId, conversation: 'c1', author: 'pat', ts, body: SECRET, ...more } });

describe('events for messages the hub does not hold', () => {
  const spans: SpanRecord[] = [];
  let store: Store;
  let acc: AccountRow;

  beforeAll(() => {
    ({ store, acc } = newStore('dropped'));
    msg(store, acc, 'held', 1000);
    setTraceSink((r) => spans.push(r));
  });
  afterAll(() => {
    setTraceSink(null);
    store.db.close();
  });

  const dropped = () => spans.filter((s) => s.name === 'dropped target');

  test('each kind is counted and traced, with ids and counts only', () => {
    const before = store.db.query('SELECT COUNT(*) AS n FROM reaction').get();
    store.ingest(acc, { t: 'reaction', conversation: 'c1', message: 'gone', author: 'pat', key: EMOJI });
    store.ingest(acc, { t: 'pin', conversation: 'c1', message: 'gone', pinned: true });
    store.ingest(acc, { t: 'delete', conversation: 'c1', nativeId: 'gone' });
    store.ingest(acc, { t: 'pollUpdate', conversation: 'c1', message: 'gone', add: { yes: 1 } });
    store.ingest(acc, { t: 'reactionsCleared', conversation: 'c1', message: 'gone', key: EMOJI });
    msg(store, acc, 'answer', 2000, { replyTo: 'gone', extra: { quote: { text: SECRET } } });
    // Nothing was stored for them.
    expect(store.db.query('SELECT COUNT(*) AS n FROM reaction').get()).toEqual(before);

    const kinds = ['reaction', 'pin', 'delete', 'pollUpdate', 'reactionsCleared', 'replyTo'];
    expect(store.droppedTargets().map((d) => [d.network, d.kind, d.count]).sort()).toEqual(kinds.map((k) => ['signal', k, 1]).sort());
    expect(dropped().map((s) => s.attrs).sort((a, b) => String(a.kind).localeCompare(String(b.kind)))).toEqual(
      kinds.sort().map((kind) => ({ network: 'signal', account: acc.id, kind, count: 1 })),
    );
    const text = JSON.stringify(spans);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(EMOJI);
  });

  test('a held message is not a drop, nor is the same reply stored again', () => {
    const n = dropped().length;
    store.ingest(acc, { t: 'reaction', conversation: 'c1', message: 'held', author: 'pat', key: EMOJI });
    store.ingest(acc, { t: 'pin', conversation: 'c1', message: 'held', pinned: true });
    msg(store, acc, 'reply-held', 3000, { replyTo: 'held' });
    // Backfill sending the reply to a missing message again: counted once, when it was first stored.
    msg(store, acc, 'answer', 2000, { replyTo: 'gone' });
    expect(dropped().length).toBe(n);
    expect(store.droppedTargets().find((d) => d.kind === 'replyTo')!.count).toBe(1);
  });

  test('more in a burst are counted, and traced once per window with the count folded in', () => {
    for (let i = 0; i < 5; i++) store.ingest(acc, { t: 'reaction', conversation: 'c1', message: `gone-${i}`, author: 'pat', key: EMOJI });
    expect(store.droppedTargets().find((d) => d.kind === 'reaction')!.count).toBe(6);

    // The window, on a clock of its own.
    let now = 0;
    const d = new DroppedTargets(() => now);
    const out: SpanRecord[] = [];
    setTraceSink((r) => out.push(r));
    try {
      const a = { id: 'acc_test', network: 'discord' };
      d.note(a, 'reaction');
      now = 1;
      d.note(a, 'reaction');
      d.note(a, 'reaction');
      now = DROPPED_TRACE_MS + 1;
      d.note(a, 'reaction');
      expect(out.map((s) => s.attrs.count)).toEqual([1, 3]);
      expect(d.list()).toEqual([{ network: 'discord', kind: 'reaction', count: 4, lastAt: DROPPED_TRACE_MS + 1 }]);
    } finally {
      setTraceSink((r) => spans.push(r));
    }
  });
});

describe('auditHubInvariants', () => {
  test('a clean database has no anomalies', () => {
    const { store, acc } = newStore('clean');
    msg(store, acc, 'a', 1000);
    msg(store, acc, 'b', 2000, { editedTs: 2500, replyTo: 'a', reactions: [{ key: EMOJI, authors: ['sam'] }] });
    msg(store, acc, 'c', 3000, { reactions: [{ key: EMOJI, authors: ['sam'] }] });
    const path = join(dir, 'clean.sqlite');
    store.db.close();
    const db = new Database(path, { readonly: true });
    const r = auditHubInvariants(db);
    db.close();
    expect(r.anomalies).toEqual([]);
    expect(r.orphans).toEqual({ reactions: 0, tallies: 0, attachments: 0, events: 0 });
    expect(r.networks).toEqual([
      expect.objectContaining({ network: 'signal', messages: 3, chainedEditDuplicates: 0, danglingReplies: { count: 0, withQuote: 0, targetsEditedTs: 0 }, editedReactionDrop: false }),
    ]);
  });

  test('finds edits stored as messages, replies to edited times, edits without reactions and orphan rows', () => {
    const { store, acc } = newStore('broken');
    // Signal's edit chain gone wrong: the original, edited at 20_000, and the edit stored as a message of its own.
    msg(store, acc, 'pat:10000', 10_000, { editedTs: 20_000 });
    msg(store, acc, 'pat:20000', 20_000);
    // A reply quoting the edit's time, naming an id with no row; and one with no quote at all.
    msg(store, acc, 'sam:30000', 30_000, { author: 'sam', replyTo: 'pat:20001', extra: { quote: { author: 'pat', ts: 20_000, text: SECRET } } });
    msg(store, acc, 'sam:30001', 30_001, { author: 'sam', replyTo: 'nowhere' });
    // Plenty of unedited messages reacted to, and edited ones that never are: their reactions went nowhere.
    for (let i = 0; i < 20; i++) msg(store, acc, `u${i}`, 40_000 + i, { ...(i % 2 ? { reactions: [{ key: EMOJI, authors: ['sam'] }] } : {}) });
    for (let i = 0; i < 12; i++) msg(store, acc, `e${i}`, 50_000 + i, { editedTs: 60_000 + i });
    const path = join(dir, 'broken.sqlite');
    store.db.close();
    // Rows whose message is gone, as only a connection without foreign keys could leave them.
    const raw = new Database(path);
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.query(`INSERT INTO reaction (message_id, identity_id, key) VALUES ('msg_gone', 'idn_x', ?)`).run(EMOJI);
    raw.query(`INSERT INTO attachment (id, message_id, kind, url) VALUES ('att_x', 'msg_gone', 'image', 'x')`).run();
    raw.close();

    const db = new Database(path, { readonly: true });
    const r = auditHubInvariants(db, { samples: 2 });
    db.close();
    const sig = r.networks.find((n) => n.network === 'signal')!;
    expect(sig.chainedEditDuplicates).toBe(1);
    expect(sig.danglingReplies).toEqual({ count: 2, withQuote: 1, targetsEditedTs: 1 });
    expect(sig.edited.reacted).toBe(0);
    expect(sig.edited.messages).toBe(13);
    expect(sig.unedited.reacted).toBe(10);
    expect(sig.editedReactionDrop).toBe(true);
    expect(r.orphans).toEqual({ reactions: 1, tallies: 0, attachments: 1, events: 0 });
    expect(r.anomalies.map((a) => [a.check, a.network, a.count])).toEqual(
      expect.arrayContaining([
        ['chainedEditDuplicates', 'signal', 1],
        ['danglingRepliesToEdits', 'signal', 1],
        ['editedReactionDrop', 'signal', 13],
        ['orphanReactions', null, 1],
        ['orphanAttachments', null, 1],
      ]),
    );
    // Named by hashes unless asked, and nothing anyone wrote.
    const cid = hubId('cnv', 'signal', 'c1');
    expect(r.samples.chainedEditDuplicates).toEqual([{ conversation: anonId(cid), edited: anonId(hubId('msg', 'signal', 'pat:10000')), duplicate: anonId(hubId('msg', 'signal', 'pat:20000')) }]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(EMOJI);

    const shown = new Database(path, { readonly: true });
    expect(auditHubInvariants(shown, { showIds: true }).samples.chainedEditDuplicates[0]!.conversation).toBe(cid);
    expect(auditHubInvariants(shown, { network: 'discord' }).networks).toEqual([]);
    shown.close();
  });
});

describe('diffSignalDesktop', () => {
  const profile = join(dir, 'profile');
  let store: Store;
  let path: string;
  const read = (fn: (db: Database) => unknown) => {
    const db = new Database(path, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  beforeAll(() => {
    writeProfile(profile);
    // The hub got what Desktop has, the way live sync names it.
    const plain = join(dir, 'work', 'desktop.sqlite');
    unpackDesktop({ profile, key: KEY, dbPath: plain, sourceSha: 'test' });
    path = join(dir, 'desktop-hub.sqlite');
    store = new Store(path, (raw) => raw ?? null);
    let acc = store.createAccount({ network: 'signal', label: 'signal', color: '#000', adapter: 'signal' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: SELF, isSelf: true } });
    acc = store.account(acc.id)!;
    mapDesktop(plain, { selfId: SELF, profile, mediaDir: join(dir, 'media') }, (x: any) => {
      if (x.t === 'conversation') store.ingest(acc, { t: 'conversation', conversation: x.conversation });
      else store.ingest(acc, { t: 'message', live: false, message: x.m });
    });
    store.flush();
  });
  afterAll(() => store.db.close());

  test('a hub that matches Desktop shows no mismatch', () => {
    const d = read((db) => diffSignalDesktop(db, { profile })) as ReturnType<typeof diffSignalDesktop>;
    expect(d.window).toEqual({ from: T + 1000, to: T + 15_000 });
    expect(d.mismatches).toEqual([]);
    expect(d.conversations).toBe(3);
    expect(d.matching).toBe(3);
    expect(d.hub).toEqual(d.desktop);
    expect(d.desktop).toMatchObject({ edited: 1, reactions: 1, attachments: 2 });
  });

  test('finds a dropped reaction and an edit stored as a message', () => {
    const dm = `dm:${SELF}:${PEER}`;
    // The reaction on the photo went missing, and the edit of "final words" came in as a message of its own.
    store.db.query('DELETE FROM reaction WHERE message_id = ?').run(hubId('msg', 'signal', `${SELF}:${T + 2000}`));
    store.ingest(store.account(store.accounts()[0]!.id)!, { t: 'message', live: false, message: { nativeId: `${PEER}:${T + 3500}`, conversation: dm, author: PEER, ts: T + 3500, body: 'final words' } });
    const d = read((db) => diffSignalDesktop(db, { profile })) as ReturnType<typeof diffSignalDesktop>;
    expect(d).toMatchObject({ reactionsMissing: 1, editDuplicates: 1, extraInHub: 1, missingInHub: 0, matching: 2 });
    expect(d.mismatches).toHaveLength(1);
    const c = d.mismatches[0]!;
    expect(c).toMatchObject({ conversation: anonId(hubId('cnv', 'signal', dm)), shape: 'direct', reactionsMissing: 1, editDuplicates: 1, extraInHub: 1 });
    expect(c.desktop.messages + 1).toBe(c.hub.messages);
    expect(c.hub.reactions).toBe(c.desktop.reactions - 1);
    // Only counts and hashes: no words, names or emoji.
    const text = JSON.stringify(d);
    for (const s of ['final words', 'hello', 'Pat', '👍', PEER]) expect(text).not.toContain(s);
    // The real id when asked for, and only the last days when asked for.
    expect((read((db) => diffSignalDesktop(db, { profile }, { showIds: true })) as ReturnType<typeof diffSignalDesktop>).mismatches[0]!.conversation).toBe(hubId('cnv', 'signal', dm));
    const late = read((db) => diffSignalDesktop(db, { profile }, { days: 1, now: T + 4000 + 86_400_000 })) as ReturnType<typeof diffSignalDesktop>;
    expect(late.window).toEqual({ from: T + 4000, to: T + 15_000 });
    expect(late.mismatches).toEqual([]);
  });
});

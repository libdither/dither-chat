/** Reply marks (replymarks.ts, docs/inbox.md "Marks"): "No reply needed" settles as dismissed, "Reply needed" holds. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { Attention, emptyTally, foldMessage, freshState, scoreConversation, WEIGHTS, type ConvState, type FoldMessage, type Settled, type Tally } from '../src/attention.ts';
import { NEEDS_HOLD, ReplyMarks } from '../src/replymarks.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 9);

const msg = (m: Partial<FoldMessage> & { ts: number }): FoldMessage => ({ id: `m${m.ts}`, author: 'sam', authorKey: 'p_sam', mine: false, bot: false, mentionsMe: false, repliesToMe: false, question: false, pushed: false, ignore: false, ...m });

describe('the fold', () => {
  const dm = { shape: 'direct' as const, members: 2 };
  const group = { shape: 'group' as const, members: 30 };

  test('"No reply needed" settles what was owed up to the message, as dismissed: neither addressed nor answered', () => {
    const s = freshState();
    const tallies = new Map<string, Tally>();
    const tallyOf = (k: string) => tallies.get(k) ?? tallies.set(k, emptyTally()).get(k)!;
    const closed: Settled[] = [];
    foldMessage(s, tallyOf, msg({ ts: T0 }), dm, (t) => closed.push(t));
    foldMessage(s, tallyOf, msg({ ts: T0 + MIN, clearedByMe: true }), dm, (t) => closed.push(t));
    expect(s.turn).toBeNull();
    expect(closed).toEqual([{ addressed: T0, kind: 'direct', authorKey: 'p_sam', answeredAt: null, timed: false, dismissed: true }]);
    expect(s.tally.addressed).toBe(0);
    expect(s.tally.replied).toBe(0);
    expect(s.tally.dismissed).toBe(1);
    expect(tallyOf('p_sam').dismissed).toBe(1);
    // What they write after it is owed afresh.
    foldMessage(s, tallyOf, msg({ ts: T0 + HOUR }), dm);
    expect(s.turn?.addressed).toBe(T0 + HOUR);
  });

  test('a reaction is an answer, whatever the mark says', () => {
    const s = freshState();
    foldMessage(s, () => emptyTally(), msg({ ts: T0 }), dm);
    foldMessage(s, () => emptyTally(), msg({ ts: T0 + 1, reactedByMe: true, clearedByMe: true }), dm);
    expect(s.tally.replied).toBe(1);
    expect(s.tally.dismissed ?? 0).toBe(0);
  });

  test('"Reply needed" holds the turn; on a message not meant for you it makes one', () => {
    const s: ConvState = freshState();
    foldMessage(s, () => emptyTally(), msg({ ts: T0 }), group);
    expect(s.turn?.addressed ?? null).toBeNull();
    foldMessage(s, () => emptyTally(), msg({ ts: T0 + MIN, neededByMe: T0 + HOUR }), group);
    expect(s.turn).toMatchObject({ addressed: T0 + MIN, kind: 'marked', held: T0 + HOUR });
    // Your answer ends it.
    foldMessage(s, () => emptyTally(), msg({ ts: T0 + 2 * HOUR, mine: true, author: 'me', authorKey: 'me' }), group);
    expect(s.turn).toBeNull();
  });

  test('held, it is owed in full at any age for a week from the mark, and says so', () => {
    const s = freshState();
    foldMessage(s, () => emptyTally(), msg({ ts: T0, neededByMe: T0 + HOUR }), dm);
    const at = (now: number) => scoreConversation({ now, shape: 'direct', members: 2, lastMessageAt: T0, state: s, author: null, authorName: 'Sam', unread: 0, mentions: 0, pinged: null, muted: null, usage: null });
    const held = at(T0 + 5 * DAY);
    expect(held.parts.owed).toBe(WEIGHTS.owed);
    expect(held.needs).toBe(true);
    expect(held.owedSince).toBe(T0);
    expect(held.owed?.held).toBe(true);
    expect(held.reasons[0]).toBe('You marked it Reply needed; unanswered for 5 days');
    const after = at(T0 + HOUR + NEEDS_HOLD + MIN);
    expect(after.owed?.held).toBeUndefined();
    expect(after.parts.owed ?? 0).toBe(0);
  });
});

describe('marks in the hub', () => {
  let dir: string;
  let store: Store;
  let att: Attention;
  let marks: ReplyMarks;
  let a1: AccountRow;
  let a2: AccountRow;
  let clock = T0;
  let n = 0;
  const say = (acc: AccountRow, conversation: string, author: string, ts: number) => {
    const nativeId = `m${++n}`;
    store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts, body: '' }, live: true });
    return (store.db.query('SELECT id FROM message WHERE native_id = ?').get(nativeId) as { id: string }).id;
  };
  const cid = (acc: AccountRow, native: string) => (store.db.query('SELECT id FROM conversation WHERE native_id = ? AND network = ?').get(native, acc.network) as { id: string }).id;
  const state = (c: string) => JSON.parse((store.db.query('SELECT state FROM conv_feature WHERE conversation_id = ?').get(c) as { state: string }).state) as ConvState;
  /** The store's changes, then the refold a mark asks for (after the quiet a few seconds give it), and the scores. */
  const settle = () => {
    store.flush();
    att.sync([]);
    clock += 10_000;
    while (att.pump() > 0);
    const out: P.ClientEvent[] = [];
    out.push(...att.sync([]));
    while (att.busy) out.push(...att.sync([]));
    return out;
  };
  const view = (c: string) => att.list().find((v) => v.id === c);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-marks-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    for (const [label, network] of [['a', 'matrix'], ['b', 'discord']] as const) {
      let acc = store.createAccount({ network, label, color: '#000', adapter: network });
      store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: `me-${label}`, displayName: 'Me' } });
      acc = store.account(acc.id)!;
      store.ingest(acc, { t: 'identity', identity: { nativeId: `sam-${label}`, displayName: 'Sam', contact: true } });
      store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: [`me-${label}`, `sam-${label}`] } });
      if (label === 'a') a1 = acc;
      else a2 = acc;
    }
    // Sam on both networks is one person: one chat of two routes.
    const person = (acc: AccountRow, native: string) => (store.db.query('SELECT person_id FROM identity WHERE native_id = ? AND network = ?').get(native, acc.network) as { person_id: string }).person_id;
    store.mergePersons(person(a1, 'sam-a'), person(a2, 'sam-b'));
    att = new Attention(store, new Triage(store), () => clock);
    att.rescoreAll(T0);
    store.flush();
    marks = new ReplyMarks(store);
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a chat of several routes is one chat to a mark', () => {
    expect(new Set(marks.routesOf(cid(a1, 'dm')))).toEqual(new Set([cid(a1, 'dm'), cid(a2, 'dm')]));
  });

  test('"No reply needed" on a message clears the turn on every route of the chat, kept as dismissed; undo brings it back', () => {
    clock = T0 + HOUR;
    say(a2, 'dm', 'sam-b', T0 - 30 * MIN);
    const m = say(a1, 'dm', 'sam-a', T0);
    settle();
    expect(state(cid(a1, 'dm')).turn?.addressed).toBe(T0);
    expect(state(cid(a2, 'dm')).turn?.addressed).toBe(T0 - 30 * MIN);
    expect(view(cid(a1, 'dm'))?.owedSince).toBe(T0);

    const r = marks.setMessage(m, 'none', { surface: 'message', device: 'dev1', now: clock })!;
    expect(r.marked).toHaveLength(2);
    expect(store.messageView(m)?.replyMark).toBe('none');
    settle();
    expect(state(cid(a1, 'dm')).turn).toBeNull();
    expect(state(cid(a2, 'dm')).turn).toBeNull();
    expect(view(cid(a1, 'dm'))?.owedSince ?? null).toBeNull();
    expect(store.db.query('SELECT COUNT(*) AS n FROM owed_turn WHERE dismissed = 1').get()).toEqual({ n: 2 });

    // Taken back: both routes owe again, and the rows stay with when they were undone.
    marks.setMessage(m, null, { now: clock });
    expect(store.messageView(m)?.replyMark).toBeUndefined();
    settle();
    expect(state(cid(a1, 'dm')).turn?.addressed).toBe(T0);
    expect(state(cid(a2, 'dm')).turn?.addressed).toBe(T0 - 30 * MIN);
    expect(store.db.query('SELECT COUNT(*) AS n FROM reply_mark WHERE undone_at IS NOT NULL').get()).toEqual({ n: 2 });
  });

  test('"Reply needed" on a row holds the newest message of the chat, without notifying; your answer ends it', () => {
    const r = marks.setRow([cid(a1, 'dm')], 'needs', { device: 'dev1', now: clock });
    expect(r.marked).toHaveLength(1);
    const pushes = store.db.query('SELECT COUNT(*) AS n FROM triage').get();
    settle();
    // Days later it still needs you, flagged as marked.
    clock = T0 + 5 * DAY;
    att.rescoreAll(clock);
    expect(view(cid(a1, 'dm'))).toMatchObject({ needs: true, replyMark: 'needs', owedSince: T0 });
    expect(store.db.query('SELECT COUNT(*) AS n FROM triage').get()).toEqual(pushes);
    say(a1, 'dm', 'me-a', clock);
    settle();
    expect(view(cid(a1, 'dm'))?.replyMark).toBeUndefined();
  });

  test('"No reply needed" on a row marks each route\'s newest message from them; a message of yours cannot be marked', () => {
    clock += HOUR;
    say(a1, 'dm', 'sam-a', clock - 2 * MIN);
    say(a2, 'dm', 'sam-b', clock - MIN);
    settle();
    const r = marks.setRow([cid(a1, 'dm')], 'none', { now: clock });
    expect(r.marked).toHaveLength(2);
    settle();
    expect(state(cid(a1, 'dm')).turn).toBeNull();
    expect(state(cid(a2, 'dm')).turn).toBeNull();
    const mine = say(a1, 'dm', 'me-a', clock);
    expect(marks.setMessage(mine, 'none')).toBeNull();
    expect(marks.setRow([cid(a1, 'dm')], 'none').marked).toEqual([]);
  });

  test('marks stay when the activity log is deleted', async () => {
    const { ActivityStore } = await import('../src/activity.ts');
    const before = store.db.query('SELECT COUNT(*) AS n FROM reply_mark').get();
    new ActivityStore(store).clear();
    expect(store.db.query('SELECT COUNT(*) AS n FROM reply_mark').get()).toEqual(before);
  });
});

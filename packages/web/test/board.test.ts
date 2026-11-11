/** src/board.ts: How it sorts' four sections, its lines per conversation, and the badge counted from them. */
import { expect, test } from 'bun:test';
import { BELOW_DAYS, BELOW_SHOWN, isMailItem, lineKey, linesOf, listPreview, reasonsOf, topImportance, topTier, triageBoard, type BoardItem } from '../src/board.ts';

const DAY = 86_400_000;
const now = 100 * DAY;
const msg = (id: string, decision: string, x: { feedback?: string | null; marks?: { alert?: boolean; less?: boolean }; ts?: number; score?: number | null; conv?: string; reasons?: string[] } = {}): any => ({
  id,
  conversationId: x.conv ?? 'cnv_a',
  ts: x.ts ?? now - 1000,
  triage: { decision, feedback: x.feedback ?? null, score: x.score === undefined ? 0.5 : x.score, reasons: x.reasons ?? [], ...(x.marks ? { marks: x.marks } : {}) },
});
const all = () => true;
const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

test('four sections, by the tier each message landed in: Alerts, Conversations, List, Below the list', () => {
  const b = triageBoard([msg('a', 'push'), msg('b', 'quiet'), msg('c', 'digest'), msg('d', 'drop'), msg('e', 'silent')], { now, shown: all, unread: all });
  expect(ids(b.alerts)).toEqual(['a']);
  expect(ids(b.conversations)).toEqual(['b']);
  expect(ids(b.list)).toEqual(['c']);
  expect(ids(b.below)).toEqual(['d']);
  // A silenced place is in none of them.
  expect([...b.alerts, ...b.conversations, ...b.list, ...b.below].some((m) => m.id === 'e')).toBe(false);
});

test('a mark, or a vote from before the tiers, does not move a message: it stays where it was decided', () => {
  const b = triageBoard(
    [msg('a', 'push', { marks: { alert: false } }), msg('b', 'quiet', { marks: { alert: true } }), msg('c', 'digest', { marks: { less: true } }), msg('d', 'digest', { feedback: 'push' }), msg('e', 'push', { feedback: 'drop' })],
    { now, shown: all, unread: all },
  );
  expect(ids(b.alerts).sort()).toEqual(['a', 'e']);
  expect(ids(b.conversations)).toEqual(['b']);
  expect(ids(b.list).sort()).toEqual(['c', 'd']);
  expect(ids(b.below)).toEqual([]);
});

test('the badge is the unread alerts and the unread Conversation messages; the list and below it never count', () => {
  const unread = new Set(['a', 'b', 'c', 'e', 'g']);
  const items = [msg('a', 'push'), msg('b', 'push'), msg('c', 'quiet'), msg('d', 'quiet'), msg('e', 'digest'), msg('f', 'push'), msg('g', 'drop')];
  const b = triageBoard(items, { now, shown: all, unread: (m) => unread.has(m.id) });
  expect(b.alertsUnread).toBe(2);
  expect(b.conversationsUnread).toBe(1);
  expect(b.alerts).toHaveLength(3);
  expect(b.conversations).toHaveLength(2);
  // Each count is of what its section shows.
  expect(b.alertsUnread).toBe(b.alerts.filter((m) => unread.has(m.id)).length);
  expect(b.conversationsUnread).toBe(b.conversations.filter((m) => unread.has(m.id)).length);
  // Read, they leave the badge and stay in their sections.
  const read = triageBoard(items, { now, shown: all, unread: () => false });
  expect([read.alertsUnread, read.conversationsUnread]).toEqual([0, 0]);
  expect(read.alerts).toHaveLength(3);
});

test('a week for the sections, two days for below the list, places you hid left out', () => {
  const b = triageBoard(
    [
      msg('old', 'push', { ts: now - 8 * DAY }),
      msg('old-conv', 'quiet', { ts: now - 8 * DAY }),
      msg('week', 'digest', { ts: now - 6 * DAY }),
      msg('drop-old', 'drop', { ts: now - (BELOW_DAYS + 1) * DAY }),
      msg('drop-new', 'drop', { ts: now - DAY }),
      msg('hidden', 'push', { conv: 'cnv_hidden' }),
      msg('silent', 'silent'),
    ],
    { now, shown: (m) => m.conversationId !== 'cnv_hidden', unread: all },
  );
  expect(ids(b.alerts)).toEqual([]);
  expect(ids(b.conversations)).toEqual([]);
  expect(ids(b.list)).toEqual(['week']);
  expect(ids(b.below)).toEqual(['drop-new']);
  expect(b.alertsUnread).toBe(0);
  expect(b.conversationsUnread).toBe(0);
});

test('orders: newest first for Alerts and Conversations, the most important first for the list and below it', () => {
  const b = triageBoard(
    [
      msg('p1', 'push', { ts: now - 3000 }),
      msg('p2', 'push', { ts: now - 1000 }),
      msg('q1', 'quiet', { ts: now - 4000, score: 0.9 }),
      msg('q2', 'quiet', { ts: now - 2000, score: 0.1 }),
      msg('d1', 'digest', { score: 0.2 }),
      msg('d2', 'digest', { score: 0.9 }),
      msg('d3', 'digest', { score: 0.9, ts: now - 500 }),
      msg('d4', 'digest', { score: null }),
    ],
    { now, shown: all, unread: all },
  );
  expect(ids(b.alerts)).toEqual(['p2', 'p1']);
  expect(ids(b.conversations)).toEqual(['q2', 'q1']);
  // The same importance: the newer first. None at all: last.
  expect(ids(b.list)).toEqual(['d3', 'd2', 'd1', 'd4']);
  const many = Array.from({ length: BELOW_SHOWN + 5 }, (_, i) => msg(`x${i}`, 'drop', { score: i / 100 }));
  const below = triageBoard(many, { now, shown: all, unread: all }).below;
  expect(below).toHaveLength(BELOW_SHOWN);
  expect(below[0].id).toBe(`x${BELOW_SHOWN + 4}`);
  expect(below.at(-1)!.id).toBe('x5');
});

test('two messages of one importance that came at once keep their order, whichever was handed over last', () => {
  const a = msg('a', 'digest', { score: 0.8, conv: 'cnv_a' });
  const b = msg('b', 'digest', { score: 0.8, conv: 'cnv_b' });
  const p = msg('p', 'push');
  const q = msg('q', 'push');
  const o = { now, shown: all, unread: all };
  // A mark sends the message again, after the others: its line must not jump.
  expect(ids(triageBoard([a, b, p, q], o).list)).toEqual(['a', 'b']);
  expect(ids(triageBoard([b, q, p, { ...a, triage: { ...a.triage, marks: { less: true } } }], o).list)).toEqual(['a', 'b']);
  expect(ids(triageBoard([a, b, p, q], o).alerts)).toEqual(['p', 'q']);
  expect(ids(triageBoard([q, p, b, a], o).alerts)).toEqual(['p', 'q']);
});

test('mail sits beside chat in the same sections, its unread counting in the badge (slice 9)', () => {
  const mail = (id: string, decision: string, x: { marks?: { less?: boolean }; ts?: number; unread?: boolean } = {}): any => ({
    kind: 'mail',
    id,
    threadId: 'mth_a',
    accountId: 'acc_mail',
    from: { name: 'Sam', email: 'sam@x.example' },
    subject: 'Dinner',
    preview: null,
    ts: x.ts ?? now - 500,
    unread: x.unread ?? true,
    triage: { decision, feedback: null, score: 0.5, reasons: [], decidedBy: 'rules', ...(x.marks ? { marks: x.marks } : {}) },
  });
  const items: BoardItem[] = [msg('a', 'push'), mail('mml_1', 'push'), mail('mml_2', 'digest', { marks: { less: true } }), mail('mml_3', 'digest', { unread: false }), mail('mml_4', 'drop')];
  const b = triageBoard(items, { now, shown: all, unread: (m) => (isMailItem(m) ? m.unread : true) });
  expect(ids(b.alerts)).toEqual(['mml_1', 'a']);
  expect(ids(b.conversations)).toEqual([]);
  expect(ids(b.list).sort()).toEqual(['mml_2', 'mml_3']);
  expect(ids(b.below)).toEqual(['mml_4']);
  expect(b.alertsUnread).toBe(2);
  expect(b.alerts.filter(isMailItem).map((m) => m.threadId)).toEqual(['mth_a']);
});

test('one line per conversation: where its first message in the section is, its marks on its newest', () => {
  const b = triageBoard(
    [
      msg('g1', 'push', { conv: 'cnv_g', ts: now - 4000 }),
      msg('d1', 'push', { conv: 'cnv_d', ts: now - 3000 }),
      msg('g2', 'push', { conv: 'cnv_g', ts: now - 2000 }),
      msg('g3', 'push', { conv: 'cnv_g', ts: now - 1000 }),
      msg('g4', 'quiet', { conv: 'cnv_g', ts: now - 500 }),
    ],
    { now, shown: all, unread: all },
  );
  const lines = linesOf(b.alerts, lineKey);
  expect(lines.map((l) => [l.key, ids(l.items), l.newest.id])).toEqual([
    ['cnv_g', ['g3', 'g2', 'g1'], 'g3'],
    ['cnv_d', ['d1'], 'd1'],
  ]);
  // Its newest in Conversations is on a line of its own there.
  expect(linesOf(b.conversations, lineKey).map((l) => [l.key, l.newest.id])).toEqual([['cnv_g', 'g4']]);
  // By importance on the list: the newest is still the newest, wherever it sits in the line.
  const d = linesOf([msg('a', 'digest', { ts: now - 10 }), msg('b', 'digest', { ts: now - 5 })], lineKey);
  expect(d[0].newest.id).toBe('b');
});

test('a mail thread is a line of its own', () => {
  const m: any = { kind: 'mail', id: 'mml_1', threadId: 'mth_a', ts: now, triage: { decision: 'push', feedback: null, score: 0.5, reasons: [] } };
  expect(linesOf([msg('a', 'push'), m], lineKey).map((l) => l.key)).toEqual(['cnv_a', 'mth_a']);
});

test("a line's reasons are each said once, the commonest first", () => {
  const items = [msg('a', 'push', { reasons: ['A DM', 'Mentions you'] }), msg('b', 'push', { reasons: ['A DM'] }), msg('c', 'push', { reasons: ['A DM', 'Late at night', 'A DM'] })];
  expect(reasonsOf(items)).toEqual([
    { text: 'A DM', n: 3 },
    { text: 'Mentions you', n: 1 },
    { text: 'Late at night', n: 1 },
  ]);
});

test("a line's importance is the highest among its messages; none when none has one", () => {
  expect(topImportance([msg('a', 'digest', { score: 0.62 }), msg('b', 'digest', { score: 0.9 }), msg('c', 'digest', { score: null })])).toBe(0.9);
  expect(topImportance([msg('a', 'digest', { score: 0 })])).toBe(0);
  expect(topImportance([msg('a', 'push', { score: null })])).toBe(null);
  expect(topImportance([])).toBe(null);
});

test('the highest tier among messages, by what was decided', () => {
  expect(topTier([msg('a', 'digest'), msg('b', 'quiet')])).toBe('quiet');
  expect(topTier([msg('a', 'drop'), msg('b', 'digest'), msg('c', 'push')])).toBe('push');
  // An old vote and a mark leave the tier alone.
  expect(topTier([msg('a', 'push', { feedback: 'digest', marks: { alert: false } }), msg('b', 'digest')])).toBe('push');
  expect(topTier([msg('a', 'drop')])).toBe('drop');
  expect(topTier([msg('a', 'silent')])).toBe(null);
  expect(topTier([])).toBe(null);
});

test("the list's preview: chats a day at a level, from the hub's rows, said in words", () => {
  const preview = [
    { level: 0.1, perDay: 61.4 },
    { level: 0.5, perDay: 2.9 },
    { level: 0.6, perDay: 16.9 },
    { level: 0.8, perDay: 1 },
    { level: 0.9, perDay: 0 },
  ];
  expect(listPreview(preview, 0.6)).toBe('about 17 chats a day at this level (last week)');
  expect(listPreview(preview, 0.1)).toBe('about 61 chats a day at this level (last week)');
  // Under three a day the decimal stays; exactly one is one chat.
  expect(listPreview(preview, 0.5)).toBe('about 2.9 chats a day at this level (last week)');
  expect(listPreview(preview, 0.8)).toBe('about 1 chat a day at this level (last week)');
  expect(listPreview(preview, 0.9)).toBe('about 0 chats a day at this level (last week)');
  // A level between two tenths reads the nearest; one the hub has no row for says nothing.
  expect(listPreview(preview, 0.62)).toBe('about 17 chats a day at this level (last week)');
  expect(listPreview(preview, 0.3)).toBe(null);
  expect(listPreview([], 0.6)).toBe(null);
});

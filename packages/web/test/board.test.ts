/** src/board.ts: the Triage board's lists, and the badge counted from them. */
import { expect, test } from 'bun:test';
import { BELOW_DAYS, BELOW_SHOWN, isMailItem, triageBoard, type BoardItem } from '../src/board.ts';

const DAY = 86_400_000;
const now = 100 * DAY;
const msg = (id: string, decision: string, x: { feedback?: string | null; ts?: number; score?: number; conv?: string } = {}): any => ({
  id,
  conversationId: x.conv ?? 'cnv_a',
  ts: x.ts ?? now - 1000,
  triage: { decision, feedback: x.feedback ?? null, score: x.score ?? 0.5, reasons: [] },
});
const all = () => true;
const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

test('each message is listed by where it is now: your vote, else the decision', () => {
  const b = triageBoard([msg('a', 'push'), msg('b', 'push', { feedback: 'quiet' }), msg('c', 'digest', { feedback: 'push' }), msg('d', 'quiet', { feedback: 'drop' })], { now, shown: all, unread: all });
  expect(ids(b.important).sort()).toEqual(['a', 'c']);
  expect(ids(b.active)).toEqual(['b']);
  expect(ids(b.below)).toEqual(['d']);
});

test('the badge is the Important list unread: a vote down takes one off, a vote up adds one, Active never counts', () => {
  const unread = new Set(['a', 'b', 'c', 'e']);
  const items = [msg('a', 'push'), msg('b', 'push'), msg('c', 'quiet'), msg('e', 'digest'), msg('f', 'push')];
  const before = triageBoard(items, { now, shown: all, unread: (m) => unread.has(m.id) });
  expect(before.importantUnread).toBe(2);
  expect(before.important).toHaveLength(3);
  // b voted down to Active, e up to Important.
  items[1] = msg('b', 'push', { feedback: 'quiet' });
  items[3] = msg('e', 'digest', { feedback: 'push' });
  const after = triageBoard(items, { now, shown: all, unread: (m) => unread.has(m.id) });
  expect(after.importantUnread).toBe(2);
  expect(ids(after.important).sort()).toEqual(['a', 'e', 'f']);
  expect(ids(after.active).sort()).toEqual(['b', 'c']);
  // The count is of what the list shows.
  expect(after.importantUnread).toBe(after.important.filter((m) => unread.has(m.id)).length);
});

test('a week for the lists, two days for Not interesting, places you hid left out', () => {
  const b = triageBoard(
    [
      msg('old', 'push', { ts: now - 8 * DAY }),
      msg('week', 'digest', { ts: now - 6 * DAY }),
      msg('drop-old', 'drop', { ts: now - (BELOW_DAYS + 1) * DAY }),
      msg('drop-new', 'drop', { ts: now - DAY }),
      msg('hidden', 'push', { conv: 'cnv_hidden' }),
      msg('silent', 'silent'),
    ],
    { now, shown: (m) => m.conversationId !== 'cnv_hidden', unread: all },
  );
  expect(ids(b.important)).toEqual([]);
  expect(ids(b.digest)).toEqual(['week']);
  expect(ids(b.below)).toEqual(['drop-new']);
  expect(b.importantUnread).toBe(0);
});

test('orders: newest first for Important and Active, what matters most first for the digest and below', () => {
  const b = triageBoard(
    [msg('p1', 'push', { ts: now - 3000 }), msg('p2', 'push', { ts: now - 1000 }), msg('d1', 'digest', { score: 0.2 }), msg('d2', 'digest', { score: 0.9 })],
    { now, shown: all, unread: all },
  );
  expect(ids(b.important)).toEqual(['p2', 'p1']);
  expect(ids(b.digest)).toEqual(['d2', 'd1']);
  const many = Array.from({ length: BELOW_SHOWN + 5 }, (_, i) => msg(`x${i}`, 'drop', { score: i / 100 }));
  const below = triageBoard(many, { now, shown: all, unread: all }).below;
  expect(below).toHaveLength(BELOW_SHOWN);
  expect(below[0].id).toBe(`x${BELOW_SHOWN + 4}`);
});

test('mail sits beside chat by the same levels, its unread counting in the badge (slice 9)', () => {
  const mail = (id: string, decision: string, x: { feedback?: string | null; ts?: number; unread?: boolean } = {}): any => ({
    kind: 'mail',
    id,
    threadId: 'mth_a',
    accountId: 'acc_mail',
    from: { name: 'Sam', email: 'sam@x.example' },
    subject: 'Dinner',
    preview: null,
    ts: x.ts ?? now - 500,
    unread: x.unread ?? true,
    triage: { decision, feedback: x.feedback ?? null, score: 0.5, reasons: [], decidedBy: 'rules' },
  });
  const items: BoardItem[] = [msg('a', 'push'), mail('mml_1', 'push'), mail('mml_2', 'push', { feedback: 'quiet' }), mail('mml_3', 'digest', { unread: false })];
  const b = triageBoard(items, { now, shown: all, unread: (m) => (isMailItem(m) ? m.unread : true) });
  expect(ids(b.important)).toEqual(['mml_1', 'a']);
  expect(ids(b.active)).toEqual(['mml_2']);
  expect(ids(b.digest)).toEqual(['mml_3']);
  expect(b.importantUnread).toBe(2);
  expect(b.important.filter(isMailItem).map((m) => m.threadId)).toEqual(['mth_a']);
});

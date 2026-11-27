/** src/sendrows.ts: what a chat shows of the sends not yet in it, from this device's copies and the hub's queue. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { countdownLeft, seenUpTo, sendNote, SENT_SHOWN_MS, shownSends, type DeviceCopy } from '../src/sendrows.ts';

const copy = (tempId: string, x: Partial<DeviceCopy> = {}): DeviceCopy => ({ tempId, conversationId: 'cnv_a', body: 'hi', ts: 1000, ...x });
let seq = 0;
const row = (clientId: string, x: Partial<P.SendRow> = {}): P.SendRow => ({
  clientId,
  conversationId: 'cnv_a',
  accountId: null,
  body: 'hi',
  files: [],
  replyTo: null,
  state: 'queued',
  pressedAt: 1000,
  updatedAt: 5000,
  messageId: null,
  error: null,
  hold: null,
  holdUntil: null,
  seq: ++seq,
  filesComing: false,
  cut: null,
  ...x,
});
const nothingHere = () => false;
const marks = (xs: ReturnType<typeof shownSends>) => xs.map((s) => `${s.key}:${s.mark}`);

test('a clock while only this device has it, one tick once the hub has it, two once the network named it', () => {
  expect(marks(shownSends(['cnv_a'], [copy('t1')], [], nothingHere, 5000))).toEqual(['t1:device']);
  // The hub's row takes the copy's place: the same id.
  expect(marks(shownSends(['cnv_a'], [copy('t1')], [row('t1')], nothingHere, 5000))).toEqual(['t1:hub']);
  expect(marks(shownSends(['cnv_a'], [], [row('t1', { state: 'sending' })], nothingHere, 5000))).toEqual(['t1:hub']);
  expect(marks(shownSends(['cnv_a'], [], [row('t1', { state: 'sent', messageId: 'msg_1' })], nothingHere, 5000))).toEqual(['t1:network']);
});

test('a sent one goes once its message is here, or after a while if it never comes', () => {
  const sent = row('t1', { state: 'sent', messageId: 'msg_1', updatedAt: 5000 });
  expect(shownSends(['cnv_a'], [], [sent], (id) => id === 'msg_1', 5000)).toEqual([]);
  expect(shownSends(['cnv_a'], [], [sent], nothingHere, 5000 + SENT_SHOWN_MS + 1)).toEqual([]);
  expect(shownSends(['cnv_a'], [], [row('t2', { state: 'cancelled' })], nothingHere, 5000)).toEqual([]);
});

test('an echo that comes before the account answers is not shown twice, nor one a network sent without naming it', () => {
  const echo = { id: 'msg_e', conversationId: 'cnv_a', body: 'hi', ts: 1200 };
  expect(shownSends(['cnv_a'], [], [row('t1', { state: 'sending' })], nothingHere, 5000, [echo])).toEqual([]);
  expect(shownSends(['cnv_a'], [], [row('t1', { state: 'sent' })], nothingHere, 5000, [echo])).toEqual([]);
  // One echo is one send's: the second of two the same waits for its own.
  expect(marks(shownSends(['cnv_a'], [], [row('t1', { state: 'sending' }), row('t2', { state: 'queued' }), row('t3', { state: 'sent' })], nothingHere, 5000, [echo]))).toEqual(['t2:hub', 't3:network']);
  // Older than the press, another text, or the message another row named: not its echo.
  expect(marks(shownSends(['cnv_a'], [], [row('t1', { state: 'sending', pressedAt: 100_000 })], nothingHere, 200_000, [echo]))).toEqual(['t1:hub']);
  expect(marks(shownSends(['cnv_a'], [], [row('t1', { state: 'sending', body: 'other' })], nothingHere, 5000, [echo]))).toEqual(['t1:hub']);
  expect(marks(shownSends(['cnv_a'], [], [row('t0', { state: 'sent', messageId: 'msg_e' }), row('t1', { state: 'sending' })], nothingHere, 5000, [echo]))).toEqual(['t0:network', 't1:hub']);
  // A sent one no longer shown still keeps its echo: the next send of the same text waits for its own.
  expect(marks(shownSends(['cnv_a'], [], [row('t0', { state: 'sent', updatedAt: 1000 }), row('t1', { state: 'sending' })], nothingHere, 1000 + SENT_SHOWN_MS + 1, [echo]))).toEqual(['t1:hub']);
});

test('a sent one says when it stops being shown, so the chat is drawn again then', () => {
  const [s] = shownSends(['cnv_a'], [], [row('t1', { state: 'sent', messageId: 'msg_1', updatedAt: 5000 })], nothingHere, 5000);
  expect(s.goneAt).toBe(5000 + SENT_SHOWN_MS);
});

test("another device's sends show too; other chats' do not", () => {
  const shown = shownSends(['cnv_a'], [copy('t9', { conversationId: 'cnv_b' })], [row('other-device'), row('elsewhere', { conversationId: 'cnv_b' })], nothingHere, 5000);
  expect(marks(shown)).toEqual(['other-device:hub']);
});

test('held: what came since, the countdown by the hub clock, and the ones behind wait on it', () => {
  const shown = shownSends(
    ['cnv_a'],
    [],
    [row('h', { state: 'held', hold: { count: 2, ids: ['m1', 'm2'] }, holdUntil: 12_000 }), row('b'), row('u', { state: 'unsure', error: 'lost' })],
    nothingHere,
    5000,
  );
  expect(marks(shown)).toEqual(['h:held', 'b:hub', 'u:unsure']);
  expect(shown[0]).toMatchObject({ hold: { count: 2 }, holdUntil: 12_000 });
  expect(shown[1].behind).toBe('h');
  expect(sendNote(shown[0], 5000)).toBe('2 new messages came in since you wrote this. Sends in 7 s.');
  expect(sendNote(shown[0], 11_500)).toBe('2 new messages came in since you wrote this. Sends in 1 s.');
  expect(sendNote(shown[1], 5000)).toBe('The hub has it · waiting on the message above');
  expect(sendNote(shown[2], 5000)).toContain('May have been sent');
});

test('held with nobody watching: no countdown, it waits for you', () => {
  const [h] = shownSends(['cnv_a'], [], [row('h', { state: 'held', hold: { count: 1, ids: ['m1'] } })], nothingHere, 5000);
  expect(h.holdUntil).toBeUndefined();
  expect(sendNote(h, 5000)).toBe('1 new message came in since you wrote this. It waits for you.');
});

test('a countdown never goes below 0, and none is null', () => {
  expect(countdownLeft(1000, 5000)).toBe(0);
  expect(countdownLeft(5001, 5000)).toBe(1);
  expect(countdownLeft(undefined, 5000)).toBeNull();
});

test('refused: on the device (the hub said no before taking it) and in the hub (the network said no)', () => {
  const shown = shownSends(['cnv_a'], [copy('t1', { failed: 'no account can send here' })], [row('t2', { state: 'failed', error: 'not allowed' })], nothingHere, 5000);
  expect(shown.map((s) => [s.key, s.mark, s.from, sendNote(s, 5000)])).toEqual([
    ['t1', 'failed', 'device', 'Not sent: no account can send here'],
    ['t2', 'failed', 'hub', 'Not sent: not allowed'],
  ]);
  // A refused one does not hold up the ones behind it: nothing went out.
  expect(shownSends(['cnv_a'], [], [row('f', { state: 'failed' }), row('n')], nothingHere, 5000)[1].behind).toBeUndefined();
});

test('what you could see: the newest message across the timelines that show the chat', () => {
  const tl = (key: string, ms: [string, number, string][]) => ({ key, messages: ms.map(([id, ts, conversationId]) => ({ id, ts, conversationId })) });
  expect(seenUpTo('cnv_a', [tl('c:cnv_a', [['m1', 10, 'cnv_a'], ['m2', 20, 'cnv_a']])])).toEqual({ id: 'm2', ts: 20 });
  // A person's chat over two routes: its newest, whichever route it came on.
  expect(seenUpTo('cnv_a', [tl('p:ann', [['m1', 10, 'cnv_a'], ['m3', 30, 'cnv_b']])])).toEqual({ id: 'm3', ts: 30 });
  expect(seenUpTo('cnv_a', [tl('c:cnv_b', [['m9', 90, 'cnv_b']])])).toBeNull();
  expect(seenUpTo('cnv_a', [tl('c:cnv_a', [])])).toBeNull();
});

test('one waiting for its files says so, holds the sends behind it, and one sent cut says how far it came', () => {
  const shown = shownSends(['cnv_a'], [], [row('p1', { files: ['a.jpg'], filesComing: true }), row('t2', { body: 'after' })], nothingHere, 5000);
  expect(shown.map((s) => [s.key, s.mark, s.behind ?? null])).toEqual([
    ['p1', 'hub', null],
    ['t2', 'hub', 'p1'],
  ]);
  expect(sendNote(shown[0], 5000)).toBe('The hub has it, and sends it once the files are in');
  expect(sendNote(shown[1], 5000)).toBe('The hub has it · waiting on the message above');
  const [cut] = shownSends(['cnv_a'], [], [row('p1', { state: 'sent', messageId: 'msg_1', files: ['a.jpg'], cut: 'fair' })], nothingHere, 5000);
  expect(sendNote(cut, 5000)).toBe('Sent as far as it had come (fair)');
});

/**
 * src/shade.ts: which of this device's notifications close on a read here, on the hub's `cleared`, and when the page
 * tidies up after a catch-up (docs/notifications.md, "Read elsewhere, gone here"). The browser's notifications are a
 * stand-in list; headless Chromium: scripts/verify-clear.ts.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { closeCleared, closeNotifications, noticeReadIn, readIn, shownTags, tidyNotifications } from '../src/shade.ts';

let up: { tag: string; data: any; closed: boolean }[] = [];
const had = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
Object.defineProperty(navigator, 'serviceWorker', {
  configurable: true,
  value: { getRegistration: async () => ({ getNotifications: async () => up.filter((n) => !n.closed).map((n) => ({ tag: n.tag, data: n.data, close: () => void (n.closed = true) })) }) },
});
afterAll(() => {
  if (had) Object.defineProperty(navigator, 'serviceWorker', had);
  else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});
const open = () => up.filter((n) => !n.closed).map((n) => n.tag);
/** Notifications up: a tag, the newest message's time, and more data (`keep`). */
const showing = (...ns: [string, number?, Record<string, unknown>?][]) => void (up = ns.map(([tag, ts, more]) => ({ tag, data: { ...(ts === undefined ? {} : { ts }), ...more }, closed: false })));
/** A reminder you set, or the summary when quiet hours end (hub notify.ts, kind 'held'): no message's time, `keep`. */
const reminder = (tag: string): [string, undefined, Record<string, unknown>] => [tag, undefined, { keep: true }];
/** sw.js `sendReply` when the hub refused or could not be reached: the only copy of what was typed. */
const notSent = (tag: string): [string, undefined, Record<string, unknown>] => [tag, undefined, { conversationId: tag, keep: true }];

const conv = (id: string, unread: number, lastReadTs: number | null, mentions = 0): P.ConversationView =>
  ({ id, vantages: [{ accountId: 'a', unread, mentions, lastReadTs }] }) as unknown as P.ConversationView;
const thread = (id: string, unread: number, lastAt = 50) => ({ id, unread, lastAt }) as unknown as P.MailThreadView;
const db = {
  conversations: new Map([
    ['cnv_read', conv('cnv_read', 0, 500)],
    ['cnv_past', conv('cnv_past', 2, 300)],
    ['cnv_mention', conv('cnv_mention', 0, 300, 1)],
  ]),
  mail: { threads: new Map([['mth_read', thread('mth_read', 0)], ['mth_new', thread('mth_new', 1)]]) },
};
const read = readIn(db);

beforeEach(() => showing());

test('read as the page holds it: a chat read past what the notification shows; a mail thread with nothing unread; nothing else', () => {
  expect(read('cnv_read', 400)).toBe(true);
  expect(read('cnv_read', 500)).toBe(true);
  // Unread again since: only a notification of what came before the read point is read.
  expect(read('cnv_past', 300)).toBe(true);
  expect(read('cnv_past', 301)).toBe(false);
  expect(read('cnv_past', undefined)).toBe(false);
  expect(read('cnv_mention', 900)).toBe(false);
  expect(read('mth_read', 50)).toBe(true);
  expect(read('mth_new', 1)).toBe(false);
  // A group of notices, a chat the page does not hold, a calendar reminder: it cannot tell.
  for (const tag of ['ntg_1', 'cnv_unknown', 'calendar:evt_1']) expect(read(tag, 1)).toBeUndefined();
});

test('nothing unread is not enough: a notification of no message, or newer than the read, cannot be told about', () => {
  // A reminder, a held summary, "Reply not sent", a page's own: no time. It stays.
  expect(read('cnv_read', undefined)).toBeUndefined();
  expect(read('mth_read', undefined)).toBeUndefined();
  // An alert that came after the page caught up: the page has not heard of its message yet.
  expect(read('cnv_read', 501)).toBeUndefined();
  expect(read('mth_read', 51)).toBeUndefined();
});

test('the start-up tidy closes what is read and leaves the unread and the unknown', async () => {
  showing(['cnv_read', 100], ['cnv_past', 200], ['cnv_past', 400], ['mth_read', 40], ['mth_new'], ['ntg_1'], ['calendar:evt_1']);
  expect(await tidyNotifications(read)).toBe(3);
  expect(open()).toEqual(['cnv_past', 'mth_new', 'ntg_1', 'calendar:evt_1']);
  expect(up.find((n) => n.tag === 'cnv_past' && !n.closed)!.data.ts).toBe(400);
});

test('the tidy leaves a reminder, a held summary and "Reply not sent" in a chat with nothing unread', async () => {
  showing(reminder('cnv_read'), notSent('cnv_past'), reminder('mth_read'), ['cnv_mention']);
  expect(await tidyNotifications(read)).toBe(0);
  expect(open()).toEqual(['cnv_read', 'cnv_past', 'mth_read', 'cnv_mention']);
});

test('the tidy leaves an alert that arrived between the catch-up and the tidy', async () => {
  // The page caught up with cnv_read read to 500; a message at 600 came after, and its alert is already up.
  showing(['cnv_read', 600], ['mth_read', 60]);
  expect(await tidyNotifications(read)).toBe(0);
  expect(open()).toEqual(['cnv_read', 'mth_read']);
});

test('`cleared` closes what the hub says was read up to where it was read', async () => {
  showing(['cnv_read', 100], ['cnv_past', 400], ['ntg_1'], ['cnv_other', 1], ['mth_read']);
  const reads = [
    { id: 'cnv_read', upTo: 100 },
    { id: 'cnv_past', upTo: 300 },
    { id: 'ntg_1', upTo: 9 },
    { id: 'mth_read', upTo: 50 },
  ];
  // cnv_past shows a message newer than the read; ntg_1 and mth_read say nothing of their time (a page's own) and the
  // page holds nothing unread there.
  expect(await closeCleared(reads, read)).toBe(3);
  expect(open()).toEqual(['cnv_past', 'cnv_other']);
});

test('`cleared` leaves an alert that reached this device after the read, before the page hears of its message', async () => {
  // The page still holds cnv_read as read to 500: the hub's read was to 500, the alert shows 700.
  showing(['cnv_read', 700]);
  expect(await closeCleared([{ id: 'cnv_read', upTo: 500 }], read)).toBe(0);
  expect(open()).toEqual(['cnv_read']);
  // A notification of no time in a chat the page holds as unread stays too.
  showing(['cnv_past']);
  expect(await closeCleared([{ id: 'cnv_past', upTo: 300 }], read)).toBe(0);
});

test('`cleared` and a read here leave a reminder and "Reply not sent"', async () => {
  showing(reminder('cnv_read'), notSent('cnv_other'));
  expect(await closeCleared([{ id: 'cnv_read', upTo: 900 }, { id: 'cnv_other', upTo: 900 }], read)).toBe(0);
  expect(await closeNotifications(['cnv_read', 'cnv_other'])).toBe(0);
  expect(open()).toEqual(['cnv_read', 'cnv_other']);
});

test('a read here closes the chat whatever the page held, and only that chat', async () => {
  showing(['cnv_past', 400], ['cnv_read', 1]);
  expect(await closeNotifications(['cnv_past'])).toBe(1);
  expect(open()).toEqual(['cnv_read']);
  expect(await closeNotifications([])).toBe(0);
});

test('a group of notices goes only when the page holds the notice it shows as read; a newer one stays', async () => {
  const items = [
    { id: 'ntc_1', unread: false },
    { id: 'ntc_2', unread: true },
  ];
  // ntc_3 came after the list was fetched (notices.ts, after a catch-up): the page has not heard of it.
  showing(['ntg_a', undefined, { notice: 'ntc_1' }], ['ntg_b', undefined, { notice: 'ntc_2' }], ['ntg_c', undefined, { notice: 'ntc_3' }], ['ntg_d'], ['ntg_e', undefined, { notice: 'ntc_1', keep: true }]);
  expect(await closeNotifications(['ntg_a', 'ntg_b', 'ntg_c', 'ntg_d', 'ntg_e'], noticeReadIn(items))).toBe(2);
  expect(open()).toEqual(['ntg_b', 'ntg_c', 'ntg_e']);
});

test('the groups of notices showing, once each', async () => {
  showing(['ntg_1'], ['ntg_1'], ['ntg_2'], ['cnv_read']);
  expect(await shownTags('ntg_')).toEqual(['ntg_1', 'ntg_2']);
});

test('without service workers nothing happens, and nothing throws', async () => {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => undefined } });
  try {
    expect(await tidyNotifications(read)).toBe(0);
    expect(await closeNotifications(['cnv_read'])).toBe(0);
  } finally {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => ({ getNotifications: async () => up.filter((n) => !n.closed).map((n) => ({ tag: n.tag, data: n.data, close: () => void (n.closed = true) })) }) },
    });
  }
});

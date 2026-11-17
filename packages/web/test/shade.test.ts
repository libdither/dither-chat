/**
 * src/shade.ts: which of this device's notifications close on a read here, on the hub's `cleared`, and when the page
 * tidies up after a catch-up (docs/notifications.md, "Read elsewhere, gone here"). The browser's notifications are a
 * stand-in list; headless Chromium: scripts/verify-clear.ts.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { closeNotifications, readIn, shownTags, tidyNotifications } from '../src/shade.ts';

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
const showing = (...ns: [string, number?][]) => void (up = ns.map(([tag, ts]) => ({ tag, data: ts === undefined ? {} : { ts }, closed: false })));

const conv = (id: string, unread: number, lastReadTs: number | null, mentions = 0): P.ConversationView =>
  ({ id, vantages: [{ accountId: 'a', unread, mentions, lastReadTs }] }) as unknown as P.ConversationView;
const thread = (id: string, unread: number) => ({ id, unread }) as unknown as P.MailThreadView;
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

test('read as the page holds it: a chat with nothing unread, or read past what the notification shows; mail; nothing else', () => {
  expect(read('cnv_read', 900)).toBe(true);
  expect(read('cnv_read', undefined)).toBe(true);
  // Unread again since: only a notification of what came before the read point is read.
  expect(read('cnv_past', 300)).toBe(true);
  expect(read('cnv_past', 301)).toBe(false);
  expect(read('cnv_past', undefined)).toBe(false);
  expect(read('cnv_mention', 900)).toBe(false);
  expect(read('mth_read', 1)).toBe(true);
  expect(read('mth_new', 1)).toBe(false);
  // A group of notices, a chat the page does not hold, a calendar reminder: it cannot tell.
  for (const tag of ['ntg_1', 'cnv_unknown', 'calendar:evt_1']) expect(read(tag, 1)).toBeUndefined();
});

test('the start-up tidy closes what is read and leaves the unread and the unknown', async () => {
  showing(['cnv_read', 100], ['cnv_past', 200], ['cnv_past', 400], ['mth_read'], ['mth_new'], ['ntg_1'], ['calendar:evt_1']);
  expect(await tidyNotifications(read)).toBe(3);
  expect(open()).toEqual(['cnv_past', 'mth_new', 'ntg_1', 'calendar:evt_1']);
  expect(up.find((n) => n.tag === 'cnv_past' && !n.closed)!.data.ts).toBe(400);
});

test('`cleared` closes what the hub says was read, unless the page knows of something newer in it', async () => {
  showing(['cnv_read', 100], ['cnv_past', 400], ['ntg_1'], ['cnv_other', 1]);
  expect(await closeNotifications(['cnv_read', 'cnv_past', 'ntg_1'], read)).toBe(2);
  expect(open()).toEqual(['cnv_past', 'cnv_other']);
});

test('a read here closes the chat whatever the page held, and only that chat', async () => {
  showing(['cnv_past', 400], ['cnv_read', 1]);
  expect(await closeNotifications(['cnv_past'])).toBe(1);
  expect(open()).toEqual(['cnv_read']);
  expect(await closeNotifications([])).toBe(0);
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

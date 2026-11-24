/**
 * Read here, not pushed there (docs/notifications.md): a chat open at its newest message on a computer in use gets no
 * push, unless a rule of yours made it an alert; and a busy chat's silent Conversations push at most once per ten
 * minutes. Each skip is logged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { WATCH_EVERY } from '@dither-chat/protocol';
import { ActivityStore } from '../src/activity.ts';
import { Notifier, type Hold, type Tier } from '../src/notify.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

describe('a page says what it watches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-watching-'));
  let store: Store;
  let hub: HubServer;
  let port = 0;
  const sockets: WebSocket[] = [];

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    const sup = { authorize: () => null, online: () => false, stop: async () => {}, command: async () => ({}) } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, open: true, secret: 's' });
    port = hub.start().port!;
  });
  afterAll(() => {
    for (const s of sockets) s.close();
    hub.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function page(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
    sockets.push(ws);
    await new Promise((r) => (ws.onopen = r));
    return ws;
  }
  /** Says it, then waits for the hub's answer to a ping sent after it: the hub has taken it in by then. */
  async function say(ws: WebSocket, w: Omit<P.ClientWatching, 't'>) {
    ws.send(JSON.stringify({ t: 'watching', ...w } satisfies P.ClientWatching));
    const pong = new Promise<void>((r) => ws.addEventListener('message', function on(e) {
      if (e.data !== 'pong') return;
      ws.removeEventListener('message', on);
      r();
    }));
    ws.send('ping');
    await pong;
  }

  test("a computer's page at the newest message: watched; a phone's, or after it stops saying so, not", async () => {
    const desk = await page();
    const phone = await page();
    expect(hub.watched('c-1')).toBe(false);
    await say(desk, { label: 'Chrome on Linux', conversationIds: ['c-1', 'c-2'] });
    await say(phone, { label: 'Android app', conversationIds: ['c-3'] });
    expect(hub.watched('c-1')).toBe(true);
    expect(hub.watched('c-2')).toBe(true);
    expect(hub.watched('c-3')).toBe(false);
    // Not said again for longer than twice WATCH_EVERY: forgotten (a laptop that slept with the page open).
    expect(hub.watched('c-1', Date.now() + 2 * WATCH_EVERY + 1000)).toBe(false);
    // Scrolled up, went idle or hidden: the page says it watches nothing.
    await say(desk, { label: 'Chrome on Linux', conversationIds: [] });
    expect(hub.watched('c-1')).toBe(false);
  });

  test('anything else on the socket is ignored', async () => {
    const ws = await page();
    ws.send('{not json');
    await say(ws, { label: 'Firefox on Linux', conversationIds: ['c-9'] });
    ws.send(JSON.stringify({ t: 'other', conversationIds: ['c-8'] }));
    await say(ws, { label: 'Firefox on Linux', conversationIds: ['c-9'] });
    expect(hub.watched('c-9')).toBe(true);
    expect(hub.watched('c-8')).toBe(false);
  });
});

describe('the notifier holds a push back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-watching-n-'));
  let store: Store;
  let activity: ActivityStore;
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    activity = new ActivityStore(store);
  });

  function notifier(watched: Set<string>, due: boolean) {
    const pushed: string[] = [];
    const n = new Notifier({
      store,
      phone: { list: () => ({ send: true }), higher: () => {} } as any,
      activity,
      devices: { addressed: () => false, quietOn: () => [] },
      push: {
        desktops: () => [],
        notify: async (_t, _b, _c, extra) => {
          pushed.push(String(extra.messageId));
          return { devices: 1, accepted: 1 };
        },
      },
      delivery: { listDue: () => true, conversationDue: () => due, plan: () => null },
      server: { notify: () => {}, warm: async () => {}, watched: (cid) => watched.has(cid) },
    });
    const send = async (mid: string, cid: string, tier: Tier, hold: Hold = {}) => {
      n.message('t', 'b', cid, mid, ['why'], {}, 'message', tier, 0.5, true, hold);
      await n.last;
    };
    return { pushed, send };
  }
  const skips = () => store.db.query('SELECT message_id, conversation_id, why FROM push_skip ORDER BY rowid').all();

  test('watched on a computer: no push of any tier, logged; an alert by rule still goes', async () => {
    store.db.exec('DELETE FROM push_skip');
    const { pushed, send } = notifier(new Set(['c-open']), true);
    await send('m1', 'c-open', 'quiet');
    await send('m2', 'c-open', 'push');
    await send('m3', 'c-open', 'digest');
    await send('m4', 'c-open', 'push', { rule: true });
    await send('m5', 'c-other', 'quiet');
    expect(pushed).toEqual(['m4', 'm5']);
    expect(skips()).toEqual([
      { message_id: 'm1', conversation_id: 'c-open', why: 'watched' },
      { message_id: 'm2', conversation_id: 'c-open', why: 'watched' },
      { message_id: 'm3', conversation_id: 'c-open', why: 'watched' },
    ]);
  });

  test("a capped Conversation within its chat's ten minutes: not pushed, logged; DMs, about you and alerts are not capped", async () => {
    store.db.exec('DELETE FROM push_skip');
    const { pushed, send } = notifier(new Set(), false);
    await send('m1', 'c-busy', 'quiet', { capped: true });
    await send('m2', 'c-busy', 'quiet');
    await send('m3', 'c-busy', 'push');
    expect(pushed).toEqual(['m2', 'm3']);
    expect(skips()).toEqual([{ message_id: 'm1', conversation_id: 'c-busy', why: 'capped' }]);
    // Due again: it goes.
    const again = notifier(new Set(), true);
    await again.send('m4', 'c-busy', 'quiet', { capped: true });
    expect(again.pushed).toEqual(['m4']);
  });

  test('with the activity log off nothing is logged, and the push is still held', async () => {
    store.db.exec('DELETE FROM push_skip');
    activity.setSettings({ enabled: false });
    const { pushed, send } = notifier(new Set(['c-open']), true);
    await send('m1', 'c-open', 'quiet');
    expect(pushed).toEqual([]);
    expect(skips()).toEqual([]);
    activity.setSettings({ enabled: true });
  });
});

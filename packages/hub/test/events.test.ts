/**
 * Events from Luma and Partiful (docs/events.md) with the demo's two event accounts (demo-events.ts): Explore read in
 * pages and kept in the site's order, the Events feed, an event's card with the people you know first and its guests
 * trimmed, the event's page with every guest, an RSVP sent and logged; who was seen at which event (`event_seen`) and a
 * profile's Events; a hidden guest list never kept, however it arrives; the table made again on an older database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { EVENT_CARD_GUESTS } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { DEMO_EVENT_ACCOUNTS, DemoEvents } from '../src/demo-events.ts';
import { Events } from '../src/events.ts';
import { eventsOf, knownOf, recordEvents } from '../src/eventseen.ts';
import { Posts } from '../src/posts.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Timelines } from '../src/timelines.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-events-'));
let store: Store;
const adapters = new Map<string, DemoEvents>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const sent: { accountId: string; cmd: Record<string, any> }[] = [];
const LUMA = DEMO_EVENT_ACCOUNTS[0]!.id;
const PARTIFUL = DEMO_EVENT_ACCOUNTS[1]!.id;

function command<T>(accountId: string, cmd: object): Promise<T> {
  const id = crypto.randomUUID();
  sent.push({ accountId, cmd });
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    adapters.get(accountId)!.command({ ...cmd, id } as P.AdapterCommand);
  });
}
let posts: Posts;
let tl: Timelines;
let events: Events;
const idn = (net: P.Network, native: string) => hubId('idn', net, native);
const seen = (eventId: string) => store.db.query('SELECT identity_id, role, rsvp FROM event_seen WHERE event_id = ? ORDER BY identity_id').all(eventId) as { identity_id: string; role: string; rsvp: string | null }[];

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  for (const meta of DEMO_EVENT_ACCOUNTS) {
    const acc = store.createAccount({ ...meta, adapter: 'demo', demo: true, config: { epoch: Date.now() } });
    const adir = join(dir, acc.id);
    mkdirSync(adir, { recursive: true });
    const a = new DemoEvents(acc, adir);
    adapters.set(acc.id, a);
    store.db.transaction(() =>
      a.start((ev) => {
        if (ev.t === 'reply') {
          const p = pending.get(ev.id);
          pending.delete(ev.id);
          if (ev.ok) p?.resolve(ev.result);
          else p?.reject(new Error(ev.error));
          return;
        }
        store.ingest(store.account(acc.id)!, ev);
      }),
    )();
  }
  posts = new Posts({ store, online: () => true, command });
  tl = new Timelines({ store, posts, online: () => true, command });
  events = new Events({ store, posts, online: () => true, command });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the explore feed', () => {
  test('the Events feed takes each event site’s Explore and Your events, and Following and Discover leave them out', () => {
    const mixes = tl.mixes();
    const on = (id: string) => mixes.find((m) => m.id === id)!.sources.filter((s) => s.share > 0).map((s) => `${s.accountId}:${s.feed}`);
    expect(on('events').sort()).toEqual([`${LUMA}:explore`, `${LUMA}:following`, `${PARTIFUL}:explore`, `${PARTIFUL}:following`]);
    expect(on('following')).toEqual([]);
    expect(on('discover')).toEqual([]);
    // An event site has no For you to offer.
    expect(mixes.find((m) => m.id === 'events')!.sources.some((s) => s.feed === 'foryou')).toBe(false);
  });

  test('Explore is read a page at a time, the next by the site’s cursor, kept in the site’s order', async () => {
    const first = await tl.read(`${LUMA}:explore`);
    const asked = sent.filter((s) => s.accountId === LUMA && s.cmd.t === 'home' && s.cmd.feed === 'explore');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.cmd.cursor).toBeUndefined();
    expect(first.entries.map((e) => e.post.id)).toEqual(['evt-demo-sheaves', 'evt-demo-market', 'evt-demo-robots']);
    expect(first.older).toBe(true);
    // The site's section comes as the reason.
    expect(first.entries[1]!.reason).toEqual({ text: 'Trending', kind: 'topic' });
    const second = await tl.read(`${LUMA}:explore`, true);
    const again = sent.filter((s) => s.accountId === LUMA && s.cmd.t === 'home' && s.cmd.feed === 'explore');
    expect(again.at(-1)!.cmd.cursor).toBe('page-2');
    expect(second.entries.map((e) => e.post.id)).toEqual(['evt-demo-sheaves', 'evt-demo-market', 'evt-demo-robots', 'evt-demo-online', 'evt-demo-craft']);
    expect(second.older).toBe(false);
  });

  test('Your events keep the site’s order: upcoming soonest first, then the past', async () => {
    const v = await tl.read(`${LUMA}:following`);
    expect(v.entries.map((e) => e.post.id)).toEqual(['evt-demo-sheaves', 'evt-demo-zines']);
  });

  test('a timeline the site has not is refused', () => {
    expect(() => tl.entries(`${LUMA}:foryou`)).toThrow(/no foryou timeline/);
  });
});

describe('the event card', () => {
  test('people you know come first, the rest in the site’s order, trimmed to a card’s few', async () => {
    const v = await tl.read(`${LUMA}:explore`);
    const sheaves = v.entries.find((e) => e.post.id === 'evt-demo-sheaves')!.post;
    const sam = idn('luma', 'usr-demo-sam');
    const jules = idn('luma', 'usr-demo-jules');
    // Sam and Jules are in your Luma group chat: known; the event's own conversation makes no one known.
    expect(sheaves.eventView!.known).toEqual([sam, jules]);
    expect(sheaves.event!.guests!.slice(0, 2)).toEqual([sam, jules]);
    expect(sheaves.event!.guests!).toHaveLength(EVENT_CARD_GUESTS);
    expect(sheaves.eventView!.guestsMore).toBe(19 - EVENT_CARD_GUESTS);
    expect(sheaves.event!.hosts).toEqual([idn('luma', 'usr-demo-rowan')]);
    expect(sheaves.eventView!.conversationId).toBe(hubId('cnv', 'luma', 'event:evt-demo-sheaves'));
    // Everyone the card draws is in the page's identities.
    for (const g of sheaves.event!.guests!) expect(v.identities.some((i) => i.id === g)).toBe(true);
  });

  test('knownOf: a person you have a direct chat with, through any of their accounts', () => {
    const priya = idn('partiful', 'pf-demo-priya');
    const hoa = idn('partiful', 'pf-demo-hoa');
    expect([...knownOf(store.db, [priya, hoa])]).toEqual([priya]);
  });

  test('the event’s page has every guest the site showed, and the people you know first', () => {
    const v = events.page('luma', 'evt-demo-sheaves');
    expect(v.post.event!.guests).toHaveLength(19);
    expect(v.post.event!.guests!.slice(0, 2)).toEqual([idn('luma', 'usr-demo-sam'), idn('luma', 'usr-demo-jules')]);
    expect(v.post.eventView!.guestsMore).toBe(0);
    expect(v.canRsvp).toBe(true);
    expect(() => events.page('x', 'evt-demo-sheaves')).toThrow(/Not an event site/);
    expect(() => events.page('luma', 'evt-nothing')).toThrow(/no such event/);
  });

  test('an RSVP goes to the site as the account, and the event is logged as it now stands', async () => {
    const v = await events.rsvp('luma', 'evt-demo-market', { account: LUMA, status: 'going' });
    expect(sent.at(-1)).toEqual({ accountId: LUMA, cmd: { t: 'action', action: 'rsvp', args: { eventId: 'evt-demo-market', status: 'going' } } });
    expect(v.post.event!.rsvp).toBe('going');
    expect(seen('evt-demo-market').find((r) => r.identity_id === store.account(LUMA)!.self_identity)?.rsvp).toBe('going');
    await expect(events.rsvp('luma', 'evt-demo-market', { account: LUMA, status: 'waitlist' })).rejects.toThrow(/status/);
    await expect(events.rsvp('luma', 'evt-demo-market', { account: PARTIFUL, status: 'going' })).rejects.toThrow(/No such account/);
  });
});

describe('who was seen where', () => {
  test('hosts and named guests are recorded; a count-only list leaves only its host', async () => {
    await tl.read(`${LUMA}:explore`);
    const sheaves = seen('evt-demo-sheaves');
    expect(sheaves.find((r) => r.identity_id === idn('luma', 'usr-demo-rowan'))?.role).toBe('host');
    expect(sheaves.filter((r) => r.role === 'guest')).toHaveLength(19);
    expect(seen('evt-demo-robots').map((r) => r.role)).toEqual(['host']);
  });

  test('a profile’s Events: hosting first, then upcoming, then past', async () => {
    await tl.read(`${LUMA}:following`);
    const jules = idn('luma', 'usr-demo-jules');
    const v = eventsOf(store, [jules]);
    expect(v.map((e) => [e.event, e.role])).toEqual([
      ['evt-demo-zines', 'host'],
      ['evt-demo-sheaves', 'guest'],
      ['evt-demo-online', 'guest'],
    ]);
    expect(v[1]).toMatchObject({ title: 'Sheaves & Snacks: a reading night', place: 'Lantern Hall, Brightwater', url: 'https://luma.com/demo-sheaves', timeZone: 'Europe/Lisbon' });
    expect(v[1]!.messageId).toBe(hubId('msg', 'luma', 'post:evt-demo-sheaves'));
  });

  test('guests get no person: they stay out of People', async () => {
    await tl.read(`${LUMA}:explore`);
    const guests = store.db.query(`SELECT i.person_id, i.native_id FROM event_seen e JOIN identity i ON i.id = e.identity_id WHERE e.event_id = 'evt-demo-sheaves' AND i.native_id LIKE 'usr-demo-g%'`).all() as { person_id: string | null }[];
    expect(guests.length).toBeGreaterThan(5);
    expect(guests.every((g) => g.person_id === null)).toBe(true);
  });
});

describe('a hidden guest list is never kept', () => {
  const acc = () => store.account(PARTIFUL)!;
  const leaky = (shown: P.EventGuestsShown): P.PostFact => ({
    id: 'pfleaky',
    url: 'https://partiful.com/e/pfleaky',
    ts: Date.now(),
    author: 'pf-demo-priya',
    text: 'A party',
    title: 'A party',
    event: { start: Date.now() + 86_400_000, hosts: ['pf-demo-priya'], guests: ['pf-demo-hoa', 'pf-demo-marco'], going: 2, guestsShown: shown },
  });
  const kept = () => JSON.parse((store.db.query('SELECT extra FROM message WHERE id = ?').get(hubId('msg', 'partiful', 'post:pfleaky')) as { extra: string }).extra).post as P.PostFact;

  test('shown in full, the guests are kept and recorded', () => {
    tl.keep(acc(), 'explore', { items: [{ post: leaky('all') }], more: null, top: null }, false);
    expect(kept().event!.guests).toEqual(['pf-demo-hoa', 'pf-demo-marco']);
    expect(seen('pfleaky').filter((r) => r.role === 'guest')).toHaveLength(2);
  });

  test('hidden later: an extractor that still sends guests is overruled, and what was recorded goes', () => {
    for (const shown of ['hidden', 'count'] as const) {
      tl.keep(acc(), 'explore', { items: [{ post: leaky(shown) }], more: null, top: null }, false);
      expect(kept().event!.guests).toBeUndefined();
      const item = JSON.parse((store.db.query(`SELECT item FROM feed_item WHERE post_id = 'pfleaky' AND account_id = ? AND feed = 'explore'`).get(PARTIFUL) as { item: string }).item) as P.HomeItem;
      expect(item.post.event!.guests).toBeUndefined();
      expect(seen('pfleaky').map((r) => r.role)).toEqual(['host']);
      // And the card shows none.
      const e = tl.entries(`${PARTIFUL}:explore`).entries.find((x) => x.post.id === 'pfleaky')!;
      expect(e.post.event!.guests).toBeUndefined();
    }
  });

  test('a message carrying such a post (a notification, a chat line) keeps none either', () => {
    store.ingest(acc(), { t: 'message', message: { nativeId: 'other:leak:pf-demo-priya', conversation: 'feed', author: 'pf-demo-priya', ts: Date.now(), kind: 'system', body: 'about a party', extra: { feed: { type: 'other', post: leaky('hidden') } } } });
    const extra = JSON.parse((store.db.query('SELECT extra FROM message WHERE id = ?').get(hubId('msg', 'partiful', 'other:leak:pf-demo-priya')) as { extra: string }).extra);
    expect(extra.feed.post.event.guests).toBeUndefined();
    expect(extra.feed.post.event.going).toBe(2);
  });

  test('recordEvents alone drops them too', () => {
    recordEvents(store.db, { network: 'partiful', self_identity: null }, [{ ...leaky('hidden'), id: 'pfleaky2' }]);
    expect(seen('pfleaky2').map((r) => r.role)).toEqual(['host']);
  });
});

describe('the migration', () => {
  test('a database from before event_seen gets the table when it opens', () => {
    const d = mkdtempSync(join(tmpdir(), 'dither-events-mig-'));
    try {
      const path = join(d, 'hub.sqlite');
      const s1 = new Store(path, mediaSigner('s'));
      s1.db.exec('DROP TABLE event_seen');
      s1.db.close();
      const s2 = new Store(path, mediaSigner('s'));
      expect(s2.db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_seen'`).get()).toEqual({ name: 'event_seen' });
      expect(s2.db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'event_seen_event'`).get()).toEqual({ name: 'event_seen_event' });
      s2.db.close();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

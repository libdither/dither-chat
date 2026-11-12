/** src/keptpages.ts: which message pages a device keeps, when each is written again, and what goes. IndexedDB: snapshot.ts. */
import { expect, test } from 'bun:test';
import { INDEX_KEY, MAX_PAGE_MESSAGES, MAX_PAGES, MAX_PAGES_CHARS, PageCache, pageText, type LiveTimeline, type PageRecord } from '../src/keptpages.ts';

const msg = (id: string, ts: number, extra: Record<string, unknown> = {}): any => ({ id, conversationId: 'c', ts, authorId: `idn_${id}`, body: 'x', replyToId: null, reactions: [], attachments: [], embeds: [], ...extra });
const tl = (key: string, n: number, extra: Partial<LiveTimeline> = {}): LiveTimeline => ({ messages: Array.from({ length: n }, (_, i) => msg(`${key}-${i}`, i)), sync: { v: 1, epoch: 'e', seq: 10 }, ...extra });
const pos = (seq: number, epoch = 'e') => ({ v: 1, epoch, seq });

/** A cache over a clock, and the timelines in memory. */
function cache(now = { t: 1000 }) {
  const live = new Map<string, LiveTimeline>();
  const gone = new Set<string>();
  const c = new PageCache('s1', () => now.t);
  const save = () => c.save({ live: (k) => live.get(k), exists: (k) => !gone.has(k), identities: new Map(), quoted: new Map() });
  return { c, live, gone, now, save };
}

test('a page keeps its newest messages, the people they name and what replies quote', () => {
  const ids = new Map([['idn_a-59', { id: 'idn_a-59' }], ['idn_q', { id: 'idn_q' }], ['idn_r', { id: 'idn_r' }], ['idn_unused', { id: 'idn_unused' }]] as any);
  const t = tl('a', 60);
  t.messages[59] = msg('a-59', 59, { replyToId: 'q', reactions: [{ identityIds: ['idn_r'] }] });
  const p = JSON.parse(pageText('c:a', t, ids, new Map([['q', msg('q', -1)]]) as any));
  expect(p.messages).toHaveLength(MAX_PAGE_MESSAGES);
  expect(p.messages.at(-1).id).toBe('a-59');
  expect(p.sync).toEqual(pos(10));
  expect(p.quoted.map((m: any) => m.id)).toEqual(['q']);
  expect(p.identities.map((i: any) => i.id).sort()).toEqual(['idn_a-59', 'idn_q', 'idn_r']);
});

test('opened and fetched-ahead pages are kept; one never opened or fetched ahead, a window around an old message, one loading or nothing are not', () => {
  const k = cache();
  for (const [key, t] of [['c:a', tl('a', 3)], ['c:ahead', { ...tl('ahead', 3), glance: true } as LiveTimeline], ['c:old', tl('old', 3, { detached: true })], ['c:busy', tl('busy', 3, { loading: true })], ['c:none', tl('none', 0)]] as const) {
    k.live.set(key, t);
    k.c.touch(key);
  }
  // Catch up's glance: in memory, never touched.
  k.live.set('c:look', { ...tl('look', 3), glance: true } as LiveTimeline);
  const w = k.save();
  expect(w.put.map((r) => r.key)).toEqual(['c:a', 'c:ahead']);
  expect(w.index.at.map(([key]) => key)).toEqual(['c:a', 'c:ahead']);
  expect(w.del).toEqual([]);
});

test('a page is written again only when its messages changed, not for a newer position alone', () => {
  const k = cache();
  const t = tl('a', 5);
  k.live.set('c:a', t);
  k.c.touch('c:a');
  expect(k.save().put).toHaveLength(1);
  // The live socket moved the client's position; the messages are the same objects.
  t.sync = pos(50);
  expect(k.save().put).toHaveLength(0);
  // An edit replaces a message object; a new one adds one.
  t.messages[2] = { ...t.messages[2], body: 'edited' };
  expect(k.save().put.map((r) => JSON.parse(r.text).messages[2].body)).toEqual(['edited']);
  t.messages.push(msg('new', 99));
  expect(k.save().put).toHaveLength(1);
  // Another epoch: the old position means nothing there.
  t.sync = pos(1, 'other');
  expect(k.save().put).toHaveLength(1);
  expect(k.save().put).toHaveLength(0);
});

test('past the bounds the least recently used go, by count and by size', () => {
  const k = cache();
  for (let i = 0; i < MAX_PAGES + 3; i++) {
    k.now.t = 1000 + i;
    k.live.set(`c:${i}`, tl(String(i), 2));
    k.c.touch(`c:${i}`);
  }
  const w = k.save();
  expect(w.put).toHaveLength(MAX_PAGES);
  expect(w.put.some((r) => r.key === 'c:0' || r.key === 'c:2')).toBe(false);
  // Opening an old one again puts it first; the least recent of the rest goes from the store.
  k.now.t = 5000;
  k.c.touch('c:0');
  const again = k.save();
  expect(again.put.map((r) => r.key)).toEqual(['c:0']);
  expect(again.del).toEqual(['c:3']);
  expect(again.index.at[0]).toEqual(['c:0', 5000]);
  // A page as big as all of them together is not kept, and leaves the rest alone.
  k.now.t = 6000;
  const big = tl('big', 1);
  big.messages[0] = msg('big', 1, { body: 'x'.repeat(MAX_PAGES_CHARS) });
  k.live.set('c:big', big);
  k.c.touch('c:big');
  const w3 = k.save();
  expect(w3.put).toEqual([]);
  expect(w3.del).toEqual([]);
});

test('read back after a start: given once, parsed only then, and not written again unless it changes', () => {
  const k = cache();
  k.live.set('c:a', tl('a', 3));
  k.c.touch('c:a');
  k.now.t = 2000;
  k.live.set('c:b', tl('b', 2));
  k.c.touch('c:b');
  const w = k.save();
  // The next start: the store's records, an index, and one record of another schema.
  const next = cache({ t: 3000 });
  next.c.adopt([...w.put, w.index, { schema: 'old', key: 'c:stale', text: '{}' } as PageRecord]);
  expect(next.c.unopened().sort()).toEqual(['c:a', 'c:b']);
  expect(next.c.has('c:a')).toBe(true);
  const a = next.c.take('c:a')!;
  expect(a.messages.map((m) => m.id)).toEqual(['a-0', 'a-1', 'a-2']);
  expect(next.c.take('c:a')).toBeUndefined();
  // Opened: the timeline holds the kept messages themselves, caught up with nothing new.
  next.live.set('c:a', { messages: a.messages, sync: a.sync });
  next.c.touch('c:a');
  const w2 = next.save();
  expect(w2.put).toEqual([]);
  expect(w2.del).toEqual(['c:stale']);
  expect(w2.index.at.map(([key]) => key)).toEqual(['c:a', 'c:b']);
  // A record that does not parse is dropped.
  const bad = cache();
  bad.c.adopt([{ schema: 's1', key: 'c:x', text: '{' }]);
  expect(bad.c.take('c:x')).toBeUndefined();
  expect(bad.save().del).toEqual(['c:x']);
  expect(INDEX_KEY.startsWith('#')).toBe(true);
});

test('a conversation or person gone from the hub takes its page along', () => {
  const k = cache();
  for (const key of ['c:a', 'c:b', 'p:x']) {
    k.live.set(key, tl(key, 2));
    k.c.touch(key);
  }
  k.save();
  k.c.forget('c:a');
  k.gone.add('p:x');
  const w = k.save();
  expect(w.del.sort()).toEqual(['c:a', 'p:x']);
  expect(w.index.at.map(([key]) => key)).toEqual(['c:b']);
});

test("an older build's pages, kept inside its snapshot, are kept as records at the next save", () => {
  const k = cache({ t: 9000 });
  k.c.adoptLegacy([{ key: 'c:l1', messages: [msg('x', 1)], sync: pos(3), identities: [], quoted: [] }, { key: 'c:l2', messages: [msg('y', 1)], identities: [], quoted: [] }]);
  expect(k.c.take('c:l2')?.messages[0].id).toBe('y');
  const w = k.save();
  expect(w.put.map((r) => r.key)).toEqual(['c:l1', 'c:l2']);
  expect(JSON.parse(w.put[0].text).sync).toEqual(pos(3));
  expect(k.save().put).toEqual([]);
});

/**
 * What a network would have notified you about, as triage reads it (triage.ts, docs/notifications.md): a followed
 * Zulip topic notifies every message but never alerts by that alone; @everyone where it is suppressed (a Discord
 * server's setting, a Zulip channel's or topic's, the most specific saying) does not notify; a group you are in
 * (a Zulip user group, a Discord role) mentioned is about you, between your name and @everyone; and in the inbox an
 * unread @everyone weighs less than a mention of you.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { freshState, scoreConversation, WEIGHTS, type ScoreInput } from '../src/attention.ts';
import { ALERT_BAR } from '../src/learn.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage, type Decision } from '../src/triage.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let store: Store;
let triage: Triage;
let z: AccountRow;
let d: AccountRow;
let clock = Date.now() - 2 * DAY;
let n = 0;
const conv = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', nativeId)!.id;

function post(acc: AccountRow, conversation: string, author: string, body: string, x: { mentionsSelf?: boolean; mentionsAll?: boolean; mentionsGroup?: boolean } = {}): string {
  clock += MIN;
  const nativeId = `m${++n}`;
  store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts: clock, body, ...x }, live: true });
  return store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
}
async function say(acc: AccountRow, conversation: string, author: string, body: string, x: Parameters<typeof post>[4] = {}): Promise<Decision> {
  const id = post(acc, conversation, author, body, x);
  const dec = (await triage.decide(id, clock))!;
  store.setTriage(id, dec, dec.facts);
  return dec;
}
const rules = (acc: AccountRow, conversation: string, author: string, body: string, x: Parameters<typeof post>[4] = {}) => triage.rulesFor(post(acc, conversation, author, body, x))!;

beforeAll(() => {
  store = new Store(':memory:', (raw) => raw ?? null);
  triage = new Triage(store);
  z = store.createAccount({ network: 'zulip', label: 'z', color: '#000', adapter: 'zulip' });
  d = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
  store.ingest(z, { t: 'status', status: 'online', self: { nativeId: 'chat.example.org/u/1', isSelf: true, displayName: 'Me' } });
  store.ingest(d, { t: 'status', status: 'online', self: { nativeId: 'dme', isSelf: true, displayName: 'Me' } });
  z = store.account(z.id)!;
  d = store.account(d.id)!;
  store.ingest(z, { t: 'identity', identity: { nativeId: 'chat.example.org/u/2', displayName: 'Ann Lee' } });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'bob', displayName: 'Bob' } });
  // A Zulip organization; two channels that notify only mentions, one of them with wildcard mentions off.
  store.ingest(z, { t: 'space', space: { nativeId: 'chat.example.org', kind: 'community', name: 'Example' } });
  for (const [c, mute] of [['chat.example.org/s/1', {}], ['chat.example.org/s/2', { suppressEveryone: true }], ['chat.example.org/s/3', { level: 'all' as const }]] as const)
    store.ingest(z, { t: 'conversation', conversation: { nativeId: c, shape: 'channel', variant: 'forum', name: c, spaces: [{ nativeId: 'chat.example.org' }], mute } });
  const topic = (nativeId: string, parent: string, x: Record<string, unknown> = {}) =>
    store.ingest(z, { t: 'conversation', conversation: { nativeId, shape: 'thread', variant: 'text', name: nativeId, parentConversation: parent, ...x } });
  // Followed, with Zulip's followed-topic notifications on: the extractor says every message (DA extractors/zulip).
  topic('chat.example.org/s/1/t/followed', 'chat.example.org/s/1', { mute: { level: 'all' }, thread: { joined: true, notify: 'all' } });
  topic('chat.example.org/s/1/t/plain', 'chat.example.org/s/1');
  topic('chat.example.org/s/2/t/quiet', 'chat.example.org/s/2');
  // Followed in the channel with wildcards off, with Zulip's followed-topic wildcard setting on: they notify here.
  topic('chat.example.org/s/2/t/loud', 'chat.example.org/s/2', { mute: { level: 'mentions', suppressEveryone: false }, thread: { joined: true } });
  topic('chat.example.org/s/3/t/any', 'chat.example.org/s/3');
  // Muted in the channel that notifies every message: your name only, as the extractor says it in full.
  topic('chat.example.org/s/3/t/hushed', 'chat.example.org/s/3', { mute: { muted: true, level: 'mentions', suppressEveryone: true }, thread: { muted: true } });
  // A Discord server that suppresses role mentions, and one that does not.
  store.ingest(d, { t: 'space', space: { nativeId: 'guild', kind: 'community', name: 'Hub', mute: { level: 'mentions', suppressRoles: true } } });
  store.ingest(d, { t: 'space', space: { nativeId: 'guild2', kind: 'community', name: 'Other', mute: { level: 'mentions' } } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'roles-off', shape: 'channel', name: 'roles-off', spaces: [{ nativeId: 'guild' }] } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'roles-on', shape: 'channel', name: 'roles-on', spaces: [{ nativeId: 'guild2' }] } });
});
afterAll(() => store.db.close());

describe('a followed Zulip topic', () => {
  test('notifies every message, so it counts as notified, but never alerts by the rules alone', async () => {
    const r = rules(z, 'chat.example.org/s/1/t/followed', 'chat.example.org/u/2', 'the build is green again');
    expect(r.decision).not.toBe('push');
    expect(r.forced).toBeUndefined();
    expect(r.facts).toMatchObject({ native: 'all', notify: true, base: 'drop', shape: 'thread' });
    expect(r.reasons).toContain('Zulip notifies every message here');
    // With no local model nothing alerts by chance: it goes on the list at the importance of what Zulip notifies.
    triage.judge = null;
    const dec = await say(z, 'chat.example.org/s/1/t/followed', 'chat.example.org/u/2', 'deploy at noon, please look now');
    expect(dec.decision).toBe('digest');
    expect(dec.facts).toMatchObject({ notify: true, conv: false });
    expect(dec.probs!.important).toBe(0.8);
  });

  test('a topic left to its channel notifies only mentions there', () => {
    const r = rules(z, 'chat.example.org/s/1/t/plain', 'chat.example.org/u/2', 'hello');
    expect(r.facts).toMatchObject({ native: 'mentions', notify: false });
    // A channel with notifications on is every message, for its topics too.
    expect(rules(z, 'chat.example.org/s/3/t/any', 'chat.example.org/u/2', 'hello').facts).toMatchObject({ native: 'all', notify: true });
    // A muted topic there is not every message, and its wildcards do not notify.
    expect(rules(z, 'chat.example.org/s/3/t/hushed', 'chat.example.org/u/2', 'hello').facts).toMatchObject({ notify: false });
    expect(rules(z, 'chat.example.org/s/3/t/hushed', 'chat.example.org/u/2', '@**all** hello', { mentionsSelf: true, mentionsAll: true }).facts).toMatchObject({ everyone: true, notify: false });
  });
});

describe('@everyone where it is suppressed', () => {
  test('a channel that says so: its topics are not notified of @all; a topic that says otherwise is', () => {
    expect(rules(z, 'chat.example.org/s/1/t/plain', 'chat.example.org/u/2', '@**all** lunch', { mentionsSelf: true, mentionsAll: true }).facts).toMatchObject({ everyone: true, notify: true });
    const quiet = rules(z, 'chat.example.org/s/2/t/quiet', 'chat.example.org/u/2', '@**all** lunch', { mentionsSelf: true, mentionsAll: true });
    expect(quiet.facts).toMatchObject({ everyone: true, notify: false });
    const loud = rules(z, 'chat.example.org/s/2/t/loud', 'chat.example.org/u/2', '@**all** lunch', { mentionsSelf: true, mentionsAll: true });
    expect(loud.facts).toMatchObject({ everyone: true, notify: true });
    // A mention by name notifies whatever the wildcard setting.
    expect(rules(z, 'chat.example.org/s/2/t/quiet', 'chat.example.org/u/2', '@**Me** hi', { mentionsSelf: true }).facts).toMatchObject({ mention: true, notify: true });
  });
});

describe('a group you are in, mentioned', () => {
  test('about you, so a Conversation, but read at the higher bar and less addressed than your name', async () => {
    triage.judge = async (t) => (/\bsoon\b/.test(t) ? 0.1 : 0.01);
    const byName = await say(z, 'chat.example.org/s/1/t/plain', 'chat.example.org/u/2', 'can you look soon', { mentionsSelf: true });
    expect(byName.decision).toBe('push');
    const group = await say(z, 'chat.example.org/s/1/t/plain', 'chat.example.org/u/2', 'can the team look soon', { mentionsSelf: true, mentionsGroup: true });
    // 0.1 is over the bar for messages to you (0.05), under the one for other chats (0.2).
    expect(group.decision).toBe('quiet');
    expect(group.facts).toMatchObject({ mention: false, group: true, everyone: false, conv: true, notify: true });
    expect(group.reasons).toEqual(['About you', 'Mentions a group you are in']);
    expect(ALERT_BAR.other).toBeGreaterThan(0.1);
    const all = await say(z, 'chat.example.org/s/1/t/plain', 'chat.example.org/u/2', 'can everyone look soon', { mentionsSelf: true, mentionsAll: true, mentionsGroup: true });
    // @all wins over the group flag: not about you.
    expect(all.facts).toMatchObject({ everyone: true, conv: false });
    expect(all.facts!.group).toBeUndefined();
    expect(byName.facts!.score!).toBeGreaterThan(group.facts!.score!);
    expect(group.facts!.score!).toBeGreaterThan(all.facts!.score!);
    triage.judge = null;
  });

  test('a Discord role mentioned where the server suppresses role mentions would not have notified you', () => {
    expect(rules(d, 'roles-off', 'bob', 'mods, look', { mentionsSelf: true, mentionsGroup: true }).facts).toMatchObject({ group: true, notify: false });
    expect(rules(d, 'roles-on', 'bob', 'mods, look', { mentionsSelf: true, mentionsGroup: true }).facts).toMatchObject({ group: true, notify: true });
    // An older extractor sends a role ping as a mention by name: it notifies as one, suppressed roles or not.
    expect(rules(d, 'roles-off', 'bob', 'mods, look', { mentionsSelf: true }).facts).toMatchObject({ mention: true, notify: true });
  });
});

describe('unread @everyone in the inbox', () => {
  const vantage = (cid: string) => store.one<{ unread: number; mentions: number; wildcards: number }>(`SELECT unread, mentions, wildcards FROM vantage WHERE account_id = ? AND target_id = ?`, z.id, cid)!;

  test('counted apart from mentions of you, live, from the network, and from the messages when the network does not say', () => {
    const cid = conv('chat.example.org/s/3/t/any');
    store.ingest(z, { t: 'read', conversation: 'chat.example.org/s/3/t/any', upToTs: clock, unread: 0, mentions: 0 });
    post(z, 'chat.example.org/s/3/t/any', 'chat.example.org/u/2', 'hi @**Me**', { mentionsSelf: true });
    post(z, 'chat.example.org/s/3/t/any', 'chat.example.org/u/2', '@**all** hi', { mentionsSelf: true, mentionsAll: true });
    post(z, 'chat.example.org/s/3/t/any', 'chat.example.org/u/2', '@**topic** hi', { mentionsSelf: true, mentionsAll: true });
    expect(vantage(cid)).toEqual({ unread: 3, mentions: 3, wildcards: 2 });
    // The network's counts, as it says them.
    store.ingest(z, { t: 'read', conversation: 'chat.example.org/s/3/t/any', upToTs: clock - 3 * MIN, unread: 3, mentions: 3, wildcards: 1 });
    expect(vantage(cid)).toEqual({ unread: 3, mentions: 3, wildcards: 1 });
    // An extractor from before `wildcards`: as many as the hub holds unread, never more than the mentions.
    store.ingest(z, { t: 'read', conversation: 'chat.example.org/s/3/t/any', upToTs: clock - 3 * MIN, unread: 3, mentions: 3 });
    expect(vantage(cid)).toEqual({ unread: 3, mentions: 3, wildcards: 2 });
    store.ingest(z, { t: 'read', conversation: 'chat.example.org/s/3/t/any', upToTs: clock - 3 * MIN, unread: 3, mentions: 1 });
    expect(vantage(cid)).toEqual({ unread: 3, mentions: 1, wildcards: 1 });
    store.markRead(cid, clock);
    expect(vantage(cid)).toEqual({ unread: 0, mentions: 0, wildcards: 0 });
  });

  test('an unread @everyone weighs less than a mention of you and more than any other message', () => {
    const now = Date.now();
    const base: ScoreInput = { now, shape: 'channel', members: 40, lastMessageAt: now - MIN, state: freshState(), author: null, authorName: null, unread: 1, mentions: 0, pinged: null, muted: null, usage: null };
    const plain = scoreConversation(base);
    const named = scoreConversation({ ...base, mentions: 1 });
    const wild = scoreConversation({ ...base, mentions: 1, wildcards: 1 });
    expect(named.parts.unread! - wild.parts.unread!).toBe(WEIGHTS.unreadAddressed - WEIGHTS.unreadWildcard);
    expect(wild.parts.unread! - plain.parts.unread!).toBe(WEIGHTS.unreadWildcard - WEIGHTS.unreadOther);
    expect(named.reasons.includes('1 unread mention')).toBe(true);
    expect(wild.reasons.includes('1 @everyone')).toBe(true);
    expect(scoreConversation({ ...base, unread: 3, mentions: 2, wildcards: 1 }).reasons.includes('1 unread mention, 1 @everyone, 1 more unread')).toBe(true);
  });
});

/**
 * End-to-end mapping proof WITHOUT a browser: build a realistic raw Discord
 * snapshot, run it through the adapter's own translate layer, and feed the
 * resulting facts into a REAL hub Store. Then assert the hub's bootstrap view --
 * the exact shapes the PWA would render. This exercises map.ts + ingest.ts +
 * the hub's ingest + deterministic ids all at once.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../hub/src/store.ts';
import type { AccountRow } from '../../hub/src/store.ts';
import { hubId } from '@dither-chat/protocol/ids';
import { messageEvents, newState, translateDispatch, translateSnapshot } from '../src/ingest.ts';
import type { RawSnapshot } from '../src/discord-types.ts';

const GUILD = '200000000000000001';
const CAT_HELP = '300000000000000100';
const CH_BEGINNERS = '300000000000000200';
const CH_RULES = '300000000000000009';
const CH_ANN = '300000000000000005';
const THREAD = '500000000000000001';
const DM = '600000000000000001';
const GDM = '600000000000000002';
const SELF = '100000000000000001';
const ALICE = '400000000000000001';
const FERRIS = '400000000000000002';

const snapshot: RawSnapshot = {
  self: { id: SELF, username: 'zyansheep', global_name: 'zyan' },
  guilds: [{ id: GUILD, name: 'Rust Programming Language', icon: 'abc', description: 'unofficial', rules_channel_id: CH_RULES }],
  channels: [
    { id: CAT_HELP, type: 4, name: 'Help', guild_id: GUILD, position: 1 },
    { id: CH_BEGINNERS, type: 0, name: 'beginners', topic: 'No question is too small', guild_id: GUILD, parent_id: CAT_HELP, position: 2 },
    { id: CH_RULES, type: 0, name: 'rules', guild_id: GUILD, position: 0 },
    { id: CH_ANN, type: 5, name: 'announcements', guild_id: GUILD, parent_id: CAT_HELP, position: 1 },
  ],
  threads: [{ id: THREAD, type: 11, name: 'async closures', guild_id: GUILD, parent_id: CH_BEGINNERS, thread_metadata: { archived: false } }],
  privateChannels: [
    { id: DM, type: 1, recipients: [{ id: ALICE, username: 'alice.chen', global_name: 'Alice' }] },
    { id: GDM, type: 3, name: 'weekend raid', recipients: [{ id: ALICE, username: 'alice.chen', global_name: 'Alice' }, { id: FERRIS, username: 'ferris', bot: true }] },
  ],
  relationships: [{ id: ALICE, type: 1 }],
  users: [{ id: ALICE, username: 'alice.chen', global_name: 'Alice', avatar: 'deadbeef' }, { id: FERRIS, username: 'ferris', bot: true }],
  readStates: [{ id: CH_BEGINNERS, last_message_id: '4194304', mention_count: 1 }],
  guildSettings: [
    { guild_id: GUILD, muted: false, message_notifications: 1, channel_overrides: [{ channel_id: CH_ANN, muted: true }] },
    { guild_id: null, channel_overrides: [] },
  ],
};

let dir: string;
let store: Store;
let acc: AccountRow;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-pipe-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  acc = store.createAccount({ network: 'discord', label: 'throwaway', color: '#5865F2', adapter: 'discord' });

  const st = newState();
  const { events, backfillTargets } = translateSnapshot(snapshot, st);
  // a couple of live events on top of the snapshot
  const live = [
    ...translateDispatch('MESSAGE_CREATE', { message: { id: '700000000000000010', channel_id: CH_BEGINNERS, author: { id: ALICE, username: 'alice.chen', global_name: 'Alice' }, content: `hey <@${SELF}> look at this`, timestamp: '2024-06-01T12:00:00.000Z', mentions: [{ id: SELF }] } }, st),
    ...translateDispatch('TYPING_START', { channelId: DM, userId: ALICE }, st),
  ];
  // feed hello + status so the account looks online, then every fact
  store.ingest(acc, { t: 'hello', network: 'discord', version: 'test', capabilities: ['send', 'history', 'liveView'] });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: SELF, handle: 'zyansheep', displayName: 'zyan', isSelf: true } });
  for (const ev of [...events, ...live]) store.ingest(acc, ev);

  // expose for a backfill assertion
  (globalThis as any).__backfill = backfillTargets;
});

afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('hub ingest of adapter facts', () => {
  test('guild -> community space; category -> section with guild parent + position', () => {
    const boot = store.bootstrap();
    const guild = boot.spaces.find((s) => s.nativeId === GUILD)!;
    expect(guild.kind).toBe('community');
    expect(guild.name).toBe('Rust Programming Language');
    const cat = boot.spaces.find((s) => s.nativeId === CAT_HELP)!;
    expect(cat.kind).toBe('section');
    const edge = boot.edges.find((e) => e.parentId === hubId('spc', 'discord', GUILD) && e.childId === hubId('spc', 'discord', CAT_HELP));
    expect(edge).toBeTruthy();
    expect(edge!.position).toBe('000001');
  });

  test('channels: variants, rules channel, category parent edge, positions', () => {
    const boot = store.bootstrap();
    const beginners = boot.conversations.find((c) => c.nativeId === CH_BEGINNERS)!;
    expect(beginners.shape).toBe('channel');
    expect(beginners.variant).toBe('text');
    expect(beginners.topic).toBe('No question is too small');
    const rules = boot.conversations.find((c) => c.nativeId === CH_RULES)!;
    expect(rules.variant).toBe('rules');
    const ann = boot.conversations.find((c) => c.nativeId === CH_ANN)!;
    expect(ann.variant).toBe('announcement');
    // beginners sits under the Help category at position 2
    const edge = boot.edges.find((e) => e.parentId === hubId('spc', 'discord', CAT_HELP) && e.childId === hubId('cnv', 'discord', CH_BEGINNERS));
    expect(edge!.position).toBe('000002');
  });

  test('announcement channel carries the per-channel mute', () => {
    const boot = store.bootstrap();
    const ann = boot.conversations.find((c) => c.nativeId === CH_ANN)!;
    expect(ann.nativeMute).toEqual({ level: 'none' });
  });

  test('thread -> thread shape with parent conversation', () => {
    const boot = store.bootstrap();
    const th = boot.conversations.find((c) => c.nativeId === THREAD)!;
    expect(th.shape).toBe('thread');
    expect(th.parentId).toBe(hubId('cnv', 'discord', CH_BEGINNERS));
  });

  test('DM -> direct, group DM -> group with participants', () => {
    const boot = store.bootstrap();
    const dm = boot.conversations.find((c) => c.nativeId === DM)!;
    expect(dm.shape).toBe('direct');
    const gdm = boot.conversations.find((c) => c.nativeId === GDM)!;
    expect(gdm.shape).toBe('group');
    expect(gdm.name).toBe('weekend raid');
    expect(gdm.participantIds).toContain(hubId('idn', 'discord', FERRIS));
    expect(gdm.participantIds).toContain(hubId('idn', 'discord', ALICE));
  });

  test('self identity recorded on the account; friend becomes a contact person', () => {
    const boot = store.bootstrap();
    expect(boot.accounts[0].selfIdentityId).toBe(hubId('idn', 'discord', SELF));
    const aliceIdn = boot.identities.find((i) => i.nativeId === ALICE)!;
    expect(aliceIdn.displayName).toBe('Alice');
    expect(aliceIdn.personId).toBeTruthy(); // friend -> promoted to a Person
    const ferrisIdn = boot.identities.find((i) => i.nativeId === FERRIS)!;
    expect(ferrisIdn.isBot).toBe(true);
  });

  test('live mention sets the mention flag and bumps the unread vantage', () => {
    const page = store.messages(hubId('cnv', 'discord', CH_BEGINNERS), null, 50);
    const msg = page.messages.find((m) => m.nativeId === '700000000000000010')!;
    expect(msg.mentionsSelf).toBe(true);
    expect(msg.body).toBe(`hey <@${SELF}> look at this`);
    const boot = store.bootstrap();
    const beginners = boot.conversations.find((c) => c.nativeId === CH_BEGINNERS)!;
    const v = beginners.vantages.find((x) => x.accountId === acc.id)!;
    expect(v.mentions).toBeGreaterThanOrEqual(1);
  });

  test('a message names its author and mentions, once each', () => {
    const st = newState();
    st.selfId = SELF;
    const bot = { id: '400000000000000009', username: 'Midjourney Bot', bot: true };
    const stranger = { id: '400000000000000010', username: 'someone', global_name: 'Some One' };
    const raw = { id: '700000000000000020', channel_id: CH_BEGINNERS, author: bot, content: `done <@${stranger.id}>`, timestamp: '2024-06-01T12:01:00.000Z', mentions: [stranger, { id: SELF, username: 'zyansheep' }], type: 20, embeds: [{ title: 'Job', description: 'finished', image: { url: 'https://cdn.discordapp.com/x.png' } }] };
    const events = messageEvents(raw, st, false);
    expect(events.map((e) => e.t)).toEqual(['identity', 'identity', 'message']);
    expect(messageEvents({ ...raw, id: '700000000000000021' }, st, false).map((e) => e.t)).toEqual(['message']);
    for (const ev of events) store.ingest(acc, ev);

    const page = store.messages(hubId('cnv', 'discord', CH_BEGINNERS), null, 50);
    expect(page.identities.find((i) => i.nativeId === bot.id)).toMatchObject({ displayName: 'Midjourney Bot', isBot: true });
    expect(page.identities.find((i) => i.nativeId === stranger.id)?.displayName).toBe('Some One');
    const msg = page.messages.find((m) => m.nativeId === raw.id)!;
    expect(msg.kind).toBe('text'); // a slash command reply is an ordinary message
    expect(msg.embeds).toMatchObject([{ title: 'Job', description: 'finished' }]);
    expect(msg.embeds[0].image).toBe('https://cdn.discordapp.com/x.png'); // this test Store's signer passes URLs through
  });

  test('the echo of a send in flight is dropped; the real message is not', () => {
    const st = newState();
    st.selfId = SELF;
    const message = { id: '700000000000000030', channel_id: DM, author: { id: SELF, username: 'zyansheep' }, content: 'hi', timestamp: '2024-06-01T12:02:00.000Z' };
    expect(translateDispatch('MESSAGE_CREATE', { message, optimistic: true }, st)).toEqual([]);
    expect(translateDispatch('MESSAGE_CREATE', { message }, st).map((e) => e.t)).toEqual(['message']);
  });

  test('a rename arrives through CHANNEL_UPDATES', () => {
    const st = newState();
    st.selfId = SELF;
    translateDispatch('CHANNEL_UPDATES', { channels: [{ id: GDM, type: 3, name: 'renamed', recipients: [{ id: ALICE, username: 'alice.chen' }] }] }, st).forEach((ev) => store.ingest(acc, ev));
    expect(store.bootstrap().conversations.find((c) => c.nativeId === GDM)?.name).toBe('renamed');
  });

  test('backfill targets are DMs plus unread-mention channels only', () => {
    const targets: string[] = (globalThis as any).__backfill;
    expect(targets).toContain(DM);
    expect(targets).toContain(GDM);
    expect(targets).toContain(CH_BEGINNERS); // mention_count > 0
    expect(targets).not.toContain(CH_RULES); // no unread mentions, loads lazily
  });
});

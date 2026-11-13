/**
 * One chat per person (docs/chats.md): the rule that says what tells a route from the chat's others, which every part
 * of the page asks before it adds anything, and the inbox's one row per chat (chatroutes.ts). The page itself is
 * checked in a browser against the multiaccount demo.
 */
import { expect, test } from 'bun:test';
import { accountName, badgeDiffers, cameFromThem, chatKey, groupChats, headIdents, labelText, leadTells, mergeRoutes, pickHolds, tagTells, tagText, tells, type HeadName, type RouteKey, type RoutePart } from '../src/chatroutes.ts';
import { inboxSnapshot, inboxView, rank, type Ranked } from '../src/ordering.ts';

const r = (id: string, network: string, theirs: string, mine: string): RouteKey => ({ id, network, theirs, mine });
const names = (theirs: string, mine: string, network = 'Discord') => ({ network, theirs, mine });

// Kit: eight routes on five networks, as in the demo.
const KIT = [
  r('dm-kit-main', 'discord', 'kit.exe', 'zyansheep'),
  r('dm-kitwork-main', 'discord', 'kit.work', 'zyansheep'),
  r('dm-kit-alt', 'discord', 'kit.exe', 'zyn.alt'),
  r('dm-kitalt-alt', 'discord', 'kit_alt', 'zyn.alt'),
  r('sig', 'signal', 'kit-sig', 'zyan.01'),
  r('mx', 'matrix', 'kit-mx', 'mx'),
  r('mx-nix', 'matrix', 'kit-nix', 'mx'),
  r('tg', 'telegram', 'kit-tg', 'tg'),
];

test('one route: nothing tells it apart, and the page is a plain conversation', () => {
  const nana = [r('wa', 'whatsapp', 'nana', 'zyan')];
  expect(tells(nana[0], nana)).toEqual({ network: false, theirs: false, mine: false });
  expect(labelText(tells(nana[0], nana), names('nana', 'zyan', 'WhatsApp'))).toBe('');
  expect(leadTells(nana[0], nana)).toEqual({ network: false, theirs: false, mine: false });
  expect(badgeDiffers(nana)).toBe(false);
});

test('two networks, one route each: the network alone', () => {
  const sam = [r('sig', 'signal', 'sam-s', 'zyan.01'), r('mx', 'matrix', 'sam-m', 'mx')];
  const t = tells(sam[0], sam);
  expect(t).toEqual({ network: true, theirs: false, mine: false });
  expect(labelText(t, names('sam', 'zyan.01', 'Signal'))).toBe('Signal');
  // The page draws the icon instead of the network's name before a name, but the network alone is the name.
  expect(labelText(t, names('sam', 'zyan.01', 'Signal'), false)).toBe('Signal');
  expect(leadTells(sam[0], sam)).toEqual({ network: true, theirs: false, mine: false });
  expect(badgeDiffers(sam)).toBe(true);
});

test('two of their accounts on one network: their account’s name, and no network', () => {
  const mo = [r('a', 'discord', 'mo.codes', 'zyansheep'), r('b', 'discord', 'mo.draws', 'zyansheep')];
  const t = tells(mo[1], mo);
  expect(t).toEqual({ network: false, theirs: true, mine: false });
  expect(labelText(t, names('mo.draws', 'zyansheep'))).toBe('mo.draws');
  expect(leadTells(mo[1], mo)).toEqual({ network: false, theirs: true, mine: false });
  // One network, one account of yours: the badge would be the same on every picture.
  expect(badgeDiffers(mo)).toBe(false);
});

test('two of your accounts with one of theirs: yours, as "via …"', () => {
  const ravi = [r('a', 'discord', 'ravi_p', 'zyansheep'), r('b', 'discord', 'ravi_p', 'zyn.alt')];
  const t = tells(ravi[1], ravi);
  expect(t).toEqual({ network: false, theirs: false, mine: true });
  expect(labelText(t, names('ravi_p', 'zyn.alt'))).toBe('via zyn.alt');
  // The box says "· via zyn.alt": their account is reached from two of yours.
  expect(leadTells(ravi[1], ravi)).toEqual({ network: false, theirs: false, mine: true });
  // Two of your accounts on a network: the badge's dots tell them apart.
  expect(badgeDiffers(ravi)).toBe(true);
});

test('both differ on a network: both names; the network joins where networks mix', () => {
  const t = tells(KIT[1], KIT);
  expect(t).toEqual({ network: true, theirs: true, mine: true });
  expect(labelText(t, names('kit.work', 'zyansheep'))).toBe('Discord kit.work ⇄ zyansheep');
  expect(labelText(t, names('kit.work', 'zyansheep'), false)).toBe('kit.work ⇄ zyansheep');
  // Alone on its network: the network alone, even in a chat of eight.
  expect(labelText(tells(KIT[4], KIT), names('kit', 'zyan.01', 'Signal'))).toBe('Signal');
  // Matrix: their two accounts, one of yours.
  expect(tells(KIT[6], KIT)).toEqual({ network: true, theirs: true, mine: false });
  expect(badgeDiffers(KIT)).toBe(true);
});

test('the message box says your account only when theirs can be reached from several of yours', () => {
  // kit.exe talks with zyansheep and zyn.alt: "from" shows.
  expect(leadTells(KIT[0], KIT)).toEqual({ network: true, theirs: true, mine: true });
  // kit.work only with zyansheep: no "from", though the tag names both.
  expect(leadTells(KIT[1], KIT)).toEqual({ network: true, theirs: true, mine: false });
  expect(tells(KIT[1], KIT).mine).toBe(true);
  // Signal: "Message Kit on Signal".
  expect(leadTells(KIT[4], KIT)).toEqual({ network: true, theirs: false, mine: false });
});

test('two conversations between the same two accounts: both names, which is all there is', () => {
  const again = [r('a', 'discord', 'x', 'me'), r('b', 'discord', 'x', 'me')];
  expect(tells(again[0], again)).toEqual({ network: false, theirs: true, mine: true });
});

// ------------------------------------------------------------------ the inbox

const NOW = 1_800_000_000_000;
const part = (key: string, o: Partial<RoutePart> = {}): RoutePart => ({ key, score: 10, needs: false, reasons: [`${key} reason`], owedSince: null, last: NOW, unread: 0, muted: false, ...o });

test('a message head names the account; the tag says only what the head does not', () => {
  // Kit's message on Discord through zyansheep: the head says kit.exe, so the tag says yours, and the icon.
  const fromThem = tagTells(KIT[0], KIT, 'theirs');
  expect(fromThem).toEqual({ network: true, theirs: false, mine: true });
  expect(tagText(fromThem, names('kit.exe', 'zyansheep'), 'theirs')).toBe('via zyansheep');
  // Yours there: the head says zyansheep, so the tag says which of theirs it went to.
  const fromMe = tagTells(KIT[0], KIT, 'mine');
  expect(fromMe).toEqual({ network: true, theirs: true, mine: false });
  expect(tagText(fromMe, names('kit.exe', 'zyansheep'), 'mine')).toBe('to kit.exe');
  // Telegram, the only route there: the network's icon and no words.
  expect(tagTells(KIT[7], KIT, 'theirs')).toEqual({ network: true, theirs: false, mine: false });
  expect(tagText(tagTells(KIT[7], KIT, 'theirs'), names('@kitkat', '@zyansheep', 'Telegram'), 'theirs')).toBe('');
  // Mo, two of theirs and one of yours on one network: the head says it all after theirs; after yours, which of theirs.
  const mo = [r('a', 'discord', 'mo.codes', 'zyansheep'), r('b', 'discord', 'mo.draws', 'zyansheep')];
  expect(tagText(tagTells(mo[1], mo, 'theirs'), names('mo.draws', 'zyansheep'), 'theirs')).toBe('');
  expect(tagTells(mo[1], mo, 'theirs')).toEqual({ network: false, theirs: false, mine: false });
  expect(tagText(tagTells(mo[1], mo, 'mine'), names('mo.draws', 'zyansheep'), 'mine')).toBe('to mo.draws');
  // A bot in the DM: the whole label, as before.
  expect(tagText(tagTells(mo[1], mo, 'other'), names('mo.draws', 'zyansheep'), 'other')).toBe('mo.draws');
  // One route: nothing, whoever wrote.
  const nana = [r('wa', 'whatsapp', 'nana', 'zyan')];
  for (const side of ['theirs', 'mine', 'other'] as const) expect(tagTells(nana[0], nana, side)).toEqual({ network: false, theirs: false, mine: false });
});

test('an account shows its handle after its name only where another on its side and network shares the name', () => {
  const h = (id: string, network: string, name: string, ident: string | null): HeadName => ({ id, network, name, ident });
  // Kit says "Kit" on Discord and on Telegram (case aside): the badge tells them apart, so no handle.
  const kit = [h('exe', 'discord', 'Kit', 'kit.exe'), h('work', 'discord', 'Kit Okafor', 'kit.work'), h('tg', 'telegram', 'kit', '@kitkat'), h('mx', 'matrix', 'kitty', '@kit:matrix.org')];
  expect(headIdents(kit).size).toBe(0);
  // Mo is "Mo" on two Discord accounts: both show their handle.
  expect([...headIdents([h('a', 'discord', 'Mo', 'mo.codes'), h('b', 'discord', 'mo', 'mo.draws')])]).toEqual([
    ['a', 'mo.codes'],
    ['b', 'mo.draws'],
  ]);
  // All different: no handles.
  expect(headIdents([h('a', 'discord', 'Mo', 'mo.codes'), h('b', 'discord', 'mo (art)', 'mo.draws')]).size).toBe(0);
  // One account seen on several routes counts once.
  expect(headIdents([h('exe', 'discord', 'Kit', 'kit.exe'), h('exe', 'discord', 'Kit', 'kit.exe')]).size).toBe(0);
  // A handle that says no more than the name is left out; one with no handle has nothing to add.
  expect([...headIdents([h('a', 'signal', 'zyan', 'zyan'), h('b', 'signal', 'zyan', '+1 555 0100'), h('c', 'signal', 'Zyan ', null)])]).toEqual([['b', '+1 555 0100']]);
});

test('a chat’s row: the highest score, needs you if any route does, owed since the earliest, unread summed, muted only if all are', () => {
  const m = mergeRoutes([
    part('dm-kit-main', { score: 20, last: NOW - 5000, unread: 1, muted: true }),
    part('sig', { score: 55, needs: true, owedSince: NOW - 3000, last: NOW - 1000, unread: 2 }),
    part('mx', { score: 30, owedSince: NOW - 9000, last: NOW, unread: 1, muted: true }),
  ]);
  expect(m).toMatchObject({ score: 55, needs: true, owedSince: NOW - 9000, unread: 4, muted: false, reasons: ['sig reason'] });
  expect(m.top.key).toBe('sig');
  // What the row shows and opens: the latest message's route.
  expect(m.latest.key).toBe('mx');
  expect(mergeRoutes([part('a', { muted: true }), part('b', { muted: true })]).muted).toBe(true);
  expect(mergeRoutes([part('a'), part('b')]).owedSince).toBe(null);
});

test('the inbox lists a person of several routes once, under person:<id>, ranked by the merge', () => {
  const rows = [
    part('dm-kit-main', { score: 20, last: NOW - 5000 }),
    part('sig', { score: 55, last: NOW - 1000, unread: 2 }),
    part('mx', { score: 30, last: NOW }),
    part('grp', { score: 40, last: NOW - 2000 }),
    part('nana', { score: 50, last: NOW - 100 }),
  ];
  const kit = new Set(['dm-kit-main', 'sig', 'mx']);
  const g = groupChats(rows, (x) => (kit.has(x.key) ? 'per_kit' : null));
  expect(g.rows.map((x) => x.key)).toEqual(['grp', 'nana']);
  expect(g.chats).toHaveLength(1);
  const c = g.chats[0];
  expect(c.key).toBe(chatKey('per_kit'));
  expect(c.key).toBe('person:per_kit');
  expect(c.parts.map((x) => x.key)).toEqual(['mx', 'sig', 'dm-kit-main']);
  expect(c.unread).toBe(2);
  const ranked: Ranked[] = [...g.rows, c].map((x) => ({ key: x.key, score: x.score, last: 'last' in x ? x.last : c.latest.last }));
  expect(rank(ranked)).toEqual(['person:per_kit', 'nana', 'grp']);
  // The open chat keeps its place by its one key, whichever DM of theirs is open (inbox.ts maps it).
  const snap = inboxSnapshot(ranked, undefined);
  const later = ranked.map((x) => (x.key === 'person:per_kit' ? { ...x, score: 1 } : x));
  const held = inboxSnapshot(later, { key: 'person:per_kit', prev: snap });
  expect(inboxView(held, later, () => true)[0]).toBe('person:per_kit');
});

test('an account goes by your nickname for it, and the handle rule compares the names as you see them', () => {
  const mo = { nativeId: '1', handle: 'mo.codes', displayName: 'Mo' };
  expect(accountName(mo)).toBe('Mo');
  expect(accountName({ ...mo, nickname: 'Mo at work' })).toBe('Mo at work');
  expect(accountName({ nativeId: '2', handle: 'mo.draws', displayName: null })).toBe('mo.draws');
  expect(accountName({ nativeId: '3', displayName: '', handle: null })).toBe('3');
  const head = (id: string, i: Parameters<typeof accountName>[0]): HeadName => ({ id, network: 'discord', name: accountName(i), ident: i.handle ?? i.nativeId });
  // Both "Mo": the handle tells them apart. A nickname on one tells them apart already.
  expect(headIdents([head('a', mo), head('b', { nativeId: '2', handle: 'mo.draws', displayName: 'Mo' })]).size).toBe(2);
  expect(headIdents([head('a', { ...mo, nickname: 'Mo at work' }), head('b', { nativeId: '2', handle: 'mo.draws', displayName: 'Mo' })]).size).toBe(0);
  // Two accounts you gave the same nickname are told apart again by their handles.
  expect(headIdents([head('a', { ...mo, nickname: 'Momo' }), head('b', { nativeId: '2', handle: 'mo.draws', displayName: 'Mo', nickname: 'momo' })])).toEqual(
    new Map([
      ['a', 'mo.codes'],
      ['b', 'mo.draws'],
    ]),
  );
});

test('a pick holds until a message comes on another route after it', () => {
  // Switched to Discord at 1000 (an hour before, the tab still open); she wrote on Signal at 2000.
  expect(pickHolds('disc', 1000, [{ id: 'disc', lastMessageAt: 900 }, { id: 'sig', lastMessageAt: 800 }])).toBe(true);
  expect(pickHolds('disc', 1000, [{ id: 'sig', lastMessageAt: 2000 }, { id: 'disc', lastMessageAt: 900 }])).toBe(false);
  // Messages on the picked route itself, or none at all, keep it.
  expect(pickHolds('disc', 1000, [{ id: 'disc', lastMessageAt: 3000 }, { id: 'sig', lastMessageAt: null }])).toBe(true);
});

test('where you came from counts only where they are: a DM with someone else says nothing of how to reach them', () => {
  const kit = new Set(['kit-sig', 'kit-disc']);
  const isKit = (id: string) => kit.has(id);
  // A Discord DM with Sam, then Kit's page from the people list: no guess, the latest message (Signal) decides.
  expect(cameFromThem({ participantIds: ['me-disc', 'sam'] }, [{ authorId: 'sam' }, { authorId: 'me-disc' }], isKit)).toBe(false);
  // A group Kit is in, or a server channel where Kit wrote among the loaded messages: the account you read on.
  expect(cameFromThem({ participantIds: ['me-disc', 'sam', 'kit-disc'] }, [], isKit)).toBe(true);
  expect(cameFromThem({ participantIds: [] }, [{ authorId: null }, { authorId: 'kit-disc' }], isKit)).toBe(true);
  // A channel Kit was not seen in.
  expect(cameFromThem({ participantIds: [] }, [{ authorId: 'sam' }], isKit)).toBe(false);
});

import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { GROUP_RULES } from '@dither-chat/protocol';
import { andList, fewNames, fitLine, groupCap, labelAccounts, leftOutLine, madeToast, makeLabel, makeProblem, mergePeople, namePlaceholder, networksOf, preselect, shortLine, whereOptions, whereSub, type GroupPerson, type MakerAccount } from '../src/groups.ts';

const LABEL: Record<string, string> = { dmain: 'main', dalt: 'alt', sig: 'personal', mx: 'matrix.org', tg: 'personal' };
const NET: Record<string, P.Network> = { dmain: 'discord', dalt: 'discord', sig: 'signal', mx: 'matrix', tg: 'telegram' };
const acc = (id: string, candidates: [string, number?][]) => ({ accountId: id, network: NET[id], rule: GROUP_RULES[NET[id]]!, candidates: candidates.map(([identityId, lastTalked]) => ({ identityId, ...(lastTalked ? { lastTalked } : {}) })) });

// Identities: "<person>@<account>"; "x@..." has no person.
const info = (id: string) => {
  const [who] = id.split('@');
  return who === 'x' ? { personId: null, name: 'Stray', handle: '@stray' } : { personId: `per_${who}`, name: who[0].toUpperCase() + who.slice(1), handle: `@${who}` };
};

const view = {
  accounts: [
    acc('dmain', [['ravi@dmain', 50], ['jordan@dmain', 40], ['alice@dmain']]),
    acc('dalt', [['ravi@dalt', 10], ['jordan@dalt']]),
    acc('sig', [['mom@sig', 90], ['alice@sig', 5], ['dad@sig']]),
    acc('mx', [['alice@mx', 20], ['x@mx']]),
  ],
};
const accounts: MakerAccount[] = labelAccounts(view, (a) => LABEL[a]);
const people = mergePeople(accounts, info);
const who = (...names: string[]) => names.map((n) => people.find((p) => p.name === n)!);

describe('people across accounts', () => {
  test('labels: the account only where you have several on a network', () => {
    expect(accounts.map((a) => a.label)).toEqual(['Discord · main', 'Discord · alt', 'Signal', 'Matrix']);
  });
  test('one row per person, the identity with no person its own row, the most recent talk first, then by name', () => {
    expect(people.map((p) => p.name)).toEqual(['Mom', 'Ravi', 'Jordan', 'Alice', 'Dad', 'Stray']);
    const alice = who('Alice')[0];
    expect(alice.key).toBe('per_alice');
    expect(alice.via.map((v) => v.accountId)).toEqual(['dmain', 'sig', 'mx']);
    expect(alice.last).toBe(20);
    expect(networksOf(who('Ravi')[0])).toEqual(['discord']);
    expect(networksOf(alice)).toEqual(['discord', 'signal', 'matrix']);
    expect(who('Stray')[0].key).toBe('x@mx');
    expect(alice.handles).toBe('@alice');
  });
  test('the cap is the biggest group any account could start', () => {
    expect(groupCap(accounts)).toBe(10);
    expect(groupCap([accounts[0]])).toBe(9);
    expect(groupCap([])).toBe(0);
  });
  test('preselected: only keys that are someone here, each once, up to the cap', () => {
    expect(preselect(['per_ravi', 'per_ghost', 'per_ravi'], people, 10)).toEqual(['per_ravi']);
    expect(preselect(undefined, people, 10)).toEqual([]);
    expect(preselect(['per_ravi', 'per_mom'], people, 1)).toEqual(['per_ravi']);
  });
});

describe('the fit line', () => {
  test('nobody picked: nothing to say', () => expect(fitLine(accounts, [])).toBeNull());
  test('every account of a network fits: the network alone; one account of several: its label', () => {
    expect(fitLine(accounts, who('Ravi', 'Jordan'))).toBe('Only Discord reaches both');
    expect(fitLine(accounts, who('Alice', 'Mom'))).toBe('Only Signal reaches both');
    expect(fitLine(accounts, who('Alice'))).toBe('Fits Signal and Matrix');
    const both = mergePeople(labelAccounts({ accounts: [acc('dmain', [['ravi@dmain'], ['alice@dmain']]), acc('dalt', [['ravi@dalt']]), acc('sig', [['ravi@sig'], ['alice@sig']])] }, (a) => LABEL[a]), info);
    expect(fitLine(labelAccounts({ accounts: [acc('dmain', [['ravi@dmain'], ['alice@dmain']]), acc('dalt', [['ravi@dalt']]), acc('sig', [['ravi@sig'], ['alice@sig']])] }, (a) => LABEL[a]), both)).toBe('Fits Discord · main and Signal');
  });
  test('only one reaches all', () => {
    expect(fitLine(accounts, who('Mom', 'Dad', 'Alice'))).toBe('Only Signal reaches all 3');
    expect(fitLine(accounts, who('Mom', 'Alice'))).toBe('Only Signal reaches both');
  });
  test('no one network: who reaches how many, most first', () => {
    expect(fitLine(accounts, who('Ravi', 'Jordan', 'Mom'))).toBe('No one network reaches all 3: Discord reaches 2, Signal 1');
  });
  test('everyone reached but too few for the network: its rule in words', () => {
    expect(fitLine(accounts, who('Ravi'))).toBe('A Discord group DM starts with at least 2 friends');
  });
});

describe('where', () => {
  test('best first: everyone, then most people, then the most recent talk; the others say why', () => {
    const { options, short } = whereOptions(accounts, who('Ravi', 'Jordan', 'Alice'));
    expect(options.map((o) => [o.account.label, o.people.length, o.left.length])).toEqual([
      ['Discord · main', 3, 0],
      ['Discord · alt', 2, 1],
      // Alice was talked with on Matrix more recently than on Signal.
      ['Matrix', 1, 2],
      ['Signal', 1, 2],
    ]);
    expect(options[0].sub).toBe('Group DM with all 3');
    expect(options[1].sub).toBe('Group DM with 2 of 3: not Alice');
    expect(options[2].sub).toBe('Room, invites 1 of 3: in once they accept. Not Ravi and Jordan');
    expect(short).toEqual([]);
  });
  test('an account reaching too few is a line, not a row', () => {
    const { options, short } = whereOptions(accounts, who('Ravi', 'Mom'));
    expect(options.map((o) => o.account.label)).toEqual(['Signal']);
    expect(short).toEqual(['Discord · main: a group DM starts with at least 2 friends, and only Ravi is a friend there', 'Discord · alt: a group DM starts with at least 2 friends, and only Ravi is a friend there', 'Matrix: a room starts with at least 1 person, and none of them is known there']);
  });
  test('what it makes, and with whom', () => {
    const [ravi, jordan, mom] = who('Ravi', 'Jordan', 'Mom');
    expect(whereSub(GROUP_RULES.matrix!, [ravi, jordan, mom], [])).toBe('Room, invites all 3: in once they accept');
    expect(whereSub(GROUP_RULES.signal!, [mom], [])).toBe('Group with Mom');
    expect(whereSub(GROUP_RULES.discord!, [ravi, jordan], [])).toBe('Group DM with both');
    expect(whereSub(GROUP_RULES.signal!, [mom], [ravi])).toBe('Group with 1 of 2: not Ravi');
  });
  test('too many for one account', () => {
    const many: GroupPerson[] = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, name: `P${i}`, handles: '', last: 0, via: [{ accountId: 'dmain', network: 'discord', identityId: `i${i}`, lastTalked: 0 }] }));
    expect(shortLine(accounts[0], many)).toBe('Discord · main: a group DM starts with at most 9 friends, and 10 are picked there');
  });
});

describe('the name page', () => {
  test('who is left out, and why', () => {
    const sig = accounts.find((a) => a.accountId === 'sig')!;
    expect(leftOutLine(sig, who('Ravi'))).toBe('Not in it: Ravi, who is not on Signal here');
    expect(leftOutLine(sig, who('Ravi', 'Jordan'))).toBe('Not in it: Ravi and Jordan, who are not on Signal here');
    expect(leftOutLine(accounts[0], who('Mom'))).toBe('Not in it: Mom, who is not a Discord friend here');
    expect(leftOutLine(sig, [])).toBeNull();
  });
  test('placeholder and button from the rule', () => {
    expect(namePlaceholder(GROUP_RULES.discord!)).toBe('Name (optional)');
    expect(namePlaceholder(GROUP_RULES.signal!)).toBe('Name the group');
    expect(namePlaceholder(GROUP_RULES.matrix!)).toBe('Name the room');
    expect([makeLabel(GROUP_RULES.discord!), makeLabel(GROUP_RULES.signal!), makeLabel(GROUP_RULES.matrix!)]).toEqual(['Make group DM', 'Make group', 'Make room']);
  });
  test('the problem is the hub’s own sentence; nothing the rules refuse is sent', () => {
    expect(makeProblem('signal', '  ', 2)).toBe('Give the group a name');
    expect(makeProblem('signal', 'Climbers', 2)).toBeNull();
    expect(makeProblem('discord', '', 2)).toBeNull();
    expect(makeProblem('signal', 'x'.repeat(33), 2)).toBe("A Signal group's name is at most 32 characters");
  });
  test('the toast: invited, refused with the reason, notes; and when nobody could be added', () => {
    const name = (id: string) => ({ a: 'Dad', b: 'Noor' })[id] ?? id;
    expect(madeToast('Climbers', { added: ['x'], invited: ['a'], failed: [{ identityId: 'b', reason: "Their privacy settings don't let you add them to groups." }], notes: ['Telegram made it a basic group'] }, name)).toEqual({
      title: 'Made Climbers',
      body: "Invited Dad: in once they accept. Could not add Noor: Their privacy settings don't let you add them to groups. Telegram made it a basic group.",
    });
    expect(madeToast('Climbers', { added: [], invited: [], failed: [{ identityId: 'b', reason: 'No.' }], notes: [] }, name).title).toBe('Made Climbers, but nobody could be added');
  });
  test('lists of names', () => {
    expect(andList(['A'])).toBe('A');
    expect(andList(['A', 'B', 'C'])).toBe('A, B and C');
    expect(fewNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 more');
  });
});

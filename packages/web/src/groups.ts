/**
 * Making a group from the palette (docs/group-settings.md "Making a group", docs/palette.md), the part that needs no
 * browser: everyone any of your accounts could put in a group as one row per person, where a picked set fits, which
 * accounts could hold it and in what order, who is left out, and the button's label and problem. A group lives on
 * one network; picking across networks is the page's job, so the owner need not think network first.
 */
import type * as P from '@dither-chat/protocol';
import { createGroupProblem, NETWORK_META } from '@dither-chat/protocol';

/** One account that can make a group, as GET /api/groups/candidates gives it, with the label the page shows. */
export interface MakerAccount {
  accountId: string;
  network: P.Network;
  rule: P.GroupRule;
  candidates: { identityId: string; relationship?: P.PersonRelationship; lastTalked?: number }[];
  /** "Discord · main" when you have several accounts on that network, else "Discord". */
  label: string;
}

/** What the page knows of an identity: the person it belongs to, if any, and how to name it. */
export interface IdentityInfo {
  personId?: string | null;
  name: string;
  handle?: string | null;
}

/** Someone to pick: a person (or an identity no person holds) and each account that could put them in a group. */
export interface GroupPerson {
  key: string;
  name: string;
  /** Their handles, searched as the name is. */
  handles: string;
  /** By account: the identity that account would add. */
  via: { accountId: string; network: P.Network; identityId: string; lastTalked: number }[];
  /** The latest any account talked with them. */
  last: number;
}

const netName = (n: P.Network) => NETWORK_META[n]?.name ?? n;

/** Each account's label: the network, and the account's own label where you have more than one there. */
export function labelAccounts(view: Pick<P.GroupCandidatesView, 'accounts'>, labelOf: (accountId: string) => string): MakerAccount[] {
  const per = new Map<string, number>();
  for (const a of view.accounts) per.set(a.network, (per.get(a.network) ?? 0) + 1);
  return view.accounts.map((a) => ({ ...a, label: (per.get(a.network) ?? 0) > 1 ? `${netName(a.network)} · ${labelOf(a.accountId)}` : netName(a.network) }));
}

/** One row per person across every account: identities merged by their person, the most recent talk first, then by name. */
export function mergePeople(accounts: readonly MakerAccount[], info: (identityId: string) => IdentityInfo | undefined): GroupPerson[] {
  const rows = new Map<string, GroupPerson>();
  for (const a of accounts)
    for (const c of a.candidates) {
      const i = info(c.identityId);
      const key = i?.personId || c.identityId;
      let r = rows.get(key);
      if (!r) rows.set(key, (r = { key, name: i?.name ?? c.identityId, handles: '', via: [], last: 0 }));
      if (r.via.some((v) => v.accountId === a.accountId)) continue;
      const t = c.lastTalked ?? 0;
      r.via.push({ accountId: a.accountId, network: a.network, identityId: c.identityId, lastTalked: t });
      if (i?.handle && !r.handles.includes(i.handle)) r.handles = `${r.handles} ${i.handle}`.trim();
      r.last = Math.max(r.last, t);
    }
  return [...rows.values()].sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
}

/** The networks someone can be put in a group on, in the accounts' order, each once. */
export const networksOf = (p: GroupPerson): P.Network[] => [...new Set(p.via.map((v) => v.network))];

/** "Ann", "Ann and Bo", "Ann, Bo and Cy". */
export function andList(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** "Ravi", "Ravi and Mom", "Ravi, Mom and 2 more". */
export function fewNames(xs: readonly string[]): string {
  if (xs.length <= 3) return andList(xs);
  return `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`;
}

/** Of the picked, whom this account reaches, in the picked order. */
export const reached = (a: MakerAccount, picked: readonly GroupPerson[]) => picked.filter((p) => p.via.some((v) => v.accountId === a.accountId));

/** The account could make a group of everyone it reaches here: enough of them, and not too many. */
const holds = (a: MakerAccount, n: number) => n >= a.rule.min && n <= a.rule.max;

/** Accounts as the line names them: a network whose every account is in the list is the network alone. */
function namesOf(list: readonly MakerAccount[], all: readonly MakerAccount[]): string[] {
  const out: string[] = [];
  const done = new Set<P.Network>();
  for (const a of list) {
    if (done.has(a.network)) continue;
    const mine = all.filter((x) => x.network === a.network);
    if (mine.every((x) => list.includes(x))) {
      out.push(netName(a.network));
      done.add(a.network);
    } else out.push(a.label);
  }
  return out;
}

/**
 * Where the picked set fits so far, in one line, the shortest true thing: "Fits Discord · main and Signal", "Only
 * Signal reaches all 3", "No one network reaches all 3: Signal reaches 2, Discord 2". Null with nobody picked.
 */
export function fitLine(accounts: readonly MakerAccount[], picked: readonly GroupPerson[]): string | null {
  const n = picked.length;
  if (!n) return null;
  const all = accounts.filter((a) => reached(a, picked).length === n);
  const fit = all.filter((a) => holds(a, n));
  if (fit.length) {
    const names = namesOf(fit, accounts);
    return names.length === 1 && n > 1 ? `Only ${names[0]} reaches ${n === 2 ? 'both' : `all ${n}`}` : `Fits ${andList(names)}`;
  }
  // Everyone is reached, but too few or too many for that network: its own rule says why.
  if (all.length) return createGroupProblem(all[0].network, 'x', n);
  if (n === 1) return null;
  const best = new Map<P.Network, number>();
  for (const a of accounts) best.set(a.network, Math.max(best.get(a.network) ?? 0, reached(a, picked).length));
  const counts = [...best].filter(([, k]) => k > 0).sort((a, b) => b[1] - a[1]);
  if (!counts.length) return `No one network reaches any of them`;
  return `No one network reaches all ${n}: ${counts.map(([net, k], i) => (i ? `${netName(net)} ${k}` : `${netName(net)} reaches ${k}`)).join(', ')}`;
}

/** An account that could hold some of the picked: whom, who is left out, and what it would make. */
export interface WhereOption {
  account: MakerAccount;
  people: GroupPerson[];
  left: GroupPerson[];
  /** "Group DM with all 3", "Room, invites all 3: in once they accept", "Group with 2 of 3: not Ravi". */
  sub: string;
}

/** What it makes and with whom. */
export function whereSub(rule: P.GroupRule, people: readonly GroupPerson[], left: readonly GroupPerson[]): string {
  const n = people.length + left.length;
  const noun = rule.noun[0].toUpperCase() + rule.noun.slice(1);
  const whom = !left.length ? (n === 1 ? people[0].name : n === 2 ? 'both' : `all ${n}`) : `${people.length} of ${n}`;
  const not = left.length ? `: not ${fewNames(left.map((p) => p.name))}` : '';
  if (rule.mode === 'invite') return `${noun}, invites ${whom}: in once they accept${left.length ? `. Not ${fewNames(left.map((p) => p.name))}` : ''}`;
  return `${noun} with ${whom}${not}`;
}

/**
 * The accounts that could take at least their rule's fewest of the picked, best first: reaches everyone, then most
 * people, then the account you talked on most recently with them; and a line for each that reaches too few or too many.
 */
export function whereOptions(accounts: readonly MakerAccount[], picked: readonly GroupPerson[]): { options: WhereOption[]; short: string[] } {
  const options: (WhereOption & { recent: number; order: number })[] = [];
  const short: string[] = [];
  accounts.forEach((a, order) => {
    const people = reached(a, picked);
    const left = picked.filter((p) => !people.includes(p));
    if (holds(a, people.length)) {
      const recent = Math.max(0, ...people.map((p) => p.via.find((v) => v.accountId === a.accountId)!.lastTalked));
      options.push({ account: a, people, left, sub: whereSub(a.rule, people, left), recent, order });
    } else short.push(shortLine(a, people));
  });
  options.sort((x, y) => Number(!y.left.length) - Number(!x.left.length) || y.people.length - x.people.length || y.recent - x.recent || x.order - y.order);
  return { options: options.map(({ recent: _r, order: _o, ...o }) => o), short };
}

/** Why an account cannot hold these: "Discord · alt: a group DM starts with at least 2 friends, and only Mara is a friend there". */
export function shortLine(a: MakerAccount, people: readonly GroupPerson[]): string {
  const r = a.rule;
  const friends = r.who === 'friends';
  const them = (k: number) => (friends ? (k === 1 ? 'friend' : 'friends') : k === 1 ? 'person' : 'people');
  if (people.length > r.max) return `${a.label}: a ${r.noun} starts with at most ${r.max} ${them(r.max)}, and ${people.length} are picked there`;
  const there = friends ? (people.length === 1 ? 'is a friend there' : 'are friends there') : people.length === 1 ? 'is known there' : 'are known there';
  const which = !people.length ? `none of them ${friends ? 'is a friend' : 'is known'} there` : `only ${andList(people.map((p) => p.name))} ${there}`;
  return `${a.label}: a ${r.noun} starts with at least ${r.min} ${them(r.min)}, and ${which}`;
}

/** Who is not in it and why, on the name page: "Not in it: Ravi, who is not on Signal here". Null when nobody is left out. */
export function leftOutLine(a: MakerAccount, left: readonly GroupPerson[]): string | null {
  if (!left.length) return null;
  const one = left.length === 1;
  const where = a.rule.who === 'friends' ? `${one ? 'is not a' : 'are not'} ${netName(a.network)} friend${one ? '' : 's'} here` : `${one ? 'is' : 'are'} not on ${netName(a.network)} here`;
  return `Not in it: ${fewNames(left.map((p) => p.name))}, who ${where}`;
}

/** The name field's placeholder. */
export const namePlaceholder = (r: P.GroupRule) => (r.name === 'optional' ? 'Name (optional)' : `Name the ${r.noun === 'group DM' ? 'group' : r.noun}`);

/** The button: "Make group DM", "Make group", "Make room". */
export const makeLabel = (r: P.GroupRule) => `Make ${r.noun}`;

/** The button's problem, in the hub's own words; null when it may go. Nothing the rules refuse is ever sent. */
export const makeProblem = (network: P.Network, name: string, people: number) => createGroupProblem(network, name, people);

/** The largest group any account could start: the most at once on the people page. */
export const groupCap = (accounts: readonly MakerAccount[]) => Math.max(0, ...accounts.map((a) => a.rule.max));

/** The picks to start with: the keys asked for that are someone here, each once. */
export const preselect = (want: readonly string[] | undefined, people: readonly GroupPerson[], cap: number) =>
  [...new Set(want ?? [])].filter((k) => people.some((p) => p.key === k)).slice(0, cap);

/** What making it did, for the toast: its title and lines. `nameOf` names an identity. */
export function madeToast(name: string, r: Pick<P.CreateGroupView, 'added' | 'invited' | 'failed' | 'notes'>, nameOf: (identityId: string) => string): { title: string; body: string } {
  const lines: string[] = [];
  if (r.invited.length) lines.push(`Invited ${andList(r.invited.map(nameOf))}: in once they accept.`);
  for (const f of r.failed) lines.push(`Could not add ${nameOf(f.identityId)}: ${f.reason}`);
  lines.push(...r.notes.map((n) => (/[.!?]$/.test(n) ? n : `${n}.`)));
  const nobody = !r.added.length && !r.invited.length;
  return { title: nobody ? `Made ${name}, but nobody could be added` : `Made ${name}`, body: lines.join(' ') };
}

/**
 * The palette (docs/palette.md): Ctrl+K and New as one box with pages on a stack. This is the part that needs no
 * browser: the stack and what each key does on it, which rows a page shows for what was typed, and picking several
 * people. ui/Palette.tsx draws it; the pages live in ui/Switcher.tsx (the root), ui/NewMessage.tsx and ui/AddMembers.tsx.
 */
import { computed, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { joinsSomething, parseAdd } from '@dither-chat/protocol';
import type { AddRow } from './add.ts';
import { switcherOrder } from './ordering.ts';

/** Word starts beat prefixes of the whole name beat scattered letters. Null when the letters are not all there in order. */
export function fuzzyScore(name: string, needle: string): number | null {
  const n = name.toLowerCase();
  const q = needle.toLowerCase();
  if (!q) return 0;
  if (n.startsWith(q)) return 1000 - n.length;
  const at = n.indexOf(q);
  if (at >= 0) return (/[^\p{L}\p{N}]/u.test(n[at - 1] ?? ' ') ? 800 : 500) - n.length;
  let i = 0;
  let gaps = 0;
  for (const ch of q) {
    const j = n.indexOf(ch, i);
    if (j < 0) return null;
    gaps += j - i;
    i = j + 1;
  }
  return 200 - gaps - n.length;
}

// ------------------------------------------------------------------ pages and the stack

/** What New was opened for: the same page, with its own title, placeholder and rows when nothing is typed. */
export type NewMode = 'message' | 'join' | 'add';

/** A page, as it is asked for. Each kind is drawn by one component; the fields are what it needs to start. */
export type PageRef =
  /** Jump anywhere: Ctrl+K as it always was. */
  | { kind: 'root' }
  /** New: message someone, join, add, scan; anything typed or pasted is read as the New box always read it. */
  | { kind: 'new'; mode?: NewMode }
  /** Someone known on several networks: which one. `key` is a person's id, or an identity's for someone not merged. */
  | { kind: 'reach'; key: string }
  /** "Message X on Network": send as, and open the conversation. */
  | { kind: 'message'; network: P.Network; peer: string; name: string }
  /** A reading looked up: its preview card and what can be done with it. `via`: the account to ask. */
  | { kind: 'card'; row: AddRow; via?: string }
  /** Scan a code. `into`: the New page the code fills, as a paste would; without one, a New page takes its place. */
  | { kind: 'scan'; into?: number }
  | { kind: 'mine' }
  /** The groups one of your accounts might add people to. */
  | { kind: 'groups' }
  /** Add people to one group, as `accountId`. `adding`: what its About said, when the opener knows. */
  | { kind: 'add'; conversationId: string; accountId?: string | null; adding?: P.AboutAdding; onDone?: (about: P.AboutView) => void };

/** A page on the stack: what was asked for, its title for the crumbs, and what it keeps while you are elsewhere. */
export type Entry = PageRef & {
  id: number;
  title: string;
  /** What is typed in the box on this page. */
  q: string;
  /** The highlighted row. */
  sel: number;
  /** People picked on a page that picks several (identity ids, or a page's own keys). */
  picked?: string[];
};

let seq = 0;
export const entry = (ref: PageRef, title: string, q = ''): Entry => ({ ...ref, id: ++seq, title, q, sel: 0 });

/** The open palette's pages, bottom first; null while it is closed. */
export const paletteStack = signal<Entry[] | null>(null);
/** A preview card is on the stack: something may be being looked up. Changes only when one comes or goes, not as you type. */
export const cardOpen = computed(() => !!paletteStack.value?.some((e) => e.kind === 'card'));

export const push = (s: Entry[], e: Entry): Entry[] => [...s, e];
/** One page off. Null: that was the bottom page, so the palette closes. */
export const pop = (s: Entry[]): Entry[] | null => (s.length > 1 ? s.slice(0, -1) : null);
/** Back to the page at `i` (a crumb), what was typed there still in the box. */
export const backTo = (s: Entry[], i: number): Entry[] => s.slice(0, Math.max(1, Math.min(s.length, i + 1)));
/** The page on top swapped for another (a scan that turns into New). */
export const replaceTop = (s: Entry[], e: Entry): Entry[] => [...s.slice(0, -1), e];
export const update = (s: Entry[], id: number, patch: Partial<Entry>): Entry[] => s.map((e) => (e.id === id ? ({ ...e, ...patch } as Entry) : e));
/** The root under everything: the one already at the bottom, else a fresh one in place of the stack. */
export const toRoot = (s: Entry[], root: () => Entry): Entry[] => (s[0]?.kind === 'root' ? [s[0]] : [root()]);

// ------------------------------------------------------------------ keys

/** Where a key was pressed: the palette's input, the box itself (a page with no input), or a button or field in a page. */
export type KeyTarget = 'input' | 'box' | 'control';

export type KeyAct = 'back' | 'down' | 'up' | 'take' | 'toggle' | 'goOn' | 'unpick' | null;

/**
 * What a key does. Escape backs out a page; Backspace in an empty input too, but first un-picks the last person
 * picked; arrows move; Enter takes the row, or on a page that picks several picks or un-picks it, and Ctrl+Enter goes
 * on. Tab and everything else are left alone. A button inside a page keeps its own Enter and Backspace.
 */
export function keyAct(k: { key: string; ctrl?: boolean; alt?: boolean; target: KeyTarget; empty: boolean; multi?: boolean; picked?: number }): KeyAct {
  switch (k.key) {
    case 'Escape':
      return 'back';
    case 'Backspace':
      if (k.target === 'control' || (k.target === 'input' && !k.empty) || k.ctrl || k.alt) return null;
      return k.multi && (k.picked ?? 0) > 0 ? 'unpick' : 'back';
    case 'ArrowDown':
      return k.alt ? null : 'down';
    case 'ArrowUp':
      return k.alt ? null : 'up';
    case 'Enter':
      if (k.multi && k.ctrl) return 'goOn';
      if (k.target === 'control') return null;
      return k.multi ? 'toggle' : 'take';
  }
  return null;
}

/** The next highlighted row, round the ends. */
export const moveSel = (sel: number, n: number, by: 1 | -1): number => (n ? (((Math.min(sel, n - 1) + by) % n) + n) % n : 0);

// ------------------------------------------------------------------ the root

/** What the root ranks: its name, its latest message, the inbox's score where it has one. */
export interface RootItem {
  key: string;
  label: string;
  last: number;
  score?: number | null;
}

/** Rows that are not items: Join a pasted invite, Search messages for it, and New… with nothing typed. */
export const JOIN = 'join';
export const SEARCH = 'search';
export const NEW = 'new';

/**
 * The root's rows, as keys. Nothing typed: the top of the inbox as it is on screen (`top`, a DM as its person), then the
 * rest by latest message, nine in all, and New… last. Typed: the best nine by match times the inbox's score, an invite
 * (read here only, never looked up) first so Enter takes it, and Search messages last.
 */
export function rootKeys(all: readonly RootItem[], needle: string, top: readonly string[]): string[] {
  if (!needle) {
    const keys = new Set(top);
    const byKey = new Map(all.map((i) => [i.key, i]));
    const first = [...keys].filter((k) => byKey.has(k));
    const rest = all.filter((i) => !keys.has(i.key)).sort((a, b) => b.last - a.last).map((i) => i.key);
    return [...[...first, ...rest].slice(0, 9), NEW];
  }
  const matched = all.flatMap((i) => {
    const match = fuzzyScore(i.label, needle);
    return match === null ? [] : [{ key: i.key, match, score: i.score ?? null, last: i.last }];
  });
  const found = switcherOrder(matched).slice(0, 9);
  return [...(parseAdd(needle).some(joinsSomething) ? [JOIN] : []), ...found, SEARCH];
}

// ------------------------------------------------------------------ New

/** The rows New shows with nothing typed, before the people. `here`: the group on screen, when you could add people to it. */
export function newMenu(o: { mode?: NewMode; newGroup: boolean; canAdd: boolean; here?: string | null }): { key: string; label: string }[] {
  if (o.mode === 'message') return [];
  if (o.mode === 'join') return [{ key: 'n:scan', label: 'Scan a code' }];
  if (o.mode === 'add') return [{ key: 'n:scan', label: 'Scan a code' }, { key: 'n:mine', label: 'My code' }];
  const add = o.here ? [{ key: 'n:add-here', label: `Add people to ${o.here}` }] : o.canAdd ? [{ key: 'n:add', label: 'Add people to a group' }] : [];
  return [...add, ...(o.newGroup ? [{ key: 'n:group', label: 'New group' }] : []), { key: 'n:scan', label: 'Scan a code' }, { key: 'n:mine', label: 'My code' }];
}

/** Someone New could message: a person, or an identity not merged into one. */
export interface Reachable {
  key: string;
  name: string;
  /** Their handles, matched as the name is. */
  handles: string;
  /** The inbox's score of their best DM. */
  score: number | null;
  last: number;
}

/**
 * The people New offers. Typed: by how well the name or a handle matches, then by name. Nothing typed: the ones you
 * would most likely message, by the inbox's score and then the latest message, as the root ranks them.
 */
export function rankPeople<T extends Reachable>(rows: readonly T[], needle: string, n = 8): T[] {
  if (!needle) {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return switcherOrder(rows.map((r) => ({ key: r.key, match: 0, score: r.score, last: r.last })))
      .slice(0, n)
      .map((k) => byKey.get(k)!);
  }
  return rows
    .map((r) => ({ r, s: fuzzyScore(`${r.name} ${r.handles}`, needle) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s! - a.s! || a.r.name.localeCompare(b.r.name))
    .slice(0, n)
    .map((x) => x.r);
}

// ------------------------------------------------------------------ groups

/** A group one of your accounts might add people to. */
export interface GroupItem {
  key: string;
  name: string;
  last: number;
}

/** Most recent first; typed, best match first, then most recent. */
export function rankGroups<T extends GroupItem>(groups: readonly T[], needle: string, n = 50): T[] {
  if (!needle) return [...groups].sort((a, b) => b.last - a.last).slice(0, n);
  return groups
    .map((g) => ({ g, s: fuzzyScore(g.name, needle) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s! - a.s! || b.g.last - a.g.last)
    .slice(0, n)
    .map((x) => x.g);
}

// ------------------------------------------------------------------ picking several

/** Picked or un-picked; past the cap nothing more is picked. */
export function togglePick(picked: readonly string[], key: string, max: number): string[] {
  if (picked.includes(key)) return picked.filter((x) => x !== key);
  return picked.length >= max ? [...picked] : [...picked, key];
}

/** The last one picked, un-picked (Backspace in an empty input). */
export const unpickLast = (picked: readonly string[]): string[] => picked.slice(0, -1);

/** How many at once: the most one go takes, and never more than there is room for. */
export const pickCap = (most: number, room?: number) => Math.max(0, Math.min(most, room ?? most));

/** The line beside the button. */
export function pickLine(n: number, max: number): string {
  if (n) return `${n} picked${n >= max ? ', the most at once' : ''}`;
  return max > 0 ? `Pick up to ${max}` : 'There is no room for anyone else';
}

/** The rows a search keeps: what was typed, anywhere in what a row is known by. */
export const matches = (text: string, needle: string): boolean => text.toLowerCase().includes(needle.trim().toLowerCase());

/**
 * A suggested folder layout from what any hub knows (docs/organize.md, "Suggested layout"): the networks' own folders,
 * which of your accounts sees each server, and the servers' names, topics and channel names. Nothing you arranged
 * moves: only servers outside your folders are placed. Pure, so the web runs it and scripts/backtest-folders.ts scores
 * it against a layout someone made by hand.
 *
 * The rules, in the order they claim servers:
 *   1. network  each folder the network keeps (Discord's server folders) becomes one;
 *   2. word     a word in the names of 3 or more of one account's servers makes a folder of those ("Lakeside");
 *               an unnamed network folder at least half on that word joins it whole;
 *   3. persona  with two or more big accounts on one network, each account's folders and servers go in a folder of
 *               its own, so two lives do not mix;
 *   then each server still loose gets its two nearest folders as suggestions ("Move to…"), never filed by itself.
 */
import type { FolderView, Network } from './index.ts';
// Not re-exported from index.ts: the web loads it when the Organize view opens (`@dither-chat/protocol/folderplan`).

export interface PlanSpace {
  id: string;
  network: Network;
  name: string;
  /** Topic and channel names: what the nearest-folder suggestion reads besides the name. */
  text?: string;
  accountIds: string[];
}
export interface PlanAccount {
  id: string;
  network: Network;
  label: string;
  /** The account's colour: its folder takes it. */
  color?: string | null;
}
export interface PlanNetworkFolder {
  accountId: string;
  name: string | null;
  color?: string | null;
  /** Hub space ids, in the network's order. */
  spaces: string[];
}
export interface PlanInput {
  accounts: PlanAccount[];
  /** Top-level communities, in the order to keep. */
  spaces: PlanSpace[];
  folders: FolderView[];
  networkFolders: PlanNetworkFolder[];
  /** Extra numeric features per space for the suggestions (the categorizer's scores, by category). */
  vectors?: Record<string, Record<string, number>>;
}

export type PlanRule = 'network' | 'word';
export interface PlanStep {
  id: string;
  rule: PlanRule;
  name: string;
  color: string | null;
  /** The account whose servers these are, when accounts are kept apart. */
  persona: string | null;
  /** One of your folders this adds to (same name); otherwise a new folder. */
  into: string | null;
  spaces: string[];
  why: string;
}
export interface PlanPersona {
  accountId: string;
  label: string;
  color: string | null;
  /** Servers it would hold, in folders or loose. */
  spaces: number;
}
export interface PlanSuggestion {
  /** One of your folders, or `step:<id>` for a folder a step makes. */
  folder: string;
  name: string;
  score: number;
}
export interface FolderPlan {
  steps: PlanStep[];
  /** Two or more when keeping accounts apart is worth a level of folders; else empty. */
  personas: PlanPersona[];
  /** Space id -> its persona's account id (empty when there is one). */
  personaOf: Record<string, string>;
  /** Servers no rule places: the two folders each fits best. */
  suggest: Record<string, PlanSuggestion[]>;
}

/** An account needs this many servers of its own to get a folder of its own. */
export const PERSONA_MIN = 5;
/** A word in this many of one account's server names makes a folder. */
export const WORD_MIN = 3;

const FILLER =
  'the a an of and or to in on for at by with from server servers community communities club clubs official discord hub hq ' +
  'space spaces group groups chat chats old new my our your fan fans team teams guild guilds lounge hangout home world ' +
  'channel channels room rooms general place unofficial';
/** Made on first use: a Set built at load would keep this module in every bundle that touches the protocol. */
let generic: Set<string> | null = null;

/** The words of a name that could name a folder: three letters or more, not filler. */
export function nameWords(name: string): string[] {
  return (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !(generic ??= new Set(FILLER.split(' '))).has(w) && !/^\d+$/.test(w));
}

/** A name holds the word, or (for a word of five letters or more) its first four letters run together ("HackLakeside"). */
export function hasWord(name: string, w: string): boolean {
  if (nameWords(name).includes(w)) return true;
  return w.length >= 5 && name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').includes(w.slice(0, 4));
}

/** The word as the names write it ("NixOS", not "nixos"). */
function displayWord(names: string[], w: string): string {
  for (const n of names) {
    const m = n.match(new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu'));
    if (m) return m[0] === m[0].toLowerCase() ? m[0].charAt(0).toUpperCase() + m[0].slice(1) : m[0];
  }
  return w.charAt(0).toUpperCase() + w.slice(1);
}

const folderSpaces = (f: FolderView, all: FolderView[]): string[] =>
  f.items.flatMap((it) => (it.kind === 'space' ? [it.id] : it.kind === 'folder' ? (all.find((x) => x.id === it.id)?.items.filter((x) => x.kind === 'space').map((x) => x.id) ?? []) : []));

// ------------------------------------------------------------------ personas

function personas(input: PlanInput): { list: PlanPersona[]; of: (s: PlanSpace) => string | null } {
  const count = new Map<string, number>();
  for (const s of input.spaces) for (const a of s.accountIds) count.set(a, (count.get(a) ?? 0) + 1);
  const big = input.accounts.filter((a) => (count.get(a.id) ?? 0) >= PERSONA_MIN);
  const nets = new Map<Network, number>();
  for (const a of big) nets.set(a.network, (nets.get(a.network) ?? 0) + 1);
  const split = big.filter((a) => (nets.get(a.network) ?? 0) >= 2);
  if (split.length < 2) return { list: [], of: () => null };
  const bySize = [...split].sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0));
  const main = bySize[0];
  const ids = new Set(split.map((a) => a.id));
  // A server two of your accounts see is the bigger one's; one on a network where you have one account is your main one's.
  const of = (s: PlanSpace) => bySize.find((a) => s.accountIds.includes(a.id))?.id ?? (s.accountIds.some((a) => ids.has(a)) ? null : main.id);
  const n = new Map<string, number>();
  for (const s of input.spaces) {
    const p = of(s);
    if (p) n.set(p, (n.get(p) ?? 0) + 1);
  }
  return { list: bySize.map((a) => ({ accountId: a.id, label: a.label, color: a.color ?? null, spaces: n.get(a.id) ?? 0 })), of };
}

// ------------------------------------------------------------------ nearest folders

function tokens(s: PlanSpace): string[] {
  return [...nameWords(s.name), ...nameWords(s.name), ...nameWords(s.text ?? '')];
}

type Vec = Map<string, number>;
const norm = (v: Vec): Vec => {
  const n = Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0)) || 1;
  return new Map([...v].map(([k, x]) => [k, x / n]));
};
const dot = (a: Vec, b: Vec) => {
  let t = 0;
  for (const [k, x] of a) t += x * (b.get(k) ?? 0);
  return t;
};
const add = (into: Vec, v: Vec) => {
  for (const [k, x] of v) into.set(k, (into.get(k) ?? 0) + x);
};

/** Word vectors (tf-idf) and the extra features, each unit length, for every space. */
function vectorsOf(input: PlanInput) {
  const df = new Map<string, number>();
  const toks = new Map(input.spaces.map((s) => [s.id, tokens(s)]));
  for (const t of toks.values()) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = input.spaces.length || 1;
  const words = new Map<string, Vec>();
  for (const [id, t] of toks) {
    const v: Vec = new Map();
    for (const w of t) v.set(w, (v.get(w) ?? 0) + 1);
    for (const [w, x] of v) v.set(w, x * Math.log(1 + N / (df.get(w) ?? 1)));
    words.set(id, norm(v));
  }
  const extra = new Map<string, Vec>();
  for (const [id, f] of Object.entries(input.vectors ?? {})) extra.set(id, norm(new Map(Object.entries(f))));
  return { words, extra };
}

// ------------------------------------------------------------------ the plan

export function planFolders(input: PlanInput): FolderPlan {
  const byId = new Map(input.spaces.map((s) => [s.id, s]));
  // A server straight inside a folder of folders (an account's folder) is still loose within it.
  const placed = new Set(input.folders.filter((f) => !f.items.some((it) => it.kind === 'folder')).flatMap((f) => f.items.filter((it) => it.kind === 'space').map((it) => it.id)));
  const free = input.spaces.filter((s) => !placed.has(s.id));
  const persona = personas(input);
  const pOf = (id: string) => {
    const s = byId.get(id);
    return s ? persona.of(s) : null;
  };
  const yours = (name: string) => input.folders.find((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase()) ?? null;
  const steps: PlanStep[] = [];
  const claimed = new Map<string, PlanStep>();
  const claim = (st: PlanStep) => {
    for (const id of st.spaces) claimed.set(id, st);
    steps.push(st);
  };
  const netName = (accountId: string) => input.accounts.find((a) => a.id === accountId)?.network ?? 'network';
  const NET = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);

  // 1. The networks' own folders. Unnamed ones wait: a word may take them whole.
  const unnamed: PlanNetworkFolder[] = [];
  for (const nf of input.networkFolders) {
    const spaces = nf.spaces.filter((id) => byId.has(id) && !placed.has(id) && !claimed.has(id));
    if (spaces.length < 2) continue;
    if (!nf.name?.trim()) {
      unnamed.push({ ...nf, spaces });
      continue;
    }
    const into = yours(nf.name);
    claim({ id: `net:${nf.accountId}:${nf.name}`, rule: 'network', name: into?.name ?? nf.name.trim(), color: nf.color ?? null, persona: majority(spaces.map(pOf)), into: into?.id ?? null, spaces, why: `${NET(netName(nf.accountId))} folder` });
  }
  const inUnnamed = new Set(unnamed.flatMap((f) => f.spaces));

  // 2. Shared words, per account when accounts are kept apart.
  const groups = new Map<string | null, PlanSpace[]>();
  for (const s of input.spaces) {
    const p = persona.of(s);
    groups.set(p, [...(groups.get(p) ?? []), s]);
  }
  const wordSteps = new Map<string, PlanStep>();
  for (const [p, mine] of groups) {
    const cnt = new Map<string, number>();
    for (const s of mine) for (const w of new Set(nameWords(s.name))) cnt.set(w, (cnt.get(w) ?? 0) + 1);
    const ranked = [...cnt].filter(([, n]) => n >= WORD_MIN).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [w] of ranked) {
      const hits = mine.filter((s) => !placed.has(s.id) && !claimed.has(s.id) && !inUnnamed.has(s.id) && hasWord(s.name, w)).map((s) => s.id);
      const label = displayWord(mine.map((s) => s.name), w);
      const into = yours(label);
      if (!hits.length || (!into && hits.length < 2)) continue;
      const st: PlanStep = { id: `word:${p ?? ''}:${w}`, rule: 'word', name: into?.name ?? label, color: into?.color ?? null, persona: p, into: into?.id ?? null, spaces: hits, why: `“${label}” in their names` };
      claim(st);
      wordSteps.set(`${p ?? ''}:${w}`, st);
    }
  }
  // An unnamed network folder mostly on one word goes in with it; else it stays a folder of its own.
  let k = 0;
  for (const nf of unnamed) {
    const p = majority(nf.spaces.map(pOf));
    const tally = new Map<string, number>();
    for (const id of nf.spaces) {
      const s = byId.get(id)!;
      for (const [key, st] of wordSteps) if (key.startsWith(`${p ?? ''}:`) && hasWord(s.name, key.slice(key.indexOf(':') + 1))) tally.set(st.id, (tally.get(st.id) ?? 0) + 1);
    }
    const best = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] * 2 >= nf.spaces.length) {
      const st = steps.find((x) => x.id === best[0])!;
      for (const id of nf.spaces) if (!claimed.has(id)) (st.spaces.push(id), claimed.set(id, st));
      continue;
    }
    const names = nf.spaces.map((id) => byId.get(id)!.name);
    const common = commonWord(names);
    claim({ id: `net:${nf.accountId}:#${k++}`, rule: 'network', name: common ?? `${names[0]} and ${names.length - 1} more`, color: nf.color ?? null, persona: p, into: null, spaces: nf.spaces, why: `${NET(netName(nf.accountId))} folder without a name` });
  }

  // Suggestions for whatever is still loose: the nearest folders of the same account, yours or the steps'.
  const { words, extra } = vectorsOf(input);
  const vecOf = (id: string): [Vec, Vec] => [words.get(id) ?? new Map(), extra.get(id) ?? new Map()];
  const centroids: { folder: string; name: string; persona: string | null; w: Vec; x: Vec }[] = [];
  const centroid = (folder: string, name: string, ids: string[]) => {
    if (!ids.length) return;
    const w: Vec = new Map();
    const x: Vec = new Map();
    for (const id of ids) {
      const [a, b] = vecOf(id);
      add(w, a);
      add(x, b);
    }
    centroids.push({ folder, name, persona: majority(ids.map(pOf)), w: norm(w), x: norm(x) });
  };
  for (const f of input.folders) {
    // A folder of folders is a level (an account), not a topic: its folders are the suggestions.
    if (f.items.some((it) => it.kind === 'folder')) continue;
    const ids = folderSpaces(f, input.folders).filter((id) => byId.has(id));
    const st = steps.find((s) => s.into === f.id);
    centroid(f.id, f.name, [...ids, ...(st?.spaces ?? [])]);
  }
  for (const st of steps) if (!st.into) centroid(`step:${st.id}`, st.name, st.spaces);
  const hasExtra = extra.size > 0;
  const suggest: Record<string, PlanSuggestion[]> = {};
  for (const s of free) {
    if (claimed.has(s.id)) continue;
    const p = persona.of(s);
    const [w, x] = vecOf(s.id);
    const scored = centroids
      .filter((c) => !persona.list.length || c.persona === p)
      .map((c) => ({ folder: c.folder, name: c.name, score: hasExtra ? (dot(w, c.w) + dot(x, c.x)) / 2 : dot(w, c.w) }))
      .filter((c) => c.score > 0.02)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (scored.length) suggest[s.id] = scored;
  }

  const personaOf: Record<string, string> = {};
  if (persona.list.length) for (const s of input.spaces) {
    const p = persona.of(s);
    if (p) personaOf[s.id] = p;
  }
  return { steps, personas: persona.list, personaOf, suggest };
}

function majority<T>(xs: T[]): T {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (null as T);
}

/** A word at least two of the names share, for naming an unnamed folder. */
function commonWord(names: string[]): string | null {
  const cnt = new Map<string, number>();
  for (const n of names) for (const w of new Set(nameWords(n))) cnt.set(w, (cnt.get(w) ?? 0) + 1);
  const best = [...cnt].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])[0];
  return best ? displayWord(names, best[0]) : null;
}

// ------------------------------------------------------------------ applying it

export interface PlanChoice {
  /** Step ids to take. */
  steps: Set<string>;
  /** Put each account's folders and servers in a folder of its own. */
  personas: boolean;
  /** Loose servers to file in a suggested folder: space id -> PlanSuggestion.folder. */
  moves?: Record<string, string>;
}

/**
 * The folders after taking what was chosen. `loose` are the top-level rail keys in rail order ("space:…",
 * "conversation:…"); with personas on, each account's loose servers move into its folder too.
 */
export function applyPlan(current: FolderView[], plan: FolderPlan, choice: PlanChoice, newId: () => string, loose: string[] = []): FolderView[] {
  // What a step or a move files leaves an account's folder, where it sat loose.
  const filed = new Set([...plan.steps.filter((st) => choice.steps.has(st.id)).flatMap((st) => st.spaces), ...Object.keys(choice.moves ?? {})]);
  const folders: FolderView[] = current.map((f) => ({ ...f, items: f.items.some((it) => it.kind === 'folder') ? f.items.filter((it) => !(it.kind === 'space' && filed.has(it.id))) : [...f.items] }));
  const made = new Map<string, string>();
  for (const st of plan.steps) {
    if (!choice.steps.has(st.id)) continue;
    const items = st.spaces.map((id) => ({ kind: 'space' as const, id }));
    const into = st.into ? folders.find((f) => f.id === st.into) : null;
    if (into) into.items.push(...items);
    else {
      const id = newId();
      made.set(`step:${st.id}`, id);
      folders.push({ id, name: st.name, icon: null, color: st.color, items });
    }
  }
  const moved = new Set<string>();
  for (const [space, target] of Object.entries(choice.moves ?? {})) {
    const id = target.startsWith('step:') ? made.get(target) : target;
    const f = id ? folders.find((x) => x.id === id) : null;
    if (f) (f.items.push({ kind: 'space', id: space }), moved.add(space));
  }
  if (!choice.personas || plan.personas.length < 2) return folders;

  // Folders that hold folders, and the folders inside them, stay where they are.
  const children = new Set(folders.flatMap((f) => f.items.filter((it) => it.kind === 'folder').map((it) => it.id)));
  const fixed = new Set([...children, ...folders.filter((f) => f.items.some((it) => it.kind === 'folder')).map((f) => f.id)]);
  const parentOf = new Map<string, FolderView>();
  for (const p of plan.personas) {
    const existing = folders.find((f) => f.name.trim().toLowerCase() === p.label.trim().toLowerCase() && !children.has(f.id));
    if (existing && (!fixed.has(existing.id) || existing.items.some((it) => it.kind === 'folder'))) parentOf.set(p.accountId, existing);
    else {
      const f: FolderView = { id: newId(), name: p.label, icon: null, color: p.color, items: [] };
      folders.push(f);
      parentOf.set(p.accountId, f);
    }
  }
  const parentIds = new Set([...parentOf.values()].map((f) => f.id));
  for (const f of folders) {
    if (parentIds.has(f.id) || fixed.has(f.id)) continue;
    const spaces = f.items.filter((it) => it.kind === 'space').map((it) => it.id);
    // Only a folder of servers belongs to an account; one of people or chats stays at the top.
    if (!spaces.length || spaces.length * 2 < f.items.length) continue;
    const p = majority(spaces.map((id) => plan.personaOf[id] ?? null));
    const parent = p ? parentOf.get(p) : null;
    if (parent) parent.items.push({ kind: 'folder', id: f.id });
  }
  for (const key of loose) {
    if (!key.startsWith('space:')) continue;
    const id = key.slice('space:'.length);
    if (moved.has(id) || plan.steps.some((st) => choice.steps.has(st.id) && st.spaces.includes(id))) continue;
    const parent = plan.personaOf[id] ? parentOf.get(plan.personaOf[id]) : null;
    if (parent) parent.items.push({ kind: 'space', id });
  }
  // Children first in each account's folder, then its loose servers.
  for (const f of parentOf.values()) f.items.sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1));
  return folders.filter((f) => f.items.length || !parentIds.has(f.id));
}

// ------------------------------------------------------------------ scoring a layout against one made by hand

/**
 * Space id -> the folder it is in (null: loose). A server straight inside a folder of folders (an account's folder)
 * counts as loose: that level keeps lives apart, it does not say what a server is about.
 */
export function placement(folders: FolderView[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const f of folders) {
    const level = f.items.some((it) => it.kind === 'folder');
    for (const it of f.items) if (it.kind === 'space') out.set(it.id, level ? null : f.id);
  }
  return out;
}

export interface LayoutScore {
  /** Share of servers whose predicted folder stands for their true folder (most of its members are there). */
  placedRight: number;
  /** Of pairs put together, the share that are together in truth. */
  pairPrecision: number;
  pairRecall: number;
  /** Share left loose. */
  loose: number;
  n: number;
}

/** How close `pred` comes to `truth` over `ids` (servers in a folder in truth). */
export function scoreLayout(pred: Map<string, string | null>, truth: Map<string, string | null>, ids: string[]): LayoutScore {
  let tp = 0,
    fp = 0,
    fn = 0;
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const t = truth.get(ids[i]) === truth.get(ids[j]);
      const pa = pred.get(ids[i]) ?? null;
      const p = pa !== null && pa === (pred.get(ids[j]) ?? null);
      if (t && p) tp++;
      else if (p) fp++;
      else if (t) fn++;
    }
  const members = new Map<string, string[]>();
  for (const id of ids) {
    const p = pred.get(id) ?? null;
    if (p !== null) members.set(p, [...(members.get(p) ?? []), id]);
  }
  const label = new Map([...members].map(([p, m]) => [p, majority(m.map((id) => truth.get(id) ?? null))]));
  const right = ids.filter((id) => {
    const p = pred.get(id) ?? null;
    return p !== null && label.get(p) === truth.get(id);
  }).length;
  const n = ids.length || 1;
  return { placedRight: right / n, pairPrecision: tp / Math.max(tp + fp, 1), pairRecall: tp / Math.max(tp + fn, 1), loose: ids.filter((id) => (pred.get(id) ?? null) === null).length / n, n: ids.length };
}

/**
 * A server you join tomorrow: each one in `truth` is taken out and placed back by the suggestions alone, against the
 * truth's folders. Returns how often the first suggestion is right, and how often one of the first two or three is.
 */
export function leaveOneOut(input: PlanInput, truth: FolderView[]): { top1: number; top2: number; top3: number; n: number } {
  const truthOf = placement(truth);
  const ids = input.spaces.filter((s) => truthOf.get(s.id)).map((s) => s.id);
  let top1 = 0,
    top2 = 0,
    top3 = 0;
  for (const id of ids) {
    const folders = truth.map((f) => ({ ...f, items: f.items.filter((it) => !(it.kind === 'space' && it.id === id)) }));
    const plan = planFolders({ ...input, folders, networkFolders: [] });
    // The word rule may put it back by itself ("Lakeside Chess" into Lakeside); else the suggestions.
    const st = plan.steps.find((x) => x.spaces.includes(id));
    const s = st ? [{ folder: st.into ?? `step:${st.id}` }] : (plan.suggest[id] ?? []);
    if (s[0]?.folder === truthOf.get(id)) top1++;
    if (s.slice(0, 2).some((x) => x.folder === truthOf.get(id))) top2++;
    if (s.slice(0, 3).some((x) => x.folder === truthOf.get(id))) top3++;
  }
  const n = ids.length || 1;
  return { top1: top1 / n, top2: top2 / n, top3: top3 / n, n: ids.length };
}

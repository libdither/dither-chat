/**
 * Learning from your votes (docs/notifications.md). Triage puts every message at one of three levels: Important
 * (the phone buzzes, the desktop shows a notification), Active (a silent notification on the phone) or Digest. You
 * vote a decision up or down a level; this finds rules that explain your votes and applies them to what comes next.
 *
 * Every decision keeps the facts it was made from (`Facts`: where, who, mentions you, a question, ...), so any set of
 * rules can be tried against every vote you ever gave: a backtest. The rules are a decision list, most specific
 * first: the first one that matches a message sets its level, else triage's own rules stand. They are learned greedily:
 * of all the conditions your votes suggest (a place, a person, a server, alone or with a flag such as "does not
 * mention you"), take the one that gets the most votes right, again and again, while each step still helps.
 *
 * Votes count in full, newer more. Decisions you did not vote on count a little, as "that was fine": enough to keep a
 * rule from reaching past what you voted on, never enough to outvote you. Votes on one conversation move it on their
 * own; a rule over a server, a person or a network needs two votes that agree.
 *
 * After each vote the rules are backtested; past `RELEARN_ERROR` wrong they are learned again, and a local model's
 * prompt (triage.ts askModel) is written again from them, with the votes they still get wrong as examples.
 */
import type * as P from '@dither-chat/protocol';

export type Level = P.NotifyTier;
export const TIERS: Level[] = ['digest', 'quiet', 'push'];
export const tierUp = (l: Level): Level => TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(l) + 1)];
export const tierDown = (l: Level): Level => TIERS[Math.max(0, TIERS.indexOf(l) - 1)];
export const isTier = (x: unknown): x is Level => TIERS.includes(x as Level);

/** What a decision was made from. No message text: flags only. */
export interface Facts {
  network: string;
  shape: string;
  conversation: string;
  /** Containing spaces, nearest first. */
  spaces: string[];
  /** The author's person, else identity. */
  author: string | null;
  bot: boolean;
  mention: boolean;
  /** @everyone / @here, not you by name. */
  everyone: boolean;
  reply: boolean;
  question: boolean;
  urgent: boolean;
  /** You wrote there in the half hour before. */
  active: boolean;
  media: boolean;
  /** Triage's own level, before any learned rule. */
  base: Level;
}

export interface Rule {
  /** Predicates that must all hold (`predicates`). */
  when: string[];
  level: Level;
  /** Votes it matches that agree, and all votes it matches. */
  votes: number;
  agree: number;
  /** You kept it: it survives relearning. */
  pinned?: boolean;
}

export interface Example {
  facts: Facts;
  label: Level;
  weight: number;
  /** A vote, as opposed to a decision you let stand. */
  vote: boolean;
  at: number;
}

const FLAGS = ['mention', 'everyone', 'reply', 'question', 'urgent', 'bot', 'active', 'media'] as const;
/** Flags whose absence says something: "unless it mentions you". */
const NEGATABLE = new Set(['mention', 'reply', 'question', 'active']);

/** Every predicate that holds for these facts. */
export function predicates(f: Facts): string[] {
  const out = [`conv:${f.conversation}`, `network:${f.network}`, `shape:${f.shape}`, `base:${f.base}`];
  for (const s of f.spaces.slice(0, 3)) out.push(`space:${s}`);
  if (f.author) out.push(`author:${f.author}`);
  for (const k of FLAGS) {
    if (f[k]) out.push(k);
    else if (NEGATABLE.has(k)) out.push(`!${k}`);
  }
  return out;
}

const SCOPE_RANK: Record<string, number> = { conv: 0, author: 1, space: 2, network: 3, shape: 4 };
const scopeOf = (p: string) => (p.includes(':') && !p.startsWith('base:') ? p.slice(0, p.indexOf(':')) : null);
/** Most specific first: a conversation before a person before a server; more conditions before fewer. */
export function specificity(when: string[]): [number, number] {
  const ranks = when.map((p) => SCOPE_RANK[scopeOf(p) ?? ''] ?? 5);
  return [Math.min(...ranks, 5), -when.length];
}
const bySpecificity = (a: Rule, b: Rule) => {
  const [x1, x2] = specificity(a.when);
  const [y1, y2] = specificity(b.when);
  return x1 - y1 || x2 - y2 || b.votes - a.votes;
};
export const ruleKey = (r: Pick<Rule, 'when' | 'level'>) => `${[...r.when].sort().join('&')}>${r.level}`;
export const condKey = (when: string[]) => [...when].sort().join('&');

/** The level for these facts: the first rule that matches, else triage's own. Silenced places are never touched. */
export function applyRules(rules: readonly Rule[], f: Facts, has?: Set<string>): { level: Level; rule: Rule | null } {
  const set = has ?? new Set(predicates(f));
  for (const r of rules) if (r.when.every((p) => set.has(p))) return { level: r.level, rule: r };
  return { level: f.base, rule: null };
}

export interface Backtest {
  votes: number;
  /** Votes the rules get wrong; and without any rules, triage's own. */
  errors: number;
  baseline: number;
  /** The newest of the votes they get wrong, newest first. */
  wrong: Example[];
}

export function backtest(rules: readonly Rule[], examples: readonly Example[]): Backtest {
  const votes = examples.filter((e) => e.vote);
  const wrong = votes.filter((e) => applyRules(rules, e.facts).level !== e.label).sort((a, b) => b.at - a.at);
  return { votes: votes.length, errors: wrong.length, baseline: votes.filter((e) => e.facts.base !== e.label).length, wrong };
}

export const MAX_RULES = 24;
/** A step must get at least this much more right (a vote counts up to 1). */
const MIN_GAIN = 0.4;
/** Of the votes a rule matches, at least this share must agree with it. */
const MIN_AGREE = 0.7;

/** Conditions a vote suggests: each scope alone, and each with one flag or with what triage would have done. */
function conditions(f: Facts): string[][] {
  const ps = predicates(f);
  const scopes = ps.filter((p) => scopeOf(p));
  const rest = ps.filter((p) => !scopeOf(p));
  const out: string[][] = scopes.map((s) => [s]);
  for (const s of scopes) for (const r of rest) out.push([s, r]);
  // Across every place: "anything that would buzz and does not mention you".
  for (const r of rest) if (!r.startsWith('base:')) out.push([`base:${f.base}`, r]);
  return out;
}

/**
 * The rules your votes support. Starts from the rules you kept, then adds, one at a time, whichever condition gets
 * the most right, until none helps by `MIN_GAIN`. Each candidate goes where its specificity puts it in the list, so
 * the gain counts only the examples no earlier rule already decides.
 */
export function learn(examples: readonly Example[], keep: readonly Rule[] = [], rejected: ReadonlySet<string> = new Set()): Rule[] {
  const sets = examples.map((e) => new Set(predicates(e.facts)));
  const byPred = new Map<string, number[]>();
  sets.forEach((s, i) => s.forEach((p) => (byPred.get(p) ?? byPred.set(p, []).get(p)!).push(i)));
  const matching = (when: string[]): number[] => {
    const lists = when.map((p) => byPred.get(p) ?? []).sort((a, b) => a.length - b.length);
    if (!lists.length) return [];
    const others = lists.slice(1).map((l) => new Set(l));
    return lists[0].filter((i) => others.every((o) => o.has(i)));
  };

  // A rule you dropped takes its narrower versions with it: "in this DM" dropped is not "in this DM, unless a question".
  const dropped = [...rejected].map((k) => ({ when: k.slice(0, k.lastIndexOf('>')).split('&'), level: k.slice(k.lastIndexOf('>') + 1) }));
  const refused = (when: string[], level: Level) => dropped.some((d) => d.level === level && d.when.every((p) => when.includes(p)));

  // Candidates from the votes only: a pattern has to be something you said.
  const cands = new Map<string, { when: string[]; level: Level; idx: number[] }>();
  for (const e of examples) {
    if (!e.vote) continue;
    for (const when of conditions(e.facts)) {
      const key = ruleKey({ when, level: e.label });
      if (cands.has(key) || refused(when, e.label)) continue;
      cands.set(key, { when, level: e.label, idx: matching(when) });
    }
  }

  let rules = [...keep].sort(bySpecificity);
  for (let round = rules.length; round < MAX_RULES; round++) {
    // Which rule decides each example now, and whether that is right.
    const decider = sets.map((s) => rules.findIndex((r) => r.when.every((p) => s.has(p))));
    const right = examples.map((e, i) => (decider[i] < 0 ? e.facts.base : rules[decider[i]].level) === e.label);
    const present = new Set(rules.map(ruleKey));
    let best: { rule: Rule; gain: number } | null = null;
    for (const [key, c] of cands) {
      if (present.has(key)) continue;
      const at = insertAt(rules, c.when);
      let gain = 0;
      let votes = 0;
      let agree = 0;
      for (const i of c.idx) {
        const e = examples[i];
        if (e.vote) {
          votes++;
          if (e.label === c.level) agree++;
        }
        if (decider[i] >= 0 && decider[i] < at) continue;
        gain += e.weight * (Number(c.level === e.label) - Number(right[i]));
      }
      const support = c.when.some((p) => p.startsWith('conv:')) ? 1 : 2;
      if (agree < support || agree / votes < MIN_AGREE || gain < MIN_GAIN) continue;
      // On a tie, the simpler condition, then the narrower scope.
      const simpler = () => c.when.length - best!.rule.when.length || specificity(c.when)[0] - specificity(best!.rule.when)[0];
      if (!best || gain > best.gain + 1e-9 || (Math.abs(gain - best.gain) < 1e-9 && simpler() < 0)) {
        best = { rule: { when: c.when, level: c.level, votes, agree }, gain };
      }
    }
    if (!best) break;
    rules = [...rules.slice(0, insertAt(rules, best.rule.when)), best.rule, ...rules.slice(insertAt(rules, best.rule.when))];
  }
  // Counts for the kept ones too, as of these votes.
  return rules.map((r) => {
    if (!r.pinned) return r;
    const idx = matching(r.when).filter((i) => examples[i].vote);
    return { ...r, votes: idx.length, agree: idx.filter((i) => examples[i].label === r.level).length };
  });
}

function insertAt(rules: readonly Rule[], when: string[]): number {
  const probe: Rule = { when, level: 'digest', votes: Infinity, agree: 0 };
  const i = rules.findIndex((r) => bySpecificity(probe, r) < 0);
  return i < 0 ? rules.length : i;
}

/** Older votes count less: half after three months, never under a quarter. */
export function voteWeight(at: number, now: number): number {
  return Math.max(0.25, 2 ** (-(now - at) / (90 * 86_400_000)));
}
/** A decision you let stand. */
export const STOOD = 0.05;
/** Of those, at most this many per conversation, the newest. */
export const STOOD_PER_PLACE = 10;
/** Relearn when the rules get more than this share of votes wrong. */
export const RELEARN_ERROR = 0.1;

// ------------------------------------------------------------------ in words

export interface Namer {
  conversation(id: string): string;
  space(id: string): string;
  person(id: string): string;
  network(id: string): string;
}

export const TIER_NAME: Record<Level, string> = { push: 'Important', quiet: 'Active', digest: 'Digest' };
const SHAPES: Record<string, string> = { direct: 'DMs', group: 'group chats', channel: 'channels', thread: 'threads', self: 'notes to self' };
const FLAG_WORDS: Record<string, string> = {
  mention: 'mentions you',
  '!mention': 'does not mention you',
  everyone: 'pings @everyone',
  reply: 'replies to you',
  '!reply': 'is not a reply to you',
  question: 'asks a question',
  '!question': 'is not a question',
  urgent: 'sounds urgent',
  bot: 'from a bot',
  active: "you'd been talking there",
  '!active': "you hadn't been talking there",
  media: 'has an attachment',
};

/** "From Sam, in #general · Hub, that does not mention you" */
export function describe(when: string[], n: Namer): string {
  const parts: string[] = [];
  const flags: string[] = [];
  for (const p of [...when].sort((a, b) => (SCOPE_RANK[scopeOf(a) ?? ''] ?? 9) - (SCOPE_RANK[scopeOf(b) ?? ''] ?? 9))) {
    const [k, v] = p.includes(':') ? [p.slice(0, p.indexOf(':')), p.slice(p.indexOf(':') + 1)] : [p, ''];
    if (k === 'conv') parts.push(`in ${n.conversation(v)}`);
    else if (k === 'author') parts.push(`from ${n.person(v)}`);
    else if (k === 'space') parts.push(`in ${n.space(v)}`);
    else if (k === 'network') parts.push(`on ${n.network(v)}`);
    else if (k === 'shape') parts.push(`in ${SHAPES[v] ?? v}`);
    else if (k === 'base') flags.push(`would have been ${TIER_NAME[v as Level]}`);
    else flags.push(FLAG_WORDS[p] ?? p);
  }
  const head = parts.length ? parts.join(', ') : 'Anything';
  const text = flags.length ? `${head}, that ${flags.join(' and ')}` : head;
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * The prompt for a local model, written from the rules: what each level means, the rules in words, and the votes
 * the rules still get wrong as examples (described by their facts, never their text).
 */
export function writePrompt(rules: readonly Rule[], wrong: readonly Example[], n: Namer): string {
  const lines = [
    'You sort incoming chat messages for one person into three levels:',
    '- important: their phone buzzes and their computer shows a notification. For what they would want to drop things for.',
    '- active: a silent notification on their phone. Worth seeing soon, not worth an interruption.',
    '- digest: no notification; read later with everything else.',
  ];
  if (rules.length) {
    lines.push('', 'They taught you these rules by voting on past notifications; the first that fits wins:');
    for (const r of rules) lines.push(`- ${describe(r.when, n)}: ${r.level === 'push' ? 'important' : r.level === 'quiet' ? 'active' : 'digest'}`);
  }
  if (wrong.length) {
    lines.push('', 'The rules still get these of their votes wrong; weigh them too:');
    for (const e of wrong.slice(0, 6)) {
      const f = e.facts;
      const what = predicates(f).filter((p) => !p.startsWith('!') && !p.startsWith('base:') && !p.startsWith('shape:') && !p.startsWith('network:'));
      lines.push(`- ${describe(what, n)}: they said ${e.label === 'push' ? 'important' : e.label === 'quiet' ? 'active' : 'digest'}`);
    }
  }
  return lines.join('\n');
}

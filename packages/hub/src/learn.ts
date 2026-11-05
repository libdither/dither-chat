/**
 * Learning from your votes (docs/notifications.md). Triage puts every message at one of four levels: Important (the
 * phone buzzes, the desktop shows a notification), Active (a silent notification on the phone), Digest, or below the
 * digest ('drop': still unread in its chat, nowhere else).
 *
 * The level comes from three chances the model predicts for each message: worth a ping, worth at least a silent
 * notification, and interesting enough for the digest. At `THRESHOLDS.ping` or more it pings; else at `active` or
 * more it is Active; else at `interesting` or more it goes in the digest; else below it.
 *
 * Each chance starts from a prior: where the network's own settings (or yours, for a place you set) would put the
 * message. Discord and Signal notify you about something, so it starts as Important. What your votes taught is added
 * on top, in log-odds: one weight per feature (a conversation, a person, a server, a flag such as "mentions you", the
 * words it uses) and per chance, fitted by L2-regularised logistic regression. The regularisation is the hierarchy: a
 * conversation moves on one vote, a person or a server on a few, a whole network or "anything that mentions you"
 * only on many, so two votes in one Signal chat do not quieten all of Signal.
 *
 * Votes count in full, newer more. Notifications you got and let stand count a little, as "that was fine". A candidate
 * model, run in shadow next to the live one (votes.ts), learns instead from what you did (labels.ts): each example
 * then says something about only some of the chances (`y`), and may carry numeric features from outside (`x`:
 * interaction features from interact.ts, later content features), each kind with its own regularisation (`NUMERIC`).
 */
import type * as P from '@dither-chat/protocol';

export type Level = P.NotifyTier;
export type Head = P.TriageHead;
export const TIERS: Level[] = ['drop', 'digest', 'quiet', 'push'];
export const HEADS: Head[] = ['ping', 'active', 'interesting'];
export const tierUp = (l: Level): Level => TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(l) + 1)];
export const tierDown = (l: Level): Level => TIERS[Math.max(0, TIERS.indexOf(l) - 1)];
export const isTier = (x: unknown): x is Level => TIERS.includes(x as Level);

/** It pings at 80% sure, as asked; Active and the digest at even odds. */
export const THRESHOLDS: P.TriageProbs = { ping: 0.8, active: 0.5, interesting: 0.5 };

/** What a decision was made from. The words are not kept here: they are read from the message when needed. */
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
  /** Where the network's own settings, or yours for this place, put it: the prior. */
  base: Level;
  /** What the network does with this place: notify on every message, only mentions, or nothing. */
  native?: 'all' | 'mentions' | 'none';
  /** The network itself would have notified you about it. */
  notify?: boolean;
  /** Triage's own sense of how addressed to you it is, 0 to 1 (triage.ts). */
  score?: number;
  /** You set this place's level yourself. */
  explicit?: boolean;
  link?: boolean;
  long?: boolean;
  /** From someone you have as a person (a contact, a friend), not a stranger. */
  known?: boolean;
}

export interface Example {
  /** The message, when known. */
  id?: string;
  facts: Facts;
  words: string[];
  /** The level it was voted to (or, for one that stood, decided at). Its labels, unless `y` says otherwise. */
  label?: Level;
  /** What it says for each chance; a chance left out is not learned from it. Default: `labels(label)`. */
  y?: Partial<Record<Head, 0 | 1>>;
  /** Numeric features as of the decision (interact.ts; later content features), by name. */
  x?: Record<string, number>;
  weight: number;
  /** A vote, as opposed to a decision you let stand or something you did. */
  vote: boolean;
  at: number;
}

/** An example's labels, by chance. */
export const labelsOf = (e: Pick<Example, 'y' | 'label'>): Partial<Record<Head, 0 | 1>> => e.y ?? (e.label ? labels(e.label) : {});

/** What each level says for each chance: Important is worth a ping, so also worth Active and the digest. */
export function labels(l: Level): Record<Head, 0 | 1> {
  return { ping: l === 'push' ? 1 : 0, active: l === 'push' || l === 'quiet' ? 1 : 0, interesting: l === 'drop' ? 0 : 1 };
}

export function levelFrom(p: P.TriageProbs, t: P.TriageProbs = THRESHOLDS): Level {
  return p.ping >= t.ping ? 'push' : p.active >= t.active ? 'quiet' : p.interesting >= t.interesting ? 'digest' : 'drop';
}

/**
 * Before any vote. The network would notify (or you set the place to): Important. Below that, how addressed to you
 * it is decides whether it is interesting enough for the digest; a place you set to Digest keeps its digest.
 */
export function prior(f: Facts): P.TriageProbs {
  switch (f.base) {
    case 'push':
      return { ping: 0.9, active: 0.97, interesting: 0.99 };
    case 'quiet':
      return { ping: 0.2, active: 0.85, interesting: 0.97 };
    case 'digest':
      return { ping: 0.03, active: 0.1, interesting: f.explicit ? 0.9 : Math.min(0.95, Math.max(0.05, 0.2 + (f.score ?? 0.15))) };
    case 'drop':
      return { ping: 0.01, active: 0.03, interesting: 0.2 };
  }
}

// ------------------------------------------------------------------ features

const FLAGS = ['mention', 'everyone', 'reply', 'question', 'urgent', 'bot', 'active', 'media', 'link', 'long', 'known'] as const;
/** Flags whose absence says something: "unless it mentions you". */
const NEGATABLE = new Set(['mention', 'reply', 'question', 'active', 'known']);

const STOP = new Set(
  'the and for are but not you all any can her was one our out has have had him his how its may new now see two who did get got let put say she too use that this with from they will would there their what about which when your said could into them than then been were more some just like also only over such very well here where after before because these those while being does doing what\'s it\'s i\'m don\'t can\'t yeah yes lol'.split(' '),
);

/** The words a message uses, for the model: distinct, lower case, three letters or more; no links, mentions or code. */
export function words(body: string, max = 40): string[] {
  const text = body
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[@#:!&a-z]*[^>]*>/gi, ' ')
    .replace(/```[\s\S]*?```|`[^`]*`/g, ' ')
    .toLowerCase();
  const out = new Set<string>();
  for (const w of text.match(/[\p{L}\p{N}'’]{3,24}/gu) ?? []) {
    const k = w.replace(/’/g, "'").replace(/^'+|'+$/g, '');
    if (k.length < 3 || STOP.has(k) || /^\d+$/.test(k)) continue;
    out.add(k);
    if (out.size >= max) break;
  }
  return [...out];
}

/**
 * Numeric features, by kind (the part of the name before ':'): how firmly each is held at zero, and what it means in
 * words. Kinds not listed get `NUMERIC_LAMBDA`. Content features (embeddings, local-model answers) add theirs here.
 */
export const NUMERIC: Record<string, { lambda: number; text: string }> = {
  rr: { lambda: 10, text: 'how often you answer' },
  engaged: { lambda: 10, text: "you're talking there now" },
  alt: { lambda: 10, text: 'back-and-forth there now' },
  since: { lambda: 10, text: 'how long since you looked' },
  device: { lambda: 10, text: "you're at a screen" },
  open: { lambda: 10, text: 'how often you open its pushes' },
};
export const NUMERIC_LAMBDA = 10;
/** Numeric feature names carry this prefix inside the model, so they never collide with the rest. */
export const NUM = '#';

/**
 * Every feature of a message, with its value: 1, or for words a share that adds up to one feature's worth; numeric
 * ones (`x`) as they are, named with a leading '#'.
 */
export function features(f: Facts, ws: readonly string[] = [], xs?: Record<string, number>): [string, number][] {
  const out: [string, number][] = [['all', 1], [`conv:${f.conversation}`, 1], [`network:${f.network}`, 1], [`shape:${f.shape}`, 1]];
  for (const s of f.spaces.slice(0, 3)) out.push([`space:${s}`, 1]);
  if (f.author) out.push([`author:${f.author}`, 1]);
  for (const k of FLAGS) {
    if (f[k]) out.push([k, 1]);
    else if (NEGATABLE.has(k) && f[k] !== undefined) out.push([`!${k}`, 1]);
  }
  if (f.native) out.push([`native:${f.native}`, 1]);
  if (f.notify !== undefined) out.push([f.notify ? 'notify' : '!notify', 1]);
  // "In this server, unless it is about you": each scope with whether it mentions or replies to you.
  const you = f.mention || f.reply ? 'you' : '!you';
  out.push([`conv:${f.conversation}&${you}`, 1]);
  if (f.spaces[0]) out.push([`space:${f.spaces[0]}&${you}`, 1]);
  if (f.author) out.push([`author:${f.author}&${you}`, 1]);
  const share = ws.length ? 1 / Math.sqrt(ws.length) : 0;
  for (const w of ws) out.push([`w:${w}`, share]);
  if (xs) for (const [k, v] of Object.entries(xs)) if (v && Number.isFinite(v)) out.push([NUM + k, v]);
  return out;
}

const kindOf = (feature: string) => feature.slice(0, feature.search(/[:&]|$/));

/**
 * How firmly each kind of feature is held at zero (the L2 weight). A conversation moves on one vote; a person and
 * words (together worth one feature) on a few; a server on several; a network, a shape or a flag across every place
 * only on many.
 */
export function lambda(feature: string): number {
  if (feature.startsWith(NUM)) return NUMERIC[kindOf(feature.slice(1))]?.lambda ?? NUMERIC_LAMBDA;
  // A scope with whether it is about you moves first: "this server, unless it mentions you" before "this server".
  if (feature.includes('&')) return base(feature) / 2;
  return base(feature);
}

function base(feature: string): number {
  switch (kindOf(feature)) {
    case 'conv':
      return 0.5;
    case 'author':
    case 'w':
      return 1;
    case 'space':
      return 4;
    case 'all':
      return 80;
    default:
      return 40;
  }
}

// ------------------------------------------------------------------ the model

export interface Model {
  w: Record<Head, Record<string, number>>;
}
export const emptyModel = (): Model => ({ w: { ping: {}, active: {}, interesting: {} } });

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(p / (1 - p));

export interface Prediction {
  probs: P.TriageProbs;
  level: Level;
  /** The features that moved it most, strongest first. */
  why: { feature: string; head: Head; by: number }[];
}

/** The chances for a message: its prior (or a local model's, `start`) plus the learned weights of its features. */
export function predict(m: Model, f: Facts, ws: readonly string[] = [], start?: P.TriageProbs, x?: Record<string, number>): Prediction {
  const p0 = start ?? prior(f);
  const fs = features(f, ws, x);
  const probs = {} as P.TriageProbs;
  const why: Prediction['why'] = [];
  for (const h of HEADS) {
    let z = logit(p0[h]);
    for (const [k, x] of fs) {
      const w = m.w[h][k];
      if (!w) continue;
      z += w * x;
      if (Math.abs(w * x) >= 0.25) why.push({ feature: k, head: h, by: w * x });
    }
    probs[h] = sigmoid(z);
  }
  why.sort((a, b) => Math.abs(b.by) - Math.abs(a.by));
  return { probs, level: levelFrom(probs), why };
}

/** How much a prediction matters, for sorting: the mean of the three chances. */
export const importance = (p: P.TriageProbs) => Math.round(((p.ping + p.active + p.interesting) / 3) * 1000) / 1000;

/**
 * Fit the weights: for each chance, weighted logistic loss plus each feature's L2 weight, by cyclic coordinate Newton
 * steps (a dozen sweeps are plenty: each feature is a handful of examples). Features you rejected are left out. An
 * example counts only for the chances it labels.
 */
export function train(examples: readonly Example[], rejected: ReadonlySet<string> = new Set(), sweeps = 12): Model {
  const index = new Map<string, number>();
  const names: string[] = [];
  const rows = examples.map((e) => {
    const fs = features(e.facts, e.words, e.x).filter(([k]) => !rejected.has(k));
    const ids = fs.map(([k]) => index.get(k) ?? (index.set(k, names.push(k) - 1), names.length - 1));
    return { ids, vals: fs.map(([, x]) => x), prior: prior(e.facts), y: labelsOf(e), c: e.weight };
  });
  // Which examples each feature is in.
  const at: { i: number; x: number }[][] = names.map(() => []);
  rows.forEach((r, i) => r.ids.forEach((f, j) => at[f].push({ i, x: r.vals[j] })));
  const lam = names.map(lambda);
  const model = emptyModel();
  for (const h of HEADS) {
    const w = new Float64Array(names.length);
    const z = rows.map((r) => logit(r.prior[h]));
    for (let s = 0; s < sweeps; s++) {
      let moved = 0;
      for (let f = 0; f < names.length; f++) {
        let g = lam[f] * w[f];
        let H = lam[f];
        for (const { i, x } of at[f]) {
          const r = rows[i];
          const y = r.y[h];
          if (y === undefined) continue;
          const p = sigmoid(z[i]);
          g += r.c * (p - y) * x;
          H += r.c * p * (1 - p) * x * x;
        }
        const d = Math.max(-2, Math.min(2, -g / H));
        if (!d) continue;
        w[f] += d;
        for (const { i, x } of at[f]) z[i] += d * x;
        moved = Math.max(moved, Math.abs(d));
      }
      if (moved < 1e-4) break;
    }
    for (let f = 0; f < names.length; f++) if (Math.abs(w[f]) >= 1e-3) model.w[h][names[f]] = Math.round(w[f] * 1e4) / 1e4;
  }
  return model;
}

export interface Backtest {
  votes: number;
  /** Votes the model gets wrong; and without what it learned, the networks' own settings. */
  errors: number;
  baseline: number;
  /** The newest of the votes it gets wrong, newest first. */
  wrong: Example[];
}

export function backtest(m: Model, examples: readonly Example[]): Backtest {
  const votes = examples.filter((e) => e.vote);
  const wrong = votes.filter((e) => predict(m, e.facts, e.words, undefined, e.x).level !== e.label).sort((a, b) => b.at - a.at);
  return { votes: votes.length, errors: wrong.length, baseline: votes.filter((e) => levelFrom(prior(e.facts)) !== e.label).length, wrong };
}

/** Older votes count less: half after three months, never under a quarter. */
export function voteWeight(at: number, now: number): number {
  return Math.max(0.25, 2 ** (-(now - at) / (90 * 86_400_000)));
}
/** A decision you let stand. */
export const STOOD = 0.05;
/** Of those, at most this many per conversation, the newest. */
export const STOOD_PER_PLACE = 10;

// ------------------------------------------------------------------ in words

export interface Namer {
  conversation(id: string): string;
  space(id: string): string;
  person(id: string): string;
  network(id: string): string;
}

export const TIER_NAME: Record<Level, string> = { push: 'Important', quiet: 'Active', digest: 'Digest', drop: 'Not interesting' };
export const HEAD_NAME: Record<Head, string> = { ping: 'ping', active: 'notify', interesting: 'make the digest' };
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
  link: 'has a link',
  long: 'is long',
  known: 'from someone you know',
  '!known': 'from a stranger',
  notify: 'the network would notify',
  '!notify': 'the network would not notify',
  'native:all': 'where the network notifies every message',
  'native:mentions': 'where the network notifies only mentions',
  'native:none': 'where the network is muted',
  you: 'about you',
  '!you': 'not about you',
};

/** "In #general · Hub, not about you", "Says “deploy”", "From Sam" */
export function describe(feature: string, n: Namer): string {
  const parts = feature.split('&');
  const out: string[] = [];
  for (const p of parts) {
    const [k, v] = p.includes(':') ? [p.slice(0, p.indexOf(':')), p.slice(p.indexOf(':') + 1)] : [p, ''];
    if (k === 'conv') out.push(`in ${n.conversation(v)}`);
    else if (k === 'author') out.push(`from ${n.person(v)}`);
    else if (k === 'space') out.push(`in ${n.space(v)}`);
    else if (k === 'network') out.push(`on ${n.network(v)}`);
    else if (k === 'shape') out.push(`in ${SHAPES[v] ?? v}`);
    else if (k === 'w') out.push(`says “${v}”`);
    else if (k === 'all') out.push('anything');
    else if (k.startsWith(NUM)) out.push(NUMERIC[k.slice(1)]?.text ?? k.slice(1));
    else out.push(FLAG_WORDS[p] ?? p);
  }
  const text = out.join(', ');
  return text[0].toUpperCase() + text.slice(1);
}

/** "More likely to ping: In #general · Hub, about you" */
export function describeWeight(feature: string, head: Head, by: number, n: Namer): string {
  return `${by > 0 ? 'More' : 'Less'} likely to ${HEAD_NAME[head]}: ${describe(feature, n)}`;
}

/** The biggest weights, strongest first, at most `max` per chance. */
export function topWeights(m: Model, max = 12): { feature: string; head: Head; weight: number }[] {
  const out: { feature: string; head: Head; weight: number }[] = [];
  for (const h of HEADS)
    out.push(
      ...Object.entries(m.w[h])
        .filter(([, w]) => Math.abs(w) >= 0.15)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, max)
        .map(([feature, weight]) => ({ feature, head: h, weight })),
    );
  return out.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

/**
 * The prompt for a local model, written from what was learned: the three questions, the strongest weights in words,
 * and votes the model still gets wrong (described by their features, never their text).
 */
export function writePrompt(m: Model, wrong: readonly Example[], n: Namer): string {
  const lines = [
    'You read incoming chat messages for one person and answer three questions about each, as chances from 0 to 1:',
    '- ping: should their phone buzz and their computer show a notification? For what they would drop things for.',
    '- active: is it worth at least a silent notification on their phone, to see soon?',
    '- interesting: is it worth reading later in their digest at all?',
    'By default, whatever Discord or Signal itself would notify them about is worth a ping.',
  ];
  const top = topWeights(m, 6);
  if (top.length) {
    lines.push('', 'Their votes on past notifications taught these, strongest first:');
    for (const t of top) lines.push(`- ${describeWeight(t.feature, t.head, t.weight, n)}`);
  }
  if (wrong.length) {
    lines.push('', 'These votes still come out wrong; weigh them too:');
    for (const e of wrong.slice(0, 6)) {
      const what = features(e.facts)
        .map(([k]) => k)
        .filter((k) => /^(conv|author|space):[^&]*$/.test(k) || ['mention', 'reply', 'question', 'urgent', 'everyone'].includes(k));
      lines.push(`- ${what.map((k) => describe(k, n)).join('; ')}: they said ${TIER_NAME[e.label!]}`);
    }
  }
  return lines.join('\n');
}

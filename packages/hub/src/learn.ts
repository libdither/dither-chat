/**
 * The decision model (docs/notifications.md). Triage puts every message in a tier: Alert (the phone sounds, the
 * desktop shows a notification), Conversation (people talking with you: a silent row of its own on the phone), List
 * (important enough for the phone's ranked list) or below it ('drop': still unread in its chat, nowhere else).
 *
 * Two chances are predicted for each message, each by its own weights:
 *  - `alert`: it cannot wait an hour or two. It starts from the local model's answer to one question about the text
 *    (triage.ts `judge`), set against a bar: `ALERT_BAR`. Only messages in the Conversation tier, and in places you
 *    marked, are asked about at all.
 *  - `important`: you would want to see it. It starts from the network's own setting: 80% where Discord or Signal
 *    itself would have notified you, less elsewhere by how much it is about you.
 * Whether a message is a Conversation is a rule, not a chance (tiers.ts).
 *
 * What your marks taught is added on top of each start, in log-odds: one weight per feature (a conversation, a
 * person, a server, a flag such as "mentions you", the words it uses) and per chance, fitted by L2-regularised
 * logistic regression. The regularisation is the hierarchy: a conversation moves on one mark, a person or a server
 * on a few, a whole network or "anything that mentions you" only on many.
 *
 * Marks count in full, newer more. What stood (an alert you saw and left, a row you opened or swiped away) counts a
 * little (votes.ts, labels.ts). Each example says something about only some of the chances (`y`), and may carry
 * numeric features from outside (`x`: interaction features from interact.ts, content features), each kind with its
 * own regularisation (`NUMERIC`); only the candidate model, run in shadow, weighs those.
 */
import type * as P from '@dither-chat/protocol';

export type Level = P.NotifyTier;
export type Head = P.TriageHead;
export const TIERS: Level[] = ['drop', 'digest', 'quiet', 'push'];
export const HEADS: Head[] = ['alert', 'important'];
export const isTier = (x: unknown): x is Level => TIERS.includes(x as Level);

/**
 * An alert at even odds. The list at your level (Store.listLevel), which starts here: with what the model learns
 * from the two weeks before, 0.6 was about 17 chats a day on a real hub, 0.5 about 38 and 0.9 about 9
 * (docs/triage-replay.md).
 */
export const THRESHOLDS: P.TriageProbs = { alert: 0.5, important: 0.6 };

/**
 * The local model's answer at which a message alerts before any mark. Its answers are low numbers: in DMs and
 * messages about you 0.05 passes nearly every urgent message and about two a day; in chats you only take part in,
 * 0.05 would be ten a day, so the bar there is 0.2 (docs/notifications.md, "The bars").
 */
export const ALERT_BAR = { direct: 0.05, other: 0.2 };
/** The alert chance of a message the local model was not asked about, or did not answer for. */
export const UNJUDGED = 0.02;
/** Importance where the network itself would have notified you. */
export const NOTIFIED = 0.8;

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
  /** Where the rules alone put it; from before the tiers, where the network's settings (or yours) did. */
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
  /** People talking with you (tiers.ts): a DM, about you, or a chat you take part in. */
  conv?: boolean;
  /** The local model's answer to the stop-now question, 0 to 1; absent when it was not asked or did not answer. */
  judge?: number;
  /** Kept to the list: a rule of yours (List only), or the place is muted on its network. Never a Conversation or an alert. */
  cap?: boolean;
}

export interface Example {
  /** The message, when known. */
  id?: string;
  facts: Facts;
  words: string[];
  /** A vote from before the tiers: the level it was voted to. Its labels, unless `y` says otherwise. */
  label?: Level;
  /** What it says for each chance; a chance left out is not learned from it. Default: `labels(label)`. */
  y?: Partial<Record<Head, 0 | 1>>;
  /** Numeric features as of the decision (interact.ts; content features), by name. */
  x?: Record<string, number>;
  weight: number;
  /** A mark of yours (or a vote from before the tiers), as opposed to something that stood or something you did. */
  vote: boolean;
  at: number;
}

/** An example's labels, by chance. */
export const labelsOf = (e: Pick<Example, 'y' | 'label'>): Partial<Record<Head, 0 | 1>> => e.y ?? (e.label ? labels(e.label) : {});

/**
 * What a vote from before the tiers says: Important or Active was worth seeing, Digest or below was not. It says
 * nothing about alerts, which did not exist.
 */
export function labels(l: Level): Partial<Record<Head, 0 | 1>> {
  return { important: l === 'push' || l === 'quiet' ? 1 : 0 };
}

/** What decides a tier besides the two chances. */
export interface TierContext {
  /** The Conversation rule holds (tiers.ts). */
  conv: boolean;
  /** It may alert: a Conversation, or a place or person you marked "should have alerted" lately. */
  eligible: boolean;
  /** The local model answered for it. Without an answer nothing alerts by chance. */
  judged: boolean;
  /** A rule of yours keeps it to the list: never a Conversation or an alert. */
  listOnly?: boolean;
}

export function tierFrom(p: P.TriageProbs, c: TierContext, t: P.TriageProbs = THRESHOLDS): Level {
  if (!c.listOnly) {
    if (c.eligible && c.judged && p.alert >= t.alert) return 'push';
    if (c.conv) return 'quiet';
  }
  return p.important >= t.important ? 'digest' : 'drop';
}

/** The tier context kept with the facts. */
export const contextOf = (f: Facts, eligible = !!f.conv): TierContext => ({ conv: !!f.conv, eligible, judged: f.judge !== undefined, listOnly: !!f.cap });

const clampP = (p: number, lo = 0.001, hi = 0.999) => Math.max(lo, Math.min(hi, p));

/** The bar the local model's answer is set against: lower where the message is to you. */
export const alertBar = (f: Pick<Facts, 'shape' | 'mention' | 'reply'>) => (f.shape === 'direct' || f.mention || f.reply ? ALERT_BAR.direct : ALERT_BAR.other);

/**
 * Before any mark. Alert: the local model's answer against the bar, so it is even odds exactly at the bar. Important:
 * the network would have notified you (facts from before `notify` was kept say so by their base); below that, how
 * addressed to you it is; half of either from a bot.
 */
export function prior(f: Facts): P.TriageProbs {
  const alert = f.judge === undefined ? UNJUDGED : clampP(sigmoid(logit(clampP(f.judge)) - logit(alertBar(f))));
  const notified = f.notify ?? (f.base === 'push' || f.base === 'quiet');
  const important = (notified ? NOTIFIED : Math.min(0.6, 0.05 + 0.75 * (f.score ?? 0.15))) * (f.bot ? 0.5 : 1);
  return { alert, important };
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
  // Content (embeddings.ts): already one number each, learned from many examples, so held less firmly.
  emb: { lambda: 5, text: 'reads like messages you answer' },
  knn: { lambda: 5, text: 'like ones you answered before' },
  jev: { lambda: 5, text: "the local model's reading of it" },
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
export const emptyModel = (): Model => ({ w: { alert: {}, important: {} } });
/** A model saved before the tiers has other chances: it starts over. */
export const validModel = (m: unknown): m is Model => !!m && typeof m === 'object' && HEADS.every((h) => typeof (m as Model).w?.[h] === 'object');

function sigmoid(z: number) {
  return 1 / (1 + Math.exp(-z));
}
function logit(p: number) {
  return Math.log(p / (1 - p));
}

export interface Prediction {
  probs: P.TriageProbs;
  /** The features that moved it most, strongest first. */
  why: { feature: string; head: Head; by: number }[];
}

/** The chances for a message: its start (`prior`, or `start`) plus the learned weights of its features. */
export function predict(m: Model, f: Facts, ws: readonly string[] = [], start?: P.TriageProbs, x?: Record<string, number>): Prediction {
  const p0 = start ?? prior(f);
  const fs = features(f, ws, x);
  const probs = {} as P.TriageProbs;
  const why: Prediction['why'] = [];
  for (const h of HEADS) {
    let z = logit(p0[h]);
    for (const [k, x] of fs) {
      const w = m.w[h]?.[k];
      if (!w) continue;
      z += w * x;
      if (Math.abs(w * x) >= 0.25) why.push({ feature: k, head: h, by: w * x });
    }
    probs[h] = sigmoid(z);
  }
  why.sort((a, b) => Math.abs(b.by) - Math.abs(a.by));
  return { probs, why };
}

/** How much a message matters, for sorting: its importance. */
export const importance = (p: P.TriageProbs) => Math.round(p.important * 1000) / 1000;

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
  /** Marks the model gets wrong; and without what it learned, its starting chances. */
  errors: number;
  baseline: number;
  /** The newest of the marks it gets wrong, newest first. */
  wrong: Example[];
}

/** Does a prediction agree with everything an example says? */
export function agrees(p: P.TriageProbs, e: Pick<Example, 'y' | 'label'>, t: P.TriageProbs = THRESHOLDS): boolean {
  const y = labelsOf(e);
  return HEADS.every((h) => y[h] === undefined || p[h] >= t[h] === (y[h] === 1));
}

export function backtest(m: Model, examples: readonly Example[], t: P.TriageProbs = THRESHOLDS): Backtest {
  const votes = examples.filter((e) => e.vote);
  const wrong = votes.filter((e) => !agrees(predict(m, e.facts, e.words, undefined, e.x).probs, e, t)).sort((a, b) => b.at - a.at);
  return { votes: votes.length, errors: wrong.length, baseline: votes.filter((e) => !agrees(prior(e.facts), e, t)).length, wrong };
}

/** Older marks count less: half after three months, never under a quarter. */
export function voteWeight(at: number, now: number): number {
  return Math.max(0.25, 2 ** (-(now - at) / (90 * 86_400_000)));
}
/** Something that stood: an alert you saw and left unmarked, a Conversation message that did not alert. */
export const STOOD = 0.05;
/** Of those, at most this many per conversation, the newest. */
export const STOOD_PER_PLACE = 10;
/** A vote from before the tiers, against a mark's 1: it answered another question. */
export const OLD_VOTE = 0.5;

// ------------------------------------------------------------------ in words

export interface Namer {
  conversation(id: string): string;
  space(id: string): string;
  person(id: string): string;
  network(id: string): string;
}

export const TIER_NAME: Record<Level, string> = { push: 'Alert', quiet: 'Conversation', digest: 'List', drop: 'Below the list' };
/**
 * What moved a message out of the tier its start gave it, in the words of a reason. Raised onto the list, it was what
 * you opened and answered: importance learns its yes from those, its no only from "Less like this". Anything else
 * (an alert raised or lowered, a message lowered off the list) came from your marks.
 */
export function learnedFrom(tier: Level, before: Level): string {
  return tier === 'digest' && before === 'drop' ? 'learned from what you opened' : 'learned from your marks';
}
export const HEAD_NAME: Record<Head, string> = { alert: 'alert', important: 'matter' };
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

/** "More likely to alert: In #general · Hub, about you" */
export function describeWeight(feature: string, head: Head, by: number, n: Namer): string {
  return `${by > 0 ? 'More' : 'Less'} likely to ${HEAD_NAME[head]}: ${describe(feature, n)}`;
}

/** The biggest weights, strongest first, at most `max` per chance. */
export function topWeights(m: Model, max = 12): { feature: string; head: Head; weight: number }[] {
  const out: { feature: string; head: Head; weight: number }[] = [];
  for (const h of HEADS)
    out.push(
      ...Object.entries(m.w[h] ?? {})
        .filter(([, w]) => Math.abs(w) >= 0.15)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, max)
        .map(([feature, weight]) => ({ feature, head: h, weight })),
    );
  return out.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

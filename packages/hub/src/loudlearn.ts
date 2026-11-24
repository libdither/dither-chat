/**
 * The loudness scale's learning and its settings (docs/notifications.md): what your answers say, routed to the one
 * part of the model each is about, and the models fitted again after each answer (loudness.ts trainAttn) and once a
 * day, when what you did (answered, opened, swiped away) joins in at low weight.
 *
 * Where each answer goes:
 *  - Worth it: want and can't-wait up, for this kind of message. Shouldn't have reached me: want down. Could have
 *    waited: can-wait longer (want unchanged), and a sound at that moment a little dearer. Wish I'd known sooner:
 *    can't-wait up, want up, a sound a little cheaper. Fine where it was: nothing moves.
 *  - Louder / Quieter for a person or a chat: that person's or chat's weight only, on both chances. They also stand as
 *    today's marks (votes.ts: should have alerted, the alert was wrong, less like this), so the tiers keep learning.
 *  - The why, when given, replaces what its answer taught with what it names: how long it could have waited (a label
 *    for the can-wait buckets), this chat, this person (want and owed, across networks), this topic (the words), the
 *    moment (a sound's cost then, not the message), or "I'd already seen it" (nothing learned: a delivery fault).
 *  - Your own words are read by the local model only, turned into one of the reasons, and never kept.
 *
 * Label weights: answers and marks 1; you answered 0.3; an open of 5 s or more that did not follow a sound 0.1; a
 * row swiped away unopened 0.05; an open right after a sound 0 (the sound caused it).
 */
import type * as P from '@dither-chat/protocol';
import { bandOf, DEFAULT_ATTENTION_PREFS, LOUDER_WHY, QUIETER_WHY } from '@dither-chat/protocol';
import { words, type Facts, type Namer } from './learn.ts';
import { answerWeight, ATTN_WEIGHTS, emptyAttnModel, learnedList, trainAttn, validAttnModel, type AttnExample, type AttnModel } from './loudness.ts';
import { Checkins, newId, type CheckinState } from './checkin.ts';
import { gatherOutcomes, LATE, OPEN_DWELL, type Outcome } from './labels.ts';
import { previewText, type Store } from './store.ts';
import { jobFailed } from './errors.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** What you did is learned from over this long, at most this many per chat (the newest). */
const IMPLICIT_WINDOW = 14 * DAY;
const IMPLICIT_PER_PLACE = 10;
/** An open this soon after a sound was the sound's doing. */
const AFTER_SOUND = 2 * MIN;
/** "Could have waited" / "Wish I'd known sooner" move a sound's cost at that moment this much; the moment's own reasons more. */
const MOMENT_NUDGE = 0.1;
const MOMENT_STEP = 0.3;

/** Answers that may be followed by "why", and which side's reasons it offers. */
const WHY_SIDE: Partial<Record<P.AttnAnswer, 'quieter' | 'louder'>> = { quieter: 'quieter', could_wait: 'quieter', shouldnt: 'quieter', louder: 'louder', sooner: 'louder' };

/** What each reason means, as the local model is asked about your words. Fixed strings: jev caches by them. */
const REASON_QUESTION: Record<P.WhyReason, string> = {
  could_wait: 'Does this say the message could have waited until later?',
  not_chat: 'Does this say the reader does not care about this chat or channel?',
  not_person: 'Does this say the reader does not care about messages from this person?',
  not_topic: 'Does this say the reader does not care about this topic?',
  bad_moment: 'Does this say it was a bad time to be interrupted?',
  seen: 'Does this say the reader had already seen it?',
  time_sensitive: 'Does this say the message was time-sensitive or urgent?',
  person_matters: 'Does this say this person matters to the reader?',
  chat_matters: 'Does this say this chat or channel matters to the reader?',
  topic_matters: 'Does this say this topic matters to the reader?',
  was_free: 'Does this say the reader was free and could have been interrupted?',
};

/** Asks the local model one yes/no question about a text: the chance of yes, or null. */
type Ask = (question: string, text: string) => Promise<number | null>;

interface Saved {
  model: AttnModel;
  rejected: string[];
}

export class LoudLearner {
  readonly checkins: Checkins;
  /** What it learned (loudness.ts), read by triage at each decision. */
  model: AttnModel = emptyAttnModel();
  private rejected: string[] = [];
  private implicitCache: { at: number; examples: AttnExample[] } | null = null;
  /** The local model, for your words (main.ts: jev; a demo hub: keywords). */
  ask: Ask | null = null;
  /** Mirrors Louder / Quieter onto today's marks (votes.ts), so the tiers keep learning. */
  mark: ((messageId: string, marks: P.TriageMarks) => void) | null = null;
  namer: Namer | null = null;

  constructor(
    private store: Store,
    readonly mode: P.AttentionMode,
  ) {
    const saved = store.metaValue<Saved>('attn_model');
    if (saved && validAttnModel(saved.model)) {
      this.model = saved.model;
      this.rejected = saved.rejected ?? [];
    }
    this.checkins = new Checkins(
      store.db,
      { get: () => store.metaValue<CheckinState>('checkin_state'), set: (s) => store.setMetaValue('checkin_state', s) },
      (id) => this.describe(id),
    );
  }

  prefs(): P.AttentionPrefs {
    return { ...DEFAULT_ATTENTION_PREFS, ...(this.store.metaValue<Partial<P.AttentionPrefs>>('attention_prefs') ?? {}) };
  }

  setPrefs(p: Partial<P.AttentionPrefs>): P.AttentionPrefs {
    const next = { ...this.prefs() };
    if (p.readily === 'less' || p.readily === 'learned' || p.readily === 'more') next.readily = p.readily;
    if (p.nextLook === 'open' || p.nextLook === 'times' || p.nextLook === 'both') next.nextLook = p.nextLook;
    if (Array.isArray(p.times)) next.times = p.times.filter((t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0, 6);
    if (typeof p.computerFirst === 'boolean') next.computerFirst = p.computerFirst;
    if (p.ask === 'never' || p.ask === 'rarely' || p.ask === 'often') next.ask = p.ask;
    if (typeof p.drifting === 'boolean') next.drifting = p.drifting;
    this.store.setMetaValue('attention_prefs', next);
    return next;
  }

  /** A message's title and one line, for a check-in. */
  private describe(messageId: string): { title: string; preview: string; conversationId: string | null } | null {
    const s = this.store;
    const m = s.one<Row>(
      `SELECT m.body, m.kind, m.conversation_id, c.name, c.shape, COALESCE(p.name, i.display_name, i.handle) AS author
       FROM message m JOIN conversation c ON c.id = m.conversation_id LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN person p ON p.id = i.person_id WHERE m.id = ?`,
      messageId,
    );
    if (!m) return null;
    const where = m.shape === 'direct' ? (m.author ?? 'Direct message') : `${m.name ?? 'A chat'}${m.author ? ` · ${m.author}` : ''}`;
    return { title: where, preview: previewText(m.body ?? '', m.kind).slice(0, 160), conversationId: m.conversation_id };
  }

  // ------------------------------------------------------------ answers

  /**
   * An answer about a message (a check-in, the Why sheet, a notification's action). Louder / Quieter also stand as
   * today's marks. Says whether to ask why: at most one a chat a day, and never twice in a row for the same answer.
   */
  answer(b: P.AttnAnswerBody, now = Date.now()): P.AttnAnswerResult {
    const s = this.store;
    const t = s.one<Row>(
      `SELECT t.decision, t.loud, m.conversation_id, COALESCE(i.person_id, m.author_id) AS author
       FROM message m LEFT JOIN triage t ON t.message_id = m.id LEFT JOIN identity i ON i.id = m.author_id WHERE m.id = ?`,
      b.messageId,
    );
    if (!t) throw new Error('No such message');
    const id = newId('ans');
    const side = WHY_SIDE[b.answer];
    const asked = side ? this.whyDue(t.conversation_id, b.answer, now) : false;
    s.db
      .query(
        `INSERT INTO attn_answer (id, message_id, conversation_id, author, answer, source, scope, checkin_id, band, sounded, why_asked, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, b.messageId, t.conversation_id, t.author, b.answer, b.source, b.scope ?? null, b.checkinId ?? null, t.loud != null ? bandOf(t.loud) : null, t.decision === 'push' ? 1 : 0, asked ? 1 : 0, now);
    if (b.checkinId) this.checkins.answer(b.checkinId, b.answer, now);
    // The tiers keep learning from Louder / Quieter as from the marks they replace.
    if (this.mark && t.decision && t.decision !== 'silent' && (b.answer === 'louder' || b.answer === 'quieter')) {
      try {
        this.mark(b.messageId, b.answer === 'louder' ? { alert: true } : t.decision === 'push' ? { alert: false } : { less: true });
      } catch (e) {
        console.error('attention: the mark could not be kept', e);
      }
    }
    this.learn(now);
    return { ok: true, answerId: id, ...(asked ? { why: side } : {}) };
  }

  /** A mark from the old route (POST /api/messages/:id/feedback), kept as the answer it now is. */
  fromMark(messageId: string, marks: P.TriageMarks, now = Date.now()) {
    const answer: P.AttnAnswer | null = marks.alert === true ? 'louder' : marks.alert === false || marks.less === true ? 'quieter' : null;
    if (!answer) return;
    const mark = this.mark;
    this.mark = null;
    try {
      this.answer({ messageId, answer, source: 'sheet' }, now);
    } finally {
      this.mark = mark;
    }
  }

  private whyDue(conversationId: string | null, answer: P.AttnAnswer, now: number): boolean {
    const s = this.store;
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    if (conversationId && s.one(`SELECT 1 FROM attn_answer WHERE conversation_id = ? AND why_asked = 1 AND at >= ?`, conversationId, day.getTime())) return false;
    const last = s.one<Row>(`SELECT answer FROM attn_answer WHERE why_asked = 1 ORDER BY at DESC LIMIT 1`);
    return last?.answer !== answer;
  }

  /** The why after an answer: a chip, or your words mapped to one by the local model; an optional end date. */
  async why(b: P.WhyBody, now = Date.now()): Promise<P.WhyResult> {
    const s = this.store;
    const a = s.one<Row>('SELECT * FROM attn_answer WHERE id = ?', b.answerId);
    if (!a) throw new Error('No such answer');
    const side = WHY_SIDE[a.answer as P.AttnAnswer] ?? 'quieter';
    const allowed = side === 'quieter' ? QUIETER_WHY : LOUDER_WHY;
    let reason: P.WhyReason | null = b.reason && allowed.includes(b.reason) ? b.reason : null;
    let texted = false;
    if (!reason && b.text?.trim()) {
      reason = await this.readWords(b.text.trim().slice(0, 500), allowed);
      texted = !!reason;
    }
    const waits = side === 'quieter' ? ['10min', 'hour', 'tonight', 'never'] : ['now', 'within_hour', 'today'];
    const wait = b.wait && waits.includes(b.wait) ? b.wait : null;
    // "How long" alone says it was about waiting.
    if (!reason && wait) reason = side === 'quieter' ? 'could_wait' : 'time_sensitive';
    const until = typeof b.until === 'number' && b.until > now ? Math.round(b.until) : null;
    s.db.query('UPDATE attn_answer SET reason = ?, wait = ?, texted = ?, until = ?, why_at = ? WHERE id = ?').run(reason, wait, texted ? 1 : 0, until, now, a.id);
    this.learn(now);
    return { ok: true, reason };
  }

  /** Your words, as the reason the local model finds most likely (above even odds), else a few plain keywords. */
  private async readWords(text: string, allowed: readonly P.WhyReason[]): Promise<P.WhyReason | null> {
    if (this.ask) {
      let best: { r: P.WhyReason; p: number } | null = null;
      for (const r of allowed) {
        const p = await this.ask(REASON_QUESTION[r], text).catch(() => null);
        if (p !== null && (!best || p > best.p)) best = { r, p };
      }
      if (best && best.p >= 0.5) return best.r;
      if (best) return null;
    }
    const t = text.toLowerCase();
    const hit = (re: RegExp, r: P.WhyReason) => (allowed.includes(r) && re.test(t) ? r : null);
    return (
      hit(/\b(later|wait|tonight|tomorrow|not urgent)\b/, 'could_wait') ??
      hit(/\b(seen|already|read it)\b/, 'seen') ??
      hit(/\b(busy|meeting|asleep|sleeping|driving|bad time)\b/, 'bad_moment') ??
      hit(/\b(free|bored|wasn't busy)\b/, 'was_free') ??
      hit(/\b(urgent|asap|deadline|soon|now)\b/, 'time_sensitive') ??
      hit(/\b(channel|chat|group|server)\b/, allowed.includes('not_chat') ? 'not_chat' : 'chat_matters') ??
      hit(/\b(he|she|they|person|friend|boss)\b/, allowed.includes('not_person') ? 'not_person' : 'person_matters') ??
      hit(/\b(about|topic|anything)\b/, allowed.includes('not_topic') ? 'not_topic' : 'topic_matters')
    );
  }

  /** A check-in's answer (or a skip: null). For you's: glad / not. */
  checkin(id: string, answer: string | null, now = Date.now()): P.AttnAnswerResult | { ok: true } {
    const r = this.store.one<Row>('SELECT * FROM checkin WHERE id = ?', id);
    if (!r) throw new Error('No such question');
    if (answer === null) {
      this.checkins.answer(id, null, now);
      return { ok: true };
    }
    if (r.side === 'foryou') {
      if (answer !== 'glad' && answer !== 'not') throw new Error('Say glad or not');
      this.checkins.answer(id, answer, now);
      this.learn(now);
      return { ok: true };
    }
    const ok: P.AttnAnswer[] = r.side === 'sounded' ? ['worth', 'could_wait', 'shouldnt'] : ['sooner', 'fine'];
    if (!ok.includes(answer as P.AttnAnswer)) throw new Error(`Say one of ${ok.join(', ')}`);
    return this.answer({ messageId: r.message_id, answer: answer as P.AttnAnswer, source: 'checkin', checkinId: id }, now);
  }

  // ------------------------------------------------------------ learning

  /** Every answer, as examples routed to the part each names. */
  answerExamples(now = Date.now()): AttnExample[] {
    const s = this.store;
    const out: AttnExample[] = [];
    const rows = s.raw<Row>(
      `SELECT a.*, t.facts, t.probs, t.loud_view, m.body FROM attn_answer a JOIN triage t ON t.message_id = a.message_id JOIN message m ON m.id = a.message_id
       WHERE t.facts IS NOT NULL ORDER BY a.at DESC LIMIT 5000`,
    );
    for (const r of rows) {
      if (r.until != null && r.until <= now) continue;
      const base = baseOf(r);
      if (!base) continue;
      out.push(...routed(r, base, answerWeight(r.at, now) * ATTN_WEIGHTS.answer));
    }
    // For you's answers: want, for the chat and the author.
    for (const r of s.raw<Row>(
      `SELECT c.answer, c.answered_at, t.facts, t.probs, t.loud_view, m.body FROM checkin c JOIN triage t ON t.message_id = c.message_id JOIN message m ON m.id = c.message_id
       WHERE c.side = 'foryou' AND c.answer IS NOT NULL AND t.facts IS NOT NULL ORDER BY c.answered_at DESC LIMIT 2000`,
    )) {
      const base = baseOf(r);
      if (base) out.push({ ...base, want: r.answer === 'glad' ? 1 : 0, weight: answerWeight(r.answered_at, now) });
    }
    return out;
  }

  /** What you did after the last two weeks' messages, at the low weights of the table. */
  implicitExamples(now = Date.now(), fresh = false): AttnExample[] {
    if (!fresh && this.implicitCache && now - this.implicitCache.at <= DAY && now >= this.implicitCache.at) return this.implicitCache.examples;
    const s = this.store;
    const row = s.db.query(`SELECT t.facts, t.probs, t.loud_view, m.body FROM triage t JOIN message m ON m.id = t.message_id WHERE t.message_id = ? AND t.loud_view IS NOT NULL`);
    const per = new Map<string, number>();
    const out: AttnExample[] = [];
    const outcomes = [...gatherOutcomes(s.db, now - IMPLICIT_WINDOW, now, { now }).values()].sort((a, b) => b.ts - a.ts);
    for (const o of outcomes) {
      const l = behaviourLabel(o);
      if (!l) continue;
      const n = per.get(o.conv) ?? 0;
      if (n >= IMPLICIT_PER_PLACE) continue;
      const r = row.get(o.id) as Row | null;
      const base = r && baseOf(r);
      if (!base) continue;
      per.set(o.conv, n + 1);
      out.push({ ...base, want: l.want, weight: l.weight, at: o.ts });
    }
    this.implicitCache = { at: now, examples: out };
    return out;
  }

  /** Fit again: after each answer (what you did as last read), and daily (read again). */
  learn(now = Date.now(), daily = false) {
    try {
      const ex = [...this.answerExamples(now), ...this.implicitExamples(now, daily)];
      this.model = trainAttn(ex, new Set(this.rejected), now);
      this.store.setMetaValue('attn_model', { model: this.model, rejected: this.rejected } satisfies Saved);
    } catch (e) {
      console.error('attention: could not learn', e);
      jobFailed('attention: learn', e);
    }
  }

  daily(now = Date.now()) {
    if (!this.model.learnedAt || now - this.model.learnedAt > DAY || now < this.model.learnedAt) this.learn(now, true);
  }

  /** Forget something learned, for good, or let it be learned again (keys as learnedList gives them). */
  forget(key: string, rejected: boolean, now = Date.now()) {
    this.rejected = rejected ? [...new Set([...this.rejected, key])] : this.rejected.filter((k) => k !== key);
    this.learn(now);
  }

  /** For you's factor from what you said was worth seeing: the chat's and the author's want, 0 to 2, 1 knowing nothing. */
  worth(c: { conv: string; author: string | null }): number {
    const z = (this.model.want[`conv:${c.conv}`] ?? 0) + (c.author ? (this.model.want[`author:${c.author}`] ?? 0) : 0);
    return 2 / (1 + Math.exp(-z));
  }

  view(now = Date.now(), held = 0): P.AttentionStateView {
    const st = this.checkins.state();
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    const sounds = this.store.one<Row>(`SELECT COUNT(*) AS n FROM triage INDEXED BY triage_created WHERE created_at >= ? AND decision = 'push'`, day.getTime())?.n ?? 0;
    return {
      mode: this.mode,
      prefs: this.prefs(),
      soundsToday: sounds,
      asked: this.checkins.askedToday(now),
      answered: this.checkins.answeredToday(now),
      pausedUntil: st.pausedUntil !== null && st.pausedUntil > now ? st.pausedUntil : null,
      rate: st.rate,
      held,
      learned: learnedList(this.model, this.namer),
    };
  }
}

/** A stored decision as the start of an example: its facts, words, reasons, and where want and urgency began. */
function baseOf(r: Row): AttnExample | null {
  let facts: Facts;
  try {
    facts = JSON.parse(r.facts);
  } catch {
    return null;
  }
  const probs = r.probs ? (JSON.parse(r.probs) as Partial<P.TriageProbs>) : {};
  const lv = r.loud_view ? (JSON.parse(r.loud_view) as { why?: string[]; moment?: string[] }) : {};
  return {
    facts,
    words: words(r.body ?? ''),
    why: lv.why ?? [],
    importance: typeof probs.important === 'number' ? probs.important : 0.3,
    ...(facts.judge !== undefined && typeof probs.alert === 'number' ? { alert: probs.alert } : {}),
    ...(lv.moment ? { moment: { keys: lv.moment, by: 0 } } : {}),
    weight: 0,
    at: r.at ?? 0,
  };
}

const QUIETER_WAIT: Record<string, AttnExample['wait']> = { '10min': [0, 1, undefined], hour: [0, 0, 1], tonight: [0, 0, 0], never: [0, 0, 0] };
const LOUDER_WAIT: Record<string, AttnExample['wait']> = { now: [1, 1, 1], within_hour: [0, 1, 1], today: [0, 0, 1] };

/** One answer (and its why) as what it teaches, each part at the scope it names. */
export function routed(a: Row, base: AttnExample, weight: number): AttnExample[] {
  const keys = base.moment?.keys ?? [];
  const e = (x: Partial<AttnExample>): AttnExample => ({ ...base, moment: undefined, ...x, weight, at: a.at });
  const scope = a.scope === 'chat' ? 'conv' : a.scope === 'person' ? 'author' : undefined;
  const reason = a.reason as P.WhyReason | null;
  if (reason) {
    switch (reason) {
      case 'could_wait':
        return [e({ wait: QUIETER_WAIT[a.wait] ?? [undefined, 0, undefined], ...(a.wait === 'never' ? { want: 0 } : {}), moment: { keys, by: MOMENT_NUDGE } })];
      case 'time_sensitive':
        return [e({ wait: LOUDER_WAIT[a.wait] ?? [undefined, 1, 1] })];
      case 'not_chat':
      case 'chat_matters':
        return [e({ want: reason === 'chat_matters' ? 1 : 0, only: 'conv' })];
      case 'not_person':
      case 'person_matters':
        return [e({ want: reason === 'person_matters' ? 1 : 0, owed: reason === 'person_matters' ? 1 : 0, only: 'author' })];
      case 'not_topic':
      case 'topic_matters':
        return base.words.length ? [e({ want: reason === 'topic_matters' ? 1 : 0, only: 'words' })] : [];
      case 'bad_moment':
      case 'was_free':
        return keys.length ? [e({ moment: { keys, by: reason === 'bad_moment' ? MOMENT_STEP : -MOMENT_STEP } })] : [];
      case 'seen':
        return [];
    }
  }
  switch (a.answer as P.AttnAnswer) {
    case 'worth':
      return [e({ want: 1, wait: [undefined, 1, 1] })];
    case 'could_wait':
      return [e({ wait: [undefined, 0, undefined], moment: { keys, by: MOMENT_NUDGE } })];
    case 'shouldnt':
      return [e({ want: 0 })];
    case 'sooner':
      return [e({ want: 1, wait: [undefined, 1, 1], moment: { keys, by: -MOMENT_NUDGE } })];
    case 'louder':
      return [e({ want: 1, wait: [undefined, 1, 1], ...(scope ? { only: scope } : {}), ...(scope === 'author' ? { owed: 1 } : {}) })];
    case 'quieter':
      return [e({ want: 0, wait: [undefined, 0, undefined], ...(scope ? { only: scope } : {}), ...(scope === 'author' ? { owed: 0 } : {}) })];
    default:
      return [];
  }
}

/** What you did, as a label of want: answered (0.3), opened and stayed, not right after a sound (0.1), swiped away unopened (0.05). */
export function behaviourLabel(o: Outcome): { want: 0 | 1; weight: number } | null {
  if (o.engaged || o.seenLive || o.suppressed) return null;
  if ((o.answered && o.nextOwn !== null && o.nextOwn <= LATE) || o.reacted) return { want: 1, weight: ATTN_WEIGHTS.replied };
  const sounded = o.decision === 'push' && o.notified;
  const tapped = o.tapped !== null && (o.tapDwell ?? o.openDwell ?? OPEN_DWELL) >= OPEN_DWELL;
  const opened = o.opened !== null && o.opened <= DAY && (o.openDwell ?? OPEN_DWELL) >= OPEN_DWELL;
  if (tapped || opened) {
    const at = tapped ? o.tapped! : o.opened!;
    if (sounded && at <= AFTER_SOUND) return null;
    return { want: 1, weight: ATTN_WEIGHTS.opened };
  }
  if (o.dismissed && o.opened === null) return { want: 0, weight: ATTN_WEIGHTS.swiped };
  return null;
}

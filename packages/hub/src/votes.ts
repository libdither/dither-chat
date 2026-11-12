/**
 * Your marks on triage's decisions, and the model learned from them (learn.ts, docs/notifications.md). A mark says a
 * message should have alerted, that an alert was wrong, or "less like this"; after each one the model is fitted
 * again to everything it learns from (it takes well under a second) and backtested. Once a day too, as marks age,
 * decisions stand and what you did is read again.
 *
 * What each chance learns from:
 *  - alert: your marks; alerts you left unmarked for half a day (a little, as "that was right"); Conversation
 *    messages the local model read that did not alert and were not marked (a little, as "that was right too").
 *    Only decisions made since the tiers: what was Important before them was not an alert.
 *  - important: "less like this"; what you did after a message (labels.ts: answered, opened, swiped away); and the
 *    votes from before the tiers, at half weight.
 *
 * Next to it, a candidate model learns from the same and from every outcome of the last two weeks, with the
 * interaction and content features kept with each decision (interact.ts, embeddings.ts, triage_input). It runs in
 * shadow (shadow.ts): its chances are kept with every decision, it never decides.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { ALERT_BAR, backtest, describe, emptyModel, isTier, OLD_VOTE, STOOD, STOOD_PER_PLACE, topWeights, train, validModel, voteWeight, words, features, type Example, type Facts, type Model, type Namer } from './learn.ts';
import { SHOWN, type Store } from './store.ts';
import type { Triage } from './triage.ts';
import { gatherOutcomes, implicitLabel } from './labels.ts';
import { shadowSummary } from './shadow.ts';

type Row = Record<string, any>;
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface State {
  model: Model;
  /** Features you told it to forget. */
  rejected: string[];
  learnedAt: number | null;
  lastReason: string | null;
  /** The shadow model, and how many examples of each kind it learned from. */
  candidate?: Model | null;
  candidateFrom?: { votes: number; implicit: number } | null;
}

/** What you did is learned from over this long. */
export const IMPLICIT_WINDOW = 14 * DAY;
/** What you did is read again at the daily refit, or after this long: a pass over two weeks of messages, a few seconds on a busy hub. */
const IMPLICIT_TTL = DAY;
/** Of what you did, the live model takes this many per conversation, the newest: one busy chat must not outweigh the rest. */
export const IMPLICIT_PER_PLACE = 10;
/** An alert left unmarked this long stood; so did a Conversation message that did not alert. */
export const STOOD_AFTER = 12 * HOUR;
/** How long a worked-out preview stands. */
const PREVIEW_EVERY = HOUR;
/** The levels the list can be set to, for the preview. */
export const LIST_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/**
 * What else triage decides on with the same model (mail/triage.ts): its marks are kept there, join these examples,
 * and teach the same weights, so "less like this" on Sam's mail moves Sam's chats too.
 */
export interface OtherVotes {
  examples(now: number): Example[];
  /** A mark on one of its messages; undefined when the message is not one of its own. */
  mark(messageId: string, marks: P.TriageMarks, now: number): P.TriageMarks | undefined;
  /** Names for its conversations and spaces, in what was learned; null when the id is not its own. */
  names?: { conversation?(id: string): string | null; space?(id: string): string | null };
}

export class TriageVotes {
  private state: State;
  private implicitCache: { at: number; examples: Example[] } | null = null;
  private shadowCache: { at: number; view: P.TriageShadowView } | null = null;
  private previewCache: { at: number; rows: P.TriagePolicyView['preview'] } | null = null;
  /** Mail's marks (mail/triage.ts). */
  readonly others: OtherVotes[] = [];

  constructor(
    private store: Store,
    private triage: Triage,
  ) {
    const saved = store.triagePolicy<Partial<State>>() ?? {};
    // A model from before the tiers predicted other chances: it starts over from the marks and the old votes.
    const ok = validModel(saved.model);
    this.state = {
      model: ok ? saved.model! : emptyModel(),
      rejected: saved.rejected ?? [],
      learnedAt: ok ? (saved.learnedAt ?? null) : null,
      lastReason: ok ? (saved.lastReason ?? null) : null,
      candidate: validModel(saved.candidate) ? saved.candidate : null,
      candidateFrom: validModel(saved.candidate) ? (saved.candidateFrom ?? null) : null,
    };
    if (!ok && saved.model) {
      // Start over at once from the marks and the old votes, which is quick. What you did is two weeks of messages
      // to read, seconds on a busy hub: the first tick does that (`daily`, which finds nothing learned yet).
      const ex = [...this.marked(Date.now()), ...this.stood(Date.now())];
      const model = train(ex, new Set(this.state.rejected));
      this.state = { ...this.state, model, candidate: model, candidateFrom: { votes: ex.filter((e) => e.vote).length, implicit: 0 }, lastReason: 'the tiers replaced the levels' };
      this.store.setTriagePolicy(this.state);
    }
    this.publish();
  }

  /** Everything the live model learns from: marks, old votes, what stood, and the newest of what you did in each place. */
  examples(now = Date.now()): Example[] {
    const out = this.marked(now);
    out.push(...this.stood(now));
    const per = new Map<string, number>();
    for (const e of [...this.implicit(now)].sort((a, b) => b.at - a.at)) {
      const n = per.get(e.facts.conversation) ?? 0;
      if (n >= IMPLICIT_PER_PLACE) continue;
      per.set(e.facts.conversation, n + 1);
      out.push(e);
    }
    for (const o of this.others) out.push(...o.examples(now));
    return out;
  }

  /** Your marks, and the votes from before the tiers. Facts missing on older votes are filled in. */
  private marked(now: number): Example[] {
    const s = this.store;
    const out: Example[] = [];
    // Each half walks its own index (triage_marked, triage_feedback): asked for together, every decision is read.
    const cols = `t.message_id, t.decision, t.was, t.feedback, t.feedback_at, t.alert_mark, t.less_mark, t.marked_at, t.facts, m.body`;
    const rows = new Map<string, Row>();
    for (const r of s.raw<Row>(`SELECT ${cols} FROM triage t LEFT JOIN message m ON m.id = t.message_id WHERE t.marked_at IS NOT NULL ORDER BY t.marked_at DESC LIMIT 5000`)) rows.set(r.message_id, r);
    for (const r of s.raw<Row>(`SELECT ${cols} FROM triage t LEFT JOIN message m ON m.id = t.message_id WHERE t.feedback IS NOT NULL ORDER BY t.feedback_at DESC LIMIT 5000`)) rows.set(r.message_id, r);
    for (const r of rows.values()) {
      let facts = r.facts ? (JSON.parse(r.facts) as Facts) : null;
      const base = r.was ?? r.decision;
      if (!facts && isTier(base)) {
        facts = this.triage.factsFor(r.message_id, base);
        if (facts) s.setTriageFacts(r.message_id, facts);
      }
      if (!facts) continue;
      const ws = words(r.body ?? '');
      if (r.marked_at != null) {
        const y: Example['y'] = {};
        if (r.alert_mark != null) y.alert = r.alert_mark ? 1 : 0;
        if (r.less_mark) y.important = 0;
        if (Object.keys(y).length) out.push({ id: r.message_id, facts, words: ws, y, weight: voteWeight(r.marked_at, now), vote: true, at: r.marked_at });
      }
      // "Less like this" says more than the vote it replaces.
      if (r.feedback && !r.less_mark) out.push({ id: r.message_id, facts, words: ws, label: r.feedback, weight: OLD_VOTE * voteWeight(r.feedback_at ?? now, now), vote: true, at: r.feedback_at ?? 0 });
    }
    return out;
  }

  /**
   * What stood since the tiers: alerts the model made that you left unmarked say "that was right" (a rule's alerts
   * say nothing of the model); Conversation messages it read and did not raise say the same of not alerting.
   */
  private stood(now: number): Example[] {
    const since = Math.max(this.store.tiersAt(), now - 30 * DAY);
    const rows = this.store.raw<Row>(
      `SELECT decision, facts, created_at FROM (
         SELECT t.decision, t.facts, t.created_at, ROW_NUMBER() OVER (PARTITION BY m.conversation_id, t.decision ORDER BY t.created_at DESC) AS n
         FROM triage t INDEXED BY triage_tier_score JOIN message m ON m.id = t.message_id
         WHERE t.marked_at IS NULL AND t.facts IS NOT NULL AND t.decision IN ('push', 'quiet') AND t.created_at > ? AND t.created_at < ?
           AND json_extract(t.facts, '$.judge') IS NOT NULL AND json_extract(t.facts, '$.base') != 'push')
       WHERE n <= ?`,
      since,
      now - STOOD_AFTER,
      STOOD_PER_PLACE,
    );
    return rows.map((r) => ({ facts: JSON.parse(r.facts), words: [], y: { alert: r.decision === 'push' ? 1 : 0 }, weight: STOOD, vote: false, at: r.created_at }) as Example);
  }

  /** What you did after the messages of the last two weeks (labels.ts), as examples of importance; marked ones left out. */
  private implicit(now: number, fresh = false): Example[] {
    if (!fresh && this.implicitCache && now - this.implicitCache.at <= IMPLICIT_TTL && now >= this.implicitCache.at) return this.implicitCache.examples;
    const s = this.store;
    const out: Example[] = [];
    const row = s.db.query('SELECT t.facts, t.feedback, t.marked_at, m.body FROM triage t JOIN message m ON m.id = t.message_id WHERE t.message_id = ?');
    for (const o of gatherOutcomes(s.db, now - IMPLICIT_WINDOW, now, { now }).values()) {
      const l = implicitLabel(o);
      if (!l || l.knownAt > now) continue;
      const r = row.get(o.id) as Row | null;
      if (!r?.facts || r.feedback || r.marked_at != null) continue;
      out.push({ id: o.id, facts: JSON.parse(r.facts), words: words(r.body ?? ''), y: l.y, weight: l.weight, vote: false, at: o.ts });
    }
    this.implicitCache = { at: now, examples: out };
    return out;
  }

  /** Mark a decision (null takes a mark back), then learn again. */
  mark(messageId: string, marks: P.TriageMarks, now = Date.now()): { marks: P.TriageMarks; policy: P.TriagePolicyView } {
    for (const o of this.others) {
      const made = o.mark(messageId, marks, now);
      if (made === undefined) continue;
      const ex = this.examples(now);
      this.learn('a mark', now, ex);
      return { marks: made, policy: this.view(now, ex) };
    }
    const s = this.store;
    const t = s.one<Row>('SELECT decision, was, facts FROM triage WHERE message_id = ?', messageId);
    if (!t) throw new Error('Triage never decided on this message');
    if (!isTier(t.decision)) throw new Error('This place is silenced: change its notification setting instead');
    if (!t.facts) {
      const f = this.triage.factsFor(messageId, t.was ?? t.decision);
      if (f) s.setTriageFacts(messageId, f);
    }
    s.triageMark(messageId, marks, now);
    this.triage.forgetMarked();
    const r = s.one<Row>('SELECT alert_mark, less_mark FROM triage WHERE message_id = ?', messageId)!;
    const ex = this.examples(now);
    this.learn('a mark', now, ex);
    return { marks: { ...(r.alert_mark != null ? { alert: !!r.alert_mark } : {}), ...(r.less_mark ? { less: true } : {}) }, policy: this.view(now, ex) };
  }

  /** Once a day: marks age, decisions stand and what you did joins in. */
  daily(now = Date.now()) {
    if (!this.state.learnedAt || now - this.state.learnedAt > DAY) this.learn('daily', now);
    else if (this.state.candidate == null) {
      // A hub from before the shadow model: it learns at the first tick, not a day later.
      this.learnCandidate(now);
      this.save();
    }
  }

  learn(reason: string, now = Date.now(), ex?: Example[]) {
    // The daily refit reads what you did again; a mark refits on it as last read.
    if (reason === 'daily') this.implicit(now, true);
    ex ??= this.examples(now);
    const model = train(ex, new Set(this.state.rejected));
    this.state = { ...this.state, model, learnedAt: now, lastReason: reason };
    this.learnCandidate(now, ex.filter((e) => e.vote));
    this.save();
  }

  /**
   * What the candidate learns from: the marks and old votes, and every outcome of the last two weeks (not only the
   * newest in each place), each with the interaction and content features kept when it was decided.
   */
  candidateExamples(now = Date.now(), marked: Example[] = this.marked(now)): Example[] {
    const s = this.store;
    const inputs = s.db.query('SELECT features FROM triage_input WHERE message_id = ?');
    // Content features are read now, not as kept: a labelled message's probe score is cross-fitted (embeddings.ts),
    // so it never learned from its own label.
    const content = this.triage.content;
    const xOf = (id: string | undefined) => {
      const r = id ? (inputs.get(id) as Row | null) : null;
      const kept = r ? (JSON.parse(r.features).x as Record<string, number> | undefined) : undefined;
      const c = id && content ? content(id) : null;
      return c && Object.keys(c).length ? { ...kept, ...c } : kept;
    };
    return [...marked, ...this.implicit(now)].map((e) => ({ ...e, x: xOf(e.id) }));
  }

  private learnCandidate(now: number, marked?: Example[]) {
    try {
      const cx = this.candidateExamples(now, marked);
      this.state.candidate = train(cx, new Set(this.state.rejected));
      this.state.candidateFrom = { votes: cx.filter((e) => e.vote).length, implicit: cx.filter((e) => !e.vote).length };
    } catch (e) {
      console.error('triage: the shadow model could not learn', e);
    }
  }

  /** What the shadow model would have done lately, worked out at most every few minutes. */
  shadow(now = Date.now()): P.TriageShadowView {
    if (this.shadowCache && now - this.shadowCache.at < 5 * 60_000) return this.shadowCache.view;
    const view = shadowSummary(this.store.db, this.triage.thresholds().important, now);
    this.shadowCache = { at: now, view };
    return view;
  }

  /**
   * Chats a day the list would have held over the last week at each level: a chat counts once a day, when a message
   * outside the Conversation tier reached that importance. A week of decisions is a second or more to read on a busy
   * hub, so it is read in the background, a few hours of them at a time (`refreshPreview`), at most once an hour:
   * this answers with what was last worked out, and with nothing until the first time.
   */
  preview(now = Date.now()): P.TriagePolicyView['preview'] {
    if (!this.previewBusy && (!this.previewCache || now - this.previewCache.at >= PREVIEW_EVERY || now < this.previewCache.at)) {
      this.previewBusy = this.refreshPreview(now)
        // The hub stopping while it reads is not worth a line.
        .catch((e) => /closed/i.test(String(e)) || console.error('triage: the list preview could not be worked out', e))
        .finally(() => (this.previewBusy = null));
    }
    return this.previewCache?.rows ?? [];
  }
  private previewBusy: Promise<unknown> | null = null;

  /** Resolves once there is a preview to show: at once when one was worked out before, else when the first is. */
  async previewReady(now = Date.now()): Promise<void> {
    if (this.previewCache) return;
    this.preview(now);
    await this.previewBusy;
  }

  /** Work the preview out now, `stepHours` of decisions at a time with room for everything else between. */
  async refreshPreview(now = Date.now(), days = 7, stepHours = 6, pause: () => Promise<unknown> = () => new Promise((r) => setTimeout(r, 5))): Promise<P.TriagePolicyView['preview']> {
    const q = this.store.db.query(
      `SELECT m.conversation_id AS conv, CAST(t.created_at / ${DAY} AS INTEGER) AS day, MAX(t.score) AS score
       FROM triage t INDEXED BY triage_created JOIN message m ON m.id = t.message_id
       WHERE t.created_at > ? AND t.created_at <= ? AND t.decision IN ('digest', 'drop') AND t.score >= ?
       GROUP BY m.conversation_id, day`,
    );
    const best = new Map<string, number>();
    const step = stepHours * HOUR;
    for (let from = now - days * DAY; from < now; from += step) {
      for (const r of q.all(from, Math.min(now, from + step), LIST_LEVELS[0]) as Row[]) {
        const k = `${r.conv}|${r.day}`;
        if ((best.get(k) ?? 0) < r.score) best.set(k, r.score);
      }
      await pause();
    }
    const scores = [...best.values()];
    const rows = LIST_LEVELS.map((level) => ({ level, perDay: Math.round((scores.filter((s) => s >= level).length / days) * 10) / 10 }));
    this.previewCache = { at: now, rows };
    return rows;
  }

  /** Set the importance at which a message reaches the list. */
  setLevel(level: number) {
    this.store.setListLevel(Math.round(Math.min(0.99, Math.max(0.01, level)) * 100) / 100);
    this.shadowCache = null;
  }

  /** Forget a feature for good (it is never learned again), or let it be learned again. */
  forget(key: string, rejected: boolean, now = Date.now()) {
    const st = this.state;
    st.rejected = rejected ? [...new Set([...st.rejected, key])] : st.rejected.filter((k) => k !== key);
    this.learn(rejected ? 'you had it forget something' : 'you let something be learned again', now);
  }

  view(now = Date.now(), ex = this.examples(now)): P.TriagePolicyView {
    const n = this.namer();
    const m = this.state.model;
    const t = this.triage.thresholds();
    const bt = backtest(m, ex, t);
    const voted = ex.filter((e) => e.vote).map((e) => new Set(features(e.facts, e.words).map(([k]) => k)));
    return {
      factors: topWeights(m).map((w) => ({ key: w.feature, text: describe(w.feature, n), head: w.head, weight: w.weight, votes: voted.filter((s) => s.has(w.feature)).length })),
      rejected: this.state.rejected.map((key) => ({ key, text: describe(key, n) })),
      votes: bt.votes,
      errors: bt.errors,
      baseline: bt.baseline,
      thresholds: t,
      bars: { ...ALERT_BAR },
      preview: this.preview(now),
      learnedAt: this.state.learnedAt,
      lastReason: this.state.lastReason,
    };
  }

  private save() {
    this.store.setTriagePolicy(this.state);
    this.publish();
  }

  private publish() {
    this.triage.learned = this.state.model;
    this.triage.candidate = this.state.candidate ?? null;
    this.triage.namer ??= this.namer();
  }

  private otherName(kind: 'conversation' | 'space', id: string): string | null {
    for (const o of this.others) {
      const n = o.names?.[kind]?.(id);
      if (n) return n;
    }
    return null;
  }

  namer(): Namer {
    const s = this.store;
    return {
      conversation: (id) => {
        const c = s.one<Row>('SELECT * FROM conversation WHERE id = ?', id);
        if (!c) return this.otherName('conversation', id) ?? 'a conversation';
        return c.shape === 'direct' ? `your DM with ${this.triage.placeName(c)}` : this.triage.placeName(c);
      },
      space: (id) => s.one<Row>('SELECT name FROM space WHERE id = ?', id)?.name ?? this.otherName('space', id) ?? 'a server',
      person: (id) =>
        s.one<Row>('SELECT name FROM person WHERE id = ?', id)?.name ??
        s.one<Row>(`SELECT ${SHOWN} AS n FROM identity i WHERE id = ?`, id)?.n ??
        'someone',
      network: (id) => NETWORK_META[id as P.Network]?.name ?? id,
    };
  }
}

/**
 * Your votes on triage's decisions, and the model learned from them (learn.ts, docs/notifications.md). A vote moves a
 * decision up or down a level, or says it was right; after each one the model is fitted again to every vote (it takes
 * well under a second) and backtested. Once a day too, as votes age and decisions stand. The local model's prompt is
 * written again with it.
 *
 * Next to it, a candidate model learns from your votes and from what you did after each message (labels.ts), with
 * the interaction features kept with each decision (interact.ts, triage_input). It runs in shadow (shadow.ts): its
 * chances are kept with every decision, it never decides.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import {
  backtest,
  describe,
  emptyModel,
  isTier,
  STOOD,
  STOOD_PER_PLACE,
  THRESHOLDS,
  tierDown,
  tierUp,
  topWeights,
  train,
  voteWeight,
  words,
  features,
  writePrompt,
  type Example,
  type Facts,
  type Level,
  type Model,
  type Namer,
} from './learn.ts';
import type { Store } from './store.ts';
import type { Triage } from './triage.ts';
import { gatherOutcomes, implicitLabel } from './labels.ts';
import { shadowSummary } from './shadow.ts';

type Row = Record<string, any>;
const DAY = 86_400_000;

interface State {
  model: Model;
  /** Features you told it to forget. */
  rejected: string[];
  learnedAt: number | null;
  lastReason: string | null;
  prompt: string | null;
  /** The shadow model, and how many examples of each kind it learned from. */
  candidate?: Model | null;
  candidateFrom?: { votes: number; implicit: number } | null;
}

/** The candidate learns from what you did over this long. */
export const IMPLICIT_WINDOW = 14 * DAY;
/** What you did is read again at the daily refit, or after this long: a pass over two weeks of messages, a few seconds on a busy hub. */
const IMPLICIT_TTL = DAY;

export type Vote = 'up' | 'down' | Level | null;

export class TriageVotes {
  private state: State;
  private implicitCache: { at: number; examples: Example[] } | null = null;
  private shadowCache: { at: number; view: P.TriageShadowView } | null = null;

  constructor(
    private store: Store,
    private triage: Triage,
  ) {
    const saved = store.triagePolicy<Partial<State> & { rules?: unknown }>() ?? {};
    // The decision list that came before learns nothing the model would keep: it starts over from the votes.
    this.state = {
      model: saved.model ?? emptyModel(),
      rejected: saved.model ? (saved.rejected ?? []) : [],
      learnedAt: saved.model ? (saved.learnedAt ?? null) : null,
      lastReason: saved.lastReason ?? null,
      prompt: saved.prompt ?? null,
      candidate: saved.candidate ?? null,
      candidateFrom: saved.candidateFrom ?? null,
    };
    this.publish();
    if (!saved.model) this.learn('the decision model replaced the rules');
  }

  /** Every vote, and the newest decisions you let stand in each place. Facts missing on older votes are filled in. */
  examples(now = Date.now()): Example[] {
    const s = this.store;
    const out: Example[] = [];
    for (const r of s.raw<Row>(
      `SELECT t.message_id, t.decision, t.feedback, t.feedback_at, t.facts, m.body FROM triage t LEFT JOIN message m ON m.id = t.message_id
       WHERE t.feedback IS NOT NULL ORDER BY t.feedback_at DESC LIMIT 5000`,
    )) {
      let facts = r.facts ? (JSON.parse(r.facts) as Facts) : null;
      if (!facts && isTier(r.decision)) {
        facts = this.triage.factsFor(r.message_id, r.decision);
        if (facts) s.setTriageFacts(r.message_id, facts);
      }
      if (!facts) continue;
      out.push({ id: r.message_id, facts, words: words(r.body ?? ''), label: r.feedback, weight: voteWeight(r.feedback_at ?? now, now), vote: true, at: r.feedback_at ?? 0 });
    }
    // Only a notification you got and left alone says "that was fine": a digest entry or what fell below it
    // was likely never looked at.
    const stood = s.raw<Row>(
      `SELECT decision, facts, created_at FROM (
         SELECT t.decision, t.facts, t.created_at, ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY t.created_at DESC) AS n
         FROM triage t JOIN message m ON m.id = t.message_id
         WHERE t.feedback IS NULL AND t.facts IS NOT NULL AND t.decision IN ('push', 'quiet') AND t.created_at > ? AND t.created_at < ?)
       WHERE n <= ?`,
      now - 30 * DAY,
      now - DAY / 2,
      STOOD_PER_PLACE,
    );
    for (const r of stood) out.push({ facts: JSON.parse(r.facts), words: [], label: r.decision, weight: STOOD, vote: false, at: r.created_at });
    return out;
  }

  /**
   * Up or down a level from where it is now (your last vote, else the decision), or straight to a level; null takes
   * the vote back. Up on Important, or down below the digest, says it was right.
   */
  vote(messageId: string, v: Vote, now = Date.now()): { feedback: Level | null; policy: P.TriagePolicyView } {
    const s = this.store;
    const t = s.one<Row>('SELECT decision, feedback, facts FROM triage WHERE message_id = ?', messageId);
    if (!t) throw new Error('Triage never decided on this message');
    if (!isTier(t.decision)) throw new Error('This place is silenced: change its notification level instead');
    const now_ = (t.feedback ?? t.decision) as Level;
    const target = v === null ? null : v === 'up' ? tierUp(now_) : v === 'down' ? tierDown(now_) : v;
    if (target !== null && !isTier(target)) throw new Error('Unknown level');
    if (!t.facts) {
      const f = this.triage.factsFor(messageId, t.decision);
      if (f) s.setTriageFacts(messageId, f);
    }
    s.triageFeedback(messageId, target, now);
    const ex = this.examples(now);
    this.learn('a vote', now, ex);
    return { feedback: target, policy: this.view(now, ex) };
  }

  /** Once a day: votes age, decisions you let stand and what you did join in. */
  daily(now = Date.now()) {
    if (!this.state.learnedAt || now - this.state.learnedAt > DAY) this.learn('daily', now);
    else if (this.state.candidate == null) {
      // A hub from before the shadow model: it learns at the first tick, not a day later.
      this.learnCandidate(now, this.examples(now));
      this.save();
    }
  }

  learn(reason: string, now = Date.now(), ex = this.examples(now)) {
    const model = train(ex, new Set(this.state.rejected));
    const wrong = backtest(model, ex).wrong;
    this.state = { ...this.state, model, learnedAt: now, lastReason: reason, prompt: writePrompt(model, wrong, this.namer()) };
    // A vote refits on what you did as last read; the daily refit reads it again.
    this.learnCandidate(now, ex, reason === 'daily');
    this.save();
  }

  /**
   * What the candidate learns from: your votes, with the interaction features kept when each was decided, and what
   * you did after the messages of the last two weeks (labels.ts), the votes left out.
   */
  candidateExamples(now = Date.now(), ex = this.examples(now), fresh = false): Example[] {
    const s = this.store;
    const inputs = s.db.query('SELECT features FROM triage_input WHERE message_id = ?');
    const xOf = (id: string | undefined) => {
      const r = id ? (inputs.get(id) as Row | null) : null;
      return r ? (JSON.parse(r.features).x as Record<string, number> | undefined) : undefined;
    };
    const votes = ex.filter((e) => e.vote).map((e) => ({ ...e, x: xOf(e.id) }));
    if (fresh || !this.implicitCache || now - this.implicitCache.at > IMPLICIT_TTL || now < this.implicitCache.at) {
      const out: Example[] = [];
      const row = s.db.query('SELECT t.facts, t.feedback, m.body FROM triage t JOIN message m ON m.id = t.message_id WHERE t.message_id = ?');
      for (const o of gatherOutcomes(s.db, now - IMPLICIT_WINDOW, now, { now }).values()) {
        const l = implicitLabel(o);
        if (!l || l.knownAt > now) continue;
        const r = row.get(o.id) as Row | null;
        if (!r?.facts || r.feedback) continue;
        out.push({ id: o.id, facts: JSON.parse(r.facts), words: words(r.body ?? ''), y: l.y, x: xOf(o.id), weight: l.weight, vote: false, at: o.ts });
      }
      this.implicitCache = { at: now, examples: out };
    }
    return [...votes, ...this.implicitCache.examples];
  }

  private learnCandidate(now: number, ex: Example[], fresh = false) {
    try {
      const cx = this.candidateExamples(now, ex, fresh);
      this.state.candidate = train(cx, new Set(this.state.rejected));
      this.state.candidateFrom = { votes: cx.filter((e) => e.vote).length, implicit: cx.filter((e) => !e.vote).length };
    } catch (e) {
      console.error('triage: the shadow model could not learn', e);
    }
  }

  /** What the shadow model would have done lately, worked out at most every few minutes. */
  shadow(now = Date.now()): P.TriageShadowView {
    if (this.shadowCache && now - this.shadowCache.at < 5 * 60_000) return this.shadowCache.view;
    const view = shadowSummary(this.store.db, now);
    this.shadowCache = { at: now, view };
    return view;
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
    const bt = backtest(m, ex);
    const voted = ex.filter((e) => e.vote).map((e) => new Set(features(e.facts, e.words).map(([k]) => k)));
    return {
      factors: topWeights(m).map((t) => ({ key: t.feature, text: describe(t.feature, n), head: t.head, weight: t.weight, votes: voted.filter((s) => s.has(t.feature)).length })),
      rejected: this.state.rejected.map((key) => ({ key, text: describe(key, n) })),
      votes: bt.votes,
      errors: bt.errors,
      baseline: bt.baseline,
      thresholds: THRESHOLDS,
      learnedAt: this.state.learnedAt,
      lastReason: this.state.lastReason,
      prompt: this.state.prompt,
      model: this.triage.model?.name ?? null,
    };
  }

  private save() {
    this.store.setTriagePolicy(this.state);
    this.publish();
  }

  private publish() {
    this.triage.learned = this.state.model;
    this.triage.candidate = this.state.candidate ?? null;
    this.triage.prompt = this.state.prompt;
    this.triage.namer ??= this.namer();
  }

  namer(): Namer {
    const s = this.store;
    return {
      conversation: (id) => {
        const c = s.one<Row>('SELECT * FROM conversation WHERE id = ?', id);
        if (!c) return 'a conversation';
        return c.shape === 'direct' ? `your DM with ${this.triage.placeName(c)}` : this.triage.placeName(c);
      },
      space: (id) => s.one<Row>('SELECT name FROM space WHERE id = ?', id)?.name ?? 'a server',
      person: (id) =>
        s.one<Row>('SELECT name FROM person WHERE id = ?', id)?.name ??
        s.one<Row>('SELECT COALESCE(display_name, handle, native_id) AS n FROM identity WHERE id = ?', id)?.n ??
        'someone',
      network: (id) => NETWORK_META[id as P.Network]?.name ?? id,
    };
  }
}

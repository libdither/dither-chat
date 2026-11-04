/**
 * Your votes on triage's decisions, and the rules learned from them (learn.ts, docs/notifications.md). A vote moves a
 * decision up or down a level; after each one the rules are backtested against every vote, and learned again when
 * they get more than `RELEARN_ERROR` of them wrong. The local model's prompt is written again with them.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import {
  applyRules,
  backtest,
  describe,
  isTier,
  learn,
  RELEARN_ERROR,
  ruleKey,
  STOOD,
  STOOD_PER_PLACE,
  tierDown,
  tierUp,
  voteWeight,
  writePrompt,
  type Example,
  type Facts,
  type Level,
  type Namer,
  type Rule,
} from './learn.ts';
import type { Store } from './store.ts';
import type { Triage } from './triage.ts';

type Row = Record<string, any>;
const DAY = 86_400_000;

interface State {
  rules: Rule[];
  rejected: string[];
  learnedAt: number | null;
  lastReason: string | null;
  prompt: string | null;
}

export type Vote = 'up' | 'down' | Level | null;

export class TriageVotes {
  private state: State;

  constructor(
    private store: Store,
    private triage: Triage,
  ) {
    this.state = { rules: [], rejected: [], learnedAt: null, lastReason: null, prompt: null, ...(store.triagePolicy<State>() ?? {}) };
    this.publish();
  }

  /** Every vote, and the newest decisions you let stand in each place. Facts missing on older votes are filled in. */
  examples(now = Date.now()): Example[] {
    const s = this.store;
    const out: Example[] = [];
    for (const r of s.raw<Row>(`SELECT message_id, decision, feedback, feedback_at, facts FROM triage WHERE feedback IS NOT NULL ORDER BY feedback_at DESC LIMIT 5000`)) {
      let facts = r.facts ? (JSON.parse(r.facts) as Facts) : null;
      if (!facts && isTier(r.decision)) {
        facts = this.triage.factsFor(r.message_id, r.decision);
        if (facts) s.setTriageFacts(r.message_id, facts);
      }
      if (!facts) continue;
      out.push({ facts, label: r.feedback, weight: voteWeight(r.feedback_at ?? now, now), vote: true, at: r.feedback_at ?? 0 });
    }
    const stood = s.raw<Row>(
      `SELECT decision, facts, created_at FROM (
         SELECT t.decision, t.facts, t.created_at, ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY t.created_at DESC) AS n
         FROM triage t JOIN message m ON m.id = t.message_id
         WHERE t.feedback IS NULL AND t.facts IS NOT NULL AND t.decision IN ('push', 'quiet', 'digest') AND t.created_at > ? AND t.created_at < ?)
       WHERE n <= ?`,
      now - 30 * DAY,
      now - DAY / 2,
      STOOD_PER_PLACE,
    );
    for (const r of stood) out.push({ facts: JSON.parse(r.facts), label: r.decision, weight: STOOD, vote: false, at: r.created_at });
    return out;
  }

  /**
   * Up or down a level from where it is now (your last vote, else the decision), or straight to a level; null takes
   * the vote back. Up on Important, or down on Digest, says it was right.
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
    this.check(now, ex);
    return { feedback: target, policy: this.view(now, ex) };
  }

  /** Backtest; past the threshold, learn again. */
  check(now = Date.now(), ex = this.examples(now)) {
    const bt = backtest(this.state.rules, ex);
    if (bt.votes && bt.errors / bt.votes > RELEARN_ERROR) this.relearn(`${bt.errors} of ${bt.votes} votes wrong`, now, ex);
  }

  /** Once a day: votes age, and decisions you let stand join in. */
  daily(now = Date.now()) {
    if (!this.state.learnedAt || now - this.state.learnedAt > DAY) this.relearn('daily', now);
  }

  relearn(reason: string, now = Date.now(), ex = this.examples(now)) {
    const rejected = new Set(this.state.rejected);
    const kept = this.state.rules.filter((r) => r.pinned);
    const fresh = learn(ex, kept, rejected);
    // Keep whichever fits better; the new ones on a tie, since they count today's weights.
    const fit = (rules: Rule[]) => ex.reduce((n, e) => n + e.weight * Number(applyRules(rules, e.facts).level === e.label), 0);
    const old = this.state.rules.filter((r) => !rejected.has(ruleKey(r)));
    const rules = fit(fresh) >= fit(old) - 1e-9 ? fresh : old;
    const wrong = backtest(rules, ex).wrong;
    this.state = { ...this.state, rules, learnedAt: now, lastReason: reason, prompt: writePrompt(rules, wrong, this.namer()) };
    this.save();
  }

  /** Keep a rule through relearning, let it go again, or drop it for good (and undo that). */
  setRule(key: string, change: { pinned?: boolean; rejected?: boolean }, now = Date.now()) {
    const st = this.state;
    if (change.pinned !== undefined) st.rules = st.rules.map((r) => (ruleKey(r) === key ? { ...r, pinned: change.pinned || undefined } : r));
    if (change.rejected === true && !st.rejected.includes(key)) {
      st.rejected = [...st.rejected, key];
      st.rules = st.rules.filter((r) => ruleKey(r) !== key);
      this.relearn('you dropped a rule', now);
      return;
    }
    if (change.rejected === false) {
      st.rejected = st.rejected.filter((k) => k !== key);
      this.relearn('you let a rule back', now);
      return;
    }
    this.save();
  }

  view(now = Date.now(), ex = this.examples(now)): P.TriagePolicyView {
    const n = this.namer();
    const bt = backtest(this.state.rules, ex);
    return {
      rules: this.state.rules.map((r) => ({ key: ruleKey(r), text: describe(r.when, n), level: r.level, votes: r.votes, agree: r.agree, pinned: !!r.pinned })),
      rejected: this.state.rejected.map((key) => ({ key, text: describe(key.slice(0, key.lastIndexOf('>')).split('&'), n) })),
      votes: bt.votes,
      errors: bt.errors,
      baseline: bt.baseline,
      threshold: RELEARN_ERROR,
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
    this.triage.rules = this.state.rules;
    this.triage.prompt = this.state.prompt;
  }

  private namer(): Namer {
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

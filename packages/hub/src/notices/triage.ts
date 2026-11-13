/**
 * Triage of notices (docs/notices.md): the tier a notice lands in, from chat's model (learn.ts) and chat's marks.
 * Notices have no Conversation tier: an alert, a row on the list, below the list, or silent.
 *
 * In order:
 *   1. Its group (`ntg_`, a repository, an app) or its account muted by a rule of yours: silent.
 *   2. One of your keywords, or Always alert on the group or the account: an alert.
 *   3. Else its two chances, which start from the source's urgency and move with your marks:
 *        high    alert 0.7, importance 0.9
 *        normal  alert from the local model's answer (the stop-now question, held to ALERT_BAR.other), importance 0.6
 *        low     alert 0.01, importance 0.15 (the local model is not asked)
 *      An alert at even odds or more; else on the list at your level of importance or more; else below it. List only
 *      on the group or the account keeps it from alerting.
 *   4. Quiet hours hold an alert as a row on the list. What came by a catch-up, was read already or came in late is
 *      rated but notifies nobody.
 *
 * The start is kept in the facts (`Facts.start`), so learning from a mark starts where the decision did.
 */
import type * as P from '@dither-chat/protocol';
import { ALERT_BAR, describeWeight, importance, judgedAlert, learnedFrom, predict, TIER_NAME, UNJUDGED, words as wordsOf, type Facts, type Level, type Model, type Namer } from '../learn.ts';
import { inQuietHours } from '../triage.ts';

const MIN = 60_000;

export const NOTICE_TRIAGE = {
  /** A notice raised longer ago than this when it comes here notifies nobody (the hub was away). */
  freshMs: 60 * MIN,
  /** The local model reads at most this much of the title and body. */
  judgeChars: 500,
};

export type Urgency = P.NoticeUrgency;

/** Where the chances start, by the source's urgency; `judge`, the local model's answer, for a normal one. */
export function startOf(urgency: Urgency, judge?: number): P.TriageProbs {
  if (urgency === 'high') return { alert: 0.7, important: 0.9 };
  if (urgency === 'low') return { alert: 0.01, important: 0.15 };
  return { alert: judge === undefined ? UNJUDGED : round(judgedAlert(judge, ALERT_BAR.other)), important: 0.6 };
}

/** Reasons that are about you by name: a mention, a review asked of you, an assignment. */
export const ADDRESSED = new Set(['mention', 'team_mention', 'review_requested', 'assign']);

const SOURCES: Record<string, string> = { github: 'GitHub', telegram: 'Telegram', 'dither-accounts': 'dither-accounts' };
export const sourceName = (s: string) => SOURCES[s] ?? (s ? s[0].toUpperCase() + s.slice(1) : 'A service');

/** What a decision reads of a notice. */
export interface NoticeInput {
  group: string;
  account: string;
  source: string;
  title: string;
  body: string | null;
  url: string | null;
  reason: string | null;
  urgency: Urgency;
  actors: { name: string; url: string | null }[];
  at: number;
  unread: boolean;
}

/** The rule of yours that holds for it, the most specific first: its group, then its account. */
export interface NoticeRule {
  level: 'all' | 'digest' | 'none';
  /** "this group", "account GitHub": for the reason. */
  source: string;
}

export interface NoticeContext {
  model: Model;
  thresholds: P.TriageProbs;
  namer?: Namer | null;
  rule?: NoticeRule | null;
  /** One of your keywords it says. */
  keyword?: string | null;
  quietHours?: P.QuietHours | null;
  /** The local model's answer; absent when it was not asked or had none. */
  judge?: number;
  /** It was asked and did not answer in time. */
  unjudged?: boolean;
  /** Came by a catch-up (notify.list), not live: rated, never notifies. */
  catchUp?: boolean;
  now: number;
}

export interface NoticeDecision {
  decision: P.TriageDecision;
  importance: number | null;
  alert: number | null;
  reasons: string[];
  decidedBy: 'rules' | 'learned';
  facts: Facts | null;
  words: string[];
  /** Why it notifies nobody though rated to; null when it may. */
  hold: string | null;
  /** Quiet hours held its alert. */
  held: boolean;
}

/** Whether the local model is asked: a normal notice that no rule of yours decides. */
export const wantsJudge = (n: Pick<NoticeInput, 'urgency'>, c: Pick<NoticeContext, 'rule' | 'keyword' | 'catchUp'>) => n.urgency === 'normal' && !c.catchUp && !c.keyword && c.rule?.level !== 'none' && c.rule?.level !== 'all';

/** The text the local model reads and the model's words come from. */
export const textOf = (n: Pick<NoticeInput, 'title' | 'body'>) => `${n.title}${n.body ? `\n${n.body}` : ''}`;

/** learn.ts's facts, from a notice. */
export function factsOf(n: NoticeInput, judge?: number): Facts {
  const a = n.actors[0];
  return {
    network: `notice:${n.source}`,
    shape: 'notice',
    conversation: n.group,
    spaces: [n.account],
    author: a ? (a.url ?? a.name) : null,
    bot: false,
    mention: !!n.reason && ADDRESSED.has(n.reason),
    everyone: false,
    reply: false,
    question: false,
    urgent: n.urgency === 'high',
    active: false,
    media: false,
    link: !!n.url,
    base: 'drop',
    ...(judge !== undefined ? { judge } : {}),
    start: startOf(n.urgency, judge),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const round = (x: number) => Math.round(x * 1000) / 1000;

export function decideNotice(n: NoticeInput, c: NoticeContext): NoticeDecision {
  const src = sourceName(n.source);
  const said = `${src} says: ${n.reason ? n.reason.replace(/_/g, ' ') : 'a notice'} (${n.urgency})`;
  if (c.rule?.level === 'none') return { decision: 'silent', importance: null, alert: null, reasons: [`Silenced: ${c.rule.source}`, said], decidedBy: 'rules', facts: null, words: [], hold: null, held: false };
  const facts = factsOf(n, c.judge);
  const words = wordsOf(textOf(n));
  const p = predict(c.model, facts, words);
  const th = c.thresholds;
  const reasons = [said];
  let decision: Level;
  let decidedBy: NoticeDecision['decidedBy'] = 'rules';
  if (c.keyword) {
    decision = 'push';
    reasons.unshift(`Matches keyword “${c.keyword}”`);
  } else if (c.rule?.level === 'all') {
    decision = 'push';
    reasons.unshift(`Always alert: ${c.rule.source}`);
  } else {
    const cap = c.rule?.level === 'digest';
    const tierOf = (q: P.TriageProbs): Level => (!cap && q.alert >= th.alert ? 'push' : q.important >= th.important ? 'digest' : 'drop');
    decision = tierOf(p.probs);
    const before = tierOf(facts.start!);
    if (decision === 'push') {
      const bar = ALERT_BAR.other;
      reasons.unshift(
        before !== 'push'
          ? 'Your marks made it an alert'
          : c.judge !== undefined
            ? `Reads as urgent: the local model's answer is ${c.judge} against a bar of ${bar}`
            : n.urgency === 'high'
              ? `${src} says it is urgent`
              : 'An alert',
      );
    } else if (decision === 'digest') reasons.unshift(`On the list: importance ${pct(p.probs.important)}, at or over your level of ${pct(th.important)}`);
    else reasons.unshift(`Below the list: importance ${pct(p.probs.important)}, under your level of ${pct(th.important)}`);
    if (cap) reasons.push(`List only: ${c.rule!.source}`);
    if (c.unjudged) reasons.push('The local model did not answer in time: not read for urgency');
    if (decision !== before) {
      const head = decision === 'push' || before === 'push' ? 'alert' : 'important';
      const why = c.namer
        ? p.why
            .filter((w) => w.head === head)
            .slice(0, 2)
            .map((w) => describeWeight(w.feature, w.head, w.by, c.namer!))
        : [];
      reasons.unshift(`${TIER_NAME[decision]}, ${learnedFrom(decision, before)} (was ${TIER_NAME[before]})`, ...why);
      decidedBy = 'learned';
    }
  }
  let held = false;
  let out: P.TriageDecision = decision;
  if (decision === 'push' && !c.catchUp && inQuietHours(c.quietHours ?? null, c.now)) {
    out = 'digest';
    held = true;
    reasons.unshift(`Held by quiet hours until ${c.quietHours!.end}`);
  }
  let hold: string | null = null;
  if (out === 'push' || out === 'digest') {
    if (c.catchUp) hold = 'Came by a catch-up: no notification';
    else if (!n.unread) hold = 'Already read: no notification';
    else if (c.now - n.at > NOTICE_TRIAGE.freshMs) hold = 'Came in late: no notification';
    if (hold) reasons.push(hold);
  }
  return { decision: out, importance: importance(p.probs), alert: round(p.probs.alert), reasons, decidedBy, facts, words, hold, held };
}

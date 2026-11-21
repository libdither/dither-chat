/**
 * The scorecard (docs/scorecard.md): how well the notification and inbox models did, day by day, scored by the hub
 * once each day's outcomes are in (hub scorecard.ts). One list of metrics for the hub, the script and the page.
 * Imported as `@dither-chat/protocol/scorecard`, not from the index, so the web's startup chunk does not carry it: only
 * the scorecard's own chunk does.
 */

/** How a metric's value reads. */
export type ScoreKind = 'share' | 'count' | 'rank' | 'auc' | 'brier';

export interface ScoreMetric {
  key: string;
  /** In a chart's legend and tooltip. */
  label: string;
  kind: ScoreKind;
  /** Higher is better; false: lower is; null: neither (a count to watch). */
  better: boolean | null;
}

export interface ScoreChart {
  id: string;
  title: string;
  /** One plain sentence: what the lines say. */
  about: string;
  /** Its lines; all of one kind, so the chart has one y-axis. */
  metrics: ScoreMetric[];
}

/** The charts, in the page's order. A metric's key is what the hub stores in `model_score.metric`. */
export const SCORE_CHARTS: ScoreChart[] = [
  {
    id: 'notified',
    title: 'Notifications you followed',
    about: 'Of the notifications that reached your phone that day, the share after which you opened that chat (for 5 seconds or more) within 3 hours.',
    metrics: [
      { key: 'alert.opened', label: 'Alerts', kind: 'share', better: true },
      { key: 'conversation.opened', label: 'Conversations', kind: 'share', better: true },
      { key: 'list.opened', label: 'List', kind: 'share', better: true },
    ],
  },
  {
    id: 'importance',
    title: 'Importance against what you opened',
    about: 'For each chat with messages that day outside Conversations, whether its importance put the ones you opened within a day above the rest. 1 is perfect, 0.5 a coin toss.',
    metrics: [
      { key: 'importance.auc', label: 'What it learned', kind: 'auc', better: true },
      { key: 'importance.auc_start', label: 'Learning nothing', kind: 'auc', better: true },
      { key: 'importance.auc_candidate', label: 'Candidate model', kind: 'auc', better: true },
    ],
  },
  {
    id: 'importance-top',
    title: 'Opened chats near the top',
    about: 'The same chats sorted by importance: how near the top the ones you opened were (average precision). 1 is all of them first.',
    metrics: [
      { key: 'importance.ap', label: 'What it learned', kind: 'auc', better: true },
      { key: 'importance.ap_start', label: 'Learning nothing', kind: 'auc', better: true },
      { key: 'importance.ap_candidate', label: 'Candidate model', kind: 'auc', better: true },
    ],
  },
  {
    id: 'alert',
    title: 'Alert chance against quick answers',
    about: 'For Conversation messages the local model read, whether the alert chance put the ones you answered within 3 hours above the rest.',
    metrics: [
      { key: 'alert.auc', label: 'What it learned', kind: 'auc', better: true },
      { key: 'alert.auc_start', label: 'Learning nothing', kind: 'auc', better: true },
      { key: 'alert.auc_candidate', label: 'Candidate model', kind: 'auc', better: true },
    ],
  },
  {
    id: 'marks',
    title: 'Your alert marks',
    about: 'Marks on that day’s messages: alerts you said were wrong, and messages you said should have alerted.',
    metrics: [
      { key: 'marks.alert_wrong', label: 'Alert was wrong', kind: 'count', better: false },
      { key: 'marks.should_alert', label: 'Should have alerted', kind: 'count', better: false },
    ],
  },
  {
    id: 'unprompted',
    title: 'Chats you went to by yourself',
    about: 'Chats you opened with no notification about them in the day before, and the share of those the list held.',
    metrics: [{ key: 'unprompted.list', label: 'Held by the list', kind: 'share', better: true }],
  },
  {
    id: 'inbox',
    title: 'Inbox order',
    about: 'For chats opened from the inbox: the share that were in its first 8 rows, and the share found below row 20.',
    metrics: [
      { key: 'inbox.top8', label: 'In the first 8 rows', kind: 'share', better: true },
      { key: 'inbox.deep', label: 'Below row 20', kind: 'share', better: false },
    ],
  },
  {
    id: 'inbox-mrr',
    title: 'How high up the chats you opened were',
    about: 'The mean of 1 ÷ row for chats opened from the inbox: 1 is always the top row, 0.5 typically the second.',
    metrics: [{ key: 'inbox.mrr', label: 'Mean 1 ÷ row', kind: 'rank', better: true }],
  },
  {
    id: 'inbox-mail',
    title: 'Mail in the inbox: the order now against the order with mail',
    about: 'For rows opened from the inbox while the order with mail runs in shadow: the mean of 1 ÷ row as they stood, and as they would have stood in that order; then the same for mail rows alone.',
    metrics: [
      { key: 'inbox.mrr_live', label: 'All rows, as shown', kind: 'rank', better: true },
      { key: 'inbox.mrr_shadow', label: 'All rows, order with mail', kind: 'rank', better: true },
      { key: 'inbox.mail_mrr', label: 'Mail rows, as shown', kind: 'rank', better: true },
      { key: 'inbox.mail_mrr_shadow', label: 'Mail rows, order with mail', kind: 'rank', better: true },
    ],
  },
  {
    id: 'needs-reply',
    title: 'Needs a reply: shown against answered',
    about: 'For owed replies whose three days ended that day: the mean chance shown that they needed a reply, and the share you answered. Close together is well calibrated.',
    metrics: [
      { key: 'needs.predicted', label: 'Chance shown', kind: 'share', better: null },
      { key: 'needs.answered', label: 'Answered', kind: 'share', better: null },
    ],
  },
  {
    id: 'needs-reply-brier',
    title: 'Needs a reply: how far off',
    about: 'The same replies: the Brier score of the chance shown, and of the reply table alone. 0 is perfect, 0.25 a coin toss.',
    metrics: [
      { key: 'needs.brier', label: 'Chance shown', kind: 'brier', better: false },
      { key: 'needs.brier_table', label: 'Reply table alone', kind: 'brier', better: false },
    ],
  },
  {
    id: 'foryou',
    title: 'For you: items you opened',
    about: 'Of the For you items that were on your screen that day, the share you opened; and the same for the items it was trying out (exploration), which no order chose.',
    metrics: [
      { key: 'foryou.clicked', label: 'All items shown', kind: 'share', better: true },
      { key: 'foryou.clicked_explore', label: 'Items it was trying', kind: 'share', better: true },
    ],
  },
];

/** Every metric, in chart order. */
export const SCORE_METRICS: ScoreMetric[] = SCORE_CHARTS.flatMap((c) => c.metrics);

/** `GET /api/model/scores?days=`: the scored days, oldest first, and each metric's value and count on each. */
export interface ModelScoresView {
  /** Local days, YYYY-MM-DD, oldest first. */
  days: string[];
  /** By metric key: one entry per day, `v` null where the day had nothing to score. */
  metrics: Record<string, { v: (number | null)[]; n: number[] }>;
  /** The newest day still waiting for its outcomes (scored once a day after it ends), or null. */
  pending: string | null;
}

/** A metric over some days together: weighted by each day's count, but a count's days are simply averaged. */
export interface ScoreSpan {
  value: number | null;
  /** How many it is of, all days together. */
  n: number;
  /** Days with a value. */
  days: number;
}

/** A metric over the days at indices [from, to) of a view. */
export function scoreSpan(view: ModelScoresView, metric: ScoreMetric, from: number, to: number): ScoreSpan {
  const s = view.metrics[metric.key];
  let sum = 0;
  let weight = 0;
  let n = 0;
  let days = 0;
  for (let i = Math.max(0, from); i < Math.min(to, view.days.length); i++) {
    const v = s?.v[i];
    if (v === null || v === undefined) continue;
    const w = metric.kind === 'count' ? 1 : s.n[i];
    if (!w) continue;
    sum += v * w;
    weight += w;
    n += s.n[i];
    days++;
  }
  return { value: weight ? sum / weight : null, n, days };
}

/** A metric's last `k` days against the `k` before them. */
export function scoreTrend(view: ModelScoresView, metric: ScoreMetric, k = 7): { recent: ScoreSpan; before: ScoreSpan } {
  const end = view.days.length;
  return { recent: scoreSpan(view, metric, end - k, end), before: scoreSpan(view, metric, end - 2 * k, end - k) };
}

/** A value as the page and the script print it: a share as a percent, an AUC or a rank to two places, a count whole. */
export function formatScore(kind: ScoreKind, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '–';
  if (kind === 'share') return `${Math.round(v * 100)}%`;
  if (kind === 'count') return Number.isInteger(v) ? String(v) : v.toFixed(1);
  if (kind === 'brier') return v.toFixed(3);
  return v.toFixed(2);
}

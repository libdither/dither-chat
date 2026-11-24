/**
 * The scorecard (docs/scorecard.md): how well the notification and inbox models did, day by day, scored by the hub
 * once each day's outcomes are in (hub scorecard.ts). One list of metrics for the hub, the script and the page.
 * Imported as `@dither-chat/protocol/scorecard`, not from the index, so the web's startup chunk does not carry it: only
 * the scorecard's own chunk does.
 */

/** How a metric's value reads. */
/** `hours`: a time in hours, read as minutes under one. */
export type ScoreKind = 'share' | 'count' | 'rank' | 'auc' | 'brier' | 'hours';

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
  // The cost side (docs/scorecard.md, "The cost side"): what notifications took, and the people waiting on you.
  {
    id: 'attn-sounds',
    title: 'Sounds a day',
    about: 'Notifications that sounded on a device that day: an alert starting a burst, a ring, quiet hours’ summary.',
    metrics: [{ key: 'attn.sounds', label: 'Sounds', kind: 'count', better: false }],
  },
  {
    id: 'attn-sounds-computer',
    title: 'Sounds per hour at a computer',
    about: 'Sounds in the hours a computer was in use, over those hours: a sound there interrupts work.',
    metrics: [{ key: 'attn.sounds_computer_hour', label: 'Sounds an hour', kind: 'count', better: false }],
  },
  {
    id: 'attn-stale',
    title: 'Pushes to a chat already being read',
    about: 'Of the notifications sent to a device, the share sent while that chat was open on a computer and read past the message there.',
    metrics: [{ key: 'attn.stale', label: 'Already read on a computer', kind: 'share', better: false }],
  },
  {
    id: 'attn-checks',
    title: 'Looks that found nothing',
    about: 'Opens of the app with nothing new on the list or above since the last look, and notifications you tapped or swiped away after reading their chat on a computer.',
    metrics: [
      { key: 'attn.checks', label: 'Opened with nothing new', kind: 'count', better: false },
      { key: 'attn.stale_shown', label: 'Still up after reading', kind: 'count', better: false },
    ],
  },
  {
    id: 'people-wait',
    title: 'How long people wait for your reply',
    about: 'For the replies you gave people that day (DMs and small groups), how long after they wrote to you: the median, and 9 in 10 within.',
    metrics: [
      { key: 'people.wait', label: 'Median', kind: 'hours', better: false },
      { key: 'people.wait_p90', label: '90th percentile', kind: 'hours', better: false },
    ],
  },
  {
    id: 'people-owed',
    title: 'Replies owed for over 3 days',
    about: 'At the end of each day, the people (DMs and small groups) who had waited on a reply from you for more than 3 days.',
    metrics: [{ key: 'people.owed_3d', label: 'Owed over 3 days', kind: 'count', better: false }],
  },
  {
    id: 'people-breadth',
    title: 'Who you talk with',
    about: 'How many people you wrote to in the 30 days to each day, against the 30 days before them. Steady is good.',
    metrics: [
      { key: 'people.breadth', label: 'Last 30 days', kind: 'count', better: null },
      { key: 'people.breadth_before', label: 'The 30 before', kind: 'count', better: null },
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

/** A value as the page and the script print it: a share as a percent, an AUC or a rank to two places, a count whole, hours as hours or minutes. */
export function formatScore(kind: ScoreKind, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '–';
  if (kind === 'share') return `${Math.round(v * 100)}%`;
  if (kind === 'count') return Number.isInteger(v) ? String(v) : v.toFixed(1);
  if (kind === 'brier') return v.toFixed(3);
  if (kind === 'hours') return v < 1 ? `${Math.round(v * 60)} min` : `${v < 10 ? v.toFixed(1) : Math.round(v)} h`;
  return v.toFixed(2);
}

/**
 * `GET /api/attention/report`: the weekly report of what attention cost (docs/scorecard.md, "The weekly report").
 * Counts and times from the scorecard's days, the replies owed now, and at most one person drifting away. Ids only for
 * the app to name from what it already holds; no budget, no names, no text.
 */
export interface AttentionReport {
  /** The last 14 scored days, oldest first, and the newest still waiting for its outcomes. */
  days: string[];
  pending: string | null;
  /** Sounds on each of `days` (null: not scored), and per hour a computer was in use. */
  sounds: (number | null)[];
  soundsComputerHour: (number | null)[];
  /** The last 7 days against the 7 before. Sounds a day and stale shares are means; checks are totals. */
  week: {
    sounds: Pair;
    stale: Pair;
    checks: Pair;
    staleShown: Pair;
    /** Hours: the median and the 90th percentile, weighted by the replies of each day. */
    wait: Pair;
    waitP90: Pair;
    owed3d: Pair;
    /** People you wrote to in the 30 days to the last scored day, and the 30 before. */
    breadth: { recent: number | null; before: number | null };
  };
  /** Replies owed to people now, longest waiting first (at most 8 of `total`). */
  waiting: { conversationId: string; since: number; needs: number | null }[];
  waitingTotal: number;
  /**
   * At most one person a week you used to talk with and have not in 4 weeks or more: someone you wrote to in several
   * weeks of the 12 before. Chosen once a week (from the week's Monday), never notified.
   */
  drifting: { personId: string | null; identityId: string; conversationId: string | null; lastAt: number; weeks: number } | null;
}

/** A value over the last 7 days, and over the 7 before. */
export interface Pair {
  recent: number | null;
  before: number | null;
}

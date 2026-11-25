/**
 * The loudness scale's side of the page (docs/notifications.md): your answers about a message (Louder / Quieter on
 * its bell, a question on the Notification calibration page, a notification's action), the one optional why after some of them,
 * the settings, and what it learned. The hub keeps it all (loudlearn.ts); this holds what is shown.
 */
import { computed, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { api, inbox, patchMessage, toast } from './state.ts';
import { loadPolicy } from './triage.ts';

/** The mode, settings and what it learned, as of the last look (GET /api/loudness/state). */
export const attnState = signal<P.AttentionStateView | null>(null);
/** How many questions wait on the Notification calibration page: its row's count in the inbox. */
export const checkinCount = signal(0);
/** The questions on the page, with where you came across each; null until it opens. */
export const checkins = signal<P.CheckinView[] | null>(null);
/** The numbers at the top of the page. */
export const calibration = signal<P.CalibrationStats | null>(null);
/** The follow-up being asked: after Quieter, Could have waited or Shouldn't have reached me, or after Louder. */
export const whyAsk = signal<{ answerId: string; side: 'quieter' | 'louder' } | null>(null);

export async function loadAttention() {
  try {
    attnState.value = await api<P.AttentionStateView>('/api/loudness/state');
  } catch {}
}

/** How many questions wait. Also a look: the hub lets go of the next look's bundle. */
export async function loadCheckinCount() {
  try {
    checkinCount.value = (await api<{ pending: number }>('/api/loudness/checkins/count')).pending;
  } catch {}
}

/** The page's questions and numbers. */
export async function loadCheckins() {
  try {
    const [list, stats] = await Promise.all([api<P.CheckinView[]>('/api/loudness/checkins'), api<P.CalibrationStats>('/api/loudness/calibration')]);
    checkins.value = list;
    checkinCount.value = list.length;
    calibration.value = stats;
  } catch (e) {
    if (!checkins.value) checkins.value = [];
    failed('Could not load the questions')(e as Error);
  }
}

const failed = (title: string) => (e: Error) => toast({ kind: 'error', title, body: e.message });

/** The marks Louder / Quieter stand as (the hub keeps the same: loudlearn.ts `answer`). */
function markOf(answer: 'louder' | 'quieter', t: Pick<P.TriageView, 'decision' | 'marks'>): P.TriageMarks {
  if (answer === 'louder') return { ...t.marks, alert: true };
  return t.decision === 'push' ? { ...t.marks, alert: false } : { ...t.marks, less: true };
}

/** Whether a message's bell shows Louder or Quieter as said, from its marks. */
export function saidOf(t: Pick<P.TriageView, 'decision' | 'marks'> | null | undefined): 'louder' | 'quieter' | null {
  if (!t?.marks) return null;
  if (t.marks.alert === true) return 'louder';
  if (t.marks.alert === false || t.marks.less) return 'quieter';
  return null;
}

function showMarks(id: string, marks: P.TriageMarks) {
  const patch = (m: P.MessageView): P.MessageView => (m.triage ? { ...m, triage: { ...m.triage, marks } } : m);
  inbox.value = inbox.value.map((m) => (m.id === id ? patch(m) : m));
  patchMessage(id, patch);
}

/**
 * An answer about a message. Louder / Quieter show at once on the message's bell. When the hub says to ask why
 * (at most one a chat a day, never the same twice in a row), the follow-up opens.
 */
export async function answer(m: { id: string; triage?: P.TriageView | null }, a: P.AttnAnswer, source: P.AttnSource, scope?: 'person' | 'chat', checkinId?: string): Promise<P.AttnAnswerResult | null> {
  const t = m.triage;
  const before = t?.marks ?? {};
  if (t && (a === 'louder' || a === 'quieter') && t.decision !== 'silent') showMarks(m.id, markOf(a, t));
  try {
    const r = await api<P.AttnAnswerResult>('/api/loudness/answers', { body: { messageId: m.id, answer: a, source, ...(scope ? { scope } : {}), ...(checkinId ? { checkinId } : {}) } });
    if (r?.why) whyAsk.value = { answerId: r.answerId, side: r.why };
    // Louder / Quieter stand as marks: what the tiers learned from them, for How it sorts.
    if (a === 'louder' || a === 'quieter') void loadPolicy();
    return r;
  } catch (e) {
    if (t) showMarks(m.id, before);
    failed('Could not send that')(e as Error);
    return null;
  }
}

/** The why, as a chip, a wait, or your words (read by the local model only, and not kept). */
export async function sendWhy(b: P.WhyBody): Promise<P.WhyResult | null> {
  whyAsk.value = null;
  try {
    return await api<P.WhyResult>('/api/loudness/why', { body: b });
  } catch (e) {
    failed('Could not send that')(e as Error);
    return null;
  }
}

/** A check-in answered, or skipped (null). */
export async function answerCheckin(c: Pick<P.CheckinView, 'id'>, a: string | null) {
  if (checkins.value) checkins.value = checkins.value.filter((x) => x.id !== c.id);
  checkinCount.value = Math.max(0, checkinCount.value - 1);
  try {
    const r = await api<P.AttnAnswerResult | { ok: true }>(`/api/loudness/checkins/${c.id}`, { body: a === null ? { skip: true } : { answer: a } });
    if (r && 'why' in r && r.why) whyAsk.value = { answerId: r.answerId, side: r.why };
  } catch (e) {
    failed('Could not send that')(e as Error);
  }
}

/** "Ask me less": halves how many it asks from now on; what already waits stays. */
export async function askLess() {
  try {
    attnState.value = await api<P.AttentionStateView>('/api/loudness/ask-less', { body: {} });
  } catch (e) {
    failed('Could not save that')(e as Error);
  }
}

export async function setAttentionPrefs(patch: Partial<P.AttentionPrefs>) {
  const s = attnState.value;
  if (s) attnState.value = { ...s, prefs: { ...s.prefs, ...patch } };
  try {
    attnState.value = await api<P.AttentionStateView>('/api/loudness/prefs', { method: 'PUT', body: patch });
  } catch (e) {
    failed('Could not save that')(e as Error);
    void loadAttention();
  }
}

/** Forget something it learned, for good; or let it be learned again. */
export async function forgetLearned(key: string, rejected: boolean) {
  try {
    attnState.value = await api<P.AttentionStateView>('/api/loudness/forget', { body: { key, rejected } });
  } catch (e) {
    failed('Could not forget that')(e as Error);
  }
}

/** A message's loudness, whole, for its Why sheet; null where it has none (a message from before the scale). */
export async function fetchLoudness(messageId: string): Promise<P.LoudView | null> {
  try {
    return await api<P.LoudView | null>(`/api/messages/${messageId}/loudness`);
  } catch {
    return null;
  }
}

/**
 * How loud each conversation's latest message on the inbox was (TriageView.loudness), for the inbox's loudness edge
 * (docs/inbox.md). Only messages the page holds with their triage: the rest draw no edge.
 */
export const loudByConv = computed(() => {
  const out = new Map<string, { ts: number; loud: number }>();
  for (const m of inbox.value) {
    const l = m.triage?.loudness;
    if (typeof l !== 'number') continue;
    const had = out.get(m.conversationId);
    if (!had || had.ts < m.ts) out.set(m.conversationId, { ts: m.ts, loud: l });
  }
  return out;
});

/** A row's loudness: the loudest of its conversations' latest. */
export function loudOf(louds: Map<string, { loud: number }>, ids: string[]): number | undefined {
  let best: number | undefined;
  for (const id of ids) {
    const l = louds.get(id)?.loud;
    if (l !== undefined && (best === undefined || l > best)) best = l;
  }
  return best;
}

/** The edge's attributes on a row: none below the inbox band (it would say nothing). */
export function loudEdge(loud: number | undefined): Record<string, unknown> {
  if (loud === undefined || loud < 30) return {};
  return { 'data-loud': Math.round(loud), style: `--loud-mix: ${Math.round(20 + loud * 0.8)}%` };
}

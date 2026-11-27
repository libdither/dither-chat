/**
 * The loudness scale's side of the page (docs/notifications.md): your answers about a message (Louder / Quieter on
 * its bell, Sound / Show / Inbox on the calibration feed, a notification's action), the one optional why after some
 * of them, the settings, and what it learned. The hub keeps it all (loudlearn.ts); this holds what is shown.
 */
import { computed, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { api, inbox, patchMessage, toast } from './state.ts';
import { loadPolicy } from './triage.ts';

/** The mode, settings and what it learned, as of the last look (GET /api/loudness/state). */
export const attnState = signal<P.AttentionStateView | null>(null);
/** How many cards and past answers wait on the calibration feed: its row's count in the inbox. */
export const checkinCount = signal(0);
/** The calibration feed (GET /api/loudness/feed); null until it opens. */
export const calFeed = signal<P.CalFeedView | null>(null);
/** The follow-up being asked: after Quieter, Could have waited or Shouldn't have reached me, or after Louder. */
export const whyAsk = signal<{ answerId: string; side: 'quieter' | 'louder' } | null>(null);

export async function loadAttention() {
  try {
    attnState.value = await api<P.AttentionStateView>('/api/loudness/state');
  } catch {}
}

/** How many cards and past answers wait on the feed. */
export async function loadCheckinCount() {
  try {
    checkinCount.value = (await api<{ pending: number }>('/api/loudness/feed/count')).pending;
  } catch {}
}

/** The feed's cards, rows and the sure ones. */
export async function loadFeed() {
  try {
    const v = await api<P.CalFeedView>('/api/loudness/feed');
    calFeed.value = v;
    checkinCount.value = v.items.filter((i) => (i.kind === 'card' && !i.answer) || i.kind === 'past').length;
  } catch (e) {
    if (!calFeed.value) calFeed.value = { items: [], sure: [] };
    failed('Could not load the feed')(e as Error);
  }
}

const countDown = (it: P.CalItem) => {
  if (it.kind === 'card' || it.kind === 'past') checkinCount.value = Math.max(0, checkinCount.value - 1);
};

/** Sound / Show / Inbox on a feed item: the chances before and after it was learned. */
export async function answerFeed(it: P.CalItem, a: P.CalAnswer): Promise<P.CalAnswerResult | null> {
  try {
    const r = await api<P.CalAnswerResult>(`/api/loudness/feed/${it.id}`, { body: { answer: a } });
    if (!it.answer) countDown(it);
    return r;
  } catch (e) {
    failed('Could not send that')(e as Error);
    return null;
  }
}

/** "What was it wrong about?": the parts the answer moves; the chances after. */
export async function feedParts(it: P.CalItem, parts: P.CalPart[]): Promise<P.Trio | null> {
  try {
    return (await api<P.CalPartsResult>(`/api/loudness/feed/${it.id}/parts`, { body: { parts } })).after;
  } catch (e) {
    failed('Could not send that')(e as Error);
    return null;
  }
}

/** A past answer: Keep, Only that once, Undo. */
export async function settleFeed(it: P.CalItem, how: P.CalSettle) {
  try {
    await api(`/api/loudness/feed/${it.id}/settle`, { body: { settle: how } });
    countDown(it);
  } catch (e) {
    failed('Could not send that')(e as Error);
  }
}

/** Skip one, or take the skip back. */
export async function skipFeed(it: P.CalItem, skip: boolean) {
  if (skip) countDown(it);
  else if (it.kind === 'card' || it.kind === 'past') checkinCount.value++;
  try {
    await api(`/api/loudness/feed/${it.id}/skip`, { body: { skip } });
  } catch (e) {
    failed('Could not send that')(e as Error);
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
export async function answer(m: { id: string; triage?: P.TriageView | null }, a: P.AttnAnswer, source: P.AttnSource, scope?: 'person' | 'chat'): Promise<P.AttnAnswerResult | null> {
  const t = m.triage;
  const before = t?.marks ?? {};
  if (t && (a === 'louder' || a === 'quieter') && t.decision !== 'silent') showMarks(m.id, markOf(a, t));
  try {
    const r = await api<P.AttnAnswerResult>('/api/loudness/answers', { body: { messageId: m.id, answer: a, source, ...(scope ? { scope } : {}) } });
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

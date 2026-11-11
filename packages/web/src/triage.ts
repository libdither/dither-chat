/**
 * Marking triage's decisions (docs/notifications.md, marks.ts): "Should have alerted", "Alert was wrong" and "Less
 * like this", on a chat message or a mail message. The hub's models learn from the marks; this keeps what it says it
 * learned, the bars alerts start at, and the level of the phone's list.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { isMailId, sendMark, type Markable } from './marks.ts';
import { api, inbox, mailTriage, patchMessage, toast } from './state.ts';
import { details } from './mail/held.ts';
import { changed, mailChanged } from './versions.ts';

export type { Markable };

/** What the hub learned, as of the last mark or look. */
export const triagePolicy = signal<P.TriagePolicyView | null>(null);

/** The marks on every copy of a message the page holds: the inbox's, the timelines', mail's board and reader. */
function setMarks(id: string, marks: P.TriageMarks) {
  const put = (t: P.TriageView): P.TriageView => ({ ...t, marks });
  if (isMailId(id)) {
    mailTriage.value = mailTriage.value.map((m) => (m.id === id ? { ...m, triage: put(m.triage) } : m));
    // The reader's copy of the message too.
    for (const d of details.values()) {
      const i = d.messages.findIndex((m) => m.id === id);
      if (i >= 0 && d.messages[i].triage) d.messages[i] = { ...d.messages[i], triage: put(d.messages[i].triage!) };
    }
    changed('list');
    mailChanged();
    return;
  }
  const patch = (m: P.MessageView): P.MessageView => (m.triage ? { ...m, triage: put(m.triage) } : m);
  inbox.value = inbox.value.map((m) => (m.id === id ? patch(m) : m));
  patchMessage(id, patch);
}

/** Mark a decision, or take a mark back (marks.ts `sendMark`): shown at once, and put back if the hub refuses. */
export const mark = (m: Markable, change: P.TriageMarks) =>
  sendMark(m, change, {
    post: (path, body) => api(path, { body }),
    apply: setMarks,
    learned: (p) => (triagePolicy.value = p),
    failed: (e) => toast({ kind: 'error', title: 'Could not mark it', body: e.message }),
  });

export async function loadPolicy() {
  try {
    triagePolicy.value = await api<P.TriagePolicyView>('/api/triage/policy');
  } catch {}
}

/** The importance a message needs to reach the phone's list, 0 to 1. */
export async function setListLevel(level: number) {
  triagePolicy.value = await api<P.TriagePolicyView>('/api/triage/level', { method: 'PUT', body: { level } });
}

/** Forget something it learned, for good; or let it be learned again. */
export async function forgetFactor(key: string, rejected: boolean) {
  triagePolicy.value = await api<P.TriagePolicyView>(`/api/triage/factors/${encodeURIComponent(key)}`, { body: { rejected } });
}

/** What the candidate model, running in shadow, would have put on the list lately. */
export const triageShadow = signal<P.TriageShadowView | null>(null);

export async function loadShadow() {
  try {
    triageShadow.value = await api<P.TriageShadowView>('/api/triage/shadow');
  } catch {}
}

export async function relearn() {
  triagePolicy.value = await api<P.TriagePolicyView>('/api/triage/policy/relearn', { body: {} });
}

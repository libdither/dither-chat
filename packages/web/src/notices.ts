/**
 * Notices (docs/notices.md): what your accounts and services told you, as the hub keeps them (GET /api/notices). The
 * page and the inbox's row read `noticesPage`; it is fetched when a hub with notices boots, when one is notified, and
 * when Notices opens.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { api, eventHooks, noticesBoot } from './state.ts';

export const noticesPage = signal<P.NoticesPage | null>(null);

let loading: Promise<void> | null = null;
let again = false;

/** Fetch the list again (once at a time; asked meanwhile, once more after). */
export function loadNotices(): Promise<void> {
  if (loading) {
    again = true;
    return loading;
  }
  loading = api<P.NoticesPage>('/api/notices')
    .then((p) => void (noticesPage.value = p))
    .catch(() => {})
    .finally(() => {
      loading = null;
      if (again) {
        again = false;
        void loadNotices();
      }
    });
  return loading;
}

/** New notices come with a notification; quieter ones are seen when the list is next fetched. */
eventHooks.add((ev) => {
  if (ev.t === 'notify' && ev.noticeId && noticesBoot.value) void loadNotices();
});

function patch(id: string, f: (n: P.NoticeView) => P.NoticeView) {
  const p = noticesPage.value;
  if (p) noticesPage.value = { ...p, items: p.items.map((n) => (n.id === id ? f(n) : n)) };
}

/** Read here, and on the service (the hub tells it, best effort). */
export async function readNotice(id: string): Promise<void> {
  patch(id, (n) => ({ ...n, unread: false }));
  await api(`/api/notices/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

/** A mark (POST /api/messages/:id/feedback, as a message's): it teaches chat's model too. */
export async function markNotice(id: string, marks: P.TriageMarks): Promise<void> {
  const r = await api<{ marks: P.TriageMarks }>(`/api/messages/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: marks });
  patch(id, (n) => (n.triage ? { ...n, triage: { ...n.triage, marks: r.marks } } : n));
}

export async function askNoticesAgain(): Promise<void> {
  await api('/api/notices/access/ask', { method: 'POST' });
  await loadNotices();
}

/** Unread notices that were not silenced: the inbox row's count. */
export const unreadNotices = (p: P.NoticesPage | null) => (p?.items ?? []).filter((n) => n.unread && n.triage?.decision !== 'silent');

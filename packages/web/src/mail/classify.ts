/**
 * Your say in "from a person" (docs/mail.md, slice 8): "This is a person" and "Not a person" on a thread, which the hub
 * applies to the thread and to its latest sender, so their other mail follows (hub mail/classify.ts).
 */
import type * as P from '@dither-chat/protocol';
import { api, db, toast } from '../state.ts';
import { mailChanged } from '../versions.ts';

/** true: a person; false: not (to Updates); null: let the rules decide again. */
export async function setPerson(t: P.MailThreadView, person: boolean | null): Promise<void> {
  try {
    const r = await api<{ sender: string | null; thread: P.MailThreadView | null }>(`/api/mail/threads/${encodeURIComponent(t.id)}/person`, { method: 'PUT', body: { person } });
    if (r.thread) db.mail.threads.set(r.thread.id, r.thread);
    mailChanged();
    if (person === false) toast({ kind: 'info', title: 'Moved to Updates', body: r.sender ? `Mail from ${r.sender} goes to Updates from now on.` : 'This thread goes to Updates.' });
  } catch (e) {
    toast({ kind: 'error', title: 'Could not change that', body: (e as Error).message });
  }
}

/** What a thread offers: "Not a person" while it counts as one, "This is a person" while it does not or nobody knows. */
export function personChoices(t: P.MailThreadView): ('is' | 'not')[] {
  if (t.class === 'bulk') return ['is'];
  if (t.class === 'personal') return t.unknown ? ['is', 'not'] : ['not'];
  return [];
}

/**
 * A discarded draft, for a few seconds (docs/mail.md, "Undo"): the strip offers Undo, and only once that is over do the
 * draft and its files go. Shared by the composer's card (ComposerCard.tsx) and the strip (Composer.tsx).
 */
import { deleteDraft, flushDraft, readDraft } from '../../mail/drafts.ts';
import { mailDiscarded, openCompose, type MailDiscarded } from './lazy.tsx';

const DISCARD_UNDO_MS = 8000;
/** Drafts gone for good this session: an upload that finishes late is deleted, not saved into them. */
export const goneKeys = new Set<string>();

export function discardLater(x: Omit<MailDiscarded, 'until'>) {
  goneKeys.delete(x.key);
  mailDiscarded.value = [...mailDiscarded.value.filter((y) => y.key !== x.key), { ...x, until: Date.now() + DISCARD_UNDO_MS }];
  setTimeout(() => void finishDiscard(x.key), DISCARD_UNDO_MS + 50);
}
/** Undo over: the draft goes, and its files from the hub's uploads. */
async function finishDiscard(key: string) {
  const x = mailDiscarded.value.find((y) => y.key === key);
  if (!x || Date.now() < x.until) return;
  mailDiscarded.value = mailDiscarded.value.filter((y) => y.key !== key);
  goneKeys.add(key);
  await flushDraft(key);
  const had = await readDraft(key);
  await deleteDraft(key);
  for (const f of had?.draft.files ?? []) void fetch(`/api/uploads/${f.uploadId}`, { method: 'DELETE' }).catch(() => {});
}
export function undoDiscard(x: MailDiscarded) {
  mailDiscarded.value = mailDiscarded.value.filter((y) => y.key !== x.key);
  openCompose({ kind: x.kind, draftKey: x.key, threadId: x.threadId });
}

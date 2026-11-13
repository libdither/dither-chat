/**
 * Where filing puts a thread, as the hub will have it (hub mail/ops.ts), so the page can show it at once: pure, on the
 * page's mailboxes (web/test/mail-ops.test.ts).
 *
 * Archive takes a thread out of Inbox (into Archive, or All mail where there is none); trash and junk take it out of
 * everything but Sent and Drafts; Inbox or a folder takes it out of the folders it is in, except that on Gmail Inbox is
 * a copy from All Mail and its labels stay (hub ops.ts copyFrom).
 *
 * What an account lets the page offer is here too (canWrite): the kinds of write its status lists, less what it
 * answered 501 to.
 */
import type * as P from '@dither-chat/protocol';

type Boxes = ReadonlyMap<string, P.MailboxView>;

const ROLE_TARGETS = new Set(['archive', 'inbox', 'trash', 'junk']);
/** Mailboxes that are not folders: what you sent stays there, and All mail and flag views are not moved out of. */
export const NOT_FOLDER = new Set(['sent', 'drafts', 'all', 'flagged', 'important']);

/** The mailbox `to` names in this thread's account. */
export function destinationIn(boxes: Boxes, t: P.MailThreadView, to: P.MailMoveTarget): P.MailboxView | undefined {
  const mine = [...boxes.values()].filter((b) => b.accountId === t.accountId);
  if (to === 'archive') return mine.find((b) => b.role === 'archive') ?? mine.find((b) => b.role === 'all');
  if (ROLE_TARGETS.has(to)) return mine.find((b) => b.role === to);
  const b = boxes.get(to);
  return b?.accountId === t.accountId ? b : undefined;
}

/** Folders a thread can be moved to: its account's, Inbox first, not the one it is only in. */
export function moveTargetsIn(boxes: Boxes, t: P.MailThreadView): P.MailboxView[] {
  return [...boxes.values()]
    .filter((b) => b.accountId === t.accountId && !NOT_FOLDER.has(b.role ?? '') && !(t.mailboxIds.length === 1 && t.mailboxIds[0] === b.id))
    .sort((a, b) => (a.role === 'inbox' ? -1 : b.role === 'inbox' ? 1 : a.path.localeCompare(b.path)));
}

/** Archived where the account has no Archive (Gmail): in All mail, not in Inbox. */
export function archivedInAll(boxes: Boxes, t: P.MailThreadView): boolean {
  if (t.roles.includes('inbox') || !t.roles.includes('all')) return false;
  return ![...boxes.values()].some((b) => b.accountId === t.accountId && b.role === 'archive');
}

/** The thread after a move, or null when the account has no such mailbox. */
export function movedView(boxes: Boxes, t: P.MailThreadView, to: P.MailMoveTarget): P.MailThreadView | null {
  const dest = destinationIn(boxes, t, to);
  if (!dest) return null;
  const role = (id: string) => boxes.get(id)?.role ?? null;
  const copied = to === 'inbox' && archivedInAll(boxes, t);
  const keep = (id: string) => {
    const r = role(id);
    if (copied) return true;
    if (to === 'archive') return r !== 'inbox';
    if (to === 'trash' || to === 'junk') return r === 'sent' || r === 'drafts';
    return NOT_FOLDER.has(r ?? '');
  };
  const ids = [...new Set([...t.mailboxIds.filter(keep), dest.id])];
  return { ...t, mailboxIds: ids, roles: [...new Set(ids.map(role).filter((r): r is P.MailboxRole => !!r))] };
}

/**
 * Where Undo takes a moved thread back to: Inbox if it was there, Archive after Move to Inbox from Gmail's All Mail
 * (its labels stayed), else the folder it was in; null when nowhere.
 */
export function undoTarget(boxes: Boxes, before: P.MailThreadView, to: P.MailMoveTarget): P.MailMoveTarget | null {
  if (before.roles.includes('inbox')) return 'inbox';
  if (to === 'inbox' && archivedInAll(boxes, before)) return 'archive';
  const dest = destinationIn(boxes, before, to)?.id;
  return before.mailboxIds.find((id) => id !== dest && !NOT_FOLDER.has(boxes.get(id)?.role ?? '')) ?? null;
}

// ------------------------------------------------------------------ what an account allows

/** What the hub keeps an account's 501 to each kind of write as (its ops view's `unsupported`). */
const REFUSED_AS: Record<P.MailWriteKind, string> = { seen: 'flag.seen', flagged: 'flag.flagged', move: 'move', trash: 'trash', junk: 'junk' };

/**
 * May the page offer this kind of write on the account? It may write (not a read grant), its status's `writes` do not
 * leave the kind out, and it did not answer 501 to it (a `move` refused before kinds were told apart counts for the
 * trash and junk too, while the status lists no writes). `flag.seen` and `flag.flagged` are seen and flagged.
 */
export function canWrite(a: P.MailAccountView | undefined, kind?: P.MailWriteKind | 'flag.seen' | 'flag.flagged'): boolean {
  if (!a || a.level !== 'write') return false;
  if (!kind) return true;
  const k: P.MailWriteKind = kind === 'flag.seen' ? 'seen' : kind === 'flag.flagged' ? 'flagged' : kind;
  if (a.writes && !a.writes.includes(k)) return false;
  const refused = a.ops?.unsupported ?? [];
  return !refused.includes(REFUSED_AS[k]) && !(!a.writes && (k === 'trash' || k === 'junk') && refused.includes('move'));
}

/** The kind of write a move into this mailbox is: into the trash, into junk, or any other move (archive, Inbox, a folder or label). */
export const moveKind = (b: P.MailboxView | null | undefined): P.MailWriteKind => (b?.role === 'trash' ? 'trash' : b?.role === 'junk' ? 'junk' : 'move');

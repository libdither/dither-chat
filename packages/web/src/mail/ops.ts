/**
 * Filing mail from the page (docs/mail.md; docs/mail-design.md §2.4, §3.6): read and unread, star, archive, move,
 * junk and trash, for one thread or a selection. The page's copy changes at once; the hub makes the change, keeps it
 * pending until the server answers (hub mail/ops.ts), and sends the threads back as they then stand.
 *
 * A change the hub did not get (the connection dropped) waits here, in localStorage too, with its clientId, and goes
 * again once the hub is back: the hub makes it once. One the hub refused is put back as it was, with a toast.
 */
import { effect, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { api, connected, db, toast } from '../state.ts';
import { mailChanged } from '../versions.ts';
import { destinationIn, movedView, moveTargetsIn, undoTarget } from './filing.ts';
import { details } from './held.ts';
import { applyMailEvent } from './model.ts';

interface Change {
  path: '/api/mail/flag' | '/api/mail/move';
  body: (P.MailFlagRequest | P.MailMoveRequest) & { clientId: string };
}

const KEY = 'dither-chat:mail-waiting';
const load = (): Change[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** Changes the hub has not got yet. */
export const waiting = signal<Change[]>(load());
/** The threads picked in a list (long press, or the avatar). */
export const selected = signal<ReadonlySet<string>>(new Set());
/** What the last move did, for its Undo. */
export const lastMove = signal<{ seq: number; text: string; undo: (() => void) | null } | null>(null);
let moveSeq = 0;

// ------------------------------------------------------------------ selection

export function toggleSelected(id: string) {
  const s = new Set(selected.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selected.value = s;
}
export const clearSelected = () => void (selected.value.size && (selected.value = new Set()));

// ------------------------------------------------------------------ what an account allows

export const canWrite = (a: P.MailAccountView | undefined, op?: string) => !!a && a.level === 'write' && !(op && a.ops?.unsupported.includes(op));

/** The mailbox `to` names in this thread's account. Archive is All mail where there is no Archive. */
export const destination = (t: P.MailThreadView, to: P.MailMoveTarget) => destinationIn(db.mail.mailboxes, t, to);
/** Mailboxes a thread can be moved to. */
export const moveTargets = (t: P.MailThreadView) => moveTargetsIn(db.mail.mailboxes, t);

// ------------------------------------------------------------------ the page's copy

/** Threads changed here before the hub says so: into and out of the loaded lists, and the reader's copy. */
function patch(ids: Iterable<string>, f: (t: P.MailThreadView) => P.MailThreadView | null): Map<string, P.MailThreadView> {
  const before = new Map<string, P.MailThreadView>();
  const after: P.MailThreadView[] = [];
  for (const id of ids) {
    const t = db.mail.threads.get(id);
    if (!t) continue;
    const n = f(t);
    if (!n) continue;
    before.set(id, t);
    after.push({ ...n, pending: true });
  }
  if (after.length) put(after);
  return before;
}

function put(threads: P.MailThreadView[]) {
  applyMailEvent(db.mail, { t: 'mail.threads', threads, removed: [] });
  for (const t of threads) {
    const d = details.get(t.id);
    if (d) details.set(t.id, { ...d, thread: t });
  }
  mailChanged();
}

// ------------------------------------------------------------------ changes

async function send(c: Change, before: Map<string, P.MailThreadView>, what: string): Promise<boolean> {
  try {
    await api(c.path, { body: c.body });
    return true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === undefined) {
      // The hub did not get it: it goes again when the connection is back.
      waiting.value = [...waiting.value, c];
      save();
      return true;
    }
    put([...before.values()]);
    toast({ kind: 'error', title: `Could not ${what}`, body: (e as Error).message });
    return false;
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(waiting.value));
  } catch {}
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (waiting.value.length && connected.value) {
      const [c, ...rest] = waiting.value;
      try {
        await api(c.path, { body: c.body });
      } catch (e) {
        // Still not reachable: later. Refused: dropped, the hub's copy stands.
        if ((e as { status?: number }).status === undefined) break;
      }
      waiting.value = rest;
      save();
    }
  } finally {
    flushing = false;
  }
}
effect(() => {
  if (connected.value && waiting.value.length) void flush();
});

const clientId = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();

/** Read or unread. Threads: read marks all of them read; unread marks the latest. */
export function markRead(threadIds: string[], seen: boolean) {
  const before = patch(threadIds, (t) => (seen ? (t.unread ? { ...t, unread: 0 } : null) : t.unread ? null : { ...t, unread: 1 }));
  if (!before.size) return;
  void send({ path: '/api/mail/flag', body: { threadIds: [...before.keys()], seen, clientId: clientId() } }, before, seen ? 'mark it read' : 'mark it unread');
}

/** Star a thread (its latest message) or unstar it (every starred one). */
export function star(threadIds: string[], flagged: boolean) {
  const before = patch(threadIds, (t) => (t.flagged === flagged ? null : { ...t, flagged }));
  if (!before.size) return;
  // The reader's messages as the hub will have them: the latest starred, or none.
  for (const id of before.keys()) {
    const d = details.get(id);
    const last = d?.messages[d.messages.length - 1];
    if (!d || !last) continue;
    const set = (m: P.MailMessageView, v: boolean) => (m.flags.flagged === v ? m : { ...m, flags: { ...m.flags, flagged: v }, pending: true });
    details.set(id, { ...d, messages: d.messages.map((m) => (flagged ? (m === last ? set(m, true) : m) : set(m, false))) });
  }
  void send({ path: '/api/mail/flag', body: { threadIds: [...before.keys()], flagged, clientId: clientId() } }, before, flagged ? 'star it' : 'unstar it');
}

/** One message's star, in the reader. */
export function starMessage(m: P.MailMessageView, flagged: boolean) {
  const t = db.mail.threads.get(m.threadId);
  const d = details.get(m.threadId);
  if (d) details.set(m.threadId, { ...d, messages: d.messages.map((x) => (x.id === m.id ? { ...x, flags: { ...x.flags, flagged }, pending: true } : x)) });
  const before = patch([m.threadId], (x) => ({ ...x, flagged: flagged || (d?.messages ?? []).some((y) => y.id !== m.id && y.flags.flagged) }));
  if (!t) mailChanged();
  void send({ path: '/api/mail/flag', body: { messageIds: [m.id], flagged, clientId: clientId() } }, before, flagged ? 'star it' : 'unstar it');
}

const MOVE_TEXT: Record<string, [string, string]> = {
  archive: ['Archived', 'archive it'],
  inbox: ['Moved to Inbox', 'move it to Inbox'],
  trash: ['Moved to the trash', 'move it to the trash'],
  junk: ['Marked as junk', 'mark it as junk'],
};

/** Archive, back to Inbox, trash, junk, or into a mailbox; then "Undo" for a few seconds. */
export function move(threadIds: string[], to: P.MailMoveTarget) {
  const before = patch(threadIds, (t) => movedView(db.mail.mailboxes, t, to));
  if (!before.size) return;
  const n = before.size;
  const name = MOVE_TEXT[to]?.[0] ?? `Moved to ${db.mail.mailboxes.get(to)?.name ?? 'the mailbox'}`;
  void send({ path: '/api/mail/move', body: { threadIds: [...before.keys()], to, clientId: clientId() } }, before, MOVE_TEXT[to]?.[1] ?? 'move it').then((ok) => {
    if (!ok) return;
    const seq = ++moveSeq;
    lastMove.value = { seq, text: n === 1 ? name : `${name}: ${n} threads`, undo: () => undoMove(before, to) };
    setTimeout(() => lastMove.value?.seq === seq && (lastMove.value = null), 7000);
  });
}

/** Back where each thread was: Inbox, or the folder it was in. */
function undoMove(before: Map<string, P.MailThreadView>, to: P.MailMoveTarget) {
  lastMove.value = null;
  const back = new Map<string, string[]>();
  for (const t of before.values()) {
    const target = undoTarget(db.mail.mailboxes, t, to);
    if (!target) continue;
    back.set(target, [...(back.get(target) ?? []), t.id]);
  }
  for (const [target, ids] of back) {
    const was = patch(ids, (t) => before.get(t.id) ?? null);
    void send({ path: '/api/mail/move', body: { threadIds: ids, to: target, clientId: clientId() } }, was, 'undo it');
  }
}

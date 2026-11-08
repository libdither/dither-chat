/**
 * Which thread a message joins (docs/mail-design.md §2.3). Pure: what it needs to know of the threads already held
 * comes through `ThreadLookup`, which MailStore answers from its tables and the tests from a table.
 *
 * Threads stay within one account. In order:
 *
 *   1. The server's thread (Gmail, Proton give `threadId`).
 *   2. References: In-Reply-To, then References newest first, then the message's own Message-ID (a reply that came
 *      first named it). A message that links two threads merges them into the older one.
 *   3. Provisional, by subject: the same normalised subject, someone besides you in both, at most 14 days apart.
 *      Empty and generic subjects never merge. When mail.get later brings references, MailStore threads it again.
 */
import { mailId } from '@dither-chat/protocol/ids';

export const SUBJECT_GAP_MS = 14 * 86_400_000;

/** Reply and forward markers in the languages mail clients write them, and `[list]` tags. */
const PREFIX = /^\s*(?:(?:re|fwd?|aw|wg|sv|vs|antw|tr|rif|r|enc|odp)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*|\[[^\]]{1,40}\]\s*)/i;

/** The subject as threads compare it: lower case, without Re:/Fwd:/AW: and list tags, spaces collapsed. */
export function normalizeSubject(subject: string): string {
  let s = (subject ?? '').trim();
  for (let i = 0; i < 20; i++) {
    const next = s.replace(PREFIX, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

const GENERIC = new Set(['', 'hi', 'hello', 'hey', 'question', 'questions', 'quick question', 'help', 'update', 'thanks', 'thank you', 'test', 'hi there', 'hello there', 'no subject', '(no subject)', 'fyi', 'info', 'follow up', 'follow-up', 'meeting', 'call']);
/** Subjects too common to say two messages belong together. */
export function genericSubject(key: string): boolean {
  return GENERIC.has(key) || key.length < 3;
}

export interface ThreadInput {
  accountId: string;
  /** The message's own key (`m:<Message-ID>` or `x:…`), for a new thread's id. */
  key: string;
  messageId: string | null;
  /** The server's thread. */
  threadId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  /** When it was received: for the subject rule's 14 days. */
  at: number;
  /** Everyone on it but you, lower-cased. */
  others: string[];
}

export interface ThreadInfo {
  id: string;
  firstAt: number;
  lastAt: number;
  /** Everyone on it but you, lower-cased. */
  others: string[];
  /** It is a server's thread. */
  native: boolean;
}

export interface ThreadLookup {
  /** The thread a Message-ID points at (mail_ref). */
  byRef(ref: string): string | null;
  info(threadId: string): ThreadInfo | null;
  /** Threads with this normalised subject whose messages are within `gap` of `at`. */
  bySubject(subjectKey: string, at: number, gap: number): ThreadInfo[];
}

export interface ThreadPlace {
  threadId: string;
  by: 'native' | 'ref' | 'subject' | 'new';
  /** Other threads the message links to this one: they merge into it. */
  merge: string[];
}

export const nativeThreadId = (accountId: string, threadId: string) => mailId('mth', accountId, `n:${threadId}`);

/** The Message-IDs to look up, in the order §2.3 gives: In-Reply-To, References newest first, the message's own. */
export function refsToTry(m: Pick<ThreadInput, 'inReplyTo' | 'references' | 'messageId'>): string[] {
  const out: string[] = [];
  const add = (r: string | null | undefined) => r && !out.includes(r) && out.push(r);
  add(m.inReplyTo);
  for (const r of [...m.references].reverse()) add(r);
  add(m.messageId);
  return out;
}

export function placeMessage(m: ThreadInput, look: ThreadLookup): ThreadPlace {
  // 1. The server's thread.
  if (m.threadId) {
    const id = nativeThreadId(m.accountId, m.threadId);
    // Threads it links by reference that are not this one join it: the server put them together.
    const linked = new Set<string>();
    for (const r of refsToTry(m)) {
      const t = look.byRef(r);
      if (t && t !== id && !look.info(t)?.native) linked.add(t);
    }
    return { threadId: id, by: 'native', merge: [...linked] };
  }
  // 2. References.
  const hits: string[] = [];
  for (const r of refsToTry(m)) {
    const t = look.byRef(r);
    if (t && !hits.includes(t)) hits.push(t);
  }
  if (hits.length) {
    // The oldest of the threads it links keeps the others.
    const infos = hits.map((id) => look.info(id)).filter((x): x is ThreadInfo => !!x);
    if (infos.length) {
      infos.sort((a, b) => a.firstAt - b.firstAt || (a.id < b.id ? -1 : 1));
      const [into, ...rest] = infos;
      // Two server threads are the server's to join, not ours.
      return { threadId: into.id, by: 'ref', merge: rest.filter((t) => !(t.native && into.native)).map((t) => t.id) };
    }
  }
  // 3. Provisional, by subject.
  const key = normalizeSubject(m.subject);
  if (!genericSubject(key) && m.others.length) {
    const near = look
      .bySubject(key, m.at, SUBJECT_GAP_MS)
      .filter((t) => !t.native && t.others.some((o) => m.others.includes(o)))
      .sort((a, b) => b.lastAt - a.lastAt);
    if (near.length) return { threadId: near[0].id, by: 'subject', merge: [] };
  }
  return { threadId: mailId('mth', m.accountId, `r:${m.messageId ?? m.key}`), by: 'new', merge: [] };
}

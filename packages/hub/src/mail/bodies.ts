/**
 * Bodies fetched before anyone opens them (docs/mail-design.md §3.3 step 6, §3.4, §2.5), in the background (P2, in
 * the budget of backfill.ts):
 *
 *   - personal mail of the last MAIL_LIMITS.prefetchDays, newest first, at most MAIL_LIMITS.prefetchMax an account,
 *     once a sync has brought it;
 *   - on an account whose summaries carry no headers (Proton, MailStore.headerless), also Inbox mail inside the
 *     one-list inbox's window (MAIL_INBOX.unread) still classed `unknown`: only its body says whether it came from a
 *     list, or answers one of yours. After headerless.ts relabelled the account, so its labels decide first;
 *   - new mail that looks personal, as it arrives (triage, slice 9, reads its text);
 *   - the first MAIL_LIMITS.prefetchRows rows of a list a page opens, so their previews show.
 *
 * "Personal" is the message's class once slice 8 sets it; until then, mail to you or Cc'd to you without list headers
 * from an address that does not look automated (§4 rules 7 and 9). Each body that arrives is MailHub's `body` event.
 */
import type * as P from '@dither-chat/protocol';
import { unref } from '../clock.ts';
import { MAIL_INBOX } from './attention.ts';
import { asMailError } from './backend.ts';
import type { BodyCache } from './cache.ts';
import { relabeled } from './headerless.ts';
import type { MailHub } from './index.ts';
import { DAY, MAIL_LIMITS } from './limits.ts';
import { P2 } from './queue.ts';

/** §4 rule 9: local parts that send for machines. */
const AUTOMATED = /^(no-?reply|do-?not-?reply|notifications?|alerts?|news(letter)?|mailer-daemon|postmaster|bounces?|marketing|updates?|digest)([+._-]|$)/i;

/** Messages that look personal, as SQL over mail_message `m` (slice 8's class, else rules 7 and 9 roughly). */
const PERSONAL = `(m.class = 'personal' OR (m.class IS NULL AND m.bulk IS NULL AND m.addressed IN ('to', 'cc')))`;

export class Bodies {
  /** Queued here and not arrived yet. */
  private queued = new Set<string>();
  private soon = new Map<string, unknown>();

  constructor(
    private hub: MailHub,
    private cache: BodyCache,
  ) {}

  private looksPersonal(fromAddr: string | null): boolean {
    return !AUTOMATED.test((fromAddr ?? '').split('@')[0] ?? '');
  }

  /** Fetches these bodies in the background, those not here or on their way already. */
  prefetch(messageIds: string[]) {
    void this.fetch(messageIds, false);
  }

  /** Fetches these again, here or not (headerless.ts: bodies kept before their headers were). Done when all settled. */
  again(messageIds: string[]): Promise<unknown> {
    return this.fetch(messageIds, true);
  }

  private fetch(messageIds: string[], again: boolean): Promise<unknown> {
    const st = this.hub.store;
    const going: Promise<unknown>[] = [];
    for (const id of messageIds) {
      if (this.queued.has(id) || (!again && st.one('SELECT 1 FROM mail_body WHERE message_id = ?', id))) continue;
      const m = st.one<{ account_id: string }>('SELECT account_id FROM mail_message WHERE id = ?', id);
      const s = m && this.hub.sync(m.account_id);
      if (!s?.workable) continue;
      this.queued.add(id);
      const one = s
        .fetchBody(id, P2)
        .then(
          () => {
            this.cache.stored();
            this.hub.emit('body', { messageId: id });
          },
          (e) => {
            const err = asMailError(e);
            // Gone, or the account stopped: nothing to say.
            if (err.status !== 404 && !/stopped/.test(err.message)) s.log(`prefetch: ${err.message}`);
          },
        )
        .finally(() => this.queued.delete(id));
      going.push(one);
    }
    return Promise.all(going);
  }

  /**
   * The newest personal mail of the last days: the bodies of those not here. Only once every followed mailbox reaches
   * back past those days (§3.3: step 6 after step 5): before, mail still on its way pushes the newest out, and each
   * pass would fetch more than the cap. The next run of pages asks again.
   */
  recent(accountId: string) {
    const since = this.hub.clock.now() - MAIL_LIMITS.prefetchDays * DAY;
    if (this.hub.store.one(`SELECT 1 FROM mailbox WHERE account_id = ? AND follow = 'always' AND complete = 0 AND (horizon IS NULL OR horizon > ?) LIMIT 1`, accountId, since)) return;
    const rows = this.hub.store.all<{ id: string; from_addr: string | null }>(
      `SELECT m.id, m.from_addr FROM mail_message m WHERE m.account_id = ? AND m.received_at >= ? AND ${PERSONAL} ORDER BY m.received_at DESC LIMIT ?`,
      accountId,
      since,
      MAIL_LIMITS.prefetchMax * 2,
    );
    const ids = rows.filter((r) => this.looksPersonal(r.from_addr)).map((r) => r.id);
    this.prefetch([...new Set([...ids.slice(0, MAIL_LIMITS.prefetchMax), ...this.window(accountId, false)])].slice(0, MAIL_LIMITS.prefetchMax));
  }

  /**
   * An account without headers on its summaries: Inbox mail in the one-list inbox's window from a sender nobody knows
   * (`unknown`, or not classified yet), whose body would say whether it came from a list or answers you. `fetched`:
   * those whose body is here (headerless.ts fetches them again once, as they were kept before their headers were);
   * else those whose body is not. Empty for any other account, and until its labels are in (headerless.ts).
   */
  window(accountId: string, fetched: boolean, now = this.hub.clock.now()): string[] {
    const st = this.hub.store;
    if (!st.headerless(accountId) || !relabeled(st, accountId)) return [];
    return st
      .all<{ id: string }>(
        `SELECT m.id FROM mail_message m
         WHERE m.account_id = ? AND m.received_at >= ? AND m.addressed != 'self' AND m.draft = 0 AND m.bulk IS NULL AND (m.class IS NULL OR m.class_why = 'unknown')
           AND ${fetched ? '' : 'NOT'} EXISTS (SELECT 1 FROM mail_body WHERE message_id = m.id)
           AND EXISTS (SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = m.id AND b.role = 'inbox')
         ORDER BY m.received_at DESC LIMIT ?`,
        accountId,
        now - MAIL_INBOX.unread,
        MAIL_LIMITS.prefetchMax,
      )
      .map((r) => r.id);
  }

  /** After a sync brought mail: `recent`, a few seconds later, once for a run of pages. */
  later(accountId: string) {
    if (this.soon.has(accountId)) return;
    const timer = this.hub.clock.setTimeout(() => {
      this.soon.delete(accountId);
      if (this.hub.sync(accountId)) this.recent(accountId);
    }, 3_000);
    unref(timer);
    this.soon.set(accountId, timer);
  }

  /** The hub stopped (MailHub.stopping). */
  stop() {
    for (const t of this.soon.values()) this.hub.clock.clearTimeout(t);
    this.soon.clear();
  }

  /** New mail, as it arrives: the personal ones' bodies. */
  arrived(messageIds: string[]) {
    if (!messageIds.length) return;
    const rows = this.hub.store.all<{ id: string; from_addr: string | null }>(
      `SELECT m.id, m.from_addr FROM mail_message m WHERE m.id IN (SELECT value FROM json_each(?)) AND ${PERSONAL}`,
      JSON.stringify(messageIds),
    );
    this.prefetch(rows.filter((r) => this.looksPersonal(r.from_addr)).map((r) => r.id));
  }

  /** A list's first rows without a preview: their latest message's body. */
  rows(threads: P.MailThreadView[]) {
    const want = threads
      .slice(0, MAIL_LIMITS.prefetchRows)
      .filter((t) => !t.preview)
      .map((t) => t.id);
    if (!want.length) return;
    const ids = this.hub.store.all<{ last_message_id: string | null }>('SELECT last_message_id FROM mail_thread WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(want));
    this.prefetch(ids.map((r) => r.last_message_id).filter((x): x is string => !!x));
  }
}

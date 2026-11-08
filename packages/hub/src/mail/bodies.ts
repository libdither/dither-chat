/**
 * Bodies fetched before anyone opens them (docs/mail-design.md §3.3 step 6, §3.4, §2.5), in the background (P2, in
 * the budget of backfill.ts):
 *
 *   - personal mail of the last MAIL_LIMITS.prefetchDays, newest first, at most MAIL_LIMITS.prefetchMax an account,
 *     once a sync has brought it;
 *   - new mail that looks personal, as it arrives (triage, slice 9, reads its text);
 *   - the first MAIL_LIMITS.prefetchRows rows of a list a page opens, so their previews show.
 *
 * "Personal" is the message's class once slice 8 sets it; until then, mail to you or Cc'd to you without list headers
 * from an address that does not look automated (§4 rules 7 and 9). Each body that arrives is MailHub's `body` event.
 */
import type * as P from '@dither-chat/protocol';
import { asMailError } from './backend.ts';
import type { BodyCache } from './cache.ts';
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
  private soon = new Map<string, Timer>();

  constructor(
    private hub: MailHub,
    private cache: BodyCache,
  ) {}

  private looksPersonal(fromAddr: string | null): boolean {
    return !AUTOMATED.test((fromAddr ?? '').split('@')[0] ?? '');
  }

  /** Fetches these bodies in the background, those not here or on their way already. */
  prefetch(messageIds: string[]) {
    const st = this.hub.store;
    for (const id of messageIds) {
      if (this.queued.has(id) || st.one('SELECT 1 FROM mail_body WHERE message_id = ?', id)) continue;
      const m = st.one<{ account_id: string }>('SELECT account_id FROM mail_message WHERE id = ?', id);
      const s = m && this.hub.sync(m.account_id);
      if (!s?.workable) continue;
      this.queued.add(id);
      s.fetchBody(id, P2)
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
    }
  }

  /**
   * The newest personal mail of the last days: the bodies of those not here. Only once every followed mailbox reaches
   * back past those days (§3.3: step 6 after step 5): before, mail still on its way pushes the newest out, and each
   * pass would fetch more than the cap. The next run of pages asks again.
   */
  recent(accountId: string) {
    const since = Date.now() - MAIL_LIMITS.prefetchDays * DAY;
    if (this.hub.store.one(`SELECT 1 FROM mailbox WHERE account_id = ? AND follow = 'always' AND complete = 0 AND (horizon IS NULL OR horizon > ?) LIMIT 1`, accountId, since)) return;
    const rows = this.hub.store.all<{ id: string; from_addr: string | null }>(
      `SELECT m.id, m.from_addr FROM mail_message m WHERE m.account_id = ? AND m.received_at >= ? AND ${PERSONAL} ORDER BY m.received_at DESC LIMIT ?`,
      accountId,
      since,
      MAIL_LIMITS.prefetchMax * 2,
    );
    this.prefetch(
      rows
        .filter((r) => this.looksPersonal(r.from_addr))
        .slice(0, MAIL_LIMITS.prefetchMax)
        .map((r) => r.id),
    );
  }

  /** After a sync brought mail: `recent`, a few seconds later, once for a run of pages. */
  later(accountId: string) {
    if (this.soon.has(accountId)) return;
    const timer = setTimeout(() => {
      this.soon.delete(accountId);
      if (this.hub.sync(accountId)) this.recent(accountId);
    }, 3_000);
    timer.unref?.();
    this.soon.set(accountId, timer);
  }

  /** The hub stopped (MailHub.stopping). */
  stop() {
    for (const t of this.soon.values()) clearTimeout(t);
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

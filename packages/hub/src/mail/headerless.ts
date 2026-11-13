/**
 * Accounts whose summaries carry no headers (docs/mail.md "Summaries without headers"): Proton's lists, events and
 * searches give a message's metadata only, so In-Reply-To, References and the list headers come with its body
 * (mail.get), and a newsletter looks like a stranger's mail until then. MailStore.headerless says which accounts
 * (the status's `details.summaryHeaders`, else no summary of the account has carried any yet).
 *
 * Such an account's summaries carry the server's own sorting as labels instead (Proton's `Category/Newsletters`, …:
 * classify.ts rule 8). Once per account, on the hub's start (the first time the account can work):
 *
 *   1. its mail is listed again from the newest, Inbox and then All mail (or Archive), down to the oldest the hub
 *      holds there, at most MAIL_LIMITS.relabelMax a mailbox, as backfill pages (P3, in the background's budget), so
 *      mail stored before the extractor gave those labels gets them. Nothing is removed: this only refreshes what
 *      it lists (a relist after a 410 is the one that drops what it does not see);
 *   2. the bodies kept before the hub read their list headers (MailStore.putBody), of Inbox mail inside the one-list
 *      inbox's window still classed `unknown`, are fetched again (bodies.ts `again`).
 *
 * Then bodies.ts fetches ahead the rest of that window still `unknown` (`Bodies.window`), and triage rates them
 * quietly (triage.ts `sweep`): only once both steps are done (`settled`), so a newsletter is not rated as a person.
 * Each step is marked done in mail_setting (`relabeled:<account>`, `rebodied:<account>`); an account added after
 * this lists its mail with the labels already, so it is marked done as it comes.
 */
import type * as M from '@dither-chat/protocol/mail-iface';
import { timedWork } from '../stalls.ts';
import { asMailError } from './backend.ts';
import type { Bodies } from './bodies.ts';
import type { MailHub } from './index.ts';
import { MAIL_LIMITS } from './limits.ts';
import { P3 } from './queue.ts';
import type { MailStore } from './store.ts';
import type { AccountSync } from './sync.ts';

type Step = 'relabeled' | 'rebodied';
type Page = { messages: M.MailSummary[]; next: string | null };

const key = (step: Step, accountId: string) => `${step}:${accountId}`;
const done = (st: MailStore, step: Step, accountId: string) => !!st.one(`SELECT 1 FROM mail_setting WHERE key = ?`, key(step, accountId));
const mark = (st: MailStore, step: Step, accountId: string) =>
  st.db.query(`INSERT INTO mail_setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key(step, accountId), String(Date.now()));

/** Its mail was listed again for the labels (step 1), or never needed to be. */
export const relabeled = (st: MailStore, accountId: string) => !st.headerless(accountId) || done(st, 'relabeled', accountId);

/** What summaries cannot say has had its chance to come in: labels, then the headers of bodies kept before. */
export const settled = (st: MailStore, accountId: string) => !st.headerless(accountId) || (done(st, 'relabeled', accountId) && done(st, 'rebodied', accountId));

/** Tries per account and hub run before a step that keeps failing waits for the next start. */
const TRIES = 3;

export class Headerless {
  private running = new Set<string>();
  private tries = new Map<string, number>();
  private timer: Timer | null = null;
  private first: Timer | null = null;

  constructor(
    private hub: MailHub,
    private bodies: Bodies,
  ) {
    const st = hub.store;
    // Accounts with nothing here yet list their mail with its labels: nothing to do again.
    for (const a of st.all<{ id: string }>(`SELECT id FROM mail_account a WHERE NOT EXISTS (SELECT 1 FROM mail_message WHERE account_id = a.id)`)) this.skip(a.id);
    hub.on('account', (e) => {
      if (e.state === 'added') this.skip(e.accountId);
      else if (e.state === 'deleted') st.db.query(`DELETE FROM mail_setting WHERE key IN (?, ?)`).run(key('relabeled', e.accountId), key('rebodied', e.accountId));
      else if (e.state === 'changed') this.check();
    });
    // When an account can work is the sync's to know: looked at a little after the start, then every minute.
    this.first = setTimeout(() => this.check(), 3_000);
    this.timer = setInterval(() => this.check(), 60_000);
    this.first.unref?.();
    this.timer.unref?.();
  }

  stop() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }

  private skip(accountId: string) {
    const st = this.hub.store;
    if (!done(st, 'relabeled', accountId)) mark(st, 'relabeled', accountId);
    if (!done(st, 'rebodied', accountId)) mark(st, 'rebodied', accountId);
  }

  /** Each account that still has a step to do, and can work now. */
  check() {
    let ids: string[];
    try {
      ids = this.hub.store.accounts().map((a) => a.id);
    } catch {
      // The hub is gone.
      return;
    }
    for (const id of ids) void this.run(id);
  }

  /** Both steps for one account, in order; resolves when they are done (or it cannot work now). */
  async run(accountId: string): Promise<void> {
    const st = this.hub.store;
    if (this.running.has(accountId) || settled(st, accountId)) return;
    if ((this.tries.get(accountId) ?? 0) >= TRIES) return;
    const s = this.hub.sync(accountId);
    if (!s?.workable || !st.account(accountId)?.synced_at) return;
    this.running.add(accountId);
    try {
      if (!done(st, 'relabeled', accountId)) {
        const n = await this.relabel(s);
        mark(st, 'relabeled', accountId);
        s.log(`listed ${n} summaries again for their labels`);
      }
      if (!done(st, 'rebodied', accountId)) {
        const ids = this.bodies.window(accountId, true);
        await this.bodies.again(ids);
        mark(st, 'rebodied', accountId);
        if (ids.length) s.log(`fetched ${ids.length} bodies again for their headers`);
      }
      // What is still from a sender nobody knows: its body ahead (bodies.ts), then triage's quiet rating.
      this.bodies.recent(accountId);
    } catch (e) {
      // Stopped (the hub, or the account went offline): it goes on when it can work again.
      const err = asMailError(e);
      if (!/stopped/.test(err.message)) {
        this.tries.set(accountId, (this.tries.get(accountId) ?? 0) + 1);
        s.log(`relabel: ${err.message}; trying again in a minute`);
      }
    } finally {
      this.running.delete(accountId);
    }
  }

  /** Step 1: Inbox, then All mail (else Archive), from the newest down to the oldest held there. Returns how many it listed. */
  private async relabel(s: AccountSync): Promise<number> {
    const st = this.hub.store;
    const boxes = st
      .followed(s.accountId)
      .filter((b) => b.follow === 'always' && b.role !== 'sent')
      .sort((a, b) => Number(b.role === 'inbox') - Number(a.role === 'inbox'));
    let total = 0;
    for (const b of boxes) {
      const oldest = st.one<{ t: number | null }>('SELECT MIN(m.received_at) AS t FROM mail_location l JOIN mail_message m ON m.id = l.message_id WHERE l.mailbox_id = ?', b.id)?.t;
      if (oldest === null || oldest === undefined) continue;
      let next: string | null = null;
      let listed = 0;
      for (;;) {
        if (!s.workable) throw new Error('stopped: the account cannot work now');
        const before: string | null = next;
        const r: Page = await s.queue.run(P3, `relabel:${b.id}`, () => s.call<Page>('mail.list', { mailboxId: b.native_id, limit: MAIL_LIMITS.backfillPage, ...(before ? { before } : {}) }));
        const row = st.mailbox(b.id);
        if (!row) break;
        timedWork(`mail: ${r.messages.length} summaries (headers)`, () => s.stored(st.ingest(s.accountId, row, r.messages), false));
        listed += r.messages.length;
        next = r.next;
        if (!next || !r.messages.length || listed >= MAIL_LIMITS.relabelMax) break;
        if (Math.min(...r.messages.map((m) => m.receivedAt)) <= oldest) break;
      }
      total += listed;
    }
    return total;
  }
}

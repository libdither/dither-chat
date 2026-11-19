/**
 * The contract FakeMailBackend's 'gmail-web' mode keeps with dither-accounts' google kind (Gmail read through the
 * signed-in browser), checked without a manager: one script of calls on the fake, and what this hub relies on in each
 * answer. mail-remote-google.test.ts runs the hub against the real kind (locally; it needs a browser).
 *
 * Where a dither-accounts checkout is beside this repo (or DITHER_ACCOUNTS_REPO), its google extractor's protocol
 * module is read too, and the divergences that can be checked without the manager are pinned, so a change on either
 * side shows here:
 *
 *   mailbox ids  the kind uses Gmail's web label ids (`^i` Inbox, `^f` Sent, `all` All Mail, `^k` Trash…); the fake,
 *                the Gmail API's (INBOX, SENT, ALL_MAIL, TRASH…). The hub keeps them opaque.
 *   roles        the kind also lists Starred (role 'flagged') and Snoozed and Scheduled (no role) as mailboxes; the
 *                fake has none of them (starring is the \Flagged flag on both).
 *   message ids  decimal on the kind (protocol.ts DECIMAL_ID); hexadecimal on the fake. Opaque to the hub.
 *   states       `g1.<history>.<ms>` on the kind, `<epoch>.<seq>` on the fake: opaque, and account-wide on both.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as M from '@dither-chat/protocol/mail-iface';
import { MailCallError } from '../src/mail/backend.ts';
import { FakeMailBackend, GMAIL_WEB } from '../src/mail/fake.ts';

const ACC = 'acc_gwebContract1';
const T0 = Date.UTC(2026, 10, 1, 12);
const H = 3_600_000;
const ACCOUNTS = process.env.DITHER_ACCOUNTS_REPO ?? resolve(import.meta.dir, '../../../../dither-accounts');
const PROTOCOL = join(ACCOUNTS, 'extractors/google/src/gmail/protocol.ts');

type Page = { messages: M.MailSummary[]; next: string | null; skipped?: string[] };

/** On its own clock (the real one): each answer a turn of the event loop later, nothing timed. */
function server() {
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { kind: 'google', email: 'me@workspace.example', opts: { ids: 'gmail-web' } });
  const call = <T>(op: string, input: Record<string, unknown> = {}) => fake.call<T>(ACC, op, input);
  return { fake, call };
}

describe("FakeMailBackend 'gmail-web' as the google kind answers", () => {
  test('one script: mailboxes, states, lists, one id everywhere, changes, skipped ids, get', async () => {
    const { fake, call } = server();
    const a = fake.put(ACC, { messageId: '<a@x>', subject: 'A', receivedAt: T0 });
    const b = fake.put(ACC, { messageId: '<b@x>', subject: 'B', receivedAt: T0 + H, labels: ['Work'] });
    const c = fake.put(ACC, { messageId: '<c@x>', subject: 'C', receivedAt: T0 + 2 * H });

    // The roles the hub follows (inbox, sent, all) and the ones it moves to (trash, junk) are there.
    const boxes = (await call<{ mailboxes: M.Mailbox[] }>('mail.mailboxes')).mailboxes;
    const roles = new Set(boxes.map((x) => x.role).filter(Boolean));
    for (const r of ['inbox', 'sent', 'all', 'trash', 'junk', 'drafts', 'important']) expect(roles.has(r as M.MailboxRole)).toBe(true);
    // A user label is a mailbox of its own, with no role.
    expect(boxes.find((x) => x.path === 'Work')?.role).toBeNull();

    // A state with no `state` given: nothing changed, never `more`. Account-wide: every mailbox gives the same one.
    const s0 = await call<M.MailChanges>('mail.changes', { mailboxId: GMAIL_WEB.inbox });
    expect(s0).toEqual({ state: expect.any(String), added: [], changed: [], removed: [], more: false });
    expect((await call<M.MailChanges>('mail.changes', { mailboxId: GMAIL_WEB.all })).state).toBe(s0.state);

    // Newest first, an opaque cursor, null at the end.
    const p1 = await call<Page>('mail.list', { mailboxId: GMAIL_WEB.inbox, limit: 2 });
    expect(p1.messages.map((m) => m.id)).toEqual([c.id, b.id]);
    expect(typeof p1.next).toBe('string');
    const p2 = await call<Page>('mail.list', { mailboxId: GMAIL_WEB.inbox, limit: 2, before: p1.next });
    expect(p2.messages.map((m) => m.id)).toEqual([a.id]);
    expect(p2.next).toBeNull();
    expect(p1.skipped).toBeUndefined();

    // One id a message in every mailbox listing it; summaries carry no headers, and their emailId is the id.
    const all = await call<Page>('mail.list', { mailboxId: GMAIL_WEB.all, limit: 50 });
    expect(all.messages.map((m) => m.id).sort()).toEqual([a.id, b.id, c.id].sort());
    for (const m of [...p1.messages, ...all.messages]) {
      expect(m.messageId).toBeNull();
      expect(m.emailId).toBe(m.id);
    }
    // mail.get has the Message-ID.
    expect((await call<M.MailMessage>('mail.get', { id: b.id })).messageId).toBe('<b@x>');

    // A new message: in `added` of each mailbox listing it, from the one state.
    const d = fake.deliver(ACC, { messageId: '<d@x>', subject: 'D', receivedAt: T0 + 3 * H });
    for (const box of [GMAIL_WEB.inbox, GMAIL_WEB.all]) {
      const ch = await call<M.MailChanges>('mail.changes', { mailboxId: box, state: s0.state });
      expect(ch.added.map((m) => m.id)).toEqual([d.id]);
      expect(ch.more).toBe(false);
    }

    // Skipped (the extractor could not parse it): out of lists, changes and searches, named in `skipped`.
    fake.skip(ACC, [d.id], 'list');
    const listed = await call<Page>('mail.list', { mailboxId: GMAIL_WEB.inbox, limit: 50 });
    expect(listed.messages.map((m) => m.id)).not.toContain(d.id);
    expect(listed.skipped).toEqual([d.id]);
    const ch = await call<M.MailChanges>('mail.changes', { mailboxId: GMAIL_WEB.inbox, state: s0.state });
    expect([ch.added, ch.skipped]).toEqual([[], [d.id]]);
    const found = await call<Page>('mail.search', { query: 'subject:D' });
    expect([found.messages, found.skipped]).toEqual([[], [d.id]]);
    // mail.get still reads it ('list'); with 'all' it fails as an unreadable message does, 502.
    expect((await call<M.MailMessage>('mail.get', { id: d.id })).subject).toBe('D');
    fake.skip(ACC, [d.id], 'all');
    expect(((await call('mail.get', { id: d.id }).catch((e) => e)) as MailCallError).status).toBe(502);
    fake.skip(ACC, [d.id], null);
    expect((await call<Page>('mail.list', { mailboxId: GMAIL_WEB.inbox, limit: 50 })).skipped).toBeUndefined();

    // A message it does not have: 404.
    expect(((await call('mail.get', { id: 'ffff' }).catch((e) => e)) as MailCallError).status).toBe(404);
  });

  test.skipIf(!existsSync(PROTOCOL))("the divergences from dither-accounts' google extractor, pinned", async () => {
    const { SYSTEM, DECIMAL_ID } = await import(PROTOCOL);
    const { fake, call } = server();
    const m = fake.put(ACC, { messageId: '<x@x>', receivedAt: T0 });
    const boxes = (await call<{ mailboxes: M.Mailbox[] }>('mail.mailboxes')).mailboxes;
    const fakeRoles = new Set(boxes.map((x) => x.role));
    const kindRoles = new Set((SYSTEM as { role: M.MailboxRole | null }[]).map((x) => x.role));
    // Every role the fake has, the kind has; the kind's Starred mailbox ('flagged') is the one the fake lacks.
    expect([...fakeRoles].filter((r) => !kindRoles.has(r))).toEqual([]);
    expect([...kindRoles].filter((r) => r && !fakeRoles.has(r))).toEqual(['flagged']);
    // Ids: the kind's are decimal, the fake's are not (the hub must not read anything into either).
    expect(DECIMAL_ID.test(m.id)).toBe(false);
    expect((SYSTEM as { id: string }[]).find((x) => x.role === 'inbox')!.id).not.toBe(GMAIL_WEB.inbox);
  });
});

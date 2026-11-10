/**
 * Sending (mail/outbox.ts, docs/mail-design.md §8) against FakeMailBackend: held and undone, sent and threaded, a 501
 * that turns sending off and keeps the message, a read grant, a dry run, retries and a timeout, files by path and by
 * their bytes, a forward's files, a From that is not the account's, a recipient or settings the extractor won't send
 * with, a clientId sent once, and a restart mid-send.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import { MailCallError } from '../src/mail/backend.ts';
import { FakeMailBackend, fakeBytes, type FakeOpts } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { FROM_REFUSED, MAYBE_SENT, READ_ONLY, recipientsRefused, STOPPED_SENDING } from '../src/mail/outbox.ts';
import { Uploads } from '../src/uploads.ts';

const ACC = 'acc_sendTest01';
const ME = 'me@example.com';
const ALIAS = 'me@alias.example';
const sam = { name: 'Sam Lee', email: 'sam@lee.example' };
const jo = { name: 'Jo', email: 'jo@park.example' };
const kim = { name: null, email: 'kim@north.example' };
const H = 3_600_000;

const until = async (f: () => unknown, ms = 4000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

interface World {
  fake: FakeMailBackend;
  hub: MailHub;
  uploads: Uploads;
  dir: string;
  db: Database;
  sent: { replyTo: string | null; messageId: string | null; dryRun: boolean }[];
}

async function world(o: { opts?: FakeOpts; level?: 'read' | 'write'; dryRun?: boolean; holdMs?: number; db?: Database; dir?: string } = {}): Promise<World> {
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME, name: 'Me', addresses: [{ email: ME, name: 'Me' }, { email: ALIAS, name: 'Me' }], level: o.level, dryRun: o.dryRun, opts: o.opts });
  const now = Date.now();
  fake.put(ACC, { messageId: '<dinner-1@x>', from: [sam], to: [{ name: 'Me', email: ME }], cc: [jo], subject: 'Dinner on Friday?', receivedAt: now - 2 * H, text: 'Are you free after 7?' });
  fake.put(ACC, {
    messageId: '<lease-1@x>',
    from: [jo],
    to: [{ name: null, email: ALIAS }],
    subject: 'Lease renewal',
    receivedAt: now - H,
    text: 'The lease, signed.',
    attachments: [
      { id: 'att-lease', filename: 'lease.pdf', mime: 'application/pdf', size: 3000, inline: false, contentId: null },
      { id: 'att-logo', filename: 'logo.png', mime: 'image/png', size: 100, inline: true, contentId: '<logo>' },
    ],
  });
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'dither-mail-send-'));
  const db = o.db ?? new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  const hub = new MailHub({ db, backend: fake, log: () => {}, dataDir: dir, holdMs: o.holdMs ?? 40 });
  const uploads = new Uploads(join(dir, 'uploads'));
  hub.outbox.files = uploads;
  hub.outbox.retryMs = [20, 40];
  const sent: World['sent'] = [];
  hub.on('sent', (e) => sent.push({ replyTo: e.replyTo, messageId: e.messageId, dryRun: e.dryRun }));
  hub.start();
  cleanup.push(() => {
    hub.stop();
    if (!o.dir) rmSync(dir, { recursive: true, force: true });
  });
  await hub.sync(ACC)!.whenSynced();
  return { fake, hub, uploads, dir, db, sent };
}

const msg = (hdr: string) => mailId('mml', ACC, `m:${hdr}`);
const thread = (w: World, hdr: string) => w.hub.store.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', msg(hdr))!.thread_id;
let seq = 0;
const cid = () => `client-${Date.now()}-${seq++}`;

/** A reply to Sam, as the composer sends it. */
function reply(w: World, o: Partial<P.MailSendRequest> = {}): P.MailSendRequest {
  return {
    clientId: cid(),
    draftKey: `t:${thread(w, '<dinner-1@x>')}`,
    accountId: ACC,
    kind: 'reply',
    replyTo: msg('<dinner-1@x>'),
    from: null,
    to: [sam],
    cc: [],
    bcc: [],
    subject: 'Re: Dinner on Friday?',
    text: 'Yes, 7:30 works.',
    quote: true,
    files: [],
    forwardParts: [],
    tz: 'UTC',
    ...o,
  };
}

const state = (w: World, id: string) => w.hub.outbox.item(id)?.state;
/** As Proton does: it says it can send (canSend), and mail.send answers 501 all the same. */
const saysItCan = (w: World) => w.fake.setStatus(ACC, { status: 'online', attention: null, self: { email: ME, addresses: [{ email: ME, name: null }] }, details: { canSend: true, sendNote: null }, layers: [] });
const sends = (w: World) => w.fake.calls.filter((c) => c.op === 'mail.send').length;
const status = async (w: World, p: Promise<unknown>): Promise<number | undefined> => p.then(() => undefined, (e: MailCallError) => e.status);

describe('hold and undo', () => {
  test('held for a while, then sent: the copy in Sent joins the thread, the draft goes', async () => {
    const w = await world({ holdMs: 120 });
    const key = `t:${thread(w, '<dinner-1@x>')}`;
    w.hub.outbox.putDraft(key, reply(w));
    const { outboxId } = await w.hub.outbox.accept(reply(w));
    expect(state(w, outboxId)).toBe('held');
    expect(w.hub.outbox.item(outboxId)!.holdUntil).toBeGreaterThan(Date.now());
    expect(w.hub.outbox.draft(key)).toBeNull();
    await Bun.sleep(60);
    expect(sends(w)).toBe(0);
    await until(() => state(w, outboxId) === 'sent', 4000, 'sent');
    expect(sends(w)).toBe(1);
    const out = w.fake.sent[0];
    expect(out.mail.to).toEqual([sam]);
    expect(out.mail.from).toBeUndefined();
    expect(out.mail.text).toStartWith('Yes, 7:30 works.\n\nOn ');
    expect(out.mail.text).toContain('Sam Lee <sam@lee.example> wrote:\n> Are you free after 7?');
    expect(out.mail.html).toContain('<blockquote type="cite"');
    // replyTo is the original's id on the server: the copy threads by In-Reply-To.
    expect(out.mail.replyTo).toBe(w.fake.messages(ACC, 'INBOX').find((m) => m.messageId === '<dinner-1@x>')!.id);
    const v = w.hub.outbox.item(outboxId)!;
    expect(v.sentMessageId).toBe(out.messageId);
    expect(w.sent).toEqual([{ replyTo: msg('<dinner-1@x>'), messageId: out.messageId, dryRun: false }]);
    await until(() => w.hub.store.one('SELECT 1 FROM mail_message WHERE id = ?', msg(out.messageId)), 4000, 'the Sent copy');
    expect(thread(w, out.messageId)).toBe(thread(w, '<dinner-1@x>'));
    expect(w.hub.store.one<{ answered: number }>('SELECT answered FROM mail_message WHERE id = ?', msg('<dinner-1@x>'))!.answered).toBe(1);
    expect(w.hub.store.accountView(w.hub.store.account(ACC)!).send.ok).toBe(true);
  });

  test('Undo while held: nothing goes, and the draft is back as it was', async () => {
    const w = await world({ holdMs: 150 });
    const req = reply(w, { text: 'Actually, wait.', cc: [jo] });
    const { outboxId } = await w.hub.outbox.accept(req);
    const back = w.hub.outbox.undo(outboxId);
    expect(back.draftKey).toBe(req.draftKey!);
    expect(back.draft).toMatchObject({ kind: 'reply', text: 'Actually, wait.', to: [sam], cc: [jo], replyTo: msg('<dinner-1@x>') });
    expect(w.hub.outbox.draft(req.draftKey!)!.draft.text).toBe('Actually, wait.');
    expect(w.hub.outbox.item(outboxId)!.state).toBe('undone' as any);
    expect(w.hub.outbox.views().some((v) => v.id === outboxId)).toBe(false);
    await Bun.sleep(300);
    expect(sends(w)).toBe(0);
    // Too late to undo once it has gone.
    const second = await w.hub.outbox.accept(reply(w));
    await until(() => state(w, second.outboxId) === 'sent');
    expect(await status(w, Promise.resolve().then(() => w.hub.outbox.undo(second.outboxId)))).toBe(409);
  });

  test('the outbox event carries the whole list; a sent item can be dismissed', async () => {
    const w = await world();
    w.hub.flush();
    const { outboxId } = await w.hub.outbox.accept(reply(w));
    const ev = w.hub.flush().find((e) => e.t === 'mail.outbox') as Extract<P.ClientEvent, { t: 'mail.outbox' }>;
    expect(ev.items.map((i) => [i.id, i.state])).toEqual([[outboxId, 'held']]);
    expect(ev.items[0]).toMatchObject({ kind: 'reply', threadId: thread(w, '<dinner-1@x>'), to: [sam], subject: 'Re: Dinner on Friday?' });
    expect(w.hub.bootstrap().outbox!.map((i) => i.id)).toEqual([outboxId]);
    await until(() => state(w, outboxId) === 'sent');
    expect(await status(w, Promise.resolve().then(() => w.hub.outbox.dismiss(outboxId)))).toBeUndefined();
    expect(w.hub.outbox.views()).toEqual([]);
  });
});

describe('when it does not go', () => {
  test('501: sending turns off for the account with its words, and the message is kept as a draft', async () => {
    const w = await world({ opts: { send: 501, ids: 'proton', state: 'account', events: 'all', threadIds: true } });
    saysItCan(w);
    expect(w.hub.store.accountView(w.hub.store.account(ACC)!).send.ok).toBe(true);
    const req = reply(w, { text: 'Keep me.' });
    const { outboxId } = await w.hub.outbox.accept(req);
    await until(() => state(w, outboxId) === 'failed');
    const v = w.hub.outbox.item(outboxId)!;
    expect(v.error).toBe("Sending is off for this account: Proton's send path was not found in the page.");
    expect(v.draftKey).toBe(req.draftKey!);
    expect(w.hub.outbox.draft(req.draftKey!)!.draft).toMatchObject({ text: 'Keep me.', to: [sam] });
    const acc = w.hub.store.accountView(w.hub.store.account(ACC)!);
    expect(acc.send).toEqual({ ok: false, why: "Proton's send path was not found in the page", refused: true });
    // Off it stays, though the extractor still says it can; a new send is refused before it is held.
    w.fake.setStatus(ACC, { status: 'online', attention: null, self: { email: ME }, details: { canSend: true, sendNote: null }, layers: [] });
    expect(w.hub.store.accountView(w.hub.store.account(ACC)!).send.ok).toBe(false);
    expect(await status(w, w.hub.outbox.accept(reply(w)))).toBe(409);
    // Reading and the rest go on: a body still comes.
    expect((await w.hub.body(msg('<lease-1@x>'))).text).toBe('The lease, signed.');
    // "Try again" offers it again.
    w.hub.outbox.sendingAgain(ACC);
    expect(w.hub.store.accountView(w.hub.store.account(ACC)!).send.ok).toBeNull();
  });

  test('canSend false: its note shows, and a send is refused with it; nothing else is read-only', async () => {
    const w = await world();
    w.fake.setStatus(ACC, { status: 'online', attention: null, self: { email: ME }, details: { canSend: false, sendNote: 'Mail cannot be sent: the SMTP server refused the password.' }, layers: [] });
    const acc = w.hub.store.accountView(w.hub.store.account(ACC)!);
    expect(acc).toMatchObject({ level: 'write', send: { ok: false, why: 'Mail cannot be sent: the SMTP server refused the password.' } });
    const e = await w.hub.outbox.accept(reply(w)).catch((x) => x as MailCallError);
    expect(e).toMatchObject({ status: 409, message: `${ME} can't send from here: Mail cannot be sent: the SMTP server refused the password.` });
  });

  test('a read grant: refused before it is held; and if the grant narrows meanwhile, the draft is kept', async () => {
    const r = await world({ level: 'read' });
    const e = await r.hub.outbox.accept(reply(r)).catch((x) => x as MailCallError);
    expect(e).toMatchObject({ status: 403, message: READ_ONLY });
    expect(await status(r, r.hub.outbox.compose('reply', msg('<dinner-1@x>'), null))).toBe(403);
    cleanup.splice(0).forEach((f) => f());

    const w = await world({ holdMs: 80 });
    const req = reply(w, { text: 'Narrowed.' });
    const { outboxId } = await w.hub.outbox.accept(req);
    w.fake.setGrant(ACC, { level: 'read' });
    await until(() => state(w, outboxId) === 'failed');
    expect(w.hub.outbox.item(outboxId)!.error).toBe(READ_ONLY);
    expect(w.hub.outbox.draft(req.draftKey!)!.draft.text).toBe('Narrowed.');
    expect(sends(w)).toBe(0);
  });

  test('the manager answers 403 (the grant went read at its end): failed, draft kept', async () => {
    const w = await world();
    w.fake.fail('mail.send', new MailCallError('this app may only read this account', 403, 'denied'));
    const { outboxId } = await w.hub.outbox.accept(reply(w));
    await until(() => state(w, outboxId) === 'failed');
    expect(w.hub.outbox.item(outboxId)!.error).toBe(READ_ONLY);
  });

  test('a dry run: answered as sent, marked so; nothing reached the account', async () => {
    const w = await world({ dryRun: true });
    expect(w.hub.store.accountView(w.hub.store.account(ACC)!).dryRun).toBe(true);
    const { outboxId } = await w.hub.outbox.accept(reply(w));
    await until(() => state(w, outboxId) === 'sent');
    expect(w.hub.outbox.item(outboxId)).toMatchObject({ state: 'sent', dryRun: true, sentMessageId: null });
    expect(w.fake.sent).toEqual([]);
    expect(w.sent[0].dryRun).toBe(true);
    // Sending is not known to work from a dry run.
    expect(w.hub.store.accountView(w.hub.store.account(ACC)!).send.ok).not.toBe(false);
  });

  test('503 and limited: tried again, then sent', async () => {
    const w = await world();
    w.fake.fail('mail.send', new MailCallError('the account is offline', 503, 'offline'));
    w.fake.fail('mail.send', new MailCallError('slow down', 429, 'limited'));
    const { outboxId } = await w.hub.outbox.accept(reply(w));
    await until(() => w.hub.outbox.item(outboxId)!.error?.startsWith('Waiting: the account is offline'), 4000, 'waiting');
    expect(state(w, outboxId)).toBe('queued');
    await until(() => state(w, outboxId) === 'sent', 8000, 'sent after retries');
    expect(w.fake.sent.length).toBe(1);
    expect(w.hub.store.one<{ attempts: number }>('SELECT attempts FROM mail_outbox WHERE id = ?', outboxId)!.attempts).toBeGreaterThanOrEqual(2);
  });

  test('the manager away: waits, and goes when it is back', async () => {
    const w = await world();
    w.hub.outbox.retryMs = [60_000];
    // The composer fetched the original when it opened.
    await w.hub.outbox.compose('reply', msg('<dinner-1@x>'), null);
    w.fake.setConnected(false);
    const { outboxId } = await w.hub.outbox.accept(reply(w));
    await until(() => w.hub.outbox.item(outboxId)!.error?.startsWith('Waiting'), 4000, 'waiting');
    await Bun.sleep(100);
    expect(state(w, outboxId)).toBe('queued');
    w.fake.setConnected(true);
    await until(() => state(w, outboxId) === 'sent', 4000, 'sent after reconnect');
  });

  test('no answer in time: failed, "may have been sent", and the draft kept', async () => {
    const w = await world();
    w.fake.fail('mail.send', new MailCallError('timed out', 504, 'timeout'));
    const req = reply(w, { text: 'Maybe.' });
    const { outboxId } = await w.hub.outbox.accept(req);
    await until(() => state(w, outboxId) === 'failed');
    expect(w.hub.outbox.item(outboxId)).toMatchObject({ unsure: true, error: MAYBE_SENT });
    expect(w.hub.outbox.draft(req.draftKey!)!.draft.text).toBe('Maybe.');
  });

  test('From must be one of the account’s addresses (422, before it is held); an alias goes as itself', async () => {
    const w = await world();
    const e = await w.hub.outbox.accept(reply(w, { from: 'someone@else.example' })).catch((x) => x as MailCallError);
    expect(e).toMatchObject({ status: 422, message: FROM_REFUSED });
    expect(w.hub.outbox.views()).toEqual([]);
    const { outboxId } = await w.hub.outbox.accept(reply(w, { from: 'ME@alias.example' }));
    await until(() => state(w, outboxId) === 'sent');
    expect(w.fake.sent[0].mail.from).toBe(ALIAS);
    // The extractor's own 422 (its list changed meanwhile) fails it with the same words.
    w.fake.fail('mail.send', new MailCallError("from is not one of this account's addresses", 422));
    const second = await w.hub.outbox.accept(reply(w, { from: ALIAS }));
    await until(() => state(w, second.outboxId) === 'failed');
    expect(w.hub.outbox.item(second.outboxId)!.error).toBe(FROM_REFUSED);
  });

  test('the extractor refuses a recipient (422 recipients): named by address, the draft kept, sending stays on', async () => {
    const w = await world({ opts: { refuseRecipient: 3, ids: 'proton', state: 'account', events: 'all', threadIds: true } });
    saysItCan(w);
    // Sam again in Cc, in capitals: counted once, so Jo is 2 and Kim (in Bcc) is 3.
    const req = reply(w, { to: [sam], cc: [{ name: null, email: 'SAM@LEE.EXAMPLE' }, jo], bcc: [kim], text: 'All of you.' });
    const { outboxId } = await w.hub.outbox.accept(req);
    await until(() => state(w, outboxId) === 'failed');
    expect(w.hub.outbox.item(outboxId)!.error).toBe(`${kim.email} has a pinned key in your Proton contacts, so send this one from Proton.`);
    expect(w.hub.outbox.draft(req.draftKey!)!.draft).toMatchObject({ text: 'All of you.', to: [sam], cc: [{ email: 'SAM@LEE.EXAMPLE' }, jo], bcc: [kim] });
    // Only this message: the account can still send, and one to Sam alone goes.
    expect(w.hub.store.accountView(w.hub.store.account(ACC)!).send.ok).toBe(true);
    const next = await w.hub.outbox.accept(reply(w, { text: 'Just you.' }));
    await until(() => state(w, next.outboxId) === 'sent');
    expect(w.fake.sent.map((x) => x.mail.to.map((a) => a.email))).toEqual([[sam.email]]);
  });

  test('recipient N in the sentence: To, Cc, Bcc in order, each address once; a number past the last stays', () => {
    const out = { to: [sam], cc: [{ name: null, email: 'Sam@Lee.Example' }, jo], bcc: [kim, { name: null, email: 'JO@park.example' }] };
    expect(recipientsRefused('Recipient 1 has a pinned key in your Proton contacts, so send this one from Proton.', out)).toBe(`${sam.email} has a pinned key in your Proton contacts, so send this one from Proton.`);
    expect(recipientsRefused('Proton has no key it trusts for recipient 2 or recipient 3, so send this one from Proton', out)).toBe(`Proton has no key it trusts for ${jo.email} or ${kim.email}, so send this one from Proton.`);
    expect(recipientsRefused('Recipient 4 has a pinned key in your Proton contacts, so send this one from Proton..', out)).toBe('Recipient 4 has a pinned key in your Proton contacts, so send this one from Proton.');
    expect(recipientsRefused('recipient 0 and recipient 12 are not on it', out)).toBe('Recipient 0 and recipient 12 are not on it.');
    // Several sharing one reason, as dither-accounts' Proton extractor words them.
    expect(recipientsRefused('Recipients 2 and 3 publish an encryption key, so Proton would encrypt to it; send this one from Proton.', out)).toBe(`${jo.email} and ${kim.email} publish an encryption key, so Proton would encrypt to it; send this one from Proton.`);
    expect(recipientsRefused('Proton gave no key it can encrypt to for recipients 1, 2 and 3, so send this one from Proton.', out)).toBe(`Proton gave no key it can encrypt to for ${sam.email}, ${jo.email} and ${kim.email}, so send this one from Proton.`);
    expect(recipientsRefused('Recipients 1, 2, and 3 have encryption settings', out)).toBe(`${sam.email}, ${jo.email} and ${kim.email} have encryption settings.`);
    expect(recipientsRefused('Recipients 2 and 9 publish an encryption key', out)).toBe('Recipients 2 and 9 publish an encryption key.');
  });

  test('422 by its code: no code and from are the From; failed, settings and others are the extractor’s words, recipients named', async () => {
    const w = await world();
    saysItCan(w);
    const SETTINGS = "Your Proton settings sign mail to outside addresses or attach your public key, which dither-chat can't do yet, so send this one from Proton.";
    const cases: [MailCallError, string][] = [
      [new MailCallError("from is not one of this account's addresses", 422), FROM_REFUSED],
      [new MailCallError("from is not one of this account's addresses", 422, 'from'), FROM_REFUSED],
      [new MailCallError("from is not one of this account's addresses", 422, 'failed'), "From is not one of this account's addresses."],
      // The manager's 'failed' (it passes no extractor code on yet): still the extractor's words, the recipient named.
      [new MailCallError('Recipient 1 has a pinned key in your Proton contacts, so send this one from Proton', 422, 'failed'), `${sam.email} has a pinned key in your Proton contacts, so send this one from Proton.`],
      [new MailCallError(SETTINGS, 422, 'settings'), SETTINGS],
      [new MailCallError('the subject is too long for this account', 422, 'something-new'), 'The subject is too long for this account.'],
    ];
    for (const [e, why] of cases) {
      w.fake.fail('mail.send', e);
      const { outboxId } = await w.hub.outbox.accept(reply(w));
      await until(() => state(w, outboxId) === 'failed');
      expect(w.hub.outbox.item(outboxId)!.error).toBe(why);
    }
    // None of them turns sending off for the account.
    expect(w.hub.store.accountView(w.hub.store.account(ACC)!).send.ok).toBe(true);
    expect(sends(w)).toBe(cases.length);
  });

  test('checked before it is held: recipients, sizes, a file the hub no longer has', async () => {
    const w = await world();
    expect(await status(w, w.hub.outbox.accept(reply(w, { to: [] })))).toBe(400);
    expect(await status(w, w.hub.outbox.accept(reply(w, { to: [{ name: null, email: 'not an address' }] })))).toBe(400);
    expect(await status(w, w.hub.outbox.accept(reply(w, { files: [{ uploadId: 'f'.repeat(24), name: 'gone.txt', mime: 'text/plain', size: 3 }] })))).toBe(410);
    expect(await status(w, w.hub.outbox.accept(reply(w, { clientId: 'x' })))).toBe(400);
    expect(w.hub.outbox.views()).toEqual([]);
  });
});

describe('files', () => {
  test('by path when the manager is on this machine; their uploads go, and so does the outbox’s copy once sent', async () => {
    const w = await world();
    const bytes = new TextEncoder().encode('the ticket, as a PDF would be');
    const up = w.uploads.put(bytes, 'ticket.pdf', 'application/pdf');
    const { outboxId } = await w.hub.outbox.accept(reply(w, { files: [{ uploadId: up.id, name: 'ticket.pdf', mime: 'application/pdf', size: bytes.length }] }));
    await until(() => state(w, outboxId) === 'sent');
    const f = w.fake.sent[0].files;
    expect(f.map((x) => [x.filename, x.mime, x.by])).toEqual([['ticket.pdf', 'application/pdf', 'path']]);
    expect(new TextDecoder().decode(f[0].bytes)).toBe('the ticket, as a PDF would be');
    expect(w.uploads.get([up.id])).toBeNull();
    expect(readdirSync(join(w.dir, 'mail-outbox'))).toEqual([]);
  });

  test('as base64 when the manager is elsewhere', async () => {
    const w = await world();
    w.fake.localFiles = false;
    const up = w.uploads.put(new Uint8Array([0, 1, 2, 250, 251]), 'raw.bin', 'application/octet-stream');
    const { outboxId } = await w.hub.outbox.accept(reply(w, { files: [{ uploadId: up.id, name: 'raw.bin', mime: 'application/octet-stream', size: 5 }] }));
    await until(() => state(w, outboxId) === 'sent');
    expect(w.fake.sent[0].files[0].by).toBe('base64');
    expect([...w.fake.sent[0].files[0].bytes]).toEqual([0, 1, 2, 250, 251]);
  });

  test('a failed send puts its files back on the hub, in its draft', async () => {
    const w = await world({ opts: { send: 501 } });
    saysItCan(w);
    const up = w.uploads.put(new TextEncoder().encode('keep'), 'keep.txt', 'text/plain');
    const req = reply(w, { files: [{ uploadId: up.id, name: 'keep.txt', mime: 'text/plain', size: 4 }] });
    const { outboxId } = await w.hub.outbox.accept(req);
    await until(() => state(w, outboxId) === 'failed');
    const d = w.hub.outbox.draft(req.draftKey!)!.draft;
    expect(d.files.map((f) => f.name)).toEqual(['keep.txt']);
    const again = w.uploads.get([d.files[0].uploadId])!;
    expect(await Bun.file(again[0].path).text()).toBe('keep');
  });

  test('a forward carries the original’s files, fetched from the server', async () => {
    const w = await world();
    const start = await w.hub.outbox.compose('forward', msg('<lease-1@x>'), null, 'UTC');
    expect(start.draft).toMatchObject({ kind: 'forward', subject: 'Fwd: Lease renewal', to: [], from: ALIAS });
    // The inline logo is not offered; the PDF is.
    expect(start.draft.forwardParts.map((p) => p.name)).toEqual(['lease.pdf']);
    expect(start.quote!.head).toContain('---------- Forwarded message ---------');
    const { outboxId } = await w.hub.outbox.accept({ ...start.draft, clientId: cid(), draftKey: start.draftKey, to: [sam], text: 'FYI' });
    await until(() => state(w, outboxId) === 'sent');
    const s = w.fake.sent[0];
    expect(s.mail.subject).toBe('Fwd: Lease renewal');
    expect(s.mail.text).toStartWith('FYI\n\n---------- Forwarded message ---------\nFrom: Jo <jo@park.example>');
    expect(s.mail.text).toContain('The lease, signed.');
    expect(s.files.map((f) => [f.filename, f.bytes.length])).toEqual([['lease.pdf', 3000]]);
    expect(s.files[0].bytes).toEqual(fakeBytes({ id: 'att-lease', size: 3000 }));
  });
});

describe('composing', () => {
  test('reply, reply all and a new message, filled in', async () => {
    const w = await world();
    const r = await w.hub.outbox.compose('reply', msg('<dinner-1@x>'), null, 'UTC');
    expect(r.draft).toMatchObject({ kind: 'reply', accountId: ACC, to: [sam], cc: [], subject: 'Re: Dinner on Friday?', from: ME, replyTo: msg('<dinner-1@x>') });
    expect(r.draftKey).toBe(`t:${thread(w, '<dinner-1@x>')}`);
    expect(r.quote!.head).toMatch(/^On .+, Sam Lee <sam@lee\.example> wrote:$/);
    expect(r.quote!.text).toBe('> Are you free after 7?');
    expect(r.replyAllDiffers).toBe(true);
    expect(r.fromChoices.map((c) => c.email)).toEqual([ME, ALIAS]);
    const all = await w.hub.outbox.compose('replyAll', msg('<dinner-1@x>'), null);
    expect(all.draft).toMatchObject({ to: [sam], cc: [jo] });
    const n = await w.hub.outbox.compose('new', null, null);
    expect(n.draft).toMatchObject({ kind: 'new', accountId: ACC, to: [], subject: '' });
    expect(n.draftKey).toMatch(/^new:[\w-]+$/);
  });

  test('drafts: kept, listed, deleted; a bad key is refused', async () => {
    const w = await world();
    w.hub.outbox.putDraft('new:abcdefgh-1234', { accountId: ACC, kind: 'new', to: [sam], subject: 'Hi', text: 'Draft text' });
    expect(w.hub.outbox.drafts().map((d) => [d.key, d.draft.text])).toEqual([['new:abcdefgh-1234', 'Draft text']]);
    expect(() => w.hub.outbox.putDraft('../etc', { accountId: ACC })).toThrow();
    w.hub.outbox.deleteDraft('new:abcdefgh-1234');
    expect(w.hub.outbox.drafts()).toEqual([]);
  });

  test('addresses as you type: those you wrote to first, never your own', async () => {
    const w = await world();
    const sent = await w.hub.outbox.accept(reply(w, { to: [{ name: 'Sammy', email: 'sammy@other.example' }] }));
    await until(() => state(w, sent.outboxId) === 'sent');
    await until(() => w.hub.store.one(`SELECT 1 FROM mail_message WHERE addressed = 'self'`), 4000, 'the Sent copy');
    const hits = w.hub.outbox.addresses('sam');
    expect(hits[0]).toMatchObject({ email: 'sammy@other.example', wroteTo: true });
    expect(hits.map((h) => h.email)).toContain('sam@lee.example');
    expect(w.hub.outbox.addresses('me@')).toEqual([]);
  });
});

describe('once, and across a restart', () => {
  test('the same clientId twice is one send, before and after it went', async () => {
    const w = await world();
    const req = reply(w);
    const a = await w.hub.outbox.accept(req);
    const b = await w.hub.outbox.accept(req);
    expect(b.outboxId).toBe(a.outboxId);
    await until(() => state(w, a.outboxId) === 'sent');
    const c = await w.hub.outbox.accept(req);
    expect(c).toEqual({ outboxId: a.outboxId, state: 'sent' });
    await Bun.sleep(100);
    expect(sends(w)).toBe(1);
    expect(w.hub.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_outbox')!.n).toBe(1);
  });

  test('through the routes: compose, send, undo', async () => {
    const w = await world({ holdMs: 2000 });
    const call = (method: string, path: string, body?: unknown) => w.hub.route(new Request(`http://hub${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), new URL(`http://hub${path}`));
    const start = (await (await call('GET', `/api/mail/compose?kind=reply&message=${msg('<dinner-1@x>')}&tz=UTC`))!.json()) as P.MailComposeStart;
    expect(start.draft.to).toEqual([sam]);
    const sent = await call('POST', '/api/mail/send', { ...start.draft, clientId: cid(), draftKey: start.draftKey, text: 'Via the route' });
    const j = (await sent!.json()) as { ok: boolean; outboxId: string; item: P.MailOutboxView };
    expect(j).toMatchObject({ ok: true, item: { state: 'held' } });
    const undo = (await (await call('DELETE', `/api/mail/outbox/${j.outboxId}`))!.json()) as { draftKey: string; draft: P.MailDraft };
    expect(undo).toMatchObject({ draftKey: start.draftKey, draft: { text: 'Via the route' } });
    const d = await call('GET', `/api/mail/drafts/${encodeURIComponent(start.draftKey)}`);
    expect(((await d!.json()) as P.MailDraftView).draft.text).toBe('Via the route');
    const one = (await (await call('GET', `/api/mail/drafts?key=${encodeURIComponent(start.draftKey)}`))!.json()) as { drafts: P.MailDraftView[] };
    expect(one.drafts.map((x) => x.draft.text)).toEqual(['Via the route']);
    // A thread with no draft: none, and not an error.
    const none = await call('GET', `/api/mail/drafts?key=${encodeURIComponent(`t:${thread(w, '<lease-1@x>')}`)}`);
    expect([none!.status, ((await none!.json()) as { drafts: unknown[] }).drafts]).toEqual([200, []]);
    const refused = await call('POST', '/api/mail/send', { ...start.draft, clientId: cid(), from: 'x@y.example' });
    expect(refused!.status).toBe(422);
  });

  test('a send the hub stopped in the middle of: may have been sent, draft kept; a held one goes after the restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dither-mail-send-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new Database(':memory:', { strict: true });
    const w = await world({ db, dir, holdMs: 60_000 });
    const req = reply(w, { text: 'Mid-send.' });
    const a = await w.hub.outbox.accept(req);
    const b = await w.hub.outbox.accept(reply(w, { kind: 'new', replyTo: null, draftKey: null, subject: 'Hello', text: 'Held over.' }));
    w.hub.stop();
    db.query(`UPDATE mail_outbox SET state = 'sending' WHERE id = ?`).run(a.outboxId);
    db.query(`UPDATE mail_outbox SET hold_until = ? WHERE id = ?`).run(Date.now() - 1, b.outboxId);
    const fake = new FakeMailBackend();
    fake.addAccount(ACC, { email: ME, addresses: [{ email: ME, name: null }] });
    const again = new MailHub({ db, backend: fake, log: () => {}, dataDir: dir });
    again.outbox.files = w.uploads;
    again.start();
    cleanup.push(() => again.stop());
    expect(again.outbox.item(a.outboxId)).toMatchObject({ state: 'failed', unsure: true, error: STOPPED_SENDING });
    expect(again.outbox.draft(req.draftKey!)!.draft.text).toBe('Mid-send.');
    await until(() => again.outbox.item(b.outboxId)?.state === 'sent', 4000, 'the held one sent');
    expect(fake.sent.map((s) => s.mail.text?.split('\n')[0])).toEqual(['Held over.']);
  });
});

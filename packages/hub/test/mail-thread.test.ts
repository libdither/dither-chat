/**
 * Threading (mail/thread.ts, docs/mail-design.md §2.3) as a table: each case gives the threads already held and one
 * message, and says where it goes. Message-IDs keep their angle brackets, as dither-accounts writes them.
 */
import { describe, expect, test } from 'bun:test';
import { mailId } from '@dither-chat/protocol/ids';
import { genericSubject, nativeThreadId, normalizeSubject, placeMessage, refsToTry, type ThreadInfo, type ThreadInput, type ThreadLookup } from '../src/mail/thread.ts';

const ACC = 'acc_mailTest01';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);

interface World {
  refs?: Record<string, string>;
  threads?: (Partial<ThreadInfo> & { id: string; subject?: string })[];
}

function lookup(w: World): ThreadLookup {
  const threads = (w.threads ?? []).map((t) => ({ firstAt: T0, lastAt: T0, others: [], native: false, subject: '', ...t }));
  return {
    byRef: (r) => w.refs?.[r] ?? null,
    info: (id) => threads.find((t) => t.id === id) ?? null,
    bySubject: (key, at, gap) => threads.filter((t) => normalizeSubject(t.subject) === key && t.lastAt >= at - gap && t.firstAt <= at + gap),
  };
}

const msg = (m: Partial<ThreadInput>): ThreadInput => ({
  accountId: ACC,
  key: `m:${m.messageId ?? '<x@y>'}`,
  messageId: '<new@example.org>',
  threadId: null,
  inReplyTo: null,
  references: [],
  subject: 'Lease renewal',
  at: T0 + DAY,
  others: ['alice@example.org'],
  ...m,
});

const fresh = (m: ThreadInput) => mailId('mth', ACC, `r:${m.messageId ?? m.key}`);

describe('subjects', () => {
  test.each([
    ['Re: Lease renewal', 'lease renewal'],
    ['RE: Fwd: AW: Lease  renewal ', 'lease renewal'],
    ['[dither-dev] Re: [dither-dev] Release 0.4', 'release 0.4'],
    ['Re[2]: Lease renewal', 'lease renewal'],
    ['SV: Vs: Antw: Hello there', 'hello there'],
    ['', ''],
  ])('%p is %p', (s, key) => expect(normalizeSubject(s)).toBe(key));

  test('empty and common subjects are generic', () => {
    for (const s of ['', 'hi', 'Hello', 'Re: question', '(no subject)', 'ok']) expect(genericSubject(normalizeSubject(s))).toBe(true);
    expect(genericSubject(normalizeSubject('Lease renewal'))).toBe(false);
  });

  test('references are tried In-Reply-To first, then newest first, then its own id', () => {
    expect(refsToTry({ inReplyTo: '<c@x>', references: ['<a@x>', '<b@x>', '<c@x>'], messageId: '<d@x>' })).toEqual(['<c@x>', '<b@x>', '<a@x>', '<d@x>']);
  });
});

describe('where a message goes', () => {
  const cases: { name: string; world: World; m: Partial<ThreadInput>; want: (m: ThreadInput) => { threadId: string; by: string; merge?: string[] } }[] = [
    {
      name: "the server's thread (Gmail, Proton)",
      world: {},
      m: { threadId: 'gm-123' },
      want: () => ({ threadId: nativeThreadId(ACC, 'gm-123'), by: 'native' }),
    },
    {
      name: "the server's thread wins over a reference to another server thread",
      world: { refs: { '<a@x>': nativeThreadId(ACC, 'other') }, threads: [{ id: nativeThreadId(ACC, 'other'), native: true }] },
      m: { threadId: 'gm-123', inReplyTo: '<a@x>' },
      want: () => ({ threadId: nativeThreadId(ACC, 'gm-123'), by: 'native', merge: [] }),
    },
    {
      name: 'In-Reply-To on the summary (plain IMAP with the new headers)',
      world: { refs: { '<a@x>': 'mth_A' }, threads: [{ id: 'mth_A' }] },
      m: { inReplyTo: '<a@x>', references: ['<a@x>'] },
      want: () => ({ threadId: 'mth_A', by: 'ref' }),
    },
    {
      name: 'References when In-Reply-To is unknown (its parent never arrived)',
      world: { refs: { '<root@x>': 'mth_A' }, threads: [{ id: 'mth_A' }] },
      m: { inReplyTo: '<missing@x>', references: ['<root@x>', '<missing@x>'] },
      want: () => ({ threadId: 'mth_A', by: 'ref' }),
    },
    {
      name: 'a reply arrived first: the parent joins it by its own Message-ID',
      world: { refs: { '<parent@x>': 'mth_Child' }, threads: [{ id: 'mth_Child' }] },
      m: { messageId: '<parent@x>' },
      want: () => ({ threadId: 'mth_Child', by: 'ref' }),
    },
    {
      name: 'brackets are part of the id: a bare id does not match a bracketed one',
      world: { refs: { '<a@x>': 'mth_A' }, threads: [{ id: 'mth_A', subject: 'Other' }] },
      m: { inReplyTo: 'a@x', subject: 'Something else' },
      want: (m) => ({ threadId: fresh(m), by: 'new' }),
    },
    {
      name: 'a message linking two threads merges them into the older',
      world: {
        refs: { '<a@x>': 'mth_Old', '<b@x>': 'mth_New' },
        threads: [
          { id: 'mth_New', firstAt: T0 + 2 * DAY },
          { id: 'mth_Old', firstAt: T0 },
        ],
      },
      m: { inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'] },
      want: () => ({ threadId: 'mth_Old', by: 'ref', merge: ['mth_New'] }),
    },
    {
      name: 'no headers (a summary from plain IMAP before §13): same subject, someone in common, within 14 days',
      world: { threads: [{ id: 'mth_S', subject: 'Lease renewal', lastAt: T0, others: ['alice@example.org', 'jo@example.org'] }] },
      m: { subject: 'Re: Lease renewal', at: T0 + 3 * DAY, others: ['jo@example.org'] },
      want: () => ({ threadId: 'mth_S', by: 'subject' }),
    },
    {
      name: 'same subject, nobody in common: a thread of its own',
      world: { threads: [{ id: 'mth_S', subject: 'Lease renewal', others: ['alice@example.org'] }] },
      m: { subject: 'Re: Lease renewal', others: ['bob@example.org'] },
      want: (m) => ({ threadId: fresh(m), by: 'new' }),
    },
    {
      name: 'same subject, too far apart',
      world: { threads: [{ id: 'mth_S', subject: 'Lease renewal', lastAt: T0, others: ['alice@example.org'] }] },
      m: { subject: 'Lease renewal', at: T0 + 20 * DAY },
      want: (m) => ({ threadId: fresh(m), by: 'new' }),
    },
    {
      name: 'a generic subject never merges',
      world: { threads: [{ id: 'mth_S', subject: 'Hi', others: ['alice@example.org'] }] },
      m: { subject: 'Re: hi' },
      want: (m) => ({ threadId: fresh(m), by: 'new' }),
    },
    {
      name: 'the subject rule never joins a server thread',
      world: { threads: [{ id: 'mth_N', subject: 'Lease renewal', others: ['alice@example.org'], native: true }] },
      m: { subject: 'Lease renewal' },
      want: (m) => ({ threadId: fresh(m), by: 'new' }),
    },
    {
      name: 'references win over a subject match',
      world: { refs: { '<a@x>': 'mth_R' }, threads: [{ id: 'mth_R', subject: 'Other' }, { id: 'mth_S', subject: 'Lease renewal', others: ['alice@example.org'] }] },
      m: { inReplyTo: '<a@x>' },
      want: () => ({ threadId: 'mth_R', by: 'ref' }),
    },
    {
      name: 'no Message-ID at all: a thread keyed by the message',
      world: {},
      m: { messageId: null, key: 'x:INBOX/INBOX.1.7', subject: 'Hello' },
      want: () => ({ threadId: mailId('mth', ACC, 'r:x:INBOX/INBOX.1.7'), by: 'new' }),
    },
  ];
  for (const c of cases)
    test(c.name, () => {
      const m = msg(c.m);
      const got = placeMessage(m, lookup(c.world));
      const want = c.want(m);
      expect(got.threadId).toBe(want.threadId);
      expect(got.by).toBe(want.by as any);
      expect(got.merge).toEqual(want.merge ?? []);
    });
});

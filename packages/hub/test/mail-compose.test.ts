/**
 * Building replies and forwards (mail/compose.ts, docs/mail-design.md §8): who a reply goes to, subjects, the quote and
 * the forwarded block, and the HTML made from the text. Pure.
 */
import { describe, expect, test } from 'bun:test';
import { quoteStart } from '@dither-chat/protocol';
import {
  attribution,
  forwardBlock,
  forwardSubject,
  messageHtml,
  messageText,
  parseAddress,
  quoteLines,
  replyAllDiffers,
  replyFrom,
  replyRecipients,
  replySubject,
  tail,
  textHtml,
  type ComposeOriginal,
} from '../src/mail/compose.ts';

const me = { name: 'Zyan', email: 'zyan@dither.example' };
const alias = { name: 'Zyan', email: 'z@alias.example' };
const sam = { name: 'Sam Lee', email: 'sam@lee.example' };
const jo = { name: 'Jo', email: 'jo@park.example' };
const alex = { name: 'Alex', email: 'alex@example.org' };
const self = new Set([me.email, alias.email]);
// Tue, Nov 3, 2026, 10:42 in New York.
const DATE = Date.UTC(2026, 10, 3, 15, 42);

const orig = (o: Partial<ComposeOriginal> = {}): ComposeOriginal => ({ from: sam, to: [me], cc: [], replyTo: [], subject: 'Dinner on Friday?', date: DATE, text: 'Are you free after 7?', ...o });
const emails = (l: { email: string }[]) => l.map((a) => a.email);

describe('recipients', () => {
  const cases: [string, Partial<ComposeOriginal>, boolean, string[], string[]][] = [
    ['reply goes to the sender', {}, false, [sam.email], []],
    ['reply goes to Reply-To when there is one', { replyTo: [{ name: 'Lists', email: 'list@lee.example' }] }, false, ['list@lee.example'], []],
    ['reply all adds To and Cc, without me', { to: [me, jo], cc: [alex, alias] }, true, [sam.email, jo.email], [alex.email]],
    ['reply all: Reply-To, then the others', { replyTo: [{ name: null, email: 'list@lee.example' }], to: [me, jo] }, true, ['list@lee.example', jo.email], []],
    ['reply all: someone in both To and Cc is in To once', { to: [me, jo], cc: [jo, { name: 'JO', email: 'JO@park.example' }] }, true, [sam.email, jo.email], []],
    ['reply to my own message: to whom it went', { from: me, to: [sam, jo] }, false, [sam.email, jo.email], []],
    ['reply all to my own message: its To and Cc', { from: alias, to: [sam], cc: [jo, me] }, true, [sam.email], [jo.email]],
    ['reply to a message I sent only to myself: to me', { from: me, to: [me] }, false, [me.email], []],
    ['reply all where only I was besides them: still them', { to: [me], cc: [alias] }, true, [sam.email], []],
    ['addresses that are not addresses are left out', { to: [me, { name: 'x', email: 'undisclosed-recipients:;' }] }, true, [sam.email], []],
  ];
  for (const [name, o, all, to, cc] of cases)
    test(name, () => {
      const r = replyRecipients(orig(o), self, all);
      expect(emails(r.to)).toEqual(to);
      expect(emails(r.cc)).toEqual(cc);
    });

  test('names come along, and the first spelling of an address is kept', () => {
    const r = replyRecipients(orig({ to: [me, { name: 'Jo Park', email: 'Jo@Park.example' }], cc: [jo] }), self, true);
    expect(r.to).toEqual([sam, { name: 'Jo Park', email: 'Jo@Park.example' }]);
    expect(r.cc).toEqual([]);
  });

  test('reply all is offered only when it reaches someone more', () => {
    expect(replyAllDiffers(orig(), self)).toBe(false);
    expect(replyAllDiffers(orig({ to: [me, jo] }), self)).toBe(true);
    expect(replyAllDiffers(orig({ cc: [alias] }), self)).toBe(false);
  });

  test('a reply goes from the address the original came to', () => {
    const addresses = [me, alias];
    expect(replyFrom(orig({ to: [alias] }), addresses)).toBe(alias.email);
    expect(replyFrom(orig({ to: [jo], cc: [{ name: null, email: 'Z@ALIAS.example' }] }), addresses)).toBe(alias.email);
    expect(replyFrom(orig({ to: [jo] }), addresses)).toBeNull();
    expect(replyFrom(orig({ from: alias, to: [sam] }), addresses)).toBe(alias.email);
  });

  test('typed addresses', () => {
    expect(parseAddress('Sam Lee <sam@lee.example>')).toEqual(sam);
    expect(parseAddress('"Lee, Sam" <sam@lee.example>')).toEqual({ name: 'Lee, Sam', email: 'sam@lee.example' });
    expect(parseAddress('  sam@lee.example ')).toEqual({ name: null, email: 'sam@lee.example' });
    expect(parseAddress('sam')).toBeNull();
    expect(parseAddress('a@b')).toBeNull();
    expect(parseAddress('a b@c.example')).toBeNull();
  });
});

describe('subjects', () => {
  const cases: [string, string, string][] = [
    ['Dinner', 'Re: Dinner', 'Fwd: Dinner'],
    ['Re: Dinner', 'Re: Dinner', 'Fwd: Re: Dinner'],
    ['RE: re: Re[2]: Dinner', 'Re: Dinner', 'Fwd: RE: re: Re[2]: Dinner'],
    ['AW: Termin', 'Re: Termin', 'Fwd: AW: Termin'],
    ['Fwd: Photos', 'Re: Fwd: Photos', 'Fwd: Photos'],
    ['FW: fw: Photos', 'Re: FW: fw: Photos', 'Fwd: Photos'],
    ['[list] Weekly', 'Re: [list] Weekly', 'Fwd: [list] Weekly'],
    ['', 'Re:', 'Fwd:'],
  ];
  for (const [s, re, fwd] of cases)
    test(JSON.stringify(s), () => {
      expect(replySubject(s)).toBe(re);
      expect(forwardSubject(s)).toBe(fwd);
    });
});

describe('quotes', () => {
  test('"On <date>, <name> wrote:" in the page’s time zone', () => {
    expect(attribution(orig(), 'America/New_York')).toBe('On Tue, Nov 3, 2026 at 10:42 AM, Sam Lee <sam@lee.example> wrote:');
    expect(attribution(orig({ from: { name: null, email: 'sam@lee.example' } }), 'UTC')).toBe('On Tue, Nov 3, 2026 at 3:42 PM, sam@lee.example wrote:');
    // A zone that is not one falls back to the hub's own, without failing.
    expect(attribution(orig(), 'Nowhere/Else')).toContain('Sam Lee <sam@lee.example> wrote:');
  });

  test('each line quoted; quoted lines once more; blank ones as >; trailing space gone', () => {
    expect(quoteLines('Hi\n\nSee below\n> earlier\n>> older\n\n\n')).toBe('> Hi\n>\n> See below\n>> earlier\n>>> older');
    expect(quoteLines('a\r\nb')).toBe('> a\n> b');
    expect(quoteLines(null)).toBe('');
  });

  test('a long original is cut, and says so', () => {
    const q = quoteLines('x'.repeat(70_000));
    expect(q.length).toBeLessThan(66_000);
    expect(q.endsWith('> […]')).toBe(true);
  });

  test('a reply’s text: yours, a blank line, the quote; the reader folds the quote', () => {
    const t = messageText('Yes, 7:30 works.', tail('reply', orig(), true, 'America/New_York'));
    expect(t).toBe('Yes, 7:30 works.\n\nOn Tue, Nov 3, 2026 at 10:42 AM, Sam Lee <sam@lee.example> wrote:\n> Are you free after 7?\n');
    expect(t.slice(0, quoteStart(t)!)).toBe('Yes, 7:30 works.\n\n');
  });

  test('without the quote, and a new message: only yours', () => {
    expect(messageText('Yes.\n\n', tail('reply', orig(), false))).toBe('Yes.');
    expect(messageText('Hello', tail('new', null, true))).toBe('Hello');
  });

  test('a forward: its headers, then its text; the reader folds it too', () => {
    const f = forwardBlock(orig({ to: [me], cc: [jo] }), 'America/New_York');
    expect(f.head).toBe(
      ['---------- Forwarded message ---------', 'From: Sam Lee <sam@lee.example>', 'Date: Tue, Nov 3, 2026 at 10:42 AM', 'Subject: Dinner on Friday?', 'To: Zyan <zyan@dither.example>', 'Cc: Jo <jo@park.example>'].join('\n'),
    );
    const t = messageText('FYI', f);
    expect(t.endsWith('Are you free after 7?\n')).toBe(true);
    expect(t.slice(0, quoteStart(t)!)).toBe('FYI\n\n');
    // The quote is always there for a forward, whatever `quote` says.
    expect(tail('forward', orig(), false)?.head).toContain('Forwarded message');
  });
});

describe('HTML', () => {
  test('escaped, with links and line breaks; > blocks become quotes', () => {
    expect(textHtml('a <b> & "c"\nsee https://ex.example/a?b=1&c=2.\n> quoted\n> more\nend')).toBe(
      'a &lt;b&gt; &amp; &quot;c&quot;<br>see <a href="https://ex.example/a?b=1&amp;c=2">https://ex.example/a?b=1&amp;c=2</a>.' +
        '<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">quoted<br>more</blockquote>end',
    );
  });

  test('a reply quotes the original in a blockquote; no script gets through', () => {
    const h = messageHtml('reply', 'Sure <b>', orig({ text: 'Hi <script>alert(1)</script>' }), true, 'UTC');
    expect(h).toContain('<div dir="auto">Sure &lt;b&gt;</div>');
    expect(h).toContain('<div class="dc-quote-head">On Tue, Nov 3, 2026 at 3:42 PM, Sam Lee &lt;sam@lee.example&gt; wrote:</div><blockquote type="cite"');
    expect(h).toContain('Hi &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(h).not.toContain('<script');
    expect(messageHtml('reply', 'Sure', orig(), false)).toBe('<div dir="auto">Sure</div>');
  });

  test('a forward carries its block', () => {
    const h = messageHtml('forward', '', orig(), true, 'UTC');
    expect(h).toContain('---------- Forwarded message ---------<br>From: Sam Lee &lt;sam@lee.example&gt;');
    expect(h).toContain('Are you free after 7?');
  });
});

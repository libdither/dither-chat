/**
 * Building a message to send (docs/mail-design.md §8): who a reply goes to, its subject, the quote or the forwarded
 * block, and the HTML made from the text. Pure: the outbox (outbox.ts) gives it the original as the hub holds it, and
 * mail-compose.test.ts tests it as a table.
 *
 *   reply      To is the original's Reply-To, else its From; to your own message, its To again
 *   reply all  adds its To and Cc, without your addresses
 *   subject    `Re: ` once (`Fwd: ` for a forward), whatever prefixes it had
 *   quote      "On <date>, <name> wrote:" and the original's text with `> ` before each line
 *   forward    a "Forwarded message" block with its headers, then its text; its attachments go along
 *
 * The HTML part is the text made into HTML. The original's own HTML would quote better; that needs slice 3's sanitiser,
 * and `quotedHtml` is where it plugs in.
 */
import type * as P from '@dither-chat/protocol';
import { parseMailAddress, validMailAddress } from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';

/** The message answered or forwarded, as compose needs it. */
export interface ComposeOriginal {
  from: M.MailAddress;
  to: M.MailAddress[];
  cc: M.MailAddress[];
  replyTo: M.MailAddress[];
  subject: string;
  date: number;
  text: string | null;
  /** Its HTML, for slice 3's sanitised quote; unused until then. */
  html?: string | null;
}

const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** The address check and parser are shared with the composer (protocol mail.ts). */
export const validEmail = validMailAddress;
export const parseAddress = parseMailAddress;

// ------------------------------------------------------------------ subjects

const REPLY_PREFIX = /^\s*(?:re|aw|sv|vs|antw|rif|r|odp|ré)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i;
const FORWARD_PREFIX = /^\s*(?:fwd?|wg|tr|enc|rv|doorst)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i;

function strip(subject: string, prefix: RegExp): string {
  let s = (subject ?? '').trim();
  for (let i = 0; i < 20; i++) {
    const next = s.replace(prefix, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** `Re: ` once, in front of the subject without the reply markers it had (`RE:`, `AW:`, `Re[2]:`). */
export function replySubject(subject: string): string {
  return `Re: ${strip(subject, REPLY_PREFIX)}`.trim();
}

/** `Fwd: ` once, in front of the subject without the forward markers it had (`FW:`, `WG:`). */
export function forwardSubject(subject: string): string {
  return `Fwd: ${strip(subject, FORWARD_PREFIX)}`.trim();
}

// ------------------------------------------------------------------ recipients

/** The same address once (the first spelling of its name), in order. */
export function dedupe(list: M.MailAddress[], without: Set<string> = new Set()): M.MailAddress[] {
  const seen = new Set(without);
  const out: M.MailAddress[] = [];
  for (const a of list) {
    const e = lc(a?.email);
    if (!e || !validEmail(e) || seen.has(e)) continue;
    seen.add(e);
    out.push({ name: a.name ?? null, email: a.email.trim() });
  }
  return out;
}

/**
 * Who a reply goes to. `self`: your addresses, lower case. A reply to your own message goes to whom it went to; reply
 * all leaves you out, and anyone in To is not in Cc as well.
 */
export function replyRecipients(o: ComposeOriginal, self: Set<string>, all: boolean): { to: M.MailAddress[]; cc: M.MailAddress[] } {
  const mine = self.has(lc(o.from.email));
  const answer = o.replyTo.length ? o.replyTo : [o.from];
  if (mine) {
    // Your own message: to the same people again (you, if you wrote only to yourself).
    const to = dedupe(o.to);
    if (!all) return { to, cc: [] };
    const toAll = dedupe(o.to, self);
    const ccAll = dedupe(o.cc, new Set([...self, ...toAll.map((a) => lc(a.email))]));
    return toAll.length || ccAll.length ? { to: toAll, cc: ccAll } : { to, cc: [] };
  }
  if (!all) return { to: dedupe(answer), cc: [] };
  const to = dedupe([...answer, ...o.to], self);
  const cc = dedupe(o.cc, new Set([...self, ...to.map((a) => lc(a.email))]));
  // Only you were on it besides them: still them.
  return { to: to.length ? to : dedupe(answer), cc };
}

/** Reply all reaches someone a reply does not. */
export function replyAllDiffers(o: ComposeOriginal, self: Set<string>): boolean {
  const one = replyRecipients(o, self, false);
  const all = replyRecipients(o, self, true);
  const key = (r: { to: M.MailAddress[]; cc: M.MailAddress[] }) => new Set([...r.to, ...r.cc].map((a) => lc(a.email)));
  const a = key(one);
  return [...key(all)].some((e) => !a.has(e));
}

/**
 * Which of your addresses a reply goes from: the one the original was sent to (in To, then Cc), else the original's
 * own From when it was yours; null: the account's first.
 */
export function replyFrom(o: ComposeOriginal, addresses: { email: string }[]): string | null {
  const mine = new Map(addresses.map((a) => [lc(a.email), a.email]));
  for (const a of [...o.to, ...o.cc, o.from]) {
    const hit = mine.get(lc(a?.email));
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------------ quotes

/** "Tue, Nov 3, 2026 at 10:42 AM", in `tz` (the page's time zone) when it is a real one. */
export function quoteDate(ts: number, tz?: string): string {
  const zone = tz && validZone(tz) ? tz : undefined;
  const d = new Date(ts);
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: zone }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(d);
  return `${day} at ${time}`;
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const addressText = (a: M.MailAddress) => (a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email);

/** "On Tue, Nov 3, 2026 at 10:42 AM, Sam Lee <sam@lee.example> wrote:" (thread readers fold from this line). */
export function attribution(o: ComposeOriginal, tz?: string): string {
  return `On ${quoteDate(o.date, tz)}, ${addressText(o.from)} wrote:`;
}

/** Quoted text is cut here: a quote longer than this ends in a line saying so. */
export const QUOTE_MAX = 64 * 1024;

/** The original's text with `> ` before each line (`>` before one already quoted, and alone on an empty one). */
export function quoteLines(text: string | null): string {
  let t = (text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  let cut = false;
  if (t.length > QUOTE_MAX) {
    t = t.slice(0, QUOTE_MAX);
    cut = true;
  }
  const lines = t ? t.split('\n').map((l) => (!l ? '>' : l.startsWith('>') ? `>${l}` : `> ${l}`)) : [];
  if (cut) lines.push('> […]');
  return lines.join('\n');
}

/** The block a forward carries: its headers, then its text. */
export function forwardBlock(o: ComposeOriginal, tz?: string): { head: string; text: string } {
  const head = [
    '---------- Forwarded message ---------',
    `From: ${addressText(o.from)}`,
    `Date: ${quoteDate(o.date, tz)}`,
    `Subject: ${o.subject}`,
    ...(o.to.length ? [`To: ${o.to.map(addressText).join(', ')}`] : []),
    ...(o.cc.length ? [`Cc: ${o.cc.map(addressText).join(', ')}`] : []),
  ].join('\n');
  let text = (o.text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (text.length > QUOTE_MAX * 4) text = `${text.slice(0, QUOTE_MAX * 4)}\n[…]`;
  return { head, text };
}

/** What follows your text: the quote of a reply, or a forward's block; null for none. */
export function tail(kind: P.MailComposeKind, o: ComposeOriginal | null, quote: boolean, tz?: string): { head: string; text: string } | null {
  if (!o) return null;
  if (kind === 'forward') return forwardBlock(o, tz);
  if ((kind === 'reply' || kind === 'replyAll') && quote) return { head: attribution(o, tz), text: quoteLines(o.text) };
  return null;
}

/** The text part: yours, then the quote or the forwarded message. */
export function messageText(own: string, t: { head: string; text: string } | null): string {
  const mine = own.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!t) return mine;
  return `${mine ? `${mine}\n\n` : ''}${t.head}\n${t.text ? `${t.text}\n` : ''}`;
}

// ------------------------------------------------------------------ HTML

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

const LINK = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Text as HTML: escaped, links made links, line breaks kept, `>` blocks as quotes. */
export function textHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const line = (l: string) => escapeHtml(l).replace(LINK, (u) => `<a href="${u}">${u}</a>`);
  for (let i = 0; i < lines.length; ) {
    if (/^>/.test(lines[i])) {
      const block: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) block.push(lines[i++].replace(/^> ?/, ''));
      out.push(`<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${textHtml(block.join('\n'))}</blockquote>`);
      continue;
    }
    out.push(`${line(lines[i])}${i < lines.length - 1 && !/^>/.test(lines[i + 1]) ? '<br>' : ''}`);
    i++;
  }
  return out.join('');
}

/**
 * The original's HTML, made safe to quote: slice 3's sanitiser (images off). Null until it lands, and the quote is
 * made from the original's text instead.
 */
export function quotedHtml(_html: string | null | undefined): string | null {
  return null;
}

/** The HTML part: your text, then the quote in a `blockquote type=cite`, or the forwarded block. */
export function messageHtml(kind: P.MailComposeKind, own: string, o: ComposeOriginal | null, quote: boolean, tz?: string): string {
  const mine = own.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const parts = [`<div dir="auto">${textHtml(mine)}</div>`];
  if (o && kind === 'forward') {
    const f = forwardBlock(o, tz);
    parts.push(`<br><div class="dc-forward">${textHtml(f.head)}<br><br>${quotedHtml(o.html) ?? textHtml(f.text)}</div>`);
  } else if (o && quote && (kind === 'reply' || kind === 'replyAll')) {
    const body = quotedHtml(o.html) ?? textHtml((o.text ?? '').replace(/\s+$/, '').slice(0, QUOTE_MAX));
    parts.push(`<br><div class="dc-quote-head">${escapeHtml(attribution(o, tz))}</div><blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote>`);
  }
  return parts.join('');
}

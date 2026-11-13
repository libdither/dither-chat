/**
 * Renders the canonical message body (Discord-flavoured Markdown subset, see
 * protocol MessageFact.body) to HTML. Everything is escaped first; only the
 * constructs below produce markup, and links are limited to http(s).
 */
import type { Network } from '@dither-chat/protocol';
import { BARE_INVITE } from './invites.ts';

export interface MdContext {
  network: Network;
  user: (nativeId: string) => { name: string; self: boolean } | null;
  room: (nativeId: string) => string | null;
  /** A role named as <@&id>, from the message's own `rich.roles`; absent or null: "@role". */
  role?: (id: string) => { name: string; color?: string } | null;
  /** Now, for <t:…:R> (relative times); Date.now() when absent. */
  now?: number;
}

/** Discord's links to a server's own pages (<id:guide> and the like), as its client names them. */
const SERVER_PAGES: Record<string, string> = { guide: 'Server Guide', customize: 'Channels & Roles', browse: 'Browse Channels', 'linked-roles': 'Linked Roles', home: 'Server Guide' };

/** A <t:…> timestamp in one of Discord's styles: t T d D f F R (f when none is given). */
export function timestampText(sec: number, style: string, now = Date.now()): string {
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return String(sec);
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, o).format(d);
  switch (style) {
    case 't':
      return fmt({ hour: 'numeric', minute: '2-digit' });
    case 'T':
      return fmt({ hour: 'numeric', minute: '2-digit', second: '2-digit' });
    case 'd':
      return fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
    case 'D':
      return fmt({ year: 'numeric', month: 'long', day: 'numeric' });
    case 'F':
      return fmt({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    case 'R': {
      const s = Math.round((d.getTime() - now) / 1000);
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
      const steps: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]];
      for (const [unit, n] of steps) if (Math.abs(s) >= n) return rtf.format(Math.trunc(s / n), unit);
      return rtf.format(s, 'second');
    }
    default:
      return fmt({ year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
}

/** One list line: how deep (two spaces a level), numbered or not, and its text. */
interface ListLine {
  level: number;
  ordered: boolean;
  start: number;
  text: string;
}

/** Consecutive list lines as nested lists: a deeper line opens a list inside the item before it. */
function listHtml(lines: ListLine[]): string {
  let html = '';
  const open: ListLine[] = [];
  const close = () => (html += `</li></${open.pop()!.ordered ? 'ol' : 'ul'}>`);
  const start = (l: ListLine) => {
    html += l.ordered ? `<ol${l.start !== 1 ? ` start="${l.start}"` : ''}><li>` : '<ul><li>';
    open.push(l);
  };
  for (const l of lines) {
    while (open.length && open[open.length - 1].level > l.level) close();
    const top = open[open.length - 1];
    if (!top || top.level < l.level) start(l);
    else if (top.ordered !== l.ordered) (close(), start(l));
    else html += '</li><li>';
    html += l.text;
  }
  while (open.length) close();
  return html;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderMarkdown(src: string, ctx: MdContext): string {
  const slots: string[] = [];
  const slot = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  // Fenced code first: nothing inside is interpreted.
  let s = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => slot(`<pre class="md-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(code.replace(/\n$/, ''))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => slot(`<code class="md-inline">${esc(code)}</code>`));
  // Mentions and room links before escaping eats the angle brackets.
  s = s.replace(/<@&(\d+)>/g, (_, id) => {
    const r = ctx.role?.(id);
    const color = r?.color && /^#[0-9a-f]{6}$/i.test(r.color) ? ` style="color:${r.color}"` : '';
    return slot(`<span class="mention role"${color}>@${esc(r?.name ?? 'role')}</span>`);
  });
  s = s.replace(/<id:([a-z-]+)>/g, (all, page) => (SERVER_PAGES[page] ? slot(`<span class="mention room">#${esc(SERVER_PAGES[page])}</span>`) : all));
  s = s.replace(/<t:(-?\d{1,13})(?::([tTdDfFR]))?>/g, (_, sec, style) =>
    slot(`<time class="md-time" title="${esc(timestampText(+sec, 'F'))}">${esc(timestampText(+sec, style ?? 'f', ctx.now))}</time>`),
  );
  s = s.replace(/<@!?([^>\s]+)>/g, (_, id) => {
    const u = ctx.user(id);
    // Discord user ids mean nothing to a reader; a Matrix id still does.
    return slot(`<span class="mention${u?.self ? ' self' : ''}" data-user="${esc(id)}" role="link" tabindex="0">@${esc(u?.name ?? (/^\d+$/.test(id) ? 'user' : id))}</span>`);
  });
  s = s.replace(/<#([^>\s]+)>/g, (_, id) => slot(`<span class="mention room">#${esc(ctx.room(id) ?? (/^\d+$/.test(id) ? 'channel' : id))}</span>`));
  s = s.replace(/<(a?):(\w+):(\d+)>/g, (_, anim, name, id) =>
    slot(
      ctx.network === 'discord'
        ? `<img class="emoji-img inline" src="/emoji/discord/${id}${anim ? '.animated' : ''}" alt=":${esc(name)}:" title=":${esc(name)}:" loading="lazy">`
        : `<span class="emoji-custom">:${esc(name)}:</span>`,
    ),
  );
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text, url) => slot(`<a href="${esc(url)}" target="_blank" rel="noreferrer noopener">${esc(text)}</a>`));
  s = s.replace(/\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, (url) => slot(`<a href="${esc(url)}" target="_blank" rel="noreferrer noopener">${esc(url)}</a>`));
  // Invite links written without https:// (t.me/+…, discord.gg/…), linked as Telegram links them.
  s = s.replace(BARE_INVITE, (url) => slot(`<a href="https://${esc(url)}" target="_blank" rel="noreferrer noopener">${esc(url)}</a>`));

  s = esc(s);
  s = s
    .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" tabindex="0">$1</span>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([\s\S]+?)__/g, '<u>$1</u>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');

  // Block quotes: consecutive "> " lines. Lists: consecutive "- ", "* " or "1. " lines, nested by two spaces a
  // level, as Discord renders them.
  const lines = s.split('\n');
  const out: string[] = [];
  let quote: string[] = [];
  let items: ListLine[] = [];
  const flush = () => {
    if (quote.length) out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
    if (items.length) out.push(listHtml(items));
    quote = [];
    items = [];
  };
  for (const line of lines) {
    const m = line.match(/^&gt;\s?(.*)$/);
    const li = !m && line.match(/^( *)(?:[-*]|(\d{1,9})\.) (.+)$/);
    if (m) {
      if (items.length) flush();
      quote.push(m[1]);
    } else if (li) {
      if (quote.length) flush();
      items.push({ level: Math.min(3, Math.floor(li[1].length / 2)), ordered: li[2] !== undefined, start: li[2] !== undefined ? Math.min(+li[2], 1e9) : 1, text: li[3] });
    } else {
      flush();
      // Discord's line-level headings and small print.
      out.push(line.replace(/^#{1,3} (.+)$/, '<strong>$1</strong>').replace(/^-# (.+)$/, '<small>$1</small>'));
    }
  }
  flush();
  // Quotes and lists break the line themselves; a line of text needs a <br> only before more text, and an empty
  // line keeps its own so a blank line between blocks still shows.
  const isBlock = (l: string | undefined) => !!l && /^<(blockquote|ul|ol)[ >]/.test(l);
  s = out.map((l, i) => (isBlock(l) || i === out.length - 1 || (l !== '' && isBlock(out[i + 1])) ? l : l + '<br>')).join('');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
}

/** True if the whole message is one to three emoji: rendered large. */
export function isJumbo(body: string): boolean {
  const t = body.trim();
  if (!t || t.length > 24) return false;
  return /^(\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️|\p{Emoji_Modifier})*\s*){1,3}$/u.test(t);
}

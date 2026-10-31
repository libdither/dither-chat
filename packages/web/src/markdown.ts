/**
 * Renders the canonical message body (Discord-flavoured Markdown subset, see
 * protocol MessageFact.body) to HTML. Everything is escaped first; only the
 * constructs below produce markup, and links are limited to http(s).
 */
import type { Network } from '@dither-chat/protocol';

export interface MdContext {
  network: Network;
  user: (nativeId: string) => { name: string; self: boolean } | null;
  room: (nativeId: string) => string | null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderMarkdown(src: string, ctx: MdContext): string {
  const slots: string[] = [];
  const slot = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  // Fenced code first: nothing inside is interpreted.
  let s = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => slot(`<pre class="md-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(code.replace(/\n$/, ''))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => slot(`<code class="md-inline">${esc(code)}</code>`));
  // Mentions and room links before escaping eats the angle brackets.
  s = s.replace(/<@&\d+>/g, () => slot('<span class="mention">@role</span>'));
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

  s = esc(s);
  s = s
    .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" tabindex="0">$1</span>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([\s\S]+?)__/g, '<u>$1</u>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');

  // Block quotes: consecutive "> " lines.
  const lines = s.split('\n');
  const out: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (quote.length) out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
    quote = [];
  };
  for (const line of lines) {
    const m = line.match(/^&gt;\s?(.*)$/);
    if (m) quote.push(m[1]);
    else {
      flush();
      // Discord's line-level headings and small print.
      out.push(line.replace(/^#{1,3} (.+)$/, '<strong>$1</strong>').replace(/^-# (.+)$/, '<small>$1</small>'));
    }
  }
  flush();
  s = out.join('\n').replace(/\n(?!<\/?blockquote)/g, '<br>').replace(/<br>(<blockquote>)/g, '$1').replace(/(<\/blockquote>)<br>/g, '$1');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
}

/** True if the whole message is one to three emoji: rendered large. */
export function isJumbo(body: string): boolean {
  const t = body.trim();
  if (!t || t.length > 24) return false;
  return /^(\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️|\p{Emoji_Modifier})*\s*){1,3}$/u.test(t);
}

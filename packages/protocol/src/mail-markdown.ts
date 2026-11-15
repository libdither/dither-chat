/**
 * What you write in mail is Markdown, as in chat: the text part goes as you wrote it, and the HTML part is it made into
 * HTML here, the same on the hub (compose.ts, when it sends) and in the composer's preview (docs/mail.md, "Formatting").
 *
 * The Markdown is GitHub's (marked, gfm), with what mail needs and nothing a mail could be hurt by:
 *
 * - a line break is a line break (`breaks`), as everyone writes mail;
 * - no setext headings and no indented code: a signature's `--` under a line, or a line indented four spaces, stays
 *   text (fenced code with ``` still works);
 * - HTML you type is text, shown as typed, never markup;
 * - links only to http(s) and mailto (anything else is its text); an image is a link to it, never fetched by the mail;
 * - a quote (`>`) is a `blockquote type=cite` with the bar mail apps draw, as the reply's own quote is.
 *
 * Every element is one that sanitize.ts calls plain (no colours, fonts or backgrounds), so a mail written here reads in
 * the app's theme, and in every mail app as its own text.
 */
import { Marked, type Tokens } from 'marked';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** The bar a quote has in mail (compose.ts quotes the original the same way). */
export const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex';

/** A link's address when it may be one: http(s) or mailto, else null. */
function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

/** A paragraph: a blank line's space under it, as the text has. */
const PARA = '<p style="margin:0 0 1em">';

const md = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  tokenizer: {
    // Undefined (not false, which falls back to marked's own) turns these off.
    lheading: () => undefined,
    code: () => undefined,
  },
  renderer: {
    html: ({ text }: Tokens.HTML | Tokens.Tag) => esc(text),
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const ok = safeHref(href);
      return ok ? `<a href="${esc(ok)}"${title ? ` title="${esc(title)}"` : ''}>${inner}</a>` : inner;
    },
    image({ href, text }: Tokens.Image) {
      const ok = safeHref(href);
      return ok ? `<a href="${esc(ok)}">${esc(text || ok)}</a>` : esc(text);
    },
    code: ({ text }: Tokens.Code) => `<pre><code>${esc(text.replace(/\n$/, ''))}</code></pre>\n`,
    blockquote({ tokens }: Tokens.Blockquote) {
      return `<blockquote type="cite" style="${QUOTE_STYLE}">${this.parser.parse(tokens)}</blockquote>\n`;
    },
    paragraph({ tokens }: Tokens.Paragraph) {
      return `${PARA}${this.parser.parseInline(tokens)}</p>\n`;
    },
    // A task list's box is text: mail has no form fields.
    checkbox: ({ checked }: Tokens.Checkbox) => (checked ? '☑ ' : '☐ '),
  },
});

/** Your text as the HTML part (a fragment: the caller wraps it). */
export function markdownHtml(text: string): string {
  const src = text.replace(/\r\n?/g, '\n');
  if (!src.trim()) return '';
  const html = (md.parse(src) as string).trim();
  // Ending in a paragraph: no space under it (what follows, a quote's attribution, brings its own line).
  const last = html.lastIndexOf(PARA);
  return last >= 0 && html.indexOf('</p>', last) === html.length - 4 ? `${html.slice(0, last)}<p style="margin:0">${html.slice(last + PARA.length)}` : html;
}

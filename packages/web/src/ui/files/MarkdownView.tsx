/**
 * Markdown, rendered (docs/files.md). marked only parses; this turns its tokens into elements, so nothing the file
 * says ever reaches the page as markup: raw HTML is shown as text, links are plain web links (they open the way any
 * link in the app does, through the desktop helper when it is on), and a picture from elsewhere loads only when asked.
 */
import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { Lexer, type Token, type Tokens } from 'marked';
import type { FileViewProps } from '../Viewer.tsx';
import { highlight, toLines } from './highlight.ts';
import { Failed, Partial, useText, Waiting } from './load.tsx';
import { Code } from './TextView.tsx';

export default function MarkdownView({ att, info }: FileViewProps) {
  const t = useText(att.url, info?.encoding);
  const [source, setSource] = useState(false);
  if (t.state === 'loading') return <Waiting />;
  if (t.state === 'error') return <Failed error={t.error} />;
  return (
    <>
      <SourceToggle source={source} set={setSource} />
      {t.truncated && <Partial shown={new TextEncoder().encode(t.value).length} total={info?.size ?? att.size} />}
      {source ? <Code text={t.value} language="markdown" /> : <Rendered text={t.value} />}
    </>
  );
}

/** Rendered or source, for the viewers that render. */
export function SourceToggle({ source, set }: { source: boolean; set: (v: boolean) => void }) {
  return (
    <div class="fv-tools fv-modes" role="tablist">
      <button class={`chip-btn${!source ? ' on' : ''}`} role="tab" aria-selected={!source} onClick={() => set(false)}>
        Rendered
      </button>
      <button class={`chip-btn${source ? ' on' : ''}`} role="tab" aria-selected={source} onClick={() => set(true)}>
        Source
      </button>
    </div>
  );
}

function Rendered({ text }: { text: string }) {
  const tokens = useMemo(() => {
    try {
      return Lexer.lex(text, { gfm: true });
    } catch {
      return null;
    }
  }, [text]);
  if (!tokens) return <Code text={text} language="markdown" />;
  return <article class="fv-md">{blocks(tokens)}</article>;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', larr: '←', rarr: '→' };
/** Character references, as Markdown reads them. */
function entities(s: string): string {
  return s.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** A link this viewer will follow: the web or mail, nothing that runs or reaches into the app. */
const safeHref = (href: string) => {
  try {
    const u = new URL(href);
    return /^(https?|mailto):$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};

function blocks(tokens: Token[]): ComponentChildren[] {
  return tokens.map((t, i) => block(t, i));
}

function block(t: Token, key: number): ComponentChildren {
  switch (t.type) {
    case 'space':
    case 'def':
      return null;
    case 'heading': {
      const H = `h${Math.min(6, Math.max(1, (t as Tokens.Heading).depth))}` as 'h1';
      return <H key={key}>{inline((t as Tokens.Heading).tokens)}</H>;
    }
    case 'paragraph':
      return <p key={key}>{inline((t as Tokens.Paragraph).tokens)}</p>;
    case 'text': {
      const x = t as Tokens.Text;
      return <p key={key}>{x.tokens ? inline(x.tokens) : entities(x.text)}</p>;
    }
    case 'code': {
      const c = t as Tokens.Code;
      const lines = toLines(highlight(c.text, c.lang?.split(/\s/)[0]) ?? [['', c.text]]);
      return (
        <pre key={key} class="fv-md-code">
          <code>
            {lines.map((l, j) => (
              <>
                {j > 0 && '\n'}
                {l.map(([cls, s]) => (cls ? <span class={`hl-${cls}`}>{s}</span> : s))}
              </>
            ))}
          </code>
        </pre>
      );
    }
    case 'blockquote':
      return <blockquote key={key}>{blocks((t as Tokens.Blockquote).tokens)}</blockquote>;
    case 'list': {
      const l = t as Tokens.List;
      const items = l.items.map((it, j) => (
        <li key={j} class={it.task ? 'task' : undefined}>
          {it.task && <input type="checkbox" checked={!!it.checked} disabled aria-label={it.checked ? 'done' : 'not done'} />}
          {/* A tight list's items are bare text, not paragraphs. */}
          {it.tokens.map((x, k) => (x.type === 'checkbox' ? null : x.type === 'text' && !l.loose ? <span key={k}>{(x as Tokens.Text).tokens ? inline((x as Tokens.Text).tokens!) : entities((x as Tokens.Text).text)}</span> : block(x, k)))}
        </li>
      ));
      return l.ordered ? (
        <ol key={key} start={typeof l.start === 'number' ? l.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'table': {
      const tb = t as Tokens.Table;
      const align = (a: string | null) => (a ? { textAlign: a } : undefined);
      return (
        <div key={key} class="fv-md-table">
          <table>
            <thead>
              <tr>
                {tb.header.map((c, j) => (
                  <th key={j} style={align(c.align)}>
                    {inline(c.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k} style={align(c.align)}>
                      {inline(c.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'hr':
      return <hr key={key} />;
    case 'html':
      // Shown as the text it is.
      return (
        <pre key={key} class="fv-md-html">
          {(t as Tokens.HTML).text}
        </pre>
      );
    default:
      return 'tokens' in t && Array.isArray(t.tokens) ? <p key={key}>{inline(t.tokens)}</p> : <p key={key}>{t.raw}</p>;
  }
}

function inline(tokens: Token[] | undefined): ComponentChildren[] {
  return (tokens ?? []).map((t, i) => {
    switch (t.type) {
      case 'text': {
        const x = t as Tokens.Text;
        return x.tokens ? inline(x.tokens) : entities(x.text);
      }
      case 'escape':
        return (t as Tokens.Escape).text;
      case 'strong':
        return <strong key={i}>{inline((t as Tokens.Strong).tokens)}</strong>;
      case 'em':
        return <em key={i}>{inline((t as Tokens.Em).tokens)}</em>;
      case 'del':
        return <del key={i}>{inline((t as Tokens.Del).tokens)}</del>;
      case 'codespan':
        return <code key={i}>{(t as Tokens.Codespan).text}</code>;
      case 'br':
        return <br key={i} />;
      case 'link': {
        const l = t as Tokens.Link;
        const href = safeHref(l.href);
        return href ? (
          <a key={i} href={href} target="_blank" rel="noreferrer noopener" title={l.title ?? href}>
            {inline(l.tokens)}
          </a>
        ) : (
          <span key={i} class="fv-md-nolink" title={l.href}>
            {inline(l.tokens)}
          </span>
        );
      }
      case 'image':
        return <Picture key={i} img={t as Tokens.Image} />;
      case 'html':
        return (
          <code key={i} class="fv-md-html">
            {(t as Tokens.Tag).text}
          </code>
        );
      default:
        return t.raw;
    }
  });
}

/** A picture in the file: inline data shows; one from elsewhere waits for a click, since loading it tells that host. */
function Picture({ img }: { img: Tokens.Image }) {
  const [load, setLoad] = useState(false);
  const alt = entities(img.text || '');
  if (/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(img.href)) return <img class="fv-md-img" src={img.href} alt={alt} title={img.title ?? undefined} />;
  const href = safeHref(img.href);
  if (!href || href.startsWith('mailto:')) return <span class="fv-md-nolink">{alt ? `[${alt}]` : '[picture]'}</span>;
  if (load) return <img class="fv-md-img" src={href} alt={alt} title={img.title ?? undefined} referrerpolicy="no-referrer" />;
  return (
    <button class="fv-md-load" onClick={() => setLoad(true)} title={href}>
      Show picture{alt ? ` “${alt}”` : ''} from {new URL(href).host}
    </button>
  );
}

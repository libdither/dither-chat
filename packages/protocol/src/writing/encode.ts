/**
 * A fitted draft (fit.ts) written out as its place takes it. A place's wire is three choices:
 *
 * - how blocks are written: as lines with markers before them, as ranges over the text, as tags, or as the network's
 *   own tree;
 * - how the text in a line is written: marker pairs around it, ranges beside it, tags around it, or styled runs;
 * - what goes beside the text (`beside` in the profile): the fields, who is told, the rest of the message.
 *
 * Structured wires (ranges, tags, trees) say exactly what was meant. A marker string does not: the same characters are
 * the writer's words and the network's markers. So a marker string is read back as its place reads it (read.ts) and
 * compared with what was meant, and what differs is said, with the words it is about.
 */
import { differs, hiddenLost, wordsLost } from './check.ts';
import { measure, type Measure } from './count.ts';
import { standIn, type Mark, type MarkKind, type Node } from './doc.ts';
import { fit, RANK, type Change, type Level } from './fit.ts';
import { PROFILES, type Fields, type Markers, type Profile, type Ranges } from './profile.ts';
import { DELIMITER, read, URL_AT } from './read.ts';

export interface Encoded {
  /** What is handed to the network's code. */
  wire: unknown;
  /** The text its limit counts. */
  counted: string;
  /** The wire for reading: a marker string as it is, anything else as JSON. */
  show: string;
  /** For a marker string: what goes beside it, as JSON. */
  beside?: string;
}

const ZW = '​';
const NB = ' ';
const PUNCT = /[!-\/:-@\[-`{-~\p{P}\p{S}]/u;
const FLANKS = /^[*_~]/;
// What hides is outermost: a network takes a hidden link, not a link with hidden words.
const ORDER = ['spoiler', 'link', 'color', 'bold', 'italic', 'underline', 'strike', 'sub', 'sup', 'code'];
const ordered = (marks: Mark[] = []) => [...marks].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
const same = (a: Mark, b: Mark) => a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});

interface Writer {
  pair: (m: Mark, n: Node) => [string, string];
  text: (s: string, code: boolean) => string;
  other: (n: Node) => string;
  /** Marker strings: spaces stay outside a pair (`**bold** `, never `**bold **`), and pairs that would run together are kept apart. */
  tight: boolean;
  /** The place takes a marker only where CommonMark's rule lets it: a character of no width makes it so. */
  flank?: boolean;
}

/**
 * Runs with sets of styles, written as nested opens and closes: a style stays open across runs that share it, and
 * where one must close under another, the others close and open again around it.
 */
function nested(nodes: Node[], o: Writer): string {
  let out = '';
  const open: { m: Mark; close: string }[] = [];
  const edge = (c: string) => c === '' || /\s/.test(c) || PUNCT.test(c);
  const closeTo = (k: number, next: string) => {
    if (open.length <= k) return;
    const space = o.tight ? /\s*$/.exec(out)![0] : '';
    out = out.slice(0, out.length - space.length);
    // A closing marker between a punctuation mark and a letter is not taken for one. When a letter follows the closing
    // markers, a character of no width goes before each that has a punctuation mark (or another marker) before it.
    const tail = space ? ' ' : next;
    while (open.length > k) {
      const cl = open.pop()!.close;
      if (o.flank && FLANKS.test(cl) && PUNCT.test(out.slice(-1)) && !edge(tail)) out += ZW;
      out += cl;
    }
    out += space;
  };
  for (const n of nodes) {
    const isText = n.type === 'text';
    const s = isText ? (n.text ?? '') : '';
    const want = ordered(n.marks);
    let k = 0;
    while (k < open.length && k < want.length && same(open[k].m, want[k])) k++;
    if (isText && o.tight && !s.trim()) {
      // Spaces between two runs keep the styles already open that they share, and open none.
      closeTo(k, ' ');
      out += s;
      continue;
    }
    const lead = isText && o.tight && k < want.length ? /^\s*/.exec(s)![0] : '';
    const body = s.slice(lead.length);
    const piece = isText ? o.text(body, want.some((m) => m.type === 'code')) : o.other(n);
    const pairs = want.slice(k).map((m) => o.pair(m, n));
    // What the closing markers will have after them. A close and an open of the same character get a character of no
    // width between them (below), which is no edge.
    const first = pairs.find(([a]) => a)?.[0] ?? '';
    const merges = !lead && !!first && open.length > k && first[0] === open[k].close.slice(-1);
    closeTo(k, lead ? ' ' : merges ? 'x' : (first[0] ?? piece[0] ?? ''));
    out += lead;
    pairs.forEach(([a, b], i) => {
      // An open right after the same character (a close, or a mention that ends in it) would read as one longer marker.
      if (o.tight && a && a[0] === out[out.length - 1]) out += ZW;
      const before = out.slice(-1);
      out += a;
      // An opening marker after a letter and before a punctuation mark is not taken for one, either.
      const after = pairs[i + 1]?.[0][0] ?? piece[0] ?? '';
      if (o.flank && FLANKS.test(a) && PUNCT.test(after) && !edge(before)) out += ZW;
      open.push({ m: want[k + i], close: b });
    });
    out += piece;
  }
  closeTo(0, '');
  return out;
}

// ------------------------------------------------------------------------------------------------ marker strings

const URLS = new RegExp(`(${URL_AT.source})`, 'u');

const thing = (n: Node, w: Markers) => (n.type === 'mention' && w.mention ? w.mention(n) : n.type === 'time' && w.time ? w.time(n) : n.type === 'emoji' && w.emoji ? w.emoji(n) : standIn(n));

/** One line of text as a marker string. */
function markerLine(nodes: Node[], w: Markers): string {
  const pair = (m: Mark, n: Node): [string, string] => {
    if (m.type === 'link') return w.link ? w.link(String(m.attrs?.href ?? '')) : ['', ''];
    const p = w.marks[m.type as MarkKind];
    if (m.type === 'code' && p?.[0] === '`' && w.code2 && n.text?.includes('`')) {
      // Code that holds a backtick sits between more of them than it holds in a row.
      const run = '`'.repeat(Math.max(...n.text.match(/`+/g)!.map((x) => x.length)) + 1);
      const pad = /^`|`$/.test(n.text.trim()) ? ' ' : '';
      return [run + pad, pad + run];
    }
    return p ?? ['', ''];
  };
  const esc = (s: string) => {
    if (!w.escape) return s;
    let r = '';
    for (const c of s) r += w.escape.includes(c) ? '\\' + c : c;
    return w.entities ? r.replace(/&(?=#?\w+;)/g, '&amp;') : r;
  };
  // An address typed bare is left as it is: escaped, it would no longer be one. But for the marker that hides: inside
  // an address it would still end what is hidden, so there it is escaped, and the address is the worse for it (said).
  const hides = w.marks.spoiler?.[0];
  const bare = (url: string) => (hides && w.escape ? url.split(hides).join([...hides].map((c) => '\\' + c).join('')) : url);
  const plain = (s: string) =>
    s
      .split(URLS)
      .map((part, i) => (i % 2 ? bare(part) : esc(w.defuse ? w.defuse(part) : part)))
      .join('');
  let line = nested(nodes, { pair, text: (s, code) => (code ? `\ue000${s}\ue001` : plain(s)), other: (n) => thing(n, w), tight: true, flank: w.reads === 'flanking' });
  // Where the place shows spaces in a row as one, every other one is a no-break space, and so are those at the start
  // and the end of the line. Code keeps its own.
  if (w.collapses)
    line = line
      .split(/(\ue000[^\ue001]*\ue001)/)
      .map((part, i) => (i % 2 ? part : part.replace(/ {2,}/g, (m) => (' ' + NB).repeat(m.length >> 1) + (m.length & 1 ? ' ' : ''))))
      .join('')
      // A line that starts four spaces or a tab in is code there.
      .replace(/^[ \t]+| +$/g, (m) => [...m].map((ch) => (ch === '\t' ? NB.repeat(4) : NB)).join(''));
  line = line.replace(/[\ue000\ue001]/g, '');
  if (!w.escape) return line;
  // A line of the writer's own that starts as a heading, a quote, a list or a rule would, is kept a line.
  const marker = nodes[0]?.marks?.some((m) => m.type === 'spoiler') && w.marks.spoiler?.[0].startsWith('>');
  if (!marker) line = line.replace(/^(\s*)>/, '$1\\>');
  // A line of dashes and bars under a line with a bar would make the two a table.
  if (w.table && DELIMITER.test(line) && line.includes('|')) line = '\\' + line;
  return line
    .replace(/^(\s*)(#{1,6}(?=\s|$)|[-+](?=\s|$)|-#(?=\s))/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)([-=])(?=[-=]*\s*$)/, '$1\\$2');
}

const markerBlocks = (all: Node[], w: Markers): string[] => pieces(all, w).map((x) => x.text);

/**
 * Blocks as marker strings, each with whether it is one of the network's paragraphs, and whether it must stand apart
 * from its neighbours by an empty line (a block of HTML runs on to the next empty line; a picture is a line of its own).
 */
function pieces(all: Node[], w: Markers): { text: string; para: boolean; apart?: boolean }[] {
  const pre = (s: string, first: string, rest: string) =>
    s
      .split('\n')
      .map((l, i) => (i === 0 ? first + l : l ? rest + l : rest.trimEnd()))
      .join('\n');
  const fenceFor = (inner: string) => (w.fence === '```' ? '`'.repeat(Math.max(3, ...(inner.match(/`+/g) ?? []).map((x) => x.length + 1))) : (w.fence ?? ''));
  const one = (b: Node): string => {
    switch (b.type) {
      case 'heading':
        // A # at the end of a heading would be taken for the end of the heading's own marker.
        return (w.heading?.(b.attrs?.level ?? 1) ?? '') + markerLine(b.content ?? [], w).replace(/(^|\s)(#+\s*)$/, '$1\\$2');
      case 'blockquote':
        return pre(markerBlocks(b.content ?? [], w).join(w.para), w.quote ?? '', w.quote ?? '');
      case 'bulletList':
      case 'orderedList':
        return (b.content ?? [])
          .map((item, i) => {
            const lead = b.type === 'orderedList' ? `${(b.attrs?.start ?? 1) + i}. ` : (w.bullet ?? '- ');
            // Inside an item a block follows on the next line, but two of the network's paragraphs stand apart.
            const inner = pieces(item.content ?? [], w).reduce((acc, x, j, all) => acc + (j ? (x.apart || all[j - 1].apart ? '\n\n' : x.para && all[j - 1].para ? w.para : '\n') : '') + x.text, '');
            return pre(inner, lead, w.indent === 'marker' ? ' '.repeat(lead.length) : (w.indent ?? '  '));
          })
          .join('\n');
      case 'codeBlock': {
        const code = b.content?.[0]?.text ?? '';
        const f = fenceFor(code);
        return `${f}${b.attrs?.language ?? ''}\n${code}\n${f}`;
      }
      case 'horizontalRule':
        return w.rule ?? '---';
      case 'table': {
        const rows = (b.content ?? []).map((r) => '| ' + (r.content ?? []).map((c) => markerLine(c.content?.[0]?.content ?? [], w).replace(/(?<!\\)\|/g, '\\|')).join(' | ') + ' |');
        const cols = b.content?.[0]?.content?.length ?? 1;
        return [rows[0], '| ' + Array(cols).fill('---').join(' | ') + ' |', ...rows.slice(1)].join('\n');
      }
      case 'fold': {
        const inner = markerBlocks(b.content ?? [], w).join(w.para);
        return w.fold!(String(b.attrs?.title ?? ''), inner, fenceFor(inner));
      }
      case 'image':
        return w.image!(b);
      case 'raw':
        // An empty line would end the block there, so it has none.
        return String(b.attrs?.source ?? '')
          .replace(/\n\s*\n/g, '\n')
          .trim();
      default:
        return markerLine(b.content ?? [], w);
    }
  };
  if (w.para !== '\n\n') return all.map((b) => ({ text: one(b), para: b.type === 'paragraph' }));
  // A paragraph here is a line and an empty one an empty line. Where the network's paragraphs stand apart, lines that
  // follow each other are one of its paragraphs with breaks, and the empty line is the gap between two.
  const out: { text: string; para: boolean; apart?: boolean }[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push({ text: run.join(w.br), para: true });
    run = [];
  };
  for (const b of all) {
    if (b.type === 'paragraph') {
      if (b.content?.length) run.push(markerLine(b.content, w));
      else flush();
      continue;
    }
    flush();
    // A quote, a list and a table take the line after them for their own, and a table the line before it: an empty
    // line keeps them apart.
    out.push({ text: one(b), para: false, apart: /^(image|raw|blockquote|bulletList|orderedList|table)$/.test(b.type) });
  }
  flush();
  return out;
}

/** Control characters (IRC's) drawn so they can be read. */
const visible = (s: string) => s.replace(/[\x00-\x09\x0b-\x1f]/g, (c) => String.fromCodePoint(0x2400 + c.charCodeAt(0))).replace(/​/g, '␣'.replace('␣', '​'));

// ------------------------------------------------------------------------------------------- plain text with ranges

interface Range {
  start: number;
  end: number;
  kind: string;
  data?: Record<string, unknown>;
}

function ranged(list: Node[], shape: string, finds = false): { text: string; ranges: Range[] } {
  let text = '';
  const ranges: Range[] = [];
  const add = (start: number, kind: string, data?: Record<string, unknown>) => {
    const last = [...ranges].reverse().find((r) => r.kind === kind && JSON.stringify(r.data) === JSON.stringify(data));
    if (last && last.end === start && kind !== 'mention') last.end = text.length;
    else ranges.push({ start, end: text.length, kind, ...(data ? { data } : {}) });
  };
  const walk = (blocks: Node[]) => {
    blocks.forEach((b, i) => {
      if (i) text += '\n';
      const start = text.length;
      if (b.type === 'blockquote') {
        walk(b.content ?? []);
        add(start, 'blockquote');
      } else if (b.type === 'codeBlock') {
        text += b.content?.[0]?.text ?? '';
        add(start, 'pre', { language: b.attrs?.language ?? '' });
      } else
        for (const n of b.content ?? []) {
          const at = text.length;
          if (n.type === 'text') text += n.text ?? '';
          else if (n.type === 'mention') {
            // Signal puts one stand-in character where the name goes; a network that looks names up gets the handle.
            text += shape === 'signal' ? '￼' : finds ? '@' + String(n.attrs?.id ?? '') : standIn(n);
            if (shape !== 'plain') add(at, 'mention', { id: n.attrs?.id });
          } else if (n.type === 'emoji') {
            text += n.attrs?.alt ?? '🙂';
            add(at, 'emoji', { id: n.attrs?.id });
          } else text += standIn(n);
          for (const m of n.marks ?? []) add(at, m.type, m.type === 'link' ? { href: m.attrs?.href } : undefined);
        }
    });
  };
  walk(list);
  return { text, ranges };
}

/** Ranges that cross, cut so that each sits inside or outside every other. */
function nest(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start || b.end - a.end)) {
    let parts = [r];
    for (const q of out) parts = parts.flatMap((p) => (p.start > q.start && p.start < q.end && p.end > q.end ? [{ ...p, end: q.end }, { ...p, start: q.end }] : [p]));
    out.push(...parts);
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;
const SIGNAL: Record<string, string> = { bold: 'BOLD', italic: 'ITALIC', strike: 'STRIKETHROUGH', code: 'MONOSPACE', spoiler: 'SPOILER' };
const TELEGRAM: Record<string, string> = { bold: 'messageEntityBold', italic: 'messageEntityItalic', underline: 'messageEntityUnderline', strike: 'messageEntityStrike', code: 'messageEntityCode', spoiler: 'messageEntitySpoiler', blockquote: 'messageEntityBlockquote' };

function rangesWire(list: Node[], pr: Profile): { wire: unknown; counted: string } {
  const w = pr.wire as Ranges;
  const found = ranged(list, w.shape, !!pr.rules?.findsMentions);
  const text = found.text;
  const cut = w.overlap === 'nested' ? nest(found.ranges) : found.ranges;
  // Offsets in what the network counts.
  const off = (i: number) => (w.unit === 'bytes' ? utf8(text.slice(0, i)) : w.unit === 'codepoints' ? [...text.slice(0, i)].length : i);
  const ranges = cut.map((r) => ({ ...r, start: off(r.start), end: off(r.end) }));
  if (w.shape === 'signal')
    return {
      counted: text,
      wire: {
        message: text,
        textStyle: ranges.filter((r) => SIGNAL[r.kind]).map((r) => `${r.start}:${r.end - r.start}:${SIGNAL[r.kind]}`),
        mention: ranges.filter((r) => r.kind === 'mention').map((r) => `${r.start}:${r.end - r.start}:${r.data?.id}`),
      },
    };
  if (w.shape === 'telegram')
    return {
      counted: text,
      wire: {
        message: text,
        entities: ranges.map((r) => {
          const at = { offset: r.start, length: r.end - r.start };
          if (r.kind === 'link') return { _: 'messageEntityTextUrl', ...at, url: r.data?.href };
          if (r.kind === 'mention') return { _: 'inputMessageEntityMentionName', ...at, user_id: r.data?.id };
          if (r.kind === 'pre') return { _: 'messageEntityPre', ...at, language: r.data?.language };
          if (r.kind === 'emoji') return { _: 'messageEntityCustomEmoji', ...at, document_id: r.data?.id };
          return { _: TELEGRAM[r.kind], ...at };
        }),
      },
    };
  if (w.shape === 'bluesky') {
    // Links and tags typed bare are found, as its own app does. A tag is not a number alone.
    const facet = (start: number, end: number, feature: Record<string, unknown>) => ({ index: { byteStart: start, byteEnd: end }, features: [feature] });
    const facets = ranges.flatMap((r) =>
      r.kind === 'link' ? [facet(r.start, r.end, { $type: 'app.bsky.richtext.facet#link', uri: r.data?.href })] : r.kind === 'mention' ? [facet(r.start, r.end, { $type: 'app.bsky.richtext.facet#mention', did: r.data?.id })] : [],
    );
    const covered = (i: number) => cut.some((r) => i >= r.start && i < r.end);
    for (const m of text.matchAll(/https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/g)) if (!covered(m.index)) facets.push(facet(off(m.index), off(m.index + m[0].length), { $type: 'app.bsky.richtext.facet#link', uri: m[0] }));
    for (const m of text.matchAll(/(?<=^|\s)#(?!\d+(?:\s|$))([\p{L}\p{N}_]+)/gu)) if (!covered(m.index)) facets.push(facet(off(m.index), off(m.index + m[0].length), { $type: 'app.bsky.richtext.facet#tag', tag: m[1] }));
    facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
    return { counted: text, wire: { $type: 'app.bsky.feed.post', text, ...(facets.length ? { facets } : {}) } };
  }
  return { counted: text, wire: { text } };
}

// --------------------------------------------------------------------------------------------------------- HTML

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
const TAG: Record<string, string> = { bold: 'strong', italic: 'em', underline: 'u', strike: 'del', code: 'code', sub: 'sub', sup: 'sup' };

function htmlInline(nodes: Node[], shape: string): string {
  const pair = (m: Mark): [string, string] =>
    m.type === 'link'
      ? [`<a href="${attr(String(m.attrs?.href ?? ''))}">`, '</a>']
      : m.type === 'spoiler'
        ? ['<span data-mx-spoiler>', '</span>']
        : m.type === 'color'
          ? [shape === 'matrix' ? `<span data-mx-color="${attr(String(m.attrs?.color ?? ''))}">` : `<span style="color:${attr(String(m.attrs?.color ?? ''))}">`, '</span>']
          : [`<${TAG[m.type]}>`, `</${TAG[m.type]}>`];
  const other = (n: Node) => {
    if (n.type !== 'mention' || shape !== 'matrix') return esc(standIn(n));
    if (n.attrs?.kind === 'everyone') return '@room';
    return `<a href="https://matrix.to/#/${attr(String(n.attrs?.id ?? ''))}">${esc((n.attrs?.kind === 'channel' ? '#' : '@') + String(n.attrs?.label ?? ''))}</a>`;
  };
  // Spaces in a row are shown as one in HTML, so every other one is a no-break space.
  const text = (s: string) => esc(s).replace(/ {2,}/g, (m) => ' &nbsp;'.repeat(m.length >> 1) + (m.length & 1 ? ' ' : ''));
  return nested(nodes, { pair, text, other, tight: false }).replace(/^ | $/g, '&nbsp;');
}

function htmlBlocks(list: Node[], shape: 'matrix' | 'mail'): string {
  let out = '';
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const inner = () => htmlBlocks(b.content ?? [], shape);
    switch (b.type) {
      case 'paragraph': {
        // A paragraph is a line. A mail's line is a <div>, which has no space around it; Matrix's lines that follow
        // each other are one <p> with breaks.
        if (shape === 'mail') {
          out += `<div${b.attrs?.textAlign ? ` style="text-align:${attr(String(b.attrs.textAlign))}"` : ''}>${htmlInline(b.content ?? [], shape) || '<br>'}</div>`;
          break;
        }
        const run = [b];
        while (list[i + 1]?.type === 'paragraph') run.push(list[++i]);
        out += `<p>${run.map((x) => htmlInline(x.content ?? [], shape)).join('<br>')}</p>`;
        break;
      }
      case 'heading':
        out += `<h${b.attrs?.level ?? 1}${b.attrs?.textAlign ? ` style="text-align:${attr(String(b.attrs.textAlign))}"` : ''}>${htmlInline(b.content ?? [], shape)}</h${b.attrs?.level ?? 1}>`;
        break;
      case 'blockquote':
        out += shape === 'mail' ? `<blockquote type="cite">${inner()}</blockquote>` : `<blockquote>${inner()}</blockquote>`;
        break;
      case 'bulletList':
        out += `<ul>${inner()}</ul>`;
        break;
      case 'orderedList':
        out += `<ol${b.attrs?.start > 1 ? ` start="${Number(b.attrs!.start)}"` : ''}>${inner()}</ol>`;
        break;
      case 'codeBlock':
        out += `<pre><code${b.attrs?.language ? ` class="language-${attr(String(b.attrs.language))}"` : ''}>${esc(b.content?.[0]?.text ?? '')}</code></pre>`;
        break;
      case 'horizontalRule':
        out += '<hr>';
        break;
      case 'fold':
        out += `<details><summary>${esc(String(b.attrs?.title ?? ''))}</summary>${inner()}</details>`;
        break;
      case 'image':
        out += `<img src="${attr(String(b.attrs?.src ?? ''))}" alt="${attr(String(b.attrs?.alt ?? ''))}">`;
        break;
      case 'raw':
        out += String(b.attrs?.source ?? '');
        break;
      default: {
        const tag = ({ listItem: 'li', table: 'table', tableRow: 'tr', tableHeader: 'th', tableCell: 'td' } as Record<string, string>)[b.type];
        if (tag) out += `<${tag}>${inner()}</${tag}>`;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------- the network's blocks

function slackInline(nodes: Node[]): unknown[] {
  return nodes.map((n) => {
    const style = Object.fromEntries((n.marks ?? []).filter((m) => m.type !== 'link').map((m) => [m.type, true]));
    const styled = Object.keys(style).length ? { style } : {};
    if (n.type === 'mention') {
      const k = n.attrs?.kind;
      if (k === 'everyone') return { type: 'broadcast', range: 'channel', ...styled };
      if (k === 'channel') return { type: 'channel', channel_id: n.attrs?.id, ...styled };
      if (k === 'role') return { type: 'usergroup', usergroup_id: n.attrs?.id, ...styled };
      return { type: 'user', user_id: n.attrs?.id, ...styled };
    }
    if (n.type === 'time') return { type: 'date', timestamp: n.attrs?.at, format: '{date_short_pretty} at {time}', fallback: standIn(n) };
    if (n.type === 'emoji') return { type: 'emoji', name: n.attrs?.name };
    if (n.type !== 'text') return { type: 'text', text: standIn(n) };
    const link = n.marks?.find((m) => m.type === 'link');
    return link ? { type: 'link', url: link.attrs?.href, text: n.text, ...styled } : { type: 'text', text: n.text, ...styled };
  });
}

function slackBlocks(list: Node[]): unknown[] {
  const out: unknown[] = [];
  const lines = (blocks: Node[]) => blocks.flatMap((x, i) => [...(i ? [{ type: 'text', text: '\n' }] : []), ...slackInline(x.content ?? [])]);
  // Lines that follow each other are one section with line ends in it, as Slack's own box sends them: sections side by
  // side run together.
  let run: unknown[] | null = null;
  const line = (b: Node) => {
    if (run) run.push({ type: 'text', text: '\n' });
    else out.push({ type: 'rich_text_section', elements: (run = []) });
    run.push(...slackInline(b.content ?? []));
  };
  // Slack's lists do not nest: a list inside an item is the next list, one step further in, and the list it was in
  // goes on after it, counting from where it stopped.
  const lists = (b: Node, indent: number) => {
    const ordered = b.type === 'orderedList';
    let cur: unknown[] = [];
    let done = (b.attrs?.start ?? 1) - 1;
    const flush = () => {
      if (cur.length) out.push({ type: 'rich_text_list', style: ordered ? 'ordered' : 'bullet', indent, ...(ordered && done ? { offset: done } : {}), elements: cur });
      done += cur.length;
      cur = [];
    };
    for (const item of b.content ?? []) {
      const kids = item.content ?? [];
      const first = kids.findIndex((x) => x.type !== 'paragraph');
      cur.push({ type: 'rich_text_section', elements: lines(first < 0 ? kids : kids.slice(0, first)) });
      // What an item holds after its first lines, in the order it was written.
      for (const x of first < 0 ? [] : kids.slice(first)) {
        flush();
        if (x.type === 'bulletList' || x.type === 'orderedList') lists(x, indent + 1);
        else out.push({ type: 'rich_text_section', elements: slackInline(x.content ?? []) });
      }
    }
    flush();
  };
  for (const b of list) {
    if (b.type === 'paragraph') {
      line(b);
      continue;
    }
    run = null;
    if (b.type === 'bulletList' || b.type === 'orderedList') lists(b, 0);
    else if (b.type === 'blockquote') out.push({ type: 'rich_text_quote', elements: lines(b.content ?? []) });
    else if (b.type === 'codeBlock') out.push({ type: 'rich_text_preformatted', elements: [{ type: 'text', text: b.content?.[0]?.text ?? '' }], ...(b.attrs?.language ? { language: b.attrs.language } : {}) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------ all of it

/** A tree with what it hides taken out and a word in its place. */
function unhidden(n: Node): Node {
  if (n.type === 'fold' && n.attrs?.why !== 'long') return { ...n, content: [{ type: 'paragraph', content: [{ type: 'text', text: '[hidden]' }] }] };
  if (!n.content) return n;
  const content: Node[] = [];
  for (const c of n.content) {
    const hid = c.marks?.some((m) => m.type === 'spoiler');
    const last = content[content.length - 1];
    if (hid && last?.type === 'text' && last.text === '[hidden]') continue;
    content.push(hid ? { type: 'text', text: '[hidden]' } : unhidden(c));
  }
  return { ...n, content };
}
const hides = (n: Node): boolean => !!n.marks?.some((m) => m.type === 'spoiler') || (n.type === 'fold' && n.attrs?.why !== 'long') || !!n.content?.some(hides);

/**
 * The plain copy that goes beside HTML: the same draft, fitted to plain text. It is what a notification and an app
 * without formatting show, so what the draft hides is not in it.
 */
const plainCopy = (d: Node) => ranged(fit(unhidden(d), PROFILES.plain).doc.content ?? [], 'plain').text;

/** A draft already fitted to `pr`, as its wire. */
export function encode(d: Node, pr: Profile, f: Fields = {}): Encoded {
  const list = d.content ?? [];
  const w = pr.wire;
  let body: unknown;
  let counted: string;
  if (w.family === 'markers') body = counted = markerBlocks(list, w).join(w.para);
  else if (w.family === 'ranges') ({ wire: body, counted } = rangesWire(list, pr));
  else if (w.family === 'html') {
    const html = htmlBlocks(list, w.shape);
    const plain = plainCopy(d);
    counted = plain + html;
    if (w.shape === 'matrix') {
      const of = (k: string, out: string[] = []) => {
        const find = (n: Node): unknown => (n.type === 'mention' && (n.attrs?.kind ?? 'user') === k ? out.push(String(n.attrs?.id)) : (n.content ?? []).forEach(find));
        find(d);
        return [...new Set(out)];
      };
      const told = { ...(of('user').length ? { user_ids: of('user') } : {}), ...(of('everyone').length ? { room: true } : {}) };
      body = { msgtype: 'm.text', body: plain, format: 'org.matrix.custom.html', formatted_body: html, 'm.mentions': told };
    } else body = { 'text/plain': plain, 'text/html': html };
  } else {
    counted = plainCopy(d);
    body = { text: counted, blocks: [{ type: 'rich_text', elements: slackBlocks(list) }] };
  }
  // What is beside the text is only what the place has.
  const has = pr.fields ?? {};
  const own: Fields = { ...(has.title ? { title: f.title } : {}), ...(has.warning ? { warning: f.warning } : {}), ...(has.place ? { place: f.place } : {}), ...(has.people ? { to: f.to, cc: f.cc } : {}) };
  const wire = pr.beside ? pr.beside(body, own, d, pr) : body;
  if (typeof body !== 'string') return { wire, counted, show: JSON.stringify(wire, null, 2) };
  return { wire, counted, show: visible(body), ...(pr.beside ? { beside: JSON.stringify(wire, (_k, v) => (v === body ? '(the text above)' : v), 2) } : {}) };
}

/** What is counted against a place's limit beside the text itself. */
interface Load {
  /** A file goes with it: the text is a caption. */
  files?: boolean;
  /** Text counted with it: a content warning, where the place counts it. */
  extra?: string;
}
const limits = (pr: Profile, load: Load) => (pr.limit ? [{ ...pr.limit, max: load.files && pr.limit.withFile ? pr.limit.withFile : pr.limit.max }, ...(pr.limit.and ?? [])] : []);
const sizes = (counted: string, pr: Profile, load: Load = {}) => limits(pr, load).map((l) => measure(counted + (load.extra ?? ''), l.count, l.max, l.url));

/**
 * A fitted draft cut into as many as each fit the place's limit: between blocks, and a line of text that is too long by
 * itself between words. A block that cannot be cut (a long code block, one endless word) stays whole.
 */
export function split(d: Node, pr: Profile, load: Load = {}): Node[] {
  if (!pr.limit) return [d];
  // A file goes with the first of them only.
  const fits = (blocks: Node[], first: boolean) => !sizes(encode({ type: 'doc', content: blocks }, pr).counted, pr, first ? load : { extra: load.extra }).some((s) => s.over);
  const empty = (b?: Node) => b?.type === 'paragraph' && !b.content?.length;
  const words = (b: Node) => (b.type === 'paragraph' ? (b.content ?? []).flatMap((n) => (n.type === 'text' ? (n.text ?? '').split(/(?<=\s)(?=\S)/).map((text) => ({ ...n, text })) : [n])) : []);
  const parts: Node[][] = [];
  let cur: Node[] = [];
  const queue = [...(d.content ?? [])];
  while (queue.length) {
    const b = queue.shift()!;
    const first = !parts.length;
    if (!cur.length && empty(b)) continue;
    if (fits([...cur, b], first)) {
      cur.push(b);
      continue;
    }
    // A line that fits a part of its own starts the next part whole. One that must be cut anyway fills this one first.
    if (cur.length && fits([b], false)) {
      parts.push(cur);
      cur = [];
      queue.unshift(b);
      continue;
    }
    const pieces = words(b);
    // The most words that still fit, found by halving: every try writes the part out.
    let k = 0;
    for (let hi = pieces.length; k < hi; ) {
      const mid = (k + hi + 1) >> 1;
      if (fits([...cur, { type: 'paragraph', content: pieces.slice(0, mid) }], first)) k = mid;
      else hi = mid - 1;
    }
    if (k === 0 && cur.length) {
      parts.push(cur);
      cur = [];
      queue.unshift(b);
      continue;
    }
    if (k === 0 || k === pieces.length) {
      // It cannot be cut (a long code block, one endless word): it stays whole.
      parts.push([...cur, b]);
      cur = [];
      continue;
    }
    parts.push([...cur, { type: 'paragraph', content: pieces.slice(0, k) }]);
    cur = [];
    queue.unshift({ type: 'paragraph', content: pieces.slice(k) });
  }
  if (cur.length) parts.push(cur);
  return parts.map((content) => {
    while (empty(content[content.length - 1])) content.pop();
    return { type: 'doc', content };
  });
}

/** Choices the writer made for one place. */
export interface Options {
  /** The title or subject goes as the first line, where the place has none. */
  lead?: boolean;
  /** The content warning goes as a fold over the text, where the place has none. */
  warn?: boolean;
  /** Too long for one post: it goes as a thread. */
  thread?: boolean;
}

export interface Sent extends Encoded {
  changes: Change[];
  size: Measure | null;
  /** The draft as it was made to fit. */
  fitted: Node;
  /** The draft as it will be read: for a marker string, the string read back. */
  reads: Node;
  /** When it goes as several messages or posts: each one, with the part of the draft it holds. */
  parts: (Encoded & { tree: Node })[] | null;
  /** How many posts a thread of it would be, when it is too long for one. */
  thread: number | null;
  /** Pictures that were in the text and go beside it. */
  files: Node[];
}

/** A draft as it goes to one place: fitted, written out, read back, measured. */
export function send(d: Node, pr: Profile, given: Fields = {}, o: Options = {}): Sent {
  // What is written beside the text is a line of words: nothing in it can start a header or a command of its own.
  const f: Fields = Object.fromEntries(Object.entries(given ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() : '']));
  o = o ?? {};
  const changes: Change[] = [];
  const say = (level: Level, key: string, text: string, words?: string[]) => changes.push({ level, key, say: text, n: 1, ...(words?.length ? { words } : {}) });
  const title = f.title?.trim();
  const warning = f.warning?.trim();

  // What is written beside the text goes only where the place has it. Elsewhere it is left out and that is said; the
  // writer may choose to have it in the text there.
  let draft = d;
  if (warning && !pr.fields?.warning) {
    const hides = pr.blocks.includes('fold') || pr.marks.includes('spoiler');
    if (!o.warn) say('exposed', 'warning', 'It has no content warning there: the text is shown openly', [warning]);
    else if (hides) draft = { type: 'doc', content: [{ type: 'fold', attrs: { title: warning, why: 'hidden' }, content: d.content ?? [] }] };
    else {
      // Nothing can be hidden there. The writer chose to say the warning first and let the text follow.
      draft = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: warning }] }, { type: 'paragraph' }, ...(d.content ?? [])] };
      say('restyled', 'warningLine', 'The content warning is its first line there, and the text below it is open');
    }
  }
  const fitted = fit(draft, pr);
  // Where the whole post sits behind its content warning, text that was hidden is still behind a tap.
  const behind = !!(warning && pr.fields?.warning);
  const shows = (words: string[]) => (behind ? say('restyled', 'hiddenBehind', 'Hidden text is behind the content warning there, not hidden on its own', words) : say('exposed', 'hidden', 'Hidden text can be read there', words));
  for (const c of fitted.changes) {
    if (c.key === 'hidden' && behind) shows(c.words ?? []);
    else if (c.key === 'hiddenFile' && behind) say('restyled', 'image', 'A picture in the text goes with the message as a file');
    else changes.push(c);
  }
  if (title && !pr.fields?.title) {
    const line = title.replace(/\s+/g, ' ');
    if (o.lead) fitted.doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: line, ...(pr.marks.includes('bold') ? { marks: [{ type: 'bold' }] } : {}) }] }, ...(fitted.doc.content ?? [])] };
    else say('dropped', 'title', 'Its title or subject is not sent there', [title]);
  }
  // Who else a mail goes to is part of where it goes: on another place it goes to the one person.
  if (f.cc?.trim() && !pr.fields?.people) say('dropped', 'cc', 'Those in Cc do not get it there', [f.cc.trim()]);
  // Apps that show no formatting, and notifications, get a plain copy: what is hidden is left out of it.
  if (pr.wire.family === 'html' && hides(fitted.doc)) say('restyled', 'plainCopy', 'Where only plain text is shown (a notification), “[hidden]” stands in for hidden text');

  const out = encode(fitted.doc, pr, f);
  const load: Load = { files: fitted.files.length > 0, extra: pr.fields?.warning?.counts && warning ? warning : '' };
  const all = sizes(out.counted, pr, load);
  const size = all.find((s) => s.over) ?? all[0] ?? null;
  let parts: Sent['parts'] = null;
  let thread: number | null = null;
  if (size?.over) {
    const how = pr.limit!.over;
    const pieces = how === 'refuse' ? [] : split(fitted.doc, pr, load).map((x) => ({ ...encode(x, pr, f), tree: x }));
    const ok = pieces.length > 1 && pieces.every((x, i) => !sizes(x.counted, pr, i ? { extra: load.extra } : load).some((s) => s.over));
    if (ok && how === 'thread') thread = pieces.length;
    if (ok && (how === 'split' || o.thread)) {
      parts = pieces;
      say('restyled', 'limit', how === 'split' ? `Too long for one message: it goes as ${pieces.length}` : `It goes as a thread of ${pieces.length} posts`);
    } else say('blocked', 'limit', `Too long by ${size.n - size.max!} ${size.unit}`);
  }

  let reads = fitted.doc;
  if (pr.wire.family === 'markers') {
    reads = read(out.counted, pr, fitted.doc);
    const shown = hiddenLost(fitted.doc, reads, true);
    const lost = wordsLost(fitted.doc, reads, true);
    if (shown.length) shows(shown);
    if (lost.length) say('blocked', 'lost', 'Some words would not arrive', lost);
    const line = shown.length || lost.length ? null : differs(fitted.doc, reads);
    if (line !== null) say('restyled', 'reread', 'A line is read another way there', [line]);
  }

  if (pr.fields?.title?.required && !title) say('blocked', 'needsTitle', `It needs a ${pr.fields.title.word.toLowerCase()}`);
  if (pr.fields?.title && title && title.length > pr.fields.title.max) say('blocked', 'titleLong', `The ${pr.fields.title.word.toLowerCase()} is too long`);
  if (pr.fields?.place && !f.place?.trim()) say('blocked', 'needsPlace', `It needs a ${pr.fields.place.word.toLowerCase()}`);
  if (pr.fields?.warning && warning && warning.length > pr.fields.warning.max) say('blocked', 'warningLong', 'The content warning is too long');

  // One line for each kind of change.
  const merged = new Map<string, Change>();
  for (const c of changes) {
    const have = merged.get(c.key);
    if (!have) merged.set(c.key, { ...c });
    else {
      have.n += c.n;
      have.words = [...new Set([...(have.words ?? []), ...(c.words ?? [])])];
    }
  }
  return { ...out, changes: [...merged.values()].sort((a, b) => RANK[a.level] - RANK[b.level]), size, fitted: fitted.doc, reads, parts, thread, files: fitted.files };
}

/** A tree drawn as its readers will get it, for the page: its own blocks and styles as HTML with classes. */
export function preview(d: Node): string {
  const inl = (nodes: Node[]) =>
    nested(nodes, {
      pair: (m) =>
        m.type === 'link'
          ? [`<a href="${attr(String(m.attrs?.href ?? ''))}" target="_blank" rel="noreferrer">`, '</a>']
          : m.type === 'spoiler'
            ? ['<span class="w-spoiler">', '</span>']
            : m.type === 'color'
              ? [`<span style="color:${attr(String(m.attrs?.color ?? ''))}">`, '</span>']
              : [`<${TAG[m.type] ?? 'span'}>`, `</${TAG[m.type] ?? 'span'}>`],
      text: (s) => esc(s),
      other: (n) => `<span class="w-${n.type}">${esc(n.type === 'mention' && n.attrs?.kind === 'everyone' ? '@everyone' : standIn(n))}</span>`,
      tight: false,
    });
  const blk = (list: Node[]): string =>
    list
      .map((b): string => {
        const inner = () => blk(b.content ?? []);
        if (b.type === 'paragraph') return `<p${b.attrs?.textAlign ? ` style="text-align:${attr(String(b.attrs.textAlign))}"` : ''}>${inl(b.content ?? []) || '<br>'}</p>`;
        if (b.type === 'heading') return `<h${b.attrs?.level ?? 1}${b.attrs?.textAlign ? ` style="text-align:${attr(String(b.attrs.textAlign))}"` : ''}>${inl(b.content ?? [])}</h${b.attrs?.level ?? 1}>`;
        if (b.type === 'codeBlock') return `<pre>${esc(b.content?.[0]?.text ?? '')}</pre>`;
        if (b.type === 'horizontalRule') return '<hr>';
        if (b.type === 'image') return `<div class="w-raw-note">A picture: ${esc(String(b.attrs?.alt || b.attrs?.name || 'no description'))}</div>`;
        if (b.type === 'raw') return `<div class="w-raw-note">Its own ${esc(String(b.attrs?.format ?? '').toUpperCase())}, as it is</div>`;
        if (b.type === 'fold') return `<details><summary>${esc(String(b.attrs?.title ?? ''))}</summary>${inner()}</details>`;
        const tag = ({ blockquote: 'blockquote', bulletList: 'ul', orderedList: 'ol', listItem: 'li', table: 'table', tableRow: 'tr', tableHeader: 'th', tableCell: 'td' } as Record<string, string>)[b.type];
        return tag ? `<${tag}>${inner()}</${tag}>` : '';
      })
      .join('');
  return blk(d.content ?? []);
}

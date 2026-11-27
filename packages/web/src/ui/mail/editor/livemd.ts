/**
 * The Markdown view's live drawing (docs/mail.md "Writing"): CodeMirror 6 with Markdown drawn formatted as you type,
 * as Obsidian and Typora do. Headings are big, bold is bold, and the marks that make them (`**`, `#`, `>`, the link's
 * address) fold away on every line but the one the caret is on, where they show to be edited. Stand-ins for what the
 * text can't hold show as chips: `[[island:id]]` as the forwarded mail or quote it stands for, `dc-picture:id` as the
 * picture.
 */
import { syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';

/** What a chip shows: an island's kind and label, a picture's bytes. */
export interface Stands {
  /** `text`: what it adds to the text part (the Plain view shows it). */
  island: (ref: string) => { kind: string; label: string; size: number; text?: string } | null;
  picture: (ref: string) => string | null;
  /** A picture address from the web as the editor draws it: a box with its host, never fetched (schema.ts); null for others. */
  webBox: (src: string) => HTMLElement | null;
  /** Markdown: a block kept whole, drawn as it will arrive under its name (MailEditor); its `dcStop` ends its watching. */
  islandSheet?: (ref: string) => HTMLElement | null;
}

/** Markdown: HTML kept whole (a newsletter's layout) in the text as it will arrive, not as a stand-in. */
class Sheet extends WidgetType {
  constructor(
    readonly ref: string,
    readonly make: (ref: string) => HTMLElement | null,
  ) {
    super();
  }
  eq(o: Sheet) {
    return o.ref === this.ref;
  }
  toDOM() {
    return this.make(this.ref) ?? document.createElement('span');
  }
  destroy(dom: HTMLElement) {
    (dom as HTMLElement & { dcStop?: () => void }).dcStop?.();
  }
  ignoreEvent() {
    return true;
  }
}

/** Syntax that folds away off the caret's line. */
const MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'StrikethroughMark', 'QuoteMark']);
/** Whole nodes and the class they draw with. */
const STYLE: Record<string, string> = {
  ATXHeading1: 'md-h1',
  ATXHeading2: 'md-h2',
  ATXHeading3: 'md-h3',
  StrongEmphasis: 'md-strong',
  Emphasis: 'md-em',
  Strikethrough: 'md-strike',
  InlineCode: 'md-code',
  Link: 'md-link',
  Blockquote: 'md-quote',
  FencedCode: 'md-fence',
  HTMLTag: 'md-html',
};

/** An entity (`&lt;`) or an escaped mark (`\_`) drawn as the character it stands for. */
class Char extends WidgetType {
  constructor(readonly ch: string) {
    super();
  }
  eq(o: Char) {
    return o.ch === this.ch;
  }
  toDOM() {
    const s = document.createElement('span');
    // A word joiner on the side of the text it belongs to: "<jo@park.example>" breaks as a whole, never after its "<".
    s.textContent = this.ch === '<' ? '<\u2060' : this.ch === '>' ? '\u2060>' : this.ch;
    return s;
  }
}
const ENTITY: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': '\u00a0' };

class Chip extends WidgetType {
  constructor(
    readonly text: string,
    readonly kind: string,
  ) {
    super();
  }
  eq(o: Chip) {
    return o.text === this.text && o.kind === this.kind;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = `md-chip md-chip-${this.kind}`;
    s.textContent = this.text;
    s.title = 'Kept as it is: open the HTML view to change it, or delete the line to take it out';
    return s;
  }
  ignoreEvent() {
    return false;
  }
}

/** Plain: a forward's or a quote's text as it goes, read-only, with its name over it. */
class IslandText extends WidgetType {
  constructor(
    readonly label: string,
    readonly text: string,
    readonly kind: string,
  ) {
    super();
  }
  eq(o: IslandText) {
    return o.label === this.label && o.text === this.text;
  }
  toDOM(view: EditorView) {
    const s = document.createElement('span');
    s.className = `md-island-text md-chip-${this.kind}`;
    const head = document.createElement('span');
    head.className = 'md-island-text-head';
    head.textContent = this.label;
    const body = document.createElement('span');
    body.className = 'md-island-text-body';
    body.textContent = this.text;
    // Taken out here as in Rich: its line goes.
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'md-island-x';
    x.textContent = '✕';
    x.title = 'Take it out of the message';
    x.setAttribute('aria-label', x.title);
    x.onmousedown = (e) => e.preventDefault();
    x.onclick = () => {
      const line = view.state.doc.lineAt(view.posAtDOM(s));
      view.dispatch({ changes: { from: Math.max(0, line.from - (line.to === view.state.doc.length && line.from > 0 ? 1 : 0)), to: Math.min(view.state.doc.length, line.to + 1) } });
      view.focus();
    };
    head.append(x);
    s.append(head, body);
    s.title = 'Goes as it is';
    return s;
  }
  ignoreEvent(e: Event) {
    return !!(e.target as Element | null)?.closest?.('.md-island-x');
  }
}

class Thumb extends WidgetType {
  constructor(
    readonly src: string,
    /** One from the web: drawn as a box (Stands.webBox), never fetched. */
    readonly box: ((src: string) => HTMLElement | null) | null = null,
  ) {
    super();
  }
  eq(o: Thumb) {
    return o.src === this.src;
  }
  toDOM() {
    const box = this.box?.(this.src);
    if (box) {
      box.classList.add('md-thumb');
      return box;
    }
    const img = document.createElement('img');
    img.className = 'md-thumb';
    img.src = this.src;
    img.alt = '';
    return img;
  }
}

class Bullet extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'md-bullet';
    s.textContent = '•';
    return s;
  }
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

function build(view: EditorView, stands: Stands): DecorationSet {
  const out: Range<Decoration>[] = [];
  const state: EditorState = view.state;
  const sel = state.selection.main;
  const caretLines = new Set<number>();
  for (let l = state.doc.lineAt(sel.from).number; l <= state.doc.lineAt(sel.to).number; l++) caretLines.add(l);
  const onCaret = (pos: number) => view.hasFocus && caretLines.has(state.doc.lineAt(pos).number);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (n) => {
        // A picture is drawn whole off the caret's line: nothing inside it is drawn again.
        if (n.name === 'Image' && !onCaret(n.from)) {
          const u = n.node.getChild('URL');
          const url = u ? state.doc.sliceString(u.from, u.to) : '';
          const m = /^dc-picture:([\w-]+)$/.exec(url);
          const src = m ? stands.picture(m[1]) : /^(https?:)?\/\//.test(url) ? url : null;
          if (src) {
            out.push(Decoration.replace({ widget: new Thumb(src, m ? null : stands.webBox) }).range(n.from, n.to));
            return false;
          }
        }
        const cls = STYLE[n.name];
        if (cls) out.push(Decoration.mark({ class: cls }).range(n.from, n.to));
        if (n.name === 'Blockquote' || n.name === 'FencedCode') {
          // A quote inside a quote draws a bar more (up to three), as the mail will.
          let depth = 0;
          for (let a = n.node.parent; a; a = a.parent) if (a.name === 'Blockquote') depth++;
          const cls = n.name === 'Blockquote' ? (depth ? `md-quote-in${Math.min(depth, 2)}` : 'md-quote-line') : 'md-fence-line';
          for (let l = state.doc.lineAt(n.from).number; l <= state.doc.lineAt(n.to).number; l++) {
            const line = state.doc.line(l);
            out.push(Decoration.line({ class: cls }).range(line.from));
          }
        }
        // What a character is written as (`&lt;`, `\_`) drawn as itself, off the caret's line.
        // escape: Markdown's backslash escape (a syntax node's name), not the key.
        if ((n.name === 'Entity' || n.name === 'Escape') && !onCaret(n.from)) {
          const t = state.doc.sliceString(n.from, n.to);
          // escape: the same node.
          const ch = n.name === 'Escape' ? t.slice(1) : ENTITY[t];
          if (ch) out.push(Decoration.replace({ widget: new Char(ch) }).range(n.from, n.to));
        }
        if (MARKS.has(n.name) && !onCaret(n.from)) {
          // A heading's and a quote's mark take their space with them.
          let end = n.to;
          if ((n.name === 'HeaderMark' || n.name === 'QuoteMark') && state.doc.sliceString(end, end + 1) === ' ') end++;
          if (end > n.from) out.push(Decoration.replace({}).range(n.from, end));
        }
        // An address written out (a link's text, an autolink) is one node: what its characters are written as, inside it.
        if (n.name === 'URL' && state.doc.sliceString(n.from - 1, n.from) !== '(' && !onCaret(n.from)) {
          const t = state.doc.sliceString(n.from, n.to);
          for (const m of t.matchAll(/&(?:lt|gt|amp|quot|#39|nbsp);|\\[!-/:-@[-`{-~]/g)) {
            const ch = m[0][0] === '\\' ? m[0].slice(1) : ENTITY[m[0]];
            if (ch) out.push(Decoration.replace({ widget: new Char(ch) }).range(n.from + m.index!, n.from + m.index! + m[0].length));
          }
        }
        // A link's address folds away (its brackets are marks); an address written as the link's text stays.
        if (n.name === 'URL' && n.node.parent?.name === 'Link' && state.doc.sliceString(n.from - 1, n.from) === '(' && !onCaret(n.from)) out.push(Decoration.replace({}).range(n.from, n.to));
        if (n.name === 'ListMark' && !onCaret(n.from)) {
          const t = state.doc.sliceString(n.from, n.to);
          if (t === '-' || t === '*' || t === '+') out.push(Decoration.replace({ widget: new Bullet() }).range(n.from, n.to));
        }
      },
    });
  }
  // Island stand-ins: their own lines, as chips.
  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to);
    const re = /^\[\[island:([\w-]+)\]\]$/gm;
    for (let m; (m = re.exec(text)); ) {
      const at = from + m.index;
      const isl = stands.island(m[1]);
      const label = isl ? `${isl.kind === 'forward' ? 'Forwarded message' : isl.kind === 'quote' ? 'Quoted text' : 'HTML'}${isl.label ? ` · ${isl.label}` : ''} · ${kb(isl.size)}` : 'Missing part';
      if (onCaret(at)) continue;
      const widget = isl && stands.islandSheet ? new Sheet(m[1], stands.islandSheet) : new Chip(label, isl?.kind ?? 'gone');
      out.push(Decoration.replace({ widget }).range(at, at + m[0].length));
    }
  }
  return Decoration.set(
    out.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide),
    true,
  );
}

/** Plain text: nothing drawn but the stand-ins, as chips (a pasted picture as its thumbnail). */
function buildPlain(view: EditorView, stands: Stands): DecorationSet {
  const out: Range<Decoration>[] = [];
  const state = view.state;
  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to);
    const pic = /!\[[^\]]*\]\(dc-picture:([\w-]+)\)/g;
    for (let m; (m = pic.exec(text)); ) {
      const src = stands.picture(m[1]);
      if (src) out.push(Decoration.replace({ widget: new Thumb(src) }).range(from + m.index, from + m.index + m[0].length));
    }
    const re = /^\[\[island:([\w-]+)\]\]$/gm;
    for (let m; (m = re.exec(text)); ) {
      const isl = stands.island(m[1]);
      const label = isl ? `${isl.kind === 'forward' ? 'Forwarded message' : isl.kind === 'quote' ? 'Quoted text' : 'HTML, as its text'}${isl.label ? ` · ${isl.label}` : ''} · goes as below` : 'Missing part';
      const widget = isl?.text ? new IslandText(label, isl.text, isl.kind) : new Chip(label, isl?.kind ?? 'gone');
      out.push(Decoration.replace({ widget }).range(from + m.index, from + m.index + m[0].length));
    }
  }
  return Decoration.set(out.sort((a, b) => a.from - b.from), true);
}

/** The Plain view's drawing: the stand-ins only. */
export function plainStands(stands: Stands) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildPlain(view, stands);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = buildPlain(u.view, stands);
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin, EditorView.lineWrapping];
}

/** The live drawing, for this document's stand-ins. */
export function liveMarkdown(stands: Stands) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, stands);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = build(u.view, stands);
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [markdown({ base: markdownLanguage }), plugin, EditorView.lineWrapping];
}

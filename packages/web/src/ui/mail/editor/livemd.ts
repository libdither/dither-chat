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
  island: (ref: string) => { kind: string; label: string; size: number } | null;
  picture: (ref: string) => string | null;
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

class Thumb extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(o: Thumb) {
    return o.src === this.src;
  }
  toDOM() {
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
          const src = m ? stands.picture(m[1]) : /^https?:/.test(url) ? url : null;
          if (src) {
            out.push(Decoration.replace({ widget: new Thumb(src) }).range(n.from, n.to));
            return false;
          }
        }
        const cls = STYLE[n.name];
        if (cls) out.push(Decoration.mark({ class: cls }).range(n.from, n.to));
        if (n.name === 'Blockquote' || n.name === 'FencedCode') {
          for (let l = state.doc.lineAt(n.from).number; l <= state.doc.lineAt(n.to).number; l++) {
            const line = state.doc.line(l);
            out.push(Decoration.line({ class: n.name === 'Blockquote' ? 'md-quote-line' : 'md-fence-line' }).range(line.from));
          }
        }
        if (MARKS.has(n.name) && !onCaret(n.from)) {
          // A heading's and a quote's mark take their space with them.
          let end = n.to;
          if ((n.name === 'HeaderMark' || n.name === 'QuoteMark') && state.doc.sliceString(end, end + 1) === ' ') end++;
          if (end > n.from) out.push(Decoration.replace({}).range(n.from, end));
        }
        // A link's address folds away (its brackets are marks).
        if (n.name === 'URL' && n.node.parent?.name === 'Link' && !onCaret(n.from)) out.push(Decoration.replace({}).range(n.from, n.to));
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
      if (!onCaret(at)) out.push(Decoration.replace({ widget: new Chip(label, isl?.kind ?? 'gone') }).range(at, at + m[0].length));
    }
  }
  return Decoration.set(
    out.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide),
    true,
  );
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

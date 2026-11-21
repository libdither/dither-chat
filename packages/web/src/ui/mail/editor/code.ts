/**
 * The Markdown and HTML views' CodeMirror (MailEditor.tsx): a chunk of its own, loaded the first time one of them opens
 * (and ahead, when the pointer goes to the switch), so writing rich text carries none of it.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { html as htmlLang } from '@codemirror/lang-html';
import { bracketMatching, defaultHighlightStyle, foldEffect, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { liveMarkdown, type Stands } from './livemd.ts';

export interface CodeViewOpts {
  parent: HTMLElement;
  mode: 'markdown' | 'html';
  doc: string;
  placeholder: string;
  stands: Stands;
  onSend: () => void;
  /** The text changed (every change; the caller waits for a pause). */
  onText: (text: string) => void;
  /** The caret moved (Markdown: the bar's pressed buttons follow it). */
  onCaret: () => void;
  /** Files pasted or dropped (not text). */
  onFiles: (files: File[]) => void;
  /** Markdown's formatting keys (edits.ts, as the bar's buttons). */
  format: (v: EditorView, f: 'bold' | 'italic' | 'link' | 'clear') => boolean;
  indent: (v: EditorView, out: boolean) => boolean;
}

export function codeView(o: CodeViewOpts): EditorView {
  const md = o.mode === 'markdown';
  const files = (list: FileList | null | undefined, text: string | undefined, ev: Event) => {
    const got = [...(list ?? [])];
    if (!got.length || text) return false;
    ev.preventDefault();
    o.onFiles(got);
    return true;
  };
  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: o.doc,
      extensions: [
        history(),
        keymap.of([
          { key: 'Mod-Enter', run: () => (o.onSend(), true) },
          ...(md
            ? [
                { key: 'Tab', run: (v: EditorView) => o.indent(v, false) },
                { key: 'Shift-Tab', run: (v: EditorView) => o.indent(v, true) },
                { key: 'Mod-b', run: (v: EditorView) => o.format(v, 'bold') },
                { key: 'Mod-i', run: (v: EditorView) => o.format(v, 'italic') },
                { key: 'Mod-k', run: (v: EditorView) => o.format(v, 'link') },
                { key: 'Mod-\\', run: (v: EditorView) => o.format(v, 'clear') },
              ]
            : [indentWithTab]),
          ...foldKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        ...(md ? liveMarkdown(o.stands) : [htmlLang(), syntaxHighlighting(defaultHighlightStyle), foldGutter(), bracketMatching(), indentOnInput(), EditorView.lineWrapping]),
        placeholder(o.placeholder),
        EditorView.contentAttributes.of({ 'aria-label': md ? 'Message, as Markdown' : 'Message, as HTML' }),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet) o.onCaret();
          if (u.docChanged) o.onText(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          paste: (ev) => files(ev.clipboardData?.files, ev.clipboardData?.getData('text/plain'), ev),
          drop: (ev) => files(ev.dataTransfer?.files, undefined, ev),
        }),
      ],
    }),
  });
  // The forwarded mail and quotes are long: folded until you open them.
  if (!md) foldIslands(view);
  return view;
}

/** Every island's inside in the HTML view, folded. */
function foldIslands(view: EditorView) {
  const text = view.state.doc.toString();
  const ranges: { from: number; to: number }[] = [];
  const re = /<div data-dc-island="[^"]*"[^>]*>\n?/g;
  for (let m; (m = re.exec(text)); ) {
    // Its own close: count the divs inside it.
    let depth = 1;
    const tag = /<(\/?)div\b[^>]*>/gi;
    tag.lastIndex = m.index + m[0].length;
    let end = -1;
    for (let t; (t = tag.exec(text)); ) {
      depth += t[1] ? -1 : 1;
      if (!depth) {
        end = t.index;
        break;
      }
    }
    if (end > m.index + m[0].length) ranges.push({ from: m.index + m[0].length, to: end });
    if (end > 0) re.lastIndex = end;
  }
  if (ranges.length) view.dispatch({ effects: ranges.map((r) => foldEffect.of(r)) });
}

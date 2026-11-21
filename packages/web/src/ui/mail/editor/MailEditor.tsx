/**
 * The mail editor (docs/mail.md "Writing"): one document, three ways to see and edit it.
 *
 * - **Rich** (the default): text as it will look, with Markdown's shortcuts as you type (`**`, `# `, `- `, `> `),
 *   pictures pasted or dropped in place, colour, alignment, tables, and forwarded or quoted mail as sealed blocks.
 * - **Markdown**: the same document as Markdown, drawn as you type (livemd.ts); what Markdown can't say stays as small
 *   pieces of HTML or as chips.
 * - **HTML**: the mail's whole HTML, the forwarded part folded, with the mail as it will arrive beside it.
 *
 * The rich document is the one truth (schema.ts): the other views are made from it when opened, and put back into it
 * as one step of undo when left. The switch animates between them: the old view fades and lifts away as the new one
 * settles in, keeping your place.
 */
import type { EditorView } from '@codemirror/view';
import { Editor, generateJSON, type JSONContent } from '@tiptap/core';
import type * as P from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { applyFormat, type Format, formatsAt, indentList, type Sel } from '../../../mail/edits.ts';
import { Icon } from '../../icons.tsx';
import { docHtml, docMarkdown, extensions, fitFrame, type IslandAttrs, islandDoc, newRef, refsOf } from './schema.ts';

export type EditorMode = 'rich' | 'markdown' | 'html';

export interface MailEditorApi {
  focus(): void;
  /** Pictures put in the text where the caret is (pasted elsewhere in the composer, or chosen). */
  addPictures(files: File[]): Promise<void>;
  /** A forwarded mail or a quote put back at the end (after it was taken out). */
  addIsland(island: P.MailIsland, from: string | null): void;
}

export interface MailEditorProps {
  /**
   * The document: HTML (what drafts keep), or Markdown from a draft written before there was HTML; `island`, the
   * forwarded mail or quote a new reply or forward starts with, after the text.
   */
  initial: { html?: string | null; markdown?: string; island?: { island: P.MailIsland; from: string | null } | null };
  mode: EditorMode;
  onMode: (m: EditorMode) => void;
  /** The formatting bar shows. */
  bar: boolean;
  placeholder: string;
  /** Every change: the mail's HTML, and its text part (Markdown, with stand-ins the hub fills in). */
  /** `initial`: the document as the editor first makes it (the quote or the forward added, old Markdown read), not an edit. */
  onChange: (out: { html: string; text: string }, initial: boolean) => void;
  onSend: () => void;
  /** Files it does not take in the text (not pictures, or too big for one): the composer attaches them. */
  onFiles: (files: File[]) => void;
  apiRef?: { current: MailEditorApi | null };
}

/** A picture over this goes as a file, not in the text. */
const INLINE_MAX = 5 * 1024 * 1024;
const isPicture = (f: File) => /^image\/(png|jpeg|gif|webp)$/.test(f.type);
const dataUrl = (f: File) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => no(r.error);
    r.readAsDataURL(f);
  });

/** The document's JSON in place of what is there: one step of undo, or none. */
/**
 * The document made `json`, changing only the stretch that differs: undo history from before (a word made bold, then a
 * trip through the Markdown view) maps through a small change, where a whole-document replace would wipe it out.
 */
function replaceDoc(editor: Editor, json: JSONContent, undoable: boolean) {
  const cur = editor.state.doc;
  const next = editor.schema.nodeFromJSON(json);
  const start = cur.content.findDiffStart(next.content);
  if (start == null) return;
  let { a: endA, b: endB } = cur.content.findDiffEnd(next.content)!;
  // Where the same text repeats around the change, the two ends can cross: move them past the start.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  const tr = editor.state.tr.replace(start, endA, next.slice(start, endB));
  if (!undoable) tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}

type Refs = { islands: Map<string, IslandAttrs>; pictures: Map<string, string> };

/** An island at the end of the document, after an empty line to write in above it. */
function appendIsland(e: Editor, island: P.MailIsland, from: string | null, undoable: boolean) {
  const node = { type: 'island', attrs: { kind: island.kind, html: island.html, label: island.label, from, ref: newRef() } };
  const json = e.getJSON();
  const content: JSONContent[] = [...(json.content ?? [])];
  if (!content.length) content.push({ type: 'paragraph' });
  content.push(node);
  replaceDoc(e, { ...json, content }, undoable);
}

/** Markdown with stand-ins back into the document's JSON. */
function markdownJson(editor: Editor, md: string, refs: Refs): JSONContent {
  const json = editor.markdown!.parse(md);
  const fix = (n: JSONContent): JSONContent => {
    if (n.type === 'paragraph' && n.content?.length === 1 && n.content[0].type === 'text') {
      const m = /^\[\[island:([\w-]+)\]\]$/.exec(String(n.content[0].text).trim());
      const isl = m && refs.islands.get(m[1]);
      if (isl) return { type: 'island', attrs: { ...isl } };
    }
    if (n.type === 'image') {
      const m = /^dc-picture:([\w-]+)$/.exec(String(n.attrs?.src ?? ''));
      if (m) return { ...n, attrs: { ...n.attrs, src: refs.pictures.get(m[1]) ?? '', ref: m[1] } };
    }
    return n.content ? { ...n, content: n.content.map(fix) } : n;
  };
  return fix(json);
}

/** Tags and attributes the document holds as its own; anything else stays exact, as an island. */
const OWN_TAGS = new Set('p br b strong i em u s del strike code pre a ul ol li blockquote h1 h2 h3 hr span img table thead tbody tr th td'.split(' '));
const OWN_ATTRS = new Set(['href', 'src', 'alt', 'width', 'height', 'title', 'rel', 'target', 'colspan', 'rowspan', 'type', 'start', 'dir', 'data-ref']);
const OWN_STYLE = /^\s*((color|text-align|border(-collapse)?|padding|margin|text-decoration|min-width)\s*:[^;]*;?\s*)*$/i;
function own(el: Element): boolean {
  if (!OWN_TAGS.has(el.tagName.toLowerCase())) return false;
  for (const a of [...el.attributes]) {
    const n = a.name.toLowerCase();
    if (n === 'style' ? !OWN_STYLE.test(a.value) : !OWN_ATTRS.has(n)) return false;
  }
  return [...el.children].every(own);
}
const escapeText = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** HTML (the HTML view's, or pasted whole) into the document: what it can't hold as its own becomes islands. */
function htmlJson(editor: Editor, html: string): JSONContent {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  // A style sheet of your own applies to everything: a mail that has one is kept whole (an island's is its own).
  if ([...doc.querySelectorAll('style, link[rel=stylesheet]')].some((el) => !el.closest('div[data-dc-island]'))) return { type: 'doc', content: [{ type: 'island', attrs: { kind: 'html', html, label: '', from: null, ref: newRef() } }] };
  const out: string[] = [];
  for (const n of [...doc.body.childNodes]) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as Element;
      if (el.matches('div[data-dc-island]') || own(el)) out.push(el.outerHTML);
      else out.push(`<div data-dc-island="html">${el.outerHTML}</div>`);
    } else if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) out.push(`<p>${escapeText(n.textContent)}</p>`);
  }
  return generateJSON(out.join(''), editor.extensionManager.extensions);
}

/** The mail's HTML laid out to be read and edited: one block a line. */
function prettyHtml(html: string): string {
  return html
    .replace(/(<\/(p|h[1-6]|li|ul|ol|blockquote|pre|table|tr|thead|tbody|div)>|<(br|hr)\s*\/?>)(?!\n)/gi, '$1\n')
    .replace(/(<(ul|ol|table|thead|tbody|tr|blockquote)(\s[^>]*)?>)(?!\n)/gi, '$1\n')
    .replace(/(<div data-dc-island[^>]*>)(?!\n)/gi, '$1\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** The Markdown and HTML views' CodeMirror (code.ts): loaded when one first opens. */
let codeChunk: Promise<typeof import('./code.ts')> | null = null;
const loadCode = () => (codeChunk ??= import('./code.ts'));

// ------------------------------------------------------------------ the bar

type Cmd = Format | 'underline' | 'color' | 'align' | 'picture' | 'table';
const BUTTONS: { c: Cmd; label: ComponentChildren; title: string; modes: EditorMode[] }[] = [
  { c: 'bold', label: <b>B</b>, title: 'Bold (Ctrl+B)', modes: ['rich', 'markdown'] },
  { c: 'italic', label: <i>I</i>, title: 'Italic (Ctrl+I)', modes: ['rich', 'markdown'] },
  { c: 'underline', label: <u>U</u>, title: 'Underline (Ctrl+U)', modes: ['rich'] },
  { c: 'strike', label: <s>S</s>, title: 'Struck through (Ctrl+Shift+S)', modes: ['rich', 'markdown'] },
  { c: 'color', label: <span class="me-color-a">A</span>, title: 'Text colour', modes: ['rich'] },
  { c: 'link', label: <Icon name="link" size={15} />, title: 'Link (Ctrl+K); or paste an address over the text', modes: ['rich', 'markdown'] },
  { c: 'bullets', label: <Icon name="list" size={15} />, title: 'Bulleted list (Ctrl+Shift+8)', modes: ['rich', 'markdown'] },
  { c: 'numbers', label: <span class="mc-fmt-num">1.</span>, title: 'Numbered list (Ctrl+Shift+7)', modes: ['rich', 'markdown'] },
  { c: 'quote', label: <span class="mc-fmt-quote">❝</span>, title: 'Quote (Ctrl+Shift+B)', modes: ['rich', 'markdown'] },
  { c: 'heading', label: <span class="mc-fmt-h">H</span>, title: 'Heading: larger, then smaller, then off', modes: ['rich', 'markdown'] },
  { c: 'code', label: <code>{'</>'}</code>, title: 'Code: in the line, or a block over several lines', modes: ['rich', 'markdown'] },
  { c: 'align', label: <span class="me-align">≡</span>, title: 'Align: left, centre, right', modes: ['rich'] },
  { c: 'picture', label: <Icon name="image" size={15} />, title: 'Picture in the text (or paste or drop one)', modes: ['rich', 'markdown'] },
  { c: 'table', label: <span class="me-table-ic">▦</span>, title: 'Table (again to remove it)', modes: ['rich'] },
  { c: 'clear', label: <span class="mc-fmt-clear">T<sub>x</sub></span>, title: 'Remove formatting (Ctrl+\\)', modes: ['rich', 'markdown'] },
];
const COLORS = ['#1f2328', '#c2410c', '#b91c1c', '#a21caf', '#1d4ed8', '#0f766e', '#15803d', '#a16207'];
const MODES: { m: EditorMode; label: string; title: string }[] = [
  { m: 'rich', label: 'Rich', title: 'Rich text: as it will look' },
  { m: 'markdown', label: 'Markdown', title: 'Markdown, drawn as you type' },
  { m: 'html', label: 'HTML', title: 'The HTML itself, with the mail as it arrives beside it' },
];

/** What the rich editor is in at the caret, as the bar's pressed buttons. */
function richActive(e: Editor): Set<Cmd> {
  const s = new Set<Cmd>();
  const pairs: [Cmd, string][] = [
    ['bold', 'bold'],
    ['italic', 'italic'],
    ['underline', 'underline'],
    ['strike', 'strike'],
    ['code', 'code'],
    ['code', 'codeBlock'],
    ['link', 'link'],
    ['bullets', 'bulletList'],
    ['numbers', 'orderedList'],
    ['quote', 'blockquote'],
    ['heading', 'heading'],
    ['table', 'table'],
  ];
  for (const [c, n] of pairs) if (e.isActive(n)) s.add(c);
  if (e.getAttributes('textStyle').color) s.add('color');
  if (e.isActive({ textAlign: 'center' }) || e.isActive({ textAlign: 'right' })) s.add('align');
  return s;
}

export function MailEditor(p: MailEditorProps) {
  const richHost = useRef<HTMLDivElement>(null);
  const mdHost = useRef<HTMLDivElement>(null);
  const htmlHost = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLIFrameElement>(null);
  const editor = useRef<Editor | null>(null);
  const cm = useRef<EditorView | null>(null);
  /** What the document was when a Markdown or HTML session began: undo takes the whole session back to it. */
  const before = useRef<JSONContent | null>(null);
  /** The view's text as the session began: unchanged, leaving it changes nothing. */
  const entered = useRef<string | null>(null);
  const refs = useRef<Refs | null>(null);
  const typingTimer = useRef<number | undefined>(undefined);
  const [shown, setShown] = useState<EditorMode>('rich');
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const [leaving, setLeaving] = useState<EditorMode | null>(null);
  const [active, setActive] = useState<Set<Cmd>>(new Set());
  const [pop, setPop] = useState<null | 'link' | 'color'>(null);
  const [linkText, setLinkText] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [, redraw] = useState(0);
  const props = useRef(p);
  props.current = p;
  const pictureInput = useRef<HTMLInputElement>(null);

  const mounting = useRef(false);
  const emit = () => {
    const e = editor.current;
    if (!e) return;
    props.current.onChange({ html: docHtml(e), text: docMarkdown(e) }, mounting.current);
  };

  /** Pictures into the text (at the caret, or as stand-ins in Markdown); anything else goes to the composer. */
  const take = async (files: File[]) => {
    const e = editor.current;
    if (!e) return;
    const pics = files.filter((f) => isPicture(f) && f.size <= INLINE_MAX);
    const rest = files.filter((f) => !pics.includes(f));
    if (rest.length) props.current.onFiles(rest);
    for (const f of pics) {
      const src = await dataUrl(f);
      const ref = newRef();
      const alt = f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[[\]]/g, '');
      const v = cm.current;
      if (shownRef.current === 'markdown' && v) {
        refs.current?.pictures.set(ref, src);
        const at = v.state.selection.main.head;
        const ins = `![${alt}](dc-picture:${ref})`;
        v.dispatch({ changes: { from: at, insert: ins }, selection: { anchor: at + ins.length } });
      } else e.chain().focus().insertContent({ type: 'image', attrs: { src, alt, ref } }).run();
    }
  };

  // The rich editor: made once, kept while the composer is open (the other views are made from it).
  useEffect(() => {
    const e = new Editor({
      element: richHost.current!,
      extensions: extensions(p.placeholder),
      content: p.initial.html ?? '',
      editorProps: {
        attributes: { class: 'me-rich-doc', 'aria-label': 'Message', 'aria-multiline': 'true', role: 'textbox' },
        handlePaste: (_view, ev) => {
          const files = [...(ev.clipboardData?.files ?? [])];
          // Text on the clipboard wins (Word and Docs copy a picture of the selection too).
          if (!files.length || ev.clipboardData?.getData('text/plain')) return false;
          void take(files);
          return true;
        },
        handleDrop: (_view, ev) => {
          const files = [...((ev as DragEvent).dataTransfer?.files ?? [])];
          if (!files.length) return false;
          void take(files);
          return true;
        },
        handleKeyDown: (_view, ev) => {
          const mod = ev.ctrlKey || ev.metaKey;
          if (ev.key === 'Enter' && mod) {
            ev.preventDefault();
            props.current.onSend();
            return true;
          }
          if (mod && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'k') {
            ev.preventDefault();
            run('link');
            return true;
          }
          if (mod && !ev.altKey && ev.key === '\\') {
            ev.preventDefault();
            run('clear');
            return true;
          }
          return false;
        },
      },
      onUpdate: () => {
        if (shownRef.current === 'rich') emit();
      },
      onTransaction: ({ editor: ed }) => setActive(richActive(ed)),
    });
    editor.current = e;
    mounting.current = true;
    // A draft kept before there was HTML: Markdown, read once and kept as HTML from now on.
    if (!p.initial.html && p.initial.markdown) replaceDoc(e, markdownJson(e, p.initial.markdown, { islands: new Map(), pictures: new Map() }), false);
    if (!p.initial.html && p.initial.island) appendIsland(e, p.initial.island.island, p.initial.island.from, false);
    if (!p.initial.html && (p.initial.markdown || p.initial.island)) emit();
    mounting.current = false;
    if (p.apiRef)
      p.apiRef.current = {
        focus: () => (shownRef.current === 'rich' ? void e.commands.focus() : cm.current?.focus()),
        addPictures: (files) => take(files),
        addIsland: (island, from) => {
          void switchTo('rich', false).then(() => appendIsland(e, island, from, true));
        },
      };
    if (p.mode !== 'rich') void switchTo(p.mode, false);
    return () => {
      clearTimeout(typingTimer.current);
      cm.current?.destroy();
      cm.current = null;
      e.destroy();
      editor.current = null;
      if (p.apiRef) p.apiRef.current = null;
    };
  }, []);

  // ---------------------------------------------------------------- the other views

  /** The Markdown or HTML view's text back into the document (silently while typing; one undo step when leaving). */
  const putBack = (mode: EditorMode, text: string, undoable: boolean) => {
    const e = editor.current;
    if (!e) return;
    const json = mode === 'markdown' ? markdownJson(e, text, refs.current ?? refsOf(e)) : htmlJson(e, text);
    if (undoable && before.current) {
      // Undo takes the session back as one step: from where it began to where it ended.
      replaceDoc(e, before.current, false);
      replaceDoc(e, json, true);
    } else replaceDoc(e, json, false);
  };

  /** Markdown formatting on the CodeMirror view, with the same edits the old composer made (edits.ts). */
  const mdSel = (v: EditorView): Sel => ({ text: v.state.doc.toString(), start: v.state.selection.main.from, end: v.state.selection.main.to });
  const mdPut = (v: EditorView, next: Sel) => {
    const cur = v.state.doc.toString();
    // The changed stretch only, so undo and the caret behave.
    let a = 0;
    while (a < cur.length && a < next.text.length && cur[a] === next.text[a]) a++;
    let b = 0;
    while (b < cur.length - a && b < next.text.length - a && cur[cur.length - 1 - b] === next.text[next.text.length - 1 - b]) b++;
    v.dispatch({ changes: { from: a, to: cur.length - b, insert: next.text.slice(a, next.text.length - b) }, selection: { anchor: next.start, head: next.end } });
    v.focus();
  };
  const mdFormat = (v: EditorView, f: Format) => (mdPut(v, applyFormat(mdSel(v), f)), true);
  const mdIndent = (v: EditorView, out: boolean) => {
    const next = indentList(mdSel(v), out);
    if (!next) return false;
    mdPut(v, next);
    return true;
  };

  const mountCode = (code: typeof import('./code.ts'), mode: 'markdown' | 'html') => {
    const e = editor.current!;
    before.current = e.getJSON();
    refs.current = refsOf(e);
    const r = refs.current;
    const text = mode === 'markdown' ? docMarkdown(e) : prettyHtml(docHtml(e));
    entered.current = text;
    cm.current = code.codeView({
      parent: mode === 'markdown' ? mdHost.current! : htmlHost.current!,
      mode,
      doc: text,
      placeholder: props.current.placeholder,
      stands: {
        island: (ref) => {
          const i = r.islands.get(ref);
          return i ? { kind: i.kind, label: i.label, size: new Blob([i.html]).size } : null;
        },
        picture: (ref) => r.pictures.get(ref) ?? null,
      },
      onSend: () => props.current.onSend(),
      onText: (t) => {
        clearTimeout(typingTimer.current);
        typingTimer.current = window.setTimeout(() => {
          putBack(mode, t, false);
          emit();
          if (mode === 'html') setPreviewHtml(t);
        }, 300);
      },
      onCaret: () => mode === 'markdown' && redraw((n) => n + 1),
      onFiles: (files) => void take(files),
      format: mdFormat,
      indent: mdIndent,
    });
    if (mode === 'html') setPreviewHtml(text);
  };
  const unmountCode = (mode: EditorMode) => {
    const v = cm.current;
    if (!v) return;
    clearTimeout(typingTimer.current);
    // Only looked at: the document stays exactly as it was (no round trip through the text, no undo step).
    const text = v.state.doc.toString();
    if (text !== entered.current) putBack(mode, text, true);
    else if (before.current) replaceDoc(editor.current!, before.current, false);
    before.current = null;
    refs.current = null;
    v.destroy();
    cm.current = null;
    emit();
  };

  /** The switch: the old view leaves as the new one comes, at the same place in the text. */
  const switching = useRef<EditorMode | null>(null);
  const switchTo = async (to: EditorMode, animate = true) => {
    if (to === shownRef.current) {
      // Back to the one shown before a load finished: that load is no longer wanted.
      switching.current = null;
      return;
    }
    if (switching.current === to) return;
    switching.current = to;
    const code = to === 'rich' ? null : await loadCode();
    // Another switch came while it loaded, or the editor closed.
    if (switching.current !== to || !editor.current) return;
    switching.current = null;
    const from = shownRef.current;
    const scroller = richHost.current?.closest('.mc-scroll') as HTMLElement | null;
    const ratio = scroller && scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight) : 0;
    if (from !== 'rich') unmountCode(from);
    if (to !== 'rich') mountCode(code!, to);
    shownRef.current = to;
    setShown(to);
    setPop(null);
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setLeaving(from);
      window.setTimeout(() => setLeaving((l) => (l === from ? null : l)), 280);
    }
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (to === 'rich') editor.current?.commands.focus();
      else cm.current?.focus();
    });
  };
  useLayoutEffect(() => {
    if (editor.current && p.mode !== shownRef.current) void switchTo(p.mode);
  }, [p.mode]);

  // A popover open: Escape closes it (and not the composer).
  useLayoutEffect(() => {
    if (!pop) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setPop(null);
      editor.current?.commands.focus();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [pop]);

  // The HTML view's mail as it arrives, as tall as it is.
  useEffect(() => {
    const f = preview.current;
    if (!f || shown !== 'html') return;
    return fitFrame(f);
  }, [shown, previewHtml]);

  // ---------------------------------------------------------------- the bar's commands

  const run = (c: Cmd) => {
    const e = editor.current;
    if (!e) return;
    if (shownRef.current === 'markdown') {
      const v = cm.current;
      if (!v) return;
      if (c === 'picture') return pictureInput.current?.click();
      if (c === 'underline' || c === 'color' || c === 'align' || c === 'table') return;
      mdFormat(v, c);
      return;
    }
    if (shownRef.current === 'html') return;
    const ch = e.chain().focus();
    switch (c) {
      case 'bold':
        return void ch.toggleBold().run();
      case 'italic':
        return void ch.toggleItalic().run();
      case 'underline':
        return void ch.toggleUnderline().run();
      case 'strike':
        return void ch.toggleStrike().run();
      case 'code': {
        const { from, to, empty } = e.state.selection;
        const block = empty || e.isActive('codeBlock') || e.state.doc.textBetween(from, to, '\n').includes('\n');
        return void (block ? ch.toggleCodeBlock() : ch.toggleCode()).run();
      }
      case 'bullets':
        return void ch.toggleBulletList().run();
      case 'numbers':
        return void ch.toggleOrderedList().run();
      case 'quote':
        return void ch.toggleBlockquote().run();
      case 'heading': {
        const lvl = ([1, 2, 3] as const).find((l) => e.isActive('heading', { level: l }));
        return void (lvl === 3 ? ch.setParagraph() : ch.setHeading({ level: lvl ? ((lvl + 1) as 2 | 3) : 1 })).run();
      }
      case 'align': {
        const now = e.isActive({ textAlign: 'center' }) ? 'center' : e.isActive({ textAlign: 'right' }) ? 'right' : 'left';
        return void ch.setTextAlign(now === 'left' ? 'center' : now === 'center' ? 'right' : 'left').run();
      }
      case 'table':
        return void (e.isActive('table') ? ch.deleteTable() : ch.insertTable({ rows: 3, cols: 3, withHeaderRow: true })).run();
      case 'picture':
        return pictureInput.current?.click();
      case 'clear':
        return void ch.unsetAllMarks().clearNodes().unsetTextAlign().run();
      case 'link':
        if (e.isActive('link')) return void ch.extendMarkRange('link').unsetLink().run();
        setLinkText('');
        return setPop('link');
      case 'color':
        return setPop((x) => (x === 'color' ? null : 'color'));
    }
  };
  const on: Set<Cmd> = shown === 'markdown' && cm.current ? (formatsAt(mdSel(cm.current)) as Set<Cmd>) : shown === 'rich' ? active : new Set();

  const applyLink = () => {
    const e = editor.current;
    let url = linkText.trim();
    setPop(null);
    if (!e || !url) return void e?.commands.focus();
    if (!/^(https?:|mailto:)/i.test(url)) url = /@/.test(url) && !/\//.test(url) ? `mailto:${url}` : `https://${url}`;
    if (e.state.selection.empty) e.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    else e.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const view = (m: EditorMode) => `me-view me-${m}${shown === m ? ' shown' : ''}${leaving === m ? ' leaving' : ''}${shown === m && leaving ? ' entering' : ''}`;
  return (
    <div class={`me me-is-${shown}`}>
      <div class="me-views">
        <div class={view('rich')} ref={richHost} />
        <div class={view('markdown')} ref={mdHost} />
        <div class={view('html')}>
          <div ref={htmlHost} class="me-html-code" />
          {shown === 'html' && (
            <div class="me-html-preview">
              <div class="me-html-preview-head">As it arrives</div>
              <iframe ref={preview} class="me-island-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="The mail as it arrives" srcdoc={islandDoc(previewHtml)} />
            </div>
          )}
        </div>
      </div>
      <input
        ref={pictureInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const el = e.target as HTMLInputElement;
          const list = [...(el.files ?? [])];
          el.value = '';
          if (list.length) void take(list);
        }}
      />
      {p.bar && pop === 'link' && (
        <div class="me-pop" role="dialog" aria-label="Link">
          <input
            class="me-pop-input"
            type="url"
            placeholder="Paste or type an address"
            value={linkText}
            autoFocus
            onInput={(e) => setLinkText((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyLink();
              }
            }}
          />
          <button class="btn small primary" type="button" onClick={applyLink}>
            Link
          </button>
        </div>
      )}
      {p.bar && pop === 'color' && (
        <div class="me-pop me-colors" role="dialog" aria-label="Text colour">
          {COLORS.map((c) => (
            <button
              class="me-swatch"
              type="button"
              style={{ background: c }}
              title={c}
              aria-label={`Colour ${c}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.current?.chain().focus().setColor(c).run();
                setPop(null);
              }}
            />
          ))}
          <button
            class="btn small ghost"
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              editor.current?.chain().focus().unsetColor().run();
              setPop(null);
            }}
          >
            None
          </button>
        </div>
      )}
      {p.bar && (
        <div class="mc-format me-bar" role="toolbar" aria-label="Formatting">
          {BUTTONS.filter((b) => b.modes.includes(shown)).map((b) => (
            <button
              class={`mc-fmt mc-fmt-${b.c}${on.has(b.c) ? ' on' : ''}`}
              type="button"
              title={b.title}
              aria-label={b.title}
              aria-pressed={b.c === 'clear' || b.c === 'picture' ? undefined : on.has(b.c)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(b.c)}
            >
              {b.label}
            </button>
          ))}
          {shown === 'html' && <span class="me-bar-note">Edit the HTML; the mail as it arrives is beside it.</span>}
          <span class="mc-fmt-gap" />
          <div class="me-modes" role="radiogroup" aria-label="Edit as" onPointerEnter={() => void loadCode()} style={{ '--at': MODES.findIndex((x) => x.m === shown) }}>
            <span class="me-modes-thumb" aria-hidden="true" />
            {MODES.map((x) => (
              <button
                class={`me-mode${shown === x.m ? ' on' : ''}`}
                type="button"
                role="radio"
                aria-checked={shown === x.m}
                title={x.title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => p.onMode(x.m)}
              >
                {x.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

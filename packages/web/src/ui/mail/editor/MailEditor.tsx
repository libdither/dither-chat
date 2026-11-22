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
import { TextSelection } from '@tiptap/pm/state';
import type * as P from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { applyFormat, type Format, formatsAt, indentList, type Sel } from '../../../mail/edits.ts';
import { Icon } from '../../icons.tsx';
import { docHtml, docMarkdown, extensions, fitFrame, type IslandAttrs, islandDoc, type IslandEdit, islandName, islandText, newRef, refsOf, setLeftOut, webBox } from './schema.ts';

export type EditorMode = 'rich' | 'markdown' | 'html' | 'plain';

export interface MailEditorApi {
  focus(): void;
  /** Pictures put in the text where the caret is (pasted elsewhere in the composer, or chosen). */
  addPictures(files: File[]): Promise<void>;
  /** A forwarded mail or a quote put back at the end (after it was taken out). */
  addIsland(island: P.MailIsland, from: string | null): void;
  /** What was typed in the last moment, which the views write back after a pause, written back now (before a send). */
  flush(): void;
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
  /** Addresses of pictures from the web that will not go as the mail is sent: faded in the frames. */
  leftOut?: string[];
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

const SHEET_NAME: Record<string, string> = { forward: 'Forwarded message', quote: 'Quoted text', html: 'HTML' };

/**
 * Markdown: a block kept whole, drawn as it will arrive, under a bar that says what it is (its own HTML, which Markdown
 * can't say, sent as it is) and opens it in the HTML view.
 */
function islandSheet(i: IslandAttrs, onEdit: () => void): HTMLElement {
  const box = document.createElement('div') as HTMLDivElement & { dcStop?: () => void };
  box.className = 'md-island-sheet';
  box.dataset.kind = i.kind;
  const bar = document.createElement('div');
  bar.className = 'md-island-sheet-bar';
  const name = document.createElement('span');
  const said = islandName(i.kind, i.label, i.html);
  name.textContent = said.text;
  name.title = said.title;
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'md-island-sheet-btn';
  // Not Rich's "Edit HTML" (which opens an editor under the block): this one goes to the whole mail's HTML.
  edit.textContent = 'Open in HTML view';
  edit.onmousedown = (e) => e.preventDefault();
  edit.onclick = onEdit;
  bar.append(name, edit);
  const f = document.createElement('iframe');
  f.className = 'me-island-frame';
  f.setAttribute('sandbox', 'allow-same-origin');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.title = SHEET_NAME[i.kind] ?? 'HTML';
  f.srcdoc = islandDoc(i.html);
  box.append(bar, f);
  box.dcStop = fitFrame(f);
  return box;
}

type Refs = { islands: Map<string, IslandAttrs>; pictures: Map<string, string>; attrs?: Map<string, Record<string, unknown>> };

/** Styles that change nothing you see (Apple Mail wraps every message in the first two). */
const UNSEEN_STYLE = /^(line-break|-webkit-nbsp-mode|-webkit-line-break|word-break|overflow-wrap|word-wrap|unicode-bidi)$/i;
/** The styles the document keeps, by tag: a span's colour, a paragraph's or heading's alignment, a quote's bar and margins (it draws its own). */
const KEPT_STYLE: Record<string, RegExp> = { span: /^color$/i, p: /^text-align$/i, h1: /^text-align$/i, h2: /^text-align$/i, h3: /^text-align$/i, blockquote: /^(margin|padding|border-left)(-\w+)?$/i };
const PLAIN_TAGS = new Set([...'p br b strong i em u s del strike code pre a ul ol li blockquote h1 h2 h3 hr span img div'.split(' ')]);
const PLAIN_ATTRS = /^(href|src|alt|width|height|title|rel|target|type|start|class|data-dc-src|data-dc-held|data-dc-text)$/i;
/** One declaration of an original's style that the document keeps, or that changes nothing to lose. */
function styleKept(tag: string, prop: string, value: string): boolean {
  if (UNSEEN_STYLE.test(prop)) return true;
  // The document is left to right, and has no spacing of its own to lose where there was none.
  if (/^direction$/i.test(prop)) return /^\s*ltr\s*$/i.test(value);
  if (/^(margin|padding)(-\w+)?$/i.test(prop) && /^\s*(0[a-z%]*\s*)+$/i.test(value)) return true;
  if (/^text-align$/i.test(prop) && /^\s*(left|start)\s*$/i.test(value)) return true;
  return KEPT_STYLE[tag]?.test(prop) ?? false;
}
/**
 * An original's element the document can hold as its own text: plain tags, and nothing in its style or direction that
 * would be lost (a colour on a paragraph, an indent, a font, right to left: those keep it whole).
 */
function plainEnough(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (!PLAIN_TAGS.has(tag)) return false;
  for (const a of [...el.attributes]) {
    if (a.name === 'dir') {
      if (!/^\s*ltr\s*$/i.test(a.value)) return false;
    } else if (a.name === 'style') {
      for (const decl of a.value.split(';')) {
        const at = decl.indexOf(':');
        if (decl.trim() && (at < 0 || !styleKept(tag, decl.slice(0, at).trim(), decl.slice(at + 1)))) return false;
      }
    } else if (!PLAIN_ATTRS.test(a.name)) return false;
  }
  return [...el.children].every(plainEnough);
}
const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * A forward or a quote as the document's own blocks, when the document can hold it with nothing lost (its text and its
 * pictures all there): the forwarded-message lines or the attribution as a line, then the original, a quote's in a
 * quote. Null when it has to stay whole, as an island (a newsletter's layout, its own styles).
 */
function islandBlocks(e: Editor, island: P.MailIsland): JSONContent[] | null {
  if (island.kind !== 'forward' && island.kind !== 'quote') return null;
  const d = new DOMParser().parseFromString(`<body>${island.html}</body>`, 'text/html');
  if (d.querySelector('style, link, table, font, center')) return null;
  const head = d.body.querySelector(':scope > .dc-quote-head, :scope > .dc-forward-head');
  const rest = [...d.body.children].filter((x) => x !== head);
  if (!head || !rest.length || !rest.every(plainEnough)) return null;
  const content = islandText(e, island.html);
  // Nothing lost on the way: the same words, the same pictures.
  const made = e.schema.nodeFromJSON({ type: 'doc', content });
  let pics = 0;
  made.descendants((n) => void (n.type.name === 'image' && pics++));
  if (squash(made.textBetween(0, made.content.size, '', '')) !== squash(d.body.textContent ?? '') || pics !== d.querySelectorAll('img').length) return null;
  return content;
}

/** A forward or a quote at the end of the document, after an empty line to write in above it: as its own text when it can be, else an island. */
function appendIsland(e: Editor, island: P.MailIsland, from: string | null, undoable: boolean) {
  const blocks = islandBlocks(e, island);
  const node = { type: 'island', attrs: { kind: island.kind, html: island.html, label: island.label, from, ref: newRef() } };
  const json = e.getJSON();
  const content: JSONContent[] = [...(json.content ?? [])];
  const empty = (n?: JSONContent) => n?.type === 'paragraph' && !n.content?.length;
  // One empty line above it is enough (taking a block out and putting it back leaves more).
  while (content.length > 1 && empty(content[content.length - 1]) && empty(content[content.length - 2])) content.pop();
  if (!content.length || content[content.length - 1].type !== 'paragraph' || content[content.length - 1].content?.length) content.push({ type: 'paragraph' });
  const first = content.length;
  content.push(...(blocks ?? [node]));
  replaceDoc(e, { ...json, content }, undoable);
  // The caret at the end of the line above it, never on the block itself (typing there would replace the quote), nor
  // on the attribution line: counted from the front, as the editor keeps an empty line after a quote at the end.
  const doc = e.state.doc;
  let at = 0;
  for (let i = 0; i < first; i++) at += doc.child(i).nodeSize;
  e.view.dispatch(e.state.tr.setSelection(TextSelection.near(doc.resolve(at - 1), -1)).setMeta('addToHistory', false));
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
      // Its size and an original's address come back too: Markdown can't say them.
      if (m) return { ...n, attrs: { ...n.attrs, ...(refs.attrs?.get(m[1]) ?? {}), alt: n.attrs?.alt ?? null, title: n.attrs?.title ?? null, src: refs.pictures.get(m[1]) ?? '', ref: m[1] } };
    }
    return n.content ? { ...n, content: n.content.map(fix) } : n;
  };
  return fix(json);
}

/** Tags and attributes the document holds as its own; anything else stays exact, as an island. */
const OWN_TAGS = new Set('p br b strong i em u s del strike code pre a ul ol li blockquote h1 h2 h3 hr span img table colgroup col thead tbody tr th td'.split(' '));
const OWN_ATTRS = new Set(['href', 'src', 'alt', 'width', 'height', 'title', 'rel', 'target', 'colspan', 'rowspan', 'type', 'start', 'dir', 'data-ref', 'data-dc-src', 'data-dc-held']);
const OWN_STYLE = /^\s*((color|text-align|border(-collapse|-left)?|padding(-left)?|margin(-left)?|text-decoration|min-width|aspect-ratio|max-height)\s*:[^;]*;?\s*)*$/i;
function own(el: Element): boolean {
  if (!OWN_TAGS.has(el.tagName.toLowerCase())) return false;
  for (const a of [...el.attributes]) {
    const n = a.name.toLowerCase();
    // A code block's language is its own too (class="language-js").
    if (n === 'class' ? !/^language-[\w+#-]+$/.test(a.value) : n === 'style' ? !OWN_STYLE.test(a.value) : !OWN_ATTRS.has(n)) return false;
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

/** Pasted pictures' bytes out of the HTML view's text, as `dc-picture:id` (as in Markdown), and back in. */
function picturesOut(html: string, r: Refs): string {
  const ids = new Map([...r.pictures].map(([ref, src]) => [src, ref]));
  return html.replace(/src="(data:[^"]+)"/g, (m, src: string) => (ids.has(src) ? `src="dc-picture:${ids.get(src)}"` : m));
}
function picturesIn(html: string, r: Refs): string {
  return html.replace(/src="dc-picture:([\w-]+)"/g, (m, ref: string) => (r.pictures.has(ref) ? `src="${r.pictures.get(ref)}"` : m));
}

/**
 * Markdown as plain text goes: the small pieces of HTML Markdown keeps (colour, alignment) taken off, their text kept,
 * entities read. Markdown's own marks (`**bold**`, `- `, `> `) stay: they are how plain text says it.
 */
function plainText(md: string): string {
  const bare = md
    // Lines of nothing but spaces (empty paragraphs) are blank lines; none at the start.
    .replace(/^[ \t\u00a0]+$/gm, '')
    .replace(/^(&nbsp;|\s)+/, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|div|li|tr|blockquote)>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
  const t = document.createElement('textarea');
  t.innerHTML = bare;
  return t.value.replace(/\u00a0/g, ' ');
}

/** An island's words, a block a line, as near as the page can tell what the hub's text part will hold. */
function islandWords(html: string): string {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('style, script, title').forEach((x) => x.remove());
  d.querySelectorAll('br').forEach((x) => x.replaceWith('\n'));
  d.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, tr, blockquote, table').forEach((x) => x.append('\n'));
  return (d.body.textContent ?? '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
/** `more`: behind the bar's ⋯ until opened (it stays open), to keep the bar to one row. */
const BUTTONS: { c: Cmd; label: ComponentChildren; title: string; modes: EditorMode[]; more?: true }[] = [
  { c: 'bold', label: <b>B</b>, title: 'Bold (Ctrl+B)', modes: ['rich', 'markdown'] },
  { c: 'italic', label: <i>I</i>, title: 'Italic (Ctrl+I)', modes: ['rich', 'markdown'] },
  { c: 'underline', label: <u>U</u>, title: 'Underline (Ctrl+U)', modes: ['rich'] },
  { c: 'strike', label: <s>S</s>, title: 'Struck through (Ctrl+Shift+S)', modes: ['rich', 'markdown'], more: true },
  { c: 'color', label: <span class="me-color-a">A</span>, title: 'Text colour', modes: ['rich'], more: true },
  { c: 'link', label: <Icon name="link" size={15} />, title: 'Link (Ctrl+K); or paste an address over the text', modes: ['rich', 'markdown'] },
  { c: 'bullets', label: <Icon name="list" size={15} />, title: 'Bulleted list (Ctrl+Shift+8)', modes: ['rich', 'markdown'] },
  { c: 'numbers', label: <span class="mc-fmt-num">1.</span>, title: 'Numbered list (Ctrl+Shift+7)', modes: ['rich', 'markdown'] },
  { c: 'quote', label: <span class="mc-fmt-quote">❝</span>, title: 'Quote (Ctrl+Shift+B)', modes: ['rich', 'markdown'] },
  { c: 'heading', label: <span class="mc-fmt-h">H</span>, title: 'Heading: larger, then smaller, then off', modes: ['rich', 'markdown'], more: true },
  { c: 'code', label: <code>{'</>'}</code>, title: 'Code: in the line, or a block over several lines', modes: ['rich', 'markdown'], more: true },
  { c: 'align', label: <span class="me-align">≡</span>, title: 'Align: left, centre, right', modes: ['rich'], more: true },
  { c: 'picture', label: <Icon name="image" size={15} />, title: 'Picture in the text (or paste or drop one)', modes: ['rich', 'markdown'] },
  { c: 'table', label: <span class="me-table-ic">▦</span>, title: 'Table (again to remove it)', modes: ['rich'], more: true },
  { c: 'clear', label: <span class="mc-fmt-clear">T<sub>x</sub></span>, title: 'Remove formatting (Ctrl+\\)', modes: ['rich', 'markdown'], more: true },
];
// No near-black: "None" is the text's own colour, which a dark theme draws light.
const COLORS = ['#c2410c', '#b91c1c', '#a21caf', '#1d4ed8', '#0f766e', '#15803d', '#a16207'];
const MODES: { m: EditorMode; label: string; title: string }[] = [
  { m: 'rich', label: 'Rich', title: 'Rich text: as it will look' },
  { m: 'markdown', label: 'Markdown', title: 'Markdown, drawn as you type' },
  { m: 'html', label: 'HTML', title: 'The HTML itself, with the mail as it arrives beside it' },
  { m: 'plain', label: 'Plain', title: 'Plain text only: no HTML part; the text here is exactly what they get' },
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
  const plainHost = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLIFrameElement>(null);
  const editor = useRef<Editor | null>(null);
  const cm = useRef<EditorView | null>(null);
  /** What the document was when a Markdown or HTML session began: undo takes the whole session back to it. */
  const before = useRef<JSONContent | null>(null);
  /** The view's text as the session began: unchanged, leaving it changes nothing. */
  const entered = useRef<string | null>(null);
  const refs = useRef<Refs | null>(null);
  const typingTimer = useRef<number | undefined>(undefined);
  /** The Markdown, HTML or Plain view's text waiting for its pause to go into the document; each open island editor's. */
  const pending = useRef<(() => void) | null>(null);
  const islandPending = useRef(new Set<() => void>());
  const flush = () => {
    for (const put of [...islandPending.current]) put();
    clearTimeout(typingTimer.current);
    const put = pending.current;
    pending.current = null;
    put?.();
  };
  const [shown, setShown] = useState<EditorMode>('rich');
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const [leaving, setLeaving] = useState<EditorMode | null>(null);
  const [active, setActive] = useState<Set<Cmd>>(new Set());
  const [pop, setPop] = useState<null | 'link' | 'color'>(null);
  const [linkText, setLinkText] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const rootEl = useRef<HTMLDivElement>(null);
  const leftOutKey = (p.leftOut ?? []).join('\n');
  useEffect(() => {
    if (rootEl.current) setLeftOut(rootEl.current, p.leftOut ?? []);
  }, [leftOutKey]);
  /** On a phone the HTML view shows one at a time: the code, or the mail as it arrives. */
  const [pane, setPane] = useState<'code' | 'preview'>('code');
  const [, redraw] = useState(0);
  const props = useRef(p);
  props.current = p;
  const pictureInput = useRef<HTMLInputElement>(null);
  const [more, setMore] = useState(() => {
    try {
      return localStorage.getItem('dither.mail.formatMore') === '1';
    } catch {
      return false;
    }
  });
  const toggleMore = () => {
    setMore(!more);
    try {
      localStorage.setItem('dither.mail.formatMore', more ? '0' : '1');
    } catch {}
  };
  /** The bar is one stop for Tab; the arrows move along it (and Home, End). */
  const barKeys = (ev: KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -1e9, End: 1e9 };
    if (!(ev.key in keys)) return;
    const list = [...(ev.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.offsetParent);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    ev.preventDefault();
    const to = list[Math.max(0, Math.min(list.length - 1, at + keys[ev.key]))];
    for (const b of list) b.tabIndex = b === to ? 0 : -1;
    to.focus();
  };

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
    // Plain text has no pictures in it: they go as files.
    if (shownRef.current === 'plain') return props.current.onFiles(files);
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
    // An island's "Edit HTML" (schema.ts): its own HTML editor, under it.
    const editHtml = (ev: Event) => void editIsland((ev as CustomEvent<IslandEdit>).detail);
    richHost.current!.addEventListener('me-edit-island', editHtml);
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
          // Rich, as the composer has it too: from Plain that means an HTML part again (MailDraft.plainOnly off).
          if (shownRef.current !== 'rich') props.current.onMode('rich');
          void switchTo('rich', false).then(() => {
            appendIsland(e, island, from, true);
            e.commands.focus();
          });
        },
        flush,
      };
    if (p.mode !== 'rich') void switchTo(p.mode, false);
    return () => {
      richHost.current?.removeEventListener('me-edit-island', editHtml);
      clearTimeout(typingTimer.current);
      cm.current?.destroy();
      cm.current = null;
      e.destroy();
      editor.current = null;
      if (p.apiRef) p.apiRef.current = null;
    };
  }, []);

  // ---------------------------------------------------------------- an island's own HTML, edited in place

  /** The HTML editor under an island (schema.ts IslandEdit): what you type draws it again; Done closes it. */
  const editIsland = async (o: IslandEdit) => {
    const code = await loadCode();
    let timer = 0;
    let waiting: (() => void) | null = null;
    // Laid out to be read; it goes back only when you change it (else the island stays byte for byte as it was).
    const shown = prettyHtml(o.html);
    const v = code.codeView({
      parent: o.host,
      mode: 'html',
      doc: shown,
      placeholder: 'Its HTML',
      stands: { island: () => null, picture: () => null, webBox },
      onSend: () => props.current.onSend(),
      onText: (t) => {
        clearTimeout(timer);
        if (waiting) islandPending.current.delete(waiting);
        // Sent or switched away from before the pause: flush() puts it in first.
        const put = () => {
          clearTimeout(timer);
          islandPending.current.delete(put);
          waiting = null;
          o.set(t);
        };
        waiting = put;
        islandPending.current.add(put);
        timer = window.setTimeout(put, 250);
      },
      onCaret: () => {},
      onFiles: () => {},
      format: () => false,
      indent: () => false,
    });
    v.focus();
    o.host.addEventListener(
      'me-island-done',
      () => {
        clearTimeout(timer);
        if (waiting) islandPending.current.delete(waiting);
        if (v.state.doc.toString() !== shown) o.set(v.state.doc.toString());
        v.destroy();
        o.closed();
      },
      { once: true },
    );
  };

  // ---------------------------------------------------------------- the other views

  /** The Markdown or HTML view's text back into the document (silently while typing; one undo step when leaving). */
  const putBack = (mode: EditorMode, text: string, undoable: boolean) => {
    const e = editor.current;
    if (!e) return;
    const json = mode === 'html' ? htmlJson(e, picturesIn(text, refs.current ?? refsOf(e))) : markdownJson(e, text, refs.current ?? refsOf(e));
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

  const mountCode = (code: typeof import('./code.ts'), mode: 'markdown' | 'html' | 'plain') => {
    const e = editor.current!;
    // A block's HTML typed a moment ago is in the document before the view takes its copy.
    flush();
    before.current = e.getJSON();
    refs.current = refsOf(e);
    const r = refs.current;
    const text = mode === 'html' ? picturesOut(prettyHtml(docHtml(e)), r) : mode === 'plain' ? plainText(docMarkdown(e)) : docMarkdown(e);
    entered.current = text;
    cm.current = code.codeView({
      parent: mode === 'html' ? htmlHost.current! : mode === 'plain' ? plainHost.current! : mdHost.current!,
      mode,
      doc: text,
      placeholder: props.current.placeholder,
      stands: {
        island: (ref) => {
          const i = r.islands.get(ref);
          if (!i) return null;
          // The hub's own text while the island is as it made it; else its words, read from the HTML.
          const made = props.current.initial.island?.island;
          const text = made?.text && made.html === i.html ? made.text : islandWords(i.html);
          return { kind: i.kind, label: i.label, size: new Blob([i.html]).size, text };
        },
        picture: (ref) => r.pictures.get(ref) ?? null,
        webBox,
        islandSheet: (ref) => {
          const i = r.islands.get(ref);
          return i ? islandSheet(i, () => props.current.onMode('html')) : null;
        },
      },
      onSend: () => props.current.onSend(),
      onText: (t) => {
        clearTimeout(typingTimer.current);
        pending.current = () => {
          putBack(mode, t, false);
          emit();
          if (mode === 'html') setPreviewHtml(picturesIn(t, r));
        };
        typingTimer.current = window.setTimeout(flush, 300);
      },
      onCaret: () => mode === 'markdown' && redraw((n) => n + 1),
      onFiles: (files) => void take(files),
      format: mdFormat,
      indent: mdIndent,
    });
    if (mode === 'html') setPreviewHtml(picturesIn(text, r));
  };
  const unmountCode = (mode: EditorMode) => {
    const v = cm.current;
    if (!v) return;
    clearTimeout(typingTimer.current);
    pending.current = null;
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
      // HTML and Plain are other shapes than the page (a long forward folds to a line): they start at the top.
      if (scroller) scroller.scrollTop = to === 'html' || to === 'plain' ? 0 : ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
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
    if (shownRef.current === 'html' || shownRef.current === 'plain') return;
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
  // The view switch's thumb slides to the picked label, as wide as it ("Rich" is narrower than "Markdown").
  const modesBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = modesBox.current;
    const b = box?.querySelector<HTMLElement>('.me-mode.on');
    if (!box || !b) return;
    box.style.setProperty('--x', `${b.offsetLeft}px`);
    box.style.setProperty('--w', `${b.offsetWidth}px`);
  }, [shown, p.bar]);
  return (
    <div ref={rootEl} class={`me me-is-${shown}`}>
      <div class="me-views">
        <div class={view('rich')} ref={richHost} />
        <div class={view('markdown')} ref={mdHost} />
        <div class={view('plain')} ref={plainHost} />
        <div class={view('html')} data-pane={pane}>
          {shown === 'html' && (
            <div class="me-html-panes" role="tablist" aria-label="Show">
              {(['code', 'preview'] as const).map((x) => (
                <button type="button" role="tab" aria-selected={pane === x} class={`me-html-pane${pane === x ? ' on' : ''}`} onClick={() => setPane(x)}>
                  {x === 'code' ? 'HTML' : 'As it arrives'}
                </button>
              ))}
            </div>
          )}
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
      <div class={`mc-format me-bar${p.bar ? '' : ' bare'}`} role="toolbar" aria-label="Formatting" onKeyDown={barKeys}>
        {/* Aa hides the formatting buttons; the switch between views always stays. */}
        {p.bar && BUTTONS.filter((b) => b.modes.includes(shown) && (more || !b.more)).map((b, i) => (
          <button
            class={`mc-fmt mc-fmt-${b.c}${on.has(b.c) ? ' on' : ''}`}
            type="button"
            tabIndex={i === 0 ? 0 : -1}
            title={b.title}
            aria-label={b.title}
            aria-pressed={b.c === 'clear' || b.c === 'picture' ? undefined : on.has(b.c)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(b.c)}
          >
            {b.label}
          </button>
        ))}
        {p.bar && BUTTONS.some((b) => b.more && b.modes.includes(shown)) && (
          <button
            class={`mc-fmt me-more${more ? ' open' : ''}${!more && BUTTONS.some((b) => b.more && on.has(b.c)) ? ' on' : ''}`}
            type="button"
            tabIndex={-1}
            aria-expanded={more}
            title={more ? 'Fewer buttons' : 'More: struck through, colour, heading, code, alignment, tables, remove formatting'}
            aria-label={more ? 'Fewer buttons' : 'More formatting'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleMore}
          >
            <Icon name={more ? 'back' : 'more'} size={15} />
          </button>
        )}
        {shown === 'html' && <span class="me-bar-note">The mail as it arrives is beside it.</span>}
        {shown === 'plain' && (
          <span class="me-bar-note" title="No HTML part: marks like **bold** stay as written, and pictures in the text are left out.">
            Sent as plain text, as you see it.
          </span>
        )}
        <span class="mc-fmt-gap" />
        <div class="me-modes" ref={modesBox} role="radiogroup" aria-label="Edit as" onPointerEnter={() => void loadCode()}>
          <span class="me-modes-thumb" aria-hidden="true" />
          {MODES.map((x) => (
            <button
              class={`me-mode${shown === x.m ? ' on' : ''}`}
              type="button"
              // The bar's one Tab stop when it has no formatting buttons (Aa off, or HTML and Plain).
              tabIndex={x.m === shown && !(p.bar && BUTTONS.some((b) => b.modes.includes(shown))) ? 0 : -1}
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
    </div>
  );
}

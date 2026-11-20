/**
 * The composer's edits as text (docs/mail.md, "Writing"): formatting is Markdown made by buttons and keys, recipients
 * are text until they become chips, and one undo history covers it all. Pure, so mail-edits.test.ts tests it as tables.
 */
import type * as P from '@dither-chat/protocol';

/** Text with its selection. */
export interface Sel {
  text: string;
  start: number;
  end: number;
}

// ------------------------------------------------------------------ formatting

export type Format = 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'bullets' | 'numbers' | 'quote' | 'heading' | 'clear';

const MARKS: Record<'bold' | 'italic' | 'strike' | 'code', string> = { bold: '**', italic: '_', strike: '~~', code: '`' };
const PREFIX: Record<'bullets' | 'numbers' | 'quote', RegExp> = { bullets: /^[-*+] /, numbers: /^\d+[.)] /, quote: /^> ?/ };
const URL_RE = /^(https?:\/\/|mailto:)\S+$/i;

/** One format applied to the selection, or taken off where it already has it (what the buttons and keys do). */
export function applyFormat(s: Sel, f: Format): Sel {
  if (f === 'link') return link(s);
  if (f === 'bullets' || f === 'numbers' || f === 'quote') return lines(s, f);
  if (f === 'heading') return heading(s);
  if (f === 'clear') return clear(s);
  if (f === 'code' && (s.text.slice(s.start, s.end).includes('\n') || inFence(s.text, s.start))) return fence(s);
  return wrap(s, MARKS[f]);
}

/** The whole lines the selection touches: [from, to) in the text. */
function lineSpan(text: string, start: number, end: number): [number, number] {
  const a = text.lastIndexOf('\n', start - 1) + 1;
  const e = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', e);
  return [a, nl < 0 ? text.length : nl];
}

/** The lines as Gmail's text sizes go: plain, then `#`, `##`, `###`, then plain again. */
function heading({ text, start, end }: Sel): Sel {
  const [a, b] = lineSpan(text, start, end);
  const ls = text.slice(a, b).split('\n');
  const level = ls.find((l) => l.trim())?.match(/^(#{1,6}) /)?.[1].length ?? 0;
  const next = level >= 3 ? 0 : level + 1;
  const out = ls.map((l) => (l.trim() ? `${next ? '#'.repeat(next) + ' ' : ''}${l.replace(/^#{1,6} +/, '')}` : l)).join('\n');
  return { text: text.slice(0, a) + out + text.slice(b), start: start === end ? a + out.length : a, end: a + out.length };
}

/** Inside a ``` block: an odd number of fence lines before the caret. */
function inFence(text: string, at: number): boolean {
  return (text.slice(0, text.lastIndexOf('\n', at - 1) + 1).match(/^```/gm)?.length ?? 0) % 2 === 1;
}

/** Code over several lines is a ``` block; inside one, Code takes the block's fences off. */
function fence(s: Sel): Sel {
  const { text } = s;
  if (inFence(text, s.start)) {
    // The fence lines around the caret: the last one before its line, the first one after.
    const lineAt = text.lastIndexOf('\n', s.start - 1) + 1;
    const open = text.slice(0, lineAt).search(/^```[^\n]*\n(?![\s\S]*^```)/m);
    const openEnd = text.indexOf('\n', open) + 1;
    const m = /^```[^\n]*(\n|$)/m.exec(text.slice(lineAt));
    if (open < 0 || !m) return s;
    const close = lineAt + m.index;
    const inner = text.slice(openEnd, close).replace(/\n$/, '');
    const out = text.slice(0, open) + inner + (close + m[0].length < text.length || m[1] ? '\n' : '') + text.slice(close + m[0].length);
    return { text: out.replace(/\n$/, text.endsWith('\n') ? '\n' : ''), start: open, end: open + inner.length };
  }
  const [a, b] = lineSpan(text, s.start, s.end);
  const body = text.slice(a, b);
  const ins = `\`\`\`\n${body}\n\`\`\``;
  return { text: text.slice(0, a) + ins + text.slice(b), start: a + 4, end: a + 4 + body.length };
}

/**
 * Formatting taken off (Gmail's Ctrl+\\): marks and links (their text stays) in what is selected, and the marks just
 * around it; headings, quotes and list markers on the lines it starts. Nothing selected: the caret's whole line.
 */
function clear({ text, start, end }: Sel): Sel {
  let [a, b] = start === end ? lineSpan(text, start, end) : [start, end];
  // Marks hugging the selection go too: **[bold]** is cleared whole.
  for (let again = true; again; ) {
    again = false;
    for (const m of ['**', '~~', '_', '`']) {
      if (text.slice(a - m.length, a) === m && text.slice(b, b + m.length) === m) (a -= m.length), (b += m.length), (again = true);
    }
  }
  const lineStart = text.lastIndexOf('\n', a - 1) + 1;
  const bare = text
    .slice(a, b)
    .split('\n')
    .filter((l) => !/^```/.test(l))
    .map((l, i) =>
      (i > 0 || a === lineStart ? l.replace(/^(\s*)(#{1,6} +|> ?|[-*+] +(\[[ xX]\] +)?|\d+[.)] +)+/, '') : l)
        .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
        .replace(/(\*\*|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
        .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, '$1$3')
        .replace(/`([^`\n]+)`/g, '$1'),
    )
    .join('\n');
  return { text: text.slice(0, a) + bare + text.slice(b), start: a, end: a + bare.length };
}

/** A list's item one level in (Tab) or out (Shift+Tab): three spaces, as a pasted list nests. Null: not in a list. */
export function indentList({ text, start, end }: Sel, out: boolean): Sel | null {
  const [a, b] = lineSpan(text, start, end);
  const ls = text.slice(a, b).split('\n');
  const item = /^\s*([-*+]|\d+[.)]) /;
  if (!ls.some((l) => item.test(l))) return null;
  let first = 0;
  let total = 0;
  const next = ls.map((l, i) => {
    if (!item.test(l)) return l;
    const was = l;
    const now = out ? l.replace(/^ {1,3}/, '') : `   ${l}`;
    if (i === 0) first = now.length - was.length;
    total += now.length - was.length;
    return now;
  });
  if (!total) return null;
  const outText = next.join('\n');
  // A selection from the line's start keeps it whole; a caret moves with its text.
  const from = start === a && end > start ? a : Math.max(a, start + first);
  return { text: text.slice(0, a) + outText + text.slice(b), start: from, end: end + total };
}

/** Which formats the caret (or the selection's start) sits in: the buttons show them pressed. */
export function formatsAt({ text, start }: Sel): Set<Format> {
  const on = new Set<Format>();
  const a = text.lastIndexOf('\n', start - 1) + 1;
  const nl = text.indexOf('\n', start);
  const line = text.slice(a, nl < 0 ? text.length : nl);
  const at = start - a;
  if (inFence(text, start) && !/^```/.test(line)) return on.add('code');
  if (/^\s*[-*+] /.test(line)) on.add('bullets');
  if (/^\s*\d+[.)] /.test(line)) on.add('numbers');
  if (/^> ?/.test(line)) on.add('quote');
  if (/^#{1,6} /.test(line)) on.add('heading');
  const before = line.slice(0, at);
  const after = line.slice(at);
  const open = (m: string) => {
    const n = before.split(m).length - 1;
    return n % 2 === 1 && after.includes(m);
  };
  if (open('**')) on.add('bold');
  if (open('~~')) on.add('strike');
  if (open('`')) on.add('code');
  // _ only as a mark (a word's own _, as in snake_case, is not).
  const us = (s: string) => (s.match(/(^|[^\w])_(?=\S)|(?<=\S)_(?![\w])/g) ?? []).length;
  if (us(before) % 2 === 1 && us(after) > 0) on.add('italic');
  if (/\[[^\]]*$/.test(before) && /^[^\[]*\]\(/.test(after)) on.add('link');
  return on;
}

function wrap({ text, start, end }: Sel, m: string): Sel {
  const n = m.length;
  // Already marked just outside the selection, or the selection itself starts and ends with the mark: off.
  if (text.slice(start - n, start) === m && text.slice(end, end + n) === m && !(m === '_' && text[start - n - 1] === '_')) {
    return { text: text.slice(0, start - n) + text.slice(start, end) + text.slice(end + n), start: start - n, end: end - n };
  }
  const sel = text.slice(start, end);
  if (sel.length >= 2 * n && sel.startsWith(m) && sel.endsWith(m)) {
    const inner = sel.slice(n, sel.length - n);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  if (!sel.trim()) return { text: text.slice(0, end) + m + m + text.slice(end), start: end + n, end: end + n };
  if (!sel.includes('\n')) {
    // Markdown marks hold no space on their inside: the spaces around the selection stay outside.
    const a = start + sel.length - sel.trimStart().length;
    const b = a + sel.trim().length;
    return { text: text.slice(0, a) + m + text.slice(a, b) + m + text.slice(b), start: a + n, end: b + n };
  }
  // Nor a line break: each line is marked on its own.
  const out = sel
    .split('\n')
    .map((line) => {
      const body = line.trim();
      if (!body) return line;
      const lead = line.length - line.trimStart().length;
      return `${line.slice(0, lead)}${m}${body}${m}${line.slice(lead + body.length)}`;
    })
    .join('\n');
  return { text: text.slice(0, start) + out + text.slice(end), start, end: start + out.length };
}

function link({ text, start, end }: Sel): Sel {
  const sel = text.slice(start, end);
  if (URL_RE.test(sel.trim())) {
    // An address selected: the text to show goes in the brackets.
    const ins = `[](${sel.trim()})`;
    return { text: text.slice(0, start) + ins + text.slice(end), start: start + 1, end: start + 1 };
  }
  const ins = `[${sel}](https://)`;
  const at = start + sel.length + 3;
  return { text: text.slice(0, start) + ins + text.slice(end), start: at, end: at + 8 };
}

function lines({ text, start, end }: Sel, f: 'bullets' | 'numbers' | 'quote'): Sel {
  const a = text.lastIndexOf('\n', start - 1) + 1;
  const e = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', e);
  const b = nl < 0 ? text.length : nl;
  const ls = text.slice(a, b).split('\n');
  const re = PREFIX[f];
  const on = ls.filter((l) => l.trim()).every((l) => re.test(l)) && ls.some((l) => l.trim());
  let k = 0;
  const next = ls.map((l) => {
    if (on) return l.replace(re, '');
    if (!l.trim() && ls.length > 1) return l;
    const bare = l.replace(PREFIX.bullets, '').replace(PREFIX.numbers, '');
    return f === 'bullets' ? `- ${bare}` : f === 'numbers' ? `${++k}. ${bare}` : `> ${l}`;
  });
  const out = next.join('\n');
  return { text: text.slice(0, a) + out + text.slice(b), start: start === end ? a + out.length : a, end: a + out.length };
}

/** A web address pasted over selected text: the text becomes a link to it. Null: paste as usual. */
export function pasteLink(s: Sel, pasted: string): Sel | null {
  const url = pasted.trim();
  const sel = s.text.slice(s.start, s.end);
  if (!sel.trim() || sel.includes('\n') || !URL_RE.test(url) || URL_RE.test(sel.trim())) return null;
  const ins = `[${sel}](${url})`;
  const at = s.start + ins.length;
  return { text: s.text.slice(0, s.start) + ins + s.text.slice(s.end), start: at, end: at };
}

/**
 * Enter in a list goes on with it (the next number, the same bullet, a task's box empty); Enter on an empty item ends
 * the list. Null: Enter as usual.
 */
export function continueList({ text, start, end }: Sel): Sel | null {
  if (start !== end) return null;
  const a = text.lastIndexOf('\n', start - 1) + 1;
  const line = text.slice(a, start);
  const m = line.match(/^(\s*)([-*+]|(\d+)([.)]))( +)(\[[ xX]\] +)?/);
  if (!m) return null;
  // The caret inside the marker itself: as usual.
  if (start - a < m[0].length) return null;
  if (!line.slice(m[0].length).trim() && !text.slice(start, text.indexOf('\n', start) < 0 ? text.length : text.indexOf('\n', start)).trim()) {
    // An empty item: the list ends there, the marker goes.
    return { text: text.slice(0, a) + text.slice(start), start: a, end: a };
  }
  const marker = `${m[1]}${m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2]}${m[5]}${m[6] ? '[ ] ' : ''}`;
  const ins = `\n${marker}`;
  return { text: text.slice(0, start) + ins + text.slice(end), start: start + ins.length, end: start + ins.length };
}

// ------------------------------------------------------------------ undo

/**
 * Undo and redo for the whole composer: what it held before each change. Typing in one field is one step until a
 * pause, the end of a word, or another field; everything else (a chip made or taken back, a file, the quote, From)
 * is a step of its own.
 */
export class EditHistory<S> {
  private past: S[] = [];
  private future: S[] = [];
  private burst: { field: string; at: number } | null = null;

  constructor(
    private readonly limit = 200,
    private readonly pauseMs = 1000,
  ) {}

  /**
   * Before a change, with the state it changes. `typing` names the field typed in (a burst there is one step), and
   * `wordEnd` says the change ends a word (a space or a line typed after other text).
   */
  record(before: S, typing?: { field: string; wordEnd?: boolean }, now = Date.now()) {
    this.future = [];
    if (typing) {
      const b = this.burst;
      const goesOn = b && b.field === typing.field && now - b.at < this.pauseMs;
      this.burst = typing.wordEnd ? null : { field: typing.field, at: now };
      if (goesOn) return;
    } else this.burst = null;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
  }

  /** The state to go back to, given the one now; null when there is none. */
  undo(now: S): S | null {
    const s = this.past.pop();
    if (s === undefined) return null;
    this.future.push(now);
    this.burst = null;
    return s;
  }

  redo(now: S): S | null {
    const s = this.future.pop();
    if (s === undefined) return null;
    this.past.push(now);
    this.burst = null;
    return s;
  }

  get canUndo() {
    return this.past.length > 0;
  }
}

/** Where the caret goes when `to` replaces `from` (an undo or a redo): at the end of what changed. */
export function caretAfter(from: string, to: string): number {
  let p = 0;
  while (p < from.length && p < to.length && from[p] === to[p]) p++;
  let s = 0;
  while (s < from.length - p && s < to.length - p && from[from.length - 1 - s] === to[to.length - 1 - s]) s++;
  return to.length - s;
}

// ------------------------------------------------------------------ recipients

/**
 * A chip opened back into text to edit: its address, without its last letter when Backspace opened it (as Backspace
 * would take a letter of text).
 */
export function chipText(a: P.MailAddressView, backspace: boolean): string {
  return backspace ? a.email.slice(0, -1) : a.email;
}

/**
 * The name an edited chip keeps: its old one while the part before @ is the same (a typo in the domain fixed), none
 * once it is someone else. A name typed with the address wins.
 */
export function keptName(was: P.MailAddressView, now: P.MailAddressView): P.MailAddressView {
  if (now.name) return now;
  const local = (e: string) => e.split('@')[0].toLowerCase();
  return was.name && local(was.email) === local(now.email) ? { ...now, name: was.name } : now;
}

/**
 * Suggestions as you type a recipient: people you wrote to first, then the server's own (Gmail's, Proton's, in its
 * order), then the rest of your mail; each address once (a name found later fills one that had none), none already
 * on the message.
 */
export function mergeHits(local: P.MailAddressHit[], server: P.MailAddressHit[] | null, taken: P.MailAddressView[], max = 8): P.MailAddressHit[] {
  const out = new Map<string, P.MailAddressHit>();
  const skip = new Set(taken.map((a) => a.email.trim().toLowerCase()));
  for (const h of [...local.filter((x) => x.wroteTo), ...(server ?? []), ...local.filter((x) => !x.wroteTo)]) {
    const k = h.email.trim().toLowerCase();
    if (skip.has(k)) continue;
    const had = out.get(k);
    if (had) {
      if (!had.name && h.name) out.set(k, { ...had, name: h.name });
    } else out.set(k, h);
  }
  return [...out.values()].slice(0, max);
}

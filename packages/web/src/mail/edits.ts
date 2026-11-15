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

export type Format = 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'bullets' | 'numbers' | 'quote';

const MARKS: Record<'bold' | 'italic' | 'strike' | 'code', string> = { bold: '**', italic: '_', strike: '~~', code: '`' };
const PREFIX: Record<'bullets' | 'numbers' | 'quote', RegExp> = { bullets: /^[-*+] /, numbers: /^\d+[.)] /, quote: /^> ?/ };
const URL_RE = /^(https?:\/\/|mailto:)\S+$/i;

/** One format applied to the selection, or taken off where it already has it (what the buttons and keys do). */
export function applyFormat(s: Sel, f: Format): Sel {
  if (f === 'link') return link(s);
  if (f === 'bullets' || f === 'numbers' || f === 'quote') return lines(s, f);
  return wrap(s, MARKS[f]);
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

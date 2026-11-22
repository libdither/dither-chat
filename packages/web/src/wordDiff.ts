/**
 * Word by word, what an edit changed (docs/history.md "A message's history"): for the history list, which shows each
 * edit as the words it took out and put in with a few words around them, and for the chat, which underlines in the
 * message the words its last edit put in.
 */

/** A run of text the same in both, taken out, or put in. */
export interface Part {
  k: '=' | '-' | '+';
  t: string;
}

const tokens = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];
const space = (t: string) => /^\s+$/.test(t);
/** Past this many cells (words before × words after, once the same start and end are set aside) it is all one change. */
const MAX_CELLS = 2_000_000;

/**
 * The words of `a` and `b` as runs kept, taken out and put in. Changes with only a space between read as one change
 * ("a" → "the big blue"), and a space both sides of a change share stays outside it.
 */
export function wordDiff(a: string, b: string): Part[] {
  const A = tokens(a), B = tokens(b);
  // Most edits touch one spot: the same start and end are kept as they are, and only the middle is compared.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let post = 0;
  while (post < A.length - pre && post < B.length - pre && A[A.length - 1 - post] === B[B.length - 1 - post]) post++;
  const a2 = A.slice(pre, A.length - post), b2 = B.slice(pre, B.length - post);
  const raw: Part[] = [];
  const push = (k: Part['k'], t: string) => {
    const last = raw[raw.length - 1];
    if (last && last.k === k) last.t += t;
    else raw.push({ k, t });
  };
  for (const t of A.slice(0, pre)) push('=', t);
  const n = a2.length, m = b2.length;
  if (n * m > MAX_CELLS) {
    for (const t of a2) push('-', t);
    for (const t of b2) push('+', t);
  } else {
    // Longest common run of words, from the end, so the walk below goes forwards.
    const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) push('=', a2[i++]), j++;
      else if (L[i + 1][j] >= L[i][j + 1]) push('-', a2[i++]);
      else push('+', b2[j++]);
    }
    while (i < n) push('-', a2[i++]);
    while (j < m) push('+', b2[j++]);
  }
  for (const t of A.slice(A.length - post)) push('=', t);
  // Join changes that only a space keeps apart; each joined change is what it took out, then what it put in.
  const out: Part[] = [];
  for (let k = 0; k < raw.length; ) {
    if (raw[k].k === '=') {
      out.push(raw[k++]);
      continue;
    }
    let del = '', ins = '';
    while (k < raw.length) {
      const p = raw[k];
      if (p.k === '-') del += p.t;
      else if (p.k === '+') ins += p.t;
      else if (space(p.t) && raw[k + 1] && raw[k + 1].k !== '=') {
        del += p.t;
        ins += p.t;
      } else break;
      k++;
    }
    // A space both sides share, before or after the change, stays outside it.
    const lead = (del || ins).match(/^\s+/)?.[0] ?? '';
    if (lead && (!del || del.startsWith(lead)) && (!ins || ins.startsWith(lead)) && (del || ins).length > lead.length) {
      if (del) del = del.slice(lead.length);
      if (ins) ins = ins.slice(lead.length);
      const prev = out[out.length - 1];
      if (prev?.k === '=') prev.t += lead;
      else out.push({ k: '=', t: lead });
    }
    const tail = (del || ins).match(/\s+$/)?.[0] ?? '';
    const shared = tail && (!del || del.endsWith(tail)) && (!ins || ins.endsWith(tail));
    if (shared) {
      if (del) del = del.slice(0, -tail.length);
      if (ins) ins = ins.slice(0, -tail.length);
    }
    if (del) out.push({ k: '-', t: del });
    if (ins) out.push({ k: '+', t: ins });
    if (shared) {
      if (raw[k]?.k === '=') raw[k] = { k: '=', t: tail + raw[k].t };
      else out.push({ k: '=', t: tail });
    }
  }
  return out;
}

/**
 * Only the changes, with up to `around` words either side and `…` where text is left out: what the history list shows
 * for one edit. A `gap` part stands for the words left out.
 */
export function changesInContext(a: string, b: string, around = 3): (Part | { k: 'gap' })[] {
  const parts = wordDiff(a, b);
  const words = (ts: string[]) => ts.filter((t) => !space(t)).length;
  const take = (ts: string[], n: number, fromEnd: boolean) => {
    const seq = fromEnd ? [...ts].reverse() : ts;
    const got: string[] = [];
    let c = 0;
    for (const t of seq) {
      if (c >= n && !space(t)) break;
      got.push(t);
      if (!space(t)) c++;
    }
    return (fromEnd ? got.reverse() : got).join('');
  };
  const out: (Part | { k: 'gap' })[] = [];
  parts.forEach((p, i) => {
    if (p.k !== '=') return void out.push(p);
    const ts = tokens(p.t), first = i === 0, last = i === parts.length - 1, n = words(ts);
    if (first && last) return void out.push(p);
    if (first) return void (n > around ? out.push({ k: 'gap' }, { k: '=', t: take(ts, around, true).replace(/^\s+/, '') }) : out.push(p));
    if (last) return void (n > around ? out.push({ k: '=', t: take(ts, around, false).replace(/\s+$/, '') }, { k: 'gap' }) : out.push(p));
    if (n > around * 2 + 1) out.push({ k: '=', t: take(ts, around, false).replace(/\s+$/, '') }, { k: 'gap' }, { k: '=', t: take(ts, around, true).replace(/^\s+/, '') });
    else out.push(p);
  });
  return out;
}

// ------------------------------------------------------------------ marking the chat's message

/** One character of an HTML string's text: `&amp;` and the like count as one, as the page shows them. */
const ENTITY = /^&(#\d+|#x[\da-f]+|[a-z]+\d*);/i;

/** The text an HTML string shows: what is outside its tags, an entity as one character (its source kept). */
function textOf(html: string): string[] {
  const chars: string[] = [];
  for (let i = 0; i < html.length; ) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const ent = html[i] === '&' ? html.slice(i).match(ENTITY)?.[0] : undefined;
    chars.push(ent ?? html[i]);
    i += ent?.length ?? 1;
  }
  return chars;
}

/**
 * `html` (a rendered message) with the words its last edit put in wrapped in `<span class="msg-changed">`, comparing
 * it with `prevHtml` (the version before, rendered the same way) as text, so markdown's marks are not words. A change
 * across tags is wrapped piece by piece inside each. Nothing is marked when no word of the old text is left, as a
 * rewrite has nothing to point at; or when the edit only took words out.
 */
export function markChanged(html: string, prevHtml: string): string {
  const now = textOf(html), before = textOf(prevHtml);
  // Entities back to the characters they stand for, for comparing; each still one position.
  const plain = (cs: string[]) => cs.map((c) => (c.length > 1 ? decode(c) : c)).join('');
  const nowText = plain(now);
  const parts = wordDiff(plain(before), nowText);
  // Positions in `now` (in characters) the edit put in.
  const put = new Uint8Array(nowText.length);
  let at = 0, count = 0;
  for (const p of parts) {
    if (p.k === '-') continue;
    if (p.k === '+')
      for (let i = 0; i < p.t.length; i++) {
        put[at + i] = 1;
        count++;
      }
    at += p.t.length;
  }
  if (!count || !parts.some((p) => p.k === '=' && /\S/.test(p.t))) return html;
  // The positions are by UTF-16 unit of the decoded text; walk the HTML with the same count.
  let out = '', pos = 0, open = false;
  const close = () => {
    if (open) out += '</span>';
    open = false;
  };
  for (let i = 0; i < html.length; ) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      const tag = html.slice(i, end < 0 ? html.length : end + 1);
      close();
      out += tag;
      i += tag.length;
      continue;
    }
    const ent = html[i] === '&' ? html.slice(i).match(ENTITY)?.[0] : undefined;
    const src = ent ?? html[i];
    const len = ent ? decode(ent).length : 1;
    const marked = put[pos] === 1 && !/\s/.test(ent ? decode(ent) : html[i]);
    // A space between two marked words stays inside the mark, so the underline runs on.
    const bridge = open && /\s/.test(ent ? decode(ent) : html[i]) && nextMarked(put, pos + len, nowText);
    if ((marked || bridge) && !open) {
      out += '<span class="msg-changed">';
      open = true;
    } else if (!marked && !bridge) close();
    out += src;
    pos += len;
    i += src.length;
  }
  close();
  return out;
}

/** Whether the next character past a run of spaces is marked. */
function nextMarked(put: Uint8Array, from: number, text: string): boolean {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return put[i] === 1;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(ent: string): string {
  const name = ent.slice(1, -1);
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : ent;
  }
  return NAMED[name] ?? ent;
}

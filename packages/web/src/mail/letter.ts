/**
 * A mail's words as a chat message draws them (docs/mail.md "Mail as chats", "Letter furniture"): what is certainly not
 * the message is folded behind ···, what may not be is drawn small and faint in place, and the rest reads as a chat
 * message. Pure, for web/test/mail-letter.test.ts.
 *
 * - Folded: everything from a `-- ` line on (the signature), and a last line that is only the sender's name (first
 *   name, full name or the account's display name).
 * - Faint, in place: a tail that may or may not be furniture: a sign-off ("Best,", "Thanks!", "Love, Mom"), a name
 *   under a sign-off ("Best,\nSam"), "Sent from my phone".
 * - A greeting ("Hi both,") stays full size, with no blank line after it.
 * - A run of blank lines is one paragraph break (the chat draws it as a small gap, not a full line).
 */

/** A line, and whether it is drawn faint (an unsure tail). */
export interface LetterLine {
  text: string;
  faint?: true;
}

export interface Letter {
  /** Paragraphs, each a run of lines with no blank line between them. */
  paras: LetterLine[][];
  /** What is folded behind ···: the name line and the signature, as written; null when nothing is. */
  rest: string | null;
}

/** Words that close a letter, as a whole line ("Best,", "Thanks!") or before a name ("Love, Mom"). */
const SIGN_OFF =
  /^(?:best|best wishes|best regards|all the best|regards|kind regards|warm regards|warmly|cheers|thanks|thanks so much|thanks again|thanks a lot|thank you|thank you so much|many thanks|love|lots of love|much love|hugs|xo|xoxo|take care|sincerely|yours|yours truly|talk soon|speak soon|see you soon|later)\b/i;
/** What a phone or a mail app adds under what you wrote. */
const SENT_FROM = /^(?:sent from my\b|sent (?:from|via|with) \S+ (?:for|on) |get outlook for\b)/i;
/** A greeting on a line of its own: a few words, no question, ending in a comma, a stop or nothing. */
const GREETING = /^(?:hi|hey|hello|hiya|dear|morning|good (?:morning|afternoon|evening)|greetings|hi there|hey there)\b[^?]*$/i;

const blank = (l: string) => !l.trim();

/** A name as compared: lower case, no dash before it, no stop after it. */
const bare = (l: string) =>
  l
    .trim()
    .replace(/^[-–—~]+\s*/, '')
    .replace(/[.!,]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** The sender's names a closing line may be: each name whole, and its first word. */
function nameSet(names: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    // A name that is an address names no one in a closing line.
    if (!n || n.includes('@')) continue;
    const b = bare(n.replace(/^"(.*)"$/, '$1'));
    if (!b) continue;
    out.add(b);
    const first = b.split(' ')[0];
    if (first.length >= 2) out.add(first);
  }
  return out;
}

/** A line that is only a sign-off, with nothing after its words but punctuation. */
const signOffAlone = (l: string) => {
  const m = l.trim().match(SIGN_OFF);
  return !!m && /^[\s,.!]*$/.test(l.trim().slice(m[0].length));
};

/** A sign-off and a name on one line: "Love, Mom", "Thanks, Sam", "Cheers Robin". */
function signOffNamed(l: string, names: Set<string>): boolean {
  const t = l.trim();
  const m = t.match(SIGN_OFF);
  if (!m) return false;
  const after = t.slice(m[0].length).replace(/^[\s,!.]+/, '');
  if (!after || /[?:;]/.test(after)) return false;
  return names.has(bare(after)) || /^\p{Lu}[\p{L}'-]*(?: \p{Lu}[\p{L}'-]*){0,2}[.!]?$/u.test(after);
}

const isName = (l: string, names: Set<string>) => {
  const b = bare(l);
  return !!b && names.has(b);
};

const isGreeting = (l: string) => {
  const t = l.trim();
  return t.length <= 40 && t.split(/\s+/).length <= 5 && GREETING.test(t) && /[,!:.]?$/.test(t);
};

/**
 * The letter in a mail's words (the text above its quote). `names`: what the sender may sign with: the From name, their
 * identity's name, your account's display name for mail you sent.
 */
export function letter(text: string, names: readonly (string | null | undefined)[]): Letter {
  const known = nameSet(names);
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  let start = 0;
  while (start < lines.length && blank(lines[start])) start++;
  let end = lines.length;
  const trim = () => {
    while (end > start && blank(lines[end - 1])) end--;
  };
  const rest: string[] = [];
  // The signature: what follows its "-- " line, when something is written above it. The delimiter itself is mail's
  // furniture and is not drawn even when the rest is opened.
  const sig = lines.findIndex((l, i) => i > start && l === '--');
  if (sig > start) {
    rest.push(...lines.slice(sig + 1));
    end = sig;
  }
  trim();
  const prevLine = (i: number) => {
    let j = i - 1;
    while (j >= start && blank(lines[j])) j--;
    return j;
  };
  // A last line that is only the sender's name, unless a sign-off sits right above it ("Best,\nSam" is drawn faint).
  if (end - start >= 2 && isName(lines[end - 1], known)) {
    const p = prevLine(end - 1);
    if (p >= start && lines[p] !== '--' && !signOffAlone(lines[p])) {
      rest.unshift(lines[end - 1], ...(rest.length ? [''] : []));
      end--;
      trim();
    }
  }
  // Unsure tails, from the end up: sign-offs, names, "Sent from my phone". Something must stay above them.
  const faint = new Set<number>();
  for (let i = end - 1; i > start; i--) {
    const l = lines[i];
    if (blank(l)) continue;
    if (!(signOffAlone(l) || signOffNamed(l, known) || isName(l, known) || SENT_FROM.test(l.trim()))) break;
    // A name is a tail only under a sign-off ("Best,\nSam"): a lone one was folded above.
    if (isName(l, known) && !signOffAlone(l)) {
      const p = prevLine(i);
      if (p < start || !signOffAlone(lines[p])) break;
    }
    faint.add(i);
  }
  // Paragraphs, a greeting joined to what follows it.
  const paras: LetterLine[][] = [];
  let cur: LetterLine[] = [];
  let firstContent = true;
  for (let i = start; i < end; i++) {
    const l = lines[i];
    if (blank(l)) {
      if (cur.length) paras.push(cur);
      cur = [];
      continue;
    }
    const greeting = firstContent && isGreeting(l) && end - start > 1;
    firstContent = false;
    cur.push(faint.has(i) ? { text: l, faint: true } : { text: l });
    if (greeting) while (i + 1 < end && blank(lines[i + 1])) i++;
  }
  if (cur.length) paras.push(cur);
  while (rest.length && blank(rest[rest.length - 1])) rest.pop();
  return { paras, rest: rest.length ? rest.join('\n') : null };
}

/**
 * A link as a mail's words show it: its host and path, without the scheme or "www.", the query left out when it makes
 * it long, and the middle of a long path cut out (…), in at most `max` characters. The full address is the title.
 */
export function shortLink(url: string, max = 48): string {
  if (/^mailto:/i.test(url)) return url.slice(7);
  let u: URL;
  try {
    u = new URL(/^www\./i.test(url) ? `https://${url}` : url);
  } catch {
    return url;
  }
  const host = u.host.replace(/^www\./i, '');
  const path = u.pathname === '/' ? '' : u.pathname;
  const whole = host + path + u.search + u.hash;
  if (whole.length <= max) return whole;
  const short = host + path.replace(/\/$/, '');
  if (short.length <= max) return short;
  if (host.length + 4 >= max) return host;
  // Keep the path's start and end: the end often names the page ("…/for-this-week").
  // Each side is cut where a word ends (a "/", "-", "_" or "."), when one is near enough.
  const p = path.replace(/\/$/, '');
  const room = max - host.length - 1;
  let head = p.slice(0, Math.ceil(room * 0.55));
  const h = Math.max(head.lastIndexOf('/'), head.lastIndexOf('-'), head.lastIndexOf('_'), head.lastIndexOf('.'));
  if (h >= head.length / 2) head = head.slice(0, h + 1);
  let tail = p.slice(p.length - (room - head.length));
  const t = tail.search(/[/_.-]/);
  if (t >= 0 && t < tail.length / 2) tail = tail.slice(t);
  return host + head + '…' + tail;
}

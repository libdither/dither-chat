/**
 * `@` mentions in the composer (docs/mentions.md), the part that rides in the app: when an `@name` is being typed.
 * As for the `:` emoji list (emojiComplete.ts), it only starts after a space, the start of a line or an opening
 * bracket or quote, so `name@host`, a mail address and a written `<@id>` never open it, and never inside `code`, a ```
 * block or a URL. A bare `@` opens it: the people here, before anything is typed. ui/MentionComplete.tsx watches for
 * it; the list (ui/MentionPicker.tsx, mentionRows.ts) is a chunk of its own.
 */
import { insideCode } from './emojiComplete.ts';

/** What may stand right before the `@`. */
const LEAD = String.raw`(?:^|[\s([{"'>*_~|])`;
const OPEN = new RegExp(`${LEAD}@([^\\s@<>\`]{0,32})$`);

export interface MentionTrigger {
  /** Index of the `@`. */
  start: number;
  /** The caret: the query runs from start + 1 to here. */
  end: number;
  query: string;
}

/** The `@query` the caret is at the end of, if it should open the list. */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  const m = text.slice(0, caret).match(OPEN);
  if (!m) return null;
  const query = m[1];
  const start = caret - query.length - 1;
  if (insideCode(text, start)) return null;
  const word = text.slice(0, caret).split(/\s/).pop() ?? '';
  if (/:\/\/|^www\./i.test(word)) return null;
  return { start, end: caret, query };
}

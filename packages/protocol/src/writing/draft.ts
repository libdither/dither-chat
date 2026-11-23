/**
 * A draft: the words, where they go, and what is one place's alone. The box, the hub and the tests all ask `outcome`
 * whether a draft may go, so they agree. Every change to a draft is a function from a draft to a draft: nothing here
 * knows what a chat or an account is, and nothing is keyed by the chat a draft was started in.
 */
import { VERSION, type Node } from './doc.ts';
import { send, type Options, type Sent } from './encode.ts';
import type { Change } from './fit.ts';
import type { Fields, Profile } from './profile.ts';

/** One place a draft goes to. */
export interface Place {
  /** Which place: an account and a chat there, as the hub names them. The model does not look inside it. */
  key: string;
  /** Words of its own, where it is written separately. Without them it gets the draft's. */
  doc?: Node;
  /** What is written beside the text for this place alone (another title, say), over the draft's. */
  fields?: Fields;
  /** Choices made for this place: the title as its first line, a thread. */
  options?: Options;
  /** Left out for now. What was written for it is kept, so putting it back loses nothing. */
  off?: true;
  /** Hidden words the writer agreed to let this place show. Asked once: the hub does not ask again, and does not guess. */
  agreed?: string[];
  /** When it went there, once it has. A draft sent again goes only where it has not been. */
  sent?: number;
}

export interface Draft {
  /** The version of the document format (doc.ts). */
  v: number;
  /** The chat the draft is shown in: a pointer, and nothing else hangs on it. `move` changes it and keeps the rest. */
  chat: string | null;
  /** The words, with the pictures in them, for every place that has none of its own. */
  doc: Node;
  /** What is written beside the text, once: each place takes what it has a field for. */
  fields: Fields;
  places: Place[];
}

export const draft = (chat: string | null, keys: string[], body: Node = { type: 'doc', content: [{ type: 'paragraph' }] }, fields: Fields = {}): Draft => ({ v: VERSION, chat, doc: body, fields, places: keys.map((key) => ({ key })) });

const each = (d: Draft, key: string, f: (p: Place) => Place): Draft => ({ ...d, places: d.places.map((p) => (p.key === key ? f(p) : p)) });
/** The words: of one place, where it is written separately, or of all that have none of their own. */
export const write = (d: Draft, body: Node, key?: string): Draft => (key ? each(d, key, (p) => ({ ...p, doc: body })) : { ...d, doc: body });
/** A place gets words of its own, starting from the draft's; or goes back to the draft's. */
export const apart = (d: Draft, key: string): Draft => each(d, key, (p) => ({ ...p, doc: p.doc ?? d.doc }));
export const together = (d: Draft, key: string): Draft => each(d, key, ({ doc: _own, ...p }) => p);
export const choose = (d: Draft, key: string, options: Options): Draft => each(d, key, (p) => ({ ...p, options: { ...p.options, ...options } }));
export const add = (d: Draft, key: string): Draft => (d.places.some((p) => p.key === key) ? each(d, key, ({ off: _off, ...p }) => p) : { ...d, places: [...d.places, { key }] });
export const leave = (d: Draft, key: string): Draft => each(d, key, (p) => ({ ...p, off: true }));
export const agree = (d: Draft, key: string, words: string[]): Draft => each(d, key, (p) => ({ ...p, agreed: [...new Set([...(p.agreed ?? []), ...words])] }));
/**
 * The draft goes elsewhere: to another way of reaching the same person, or with its writer to another chat (a
 * group's, when someone is added to a mail). The words, the fields and the pictures travel. What was one place's
 * alone stays with that place if it is still among them.
 */
export const move = (d: Draft, chat: string | null, keys: string[]): Draft => ({ ...d, chat, places: [...new Set(keys)].map((key) => d.places.find((p) => p.key === key) ?? { key }) });
/** After a send: where it went is marked. A draft that has been everywhere is done. */
export const went = (d: Draft, keys: string[], at: number): Draft => ({ ...d, places: d.places.map((p) => (keys.includes(p.key) ? { ...p, sent: at } : p)) });
export const done = (d: Draft): boolean => d.places.every((p) => p.sent !== undefined);

export interface Outcome {
  /** What each place still to get it would get. */
  sent: Record<string, Sent>;
  /** The places still to get it. */
  due: string[];
  /** Those that cannot take it as it is. */
  stopped: string[];
  /** Those that would show hidden words the writer has not agreed to show there: the writer is asked first. */
  exposing: string[];
  /** Those where it arrives looking another way, with nothing lost. */
  differing: string[];
  /** Some place would get nothing: judged from what would arrive there, not from what the draft holds. */
  empty: boolean;
  /**
   * It may go. A draft goes whole: while one place cannot take it, none gets it, until that place is fixed, written
   * separately or left out. Half of a post sent is worse than a post not sent yet. Whoever sends (the box, the hub)
   * sends when it is ready and `exposing` is empty.
   */
  ready: boolean;
}

export function outcome(d: Draft, profile: (key: string) => Profile): Outcome {
  const due = d.places.filter((p) => p.sent === undefined && !p.off);
  const sent: Record<string, Sent> = {};
  // A mail with a subject and no text is a mail; a message with no words, no file and no title is nothing.
  let empty = false;
  for (const p of due) {
    const pr = profile(p.key);
    const f = { ...d.fields, ...p.fields };
    const s = (sent[p.key] = send(p.doc ?? d.doc, pr, f, p.options));
    if (!s.counted.trim() && !s.files.length && !(pr.fields?.title && f.title?.trim())) empty = true;
  }
  const keys = due.map((p) => p.key);
  const some = (key: string, is: (c: Change) => boolean) => sent[key].changes.some(is);
  const stopped = keys.filter((k) => some(k, (c) => c.level === 'blocked'));
  const asked = (p: Place) => sent[p.key].changes.some((c) => c.level === 'exposed' && !(c.words?.length && c.words.every((w) => p.agreed?.includes(w))));
  return {
    sent,
    due: keys,
    stopped,
    exposing: due.filter((p) => !stopped.includes(p.key) && asked(p)).map((p) => p.key),
    differing: keys.filter((k) => some(k, (c) => c.level !== 'blocked' && c.level !== 'exposed')),
    empty,
    // A draft in a newer format than this code knows is not sent by it.
    ready: keys.length > 0 && !empty && stopped.length === 0 && d.v <= VERSION,
  };
}

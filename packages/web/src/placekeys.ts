/**
 * Keys that go to the app's places (docs/desktop.md "Keys to the places"): G then a place's letter, as in Gmail and
 * GitHub, when you are not typing; and Ctrl+Shift with the place's number on the rail, which works while you type too
 * (a chat puts you in its message box as it opens). Not Alt: window managers take Alt for their own (niri's default
 * mod key), and Firefox and Chromium switch tabs with it. Pure, so tests can import it; ui/PlaceKeys.tsx listens.
 */

export type Place = 'inbox' | 'people' | 'mail' | 'calendar' | 'feed' | 'foryou' | 'settings' | 'accounts';

/**
 * The rail's top places in its order, with their numbers, then places with a letter only. The numbers are fixed: a
 * place the hub doesn't offer leaves its number unused.
 */
export const PLACES: readonly { place: Place; letter: string; digit?: number; label: string }[] = [
  { place: 'inbox', letter: 'i', digit: 1, label: 'Inbox' },
  { place: 'people', letter: 'p', digit: 2, label: 'People' },
  { place: 'mail', letter: 'm', digit: 3, label: 'Mail' },
  { place: 'calendar', letter: 'c', digit: 4, label: 'Calendar' },
  { place: 'feed', letter: 'f', digit: 5, label: 'Feed' },
  { place: 'foryou', letter: 'y', label: 'For you' },
  { place: 'settings', letter: 's', label: 'Settings' },
  { place: 'accounts', letter: 'a', label: 'Accounts' },
];

/** How long G waits for its letter. */
export const G_WAIT_MS = 1500;

export interface KeyIn {
  key: string;
  /** The physical key (`Digit1`): Shift turns a number into a symbol (`!`), and a layout may too; never the code. */
  code: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  repeat: boolean;
  composing: boolean;
  /** In a text field, a text area, a select or editable text. */
  typing: boolean;
  /** A menu, sheet, dialog, the switcher or the picture viewer is over the page. */
  covered: boolean;
}

type KeyOut =
  /** Go there; the key is used up. */
  | { kind: 'go'; place: Place; how: 'g' | 'chord' }
  /** G was pressed: wait for the letter; the key is used up. */
  | { kind: 'wait' }
  /** Stop waiting for a letter; the key goes on to whatever else listens. */
  | { kind: 'cancel' }
  | null;

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** What a key does, `waiting` after a G, with `offered` the places this hub has. */
export function readKey(k: KeyIn, waiting: boolean, offered: (p: Place) => boolean): KeyOut {
  if (k.composing) return waiting ? { kind: 'cancel' } : null;
  if (k.ctrl && k.shift && !k.alt && !k.meta && !k.covered && !k.repeat) {
    const d = /^Digit([1-9])$/.exec(k.code);
    const p = d && PLACES.find((x) => x.digit === Number(d[1]));
    if (p && offered(p.place)) return { kind: 'go', place: p.place, how: 'chord' };
  }
  if (waiting) {
    // A modifier on its way to a chord keeps G waiting; Shift alone does too, for a capital letter.
    if (MODIFIERS.has(k.key)) return null;
    const p = !k.alt && !k.ctrl && !k.meta ? PLACES.find((x) => x.letter === k.key.toLowerCase()) : undefined;
    return p && offered(p.place) ? { kind: 'go', place: p.place, how: 'g' } : { kind: 'cancel' };
  }
  if (k.typing || k.covered || k.repeat || k.alt || k.ctrl || k.meta || k.shift) return null;
  return k.key === 'g' ? { kind: 'wait' } : null;
}

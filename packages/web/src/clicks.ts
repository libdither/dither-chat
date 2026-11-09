/**
 * Button counts (docs/button-counts.md), the part that needs no browser: which key a click counts as, which page
 * the app is on, and the tally waiting to go to the hub. clicklog.ts listens and sends.
 *
 * A control says what it is with `data-track="vote up"`. A key without ": " takes the name of the nearest
 * `data-track-area` around it ("triage: vote up"), else the page's; one with ": " is complete. A control without a
 * key counts as "<page>: other", so what is not tagged yet still shows. Keys are written in code: never a name,
 * a message, an id or an address.
 */
import type { ClickCount, ClickDevice } from '@dither-chat/protocol';
import { localDay } from '@dither-chat/protocol';
import type { Route } from './routes.ts';

/** What keyOf reads of an element, so a test can hand it plain objects. */
export interface ElementLike {
  tagName: string;
  parentElement: ElementLike | null;
  getAttribute(name: string): string | null;
}

const CONTROLS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
const ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'checkbox', 'radio', 'switch']);
const isControl = (el: ElementLike) => CONTROLS.has(el.tagName.toUpperCase()) || ROLES.has(el.getAttribute('role') ?? '');

/** The area a key without one belongs to: the nearest `data-track-area` from `el` up. */
export function areaOf(el: ElementLike | null): string | null {
  for (let x = el; x; x = x.parentElement) {
    const a = x.getAttribute('data-track-area');
    if (a) return a;
  }
  return null;
}

/** A key as it is counted: complete, or with its area (or the page) in front. */
export const fullKey = (key: string, area: string | null, page: string) => (key.includes(': ') ? key : `${area ?? page}: ${key}`);

/**
 * What a click on `target` counts as, on `page`. The nearest control decides: its key if it has one, else
 * "<page>: other", so an untagged button inside a tagged row is not taken for the row. A click on no control
 * (text, empty space) counts as nothing, and a label's click counts as the one on its control that follows.
 */
export function keyOf(target: ElementLike | null, page: string): string | null {
  for (let el = target; el; el = el.parentElement) {
    const key = el.getAttribute('data-track');
    if (key) return fullKey(key, areaOf(el), page);
    if (el.tagName.toUpperCase() === 'LABEL') return null;
    if (isControl(el)) return `${page}: other`;
  }
  return null;
}

/** Counts a click on `target` into `tally`, if it landed on a control. The key it counted, or null. */
export function recordClick(tally: ClickTally, target: ElementLike | null, page: string, device: ClickDevice, now: number | Date = Date.now()): string | null {
  const key = keyOf(target, page);
  if (key) tally.add(key, page, device, now);
  return key;
}

/** The page a route shows, by kind: never which conversation, person or place. */
export function pageOf(r: Route): string {
  switch (r.view) {
    case 'inbox':
      return r.conv ? (r.conv.startsWith('mth_') ? 'mail thread' : 'conversation') : 'inbox';
    case 'people':
      return r.person ? 'conversation' : r.graph ? 'people graph' : 'people';
    case 'space':
    case 'search':
      return r.conv ? 'conversation' : r.view;
    case 'folder':
      return r.conv || r.person ? 'conversation' : 'folder';
    case 'mail':
      return r.thread ? 'mail thread' : 'mail';
    default:
      return r.view;
  }
}

/** A list row's key: what kind of row and what it shows, never whose. */
export function rowTrack(kind: string, unread: boolean, owes = false): string {
  return `row (${kind}${unread ? ', unread' : owes ? ', owes a reply' : ''})`;
}

/** What a conversation is, as a row's key says it. */
export const convKind = (shape: string): string => ({ direct: 'DM', group: 'group', self: 'notes', channel: 'channel', thread: 'thread' })[shape] ?? shape;

/** Counts not sent yet, one entry per day, key, page and device. */
export class ClickTally {
  private m = new Map<string, ClickCount>();

  constructor(from: ClickCount[] = []) {
    for (const c of from) this.addCount(c);
  }

  add(key: string, page: string, device: ClickDevice, now: number | Date = Date.now()) {
    this.addCount({ day: localDay(now), key, page, device, n: 1 });
  }

  private addCount(c: ClickCount) {
    const k = `${c.day}\t${c.key}\t${c.page}\t${c.device}`;
    const cur = this.m.get(k);
    if (cur) cur.n += c.n;
    else this.m.set(k, { ...c });
  }

  get size() {
    return this.m.size;
  }

  /** Everything, and the tally empty. */
  take(): ClickCount[] {
    const out = [...this.m.values()];
    this.m.clear();
    return out;
  }

  list(): ClickCount[] {
    return [...this.m.values()];
  }
}

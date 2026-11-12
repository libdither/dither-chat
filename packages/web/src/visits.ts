/**
 * The recording behind activity.ts, with the clock passed in: one record per stay on a screen or place, how the
 * user got there and what they did, counted by the same rules as tracker.ts (docs/activity.md).
 */
import type { VisitRecord, VisitSource, VisitView } from '@dither-chat/protocol';
import { MAX_TICK, VISIT_AFTER } from './tracker.ts';

export type Place = { view: VisitView; conversationId?: string | null; spaceId?: string | null; personId?: string | null };
export type Arrival = { source: VisitSource; pushId?: string | null; rank?: number | null; score?: number | null; needs?: boolean | null };
export type Action = 'sent' | 'reactions' | 'history' | 'threads' | 'attachments';

export const samePlace = (a: Place, b: Place) =>
  a.view === b.view && (a.conversationId ?? null) === (b.conversationId ?? null) && (a.spaceId ?? null) === (b.spaceId ?? null) && (a.personId ?? null) === (b.personId ?? null);

/** Worth keeping: in use long enough to be a visit, reached from a notification, or something was done there. */
export const worthKeeping = (v: VisitRecord) =>
  v.active >= VISIT_AFTER || v.source === 'notification' || v.source === 'toast' || v.sent > 0 || v.reactions > 0 || v.history > 0 || v.threads > 0 || v.attachments > 0;

/** How many tapped push ids a device remembers. */
export const TAPS_KEPT = 200;

/**
 * Is this the first time this device opens from this push? The Android app's activity, made again after Android
 * stopped it, starts from the intent that first launched it: an old notification's, with its push id. That is not a
 * tap. Returns whether it is new, and what to remember (newest last, at most TAPS_KEPT).
 */
export function firstTap(seen: readonly string[], id: string): { fresh: boolean; seen: string[] } {
  if (seen.includes(id)) return { fresh: false, seen: [...seen] };
  return { fresh: true, seen: [...seen, id].slice(-TAPS_KEPT) };
}

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export class VisitLog {
  current: VisitRecord | null = null;
  private done: VisitRecord[] = [];
  private active = false;
  private last: number;

  constructor(
    private device: string,
    private label: string,
    now: number,
    private newId = randomId,
  ) {
    this.last = now;
  }

  /** The time since the last call goes to the open stay if the app was in use. */
  update(now: number, active: boolean) {
    const elapsed = this.active ? Math.min(Math.max(0, now - this.last), MAX_TICK) / 1000 : 0;
    const v = this.current;
    if (v && elapsed > 0) {
      v.active = Math.round((v.active + elapsed) * 10) / 10;
      v.end = now;
    }
    this.active = active;
    this.last = now;
  }

  /** Where the user is now. The same place goes on; another closes this stay, naming where they went. */
  enter(now: number, place: Place, arrival: Arrival, active: boolean) {
    this.update(now, active);
    if (this.current && samePlace(this.current, place)) return false;
    this.close(place.view);
    this.open(now, place, arrival);
    return true;
  }

  /** A new stay at the same place: back after a long time away, or a notification tapped while already here. */
  restart(now: number, arrival: Arrival, active: boolean) {
    this.update(now, active);
    const cur = this.current;
    if (!cur) return;
    this.close(cur.view);
    this.open(now, cur, arrival);
  }

  /** The stay that just began came from somewhere better known (a notification tap arriving after the app came forward). */
  relabel(now: number, arrival: Arrival, within: number): boolean {
    const v = this.current;
    if (!v || now - v.start > within || v.source === 'notification') return false;
    Object.assign(v, { source: arrival.source, pushId: arrival.pushId ?? null, rank: arrival.rank ?? null, score: arrival.score ?? null, needs: arrival.needs ?? null });
    return true;
  }

  private open(now: number, place: Place, a: Arrival) {
    this.current = {
      id: this.newId(),
      device: this.device,
      deviceLabel: this.label,
      view: place.view,
      conversationId: place.conversationId ?? null,
      spaceId: place.spaceId ?? null,
      personId: place.personId ?? null,
      start: now,
      end: now,
      active: 0,
      source: a.source,
      pushId: a.pushId ?? null,
      rank: a.rank ?? null,
      score: a.score ?? null,
      needs: a.needs ?? null,
      depth: null,
      readToId: null,
      readToTs: null,
      sent: 0,
      reactions: 0,
      history: 0,
      threads: 0,
      attachments: 0,
      next: null,
      closed: false,
    };
  }

  /** Over: kept if it was worth keeping. `next` is where the user went, null when the app went away. */
  close(next: VisitView | null) {
    const v = this.current;
    if (!v) return;
    v.closed = true;
    v.next = next;
    if (worthKeeping(v)) this.done.push(v);
    this.current = null;
  }

  /** Something done during the stay. With a conversation, only if it is the one open. */
  note(action: Action, conversationId?: string) {
    const v = this.current;
    if (!v || (conversationId && v.conversationId !== conversationId)) return;
    v[action]++;
  }

  /** The inbox's list is on screen down to this row (0 = top): the stay keeps the deepest. */
  saw(depth: number | null) {
    const v = this.current;
    if (v && depth != null && depth > (v.depth ?? -1)) v.depth = depth;
  }

  /** The conversation open was marked read, up to this message. */
  read(conversationId: string, id: string, ts: number) {
    const v = this.current;
    if (!v || v.conversationId !== conversationId || (v.readToTs ?? 0) >= ts) return;
    v.readToId = id;
    v.readToTs = ts;
  }

  /** What to send: the stays that ended, and a copy of the open one if it is worth keeping yet. */
  take(): VisitRecord[] {
    const out = this.done;
    this.done = [];
    if (this.current && worthKeeping(this.current)) out.push({ ...this.current });
    return out;
  }
}

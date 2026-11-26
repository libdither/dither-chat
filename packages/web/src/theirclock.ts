/**
 * What time it is for someone (docs/profile.md "Their time"): their clock from the hub (a zone set by hand, a zone a
 * profile states, or an offset guessed from when they write), asked for a chat's authors in one request as their
 * messages are drawn, and kept a few hours; and their time at a moment, to show beside yours.
 */
import type * as P from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { api } from './api.ts';
import { zoneOffset } from './format.ts';

const KEEP_MS = 3 * 3_600_000;
/** How long after a hub says it is asking a profile for a zone to ask the hub again. */
const ASKING_AGAIN_MS = 8_000;

const kept = new Map<string, { clock: P.TheirClock | null; at: number }>();
const wanted = new Set<string>();
const inFlight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Bumped when clocks come in: what shows one reads it, and is drawn again. */
export const clocksRev = signal(0);

/** This device's zone, as the hub is told it. */
export const myZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** An author's clock: undefined until the hub has said (it is asked for here), null when none is known. */
export function clockOf(identityId: string): P.TheirClock | null | undefined {
  const k = kept.get(identityId);
  if ((!k || Date.now() - k.at > KEEP_MS) && !inFlight.has(identityId)) want(identityId);
  return k?.clock;
}

function want(id: string) {
  wanted.add(id);
  timer ??= setTimeout(flush, 40);
}

async function flush() {
  timer = null;
  const ids = [...wanted].slice(0, 100);
  for (const id of ids) {
    wanted.delete(id);
    inFlight.add(id);
  }
  if (wanted.size) timer = setTimeout(flush, 40);
  try {
    const v = await api<P.TheirClocksView>(`/api/people/clocks?ids=${ids.join(',')}&tz=${encodeURIComponent(myZone())}`);
    const now = Date.now();
    for (const id of ids) kept.set(id, { clock: v.clocks[id] ?? null, at: now });
    // A profile is being asked for a zone: ask again shortly, once it has come.
    if (v.asking?.length) setTimeout(() => v.asking!.forEach((id) => (kept.delete(id), want(id))), ASKING_AGAIN_MS);
    clocksRev.value++;
  } catch {
    // Asked again the next time one is drawn.
  } finally {
    for (const id of ids) inFlight.delete(id);
  }
}

/** Their clock changed here (a zone set by hand): forget it, so it is asked for again. */
export function forgetClock(identityId: string) {
  kept.delete(identityId);
  clocksRev.value++;
}

/** Their offset from UTC at a moment, in minutes east; null for a zone this browser does not know. */
export function clockOffset(c: P.TheirClock, ts: number): number | null {
  return c.source === 'rhythm' ? c.offset : zoneOffset(c.zone, ts);
}

/** Your own offset from UTC at a moment, in minutes east. */
export const myOffset = (ts: number) => -new Date(ts).getTimezoneOffset();

let clockFmt: Intl.DateTimeFormat | undefined;
let weekdayFmt: Intl.DateTimeFormat | undefined;
/** A wall-clock time at `offset` minutes east of UTC: "3:41 AM", with the weekday when `withDay`. */
export function wallClock(ts: number, offset: number, withDay = false): string {
  const at = ts + offset * 60_000;
  const t = (clockFmt ??= new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })).format(at);
  return withDay ? `${(weekdayFmt ??= new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short' })).format(at)} ${t}` : t;
}

/**
 * Their time at a moment, for beside yours: null when it is the same as yours, or a guess within two hours of it (a
 * guess can be an hour out either way, so that close it says nothing). `day` when their date is not yours, `night`
 * between 10 at night and 7 in the morning for them.
 */
export function theirTimeAt(c: P.TheirClock, ts: number): { text: string; guessed: boolean; night: boolean; offset: number } | null {
  const theirs = clockOffset(c, ts);
  const mine = myOffset(ts);
  if (theirs === null || theirs === mine) return null;
  const guessed = c.source === 'rhythm';
  if (guessed && Math.abs(theirs - mine) < 120) return null;
  const day = (o: number) => Math.floor((ts + o * 60_000) / 86_400_000);
  const hour = Math.floor((((ts + theirs * 60_000) % 86_400_000) + 86_400_000) % 86_400_000 / 3_600_000);
  return { text: wallClock(ts, theirs, day(theirs) !== day(mine)), guessed, night: hour >= 22 || hour < 7, offset: theirs };
}

/**
 * When someone is likely to answer you (docs/profile.md "When they answer"): the hub's estimate, asked for as a chat
 * with them shows, again when a message comes or goes, and every few minutes while it stays open; and its times in
 * words.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api } from './api.ts';
import { myOffset, wallClock } from './theirclock.ts';

/** Asked again this often while a chat stays open: the chance moves as you wait. */
const AGAIN_MS = 5 * 60_000;
/** Fewer of your messages to them than this: too little to say. */
export const ENOUGH_TURNS = 3;

const kept = new Map<string, { key: string; v: P.TheirAnswerView }>();

/** Their estimate, for `ref` (a person or identity id) as of the chat's last message `last`: null until known, or none. */
export function useAnswer(ref: string | null, last: number | null): P.TheirAnswerView | null {
  const key = `${ref}|${last}`;
  const k = ref ? kept.get(ref) : undefined;
  const [v, setV] = useState<P.TheirAnswerView | null>(k?.key === key ? k.v : null);
  useEffect(() => {
    if (!ref) return setV(null);
    let live = true;
    const ask = () =>
      api<P.TheirAnswerView>(`/api/people/${ref}/answer`).then(
        (x) => {
          kept.set(ref, { key, v: x });
          if (live) setV(x);
        },
        () => {},
      );
    const k = kept.get(ref);
    if (k?.key === key) setV(k.v);
    else void ask();
    const t = setInterval(ask, AGAIN_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key]);
  return v;
}

/** A time ahead, as short as it can say which day: "9:40 PM", "tomorrow 9:10 AM", "Fri 9:10 AM"; at `at(ts)` minutes east of UTC, yours by default. */
function aheadLabel(ts: number, now = Date.now(), at: (ts: number) => number = myOffset): string {
  const day = (t: number) => Math.floor((t + at(t) * 60_000) / 86_400_000);
  const days = day(ts) - day(now);
  if (days <= 0) return wallClock(ts, at(ts));
  if (days === 1) return `tomorrow ${wallClock(ts, at(ts))}`;
  return wallClock(ts, at(ts), true);
}

/** "Likely by 9:40 PM, 8 in 10 by tomorrow 1 AM" ("likely…" inside a sentence); "any minute" when the likely time is that close. Times as `aheadLabel`. */
export function answerLine(v: P.TheirAnswerView, now = Date.now(), inside = false, at?: (ts: number) => number): string {
  if (v.half === null) return `${v.week}% chance of an answer within the week`;
  const half = v.half - now < 5 * 60_000 ? 'any minute' : `by ${aheadLabel(v.half, now, at)}`;
  const likely = `${inside ? 'likely' : 'Likely'} ${half}`;
  return v.likely === null ? likely : `${likely}, 8 in 10 by ${aheadLabel(v.likely, now, at)}`;
}

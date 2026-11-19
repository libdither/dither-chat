import { describe, expect, test } from 'bun:test';
import { callBadge, type HoldTimers, SPEAKING_HOLD_MS, speakingHold } from '../src/callmarks.ts';

/** A clock the test moves by hand: timers fire only when it is advanced past them. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: HoldTimers = {
    after(fn, ms) {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { timers, advance, pending };
}

function setup() {
  const clock = fakeTimers();
  const changes: string[][] = [];
  const hold = speakingHold((on) => changes.push([...on].sort()), SPEAKING_HOLD_MS, clock.timers);
  return { ...clock, hold, changes };
}

describe('speakingHold', () => {
  test('comes on at once', () => {
    const { hold, changes } = setup();
    hold.update(['a']);
    expect([...hold.on]).toEqual(['a']);
    expect(changes).toEqual([['a']]);
  });

  test('stays on through a gap between words shorter than the hold', () => {
    const { hold, changes, advance } = setup();
    hold.update(['a']);
    hold.update([]);
    advance(SPEAKING_HOLD_MS - 1);
    hold.update(['a']);
    advance(SPEAKING_HOLD_MS - 1);
    hold.update([]);
    advance(SPEAKING_HOLD_MS - 1);
    expect([...hold.on]).toEqual(['a']);
    expect(changes).toEqual([['a']]);
  });

  test('goes off once quiet for the whole hold after the last word', () => {
    const { hold, changes, advance } = setup();
    hold.update(['a']);
    hold.update([]);
    advance(SPEAKING_HOLD_MS - 1);
    expect(hold.on.has('a')).toBe(true);
    advance(1);
    expect(hold.on.has('a')).toBe(false);
    expect(changes).toEqual([['a'], []]);
  });

  test('a repeated quiet update does not restart the hold', () => {
    const { hold, advance } = setup();
    hold.update(['a']);
    hold.update([]);
    advance(200);
    hold.update([]);
    advance(SPEAKING_HOLD_MS - 200);
    expect(hold.on.size).toBe(0);
  });

  test('holds each person on their own', () => {
    const { hold, advance } = setup();
    hold.update(['a', 'b']);
    hold.update(['b']);
    advance(SPEAKING_HOLD_MS);
    expect([...hold.on]).toEqual(['b']);
    hold.update([]);
    advance(SPEAKING_HOLD_MS);
    expect(hold.on.size).toBe(0);
  });

  test('clear drops everyone and their timers', () => {
    const { hold, pending, changes } = setup();
    hold.update(['a', 'b']);
    hold.update(['a']);
    hold.clear();
    expect(hold.on.size).toBe(0);
    expect(pending.size).toBe(0);
    expect(changes.at(-1)).toEqual([]);
  });
});

describe('callBadge', () => {
  const base = { muted: false, deafened: false };
  test('shows the most important state', () => {
    expect(callBadge({ ...base, muted: true, deafened: true, serverMuted: true, stage: 'hand' })).toBe('serverMuted');
    expect(callBadge({ ...base, muted: true, serverDeafened: true })).toBe('serverDeafened');
    expect(callBadge({ ...base, muted: true, deafened: true, stage: 'hand' })).toBe('deafened');
    expect(callBadge({ ...base, muted: true, stage: 'hand' })).toBe('muted');
    expect(callBadge({ ...base, stage: 'hand', localMute: true })).toBe('hand');
    expect(callBadge({ ...base, localMute: true })).toBe('mutedForYou');
    expect(callBadge({ ...base, stage: 'speaker' })).toBeNull();
  });
});

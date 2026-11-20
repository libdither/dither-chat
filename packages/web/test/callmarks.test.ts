import { describe, expect, test } from 'bun:test';
import { badgeSize, callBadge, callTime, type Clock, controlsFor, FEATURE_KEEP_MS, featuredPicker, MUTED_TALK, SPEAKING_HOLD_MS, speakingHold, stageCan, statusFor, talkGate } from '../src/callmarks.ts';

/** A clock the test moves by hand: timers fire only when it is advanced past them. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
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
  return { clock, advance, pending };
}

function holdSetup() {
  const c = fakeClock();
  const changes: string[][] = [];
  const hold = speakingHold((on) => changes.push([...on].sort()), SPEAKING_HOLD_MS, c.clock);
  return { ...c, hold, changes };
}

describe('speakingHold', () => {
  test('comes on at once', () => {
    const { hold, changes } = holdSetup();
    hold.update(['a']);
    expect([...hold.on]).toEqual(['a']);
    expect(changes).toEqual([['a']]);
  });

  test('stays on through a gap between words shorter than the hold', () => {
    const { hold, changes, advance } = holdSetup();
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
    const { hold, changes, advance } = holdSetup();
    hold.update(['a']);
    hold.update([]);
    advance(SPEAKING_HOLD_MS - 1);
    expect(hold.on.has('a')).toBe(true);
    advance(1);
    expect(hold.on.has('a')).toBe(false);
    expect(changes).toEqual([['a'], []]);
  });

  test('a repeated quiet update does not restart the hold', () => {
    const { hold, advance } = holdSetup();
    hold.update(['a']);
    hold.update([]);
    advance(200);
    hold.update([]);
    advance(SPEAKING_HOLD_MS - 200);
    expect(hold.on.size).toBe(0);
  });

  test('holds each person on their own', () => {
    const { hold, advance } = holdSetup();
    hold.update(['a', 'b']);
    hold.update(['b']);
    advance(SPEAKING_HOLD_MS);
    expect([...hold.on]).toEqual(['b']);
    hold.update([]);
    advance(SPEAKING_HOLD_MS);
    expect(hold.on.size).toBe(0);
  });

  test('clear drops everyone and their timers', () => {
    const { hold, pending, changes } = holdSetup();
    hold.update(['a', 'b']);
    hold.update(['a']);
    hold.clear();
    expect(hold.on.size).toBe(0);
    expect(pending.size).toBe(0);
    expect(changes.at(-1)).toEqual([]);
  });
});

function pickerSetup() {
  const c = fakeClock();
  const picks: (string | null)[] = [];
  const picker = featuredPicker((id) => picks.push(id), FEATURE_KEEP_MS, c.clock);
  return { ...c, picker, picks };
}

describe('featuredPicker', () => {
  test('features the first to talk at once, never you', () => {
    const { picker, picks } = pickerSetup();
    picker.update(['me'], 'me');
    expect(picker.shown).toBeNull();
    picker.update(['me', 'a'], 'me');
    expect(picker.shown).toBe('a');
    expect(picks).toEqual(['a']);
  });

  test('switches to the latest to start talking, but only after the keep', () => {
    const { picker, picks, advance } = pickerSetup();
    picker.update(['a']);
    advance(500);
    picker.update(['a', 'b']);
    expect(picker.shown).toBe('a');
    advance(FEATURE_KEEP_MS - 500 - 1);
    expect(picker.shown).toBe('a');
    advance(1);
    expect(picker.shown).toBe('b');
    expect(picks).toEqual(['a', 'b']);
  });

  test('a talker who started long after the keep takes it at once', () => {
    const { picker, advance } = pickerSetup();
    picker.update(['a']);
    advance(FEATURE_KEEP_MS + 1000);
    picker.update(['a', 'b']);
    expect(picker.shown).toBe('b');
  });

  test('a quick word from someone else inside the keep never takes it', () => {
    const { picker, picks, advance } = pickerSetup();
    picker.update(['a']);
    advance(300);
    picker.update(['a', 'b']);
    advance(300);
    picker.update(['a']);
    advance(FEATURE_KEEP_MS);
    expect(picker.shown).toBe('a');
    expect(picks).toEqual(['a']);
  });

  test('nobody talking: nobody featured once the keep is over', () => {
    const { picker, picks, advance } = pickerSetup();
    picker.update(['a']);
    advance(200);
    picker.update([]);
    expect(picker.shown).toBe('a');
    advance(FEATURE_KEEP_MS - 200);
    expect(picker.shown).toBeNull();
    expect(picks).toEqual(['a', null]);
  });

  test('clear forgets everyone and calls off a waiting switch', () => {
    const { picker, pending } = pickerSetup();
    picker.update(['a']);
    picker.update(['a', 'b']);
    expect(pending.size).toBe(1);
    picker.clear();
    expect(picker.shown).toBeNull();
    expect(pending.size).toBe(0);
  });
});

describe('talkGate (talking into a muted microphone)', () => {
  /** Readings every 100 ms, as call.ts takes them: `pattern` one character a reading, x loud and . quiet. */
  function run(pattern: string) {
    const c = fakeClock();
    const seen: boolean[] = [];
    const gate = talkGate((on) => seen.push(on), MUTED_TALK, c.clock);
    const at: boolean[] = [];
    for (const ch of pattern) {
      gate.update(ch === 'x');
      at.push(gate.on);
      c.advance(100);
    }
    return { at, seen, gate };
  }

  test('a cough does not show it', () => {
    expect(run('xx........').seen).toEqual([]);
  });

  test('half a second of talk shows it', () => {
    const { at } = run('xxxxxxx');
    expect(at.indexOf(true)).toBe(MUTED_TALK.onMs / 100);
  });

  test('short gaps between words do not restart the count', () => {
    const { at } = run('xx.xx.xx');
    expect(at.at(-1)).toBe(true);
  });

  test('a long gap does', () => {
    expect(run('xxx....xxx').seen).toEqual([]);
  });

  test('stays through pauses, clears after three seconds of quiet', () => {
    const quiet = MUTED_TALK.offMs / 100;
    const { at, seen } = run('xxxxxx' + '.'.repeat(10) + 'x' + '.'.repeat(quiet + 1));
    const back = at.lastIndexOf(true);
    expect(back).toBe(6 + 10 + quiet - 1);
    expect(seen).toEqual([true, false]);
  });
});

describe('callBadge', () => {
  const base = { muted: false, deafened: false };
  test('a speaker, or a call without an audience: the most important state', () => {
    expect(callBadge({ ...base, muted: true, deafened: true, serverMuted: true })).toBe('serverMuted');
    expect(callBadge({ ...base, muted: true, serverDeafened: true })).toBe('serverDeafened');
    expect(callBadge({ ...base, muted: true, deafened: true })).toBe('deafened');
    expect(callBadge({ ...base, muted: true, stage: 'speaker' })).toBe('muted');
    expect(callBadge({ ...base, localMute: true })).toBe('mutedForYou');
    expect(callBadge({ ...base, stage: 'speaker' })).toBeNull();
  });

  test('the audience: muted is their default, so a hand, then an invitation, else nothing', () => {
    expect(callBadge({ ...base, muted: true, serverMuted: true, stage: 'hand' })).toBe('hand');
    expect(callBadge({ ...base, muted: true, serverMuted: true, stage: 'invited' })).toBe('invited');
    expect(callBadge({ ...base, muted: true, serverMuted: true, deafened: true, stage: 'audience' })).toBeNull();
  });

  test('grows with the face', () => {
    expect(badgeSize(18)).toBe(10);
    expect(badgeSize(40)).toBe(14);
    expect(badgeSize(64)).toBe(23);
    expect(badgeSize(88)).toBe(28);
  });
});

describe('the status line', () => {
  const call = { mode: 'bridge' as const, phase: 'live' as const, muted: false, deafened: false, since: 0, camera: false, screen: false, self: { connected: true, muted: false } };
  test('hours as 1:15:03', () => {
    expect(callTime(65_000)).toBe('1:05');
    expect(callTime(75 * 60_000 + 3_000)).toBe('1:15:03');
    expect(statusFor(call, 75 * 60_000 + 3_000, 'Discord')).toEqual({ text: '1:15:03', phase: 'live' });
  });

  test("bridge mode, before the account's own client is in: reaching", () => {
    expect(statusFor({ ...call, self: { connected: false, muted: false } }, 5000, 'Discord')).toEqual({ text: 'Connecting to Discord…', phase: 'reaching' });
  });

  test('the account still muted after you unmuted: a hint', () => {
    expect(statusFor({ ...call, self: { connected: true, muted: true } }, 5000, 'Discord').hint).toBe('The account is still muted: tap to try again');
  });

  test('connecting and ended', () => {
    expect(statusFor({ ...call, phase: 'connecting' }, 0, 'Discord').text).toBe('Connecting…');
    expect(statusFor({ ...call, phase: 'ended', note: 'You left' }, 0, 'Discord')).toEqual({ text: 'You left', phase: 'ended' });
  });
});

describe('controlsFor', () => {
  const call = { mode: 'bridge' as const, phase: 'live' as const, muted: false, deafened: false, since: 0, camera: false, screen: false };
  const can = { role: null, video: true, share: true, stage: true } as const;
  const kinds = (c: Parameters<typeof controlsFor>[0], a: Parameters<typeof controlsFor>[1]) => controlsFor(c, a).map((x) => x.kind);

  test('a plain call', () => {
    expect(kinds(call, can)).toEqual(['mute', 'deafen', 'camera', 'share', 'leave']);
    expect(kinds(call, { ...can, video: false })).toEqual(['mute', 'deafen', 'leave']);
    expect(kinds(call, { ...can, share: false })).toEqual(['mute', 'deafen', 'camera', 'leave']);
  });

  test('a stage: speaker, audience, hand up, invited, moderator', () => {
    const stage = { ...call, stage: {} };
    expect(kinds(stage, { ...can, role: 'speaker' })).toEqual(['mute', 'deafen', 'camera', 'share', 'listen', 'leave']);
    expect(kinds(stage, { ...can, role: 'audience' })).toEqual(['deafen', 'hand', 'leave']);
    expect(controlsFor(stage, { ...can, role: 'hand' }).find((c) => c.kind === 'hand')).toMatchObject({ label: 'Lower hand', on: true });
    expect(kinds(stage, { ...can, role: 'invited' })).toEqual(['deafen', 'speak', 'listen', 'leave']);
    expect(controlsFor(stage, { ...can, role: 'invited' }).find((c) => c.kind === 'listen')?.label).toBe('Stay in the audience');
    // A moderator listening speaks without asking first: Speak, and no Ask to speak beside it.
    expect(kinds(stage, { ...can, role: 'audience', rank: 'moderator' })).toEqual(['deafen', 'speak', 'leave']);
    expect(kinds({ ...stage, stage: { canOn: ['invite'] } }, { ...can, role: 'audience' })).toEqual(['deafen', 'speak', 'leave']);
    expect(kinds(stage, { ...can, role: 'hand', rank: 'host' })).toEqual(['deafen', 'hand', 'speak', 'leave']);
    expect(controlsFor(stage, { ...can, role: 'audience' }).at(-1)?.label).toBe('Leave quietly');
  });

  test("what the stage says you may do wins over your role's defaults", () => {
    // A Space that lets nobody ask: no hand. A speaker the room won't let step down: no Move to the audience.
    expect(kinds({ ...call, stage: { can: [] } }, { ...can, role: 'audience' })).toEqual(['deafen', 'leave']);
    expect(kinds({ ...call, stage: { can: [] } }, { ...can, role: 'speaker' })).toEqual(['mute', 'deafen', 'camera', 'share', 'leave']);
    expect(stageCan({ stage: {} }, { role: 'speaker', rank: 'cohost', stage: true })).toEqual({ can: ['listen'], canOn: ['invite', 'audience'] });
    expect(stageCan({ stage: {} }, { role: 'audience', stage: true })).toEqual({ can: ['raiseHand'], canOn: [] });
  });

  test('without the stage capability: no hand, Speak or Move', () => {
    expect(kinds({ ...call, stage: { canOn: ['invite', 'audience'] } }, { ...can, role: 'audience', stage: false })).toEqual(['deafen', 'leave']);
    expect(stageCan({ stage: {} }, { role: 'audience', rank: 'host', stage: false })).toEqual({ can: [], canOn: [] });
  });

  test('the audience never gets a camera or a screen', () => {
    expect(kinds({ ...call, stage: {} }, { ...can, role: 'audience' })).not.toContain('camera');
    expect(kinds({ ...call, stage: {} }, { ...can, role: 'invited' })).not.toContain('share');
  });

  test("the microphone's state", () => {
    expect(controlsFor({ ...call, muted: true, listenOnly: true }, can)[0]).toMatchObject({ label: 'Unmute', off: true, disabled: true, title: 'No microphone: listening only' });
    expect(controlsFor({ ...call, self: { connected: true, muted: true } }, can)[0]).toMatchObject({ label: 'Mute', title: 'The account is still muted: tap to try again' });
    expect(controlsFor({ ...call, phase: 'ended' }, can).every((c) => c.disabled)).toBe(true);
  });
});

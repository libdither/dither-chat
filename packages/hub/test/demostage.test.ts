/**
 * The demo stage (demostage.ts): the room's state gets everyone's role laid over it and the simulated people added;
 * stage actions move roles as Discord's would, a moderator's only for moderators; a simulated person invited to speak
 * accepts; the stage starts over once the last device leaves.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { DemoStage, demoStageSeed } from '../src/demostage.ts';

const MOD = '700000000000000001';
const ALT = '700000000000000002';
const BOT = '700000000000000009';
const CHANNEL = '300000000000000301';

function stage() {
  const later: (() => void)[] = [];
  const s = new DemoStage(demoStageSeed(CHANNEL, [MOD], BOT), { every: () => 0 as any, stop: () => {}, later: (fn) => (later.push(fn), 0 as any) });
  const got = new Map<string, P.CallState[]>();
  const join = (call: string, self: string) => {
    got.set(call, []);
    const emit = s.join(call, self, (ev) => {
      if (ev.t === 'call' && ev.state) got.get(call)!.push(ev.state);
    });
    // The room's own state: the bot and every device in the channel.
    return (selves: string[]) => emit({ t: 'call', call, state: { conversation: CHANNEL, participants: [BOT, ...selves].map((id) => ({ id, muted: false, deafened: false, speaking: id === BOT })) } });
  };
  const last = (call: string) => got.get(call)!.at(-1)!;
  const role = (call: string, id: string) => last(call).participants.find((p) => p.id === id)?.stage;
  return { s, join, last, role, later };
}

describe('demo stage', () => {
  test('the room state gets roles, the simulated people and the stage', () => {
    const { join, last } = stage();
    join('c1', ALT)([ALT]);
    const st = last('c1');
    expect(st.stage).toEqual({ topic: 'Office hours: routing questions', moderator: false });
    const by = (r: P.StageRole) => st.participants.filter((p) => p.stage === r);
    expect(by('speaker').map((p) => p.id)).toContain(BOT);
    expect(by('speaker')).toHaveLength(3);
    expect(by('hand')).toHaveLength(2);
    expect(by('audience').length).toBeGreaterThanOrEqual(19);
    // The device joins listening, and only speakers are heard.
    expect(st.participants.find((p) => p.id === ALT)).toMatchObject({ stage: 'audience', muted: true, speaking: false });
    expect(st.participants.find((p) => p.id === BOT)).toMatchObject({ stage: 'speaker', stageModerator: true });
  });

  test('a hand goes up, a moderator invites, the invited speaks; a moderator moves them back', () => {
    const { s, join, role } = stage();
    const mod = join('m', MOD);
    const alt = join('a', ALT);
    mod([MOD, ALT]);
    alt([MOD, ALT]);
    expect(s.action('a', 'invite', MOD)).toBe('Only a moderator can do that.');
    expect(s.action('a', 'speak')).toMatch(/moderator or someone invited/);
    expect(s.action('a', 'raiseHand')).toBeNull();
    expect(role('m', ALT)).toBe('hand');
    expect(s.action('m', 'invite', ALT)).toBeNull();
    expect(role('a', ALT)).toBe('invited');
    expect(s.action('a', 'speak')).toBeNull();
    expect(role('m', ALT)).toBe('speaker');
    expect(s.action('m', 'audience', ALT)).toBeNull();
    expect(role('a', ALT)).toBe('audience');
    // A moderator may speak without an invitation.
    expect(s.action('m', 'speak')).toBeNull();
    expect(role('a', MOD)).toBe('speaker');
    expect(s.action('m', 'listen')).toBeNull();
    expect(role('a', MOD)).toBe('audience');
  });

  test('a simulated person invited to speak accepts a moment later', () => {
    const { s, join, last, role, later } = stage();
    join('m', MOD)([MOD]);
    const hand = last('m').participants.find((p) => p.stage === 'hand')!;
    expect(s.action('m', 'invite', hand.id)).toBeNull();
    expect(role('m', hand.id)).toBe('invited');
    later.forEach((f) => f());
    expect(role('m', hand.id)).toBe('speaker');
  });

  test('the stage starts over once the last device leaves', () => {
    const { s, join, last } = stage();
    join('m', MOD)([MOD]);
    const hand = last('m').participants.find((p) => p.stage === 'hand')!;
    s.action('m', 'invite', hand.id);
    s.leave('m');
    expect(s.has('m')).toBe(false);
    join('m2', MOD)([MOD]);
    expect(last('m2').participants.find((p) => p.id === hand.id)?.stage).toBe('hand');
  });

  test('speaking takes turns among the simulated speakers', () => {
    const { s, join, last } = stage();
    join('c', ALT)([ALT]);
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      s.tick();
      for (const p of last('c').participants) if (p.speaking && p.id !== BOT) seen.add(p.id);
      expect(last('c').participants.filter((p) => p.speaking && p.id !== BOT).length).toBeLessThanOrEqual(1);
    }
    expect(seen.size).toBe(2);
  });
});

import { describe, expect, test } from 'bun:test';
import { BAR_UNDER, barKinds, barShows, idleFaces } from '../src/callbar.ts';
import { controlsFor } from '../src/callmarks.ts';

describe('barKinds', () => {
  const call = { mode: 'bridge' as const, phase: 'live' as const, muted: false, deafened: false, since: 0, camera: false, screen: false };
  const can = { role: null, video: true, share: true, stage: true } as const;
  const bar = (c: Parameters<typeof controlsFor>[0], a: Parameters<typeof controlsFor>[1]) => barKinds(controlsFor(c, a), !!c.listenOnly);

  test('a speaker: mute and deafen, never leave', () => {
    expect(bar(call, can)).toEqual(['mute', 'deafen']);
    expect(bar(call, { ...can, video: false })).toEqual(['mute', 'deafen']);
  });

  test('a camera or a screen that is on takes the second place, so it can be turned off from anywhere', () => {
    expect(bar({ ...call, camera: true }, can)).toEqual(['mute', 'camera']);
    expect(bar({ ...call, screen: true }, can)).toEqual(['mute', 'share']);
    expect(bar({ ...call, camera: true, screen: true }, can)).toEqual(['mute', 'camera']);
  });

  test('no microphone: deafen alone', () => {
    expect(bar({ ...call, muted: true, listenOnly: true }, can)).toEqual(['deafen']);
  });

  test('a stage: the audience has deafen and its hand, the invited Speak', () => {
    const stage = { ...call, stage: { moderator: false } };
    expect(bar(stage, { ...can, role: 'speaker' })).toEqual(['mute', 'deafen']);
    expect(bar(stage, { ...can, role: 'audience' })).toEqual(['deafen', 'hand']);
    expect(bar(stage, { ...can, role: 'hand' })).toEqual(['deafen', 'hand']);
    expect(bar(stage, { ...can, role: 'invited' })).toEqual(['deafen', 'speak']);
    expect(bar({ ...stage, stage: { moderator: true } }, { ...can, role: 'audience' })).toEqual(['deafen', 'speak']);
    expect(bar(stage, { ...can, role: 'audience', stage: false })).toEqual(['deafen']);
  });

  test('no role ever gets leave on the bar', () => {
    for (const role of [null, 'speaker', 'audience', 'hand', 'invited'] as const) {
      const stage = role ? { ...call, stage: { moderator: true } } : call;
      expect(bar(stage, { ...can, role })).not.toContain('leave');
    }
  });
});

describe('barShows', () => {
  const at = { inCall: true, phone: false, here: false, listHidden: false, listWidth: 332 };

  test('never without a call', () => {
    expect(barShows({ ...at, inCall: false, phone: true })).toBe(false);
    expect(barShows({ ...at, inCall: false, listHidden: true })).toBe(false);
  });

  test("a phone: anywhere but the call's own chat", () => {
    expect(barShows({ ...at, phone: true })).toBe(true);
    expect(barShows({ ...at, phone: true, here: true })).toBe(false);
  });

  test('a computer: only where the list is hidden or narrow', () => {
    expect(barShows(at)).toBe(false);
    expect(barShows({ ...at, here: true })).toBe(false);
    expect(barShows({ ...at, listHidden: true })).toBe(true);
    expect(barShows({ ...at, listWidth: BAR_UNDER })).toBe(true);
    expect(barShows({ ...at, listWidth: BAR_UNDER + 1 })).toBe(false);
  });
});

describe('idleFaces', () => {
  test('the others, in order, at most three', () => {
    expect(idleFaces(['me', 'a', 'b', 'c', 'd'], 'me')).toEqual(['a', 'b', 'c']);
    expect(idleFaces(['a', 'me'], 'me')).toEqual(['a']);
    expect(idleFaces(['me'], 'me')).toEqual([]);
    expect(idleFaces(['a', 'b'], undefined, 1)).toEqual(['a']);
  });
});

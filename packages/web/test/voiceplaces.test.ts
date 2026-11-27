/**
 * Who is in a call or a voice channel now (voiceplaces.ts; docs/calls.md "In a call now"): the lookup a row's in-call
 * icon reads, from the voice channels' people, the calls going on and the call this device is in.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { buildVoiceNow, placesOf, voiceNowFrom, voiceNowText, type VoiceLook } from '../src/voiceplaces.ts';

const convs: Record<string, Pick<P.ConversationView, 'id' | 'shape' | 'peerPersonId'>> = {
  hangout: { id: 'hangout', shape: 'channel', peerPersonId: null },
  dmLev: { id: 'dmLev', shape: 'direct', peerPersonId: 'pLev' },
  dmOwl: { id: 'dmOwl', shape: 'direct', peerPersonId: 'pOwl' },
  group: { id: 'group', shape: 'group', peerPersonId: null },
};
const persons: Record<string, string> = { lev: 'pLev', levTg: 'pLev', mara: 'pMara' };
const names: Record<string, string> = { lev: 'Lev', mara: 'Mara', stray: 'stray.one' };
const look: VoiceLook = {
  conv: (id) => convs[id],
  personOf: (id) => persons[id] ?? null,
  isSelf: (id) => id === 'me',
  name: (id) => names[id] ?? 'Someone',
  placeName: (id) => (id === 'hangout' ? '#hangout · Dither' : id === 'group' ? 'Weekend plans' : id),
};
const member = (identityId: string, more: Partial<P.VoiceChannelView['members'][number]> = {}) => ({ identityId, ...more });
const hangout = (...members: ReturnType<typeof member>[]) => ({ conversationId: 'hangout', members });
const call = (conversationId: string, participants: string[], more: Partial<P.CallView> = {}) => ({ conversationId, participants, state: 'ongoing' as const, ringing: false, ...more });

describe('buildVoiceNow', () => {
  test('a voice channel: each person in it, by person and identity, and the channel itself; never you', () => {
    const v = buildVoiceNow([hangout(member('lev'), member('me'), member('stray'))], [], null, look);
    expect(v.byPerson.get('pLev')).toEqual([{ conversationId: 'hangout', words: 'In voice in #hangout · Dither' }]);
    expect(v.byIdentity.get('stray')).toEqual([{ conversationId: 'hangout', words: 'In voice in #hangout · Dither' }]);
    expect(v.byIdentity.has('me')).toBe(false);
    expect(v.channels.get('hangout')).toEqual({ n: 2, words: 'In voice: Lev, stray.one' });
  });

  test('a channel with nobody in it (the voice setting off) gives nothing', () => {
    const v = buildVoiceNow([hangout()], [], null, look);
    expect(v.byPerson.size + v.byIdentity.size + v.channels.size).toBe(0);
  });

  test('a one-to-one call going on: the other side is in a call with you, listed or not', () => {
    expect(placesOf(buildVoiceNow([], [call('dmLev', ['lev', 'me'])], null, look), { person: 'pLev' })).toEqual([{ conversationId: 'dmLev', words: 'In a call with you' }]);
    expect(placesOf(buildVoiceNow([], [call('dmOwl', [])], null, look), { person: 'pOwl' })).toEqual([{ conversationId: 'dmOwl', words: 'In a call with you' }]);
  });

  test('a call still ringing, or ended, puts nobody in it', () => {
    const v = buildVoiceNow([], [call('dmLev', ['lev'], { ringing: true }), call('dmOwl', [], { state: 'ended' }), call('group', ['mara'], { state: 'ringing' })], null, look);
    expect(v.byPerson.size).toBe(0);
  });

  test('the call this device is in: a group call names the group; an ended one gives nothing', () => {
    expect(placesOf(buildVoiceNow([], [], { conversationId: 'group', phase: 'live', participants: [{ id: 'mara' }, { id: 'me' }] }, look), { person: 'pMara' })).toEqual([{ conversationId: 'group', words: 'In a call in Weekend plans' }]);
    expect(buildVoiceNow([], [], { conversationId: 'group', phase: 'ended', participants: [{ id: 'mara' }] }, look).byPerson.size).toBe(0);
  });

  test('your call in a voice channel says voice, and is listed once with what the channel says', () => {
    const v = buildVoiceNow([hangout(member('lev'))], [], { conversationId: 'hangout', phase: 'live', participants: [{ id: 'lev' }, { id: 'me' }] }, look);
    expect(v.byPerson.get('pLev')).toEqual([{ conversationId: 'hangout', words: 'In voice in #hangout · Dither' }]);
  });

  test('a person with two accounts in two places is in both', () => {
    const v = buildVoiceNow([hangout(member('lev'))], [call('dmLev', ['levTg'])], null, look);
    expect(v.byPerson.get('pLev')!.map((p) => p.conversationId)).toEqual(['hangout', 'dmLev']);
  });
});

describe('placesOf', () => {
  const v = buildVoiceNow([hangout(member('lev'), member('stray'))], [call('dmLev', ['lev'])], null, look);

  test("leaves out the row's own conversations: the row's call mark shows those", () => {
    expect(placesOf(v, { person: 'pLev' }, ['dmLev'])).toEqual([{ conversationId: 'hangout', words: 'In voice in #hangout · Dither' }]);
    expect(placesOf(v, { person: 'pLev' }, ['dmLev', 'hangout'])).toEqual([]);
  });

  test('an identity with no person is found by identity; someone nowhere has nothing', () => {
    expect(placesOf(v, { person: null, identity: 'stray' })).toHaveLength(1);
    expect(placesOf(v, { person: 'pOwl' })).toEqual([]);
    expect(placesOf(v, {})).toEqual([]);
  });
});

describe('voiceNowText', () => {
  test('a mute, a camera or a stream changes nothing the icons show: the text is the same', () => {
    const quiet = voiceNowText(buildVoiceNow([hangout(member('lev'), member('mara'))], [], null, look));
    const busy = voiceNowText(buildVoiceNow([hangout(member('lev', { muted: true }), member('mara', { video: true, streaming: true }))], [], null, look));
    expect(busy).toBe(quiet);
  });

  test('someone joining or leaving changes it, and it reads back as it was', () => {
    const one = buildVoiceNow([hangout(member('lev'))], [], null, look);
    const two = buildVoiceNow([hangout(member('lev'), member('mara'))], [], null, look);
    expect(voiceNowText(two)).not.toBe(voiceNowText(one));
    expect(voiceNowFrom(voiceNowText(two))).toEqual(two);
  });
});

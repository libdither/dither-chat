/**
 * What a call carries beyond joining it (call.ts, docs/calls.md "In a call"): the microphone's handling as it may go to
 * an account, and the actions on someone in voice (moderation.ts), which need the permission and nothing about rank.
 */
import { describe, expect, test } from 'bun:test';
import { CALL_INPUT_DEFAULT, callInput, modActionProblem, modPowerOf, modRefusal, modVerb } from '../src/index.ts';

describe('the microphone in a call', () => {
  test('anything out of range is the default; a level is a whole dB from -100 to 0', () => {
    expect(callInput(undefined)).toEqual(CALL_INPUT_DEFAULT);
    expect(callInput({ noiseSuppression: false, sensitivity: -42.6 })).toEqual({ noiseSuppression: false, sensitivity: -43 });
    expect(callInput({ noiseSuppression: 'no', sensitivity: 3 })).toEqual({ noiseSuppression: true, sensitivity: 'auto' });
    expect(callInput({ sensitivity: -101 }).sensitivity).toBe('auto');
    expect(callInput({ sensitivity: Number.NaN }).sensitivity).toBe('auto');
  });
});

describe('someone in voice', () => {
  test('mute and deafen need on or off, a move a channel; move and disconnect share one power', () => {
    expect(modActionProblem({ op: 'voiceDeafen', who: 'x', on: 'yes' })).toBe('on or off?');
    expect(modActionProblem({ op: 'move', who: 'x', to: '' })).toBe('to which voice channel?');
    expect(modActionProblem({ op: 'disconnect', who: 'x' })).toBeNull();
    expect(modPowerOf('move')).toBe('voiceMove');
    expect(modPowerOf('disconnect')).toBe('voiceMove');
    expect(modPowerOf('voiceMute')).toBe('voiceMute');
  });

  test('no rank above theirs is needed, and the network says whether they are in voice', () => {
    const m = { voiceMute: { can: true }, voiceMove: { can: false, reason: 'You need the Move Members permission.' } };
    expect(modRefusal(m, { op: 'voiceMute', who: 'x', on: true }, { above: true, reason: 'They own the server.' }, false)).toBeNull();
    expect(modRefusal(m, { op: 'move', who: 'x', to: 'c' })).toBe('You need the Move Members permission.');
    expect(modRefusal({}, { op: 'voiceDeafen', who: 'x', on: true })).toBe('You cannot do that here.');
    expect(modVerb('discord', { op: 'voiceMute', who: 'x', on: false })).toBe('Server unmute');
  });
});

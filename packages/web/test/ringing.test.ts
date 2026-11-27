import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { answerable, ringsAloud } from '../src/ringing.ts';

function call(id: string, state: P.CallView['state'], startedAt: number): P.CallView {
  return {
    id,
    accountId: 'acc_a',
    network: 'signal',
    conversationId: 'cnv_a',
    callerId: 'idn_b',
    startedAt,
    state,
    ringing: state === 'ringing',
    outgoing: false,
    video: false,
    participants: [],
    outcome: state === 'ended' ? 'answered' : null,
    endedAt: state === 'ended' ? startedAt + 60_000 : null,
    duration: null,
    messageId: null,
    canDecline: true,
    canAnswer: true,
  };
}

describe('answerable: an Answer from outside the page', () => {
  test('joins the call it was for while it rings or goes on', () => {
    expect(answerable([call('c1', 'ringing', 1)], 'c1')?.id).toBe('c1');
    expect(answerable([call('c1', 'ongoing', 1)], 'c1')?.id).toBe('c1');
  });

  test('joins nothing once that call is over, though a newer one goes on', () => {
    // Joining an ended one-to-one call calls the other side anew: a replayed Answer must not.
    expect(answerable([call('c1', 'ended', 1)], 'c1')).toBeNull();
    expect(answerable([call('c2', 'ringing', 2), call('c1', 'ended', 1)], 'c1')).toBeNull();
    expect(answerable([], 'c1')).toBeNull();
  });

  test('without a call id, the conversation call that is not over', () => {
    expect(answerable([call('c2', 'ended', 2), call('c1', 'ringing', 1)], undefined)?.id).toBe('c1');
    expect(answerable([call('c1', 'ended', 1)], undefined)).toBeNull();
  });
});

describe('the ring card rings aloud', () => {
  const alerting = { ringing: true, alerts: true };
  test('a call that may sound rings on a page in sight', () => {
    expect(ringsAloud([alerting], true, false)).toBe(true);
  });
  test('a muted call (or one quiet hours hold) shows its card quietly', () => {
    expect(ringsAloud([{ ringing: true, alerts: false }], true, false)).toBe(false);
  });
  test('a page out of sight leaves the sound to the notification', () => {
    expect(ringsAloud([alerting], false, false)).toBe(false);
  });
  test('not while this device is in a call', () => {
    expect(ringsAloud([alerting], true, true)).toBe(false);
  });
  test('nothing ringing, nothing rings', () => {
    expect(ringsAloud([{ ringing: false, alerts: false }], true, false)).toBe(false);
    expect(ringsAloud([], true, false)).toBe(false);
  });
});

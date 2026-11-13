/** A server's page beyond its settings (servers.ts, docs/servers.md): how a repeat reads, and when an answer may go. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { calledOff, gateReady, repeatText } from '../src/servers.ts';

test('repeats in words', () => {
  expect(repeatText(null)).toBeNull();
  expect(repeatText('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU')).toBe('Every week');
  expect(repeatText('FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU')).toBe('Every 2 weeks');
  expect(repeatText('FREQ=MONTHLY;INTERVAL=1;BYDAY=2FR')).toBe('Every month');
  expect(repeatText('FREQ=HOURLY')).toBe('Repeats');
});

test('rules wait for the tick; questions for the required answers; onboarding for a required pick', () => {
  const rules: P.SpaceGate = { space: 's', kind: 'rules', rules: ['Be kind'] };
  expect(gateReady(rules, false, {}, new Set())).toBe(false);
  expect(gateReady(rules, true, {}, new Set())).toBe(true);
  const apply: P.SpaceGate = { space: 's', kind: 'apply', rules: ['Be kind'], questions: [{ id: '1', kind: 'text', label: 'Why?', required: true }] };
  expect(gateReady(apply, true, { '1': '  ' }, new Set())).toBe(false);
  expect(gateReady(apply, true, { '1': 'art' }, new Set())).toBe(true);
  const onboarding: P.SpaceGate = { space: 's', kind: 'onboarding', prompts: [{ id: 'p', title: 'Pick', single: false, required: true, options: [{ id: 'o', title: 'Art' }] }] };
  expect(gateReady(onboarding, false, {}, new Set())).toBe(false);
  expect(gateReady(onboarding, false, {}, new Set(['o']))).toBe(true);
});

test('only called-off occurrences still to come are counted', () => {
  expect(calledOff({ exceptions: [{ nativeId: 'a', original: 10, cancelled: true }, { nativeId: 'b', original: 30, cancelled: true }, { nativeId: 'c', original: 40 }] }, 20)).toBe(1);
});

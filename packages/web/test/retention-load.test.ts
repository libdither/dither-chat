/**
 * The message-history settings (history.ts, docs/history.md) come back after a start that could not reach the hub:
 * a device between networks as it woke would otherwise show the defaults until the page reloaded.
 */
import { expect, mock, test } from 'bun:test';
import { DEFAULT_RETENTION } from '@dither-chat/protocol';
import { answers, asked, connected, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { loadRetention, retention, startRetention } = await import('../src/history.ts');

const kept = { ...DEFAULT_RETENTION, adversarial: true, deleted: true };
const loads = () => asked.filter((p) => p === '/api/retention').length;

test('a first load that finds the hub out of reach is asked again once the socket is back, and on each reconnect', async () => {
  // A start that cannot reach the hub: the socket opens and closes, the load fails, the defaults show.
  retention.value = DEFAULT_RETENTION;
  startRetention();
  connected.value = true;
  await loadRetention();
  connected.value = false;
  expect(retention.value).toEqual(DEFAULT_RETENTION);
  const before = loads();

  answers.set('/api/retention', () => kept);
  connected.value = true;
  await loadRetention();
  expect(retention.value).toEqual(kept);
  expect(loads()).toBe(before + 1);

  // Further calls use what was loaded; a reconnect asks again, for a change made elsewhere meanwhile.
  await loadRetention();
  expect(loads()).toBe(before + 1);
  connected.value = false;
  const changed = { ...kept, deleted: false };
  answers.set('/api/retention', () => changed);
  connected.value = true;
  await loadRetention();
  expect(retention.value).toEqual(changed);
  expect(loads()).toBe(before + 2);
  answers.delete('/api/retention');
  connected.value = false;
});

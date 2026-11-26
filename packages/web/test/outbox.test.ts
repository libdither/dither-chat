/** src/outbox.ts: sends kept on the device across a reload, until the hub has them, and what a failed POST becomes. */
import { expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { afterFailure, openOutbox, restoredState, type OutboxEntry } from '../src/outbox.ts';

const entry = (tempId: string, x: Partial<OutboxEntry> = {}): OutboxEntry => ({ tempId, conversationId: 'cnv_a', body: 'hi', ts: 1000, ...x });

test('what is put survives a new start (a reload opens the outbox again), files and all', async () => {
  const idb = new IDBFactory();
  const before = openOutbox(idb);
  const file = new Blob(['picture bytes'], { type: 'image/png' });
  await before.put(entry('tmp-1', { ts: 2000, files: [{ name: 'a.png', type: 'image/png', blob: file }] }));
  await before.put(entry('tmp-2', { ts: 1000, body: 'first' }));
  await before.put(entry('tmp-3', { ts: 3000 }));
  await before.remove('tmp-3');

  const after = openOutbox(idb);
  const kept = await after.all();
  // Oldest first, so they go out in the order they were written.
  expect(kept.map((e) => e.tempId)).toEqual(['tmp-2', 'tmp-1']);
  expect(kept[0].body).toBe('first');
  const f = kept[1].files![0];
  expect(f.name).toBe('a.png');
  expect(await new Response(f.blob).text()).toBe('picture bytes');
});

test('the upload ids and a refusal are kept with it', async () => {
  const idb = new IDBFactory();
  const o = openOutbox(idb);
  const e = entry('tmp-1');
  await o.put(e);
  e.attachments = ['upl_1'];
  e.failed = 'that upload has expired';
  await o.put(e);
  expect(await openOutbox(idb).all()).toEqual([{ ...entry('tmp-1'), attachments: ['upl_1'], failed: 'that upload has expired' }]);
});

test('without IndexedDB it still works, in memory, as before', async () => {
  const o = openOutbox(undefined);
  await o.put(entry('tmp-1'));
  expect((await o.all()).map((e) => e.tempId)).toEqual(['tmp-1']);
  await o.remove('tmp-1');
  expect(await o.all()).toEqual([]);
});

// ------------------------------------------------------------------ a failed POST (docs/sync.md "The send queue")

const noAnswer = () => new TypeError('Failed to fetch');
const hubSays = (status: number, message = 'x') => Object.assign(new Error(message), { status });

test('no answer: it waits on the device and goes to the hub again when it is back, under the same id', () => {
  // The hub keeps every clientId for good, so the same send again is answered with what the hub has: never in doubt here.
  for (const e of [noAnswer(), new DOMException('aborted', 'AbortError'), hubSays(502), hubSays(503), hubSays(504)]) expect(afterFailure(e, { online: true })).toBe('queued');
  expect(afterFailure(new Error('gone'), { online: false })).toBe('queued');
});

test('a refusal, or the hub\'s own error, is failed: shown with the reason', () => {
  for (const status of [400, 404, 409, 410, 413, 500]) expect(afterFailure(hubSays(status), { online: true })).toBe('failed');
});

test('kept from before a reload: failed as it was, else waiting to go to the hub', () => {
  expect(restoredState(entry('tmp-1'))).toEqual({ queued: true });
  expect(restoredState(entry('tmp-1', { failed: 'no' }))).toEqual({ failed: 'no' });
});

test('what you could see when you pressed Send is kept with it', async () => {
  const idb = new IDBFactory();
  await openOutbox(idb).put(entry('tmp-1', { seenUpTo: { id: 'msg_1', ts: 900 } }));
  expect(await openOutbox(idb).all()).toEqual([entry('tmp-1', { seenUpTo: { id: 'msg_1', ts: 900 } })]);
});

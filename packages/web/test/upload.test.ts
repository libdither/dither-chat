/** src/upload.ts: pieces and progress, carrying on after a drop or a reload, refusals said, cancel and retry. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { UPLOAD_CHUNK } from '@dither-chat/protocol';
import { refusalOf, UNREADABLE, UploadJob, uploadFile, type Transport } from '../src/upload.ts';

/** A hub in memory, as the routes behave (docs/uploads.md); `fail` decides what the next piece meets. */
function fakeHub() {
  const files = new Map<string, { name: string; mime: string; size: number; bytes: Uint8Array }>();
  let n = 0;
  const hub = {
    files,
    puts: 0,
    cancelled: [] as string[],
    /** Before a piece: 'drop' cuts it off halfway, as a lost connection does; a number is the hub's refusal. */
    fail: [] as ('drop' | number)[],
    st(id: string): P.UploadState {
      const f = files.get(id)!;
      return { id, name: f.name, mime: f.mime, size: f.size, received: f.bytes.length };
    },
    transport: {
      async start(name, mime, size) {
        const id = `u${n++}`;
        files.set(id, { name, mime, size, bytes: new Uint8Array(0) });
        return hub.st(id);
      },
      async state(id) {
        if (!files.has(id)) throw Object.assign(new Error('no such upload'), { status: 404 });
        return hub.st(id);
      },
      async put(id, offset, piece, onSent) {
        hub.puts++;
        const f = files.get(id);
        if (!f) throw Object.assign(new Error('no such upload'), { status: 404 });
        if (offset !== f.bytes.length) throw Object.assign(new Error('expected offset'), { status: 409, received: f.bytes.length });
        const bytes = new Uint8Array(await piece.arrayBuffer());
        const what = hub.fail.shift();
        const append = (b: Uint8Array) => (f.bytes = concat(f.bytes, b));
        if (what === 'drop') {
          append(bytes.subarray(0, bytes.length >> 1));
          onSent(bytes.length >> 1);
          throw new TypeError('Cannot reach the hub');
        }
        if (typeof what === 'number') throw Object.assign(new Error(`refused ${what}`), { status: what });
        onSent(bytes.length);
        append(bytes);
        return hub.st(id);
      },
      async cancel(id) {
        hub.cancelled.push(id);
        files.delete(id);
      },
    } satisfies Transport,
  };
  return hub;
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
const blob = (size: number) => new Blob([new Uint8Array(size).map((_, i) => i % 251)]);
const same = async (b: Blob, bytes: Uint8Array) => expect(Buffer.compare(bytes, new Uint8Array(await b.arrayBuffer()))).toBe(0);
const noWait = () => Promise.resolve();

test('a piece at a time, with progress, to the end', async () => {
  const hub = fakeHub();
  const file = blob(UPLOAD_CHUNK * 2 + 10);
  const seen: number[] = [];
  const v = await uploadFile(file, 'a.bin', 'application/octet-stream', { transport: hub.transport, onProgress: (n) => seen.push(n) });
  expect(v).toEqual({ id: 'u0', name: 'a.bin', mime: 'application/octet-stream', size: file.size });
  expect(hub.puts).toBe(3);
  await same(file, hub.files.get('u0')!.bytes);
  expect(seen.at(-1)).toBe(file.size);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
});

test('a dropped connection carries on from what the hub has, not from the start', async () => {
  const hub = fakeHub();
  const file = blob(UPLOAD_CHUNK * 2);
  hub.fail = ['drop', 'drop'];
  const waits: number[] = [];
  await uploadFile(file, 'a', '', { transport: hub.transport, wait: async (ms) => void waits.push(ms) });
  await same(file, hub.files.get('u0')!.bytes);
  // Two drops, two waits, each longer; and only one upload on the hub.
  expect(waits).toEqual([1000, 2000]);
  expect(hub.files.size).toBe(1);
});

test('after a reload it carries on with the id it had', async () => {
  const hub = fakeHub();
  const file = blob(UPLOAD_CHUNK + 100);
  hub.fail = ['drop'];
  let id: string | undefined;
  await uploadFile(file, 'a', '', { transport: hub.transport, retries: 0, onId: (x) => (id = x) }).catch(() => {});
  expect(hub.files.get(id!)!.bytes.length).toBe(UPLOAD_CHUNK >> 1);
  const v = await uploadFile(file, 'a', '', { transport: hub.transport, id });
  expect(v.id).toBe(id!);
  await same(file, hub.files.get(id!)!.bytes);
});

test('the hub having lost it begins again once; a refusal is said at once', async () => {
  const hub = fakeHub();
  // Gone from the hub (a restart without it, or swept): a new one.
  const v = await uploadFile(blob(10), 'a', '', { transport: hub.transport, id: 'gone' });
  expect(v.id).toBe('u0');
  hub.fail = [413];
  const e = await uploadFile(blob(10), 'a', '', { transport: hub.transport, wait: noWait }).catch((e) => e);
  expect(e).toMatchObject({ status: 413, message: 'refused 413' });
});

test('no hub for long: it gives up as the network, so the outbox waits for the hub', async () => {
  const hub = fakeHub();
  hub.fail = ['drop', 'drop', 'drop', 'drop'];
  const e = await uploadFile(blob(100), 'a', '', { transport: hub.transport, retries: 3, wait: noWait }).catch((e) => e);
  expect(e).toBeInstanceOf(TypeError);
});

test('a file that can no longer be read says so, rather than waiting for the hub', async () => {
  const hub = fakeHub();
  const gone = { size: 50, slice: () => ({ size: 50, arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotFoundError')) }) } as unknown as Blob;
  const t: Transport = { ...hub.transport, put: () => Promise.reject(new TypeError('failed')) };
  const e = await uploadFile(gone, 'a', '', { transport: t, wait: noWait }).catch((e) => e);
  expect(e.message).toBe(UNREADABLE);
});

test('a job: cancel stops it and the hub forgets it; a failed one is tried again where it stopped', async () => {
  const hub = fakeHub();
  const slow: Transport = { ...hub.transport, put: (id, o, p, s, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))) };
  const j = new UploadJob(blob(10), 'a', '', { transport: slow });
  await Bun.sleep(5);
  j.cancel();
  expect(j.status.value).toBe('cancelled');
  expect(hub.cancelled).toEqual(['u0']);
  expect(await j.settle().catch((e) => e.name)).toBe('AbortError');

  hub.fail = [503];
  const k = new UploadJob(blob(UPLOAD_CHUNK + 10), 'b', '', { transport: hub.transport, retries: 0, wait: noWait });
  await k.settle().catch(() => {});
  expect(k.progress.value).toMatchObject({ status: 'failed', error: 'refused 503' });
  const v = await k.settle();
  expect(k.status.value).toBe('done');
  expect(v.id).toBe(k.id!);
  expect(hub.files.size).toBe(1);
});

test('a job told it is offline says so', async () => {
  const hub = fakeHub();
  hub.fail = ['drop'];
  const j = new UploadJob(blob(10), 'a', '', { transport: hub.transport, retries: 0 });
  await j.settle().catch(() => {});
  expect(j.progress.value).toMatchObject({ status: 'failed', error: 'Cannot reach the hub', offline: true });
});

test('why a file cannot be sent, the lower limit first', () => {
  const discord = { name: 'Discord', bytes: 10 * 1024 * 1024, files: 10 };
  const ok = { size: 5, readable: true };
  expect(refusalOf(ok, 0, discord)).toBeNull();
  expect(refusalOf({ size: 0, readable: true }, 0, discord)).toBe('Empty file');
  expect(refusalOf({ size: 12 * 1024 * 1024, readable: true }, 0, discord)).toBe('Over Discord’s 10 MB limit (this is 12 MB)');
  expect(refusalOf({ size: 12 * 1024 * 1024, readable: true }, 0, { ...discord, bytes: 100 * 1024 * 1024 }, 10 * 1024 * 1024)).toBe('Over the hub’s 10 MB limit (this is 12 MB)');
  expect(refusalOf({ size: 5, readable: false }, 0, discord)).toBe(UNREADABLE);
  expect(refusalOf(ok, 10, discord)).toBe('Discord takes 10 files at a time');
});

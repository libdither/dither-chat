/** src/upload.ts: pieces and progress, carrying on after a drop or a reload, refusals said, cancel and retry. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { UPLOAD_PIECE } from '@dither-chat/protocol';
import { refusalOf, UNREADABLE, UploadJob, uploadFile, type Packer, type Transport } from '../src/upload.ts';

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
      async put(id, offset, piece) {
        hub.puts++;
        const f = files.get(id);
        if (!f) throw Object.assign(new Error('no such upload'), { status: 404 });
        if (offset !== f.bytes.length) throw Object.assign(new Error('expected offset'), { status: 409, received: f.bytes.length });
        const bytes = new Uint8Array(await piece.arrayBuffer());
        const what = hub.fail.shift();
        const append = (b: Uint8Array) => (f.bytes = concat(f.bytes, b));
        if (what === 'drop') {
          append(bytes.subarray(0, bytes.length >> 1));
          throw new TypeError('Cannot reach the hub');
        }
        if (typeof what === 'number') throw Object.assign(new Error(`refused ${what}`), { status: what });
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
  const file = blob(UPLOAD_PIECE * 2 + 10);
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
  const file = blob(UPLOAD_PIECE * 2);
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
  const file = blob(UPLOAD_PIECE + 100);
  hub.fail = ['drop'];
  let id: string | undefined;
  await uploadFile(file, 'a', '', { transport: hub.transport, retries: 0, onId: (x) => (id = x) }).catch(() => {});
  expect(hub.files.get(id!)!.bytes.length).toBe(UPLOAD_PIECE >> 1);
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
  let putting!: () => void;
  const put = new Promise<void>((r) => (putting = r));
  const slow: Transport = {
    ...hub.transport,
    put: (id, o, p, signal) => (putting(), new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))))),
  };
  const j = new UploadJob(blob(10), 'a', '', { transport: slow });
  await put;
  j.cancel();
  expect(j.status.value).toBe('cancelled');
  expect(hub.cancelled).toEqual(['u0']);
  expect(await j.settle().catch((e) => e.name)).toBe('AbortError');

  hub.fail = [503];
  const k = new UploadJob(blob(UPLOAD_PIECE + 10), 'b', '', { transport: hub.transport, retries: 0, wait: noWait });
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

test('progress is what the hub has said it has: never a piece only handed to the socket', async () => {
  const hub = fakeHub();
  const file = blob(UPLOAD_PIECE * 3);
  hub.fail = ['drop'];
  const seen: number[] = [];
  await uploadFile(file, 'a', '', { transport: hub.transport, wait: noWait, onProgress: (n) => seen.push(n) });
  // After the drop the hub had half a piece; that is what was said, then the rest.
  for (const n of seen) expect([0, UPLOAD_PIECE >> 1, UPLOAD_PIECE, UPLOAD_PIECE + (UPLOAD_PIECE >> 1), UPLOAD_PIECE * 2, UPLOAD_PIECE * 2 + (UPLOAD_PIECE >> 1), UPLOAD_PIECE * 3]).toContain(n);
  expect(seen).toContain(UPLOAD_PIECE >> 1);
});

test("a piece never runs past a photo's next quality stop", async () => {
  const hub = fakeHub();
  const file = blob(UPLOAD_PIECE + 5000);
  const sizes: number[] = [];
  const t: Transport = { ...hub.transport, put: (id, o, p, sig) => (sizes.push(p.size), hub.transport.put(id, o, p, sig)) };
  await uploadFile(file, 'a', 'image/jpeg', { transport: t, stops: [1000, 4000, UPLOAD_PIECE + 5000] });
  expect(sizes).toEqual([1000, 3000, UPLOAD_PIECE, 1000]);
});

test('an upload the hub sent already (410, sent) ends as sent, not begun again', async () => {
  const hub = fakeHub();
  hub.fail = [410];
  const t: Transport = {
    ...hub.transport,
    put: async (id, o, p, sig) => {
      if (hub.fail[0] === 410) throw (hub.fail.shift(), Object.assign(new Error('it was sent as far as it had come'), { status: 410, sent: true }));
      return hub.transport.put(id, o, p, sig);
    },
  };
  const v = await uploadFile(blob(UPLOAD_PIECE * 2), 'a', '', { transport: t });
  expect(v).toMatchObject({ id: 'u0', sent: true });
  expect(hub.files.size).toBe(1);
});

test('back after a lost link, asking how much the hub has: sent already (410) ends it as sent', async () => {
  const hub = fakeHub();
  const t: Transport = {
    ...hub.transport,
    state: async () => {
      throw Object.assign(new Error('it was sent as far as it had come'), { status: 410, sent: true });
    },
  };
  const v = await uploadFile(blob(UPLOAD_PIECE), 'a', '', { transport: t, id: 'u9' });
  expect(v).toMatchObject({ id: 'u9', sent: true });
  expect(hub.files.size).toBe(0);
});

/** A packer that makes every photo "progressive" with stops at 100, 300 and its end, as pack.ts would. */
const fakePacker: Packer = async (f) => ({ blob: f, layers: { ends: [100, 300, f.size - 2], preview: 100 }, stops: [100, 300, f.size] });

test('a photo is packed first, then uploads; the others wait their turn by quality', async () => {
  const hub = fakeHub();
  const order: string[] = [];
  const t: Transport = {
    ...hub.transport,
    put: async (id, o, p, sig) => {
      order.push(`${id}@${o}+${p.size}`);
      // Give the other job its chance to go first: only the turns (upload.ts turn()) keep the order.
      for (let k = 0; k < 10; k++) await Promise.resolve();
      return hub.transport.put(id, o, p, sig);
    },
  };
  const a = new UploadJob(blob(1000), 'a.jpg', 'image/jpeg', { transport: t, packer: fakePacker });
  expect(a.status.value).toBe('packing');
  const b = new UploadJob(blob(1000), 'b.jpg', 'image/jpeg', { transport: t, packer: fakePacker });
  await Promise.all([a.settle(), b.settle()]);
  // Both get their first picture (to 100) before either goes past it, and both reach 300 before either goes on.
  const at = (s: string) => order.indexOf(s);
  expect(Math.max(at('u0@0+100'), at('u1@0+100'))).toBeLessThan(Math.min(at('u0@100+200'), at('u1@100+200')));
  expect(Math.max(at('u0@100+200'), at('u1@100+200'))).toBeLessThan(Math.min(at('u0@300+700'), at('u1@300+700')));
  expect(a.status.value).toBe('done');
});

test('a packed photo uploads the packed bytes, and the outbox is told them', async () => {
  const hub = fakeHub();
  const packedBlob = blob(700);
  const packer: Packer = async () => ({ blob: packedBlob, layers: { ends: [100, 698], preview: 100 }, stops: [100, 700] });
  const j = new UploadJob(blob(1000), 'a.jpg', 'image/jpeg', { transport: hub.transport, packer });
  let told: Blob | undefined;
  j.onPacked = (b) => (told = b);
  const v = await j.settle();
  expect(v.size).toBe(700);
  expect(told).toBe(packedBlob);
  await same(packedBlob, hub.files.get(v.id)!.bytes);
  expect(j.size).toBe(700);
});

test('a job stopped because the hub sent it ends as sent, with no cancel to the hub', async () => {
  const hub = fakeHub();
  let putting!: () => void;
  const put = new Promise<void>((r) => (putting = r));
  const slow: Transport = {
    ...hub.transport,
    put: (id, o, p, signal) => (putting(), new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))))),
  };
  const j = new UploadJob(blob(10), 'a', '', { transport: slow });
  await put;
  j.stop();
  expect(await j.settle()).toMatchObject({ sent: true });
  expect(j.progress.value).toMatchObject({ status: 'done', cut: true });
  expect(hub.cancelled).toEqual([]);
});

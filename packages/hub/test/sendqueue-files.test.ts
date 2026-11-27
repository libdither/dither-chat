/**
 * A send whose files are still coming (sendqueue.ts, docs/uploads.md "A send the hub holds"): its row heads its chat
 * and goes once the last byte is in, or, when the phone stopped, with its progressive pictures cut after their last
 * whole layer, as the setting says. The sends behind it wait with it. Against a real upload folder, a store of its own
 * and a clock of the test's own; the account is a fake that records what it was asked to send.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { jpegLayers } from '@dither-chat/protocol';
import { mediaSigner } from '../src/server.ts';
import { FILES_MAX_MS, SendQueue, type QueueBody } from '../src/sendqueue.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Uploads } from '../src/uploads.ts';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
/** An invented picture (gradients and two shapes), made progressive by jpegtran. */
const photo = new Uint8Array(readFileSync(join(import.meta.dir, '../../protocol/test/fixtures/progressive.jpg')));
const bodyOf = (b: Uint8Array) => new Response(b).body;

function world(settings: P.CutSettings = { afterMs: 60_000, atLeast: 'fair' }) {
  const dir = mkdtempSync(join(tmpdir(), 'sendq-files-'));
  dirs.push(dir);
  let now = 1_700_000_000_000;
  const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };
  const store = new Store(':memory:', mediaSigner('s'));
  const acc: AccountRow = store.createAccount({ network: 'discord', label: 'x', color: '#000', adapter: 'discord' });
  store.ingest(acc, { t: 'hello', network: 'discord', version: '1', capabilities: ['send'], self: { nativeId: 'me', name: 'Me' } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'c', shape: 'group', name: 'Chat' } });
  const conv = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'c'`)!.id;
  const uploads = new Uploads(join(dir, 'uploads'), now);
  /** What the account was asked to send: the words, and the bytes of each file as they were then. */
  const sent: { body: string; bytes: Uint8Array[] }[] = [];
  const deps = {
    send: async (_conv: string, b: { body?: string; attachments?: string[] }) => {
      const files = b.attachments?.length ? uploads.get(b.attachments, now)! : [];
      sent.push({ body: b.body ?? '', bytes: files.map((f) => new Uint8Array(readFileSync(f.path))) });
      return Response.json({ ok: true, accountId: acc.id, messageId: `msg-${sent.length}` });
    },
    watched: () => false,
    broadcast: () => {},
    files: (ids: string[]) => uploads.names(ids),
    dropFiles: (ids: string[]) => uploads.remove(ids),
    clock,
    upload: (id: string) => uploads.state(id),
    idle: (id: string, at: number) => uploads.idle(id, at),
    cuttable: (id: string) => uploads.cuttable(id),
    cut: (id: string) => uploads.cut(id, now),
    cutSettings: () => settings,
  };
  const queue = new SendQueue(store, deps);
  uploads.onWhole = (id) => queue.uploaded(id);
  uploads.sent = (id) => queue.sentUpload(id);
  queue.start();
  const start = (size: number, mime = 'image/jpeg') => uploads.start('p.jpg', mime, size, now).id;
  const put = (id: string, b: Uint8Array, from: number, to: number) => uploads.write(id, from, bodyOf(b.subarray(from, to)), now);
  const send = (clientId: string, b: Partial<QueueBody>) => queue.accept(conv, { clientId, ack: 'hub', ...b });
  return {
    store,
    uploads,
    queue,
    sent,
    start,
    put,
    send,
    /** A picture send that says its files are still coming, as the app sends one. */
    picture: (ids: string[], clientId = 'c1') => send(clientId, { body: 'from the trip', attachments: ids, waitForFiles: true }),
    later: (ms: number) => (now += ms),
    /** A queue of its own on the same store: the hub started again. */
    restarted: () => {
      queue.stop();
      const again = new SendQueue(store, deps);
      uploads.onWhole = (id) => again.uploaded(id);
      again.start();
      return again;
    },
  };
}

describe('a send whose files are still coming', () => {
  test('taken at once, sent when the last byte is in, and a repeat is the same row', async () => {
    const w = world();
    const id = w.start(photo.length);
    await w.put(id, photo, 0, 1000);
    const row = w.picture([id]);
    expect(row).toMatchObject({ state: 'queued', filesComing: true, files: ['p.jpg'] });
    expect(await w.queue.settled('c1')).toMatchObject({ state: 'queued', filesComing: true });
    expect(w.sent).toHaveLength(0);
    await w.put(id, photo, 1000, photo.length);
    expect(await w.queue.settled('c1')).toMatchObject({ state: 'sent', filesComing: false, cut: null, messageId: 'msg-1' });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].bytes[0]).toEqual(photo);
    expect(w.picture([id])).toMatchObject({ state: 'sent' });
    expect(w.sent).toHaveLength(1);
  });

  test('a send behind it in the chat waits for it, and goes right after', async () => {
    const w = world();
    const id = w.start(photo.length);
    await w.put(id, photo, 0, 1000);
    w.picture([id]);
    w.send('t1', { body: 'and this one' });
    expect(await w.queue.settled('t1')).toMatchObject({ state: 'queued' });
    expect(w.sent).toHaveLength(0);
    await w.put(id, photo, 1000, photo.length);
    expect(await w.queue.settled('t1')).toMatchObject({ state: 'sent' });
    expect(w.sent.map((s) => s.body)).toEqual(['from the trip', 'and this one']);
  });

  test('a phone that stopped: after the wait, the picture goes as far as its last whole layer', async () => {
    const w = world({ afterMs: 60_000, atLeast: 'fair' });
    const id = w.start(photo.length);
    const L = jpegLayers(photo)!;
    // Partway into the layer after the one that makes it fair.
    const fair = L.ends.find((e) => e >= photo.length * 0.35)!;
    const next = L.ends[L.ends.indexOf(fair) + 1];
    await w.put(id, photo, 0, Math.floor((fair + next) / 2));
    w.picture([id]);
    w.later(59_000);
    w.queue.filesTick();
    expect(await w.queue.settled('c1')).toMatchObject({ state: 'queued', filesComing: true });
    w.later(2_000);
    w.queue.filesTick();
    expect(await w.queue.settled('c1')).toMatchObject({ state: 'sent', cut: 'fair' });
    const cut = w.sent[0].bytes[0];
    expect(cut.length).toBe(fair + 2);
    expect([...cut.subarray(0, fair)]).toEqual([...photo.subarray(0, fair)]);
    expect([...cut.subarray(-2)]).toEqual([0xff, 0xd9]);
    // Its next piece is told it went, not to begin again.
    await expect(w.put(id, photo, fair + 2, fair + 100)).rejects.toMatchObject({ status: 410, sent: true });
  });

  test('not cut while too little has come for the setting, nor at all when it says never', async () => {
    const w = world({ afterMs: 60_000, atLeast: 'good' });
    const id = w.start(photo.length);
    const L = jpegLayers(photo)!;
    await w.put(id, photo, 0, L.ends.find((e) => e >= photo.length * 0.35)! + 10);
    w.picture([id]);
    w.later(3600_000);
    w.queue.filesTick();
    expect(w.queue.get('c1')).toMatchObject({ state: 'queued', filesComing: true });
    expect(w.uploads.state(id)!.size).toBe(photo.length);

    const never = world({ afterMs: null, atLeast: 'preview' });
    const n = never.start(photo.length);
    await never.put(n, photo, 0, photo.length - 10);
    never.picture([n]);
    never.later(3600_000);
    never.queue.filesTick();
    expect(never.queue.get('c1')).toMatchObject({ state: 'queued', filesComing: true });
    expect(never.sent).toHaveLength(0);
  });

  test('all or none: one file that cannot be cut keeps the message, and the picture beside it, waiting', async () => {
    const w = world({ afterMs: 60_000, atLeast: 'preview' });
    const pic = w.start(photo.length);
    const video = w.start(5000, 'video/mp4');
    await w.put(pic, photo, 0, photo.length - 100);
    await w.put(video, new Uint8Array(5000), 0, 2000);
    w.picture([pic, video]);
    w.later(120_000);
    w.queue.filesTick();
    expect(w.sent).toHaveLength(0);
    // Nothing was cut: the phone can carry on where it was.
    expect(w.uploads.state(pic)).toMatchObject({ size: photo.length, received: photo.length - 100 });
  });

  test('a baseline JPEG, or one with not even its first picture in, is never cut', async () => {
    const base = new Uint8Array(readFileSync(join(import.meta.dir, '../../protocol/test/fixtures/baseline.jpg')));
    const w = world({ afterMs: 60_000, atLeast: 'preview' });
    const a = w.start(base.length);
    await w.put(a, base, 0, base.length - 100);
    w.picture([a], 'a');
    const b = w.start(photo.length);
    await w.put(b, photo, 0, jpegLayers(photo)!.preview! - 1);
    w.picture([b], 'b');
    w.later(120_000);
    w.queue.filesTick();
    expect(w.sent).toHaveLength(0);
  });

  test('a file gone fails it with 410 and what waited behind it goes; one that waits a day fails too', async () => {
    const w = world();
    expect(() => w.picture(['000000000000000000000000'], 'gone')).toThrow(expect.objectContaining({ status: 410 }));
    const id = w.start(photo.length);
    await w.put(id, photo, 0, 100);
    w.picture([id], 'lost');
    w.send('t1', { body: 'after it' });
    w.uploads.remove([id]);
    w.queue.filesTick();
    expect(await w.queue.settled('t1')).toMatchObject({ state: 'sent' });
    expect(w.queue.get('lost')).toMatchObject({ state: 'failed', error: 'that upload has expired, attach the file again' });

    const d = w.start(photo.length);
    await w.put(d, photo, 0, 100);
    w.picture([d], 'long');
    w.later(FILES_MAX_MS + 1);
    w.queue.filesTick();
    expect(w.queue.get('long')).toMatchObject({ state: 'failed', error: 'Its files did not finish uploading within a day' });
  });

  test('without waitForFiles, a file still uploading is refused as before', async () => {
    const w = world();
    const id = w.start(photo.length);
    await w.put(id, photo, 0, 100);
    expect(() => w.send('plain', { body: 'x', attachments: [id] })).toThrow(expect.objectContaining({ status: 410 }));
  });

  test('its files are held from the sweep while it waits', async () => {
    const w = world();
    const id = w.start(photo.length);
    await w.put(id, photo, 0, 100);
    w.picture([id]);
    expect([...w.queue.heldUploads()]).toEqual([id]);
  });

  test('a hub started again still waits for the files, and sends once they are in', async () => {
    const w = world();
    const id = w.start(photo.length);
    await w.put(id, photo, 0, 1000);
    w.picture([id]);
    const again = w.restarted();
    expect(again.get('c1')).toMatchObject({ state: 'queued', filesComing: true });
    await w.put(id, photo, 1000, photo.length);
    expect(await again.settled('c1')).toMatchObject({ state: 'sent' });
    expect(w.sent).toHaveLength(1);
    again.stop();
  });

  test('cancelled while its files come: nothing goes, and what waited behind it does', async () => {
    const w = world();
    const id = w.start(photo.length);
    await w.put(id, photo, 0, 1000);
    w.picture([id]);
    w.send('t1', { body: 'after it' });
    expect(w.queue.act('c1', 'cancel')).toMatchObject({ state: 'cancelled', filesComing: false });
    expect(await w.queue.settled('t1')).toMatchObject({ state: 'sent' });
    expect(w.sent.map((s) => s.body)).toEqual(['after it']);
    expect(w.uploads.state(id)).toBeNull();
  });
});

/**
 * Files to send (docs/uploads.md): streamed to disk under the cap, nothing left of one cut off, pieces resumed at
 * their offset, kept across a restart with the rest swept, and names cleaned.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFileName, KEEP, Uploads } from '../src/uploads.ts';

const root = mkdtempSync(join(tmpdir(), 'dither-uploads-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `u${n++}`);

/** A body that hands over these pieces, then ends, or fails the way a dropped connection does. */
function body(pieces: (string | Uint8Array)[], drop = false): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < pieces.length) {
        const p = pieces[i++];
        return c.enqueue(typeof p === 'string' ? enc.encode(p) : p);
      }
      if (drop) c.error(new Error('connection reset'));
      else c.close();
    },
  });
}
const status = (p: Promise<unknown>) => p.then(() => 0, (e) => e.status ?? 'dropped');
const mode = (p: string) => statSync(p).mode & 0o777;

describe('streamed in one request', () => {
  test('written to disk, private, and handed over by path', async () => {
    const dir = fresh();
    const u = new Uploads(dir);
    const v = await u.receive(body(['hello ', 'world']), 'a.txt', 'text/plain');
    expect(v).toMatchObject({ name: 'a.txt', mime: 'text/plain', size: 11 });
    const [f] = u.get([v.id])!;
    expect(readFileSync(f.path, 'utf8')).toBe('hello world');
    expect(f).toMatchObject({ kind: 'file', size: 11 });
    expect(mode(dir)).toBe(0o700);
    expect(mode(f.path)).toBe(0o600);
    expect(mode(f.path + '.json')).toBe(0o600);
  });
  test('refused as soon as it passes the cap, and nothing kept', async () => {
    const dir = fresh();
    const u = new Uploads(dir);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull: (c) => (pulled++, c.enqueue(new Uint8Array(4))) });
    expect(await status(u.receive(endless, 'big', '', { cap: 10 }))).toBe(413);
    // It stopped reading there: three pieces of four bytes passed ten.
    expect(pulled).toBeLessThan(6);
    expect(readdirSync(dir)).toEqual([]);
  });
  test('a dropped connection leaves no partial file', async () => {
    const dir = fresh();
    const u = new Uploads(dir);
    expect(await status(u.receive(body(['half of it'], true), 'x', ''))).toBe('dropped');
    expect(readdirSync(dir)).toEqual([]);
  });
  test('short of the length the request gave: cut off, and nothing kept', async () => {
    const dir = fresh();
    const u = new Uploads(dir);
    expect(await status(u.receive(body(['only part']), 'x', '', { length: 100 }))).toBe(400);
    expect(readdirSync(dir)).toEqual([]);
    expect((await u.receive(body(['exactly']), 'x', '', { length: 7 })).size).toBe(7);
  });
  test('an empty file is refused', async () => {
    const dir = fresh();
    const u = new Uploads(dir);
    expect(await status(u.receive(body([]), 'x', ''))).toBe(400);
    expect(await status(u.receive(null, 'x', ''))).toBe(400);
    expect(readdirSync(dir)).toEqual([]);
  });
  test('a type that is not one becomes application/octet-stream', async () => {
    const u = new Uploads(fresh());
    expect((await u.receive(body(['x']), 'x', 'text/html; <script>')).mime).toBe('application/octet-stream');
  });
});

describe('a piece at a time', () => {
  test('pieces at their offset; a wrong offset says where to carry on', async () => {
    const u = new Uploads(fresh());
    const s = u.start('p.bin', 'application/octet-stream', 10);
    expect(s).toMatchObject({ size: 10, received: 0 });
    expect(await u.write(s.id, 0, body(['01234']))).toMatchObject({ received: 5 });
    const wrong = await u.write(s.id, 0, body(['01234'])).catch((e) => e);
    expect(wrong).toMatchObject({ status: 409, received: 5 });
    // Not all there yet: it cannot be sent.
    expect(u.get([s.id])).toBeNull();
    expect(await u.write(s.id, 5, body(['56789']))).toMatchObject({ received: 10 });
    expect(readFileSync(u.get([s.id])![0].path, 'utf8')).toBe('0123456789');
  });
  test('a piece cut off keeps what came, and the next carries on from there', async () => {
    const u = new Uploads(fresh());
    const s = u.start('p', '', 8);
    expect(await status(u.write(s.id, 0, body(['abc'], true)))).toBe('dropped');
    expect(u.state(s.id)!.received).toBe(3);
    await u.write(s.id, 3, body(['defgh']));
    expect(readFileSync(u.get([s.id])![0].path, 'utf8')).toBe('abcdefgh');
  });
  test('no more bytes than it said, nothing over the cap, nothing empty', async () => {
    const u = new Uploads(fresh());
    const s = u.start('p', '', 4);
    expect(await status(u.write(s.id, 0, body(['12345'])))).toBe(413);
    expect(u.state(s.id)!.received).toBe(0);
    expect(() => u.start('p', '', 25 * 1024 * 1024 + 1)).toThrow('the hub takes files up to 25 MB');
    expect(() => u.start('p', '', 0)).toThrow('empty file');
    expect(() => u.start('p', '', NaN)).toThrow();
    expect(await status(u.write('0'.repeat(24), 0, body(['x'])))).toBe(404);
  });
  test('cancelled: both files go', async () => {
    const dir = fresh();
    const u = new Uploads(dir);
    const s = u.start('p', '', 4);
    await u.write(s.id, 0, body(['12']));
    u.remove([s.id]);
    expect(readdirSync(dir)).toEqual([]);
    expect(u.state(s.id)).toBeNull();
  });
});

describe('across a restart', () => {
  test('whole and half-made uploads stay; old ones and strays go', async () => {
    const dir = fresh();
    const t0 = 1_000_000_000_000;
    const a = new Uploads(dir, t0);
    const whole = a.put(new TextEncoder().encode('kept'), 'whole.txt', 'text/plain', t0);
    const half = a.start('half.bin', '', 6, t0);
    await a.write(half.id, 0, body(['abc']), t0);
    const old = a.put(new TextEncoder().encode('old'), 'old.txt', 'text/plain', t0 - KEEP - 1);
    // What a crash can leave: a stream cut off before its record, a record half-written, one that is not JSON.
    writeFileSync(join(dir, 'a'.repeat(24)), 'no record');
    writeFileSync(join(dir, `${whole.id}.json.tmp`), '{');
    writeFileSync(join(dir, `${'b'.repeat(24)}.json`), 'not json');
    writeFileSync(join(dir, `${'b'.repeat(24)}`), 'x');
    writeFileSync(join(dir, 'stray'), 'x');

    const b = new Uploads(dir, t0 + 60_000);
    expect(readdirSync(dir).sort()).toEqual([whole.id, `${whole.id}.json`, half.id, `${half.id}.json`].sort());
    expect(b.state(old.id)).toBeNull();
    const [f] = b.get([whole.id])!;
    expect(f).toMatchObject({ name: 'whole.txt', mime: 'text/plain', size: 4, kind: 'file' });
    expect(readFileSync(f.path, 'utf8')).toBe('kept');
    // The half-made one carries on where it was.
    expect(b.state(half.id)).toMatchObject({ name: 'half.bin', size: 6, received: 3 });
    await b.write(half.id, 3, body(['def']));
    expect(readFileSync(b.get([half.id])![0].path, 'utf8')).toBe('abcdef');
    // Sent: deleted, records too.
    b.remove([whole.id, half.id]);
    expect(readdirSync(dir)).toEqual([]);
  });
  test('used counts from the last piece or send, not from when it began', async () => {
    const dir = fresh();
    const t0 = 2_000_000_000_000;
    const a = new Uploads(dir, t0);
    const s = a.start('slow', '', 2, t0);
    await a.write(s.id, 0, body(['1']), t0 + KEEP - 1000);
    expect(new Uploads(dir, t0 + KEEP + 1000).state(s.id)).toMatchObject({ received: 1 });
    expect(new Uploads(dir, t0 + 2 * KEEP).state(s.id)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
  test('swept after an hour unused while running', () => {
    const dir = fresh();
    const u = new Uploads(dir, 0);
    const v = u.put(new Uint8Array([1]), 'x', '', 0);
    u.sweep(KEEP / 2);
    expect(u.state(v.id)).not.toBeNull();
    u.sweep(KEEP + 1);
    expect(u.state(v.id)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('names', () => {
  test('cleaned to a name, never a path', () => {
    expect(cleanFileName('a%20b.png')).toBe('a b.png');
    expect(cleanFileName('..%2F..%2Fetc%2Fpasswd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\me\\photo.jpg')).toBe('photo.jpg');
    expect(cleanFileName('bad\u0000\u001fname\u007f.txt')).toBe('badname.txt');
    expect(cleanFileName('..')).toBe('file');
    expect(cleanFileName('  ')).toBe('file');
    expect(cleanFileName(null)).toBe('file');
    expect(cleanFileName('100%.txt')).toBe('100%.txt');
    // From JSON it is taken as it is: no decoding.
    expect(cleanFileName('50%20off.pdf', false)).toBe('50%20off.pdf');
    expect(cleanFileName('a/../b.txt', false)).toBe('b.txt');
    // Too long: the end is kept, extension and all.
    const long = cleanFileName('x'.repeat(300) + '.tar.gz');
    expect(long.length).toBe(200);
    expect(long.endsWith('.tar.gz')).toBe(true);
  });
});

/**
 * A push's pictures go into the media cache before the push (server.ts warm, main.ts deliver): the phone waits only
 * seconds for them while it draws the notification, so it should find them there.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-warm-'));
const sign = mediaSigner('s');
const asked: string[] = [];
let store: Store;
let hub: HubServer;

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), sign);
  const sup = {
    authorize: () => null,
    online: () => true,
    command: async (_a: string, c: any) => {
      asked.push(c.url);
      if (c.url === 'mxc://x/slow') await new Promise((r) => setTimeout(r, 2000));
      return { mime: 'image/png', base64: Buffer.from('pic').toString('base64') };
    },
  } as any;
  hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cached = (raw: string) => existsSync(join(dir, 'media-cache', new Bun.CryptoHasher('sha256').update(raw).digest('hex')));

test('fetches each signed picture once into the cache, and leaves alone what it did not sign', async () => {
  const a = sign('mxc://x/a', 'acc_1')!;
  await hub.warm([a, a, sign('mxc://x/b', 'acc_1'), 'data:image/png;base64,AA', undefined, `/media/forged/${Buffer.from('mxc://x/c').toString('base64url')}?a=acc_1`]);
  expect(cached('mxc://x/a')).toBe(true);
  expect(cached('mxc://x/b')).toBe(true);
  expect(asked.filter((u) => u === 'mxc://x/a')).toHaveLength(1);
  expect(asked).not.toContain('mxc://x/c');
});

test('waits no longer than it was given', async () => {
  const t = Date.now();
  await hub.warm([sign('mxc://x/slow', 'acc_1')], 100);
  expect(Date.now() - t).toBeLessThan(1000);
  expect(cached('mxc://x/slow')).toBe(false);
});

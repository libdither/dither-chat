/**
 * What a hub runs in the background starts in start() and ends in stop(), so nothing reads a store after it closed.
 * The profile collector's timer once started as the hub was built: test files that built a hub, never started it and
 * closed its store left a timer reading a closed database, which failed tests in other files on a slow machine.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

let dir: string;
let store: Store;
let reads = 0;

const sup = { authorize: () => null, online: () => false } as any;
const build = () => new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, open: true, secret: 's' });

beforeEach(() => {
  jest.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'dither-lifetime-'));
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  reads = 0;
  // Every collector step reads the retention switches first.
  store.retention = () => {
    reads++;
    throw new Error('read after the store closed');
  };
});
afterEach(() => {
  jest.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

test('a hub built and never started reads nothing once its store closes', () => {
  build();
  store.db.close();
  jest.advanceTimersByTime(5 * 60_000);
  expect(reads).toBe(0);
});

test('a hub started and stopped reads nothing once its store closes', () => {
  const hub = build();
  hub.start();
  hub.stop();
  store.db.close();
  jest.advanceTimersByTime(5 * 60_000);
  expect(reads).toBe(0);
});

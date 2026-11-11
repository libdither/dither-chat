/** PUT /api/retention: only what is sent changes, turning off is confirmed, each chat has its say (docs/history.md). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION, showsGone } from '@dither-chat/protocol';
import { HubServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-retention-'));
let store: Store;
let hub: HubServer;
let port = 0;
const put = async (body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/retention`, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'user-agent': 'test phone' } });
  return { status: r.status, json: (await r.json()) as P.RetentionSettings & { error?: string } };
};

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'));
  store.setRetention({ ...DEFAULT_RETENTION, adversarial: true, deleted: true, disappearing: true, presence: true });
  hub = new HubServer(store, { authorize: () => null, online: () => false } as any, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
  port = hub.start().port!;
});
afterAll(() => {
  hub.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('PUT /api/retention', () => {
  test('a device sending one field changes that field alone', async () => {
    const r = await put({ edits: false });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ edits: false, adversarial: true, deleted: true, disappearing: true, presence: true });
  });

  test('turning off what keeps or shows kept things is refused unless confirmed', async () => {
    // A device that never loaded the settings and sends the defaults back whole.
    const stale = await put({ ...DEFAULT_RETENTION });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toContain('confirm');
    expect(store.retention()).toMatchObject({ adversarial: true, deleted: true, disappearing: true, presence: true });
    const hidden = await put({ adversarial: false, confirm: true });
    expect(hidden.status).toBe(200);
    // Hiding keeps the switches: nothing stops being kept.
    expect(hidden.json).toMatchObject({ adversarial: false, deleted: true, disappearing: true });
    // Kept messages are served with their words again: devices' kept copies are void (a new journal epoch).
    const epoch = store.journal.position().epoch;
    expect((await put({ adversarial: true })).status).toBe(200);
    expect(store.journal.position().epoch).not.toBe(epoch);
    const same = store.journal.position().epoch;
    expect((await put({ show: 'hidden' })).status).toBe(200);
    expect(store.journal.position().epoch).toBe(same);
    await put({ show: 'shown' });
  });

  test('each change is logged with the device that made it', async () => {
    const log = store.retentionLog();
    expect(log.findLast((c) => 'adversarial' in c.changed)).toMatchObject({ by: 'test phone', changed: { adversarial: [false, true] } });
    const r = await fetch(`http://127.0.0.1:${port}/api/retention/log`);
    expect(((await r.json()) as { changes: P.RetentionChange[] }).changes.length).toBe(log.length);
  });

  test('shown or hidden, everywhere and in one chat', async () => {
    expect((await put({ show: 'collapsed' })).json.show).toBe('shown');
    let r = (await put({ showIn: { cnv_a: 'hidden', 'bad id!': 'hidden' } })).json;
    expect(r.showIn).toEqual({ cnv_a: 'hidden' });
    expect([showsGone(r, 'cnv_a'), showsGone(r, 'cnv_b')]).toEqual([false, true]);
    r = (await put({ show: 'hidden', showIn: { cnv_b: 'shown' } })).json;
    expect([showsGone(r, 'cnv_a'), showsGone(r, 'cnv_b'), showsGone(r, 'cnv_c')]).toEqual([false, true, false]);
    r = (await put({ showIn: { cnv_a: null } })).json;
    expect(r.showIn).toEqual({ cnv_b: 'shown' });
    expect(showsGone({ ...r, adversarial: false }, 'cnv_b')).toBe(false);
  });
});

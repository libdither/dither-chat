/**
 * The hub started on a database an older hub left (test/fixtures/old-db, made by scripts/old-db-fixture.ts): it copies
 * the database aside, migrates, says it is ready, and what the old hub stored reads back through the API. One fixture
 * per schema era; a new era gets one when its migration matters.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.ts';
import { freePorts } from './fixtures/port.ts';

const fixtures = join(import.meta.dir, 'fixtures/old-db');
const main = resolve(import.meta.dir, '../src/main.ts');

interface Fixture {
  commit: string;
  committed: string;
  schemaSig: string | null;
  counts: Record<string, number>;
  marker: { conversationId: string; messageId: string; word: string; reaction: string };
}

/** The schema signature a hub of this tree writes. */
function currentSig(): string {
  const s = new Store(':memory:', () => null);
  return (s.db.query(`SELECT value FROM meta WHERE key = 'schema_sig'`).get() as { value: string }).value;
}

async function within<T>(ms: number, what: string, fn: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(what);
    await Bun.sleep(100);
  }
}

for (const name of readdirSync(fixtures).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()) {
  const fx = JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')) as Fixture;

  describe(`a database from ${fx.committed.slice(0, 10)} (${fx.commit.slice(0, 12)})`, () => {
    test('migrates, gets to ready, and reads back what the old hub stored', async () => {
      const work = mkdtempSync(join(tmpdir(), 'dither-old-db-test-'));
      const data = join(work, 'data');
      mkdirSync(data, { mode: 0o700 });
      writeFileSync(join(data, 'hub.sqlite'), Bun.gunzipSync(readFileSync(join(fixtures, `${name}.sqlite.gz`))), { mode: 0o600 });
      const [port] = freePorts();
      const base = `http://127.0.0.1:${port}`;
      // None of the caller's hub settings (a manager's address, a model): a demo hub on the fixture alone.
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DITHER_')));
      const hub = Bun.spawn(['bun', main, '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', '--web', join(work, 'no-web')], {
        env: { ...env, DITHER_DEMO_CHATTER: '0', DITHER_CATEGORY_MODEL: 'keyword' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      let log = '';
      const read = async (s: ReadableStream<Uint8Array>) => {
        for await (const chunk of s) log += new TextDecoder().decode(chunk);
      };
      const reading = Promise.all([read(hub.stdout), read(hub.stderr)]);
      const json = async (path: string) => {
        const r = await fetch(base + path);
        if (!r.ok) throw new Error(`${path}: ${r.status}`);
        return r.json() as Promise<any>;
      };
      try {
        await within(30_000, `no ready line:\n${log}`, async () => hub.exitCode === null && /startup: ready in/.test(log));
        const ready = log.split('\n').find((l) => l.startsWith('startup: ready in'))!;
        expect(ready).toContain('migrations');
        // A schema it had not met: copied aside first.
        expect(ready).toContain('pre-migrate copy');
        expect(readdirSync(join(data, 'backups')).some((f) => /^pre-migrate-.*\.sqlite$/.test(f))).toBe(true);
        expect((await json('/api/health')).ok).toBe(true);

        const boot = await json('/api/bootstrap');
        expect(boot.accounts.length).toBeGreaterThanOrEqual(fx.counts.accounts);
        expect(boot.conversations.some((c: any) => c.id === fx.marker.conversationId)).toBe(true);
        // The message the old hub sent and reacted to, under the same id, with its reaction.
        const { messages } = await json(`/api/conversations/${fx.marker.conversationId}/messages?limit=200`);
        const m = messages.find((x: any) => x.id === fx.marker.messageId);
        expect(m?.body).toContain(fx.marker.word);
        expect(JSON.stringify(m?.reactions ?? [])).toContain(fx.marker.reaction);
        // Full-text search over the old rows.
        const found = await json(`/api/search?q=${encodeURIComponent(fx.marker.word)}`);
        expect(found.hits.map((h: any) => h.message.id)).toContain(fx.marker.messageId);
        expect(log).not.toMatch(/uncaught exception|unhandled rejection/);
      } finally {
        hub.kill('SIGTERM');
        await hub.exited;
        await reading;
      }
      expect(hub.exitCode).toBe(0);
      const db = new Database(join(data, 'hub.sqlite'), { readonly: true });
      try {
        expect((db.query(`SELECT value FROM meta WHERE key = 'schema_sig'`).get() as { value: string }).value).toBe(currentSig());
        expect((db.query('SELECT count(*) AS n FROM message').get() as { n: number }).n).toBeGreaterThanOrEqual(fx.counts.messages);
      } finally {
        db.close();
        rmSync(work, { recursive: true, force: true });
      }
    }, 60_000);
  });
}

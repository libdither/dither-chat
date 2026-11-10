/**
 * A demo world's database as an older hub left it, for the hub's start-on-an-old-database test
 * (packages/hub/test/old-database.test.ts).
 *
 *   bun scripts/old-db-fixture.ts <commit> <name> [--port 8982]
 *
 * Checks the commit out into a temp worktree, runs its demo hub on a fresh data dir, writes a few things through its
 * API (a message of its own, a reaction to it, the conversation read), stops it cleanly, and keeps the database,
 * vacuumed and gzipped, as packages/hub/test/fixtures/old-db/<name>.sqlite.gz with <name>.json saying what is in it. Demo data only:
 * it refuses to write a fixture that holds anything that looks like a real id or a token (--keep-bad leaves it at
 * <name>.rejected.sqlite to look at). The worktree goes afterwards.
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const [commit, name] = args;
if (!commit || !name) throw new Error('usage: bun scripts/old-db-fixture.ts <commit> <name> [--port 8982]');
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : '8982');
const root = resolve(import.meta.dir, '..');
const outDir = join(root, 'packages/hub/test/fixtures/old-db');
const base = `http://127.0.0.1:${port}`;

const run = (cmd: string[], cwd = root) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const sha = run(['git', 'rev-parse', commit]);
const date = run(['git', 'show', '-s', '--format=%cI', sha]);
const work = mkdtempSync(join(tmpdir(), 'dither-old-db-'));
const tree = join(work, 'tree');
const data = join(work, 'data');
let hub: ReturnType<typeof Bun.spawn> | undefined;

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(250);
  }
  throw new Error(what);
}
/** The commit's demo world and protocol source: the ids, numbers and names a demo hub can hold come from there. */
function demoSource(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.tsx?$/.test(e.name)) out.push(readFileSync(join(d, e.name), 'utf8'));
    }
  };
  for (const d of ['packages/hub/src', 'packages/protocol/src']) walk(join(dir, d));
  return out.join('\n');
}

/**
 * Anything in the database that did not come from the demo world: this machine's name, its user, home paths, tailnet
 * names and addresses, tokens, and phone numbers, Matrix ids or names its source does not have. Value by value, every
 * column of every table but the search index (made from message bodies). Discord-shaped ids are the demo's own (snow() in demo.ts hashes a key into
 * one): every account is a demo account whose adapter runs in process and reaches no network.
 */
function scan(db: Database, source: string): string[] {
  const own = (x: string) => source.includes(x) || source.includes(x.replace(/^[^\w]+/, ''));
  // This machine's name, its user and tailnet names: read here, so no name is written in this file.
  const names = [hostname().split('.')[0], userInfo().username, 'ts.net'].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const local = new RegExp(`[\\w@:./-]*(?:${names.join('|')})[\\w@:./-]*`, 'gi');
  const found: string[] = [];
  const tables = (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%'`).all() as { name: string }[]).map((r) => r.name);
  for (const t of tables) {
    for (const row of db.query(`SELECT * FROM "${t}"`).values()) {
      for (const v of row) {
        if (v === null || typeof v === 'number' || typeof v === 'bigint') continue;
        const text = typeof v === 'string' ? v : Buffer.from(v as Uint8Array).toString('latin1');
        const hits = [
          ...(text.match(/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g) ?? []),
          ...(text.match(/\/home\/[\w.-]+/g) ?? []),
          ...(text.match(/\b(?:mfa\.|xox[bp]-|ghp_|gho_|eyJ)[\w-]{20,}/g) ?? []),
          ...(text.match(/[A-Za-z\d_-]{24,26}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/g) ?? []),
          ...[
            ...(text.match(local) ?? []),
            ...(text.match(/\+\d{10,15}/g) ?? []),
            ...(text.match(/@[\w.-]+:[\w.-]+\.[a-z]{2,}/g) ?? []),
          ].filter((x) => !own(x)),
        ];
        for (const h of hits) found.push(`${t}: ${h}`);
      }
    }
  }
  return found;
}

const json = async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', origin: base, ...init?.headers } });
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};

try {
  if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${port}`);
  run(['git', 'worktree', 'add', '--detach', tree, sha]);
  run(['bun', 'install', '--frozen-lockfile'], tree);
  mkdirSync(data, { mode: 0o700 });
  // The demo's chatter waits 45 s before its first line (and is off where DITHER_DEMO_CHATTER is known).
  hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', '--web', join(work, 'no-web')], {
    cwd: tree,
    env: { ...process.env, DITHER_DEMO_CHATTER: '0', DITHER_CATEGORY_MODEL: 'keyword' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await until(async () => (await fetch(`${base}/api/health`)).ok, 30_000, 'the old hub did not start');
  const boot = await until(async () => {
    const b = await json('/api/bootstrap');
    return b.accounts.length && b.accounts.every((a: any) => a.status === 'online') ? b : null;
  }, 30_000, 'demo accounts not online');
  if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
  // Then until the world has stopped arriving.
  let seq = -1;
  let still = Date.now();
  while (Date.now() - still < 3000) {
    await Bun.sleep(500);
    const b = await json('/api/bootstrap');
    const now = b.sync?.seq ?? b.conversations.length;
    if (now !== seq) (seq = now), (still = Date.now());
  }

  // Something this hub wrote, beyond the demo world it brings in on every start.
  const conv = boot.conversations.find((c: any) => c.network === 'signal' && c.name === 'Family') ?? boot.conversations.find((c: any) => c.kind === 'dm');
  if (!conv) throw new Error('no conversation to write in');
  const marker = `oldfixture${name.replace(/[^a-z0-9]/gi, '')}`;
  await json(`/api/conversations/${conv.id}/send`, { method: 'POST', body: JSON.stringify({ body: `${marker} written by ${sha.slice(0, 12)}` }) });
  const msg = await until(async () => (await json(`/api/conversations/${conv.id}/messages?limit=20`)).messages.find((m: any) => m.body?.includes(marker)), 10_000, 'the sent message did not come back');
  await json(`/api/messages/${msg.id}/react`, { method: 'POST', body: JSON.stringify({ key: '👍' }) });
  await until(async () => (await json(`/api/conversations/${conv.id}/messages?limit=20`)).messages.find((m: any) => m.id === msg.id && m.reactions?.length), 10_000, 'the reaction did not come back');
  await json(`/api/conversations/${conv.id}/read`, { method: 'POST', body: JSON.stringify({}) });

  hub.kill('SIGTERM');
  const code = await hub.exited;
  hub = undefined;
  if (code !== 0) throw new Error(`the old hub stopped with ${code}`);

  // Vacuumed from a read-only connection, as anything else that copies a hub's database does; checked before it is kept.
  const made = join(work, 'fixture.sqlite');
  const src = new Database(join(data, 'hub.sqlite'), { readonly: true });
  src.exec(`VACUUM INTO '${made.replace(/'/g, "''")}'`);
  src.close();
  const db = new Database(made, { readonly: true });
  const count = (t: string) => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  const tables = (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  const meta = Object.fromEntries((db.query('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const others = count(`account WHERE id NOT LIKE 'acc_demo-%'`);
  const leaks = scan(db, demoSource(tree));
  const counts = { accounts: count('account'), conversations: count('conversation'), identities: count('identity'), messages: count('message'), reactions: count('reaction') };
  db.close();
  if ((others || leaks.length) && args.includes('--keep-bad')) copyFileSync(made, join(root, `${name}.rejected.sqlite`));
  if (others || leaks.length) throw new Error(`not demo-only: ${others} other accounts; ${JSON.stringify(leaks.slice(0, 10))}`);
  mkdirSync(outDir, { recursive: true });
  // Gzipped: most of a small database is empty pages, a seventh of the size.
  const file = join(outDir, `${name}.sqlite.gz`);
  writeFileSync(file, Bun.gzipSync(readFileSync(made), { level: 9 }));
  const info = {
    note: 'bun scripts/old-db-fixture.ts (packages/hub/test/old-database.test.ts). A demo world as this hub left it.',
    commit: sha,
    committed: date,
    schemaSig: meta.schema_sig ?? null,
    tables,
    counts,
    marker: { conversationId: conv.id, conversationName: conv.name, messageId: msg.id, word: marker, reaction: '👍' },
  };
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(info, null, 1) + '\n');
  console.log(`wrote ${file} (${Bun.file(file).size} bytes)`, JSON.stringify(info.counts));
} finally {
  if (hub) {
    hub.kill('SIGTERM');
    await hub.exited;
  }
  Bun.spawnSync(['git', 'worktree', 'remove', '--force', tree], { cwd: root });
  rmSync(work, { recursive: true, force: true });
}

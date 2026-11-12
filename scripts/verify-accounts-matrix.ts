/**
 * Moving an account to dither-accounts and back, end to end, with the Matrix testbed (docs/accounts.md):
 *
 *   1. a fresh hub runs a testbed Matrix account itself; a message arrives
 *   2. the hub stops; the account is imported into a fresh manager in place (cli.ts import-dither-chat)
 *   3. the hub starts with DITHER_ACCOUNTS_URL; its requests are approved; the account is remote: a message arrives
 *      through the manager, and one sent from the hub reaches the homeserver
 *   4. the hub restarts; a message sent while it was away arrives (the manager held it)
 *   5. rollback: hub and manager stop, the hub starts without DITHER_ACCOUNTS_URL, and runs the account itself again
 *
 *   bun scripts/verify-accounts-matrix.ts [--keep]
 *
 * Everything is fresh under /tmp (the testbed on port 6199, the hub on 8494, the manager on 8482) and deleted after
 * unless --keep. Needs dither-accounts beside this repo (or DITHER_ACCOUNTS_REPO). Never touches a real account.
 */
import type { Subprocess } from 'bun';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const ACC = process.env.DITHER_ACCOUNTS_REPO ?? resolve(REPO, '../dither-accounts');
const T = mkdtempSync('/tmp/dacc-e2e-');
const TB = join(T, 'tb');
const HUB_DATA = join(T, 'hub');
const MGR_DATA = join(T, 'mgr');
const WEB = join(T, 'web');
const HUB = 'http://127.0.0.1:8494';
const MGR = 'http://127.0.0.1:8482';
const tbEnv = { ...process.env, DITHER_TESTBED_DIR: TB, DITHER_TESTBED_PORT: '6199' };
const keep = process.argv.includes('--keep');
const tag = Math.random().toString(36).slice(2, 8);
mkdirSync(WEB, { recursive: true });
mkdirSync(MGR_DATA, { recursive: true });

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const until = async (f: () => Promise<boolean> | boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await f()) return true;
    } catch {}
    await Bun.sleep(300);
  }
  console.log(`     (gave up waiting for ${what})`);
  return false;
};
const get = async (base: string, path: string) => (await fetch(base + path)).json() as Promise<any>;
const post = (base: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
const testbed = (...args: string[]) => {
  const r = Bun.spawnSync(['bun', join(ACC, 'extractors/matrix/testbed/testbed.ts'), ...args], { env: tbEnv, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`testbed ${args[0]}: ${r.stderr.toString().slice(-400)}`);
  return r.stdout.toString();
};
const spawn = (cmd: string[], env: Record<string, string | undefined>, log: string): Subprocess =>
  Bun.spawn(cmd, { cwd: REPO, env: env as any, stdout: Bun.file(join(T, log)), stderr: Bun.file(join(T, `${log}.err`)) });
const stopProc = async (p: Subprocess | null) => {
  if (!p || p.exitCode !== null) return;
  p.kill('SIGTERM');
  const killer = setTimeout(() => p.kill('SIGKILL'), 15_000);
  await p.exited;
  clearTimeout(killer);
};
const hubEnv = (remote: boolean) => {
  // DITHER_CALENDAR_URL=off: a hub that is not a demo would otherwise hold the live calendar's stream (docs/calendar.md).
  const e: Record<string, string | undefined> = { ...process.env, DITHER_DATA: undefined, DITHER_PORT: undefined, DITHER_PUBLIC_URL: undefined, DITHER_CALENDAR_URL: 'off' };
  if (remote) e.DITHER_ACCOUNTS_URL = MGR;
  else delete e.DITHER_ACCOUNTS_URL;
  return e;
};
const startHub = async (remote: boolean) => {
  const p = spawn(['bun', 'packages/hub/src/main.ts', '--data', HUB_DATA, '--port', '8494', '--host', '127.0.0.1', '--web', WEB], hubEnv(remote), `hub-${Date.now()}.log`);
  await until(async () => (await fetch(`${HUB}/api/health`)).ok, 20_000, 'the hub');
  return p;
};
const account = async (id: string) => (await get(HUB, '/api/bootstrap')).accounts.find((a: any) => a.id === id);
const found = async (text: string) => (await get(HUB, `/api/search?q=${encodeURIComponent(text)}`)).hits.length > 0;

let hub: Subprocess | null = null;
let mgr: Subprocess | null = null;
try {
  console.log(`     workdir ${T}`);
  testbed('up');
  const tb = JSON.parse(readFileSync(join(TB, 'testbed.json'), 'utf8'));
  const general = tb.rooms.general as string;
  check(!!general && tb.users?.zyan?.password, 'the testbed is up with its rooms and users');

  // 1. The hub runs the account itself.
  hub = await startHub(false);
  const added = await (await post(HUB, '/api/accounts', { network: 'matrix', label: 'testbed', config: { homeserver: tb.baseUrl }, secret: { userId: tb.users.zyan.userId, password: tb.users.zyan.password } })).json();
  const id = added.id as string;
  check(!!id, 'added a testbed Matrix account to a fresh hub', id);
  check(await until(async () => (await account(id))?.status === 'online', 60_000, 'online'), 'it runs here and is online');
  testbed('say', 'alice', 'general', `local${tag} from alice`);
  check(await until(() => found(`local${tag}`), 30_000, 'the local message'), 'a message arrives while the hub runs it');
  await stopProc(hub);
  hub = null;

  // 2. Into a fresh manager, in place.
  mgr = spawn(['bun', join(ACC, 'packages/manager/src/main.ts'), '--data', MGR_DATA, '--port', '8482', '--host', '127.0.0.1'], { ...process.env }, 'manager.log');
  await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager');
  const imp = Bun.spawnSync(['bun', join(ACC, 'packages/manager/src/cli.ts'), 'import-dither-chat', '--hub-data', HUB_DATA, '--accounts', id, '--url', MGR], { stdout: 'pipe', stderr: 'pipe' });
  console.log(imp.stdout.toString().trim().replace(/^/gm, '     | '));
  check(imp.exitCode === 0, 'import-dither-chat registered it in place');
  check(await until(async () => (await get(MGR, '/api/state')).accounts.find((a: any) => a.id === id)?.online, 60_000, 'the manager running it'), 'the manager runs it on the same session directory', (await get(MGR, '/api/state')).accounts.find((a: any) => a.id === id)?.dir);

  // 3. The hub as an app.
  hub = await startHub(true);
  await until(async () => (await get(MGR, '/api/state')).apps.some((a: any) => a.name === 'dither-chat'), 10_000, 'the hub registered');
  const st = await get(MGR, '/api/state');
  const app = st.apps.find((a: any) => a.name === 'dither-chat');
  for (const r of app.requests.filter((r: any) => r.state === 'pending')) await fetch(`${MGR}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  check(app.requests.length === 2, 'the hub asked for chat and for managing its account kinds', app.requests.map((r: any) => `${r.interface}:${r.level}`));
  check(await until(async () => (await account(id))?.status === 'online', 30_000, 'remote online'), 'the account is online in the hub, through the manager');
  check(!Bun.spawnSync(['ps', '-eo', 'args']).stdout.toString().includes(join(REPO, 'packages/adapter-matrix/src/main.ts')), 'the hub runs no Matrix adapter of its own');
  testbed('say', 'alice', 'general', `remotein${tag} from alice`);
  check(await until(() => found(`remotein${tag}`), 30_000, 'the remote message'), 'a message arrives through the manager');
  const conv = (await get(HUB, '/api/bootstrap')).conversations.find((c: any) => c.nativeId === general);
  const sent = await post(HUB, `/api/conversations/${conv.id}/send`, { body: `remoteout${tag} from the hub` });
  check(sent.ok, 'the hub sent a message', sent.status);
  check(await until(() => testbed('tail', 'general', '10').includes(`remoteout${tag}`), 30_000, 'the sent message on the homeserver'), 'it reached the homeserver through the manager');

  // 4. The hub restarts; what came meanwhile waited in the manager.
  await stopProc(hub);
  hub = null;
  testbed('say', 'alice', 'general', `away${tag} while the hub was down`);
  await Bun.sleep(3000);
  hub = await startHub(true);
  check(await until(() => found(`away${tag}`), 30_000, 'the held message'), 'a message sent while the hub was away arrives after it restarts');

  // 5. Rollback: no manager, no DITHER_ACCOUNTS_URL.
  await stopProc(hub);
  hub = null;
  await stopProc(mgr);
  mgr = null;
  hub = await startHub(false);
  check(await until(async () => (await account(id))?.status === 'online', 60_000, 'local again'), 'rollback: the hub runs the account itself again');
  testbed('say', 'alice', 'general', `back${tag} after rollback`);
  check(await until(() => found(`back${tag}`), 30_000, 'the rollback message'), 'and messages arrive');
} catch (e) {
  check(false, 'the run', String((e as Error)?.stack ?? e));
} finally {
  await stopProc(hub);
  await stopProc(mgr);
  try {
    testbed('stop');
  } catch {}
  if (!keep) rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);

export {};
/**
 * The hub's CLI.
 *
 * The login (docs/login.md), on the hub's data dir; these work whether the hub runs or not:
 *
 *   bun packages/hub/src/cli.ts set-password [--file F]   # the password from F, or stdin (typed twice on a terminal)
 *   bun packages/hub/src/cli.ts sessions                  # the signed-in devices
 *   bun packages/hub/src/cli.ts revoke-sessions [id]      # sign out one device, or every one
 *   bun packages/hub/src/cli.ts token [--rotate]          # where the service token is; --rotate makes a new one
 *
 * Over the hub's HTTP API (the hub must be running; they send the service token):
 *
 *   bun packages/hub/src/cli.ts accounts
 *   bun packages/hub/src/cli.ts add <network> [--label L] [--adapter A] [--config JSON] [--secret JSON]
 *   bun packages/hub/src/cli.ts remove <accountId>
 *   bun packages/hub/src/cli.ts action <accountId> <action> [argsJSON]
 *   bun packages/hub/src/cli.ts log <accountId>
 *
 * --data <dir> (or DITHER_DATA) is the hub's data dir: default ~/.local/share/dither-chat when it exists, else the
 * repo's .data. --hub http://127.0.0.1:8460 (or DITHER_HUB) picks the hub.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ensureToken, listSessions, MIN_PASSWORD, openAuthDb, readPassword, setPassword, TOKEN_FILE } from './auth.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const hub = opt('hub') ?? process.env.DITHER_HUB ?? 'http://127.0.0.1:8460';
const shared = join(homedir(), '.local/share/dither-chat');
const dataDir = resolve(opt('data') ?? process.env.DITHER_DATA ?? (existsSync(shared) ? shared : join(import.meta.dir, '../../../.data')));
const label = opt('label');
const adapter = opt('adapter');
const config = opt('config');
const secret = opt('secret');
const file = opt('file');
const rotate = flag('rotate');
const [cmd, a, b, c] = args;

const token = () => {
  try {
    return readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim();
  } catch {
    return '';
  }
};

const call = async (method: string, path: string, body?: unknown) => {
  const t = token();
  const res = await fetch(hub + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) } });
  const text = await res.text();
  if (res.status === 401) throw new Error(`401: the hub did not take the token in ${join(dataDir, TOKEN_FILE)} (pass --data <the hub's data dir>)`);
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A line from stdin; on a terminal, typed without echo. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).replace(/\r?\n$/, '');
  process.stdout.write(prompt);
  Bun.spawnSync(['stty', '-echo'], { stdin: 'inherit' });
  try {
    const rl = createInterface({ input: process.stdin });
    const line = await new Promise<string>((r) => rl.once('line', r));
    rl.close();
    return line;
  } finally {
    Bun.spawnSync(['stty', 'echo'], { stdin: 'inherit' });
    process.stdout.write('\n');
  }
}

const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

switch (cmd) {
  case 'set-password': {
    if (!existsSync(dataDir)) throw new Error(`no data dir at ${dataDir} (pass --data)`);
    let pw: string;
    if (file) pw = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    else {
      pw = await readSecret(`New password for ${dataDir} (at least ${MIN_PASSWORD} characters): `);
      if (process.stdin.isTTY && (await readSecret('Again: ')) !== pw) throw new Error('the two did not match');
    }
    await setPassword(dataDir, pw);
    console.log(`password set for ${dataDir}; every session was signed out. Sign in on each device with the username "admin".`);
    break;
  }
  case 'sessions': {
    const db = openAuthDb(dataDir);
    if (!readPassword(dataDir)) console.log(`no password is set: run set-password first (docs/login.md)`);
    for (const s of listSessions(db)) console.log(`${s.id}  last used ${when(s.lastUsed)} from ${s.lastIp ?? '?'}  signed in ${when(s.createdAt)}  ${s.userAgent ?? ''}`);
    db.close();
    break;
  }
  case 'revoke-sessions': {
    const db = openAuthDb(dataDir);
    const n = a ? db.query('DELETE FROM session WHERE id = ?').run(a).changes : db.query('DELETE FROM session').run().changes;
    console.log(`${n} session${n === 1 ? '' : 's'} signed out`);
    db.close();
    break;
  }
  case 'token': {
    if (!existsSync(dataDir)) throw new Error(`no data dir at ${dataDir} (pass --data)`);
    ensureToken(dataDir, rotate);
    console.log(`${rotate ? 'a new service token is in' : 'the service token is in'} ${join(dataDir, TOKEN_FILE)} (0600). Send it as "Authorization: Bearer <token>".`);
    break;
  }
  case 'accounts': {
    const boot = await call('GET', '/api/bootstrap');
    for (const x of boot.accounts) console.log(`${x.id}  ${x.network.padEnd(8)} ${x.label.padEnd(14)} ${x.status}${x.attention ? '  ! ' + x.attention.message : ''}`);
    break;
  }
  case 'add':
    console.log(await call('POST', '/api/accounts', { network: a, label, adapter, config: config ? JSON.parse(config) : undefined, secret: secret ? JSON.parse(secret) : undefined }));
    break;
  case 'remove':
    console.log(await call('DELETE', `/api/accounts/${a}`));
    break;
  case 'action':
    console.log(JSON.stringify(await call('POST', `/api/accounts/${a}/action`, { action: b, args: c ? JSON.parse(c) : undefined }), null, 2));
    break;
  case 'log':
    console.log(await call('GET', `/api/accounts/${a}/log`));
    break;
  default:
    console.log(`usage: cli.ts [--data DIR] set-password [--file F] | sessions | revoke-sessions [id] | token [--rotate]
       cli.ts [--hub URL] accounts | add <network> [--label] [--adapter] [--config JSON] [--secret JSON] | remove <id> | action <id> <action> [args] | log <id>`);
}

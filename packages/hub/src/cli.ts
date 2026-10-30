export {};
/**
 * Small CLI over the hub's HTTP API (the hub must be running).
 *
 *   bun packages/hub/src/cli.ts accounts
 *   bun packages/hub/src/cli.ts add <network> [--label L] [--adapter A] [--config JSON] [--secret JSON]
 *   bun packages/hub/src/cli.ts remove <accountId>
 *   bun packages/hub/src/cli.ts action <accountId> <action> [argsJSON]
 *   bun packages/hub/src/cli.ts log <accountId>
 *
 * --hub http://127.0.0.1:8460 (or DITHER_HUB) picks the hub.
 */
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const hub = opt('hub') ?? process.env.DITHER_HUB ?? 'http://127.0.0.1:8460';
const label = opt('label');
const adapter = opt('adapter');
const config = opt('config');
const secret = opt('secret');
const [cmd, a, b, c] = args;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(hub + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

switch (cmd) {
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
    console.log('usage: cli.ts accounts | add <network> [--label] [--adapter] [--config JSON] [--secret JSON] | remove <id> | action <id> <action> [args] | log <id>');
}

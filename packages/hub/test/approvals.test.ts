/**
 * Approvals (approvals.ts, docs/approvals.md): askers' tokens reach only /api/approvals and only their own requests;
 * a device's signed answer is checked before it counts; the page answers what needs no signature; expiry, cancel,
 * long polls, the keys file; and dither-ask against a real hub, with its exit codes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keysLine, mergePayload, parseKeys } from '@dither-chat/approvals';
import { verifyAnswer, type RequestView } from '../../approvals/src/client.ts';
import { FakeDevice } from '../../approvals/test/helpers.ts';
import { type ApprovalDevice, type ApprovalLink, Approvals, type DeviceAnswer } from '../src/approvals.ts';
import { TOKEN_FILE } from '../src/auth.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { memTempDir } from './fixtures/memdir.ts';

const CLI = join(import.meta.dir, '../../approvals/src/cli.ts');

class FakeLink implements ApprovalLink {
  asked: string[] = [];
  cancelled: string[] = [];
  intents: { id: string; action: string; message: string | null }[] = [];
  desk = false;
  constructor(private list: () => ApprovalDevice[]) {}
  async devices() {
    return this.list();
  }
  async ask(i: { ask: string }) {
    this.asked.push(/^id (\S+)$/m.exec(i.ask)![1]!);
    return { devices: 1 };
  }
  async cancel(id: string) {
    this.cancelled.push(id);
  }
  async intent(id: string, action: string, message: string | null) {
    if (!this.desk) return { sent: 0 };
    this.intents.push({ id, action, message });
    return { sent: 1 };
  }
  async answers() {
    return { answers: [] as DeviceAnswer[] };
  }
}

let dir: string;
let store: Store;
let hub: HubServer;
let approvals: Approvals;
let link: FakeLink;
let phone: FakeDevice;
let base: string;
let serviceToken: string;
let tokenA: string;
let tokenB: string;
let keysFile: string;
const raised: string[] = [];
const read: string[] = [];
let clock = 0;

beforeAll(async () => {
  // In memory: the hub's database, its token file and the askers file each sync to disk when written, and on a busy
  // disk the setup alone took over a minute (memdir.ts).
  dir = memTempDir('dither-approvals-');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  phone = await FakeDevice.make('dev_TestPhone0001');
  link = new FakeLink(() => [{ id: phone.id, name: 'Test phone', kind: 'phone', approvalKey: phone.spki, online: true }]);
  const dataDir = join(dir, 'data');
  require('node:fs').mkdirSync(dataDir, { recursive: true });
  approvals = new Approvals({ dataDir, link, notices: { raise: (n) => raised.push(n.id), read: (id) => read.push(id) }, now: () => Date.now() + clock, sweepMs: 50 });
  const sup = { authorize: () => null, online: () => false, command: async () => ({}) } as any;
  hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir, webDist: dir, secret: 's', approvals });
  base = `http://127.0.0.1:${hub.start().port!}`;
  serviceToken = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim();
  tokenA = approvals.askers.add('deployer', ['rebuild', 'deploy', 'alert']);
  tokenB = approvals.askers.add('other');
  writeFileSync(join(dir, 'a.token'), tokenA);
  keysFile = join(dir, 'keys');
  writeFileSync(keysFile, `${keysLine(phone.key())}\n`);
});

afterAll(() => {
  hub.stop();
  approvals.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

/** The phone answers `id` as a device would, through the manager's event. */
async function phoneAnswers(id: string, action: string, message: string | null = null, o: { sign?: boolean; tamper?: boolean } = {}) {
  const v = approvals.get(id)!;
  const signed = Date.now();
  const askObj = Object.fromEntries(v.ask.trim().split('\n').slice(1).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]));
  const ask = { id: askObj.id!, kind: askObj.kind as any, asker: askObj.asker!, created: Number(askObj.created), expires: Number(askObj.expires), payloadSha256: askObj['payload-sha256']!, displaySha256: askObj['display-sha256']! };
  const { signature } = await phone.answer(o.tamper ? { ...ask, created: ask.created + 1 } : ask, action, message, signed);
  return approvals.answered({ id, ok: true, action, message, signed, device: phone.id, deviceName: 'Test phone', deviceKind: 'phone', ...(o.sign === false ? {} : { signature }) });
}

describe('askers', () => {
  test('an asker reaches /api/approvals and nothing else', async () => {
    const r = await call(tokenA, 'POST', '/api/approvals', { kind: 'rebuild', title: 'Switch a host', body: 'diff', payload: 'dither-rebuild-v1\nhost h\n' });
    expect(r.status).toBe(201);
    const v = (await r.json()) as RequestView;
    expect(v).toMatchObject({ kind: 'rebuild', asker: 'deployer', state: 'waiting' });
    expect(link.asked).toContain(v.id);
    expect(raised).toContain(v.id);
    expect((await call(tokenA, 'GET', `/api/approvals/${v.id}`)).status).toBe(200);
    // Another asker sees nothing of it; nobody reaches the rest of the API with an asker's token.
    expect((await call(tokenB, 'GET', `/api/approvals/${v.id}`)).status).toBe(404);
    expect(((await (await call(tokenB, 'GET', '/api/approvals')).json()) as any).items).toEqual([]);
    expect((await call(tokenA, 'GET', '/api/bootstrap')).status).toBe(401);
    expect((await call('dask_not-a-token', 'GET', '/api/approvals')).status).toBe(401);
    // Kinds it was not given, and answering, are refused.
    expect((await call(tokenA, 'POST', '/api/approvals', { kind: 'merge', title: 'x', payload: 'dither-merge-v1\n' })).status).toBe(403);
    expect((await call(tokenA, 'POST', `/api/approvals/${v.id}/answer`, { action: 'approve' })).status).toBe(403);
    // The service token lists all, but is no page: it answers nothing either.
    expect(((await (await call(serviceToken, 'GET', '/api/approvals')).json()) as any).items.length).toBeGreaterThan(0);
    expect((await call(serviceToken, 'POST', `/api/approvals/${v.id}/answer`, { action: 'deny' })).status).toBe(403);
  });

  test('bad requests say what is wrong', async () => {
    for (const [b, word] of [
      [{ kind: 'nope', title: 't' }, 'kind'],
      [{ kind: 'rebuild', title: '' }, 'title'],
      [{ kind: 'rebuild', title: 't', payload: 'not a payload' }, 'payload'],
      [{ kind: 'rebuild', title: 't', actions: [{ id: 'Bad Id' }] }, 'action'],
    ] as const) {
      const r = await call(tokenA, 'POST', '/api/approvals', b);
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toContain(word);
    }
  });
});

describe('answers', () => {
  const ask = async (extra: Record<string, unknown> = {}) => (await (await call(tokenA, 'POST', '/api/approvals', { kind: 'deploy', title: 'Deploy paused', body: 'a check failed', payload: 'dither-deploy-v1\nhost h\n', ...extra })).json()) as RequestView;

  test('a signed answer counts once it checks out; a forged or unsigned one does not', async () => {
    const v = await ask();
    expect(await phoneAnswers(v.id, 'approve', null, { tamper: true })).toBe(false);
    expect(await phoneAnswers(v.id, 'approve', null, { sign: false })).toBe(false);
    expect(approvals.get(v.id)!.state).toBe('waiting');
    expect(await phoneAnswers(v.id, 'approve', 'go ahead')).toBe(true);
    const done = approvals.get(v.id)!;
    expect(done).toMatchObject({ state: 'answered', action: 'approve', message: 'go ahead', signed: true, via: 'device' });
    expect(read).toContain(v.id);
    expect(link.cancelled).toContain(v.id);
    // The asker's own check, with the keys it trusts.
    const keys = parseKeys(readFileSync(keysFile, 'utf8')) as any;
    expect(await verifyAnswer(done as any, keys, { kind: 'deploy', title: 'Deploy paused', body: 'a check failed', payload: 'dither-deploy-v1\nhost h\n', actions: [{ id: 'approve', needs: 'signed' }] })).toEqual({ ok: true });
    expect((await verifyAnswer(done as any, keys, { payload: 'dither-deploy-v1\nhost other\n' })).ok).toBe(false);
    // A second answer changes nothing.
    expect(await phoneAnswers(v.id, 'deny')).toBe(false);
  });

  test('deny needs no signature; an action not offered is ignored', async () => {
    const v = await ask();
    expect(await phoneAnswers(v.id, 'rollback', null, { sign: false })).toBe(false);
    expect(await phoneAnswers(v.id, 'deny', 'not now', { sign: false })).toBe(true);
    expect(approvals.get(v.id)).toMatchObject({ state: 'answered', action: 'deny', signed: false });
  });

  test('the page answers actions marked any, and sends signed ones to the laptop signer', async () => {
    const v = await ask({ actions: [{ id: 'resume' }, { id: 'hold', needs: 'any' }] });
    expect(v.actions.map((a) => `${a.id}:${a.needs}`)).toEqual(['resume:signed', 'hold:any', 'deny:any']);
    const page = { admin: true as const, page: true };
    const res = await approvals.route(new Request(`${base}/api/approvals/${v.id}/answer`, { method: 'POST', body: JSON.stringify({ action: 'resume' }) }), new URL(`${base}/api/approvals/${v.id}/answer`), page);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain('phone');
    link.desk = true;
    expect(await approvals.pageAnswer(v.id, 'resume', 'ok')).toEqual({ answered: false, signing: true });
    expect(link.intents.at(-1)).toEqual({ id: v.id, action: 'resume', message: 'ok' });
    expect(approvals.get(v.id)!.signing).toBe('resume');
    link.desk = false;
    expect(await approvals.pageAnswer(v.id, 'hold', null)).toEqual({ answered: true, signing: false });
    expect(approvals.get(v.id)).toMatchObject({ state: 'answered', action: 'hold', via: 'page', signed: false, signing: null });
  });

  test('a long poll returns when the answer comes', async () => {
    const v = await ask();
    const t = Date.now();
    const polled = call(tokenA, 'GET', `/api/approvals/${v.id}?wait=20`).then((r) => r.json() as Promise<RequestView>);
    await approvals.waitFor(v.id, 0); // let the poll register
    setTimeout(() => void phoneAnswers(v.id, 'deny', null, { sign: false }), 100);
    expect((await polled).state).toBe('answered');
    expect(Date.now() - t).toBeLessThan(10_000); // wall-clock: the poll returns on the answer, long before its 20 s
  });

  test('expired and cancelled requests end, and say so', async () => {
    const a = await ask({ expiresIn: 60 });
    const b = await ask();
    expect((await call(tokenA, 'POST', `/api/approvals/${b.id}/cancel`, { reason: 'not needed' })).status).toBe(200);
    expect(approvals.get(b.id)).toMatchObject({ state: 'cancelled', cancelReason: 'not needed' });
    clock = 61_000;
    try {
      expect(approvals.get(a.id)!.state).toBe('expired');
      expect(read).toContain(a.id);
    } finally {
      clock = 0;
    }
  });

  test('the keys file lists each device with its fingerprint', async () => {
    const text = await (await call(tokenA, 'GET', '/api/approvals/keys')).text();
    expect(parseKeys(text)).toEqual([{ ...phone.key(), name: 'Test phone' }]);
  });

  test('a merge needs a merge payload', async () => {
    approvals.askers.add('reviewbot', ['merge']);
    const r = approvals.create({ asker: 'reviewbot', kinds: ['merge'] }, { kind: 'merge', title: 'Merge', payload: mergePayload({ repo: 'r', target: 'main', branch: 'review/x', base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40) }), topic: 'r:review/x' });
    expect(r.topic).toBe('r:review/x');
    expect(() => approvals.create({ asker: 'reviewbot', kinds: ['merge'] }, { kind: 'merge', title: 'Merge', payload: 'dither-merge-v1\nrepo r\n' })).toThrow();
    // Any asker reads a topic's requests (an agent reads what its review got).
    const items = ((await (await call(tokenB, 'GET', '/api/approvals?topic=r%3Areview%2Fx')).json()) as any).items;
    expect(items.map((x: any) => x.id)).toEqual([r.id]);
  });
});

describe('dither-ask', () => {
  const ask = (args: string[]) =>
    Bun.spawn(['bun', CLI, ...args, '--url', base, '--token-file', join(dir, 'a.token')], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, DITHER_ASK_URL: '', DITHER_ASK_TOKEN_FILE: '' } });
  /** The id of the next request asked after `n` were (the CLI's). */
  const next = async (n: number) => {
    while (link.asked.length <= n) await approvals.waitFor('none', 20);
    return link.asked[n]!;
  };

  test('approved and verified: exit 0 with the answer as JSON', async () => {
    writeFileSync(join(dir, 'p'), 'dither-rebuild-v1\nhost h\n');
    const n = link.asked.length;
    const p = ask(['request', '--kind', 'rebuild', '--title', 'Switch to the build', '--payload-file', join(dir, 'p'), '--wait', '30', '--keys', keysFile]);
    const id = await next(n);
    await phoneAnswers(id, 'approve', 'fine');
    expect(await p.exited).toBe(0);
    const j = JSON.parse(await new Response(p.stdout).text());
    expect(j).toMatchObject({ id, state: 'answered', action: 'approve', message: 'fine', signed: true, verified: true });
    expect(await new Response(p.stderr).text()).toContain("The user's message: fine");
  });

  test('denied: 77; no answer in time: 75; a key it does not trust: 76', async () => {
    let n = link.asked.length;
    const p = ask(['request', '--kind', 'rebuild', '--title', 'Switch to the build', '--wait', '30']);
    await phoneAnswers(await next(n), 'deny', null, { sign: false });
    expect(await p.exited).toBe(77);
    const q = ask(['request', '--kind', 'rebuild', '--title', 'Switch to the build', '--wait', '1']);
    expect(await q.exited).toBe(75);
    const other = await FakeDevice.make('dev_TestPhone0001');
    writeFileSync(join(dir, 'other-keys'), `${keysLine(other.key())}\n`);
    n = link.asked.length;
    const r = ask(['request', '--kind', 'rebuild', '--title', 'Switch to the build', '--wait', '30', '--keys', join(dir, 'other-keys')]);
    await phoneAnswers(await next(n), 'approve');
    expect(await r.exited).toBe(76);
    const bad = ask(['request', '--kind', 'merge', '--title', 'x']);
    expect(await bad.exited).toBe(64);
  });
});

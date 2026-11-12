/**
 * Making a group through the hub (groups.ts, docs/group-settings.md "Making a group"), against the demo world's
 * adapters run in process: whom each account is offered, the rules' refusals before anything reaches an adapter, what
 * each network does with the people (Discord only friends, Signal adds, Matrix invites, Telegram's privacy refusal),
 * the pace for both kinds and its give-back, the log line, and the route's Origin.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { createGroupNotBuilt, GROUP_RULES } from '@dither-chat/protocol';
import { AboutError } from '../src/about.ts';
import { ADD_LIMITS } from '../src/add.ts';
import { asked, attempt, candidatesAttempt } from '../src/attempts.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { Groups } from '../src/groups.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-create-group-'));
let store: Store;
let groups: Groups;
const sent: { account: string; cmd: { t: string; name?: string; people?: string[] } }[] = [];
const notes: string[] = [];
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const offline = new Set<string>();
/** An answer the next createGroup gets instead of the adapter's, to see what the hub does with it. */
let instead: ((cmd: { t: string }) => Promise<unknown>) | null = null;

const MAIN = 'acc_demo-discord-main';
const ALT = 'acc_demo-discord-alt';
const SIG = 'acc_demo-signal';
const MX = 'acc_demo-matrix';
const WA = 'acc_demo-whatsapp';
const TG = 'acc_demo-telegram';

const who = (net: P.Network, displayName: string) => {
  const r = store.one<{ id: string }>('SELECT id FROM identity WHERE network = ? AND display_name = ?', net, displayName);
  if (!r) throw new Error(`nobody called ${displayName} on ${net}`);
  return r.id;
};
const selfOf = (acc: string) => store.account(acc)!.self_identity!;
const participants = (id: string) => (store.db.query('SELECT identity_id FROM participant WHERE conversation_id = ?').all(id) as { identity_id: string }[]).map((r) => r.identity_id);
const paced = (acc: string, kind: string) => (store.db.query('SELECT COUNT(*) AS n FROM add_pace WHERE account_id = ? AND kind = ?').get(acc, kind) as { n: number }).n;
const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as AboutError;
  }
  throw new Error('it went through');
};
const makes = () => sent.filter((s) => s.cmd.t === 'createGroup');
const command = <T>(account: string, cmd: any) => {
  sent.push({ account, cmd });
  if (instead) {
    const f = instead;
    instead = null;
    return f(cmd) as Promise<T>;
  }
  return new Promise<T>((resolve, rej) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject: rej });
    adapters.get(account)!.command({ ...cmd, id });
  });
};

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  store.db.transaction(() => {
    for (const acc of createDemoAccounts(store)) {
      const adir = join(dir, acc.id);
      mkdirSync(adir, { recursive: true });
      const a = demoFactory(acc, adir)!;
      adapters.set(acc.id, a);
      a.start((ev) => {
        if (ev.t === 'reply') {
          const p = pending.get(ev.id);
          pending.delete(ev.id);
          if (ev.ok) p?.resolve(ev.result);
          else p?.reject(new Error(ev.error));
          return;
        }
        store.ingest(store.account(acc.id)!, ev);
      });
    }
  })();
  store.flush();
  groups = new Groups({ store, online: (a) => !offline.has(a), command, note: (_a, line) => notes.push(line) });
});

afterAll(() => {
  for (const a of adapters.values()) (a as unknown as { stop(): void }).stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('who is offered', () => {
  test('each account that can, with its rule and the people it knows; WhatsApp is unable, with its line', () => {
    const v = groups.candidates();
    const by = new Map(v.accounts.map((a) => [a.accountId, a]));
    expect([...by.keys()].sort()).toEqual(['acc_demo-discord-alt', MAIN, MX, SIG, TG].sort());
    expect(by.get(MAIN)!.rule).toEqual(GROUP_RULES.discord!);
    expect(by.get(MX)!.rule.mode).toBe('invite');
    expect(v.unable).toEqual([{ accountId: WA, network: 'whatsapp', reason: createGroupNotBuilt('whatsapp') }]);
    // Every candidate's identity comes with the view, once.
    const all = v.accounts.flatMap((a) => a.candidates.map((c) => c.identityId));
    expect(v.identities.map((i) => i.id).sort()).toEqual([...new Set(all)].sort());
    for (const a of v.accounts) {
      const ids = a.candidates.map((c) => c.identityId);
      expect(ids).not.toContain(selfOf(a.accountId));
      expect(v.identities.filter((i) => ids.includes(i.id)).every((i) => i.network === a.network && !i.isBot)).toBe(true);
    }
  });

  test('Discord offers only friends; Signal everyone it knows but someone whose request waits', () => {
    const v = groups.candidates();
    const discord = v.accounts.find((a) => a.accountId === MAIN)!.candidates;
    expect(discord.every((c) => c.relationship === 'friend')).toBe(true);
    const offered = discord.map((c) => c.identityId);
    expect(offered).toContain(who('discord', 'Alice'));
    expect(offered).not.toContain(who('discord', 'Mara'));
    const signal = v.accounts.find((a) => a.accountId === SIG)!.candidates.map((c) => c.identityId);
    // In a group already is no reason to leave someone out of a new one.
    for (const name of ['Alice Chen', 'Sam Rivera', 'Quinn', 'Dad', 'Mom']) expect(signal).toContain(who('signal', name));
    expect(signal).not.toContain(who('signal', 'Jamie'));
    // People talked with lately first.
    const talked = v.accounts.find((a) => a.accountId === SIG)!.candidates.map((c) => c.lastTalked ?? 0);
    expect(talked).toEqual([...talked].sort((a, b) => b - a));
  });

  test('?account= for one; an offline account is left out of both lists', () => {
    expect(groups.candidates(SIG).accounts.map((a) => a.accountId)).toEqual([SIG]);
    offline.add(WA);
    offline.add(MX);
    try {
      const v = groups.candidates();
      expect(v.accounts.map((a) => a.accountId)).not.toContain(MX);
      expect(v.unable).toEqual([]);
    } finally {
      offline.clear();
    }
  });
});

describe('the rules, before anything reaches an adapter', () => {
  test('a bad shape, too few or too many, no name, a long name', async () => {
    const before = makes().length;
    const sig = (name: unknown, identities: unknown) => reject(groups.create({ accountId: SIG, name, identities }));
    expect((await reject(groups.create({ identities: [who('signal', 'Quinn')] }))).status).toBe(400);
    expect((await sig('x', 'nope')).status).toBe(400);
    expect((await sig(5, [who('signal', 'Quinn')])).status).toBe(400);
    expect(await sig('x', [])).toMatchObject({ status: 400, message: 'A Signal group starts with at least 1 person' });
    expect(await sig('  ', [who('signal', 'Quinn')])).toMatchObject({ status: 400, message: 'Give the group a name' });
    expect(await sig('x'.repeat(33), [who('signal', 'Quinn')])).toMatchObject({ status: 400, message: "A Signal group's name is at most 32 characters" });
    expect(await sig('x', Array.from({ length: 11 }, (_, i) => `idn_${i}`))).toMatchObject({ status: 400, message: 'A Signal group starts with at most 10 people' });
    const d = await reject(groups.create({ accountId: MAIN, identities: [who('discord', 'Alice')] }));
    expect(d).toMatchObject({ status: 400, message: 'A Discord group DM starts with at least 2 friends' });
    expect(makes().length).toBe(before);
  });

  test('no such account or person, another network, the account itself', async () => {
    const before = makes().length;
    expect((await reject(groups.create({ accountId: 'acc_nope', name: 'x', identities: [who('signal', 'Quinn')] }))).status).toBe(404);
    expect((await reject(groups.create({ accountId: SIG, name: 'x', identities: ['idn_nobody'] }))).status).toBe(404);
    expect(await reject(groups.create({ accountId: SIG, name: 'x', identities: [who('matrix', 'Ben')] }))).toMatchObject({ status: 400, message: 'Only Signal people can be in a Signal group' });
    expect(await reject(groups.create({ accountId: SIG, name: 'x', identities: [selfOf(SIG)] }))).toMatchObject({ status: 400, message: 'That is this account' });
    // Another of your own accounts is refused too (the candidates leave it out), and said so.
    expect(await reject(groups.create({ accountId: MAIN, identities: [selfOf(ALT), who('discord', 'Alice')] }))).toMatchObject({ status: 400, message: 'That is one of your own accounts' });
    expect(makes().length).toBe(before);
    expect(paced(SIG, 'groups')).toBe(0);
  });

  test('WhatsApp: not able, with its line; an account offline: not connected', async () => {
    const before = makes().length;
    const someone = store.one<{ id: string }>(`SELECT id FROM identity WHERE network = 'whatsapp' AND display_name = 'Marco'`)!.id;
    expect(await reject(groups.create({ accountId: WA, name: 'Book club 2', identities: [someone] }))).toMatchObject({ status: 409, message: createGroupNotBuilt('whatsapp') });
    offline.add(SIG);
    try {
      const e = await reject(groups.create({ accountId: SIG, name: 'x', identities: [who('signal', 'Quinn')] }));
      expect(e.status).toBe(409);
      expect(e.message).toContain('is not connected');
    } finally {
      offline.clear();
    }
    expect(makes().length).toBe(before);
  });
});

describe('each network', () => {
  test('Signal adds, and someone whose profile it lacks comes in invited; the answer carries the new conversation', async () => {
    const r = await groups.create({ accountId: SIG, name: '  Board games  ', identities: [who('signal', 'Quinn'), who('signal', 'Dad'), who('signal', 'Mom')] });
    expect(makes().at(-1)!.cmd).toMatchObject({ t: 'createGroup', name: 'Board games', people: expect.any(Array) });
    expect(r.accountId).toBe(SIG);
    expect(r.added.sort()).toEqual([who('signal', 'Quinn'), who('signal', 'Mom')].sort());
    expect(r.invited).toEqual([who('signal', 'Dad')]);
    expect(r).toMatchObject({ failed: [], notes: [] });
    expect(r.conversation).toMatchObject({ network: 'signal', shape: 'group', name: 'Board games' });
    expect(participants(r.conversation.id).sort()).toEqual([selfOf(SIG), who('signal', 'Quinn'), who('signal', 'Mom')].sort());
    expect(notes.at(-1)).toBe('[add] made group "Board games" with +1 555 0190, +1 555 0102; invited +1 555 0103');
    expect(paced(SIG, 'groups')).toBe(1);
    expect(paced(SIG, 'members')).toBe(3);
  });

  test('Discord: friends only; someone who is not one comes back refused, the rest are in, the name is optional', async () => {
    const r = await groups.create({ accountId: MAIN, identities: [who('discord', 'Alice'), who('discord', 'Jordan'), who('discord', 'Mara')] });
    expect(makes().at(-1)!.cmd.name).toBeUndefined();
    expect(r.added.sort()).toEqual([who('discord', 'Alice'), who('discord', 'Jordan')].sort());
    expect(r.failed).toEqual([{ identityId: who('discord', 'Mara'), reason: 'Discord adds only your friends to a group.' }]);
    expect(r.conversation).toMatchObject({ network: 'discord', shape: 'group', name: null });
    expect(notes.at(-1)).toBe('[add] made group DM with alice.chen, jordanruns; could not add mara');
  });

  test('Discord with fewer than 2 friends among them makes nothing, and the slots come back', async () => {
    const g = paced(MAIN, 'groups');
    const m = paced(MAIN, 'members');
    const e = await reject(groups.create({ accountId: MAIN, identities: [who('discord', 'Alice'), who('discord', 'Mara')] }));
    expect(e.status).toBe(502);
    expect(e.message).toContain('at least 2 of your friends');
    expect(paced(MAIN, 'groups')).toBe(g);
    expect(paced(MAIN, 'members')).toBe(m);
  });

  test('Matrix invites everyone: they are in once they accept', async () => {
    const r = await groups.create({ accountId: MX, name: 'Garden', identities: [who('matrix', 'kai'), who('matrix', 'Lina')] });
    expect(r.added).toEqual([]);
    expect(r.invited.sort()).toEqual([who('matrix', 'kai'), who('matrix', 'Lina')].sort());
    expect(participants(r.conversation.id)).toEqual([selfOf(MX)]);
    expect(r.conversation.name).toBe('Garden');
    expect(notes.at(-1)).toBe('[add] made room "Garden"; invited @kai:nixos.dev, @lina:nixos.dev');
  });

  test("Telegram: Noor's privacy settings refuse her, the group is made with the rest, and Telegram's note comes back", async () => {
    const r = await groups.create({ accountId: TG, name: 'Film walks', identities: [who('telegram', 'Alice Chen'), who('telegram', 'Noor')] });
    expect(r.added).toEqual([who('telegram', 'Alice Chen')]);
    expect(r.failed).toEqual([{ identityId: who('telegram', 'Noor'), reason: "Their privacy settings don't let you add them to groups." }]);
    expect(r.notes).toEqual(['Telegram made it a basic group']);
    expect(r.conversation).toMatchObject({ network: 'telegram', shape: 'group', name: 'Film walks' });
    expect(notes.at(-1)).toBe('[add] made group "Film walks" with @alicechen; could not add @noor_h');
  });

  test('an adapter that names no conversation the hub has: 502', async () => {
    instead = async () => ({ conversation: 'group:nothing-like-it', added: [] });
    const e = await reject(groups.create({ accountId: SIG, name: 'Ghost', identities: [who('signal', 'Lev')] }));
    expect(e).toMatchObject({ status: 502, message: 'Signal made something but did not say which conversation it made' });
  });

  test('no answer: 504, saying it may still have gone through, and the slots stay taken', async () => {
    const g = paced(SIG, 'groups');
    instead = async () => {
      throw new Error('adapter timed out on createGroup');
    };
    const e = await reject(groups.create({ accountId: SIG, name: 'Slow', identities: [who('signal', 'Lev')] }));
    expect(e.status).toBe(504);
    expect(e.message).toBe('Signal did not answer in 90 seconds. It may still have gone through: look again in a minute.');
    expect(paced(SIG, 'groups')).toBe(g + 1);
  });
});

describe('pace', () => {
  test('groups: 5 a day, 3 on Telegram; past it nothing goes out and nothing is taken', async () => {
    expect(ADD_LIMITS.groups).toMatchObject({ max: 5, windowMs: 86_400_000, networks: { telegram: 3 } });
    const now = Date.now();
    for (let i = paced(TG, 'groups'); i < 3; i++) store.db.query(`INSERT INTO add_pace (account_id, kind, at) VALUES (?, 'groups', ?)`).run(TG, now - 1000);
    const m = paced(TG, 'members');
    const before = makes().length;
    const e = await reject(groups.create({ accountId: TG, name: 'One more', identities: [who('telegram', 'Alice Chen')] }));
    expect(e.status).toBe(429);
    expect(e.message).toContain('has made 3 groups in the last day');
    expect(makes().length).toBe(before);
    expect(paced(TG, 'groups')).toBe(3);
    expect(paced(TG, 'members')).toBe(m);
  });

  test('one members slot per person, all or none: the group slot comes back too', async () => {
    const acc = MX;
    const g = paced(acc, 'groups');
    const now = Date.now();
    for (let i = paced(acc, 'members'); i < ADD_LIMITS.members.max - 1; i++) store.db.query(`INSERT INTO add_pace (account_id, kind, at) VALUES (?, 'members', ?)`).run(acc, now - 1000);
    const before = makes().length;
    const e = await reject(groups.create({ accountId: acc, name: 'Too many', identities: [who('matrix', 'kai'), who('matrix', 'Mira')] }));
    expect(e.status).toBe(429);
    expect(e.message).toContain('(1 of the 2 would fit)');
    expect(makes().length).toBe(before);
    expect(paced(acc, 'groups')).toBe(g);
    expect(paced(acc, 'members')).toBe(ADD_LIMITS.members.max - 1);
  });

  test("the adapter's own refusal gives every slot back", async () => {
    const g = paced(SIG, 'groups');
    const m = paced(SIG, 'members');
    instead = async () => {
      throw new Error('signal-cli refused: the group name is not valid');
    };
    const e = await reject(groups.create({ accountId: SIG, name: 'Refused', identities: [who('signal', 'Lev'), who('signal', 'Mei')] }));
    expect(e).toMatchObject({ status: 502, message: 'signal-cli refused: the group name is not valid' });
    expect(paced(SIG, 'groups')).toBe(g);
    expect(paced(SIG, 'members')).toBe(m);
  });
});

describe('the routes', () => {
  test('GET candidates; POST only with a browser Origin, and then it makes the group', async () => {
    const sup = { authorize: () => null, online: (a: string) => !offline.has(a), command: (a: string, c: any) => command(a, c), note: (_a: string, line: string) => notes.push(line), liveViewUrl: () => null } as any;
    const hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    const port = hub.start().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const c = await fetch(`${base}/api/groups/candidates?account=${SIG}`);
      expect(c.status).toBe(200);
      expect(((await c.json()) as P.GroupCandidatesView).accounts.map((a) => a.accountId)).toEqual([SIG]);
      const b = JSON.stringify({ accountId: SIG, name: 'Route', identities: [who('signal', 'Lev')] });
      const before = makes().length;
      const bare = await fetch(`${base}/api/groups`, { method: 'POST', body: b });
      expect(bare.status).toBe(403);
      expect(((await bare.json()) as { error: string }).error).toBe('Groups are made from the app itself');
      const other = await fetch(`${base}/api/groups`, { method: 'POST', body: b, headers: { origin: 'https://elsewhere.example' } });
      expect(other.status).toBe(403);
      expect(makes().length).toBe(before);
      const ok = await fetch(`${base}/api/groups`, { method: 'POST', body: b, headers: { origin: base } });
      expect(ok.status).toBe(200);
      const v = (await ok.json()) as P.CreateGroupView;
      expect(v.conversation.name).toBe('Route');
      expect(v.added).toEqual([who('signal', 'Lev')]);
      const wa = await fetch(`${base}/api/groups`, { method: 'POST', body: JSON.stringify({ accountId: WA, identities: ['x'] }), headers: { origin: base } });
      expect(wa.status).toBe(409);
    } finally {
      hub.stop();
    }
  });
});

describe("in the hub's log", () => {
  /** What console.warn got while `f` ran, and what `f` threw. */
  const warned = async (f: () => unknown) => {
    const lines: string[] = [];
    const spy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    let error: AboutError | Error | null = null;
    try {
      await f();
    } catch (e) {
      error = e as Error;
    } finally {
      spy.mockRestore();
    }
    return { lines, error };
  };
  const accountLog: string[] = [];
  /** The attempt as the route runs it. */
  const make = (b: { accountId?: unknown; name?: unknown; identities?: unknown }, g = groups) =>
    attempt({ kind: 'create', people: asked(b.identities) }, (a) => g.create(b, a), (acc, line) => accountLog.push(`${acc} ${line}`));

  test('made, with someone refused: one created line, and failed counts them', async () => {
    const { lines, error } = await warned(() => make({ accountId: MAIN, identities: [who('discord', 'Alice'), who('discord', 'Jordan'), who('discord', 'Mara')] }));
    expect(error).toBeNull();
    expect(lines).toEqual(['groups: created account=acc_demo-discord-main network=discord added=2 invited=0 failed=1']);
  });

  test("a bad shape: account and network unknown, nothing in an account's log", async () => {
    const before = accountLog.length;
    const { lines } = await warned(() => make({ identities: [who('signal', 'Quinn')] }));
    expect(lines).toEqual(['groups: create failed account=- network=- people=1 status=400 error="Which account makes it?"']);
    expect(accountLog.length).toBe(before);
  });

  test("a rule's refusal (400), and the line in the account's log", async () => {
    const { lines } = await warned(() => make({ accountId: SIG, name: 'x', identities: [] }));
    expect(lines).toEqual(['groups: create failed account=acc_demo-signal network=signal people=0 status=400 error="A Signal group starts with at least 1 person"']);
    expect(accountLog.at(-1)).toBe('acc_demo-signal [add] could not make group: A Signal group starts with at least 1 person');
    const own = await warned(() => make({ accountId: MAIN, identities: [selfOf(ALT), who('discord', 'Alice')] }));
    expect(own.lines).toEqual(['groups: create failed account=acc_demo-discord-main network=discord people=2 status=400 error="That is one of your own accounts"']);
    expect(accountLog.at(-1)).toBe('acc_demo-discord-main [add] could not make group DM: That is one of your own accounts');
  });

  test('the pace (429)', async () => {
    // Telegram is at its 3 a day since "pace", above.
    const { lines, error } = await warned(() => make({ accountId: TG, name: 'Again', identities: [who('telegram', 'Alice Chen')] }));
    expect(error).toMatchObject({ status: 429 });
    expect(error!.message).toContain('has made 3 groups in the last day');
    expect(lines).toEqual([`groups: create failed account=acc_demo-telegram network=telegram people=1 status=429 error=${JSON.stringify(error!.message)}`]);
  });

  test("the adapter's refusal (502), and no answer (504)", async () => {
    instead = async () => {
      throw new Error('the server said "no"');
    };
    const refused = await warned(() => make({ accountId: MX, name: 'Refused', identities: [who('matrix', 'kai')] }));
    expect(refused.lines).toEqual(['groups: create failed account=acc_demo-matrix network=matrix people=1 status=502 error="the server said \\"no\\""']);
    expect(accountLog.at(-1)).toBe('acc_demo-matrix [add] could not make room: the server said "no"');
    instead = async () => {
      throw new Error('adapter timed out on createGroup');
    };
    const slow = await warned(() => make({ accountId: MX, name: 'Slow', identities: [who('matrix', 'kai')] }));
    expect(slow.lines).toEqual(['groups: create failed account=acc_demo-matrix network=matrix people=1 status=504 error="Matrix did not answer in 90 seconds. It may still have gone through: look again in a minute."']);
  });

  test('anything else (500) is logged, then thrown on as it was; a long sentence is cut to 300 characters', async () => {
    const broken = new Groups({
      store,
      online: () => true,
      command,
      note: () => {
        throw new TypeError(`the log is full ${'x'.repeat(400)}`);
      },
    });
    const { lines, error } = await warned(() => make({ accountId: MAIN, identities: [who('discord', 'Alice'), who('discord', 'Jordan')] }, broken));
    expect(error).toBeInstanceOf(TypeError);
    expect(lines).toEqual([`groups: create failed account=acc_demo-discord-main network=discord people=2 status=500 error=${JSON.stringify(`the log is full ${'x'.repeat(400)}`.slice(0, 300))}`]);
    expect(accountLog.at(-1)).toStartWith('acc_demo-discord-main [add] could not make group DM: the log is full xxx');
  });

  test('candidates that fail', async () => {
    const { lines } = await warned(() =>
      candidatesAttempt(null, () => {
        throw new AboutError('No such account', 404);
      }),
    );
    expect(lines).toEqual(['groups: candidates failed status=404 error="No such account"']);
  });

  test('through the route: the refusal without an Origin (403) and a group made', async () => {
    const sup = { authorize: () => null, online: () => true, command: (a: string, c: any) => command(a, c), note: (a: string, line: string) => accountLog.push(`${a} ${line}`), liveViewUrl: () => null } as any;
    const hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    const base = `http://127.0.0.1:${hub.start().port}`;
    try {
      const b = JSON.stringify({ accountId: MAIN, identities: [who('discord', 'Alice'), who('discord', 'Jordan')] });
      const bare = await warned(() => fetch(`${base}/api/groups`, { method: 'POST', body: b }));
      expect(bare.lines).toEqual(['groups: create failed account=- network=- people=2 status=403 error="Groups are made from the app itself"']);
      const made = await warned(async () => expect((await fetch(`${base}/api/groups`, { method: 'POST', body: b, headers: { origin: base } })).status).toBe(200));
      expect(made.lines).toEqual(['groups: created account=acc_demo-discord-main network=discord added=2 invited=0 failed=0']);
    } finally {
      hub.stop();
    }
  });
});

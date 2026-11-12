/**
 * Adding people to groups through the hub (about.ts addMembers and candidates, docs/group-settings.md), against the
 * demo world's adapters run in process: whom each account is offered, what a fresh About allows, what each network
 * does with the people (Discord only friends, Signal adds, Matrix invites), the pace per account, and the line a
 * network without it shows instead of a button.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { addMembersNotBuilt } from '@dither-chat/protocol';
import { AboutError, Abouts } from '../src/about.ts';
import { ADD_LIMITS } from '../src/add.ts';
import { asked, attempt, candidatesAttempt } from '../src/attempts.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-add-members-'));
let store: Store;
let abouts: Abouts;
const sent: { account: string; cmd: { t: string; people?: string[] } }[] = [];
const notes: string[] = [];
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// By the start of its name: about.test.ts renames some of the demo world's groups, and may run first in this process.
const conv = (net: P.Network, name: string) => {
  const r = store.one<{ id: string }>(`SELECT id FROM conversation WHERE network = ? AND name LIKE ? || '%'`, net, name);
  if (!r) throw new Error(`no ${net} conversation ${name}`);
  return r.id;
};
const who = (net: P.Network, displayName: string) => {
  const r = store.one<{ id: string }>('SELECT id FROM identity WHERE network = ? AND display_name = ?', net, displayName);
  if (!r) throw new Error(`nobody called ${displayName} on ${net}`);
  return r.id;
};
const participants = (id: string) => (store.db.query('SELECT identity_id FROM participant WHERE conversation_id = ?').all(id) as { identity_id: string }[]).map((r) => r.identity_id);
const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as AboutError;
  }
  throw new Error('it went through');
};
const adds = () => sent.filter((s) => s.cmd.t === 'addMembers');

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  // The world's first events in one transaction: one write to disk, not one per event (seconds on a busy disk).
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
  abouts = new Abouts({ ...deps, note: (_a, line) => notes.push(line) });
});

/** An answer the next addMembers gets instead of the adapter's, to see what the hub does with it. */
let instead: (() => Promise<unknown>) | null = null;
const deps = {
  get store() {
    return store;
  },
  online: () => true,
  command: <T>(account: string, cmd: any) => {
    sent.push({ account, cmd });
    if (instead && cmd.t === 'addMembers') {
      const f = instead;
      instead = null;
      return f() as Promise<T>;
    }
    return new Promise<T>((resolve, rej) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject: rej });
      adapters.get(account)!.command({ ...cmd, id });
    });
  },
  pickAccount: (c: string, requested?: string) => {
    const vs = store.vantageAccounts('conversation', c);
    return requested && vs.includes(requested) ? requested : (vs[0] ?? null);
  },
};

afterAll(() => {
  for (const a of adapters.values()) (a as unknown as { stop(): void }).stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Signal', () => {
  test('an admin is offered the people the account knows who are not in it, and adds them; one comes in invited', async () => {
    const id = conv('signal', 'Climbing crew');
    const v = await abouts.get('conversation', id);
    expect(v.adding).toEqual({ can: true, who: 'known', mode: 'add' });
    const c = await abouts.candidates(id);
    const offered = c.candidates.map((x) => x.identityId);
    for (const name of ['Quinn', 'Dad', 'Mom']) expect(offered).toContain(who('signal', name));
    // Not the ones in it, and never the account itself.
    for (const name of ['Alice Chen', 'Sam Rivera', 'Priya', 'Theo K', 'zyan']) expect(offered).not.toContain(who('signal', name));
    // Jamie's message request still waits: adding them would answer it.
    expect(offered).not.toContain(who('signal', 'Jamie'));
    expect(c.identities.map((i) => i.id).sort()).toEqual([...offered].sort());

    const r = await abouts.addMembers(id, { identities: [who('signal', 'Quinn'), who('signal', 'Dad')] });
    expect(r.added).toEqual([who('signal', 'Quinn')]);
    expect(r.invited).toEqual([who('signal', 'Dad')]);
    expect(r.failed).toEqual([]);
    expect(participants(id)).toContain(who('signal', 'Quinn'));
    expect(r.about?.members?.list.map((m) => m.identityId)).toContain(who('signal', 'Quinn'));
    expect(notes.at(-1)).toContain('[add] added');
    expect(notes.at(-1)).toMatch(/\(Climbing crew/);
    // Quinn is in it now, so no longer offered.
    expect((await abouts.candidates(id)).candidates.map((x) => x.identityId)).not.toContain(who('signal', 'Quinn'));
  });

  test('a member of a group where only admins add is told why, and nothing reaches Signal', async () => {
    const id = conv('signal', 'Family');
    const v = await abouts.get('conversation', id);
    expect(v.adding).toEqual({ can: false, reason: 'Only admins can add members.', who: 'known', mode: 'add' });
    const before = adds().length;
    const e = await reject(abouts.addMembers(id, { identities: [who('signal', 'Quinn')] }));
    expect(e.status).toBe(403);
    expect(e.message).toBe('Only admins can add members.');
    expect(adds().length).toBe(before);
  });

  test('someone in it already, someone from another network, too many at once', async () => {
    const id = conv('signal', 'Climbing crew');
    expect((await reject(abouts.addMembers(id, { identities: [who('signal', 'Alice Chen')] }))).status).toBe(409);
    const e = await reject(abouts.addMembers(id, { identities: [who('matrix', 'Ben')] }));
    expect(e.status).toBe(400);
    expect(e.message).toContain('Only Signal people');
    expect((await reject(abouts.addMembers(id, { identities: Array.from({ length: 11 }, (_, i) => `idn_${i}`) }))).status).toBe(400);
    expect((await reject(abouts.addMembers(id, { identities: [] }))).status).toBe(400);
  });
});

describe('Discord', () => {
  test('a group DM offers only friends, says how many more fit, and a non-friend comes back refused', async () => {
    const id = conv('discord', 'weekend raid');
    const v = await abouts.get('conversation', id);
    expect(v.adding).toEqual({ can: true, reason: 'Only your friends, up to 10 people in all.', who: 'friends', mode: 'add', room: 7 });
    const c = await abouts.candidates(id);
    expect(c.who).toBe('friends');
    expect(c.room).toBe(7);
    const offered = c.candidates.map((x) => x.identityId);
    expect(offered).toContain(who('discord', 'Alice'));
    expect(offered).not.toContain(who('discord', 'Ravi')); // in it
    expect(offered).not.toContain(who('discord', 'Mara')); // not a friend
    expect(c.candidates.every((x) => x.relationship === 'friend')).toBe(true);

    const r = await abouts.addMembers(id, { identities: [who('discord', 'Alice'), who('discord', 'Mara')] });
    expect(r.added).toEqual([who('discord', 'Alice')]);
    expect(r.failed).toEqual([{ identityId: who('discord', 'Mara'), reason: 'Discord adds only your friends to a group.' }]);
    expect(r.about?.adding?.room).toBe(6);
  });

  test('more than fit is refused before Discord hears of it', async () => {
    const id = conv('discord', 'weekend raid');
    const many = ['Jordan', 'Quinn', 'Lev', 'pixelfox', 'Mara', 'owl', 'Tim'].map((n) => who('discord', n));
    const before = adds().length;
    const e = await reject(abouts.addMembers(id, { identities: many }));
    expect(e.status).toBe(409);
    expect(e.message).toBe('Only 6 more fit here');
    expect(adds().length).toBe(before);
  });
});

describe('Matrix', () => {
  test('a room invites: they are in once they accept', async () => {
    const id = conv('matrix', 'Housemates');
    const v = await abouts.get('conversation', id);
    expect(v.adding).toEqual({ can: true, who: 'known', mode: 'invite' });
    const c = await abouts.candidates(id);
    expect(c.mode).toBe('invite');
    expect(c.candidates.map((x) => x.identityId)).toContain(who('matrix', 'kai'));
    expect(c.identities.some((i) => i.isBot)).toBe(false);
    const r = await abouts.addMembers(id, { identities: [who('matrix', 'kai')] });
    expect(r).toMatchObject({ added: [], invited: [who('matrix', 'kai')], failed: [] });
    expect(participants(id)).not.toContain(who('matrix', 'kai'));
  });
});

describe('without it', () => {
  test('a WhatsApp group says why there is no Add, and refuses one asked for anyway', async () => {
    const id = conv('whatsapp', 'Book club');
    const v = await abouts.get('conversation', id);
    expect(v.adding).toEqual({ can: false, reason: addMembersNotBuilt('whatsapp'), who: 'known', mode: 'add' });
    const someone = store.one<{ id: string }>(`SELECT id FROM identity WHERE network = 'whatsapp' AND display_name = 'Marco'`)!.id;
    const before = adds().length;
    const e = await reject(abouts.addMembers(id, { identities: [someone] }));
    expect(e.status).toBe(409);
    expect(e.message).toContain('WhatsApp');
    expect(adds().length).toBe(before);
  });

  test('a direct conversation has no adding at all', async () => {
    const id = store.one<{ id: string }>(`SELECT id FROM conversation WHERE network = 'signal' AND shape = 'direct' LIMIT 1`)!.id;
    expect((await abouts.get('conversation', id)).adding).toBeUndefined();
  });
});

describe('pace', () => {
  test('each person counts once; past the day it is all or none, saying how many would fit', async () => {
    const id = conv('signal', 'dither core');
    const acc = 'acc_demo-signal';
    const used = (store.db.query(`SELECT COUNT(*) AS n FROM add_pace WHERE account_id = ? AND kind = 'members'`).get(acc) as { n: number }).n;
    expect(used).toBe(2); // Quinn and Dad, above
    const now = Date.now();
    for (let i = used; i < ADD_LIMITS.members.max - 1; i++) store.db.query(`INSERT INTO add_pace (account_id, kind, at) VALUES (?, 'members', ?)`).run(acc, now - 1000);
    const before = adds().length;
    const e = await reject(abouts.addMembers(id, { identities: [who('signal', 'Mom'), who('signal', 'Mei')] }));
    expect(e.status).toBe(429);
    expect(e.message).toContain('(1 of the 2 would fit)');
    expect(adds().length).toBe(before);
    expect((store.db.query(`SELECT COUNT(*) AS n FROM add_pace WHERE account_id = ? AND kind = 'members'`).get(acc) as { n: number }).n).toBe(ADD_LIMITS.members.max - 1);
    const r = await abouts.addMembers(id, { identities: [who('signal', 'Mom')] });
    expect(r.added).toEqual([who('signal', 'Mom')]);
  });
});

describe("in the hub's log", () => {
  /** What console.warn got while `f` ran, and what `f` threw. */
  const warned = async (f: () => unknown) => {
    const lines: string[] = [];
    const spy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    let error: Error | null = null;
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
  const add = (id: string, b: { identities?: unknown; accountId?: unknown }, a = abouts) =>
    attempt({ kind: 'add', conversation: id, people: asked(b.identities) }, (x) => a.addMembers(id, b, x), (acc, line) => accountLog.push(`${acc} ${line}`));
  const nameOf = (id: string) => store.one<{ name: string }>('SELECT name FROM conversation WHERE id = ?', id)!.name;

  test('added, with someone refused: one added line, and failed counts them', async () => {
    const id = conv('discord', 'weekend raid');
    const { lines, error } = await warned(() => add(id, { identities: [who('discord', 'Jordan'), who('discord', 'Mara')] }));
    expect(error).toBeNull();
    expect(lines).toEqual([`members: added conversation=${id} account=acc_demo-discord-main network=discord added=1 invited=0 failed=1`]);
  });

  test("a bad shape: no account, nothing in an account's log; another of your accounts", async () => {
    const id = conv('signal', 'Climbing crew');
    const before = accountLog.length;
    const { lines } = await warned(() => add(id, { identities: [] }));
    expect(lines).toEqual([`members: add failed conversation=${id} account=- network=signal people=0 status=400 error="Pick 1 to 10 people"`]);
    expect(accountLog.length).toBe(before);
    const raid = conv('discord', 'weekend raid');
    const alt = store.account('acc_demo-discord-alt')!.self_identity!;
    const own = await warned(() => add(raid, { identities: [alt], accountId: 'acc_demo-discord-main' }));
    expect(own.lines).toEqual([`members: add failed conversation=${raid} account=acc_demo-discord-main network=discord people=1 status=400 error="That is one of your own accounts"`]);
  });

  test("a rule's refusal (403, 400), and the line in the account's log", async () => {
    const family = conv('signal', 'Family');
    const { lines } = await warned(() => add(family, { identities: [who('signal', 'Quinn')] }));
    expect(lines).toEqual([`members: add failed conversation=${family} account=acc_demo-signal network=signal people=1 status=403 error="Only admins can add members."`]);
    expect(accountLog.at(-1)).toBe(`acc_demo-signal [add] could not add people to ${nameOf(family)}: Only admins can add members.`);
    const crew = conv('signal', 'Climbing crew');
    const other = await warned(() => add(crew, { identities: [who('matrix', 'Ben')] }));
    expect(other.lines).toEqual([`members: add failed conversation=${crew} account=acc_demo-signal network=signal people=1 status=400 error="Only Signal people can be added to a Signal group"`]);
    expect(accountLog.at(-1)).toBe(`acc_demo-signal [add] could not add people to ${nameOf(crew)}: Only Signal people can be added to a Signal group`);
  });

  test('the pace (429)', async () => {
    // Signal's day is full since "pace", above.
    const id = conv('signal', 'dither core');
    const { lines, error } = await warned(() => add(id, { identities: [who('signal', 'Mei')] }));
    expect(error).toMatchObject({ status: 429 });
    expect(lines).toEqual([`members: add failed conversation=${id} account=acc_demo-signal network=signal people=1 status=429 error=${JSON.stringify(error!.message)}`]);
  });

  test("the adapter's refusal (502), and no answer (504)", async () => {
    const id = conv('matrix', 'Housemates');
    instead = async () => {
      throw new Error('M_FORBIDDEN: not allowed');
    };
    const refused = await warned(() => add(id, { identities: [who('matrix', 'Lina')] }));
    expect(refused.lines).toEqual([`members: add failed conversation=${id} account=acc_demo-matrix network=matrix people=1 status=502 error="M_FORBIDDEN: not allowed"`]);
    expect(accountLog.at(-1)).toBe(`acc_demo-matrix [add] could not add people to ${nameOf(id)}: M_FORBIDDEN: not allowed`);
    instead = async () => {
      throw new Error('adapter timed out on addMembers');
    };
    const slow = await warned(() => add(id, { identities: [who('matrix', 'Lina')] }));
    expect(slow.lines).toEqual([`members: add failed conversation=${id} account=acc_demo-matrix network=matrix people=1 status=504 error="Matrix did not answer in 90 seconds. It may still have gone through: look again in a minute."`]);
  });

  test('anything else (500) is logged, then thrown on as it was', async () => {
    const broken = new Abouts({
      ...deps,
      note: () => {
        throw new TypeError('the log is full');
      },
    });
    const id = conv('matrix', 'Housemates');
    const { lines, error } = await warned(() => add(id, { identities: [who('matrix', 'Lina')] }, broken));
    expect(error).toBeInstanceOf(TypeError);
    expect(lines).toEqual([`members: add failed conversation=${id} account=acc_demo-matrix network=matrix people=1 status=500 error="the log is full"`]);
  });

  test('candidates that fail; no such conversation, nothing known', async () => {
    const { lines } = await warned(() => candidatesAttempt('cnv_nope', () => abouts.candidates('cnv_nope')));
    expect(lines).toEqual(['members: candidates failed conversation=cnv_nope status=404 error="no such conversation"']);
    const gone = await warned(() => add('cnv_nope', { identities: ['idn_x'] }));
    expect(gone.lines).toEqual(['members: add failed conversation=cnv_nope account=- network=- people=1 status=404 error="no such conversation"']);
  });
});

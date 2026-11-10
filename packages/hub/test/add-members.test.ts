/**
 * Adding people to groups through the hub (about.ts addMembers and candidates, docs/group-settings.md), against the
 * demo world's adapters run in process: whom each account is offered, what a fresh About allows, what each network
 * does with the people (Discord only friends, Signal adds, Matrix invites), the pace per account, and the line a
 * network without it shows instead of a button.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { addMembersNotBuilt } from '@dither-chat/protocol';
import { AboutError, Abouts } from '../src/about.ts';
import { ADD_LIMITS } from '../src/add.ts';
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
  store.flush();
  abouts = new Abouts({
    store,
    online: () => true,
    command: <T>(account: string, cmd: any) =>
      new Promise<T>((resolve, rej) => {
        const id = crypto.randomUUID();
        sent.push({ account, cmd });
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject: rej });
        adapters.get(account)!.command({ ...cmd, id });
      }),
    pickAccount: (c, requested) => {
      const vs = store.vantageAccounts('conversation', c);
      return requested && vs.includes(requested) ? requested : (vs[0] ?? null);
    },
    note: (_a, line) => notes.push(line),
  });
});

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

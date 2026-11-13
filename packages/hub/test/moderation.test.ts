/**
 * Moderating through the hub (moderation.ts, docs/moderation.md), against the demo world's adapters run in process:
 * a Signal group's admin removes, bans, unbans and makes admins, sets a member label and leaves naming who takes over;
 * a Discord server's moderator kicks, gives a role and times someone out; others' messages and reactions; and the
 * refusals: not an admin, someone who outranks you, yourself, an action out of shape, the hour's limit.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { modActionProblem, modRefusal } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { Abouts } from '../src/about.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { Moderation, MOD_PER_HOUR, ModerationError } from '../src/moderation.ts';
import { mediaSigner } from '../src/server.ts';
import { Servers } from '../src/servers.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-mod-'));
let store: Store;
let mod: Moderation;
let abouts: Abouts;
let servers: Servers;
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const sent: { account: string; cmd: any }[] = [];
const notes: string[] = [];
const SIG = 'acc_demo-signal';
const MAIN = 'acc_demo-discord-main';
const ALT = 'acc_demo-discord-alt';
let clock = Date.now();

const conv = (network: string, name: string) => {
  const r = store.one<{ id: string }>('SELECT id FROM conversation WHERE network = ? AND name = ?', network, name);
  if (!r) throw new Error(`no conversation ${name}`);
  return r.id;
};
const space = (name: string) => store.one<{ id: string }>(`SELECT id FROM space WHERE network = 'discord' AND name = ?`, name)!.id;
const sig = (key: string) => hubId('idn', 'signal', store.one<{ native_id: string }>(`SELECT native_id FROM identity WHERE network = 'signal' AND display_name = ?`, key)!.native_id);
const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ModerationError;
  }
  throw new Error('it went through');
};

const deps = {
  get store() {
    return store;
  },
  online: () => true,
  command: <T>(account: string, cmd: any) => {
    sent.push({ account, cmd });
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
  abouts = new Abouts({ ...deps });
  mod = new Moderation({
    ...deps,
    keep: (k, i, n, a, ab) => (abouts.keep(i, a, ab), abouts.view(k, i, n, a, ab, Date.now(), undefined, true)),
    note: (_a, line) => notes.push(line),
    now: () => clock,
  });
  servers = new Servers({ ...deps, note: (_a, line) => notes.push(line) });
});

afterAll(() => {
  for (const a of adapters.values()) (a as unknown as { stop(): void }).stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the rules, before anything is asked', () => {
  test('an action out of shape', () => {
    expect(modActionProblem({ op: 'kick', who: 'x' })).toBe('unknown action');
    expect(modActionProblem({ op: 'remove' })).toBe('to whom?');
    expect(modActionProblem({ op: 'ban', who: 'x', deleteSeconds: 5 })).toBe('not one of the choices for deleting their messages');
    expect(modActionProblem({ op: 'timeout', who: 'x', seconds: 29 * 86400 })).toMatch(/at most 28 days/);
    expect(modActionProblem({ op: 'end' })).toBeNull();
  });

  test('a power the About does not give, someone above you, a role not below yours', () => {
    expect(modRefusal(undefined, { op: 'remove', who: 'x' })).toBe('You cannot do that here.');
    expect(modRefusal({ remove: { can: false, reason: 'Only admins can do this.' } }, { op: 'remove', who: 'x' })).toBe('Only admins can do this.');
    expect(modRefusal({ remove: { can: true } }, { op: 'remove', who: 'x' }, { above: true, reason: 'They own it.' })).toBe('They own it.');
    const roles = { roles: { can: true, assignable: ['r1'] } };
    expect(modRefusal(roles, { op: 'role', who: 'x', role: 'r2' }, {})).toMatch(/not below your own top role/);
    expect(modRefusal(roles, { op: 'role', who: 'x', role: 'r1' }, { roles: ['r1'] })).toBe('They have that role already.');
    expect(modRefusal(roles, { op: 'role', who: 'x', role: 'r1', remove: true }, { roles: [] })).toBe('They do not have that role.');
    expect(modRefusal({ remove: { can: true } }, { op: 'remove', who: 'x' }, undefined, false)).toBe('They are not in it now.');
  });
});

describe('a Signal group you admin', () => {
  test('the About says what you may, with labels and the banned', async () => {
    const v = await abouts.get('conversation', conv('signal', 'Climbing crew 🧗'), SIG);
    expect(v.moderation).toMatchObject({ remove: { can: true }, ban: { can: true }, admins: { can: true }, end: { can: true }, banned: [] });
    expect(v.label).toMatchObject({ value: null, canEdit: true, max: 24 });
    expect(v.leaving).toMatchObject({ can: true, canForget: true });
    expect(v.leaving?.needsAdmin).toBeUndefined();
  });

  test('remove, ban and unban: through the account, a line in its log, the About as it now stands', async () => {
    const id = conv('signal', 'Climbing crew 🧗');
    const theo = sig('Theo K');
    let v = await mod.moderate('conversation', id, { action: { op: 'remove', who: theo } });
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'moderate', action: { op: 'remove', who: store.nativeOf('identity', theo)!.nativeId } });
    expect(v.members!.list.some((m) => m.identityId === theo)).toBe(false);
    expect(notes.at(-1)).toBe('[moderate] removed Theo K in Climbing crew 🧗');
    const alice = sig('Alice Chen');
    v = await mod.moderate('conversation', id, { action: { op: 'ban', who: alice } });
    expect(v.moderation!.banned).toEqual([alice]);
    expect((await mod.bans('conversation', id)).banned).toEqual([{ identityId: alice }]);
    v = await mod.moderate('conversation', id, { action: { op: 'unban', who: alice } });
    expect(v.moderation!.banned).toEqual([]);
    expect((await reject(mod.moderate('conversation', id, { action: { op: 'unban', who: alice } }))).message).toBe('They are not banned here');
    // Gone: nothing more to do to them but ban.
    expect((await reject(mod.moderate('conversation', id, { action: { op: 'remove', who: theo } }))).message).toBe('They are not in it now.');
  });

  test('your own label', async () => {
    const id = conv('signal', 'Climbing crew 🧗');
    const v = await mod.setLabel(id, { text: ' belayer ', emoji: '🧗' });
    expect(v.label).toMatchObject({ value: 'belayer', emoji: '🧗' });
    expect(v.members!.list.find((m) => store.isSelf(m.identityId))?.label).toEqual({ text: 'belayer', emoji: '🧗' });
    expect((await reject(mod.setLabel(id, { text: 'x'.repeat(25) }))).status).toBe(400);
  });

  test('as its only admin, leaving names who takes over; never without', async () => {
    const id = conv('signal', 'Climbing crew 🧗');
    await mod.moderate('conversation', id, { action: { op: 'admin', who: sig('Priya'), remove: true } });
    const v = await abouts.get('conversation', id, SIG);
    expect(v.leaving).toMatchObject({ can: true, needsAdmin: true });
    const e = await reject(servers.leave('conversation', id, {}));
    expect(e.status).toBe(409);
    expect(e.message).toBe('You are its only admin: pick who becomes admin as you leave');
    expect((await reject(servers.leave('conversation', id, { admins: [hubId('idn', 'signal', 'nobody')] }))).status).toBe(400);
    expect(await servers.leave('conversation', id, { admins: [sig('Sam Rivera')] })).toEqual({ left: true });
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'leave', admins: [store.nativeOf('identity', sig('Sam Rivera'))!.nativeId] });
    expect(sent.at(-1)!.cmd.forget).toBeUndefined();
  });

  test('a group you do not admin: told why, nothing sent', async () => {
    const id = conv('signal', 'Family');
    const before = sent.length;
    const e = await reject(mod.moderate('conversation', id, { action: { op: 'remove', who: sig('Mei') } }));
    expect(e.status).toBe(403);
    expect(e.message).toBe('Only admins can do this.');
    expect(sent.slice(before).map((s) => s.cmd.t)).toEqual(['about']);
  });

  test('ending a group locks everything after', async () => {
    const id = conv('signal', 'dither core');
    const v = await mod.moderate('conversation', id, { action: { op: 'end' } });
    expect(v.moderation!.remove).toEqual({ can: false, reason: 'This group has been ended.' });
    expect(notes.at(-1)).toBe('[moderate] end the group in dither core');
  });
});

describe('a Discord server you moderate', () => {
  test('roles below yours, a timeout, a kick; someone as high as you is refused', async () => {
    const id = space('libdither');
    let v = await abouts.get('space', id, MAIN);
    expect(v.moderation).toMatchObject({ remove: { can: true }, ban: { can: true, deleteHistory: expect.any(Array) }, timeout: { can: true }, bansOnRequest: true });
    const contrib = v.roles!.find((r) => r.name === 'Contributor')!.id;
    expect(v.moderation!.roles!.assignable).toEqual([contrib]);
    const someone = v.members!.list.find((m) => !m.mod?.above && !store.isSelf(m.identityId))!;
    v = await mod.moderate('space', id, { action: { op: 'role', who: someone.identityId, role: contrib } });
    expect(v.members!.list.find((m) => m.identityId === someone.identityId)!.mod!.roles).toEqual([contrib]);
    expect(notes.at(-1)).toMatch(/^\[moderate\] gave .+ the Contributor role in libdither$/);
    v = await mod.moderate('space', id, { action: { op: 'timeout', who: someone.identityId, seconds: 3600 } });
    expect(v.members!.list.find((m) => m.identityId === someone.identityId)!.mod!.timedOutUntil).toBeGreaterThan(Date.now());
    expect((await reject(mod.moderate('space', id, { action: { op: 'timeout', who: someone.identityId, seconds: 7 } }))).message).toBe('not one of the timeout choices');
    const boss = v.members!.list.find((m) => m.mod?.above && !store.isSelf(m.identityId))!;
    expect((await reject(mod.moderate('space', id, { action: { op: 'remove', who: boss.identityId } }))).message).toBe('They have a role as high as yours.');
    const self = store.account(MAIN)!.self_identity!;
    expect((await reject(mod.moderate('space', id, { action: { op: 'remove', who: self } }))).message).toBe('That is one of your own accounts');
    await mod.moderate('space', id, { action: { op: 'remove', who: someone.identityId } });
    expect(notes.at(-1)).toMatch(/^\[moderate\] kicked .+ in libdither$/);
  });

  test('someone in voice: server mute and deafen, move to another voice channel, disconnect; no rank needed', async () => {
    const id = conv('discord', 'hangout');
    const v = await abouts.get('conversation', id, MAIN);
    expect(v.moderation).toMatchObject({ voiceMute: { can: true }, voiceDeafen: { can: true }, voiceMove: { can: true } });
    // Someone as high as you: kicking them is refused, muting them in voice is not (Discord's own member menu).
    const members = (await abouts.get('space', space('libdither'), MAIN)).members!.list;
    const someone = members.find((m) => m.mod?.above && !store.isSelf(m.identityId))!;
    await mod.moderate('conversation', id, { action: { op: 'voiceMute', who: someone.identityId, on: true }, accountId: MAIN });
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'moderate', action: { op: 'voiceMute', on: true, who: store.nativeOf('identity', someone.identityId)!.nativeId } });
    expect(notes.at(-1)).toMatch(/^\[moderate\] server-muted .+ in hangout$/);
    await mod.moderate('conversation', id, { action: { op: 'voiceDeafen', who: someone.identityId, on: false }, accountId: MAIN });
    expect(notes.at(-1)).toMatch(/^\[moderate\] server-undeafened /);
    // A move names the voice channel by its hub id; the adapter gets its native id.
    const other = conv('discord', 'hangout');
    await mod.moderate('conversation', id, { action: { op: 'move', who: someone.identityId, to: other }, accountId: MAIN });
    expect(sent.at(-1)!.cmd.action).toMatchObject({ op: 'move', to: store.nativeOf('conversation', other)!.nativeId });
    expect((await reject(mod.moderate('conversation', id, { action: { op: 'move', who: someone.identityId, to: conv('discord', 'general') }, accountId: MAIN }))).message).toBe('Move them to a voice channel of the same server');
    expect((await reject(mod.moderate('conversation', id, { action: { op: 'move', who: someone.identityId, to: conv('discord', 'General') }, accountId: MAIN }))).message).toBe('That voice channel is in another server.');
    await mod.moderate('conversation', id, { action: { op: 'disconnect', who: someone.identityId }, accountId: MAIN });
    expect(notes.at(-1)).toMatch(/^\[moderate\] disconnected .+ from voice in hangout$/);
    expect(modActionProblem({ op: 'voiceMute', who: 'x' })).toBe('on or off?');
    expect(modActionProblem({ op: 'move', who: 'x' })).toBe('to which voice channel?');
    expect(modRefusal({ voiceMove: { can: false, reason: 'You need the Move Members permission.' } }, { op: 'disconnect', who: 'x' })).toBe('You need the Move Members permission.');
    clock += 3_600_001;
  });

  test('an account without the permission is told which one', async () => {
    const e = await reject(mod.moderate('space', space('Rust Programming Language'), { action: { op: 'remove', who: hubId('idn', 'discord', 'x') } }));
    expect(e.status).toBe(404);
    const v = await abouts.get('space', space('Rust Programming Language'), MAIN);
    expect(v.moderation!.remove).toEqual({ can: false, reason: 'You need the Kick Members permission.' });
  });

  test("others' messages and reactions, as Manage Messages allows", async () => {
    // libdither's general, where the main account is a Maintainer.
    const id = (await Promise.all(store.db.query(`SELECT id FROM conversation WHERE network = 'discord' AND name = 'general'`).all().map(async (r: any) => ((await abouts.get('conversation', r.id, MAIN)).moderation?.remove?.can ? r.id : null)))).find(Boolean) as string;
    const self = store.account(MAIN)!.self_identity;
    const msg = store.one<{ id: string }>('SELECT id FROM message WHERE conversation_id = ? AND author_id IS NOT ? LIMIT 1', id, self)!.id;
    expect(await mod.clearReactions(msg, { key: '👍' })).toEqual({ ok: true });
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'clearReactions', key: '👍' });
    expect((await reject(mod.clearReactions(msg, { identityId: 'idn_x' }))).status).toBe(404);
    expect(await mod.deleteMessage(msg, { accountId: MAIN })).toEqual({ ok: true });
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'redact', moderator: true });
    expect(store.messageView(msg)?.deleted).toBeTruthy();
    expect(notes.at(-1)).toMatch(/^\[moderate\] deleted a message by .+ in general$/);
    // The alt account moderates nothing there.
    const other = store.one<{ id: string }>('SELECT id FROM message WHERE conversation_id = ? AND id != ? AND deleted = 0 LIMIT 1', id, msg);
    if (other) expect((await reject(mod.deleteMessage(other.id, { accountId: ALT }))).message).toBe('You need the Manage Messages permission here.');
  });

  test('at most so many an hour from one account', async () => {
    const id = space('libdither');
    const v = await abouts.get('space', id, MAIN);
    const someone = v.members!.list.find((m) => !m.mod?.above && !store.isSelf(m.identityId))!;
    // Refused ones take no slot; fill the hour by hand.
    (mod as unknown as { recent: Map<string, number[]> }).recent.set(MAIN, Array(MOD_PER_HOUR).fill(clock));
    const before = sent.length;
    const e = await reject(mod.moderate('space', id, { action: { op: 'ban', who: someone.identityId } }));
    expect(e.status).toBe(429);
    expect(e.message).toMatch(/the next frees up in 60 minutes/);
    expect(sent.slice(before).map((s) => s.cmd.t)).toEqual(['about']);
    clock += 3_600_001;
  });
});

/**
 * Servers beyond their channels through the hub (servers.ts, docs/servers.md), against the demo world's adapters run in
 * process: scheduled events kept as an account says them, saying Interested, the calendar's feed, leaving (refused
 * where you own it), a server's rules and onboarding answered step by step, your nickname, and invite links with limits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DISCORD_INVITE_OPTIONS, gateAnswerProblem } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { Abouts } from '../src/about.ts';
import { createDemoAccounts, DEMO_PIXEL_GUILD, demoFactory } from '../src/demo.ts';
import { mediaSigner } from '../src/server.ts';
import { Servers, ServersError } from '../src/servers.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-servers-'));
let store: Store;
let servers: Servers;
let abouts: Abouts;
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const sent: { account: string; cmd: { t: string } }[] = [];
const notes: string[] = [];
const MAIN = 'acc_demo-discord-main';

const space = (name: string) => {
  const r = store.one<{ id: string }>(`SELECT id FROM space WHERE network = 'discord' AND name = ?`, name);
  if (!r) throw new Error(`no space ${name}`);
  return r.id;
};
const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ServersError;
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
  servers = new Servers({ ...deps, note: (_a, line) => notes.push(line), aboutView: (k, i, n, a, ab) => abouts.view(k, i, n, a, ab, Date.now(), undefined, true) });
});

afterAll(() => {
  for (const a of adapters.values()) (a as unknown as { stop(): void }).stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scheduled events', () => {
  test('kept as the account said them at start, soonest first, with the place, the counts and your answer', async () => {
    const v = await servers.events(space('libdither'), MAIN);
    expect(v.canRsvp).toBe(true);
    expect(v.events.map((e) => e.name)).toEqual(['Dither sync', 'Meetup at the lab']);
    const sync = v.events[0];
    expect(sync.place).toEqual({ kind: 'voice', conversationId: expect.stringMatching(/^cnv_/) });
    expect(sync).toMatchObject({ interested: 6, youInterested: true, status: 'scheduled', network: 'discord' });
    expect(sync.url).toBe(`https://discord.com/events/${store.nativeOf('space', space('libdither'))!.nativeId}/evt-dither-sync`);
    expect(v.events[1].place).toEqual({ kind: 'external', location: 'Hackerspace, 2nd floor' });
  });

  test('fresh asks the network again; a repeating one keeps its rule and its called-off occurrence', async () => {
    const before = sent.length;
    const v = await servers.events(space('Rust Programming Language'), MAIN, true);
    expect(sent.slice(before).map((s) => s.cmd.t)).toEqual(['scheduledEvents']);
    const office = v.events.find((e) => e.name === 'Rust office hours')!;
    expect(office.rrule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU');
    expect(office.exceptions).toEqual([expect.objectContaining({ cancelled: true })]);
  });

  test('Interested and back: through the account, the count follows, and a line in its log', async () => {
    const id = space('Rust Programming Language');
    const office = (await servers.events(id, MAIN)).events.find((e) => e.name === 'Rust office hours')!;
    const on = await servers.rsvp(id, office.id, { interested: true });
    expect(on).toMatchObject({ youInterested: true, interested: 215 });
    expect((await servers.events(id, MAIN)).events.find((e) => e.id === office.id)!.youInterested).toBe(true);
    const off = await servers.rsvp(id, office.id, { interested: false });
    expect(off).toMatchObject({ youInterested: false, interested: 214 });
    expect(notes.at(-1)).toBe('[event] no longer interested in Rust office hours');
  });

  test('one occurrence of a repeating event, and refusals before anything is asked', async () => {
    const id = space('Rust Programming Language');
    const office = (await servers.events(id, MAIN)).events.find((e) => e.name === 'Rust office hours')!;
    const one = await servers.rsvp(id, office.id, { interested: true, occurrence: 'ex-rust-office-2' });
    expect(one.exceptions.find((x) => x.nativeId === 'ex-rust-office-2')?.youInterested).toBe(true);
    expect((await reject(servers.rsvp(id, office.id, { interested: 'yes' }))).status).toBe(400);
    expect((await reject(servers.rsvp(id, hubId('evt', 'discord', 'nope'), { interested: true }))).status).toBe(404);
    const sync = (await servers.events(space('libdither'), MAIN)).events[0];
    expect((await reject(servers.rsvp(space('libdither'), sync.id, { interested: true, occurrence: '1' }))).message).toBe('This event does not repeat');
  });

  test("the calendar's feed: times, the rule, called-off occurrences, the place in words", () => {
    const feed = servers.calendarFeed(0);
    const office = feed.events.find((e) => e.title === 'Rust office hours')!;
    expect(office).toMatchObject({ allDay: false, timeZone: 'UTC', rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU', location: 'General · Rust Programming Language', place: 'Rust Programming Language' });
    expect(office.exdates).toHaveLength(1);
    expect(feed.events.find((e) => e.title === 'Meetup at the lab')?.location).toBe('Hackerspace, 2nd floor');
    expect(servers.calendarFeed(Date.now() + 60_000).events).toEqual([]);
    // Every account's, once each: libdither's events are seen by both Discord accounts.
    expect(feed.events.filter((e) => e.title === 'Dither sync')).toHaveLength(1);
  });
});

describe('invite links', () => {
  test('a server lists its links with the dialog\'s choices and its vanity address; a link made with limits, then turned off', async () => {
    const id = space('libdither');
    const v = await abouts.get('space', id, MAIN);
    expect(v.invite?.options).toEqual(DISCORD_INVITE_OPTIONS);
    expect(v.invite?.vanity).toBe('https://discord.gg/libdither');
    const made = await abouts.configure('space', id, { key: 'invite', op: 'create', maxAge: 3600, maxUses: 5 }, MAIN);
    const link = made.invite!.links![0];
    expect(link).toMatchObject({ maxUses: 5, uses: 0, canRevoke: true });
    expect(link.expiresAt! - Date.now()).toBeGreaterThan(3500_000);
    expect(made.invite!.link).toBe(link.url);
    const off = await abouts.configure('space', id, { key: 'invite', op: 'revoke', code: link.code }, MAIN);
    expect(off.invite!.links).toEqual([]);
    await expect(abouts.configure('space', id, { key: 'invite', op: 'create', maxAge: -1 }, MAIN)).rejects.toThrow('an expiry and a use limit are whole numbers');
  });
});

describe('nickname', () => {
  test('set, shown in the About, and cleared; too long is refused before asking', async () => {
    const id = space('libdither');
    const v = (await servers.setNick(id, { nick: ' zyan ', accountId: MAIN })) as P.AboutView;
    expect(v.nick).toMatchObject({ value: 'zyan', canEdit: true });
    expect(((await servers.setNick(id, { nick: '' })) as P.AboutView).nick?.value).toBeNull();
    expect((await reject(servers.setNick(id, { nick: 'x'.repeat(33) }))).status).toBe(400);
  });
});

describe('gates', () => {
  test('rules, then onboarding, each the owner\'s own answer; nothing left after', async () => {
    // As if the account had just joined it (docs/add.md): the hub has the space and the account's vantage.
    const nativeId = DEMO_PIXEL_GUILD;
    store.ingest(store.account(MAIN)!, { t: 'space', space: { nativeId, kind: 'community', name: 'Pixel Art Club' } });
    const id = hubId('spc', 'discord', nativeId);
    const g = await servers.gate(id, MAIN);
    expect(g.gate?.kind).toBe('rules');
    expect(g.gate?.rules).toHaveLength(3);
    // Never answered for the owner: no tick, no request.
    const before = sent.filter((s) => s.cmd.t === 'answerGate').length;
    expect((await reject(servers.answerGate(id, { answer: { kind: 'rules' } }))).message).toBe('Agreeing to the rules is yours to do: tick that you agree');
    expect(sent.filter((s) => s.cmd.t === 'answerGate').length).toBe(before);
    const r = await servers.answerGate(id, { answer: { kind: 'rules', agree: true } });
    expect(r.done).toBe(true);
    expect(r.next?.kind).toBe('onboarding');
    expect((await reject(servers.answerGate(id, { answer: { kind: 'onboarding', picks: [] } }))).message).toBe('Pick something for "What do you make?"');
    const done = await servers.answerGate(id, { answer: { kind: 'onboarding', picks: ['o-sprites', 'o-yes'] } });
    expect(done).toEqual({ done: true, next: null });
    expect((await servers.gate(id, MAIN)).gate).toBeNull();
  });

  test('gateAnswerProblem checks an application\'s questions', () => {
    const gate: P.SpaceGate = { space: 's', kind: 'apply', questions: [{ id: '0', kind: 'text', label: 'Why join?', required: true }, { id: '1', kind: 'choice', label: 'Level', required: false, choices: ['New', 'Old'] }] };
    expect(gateAnswerProblem(gate, { kind: 'apply', answers: {} })).toBe('Answer "Why join?"');
    expect(gateAnswerProblem(gate, { kind: 'apply', answers: { '0': 'art', '1': 5 } })).toBe('Pick one of the answers to "Level"');
    expect(gateAnswerProblem(gate, { kind: 'apply', answers: { '0': 'art', '1': 1 } })).toBeNull();
  });
});

describe('leaving', () => {
  test('refused where you own it, in words, before anything is asked', async () => {
    const e = await reject(servers.leave('space', space('libdither'), { accountId: MAIN }));
    expect(e.status).toBe(403);
    expect(e.message).toMatch(/^You own this server/);
    expect(sent.some((s) => s.cmd.t === 'leave')).toBe(false);
  });

  test('a server you are only in: left, with its channels and events, and a line in the log', async () => {
    const id = space('Rust Programming Language');
    expect(await servers.leave('space', id, {})).toEqual({ left: true });
    expect(store.vantageAccounts('space', id)).toEqual([]);
    expect(store.one(`SELECT 1 FROM conversation WHERE network = 'discord' AND name = 'General' AND id IN (SELECT target_id FROM vantage WHERE account_id = ?)`, MAIN)).toBeNull();
    expect(store.one('SELECT 1 FROM scheduled_event WHERE space_id = ?', id)).toBeNull();
    expect(notes.at(-1)).toBe('[leave] left Rust Programming Language');
  });
});

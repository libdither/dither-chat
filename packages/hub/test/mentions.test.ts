/**
 * The composer's @ picker on the hub (mentions.ts, docs/mentions.md), against the demo world's adapters run in
 * process: the rows a conversation offers from what the hub stores and what the network answers, their order, what a
 * row inserts, @everyone only where the account may, the account the composer sends from, and an answer that is late
 * or missing. Nothing the network names is stored.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { emptyTally } from '../src/attention.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { cleanQuery, matchTier, mentionables, type MentionDeps } from '../src/mentions.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-mentions-'));
let store: Store;
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const asked: { account: string; query: string }[] = [];
/** Instead of the adapter's answer, for the next command. */
let instead: (() => Promise<unknown>) | null = null;

const conv = (net: P.Network, name: string, space?: string) => {
  const r = store.one<{ id: string }>(
    `SELECT c.id FROM conversation c WHERE c.network = ? AND c.name LIKE ? || '%' ${space ? `AND EXISTS (SELECT 1 FROM space_edge e JOIN space_edge e2 ON e2.child_id = e.parent_id JOIN space s ON s.id = e2.parent_id WHERE e.child_id = c.id AND s.name = ?)` : ''}`,
    net,
    name,
    ...(space ? [space] : []),
  );
  if (!r) throw new Error(`no ${net} conversation ${name}`);
  return r.id;
};
const acc = (key: string) => `acc_demo-${key}`;
const count = (table: string) => store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;

const deps: MentionDeps = {
  get store() {
    return store;
  },
  online: () => true,
  command: <T>(account: string, cmd: { t: 'mentionables'; conversation: string; query: string; limit: number }) => {
    asked.push({ account, query: cmd.query });
    if (instead) {
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
const view = (id: string, q = '', x: Record<string, string> = {}) => mentionables(deps, id, new URLSearchParams({ q, ...x })) as Promise<P.MentionablesView>;
const names = (v: P.MentionablesView) => v.rows.map((r) => r.name);

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  store.db.transaction(() => {
    for (const a of createDemoAccounts(store)) {
      const adir = join(dir, a.id);
      mkdirSync(adir, { recursive: true });
      const ad = demoFactory(a, adir)!;
      adapters.set(a.id, ad);
      ad.start((ev) => {
        if (ev.t === 'reply') {
          const p = pending.get(ev.id);
          pending.delete(ev.id);
          if (ev.ok) p?.resolve(ev.result);
          else p?.reject(new Error(ev.error));
          return;
        }
        store.ingest(store.account(a.id)!, ev);
      });
    }
  })();
  store.flush();
});

afterAll(() => {
  for (const a of adapters.values()) (a as unknown as { stop(): void }).stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('matching', () => {
  test('a name matches whole, at its start, at a word, anywhere, or not at all', () => {
    expect(matchTier(['Quinn'], 'quinn')).toBe(4);
    expect(matchTier(['Quinn'], 'qu')).toBe(3);
    expect(matchTier(['Sam Rivera'], 'riv')).toBe(2);
    expect(matchTier(['quinn.dev'], 'dev')).toBe(2);
    expect(matchTier(['pixelfox'], 'fox')).toBe(1);
    expect(matchTier(['Lev'], 'x')).toBe(0);
    // Any of the names counts, the best of them.
    expect(matchTier(['Theo', 'theo.k'], 'theo.k')).toBe(4);
    // Nothing typed: everyone alike.
    expect(matchTier(['Lev'], '')).toBe(1);
    expect(cleanQuery('@@Qu ')).toBe('qu');
  });
});

describe('Discord', () => {
  test('a server channel with nothing typed: who wrote there lately, then its roles, then @everyone and @here where you may', async () => {
    asked.length = 0;
    const v = await view(conv('discord', 'dev', 'libdither'), '', { account: acc('discord-main') });
    expect(v.partial).toBeUndefined();
    expect(asked).toEqual([{ account: acc('discord-main'), query: '' }]);
    const people = v.rows.filter((r) => r.kind === 'identity');
    expect(people.map((r) => r.name).sort()).toEqual(['Lev', 'Quinn', 'dither-ci']);
    // Never you.
    expect(names(v)).not.toContain('zyan');
    for (const r of people) {
      expect(r.insert).toMatch(/^<@\d+> $/);
      expect(r.pings).toBe(true);
      expect(r.section).toBe('here');
      expect(r.network).toBe('discord');
      expect(r.identityId).toMatch(/^idn_/);
    }
    expect(people.find((r) => r.name === 'dither-ci')!.isBot).toBe(true);
    // Who spoke last first, on a tie.
    expect(people[0].name).toBe('Quinn');
    const kinds = v.rows.map((r) => r.kind);
    expect(kinds.slice(-4)).toEqual(['role', 'role', 'everyone', 'here']);
    expect(v.rows.find((r) => r.name === 'core')).toMatchObject({ insert: expect.stringMatching(/^<@&\d+> $/), color: '#e67e22', roleId: expect.any(String) });
    expect(v.rows.find((r) => r.kind === 'everyone')!.insert).toBe('@everyone ');
    expect(v.rows.find((r) => r.kind === 'here')!.insert).toBe('@here ');
  });

  test('typing a name: the best match first, members the hub never stored come from the network, and none is stored', async () => {
    const identities = count('identity');
    const members = count('membership');
    const v = await view(conv('discord', 'dev', 'libdither'), 'qui', { account: acc('discord-main') });
    expect(v.rows[0].name).toBe('Quinn');
    // quin, quin_dev, ...: the server's members by that name, from the network alone.
    const fromNet = v.rows.filter((r) => r.kind === 'identity' && !r.identityId);
    expect(fromNet.length).toBeGreaterThan(3);
    expect(fromNet.every((r) => /^quin/.test(r.name) && /^<@\d+> $/.test(r.insert))).toBe(true);
    // Not a role nor @everyone that does not match.
    expect(v.rows.some((r) => r.kind !== 'identity')).toBe(false);
    expect(count('identity')).toBe(identities);
    expect(count('membership')).toBe(members);
  });

  test('@ev finds @everyone; a role by its name', async () => {
    const id = conv('discord', 'dev', 'libdither');
    expect((await view(id, 'ev', { account: acc('discord-main') })).rows.map((r) => r.kind)).toContain('everyone');
    const r = await view(id, 'review', { account: acc('discord-main') });
    expect(r.rows[0]).toMatchObject({ kind: 'role', name: 'reviewers' });
  });

  test('the account the composer sends from is the one asked: the alt is no admin there, so no @everyone', async () => {
    asked.length = 0;
    const v = await view(conv('discord', 'dev', 'libdither'), '', { account: acc('discord-alt') });
    expect(asked[0].account).toBe(acc('discord-alt'));
    expect(v.rows.some((r) => r.kind === 'everyone' || r.kind === 'here')).toBe(false);
    // Each account is left out as you.
    expect(names(v)).not.toContain('zyn');
  });

  test('a direct conversation: the person in it', async () => {
    const id = store.one<{ id: string }>(
      `SELECT c.id FROM conversation c JOIN participant p ON p.conversation_id = c.id JOIN identity i ON i.id = p.identity_id WHERE c.network = 'discord' AND c.shape = 'direct' AND i.display_name = 'Alice'`,
    )!.id;
    const v = await view(id);
    expect(names(v)).toEqual(['Alice']);
  });

  test('how much you talk with someone puts them first among names that match alike', async () => {
    const id = conv('discord', 'dev', 'libdither');
    const lev = store.one<{ id: string; person_id: string | null }>(`SELECT id, person_id FROM identity WHERE network = 'discord' AND display_name = 'Lev'`)!;
    const before = (await view(id, '', { account: acc('discord-main') })).rows.filter((r) => r.kind === 'identity').map((r) => r.name);
    expect(before.indexOf('Lev')).toBeGreaterThan(0);
    const t = { ...emptyTally(), at: Date.now(), addressed: 6, replied: 5 };
    store.db.query('INSERT OR REPLACE INTO conv_author_feature (conversation_id, author_key, tally) VALUES (?, ?, ?)').run('cnv_elsewhere', lev.person_id ?? lev.id, JSON.stringify(t));
    const after = (await view(id, '', { account: acc('discord-main') })).rows.filter((r) => r.kind === 'identity').map((r) => r.name);
    expect(after[0]).toBe('Lev');
    store.db.query(`DELETE FROM conv_author_feature WHERE conversation_id = 'cnv_elsewhere'`).run();
  });

  test('no answer in time: what the hub knows, marked partial', async () => {
    instead = () => new Promise(() => {});
    // The hub's wait, made short: the network never answers.
    const v = (await mentionables({ ...deps, wait: 5 }, conv('discord', 'dev', 'libdither'), new URLSearchParams({ q: '', account: acc('discord-main') })))!;
    expect(v.partial).toBe(true);
    expect(v.rows.filter((r) => r.kind === 'identity').map((r) => r.name).sort()).toEqual(['Lev', 'Quinn', 'dither-ci']);
    expect(v.rows.some((r) => r.kind !== 'identity')).toBe(false);
  });

  test('a failed answer is the same, and an account that is not connected is not asked', async () => {
    instead = () => Promise.reject(new Error('Discord changed'));
    expect((await view(conv('discord', 'dev', 'libdither'), '', { account: acc('discord-main') })).partial).toBe(true);
    asked.length = 0;
    const off = await mentionables({ ...deps, online: () => false }, conv('discord', 'dev', 'libdither'), new URLSearchParams({ q: '' }));
    expect(asked).toEqual([]);
    expect(off!.partial).toBe(true);
  });
});

describe('networks without the command', () => {
  test("a Signal group: its people, from the hub alone, and it is not partial: the hub knows who is in it", async () => {
    asked.length = 0;
    const v = await view(conv('signal', 'Climbing crew'));
    expect(asked).toEqual([]);
    expect(v.partial).toBeUndefined();
    const people = v.rows.map((r) => r.name);
    for (const n of ['Alice Chen', 'Sam Rivera', 'Priya', 'Theo K']) expect(people).toContain(n);
    expect(people).not.toContain('zyan');
    expect(v.rows.every((r) => r.kind === 'identity' && r.insert.startsWith('<@') && r.network === 'signal')).toBe(true);
    // Typing narrows it.
    expect(names(await view(conv('signal', 'Climbing crew'), 'pri'))).toEqual(['Priya']);
  });

  test('a WhatsApp group: its participants the same way', async () => {
    asked.length = 0;
    const v = await view(conv('whatsapp', 'Book club'));
    expect(asked).toEqual([]);
    expect(names(v).sort()).toEqual(['Alice Chen', 'Inês', 'Marco']);
    expect(v.rows.every((r) => /^<@\d+@s\.whatsapp\.net> $/.test(r.insert))).toBe(true);
  });
});

describe('Matrix', () => {
  test('@room where your power level allows it, and never @here', async () => {
    const house = await view(conv('matrix', 'Housemates'));
    expect(house.rows.filter((r) => r.kind === 'everyone')).toEqual([{ kind: 'everyone', insert: '@room ', pings: true, section: 'here', name: 'room', network: 'matrix' }]);
    expect(house.rows.some((r) => r.kind === 'here')).toBe(false);
    for (const r of house.rows.filter((r) => r.kind === 'identity')) expect(r.insert).toMatch(/^<@@[\w.-]+:[\w.-]+> $/);
  });
});

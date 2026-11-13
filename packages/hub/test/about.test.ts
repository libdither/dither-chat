/**
 * About and settings through the hub (about.ts, docs/group-settings.md), against the demo world's adapters run in
 * process: what each account may change and why not, changes refused before they reach a network, what is kept
 * for when an account is offline, and the panel an adapter without `about` still gets.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { AboutError, Abouts, readOnly, refusalOf } from '../src/about.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-about-'));
let store: Store;
let abouts: Abouts;
const offline = new Set<string>();
const sent: { account: string; cmd: { t: string } }[] = [];
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const conv = (net: P.Network, pred: (c: P.ConversationView) => boolean) => {
  const ids = (store.db.query('SELECT id FROM conversation WHERE network = ?').all(net) as { id: string }[]).map((r) => r.id);
  const c = store.conversationViews(ids).find(pred);
  if (!c) throw new Error(`no such ${net} conversation`);
  return c;
};
const space = (net: P.Network, name: string) => store.one<{ id: string }>('SELECT id FROM space WHERE network = ? AND name = ?', net, name)!.id;
const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as AboutError;
  }
  throw new Error('it went through');
};

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
  abouts = new Abouts({
    store,
    online: (a) => !offline.has(a),
    command: <T>(account: string, cmd: any) =>
      new Promise<T>((resolve, rej) => {
        const id = crypto.randomUUID();
        sent.push({ account, cmd });
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject: rej });
        adapters.get(account)!.command({ ...cmd, id });
      }),
    pickAccount: (c, requested) => {
      const vs = store.vantageAccounts('conversation', c);
      return requested && vs.includes(requested) ? requested : (vs.find((a) => !offline.has(a)) ?? vs[0] ?? null);
    },
  });
});

afterAll(() => {
  for (const a of adapters.values()) (a as unknown as { stop(): void }).stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reading', () => {
  test('a Signal group you administer: everything editable, members with their roles', async () => {
    const c = conv('signal', (c) => c.name === 'Climbing crew 🧗');
    const v = await abouts.get('conversation', c.id);
    expect(v.accountId).toBe('acc_demo-signal');
    expect(v.stale).toBeUndefined();
    expect(v.canConfigure).toBe(true);
    expect(v.fields.name).toEqual({ value: 'Climbing crew 🧗', canEdit: true });
    expect(v.fields.disappearing?.value).toBe(7 * 86_400);
    expect(v.fields.encrypted).toMatchObject({ value: true, canEdit: false });
    // Signal cannot say whether approval is on.
    expect(v.fields.joinApproval?.value).toBeNull();
    expect(v.members?.list.length).toBe(5);
    expect(v.members?.list.every((m) => m.identityId.startsWith('idn_'))).toBe(true);
    expect(v.members?.list.find((m) => m.identityId === store.accounts().find((a) => a.id === 'acc_demo-signal')!.self_identity)?.role).toBe('Admin');
    expect(v.invite?.link).toContain('signal.group');
  });

  test('a Signal group where only admins edit and you are not one: no setting editable, and why; pinning still is', async () => {
    const v = await abouts.get('conversation', conv('signal', (c) => c.name === 'Family').id);
    expect(v.fields.name).toMatchObject({ canEdit: false, reason: expect.stringContaining('Only admins') });
    expect(Object.values(v.fields).some((f) => f?.canEdit)).toBe(false);
    // Whoever may send may pin (docs/polls.md), so the About still changes something.
    expect(v.pinned?.canEdit).toBe(true);
    expect(v.canConfigure).toBe(true);
    expect(v.rules?.find((r) => r.what.startsWith('Edit name'))).toMatchObject({ who: 'Only admins', you: false });
  });

  test('one Discord server, two accounts: the owner may rename it, the member is told what it lacks', async () => {
    const id = space('discord', 'libdither');
    const main = await abouts.get('space', id, 'acc_demo-discord-main');
    const alt = await abouts.get('space', id, 'acc_demo-discord-alt');
    expect(main.fields.name?.canEdit).toBe(true);
    expect(alt.fields.name).toMatchObject({ canEdit: false, reason: 'You need the Manage Server permission.' });
    expect(alt.accountId).toBe('acc_demo-discord-alt');
    expect(main.roles?.map((r) => r.name)).toEqual(['Maintainer', 'Contributor', '@everyone']);
    // The member list loads lazily on Discord.
    expect(main.members?.complete).toBe(false);
    // Strangers are not in the bootstrap, so their identities come with the answer.
    expect(main.identities.map((i) => i.id).sort()).toEqual(main.members!.list.map((m) => m.identityId).sort());
  });

  test('pinned messages come back as the messages the hub has', async () => {
    const v = await abouts.get('conversation', conv('discord', (c) => c.name === 'general' && c.vantages.length === 2).id, 'acc_demo-discord-main');
    expect(v.pinned?.messages.map((m) => m.body)).toEqual(['pinned the getting-started doc']);
    expect(v.pinned?.missing).toBe(0);
  });

  test('a Matrix room where you are a moderator: name yes, join rule no, with the levels', async () => {
    const v = await abouts.get('conversation', conv('matrix', (c) => c.name === 'libdither').id);
    expect(v.fields.name?.canEdit).toBe(true);
    expect(v.fields.joinRule).toEqual({ value: 'ask', canEdit: false, reason: 'Needs power level 100; yours is 50.' });
    expect(v.you).toEqual({ role: 'Moderator', rank: 50 });
    expect(v.invite).toMatchObject({ derived: true, canCreate: false });
  });
});

describe('changing', () => {
  test('a name changes on the network, and the conversation with it', async () => {
    const c = conv('whatsapp', (c) => c.name === 'Book club 📚');
    const v = await abouts.configure('conversation', c.id, { key: 'name', value: 'Book club' });
    expect(v.fields.name?.value).toBe('Book club');
    expect(store.conversationView(c.id)?.name).toBe('Book club');
    expect(sent.at(-1)?.cmd).toMatchObject({ t: 'configure', change: { key: 'name', value: 'Book club' } });
  });

  test('a change the account may not make is refused with the network’s reason, and never sent', async () => {
    const c = conv('signal', (c) => c.name === 'Family');
    const before = sent.length;
    const e = await reject(abouts.configure('conversation', c.id, { key: 'name', value: 'Fam' }));
    expect(e.status).toBe(403);
    expect(e.message).toContain('Only admins');
    expect(sent.slice(before).map((s) => s.cmd.t)).toEqual(['about']);
  });

  test('a change the network does not have is refused before any adapter hears of it', async () => {
    const before = sent.length;
    const wa = conv('whatsapp', (c) => c.name === 'Book club');
    expect((await reject(abouts.configure('conversation', wa.id, { key: 'disappearing', value: 3600 }))).message).toContain('not one of the timers');
    expect((await reject(abouts.configure('conversation', wa.id, { key: 'slowMode', value: 10 }))).message).toContain('not a setting here');
    expect((await reject(abouts.configure('conversation', wa.id, { key: 'name', value: '  ' }))).status).toBe(400);
    expect(sent.length).toBe(before);
  });

  test('a timer, a permission and the invite link', async () => {
    const c = conv('signal', (c) => c.name === 'Climbing crew 🧗');
    expect((await abouts.configure('conversation', c.id, { key: 'disappearing', value: 90 })).fields.disappearing?.value).toBe(90);
    expect((await abouts.configure('conversation', c.id, { key: 'editInfo', value: 'admins' })).fields.editInfo?.value).toBe('admins');
    const off = await abouts.configure('conversation', c.id, { key: 'invite', op: 'revoke' });
    expect(off.invite?.link).toBeNull();
    expect((await abouts.configure('conversation', c.id, { key: 'invite', op: 'create' })).invite?.link).toContain('signal.group');
  });

  test('pinning and unpinning', async () => {
    const c = conv('discord', (c) => c.name === 'general' && c.vantages.length === 2);
    const first = (await abouts.get('conversation', c.id, 'acc_demo-discord-main')).pinned!.messages[0];
    const other = store.messages(c.id, null, 10).messages.find((m) => m.id !== first.id)!;
    const pinned = await abouts.configure('conversation', c.id, { key: 'pin', message: other.nativeId }, 'acc_demo-discord-main');
    expect(pinned.pinned?.messages.map((m) => m.id)).toEqual([other.id, first.id]);
    const unpinned = await abouts.configure('conversation', c.id, { key: 'pin', message: other.nativeId, remove: true }, 'acc_demo-discord-main');
    expect(unpinned.pinned?.messages.map((m) => m.id)).toEqual([first.id]);
  });
});

describe('without the network', () => {
  test('an offline account: the last answer, read-only, saying why', async () => {
    const c = conv('signal', (c) => c.name === 'Climbing crew 🧗');
    offline.add('acc_demo-signal');
    try {
      const v = await abouts.get('conversation', c.id);
      expect(v.stale).toContain('not connected');
      expect(v.fields.name).toMatchObject({ value: 'Climbing crew 🧗', canEdit: false });
      expect(v.fields.disappearing?.value).toBe(90);
      expect(v.canConfigure).toBe(false);
      expect((await reject(abouts.configure('conversation', c.id, { key: 'name', value: 'x' }))).status).toBe(409);
    } finally {
      offline.delete('acc_demo-signal');
    }
  });

  test('an adapter that cannot read settings: what the hub stores, read-only', async () => {
    const acc = store.createAccount({ network: 'matrix', label: 'old', color: '#000', adapter: 'matrix' });
    store.ingest(acc, { t: 'hello', network: 'matrix', version: '1', capabilities: ['send'] });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: '!old:x.org', shape: 'group', name: 'Old room', topic: 'kept', participants: ['@a:x.org', '@b:x.org'] } });
    const v = await abouts.get('conversation', hubId('cnv', 'matrix', '!old:x.org'));
    expect(v.stale).toContain('cannot read settings');
    expect(v.fields.topic).toMatchObject({ value: 'kept', canEdit: false });
    expect(v.members?.list.map((m) => m.identityId).sort()).toEqual([hubId('idn', 'matrix', '@a:x.org'), hubId('idn', 'matrix', '@b:x.org')].sort());
  });
});

describe('the rules, as plain functions', () => {
  const about: P.About = {
    fields: { name: { value: 'x', canEdit: false, reason: 'no' }, topic: { value: '', canEdit: true } },
    invite: { link: null, canCreate: true },
    pinned: { messages: [], canEdit: false },
  };
  test('refusalOf', () => {
    expect(refusalOf(about, { key: 'name', value: 'y' })).toBe('no');
    expect(refusalOf(about, { key: 'topic', value: 'y' })).toBeNull();
    expect(refusalOf(about, { key: 'disappearing', value: 0 })).toContain('not a setting here');
    expect(refusalOf(about, { key: 'invite', op: 'create' })).toBeNull();
    expect(refusalOf(about, { key: 'invite', op: 'revoke' })).toBeTruthy();
    expect(refusalOf(about, { key: 'pin', message: 'm' })).toBeTruthy();
  });
  test('readOnly', () => {
    const r = readOnly(about, 'offline');
    expect(Object.values(r.fields).every((f) => !f?.canEdit && f?.reason === 'offline')).toBe(true);
    expect(r.invite?.canCreate).toBe(false);
  });
});

describe('members seen (adversarial, passive)', () => {
  test("a server's About says how many members were seen only with the members setting on", async () => {
    const id = space('discord', 'libdither');
    const before = store.retention();
    expect((await abouts.get('space', id)).coverage).toBeUndefined();
    store.setRetention({ ...before, adversarial: true, members: true });
    try {
      const dmain = store.accounts().find((a) => a.network === 'discord' && store.vantageAccounts('space', id).includes(a.id))!;
      const native = store.nativeOf('space', id)!.nativeId;
      store.ingest(dmain, { t: 'members', space: native, source: 'seen', members: [{ who: 'm1' }, { who: 'm2' }], total: 200, online: 30, ts: 5 });
      expect((await abouts.get('space', id)).coverage).toEqual({ seen: 2, total: 200, online: 30, fraction: 0.01, lastSeenAt: 5, reportedAt: 5 });
      // A section is not a server of its own.
      expect((await abouts.get('space', space('discord', 'General'))).coverage).toBeUndefined();
    } finally {
      store.setRetention(before);
    }
  });
});

describe('a new demo world', () => {
  test('starts from the first names and settings (a fresh hub, Reset demo, the next test run)', async () => {
    // The tests above renamed the book club and set the climbers' timer to 90 s.
    const climb = conv('signal', (c) => c.name === 'Climbing crew 🧗');
    expect((await abouts.get('conversation', climb.id)).fields.disappearing?.value).toBe(90);
    const again = new Store(join(dir, 'again.sqlite'), mediaSigner('s'));
    createDemoAccounts(again);
    again.db.close();
    expect((await abouts.get('conversation', climb.id)).fields.disappearing?.value).toBe(7 * 86_400);
    const book = conv('whatsapp', (c) => c.name === 'Book club');
    expect((await abouts.get('conversation', book.id)).fields.name?.value).toBe('Book club 📚');
  });
});

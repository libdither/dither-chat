/**
 * Bots and apps through the hub (apps.ts, docs/apps.md), against the demo world's adapters and its bot (demoapps.ts)
 * run in process: presses and choices checked against the message's controls as stored, slash commands checked
 * against the list the adapter gave, suggestions, message commands, forms kept while open and sent once, outcomes
 * passed to the page as they come, and the page's picks turned into native ids.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { Apps, AppsError, cleanFields, communityOf } from '../src/apps.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-apps-'));
let store: Store;
let apps: Apps;
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const sent: { account: string; cmd: any }[] = [];
const notes: string[] = [];
const events: P.ClientEvent[] = [];
const waiters: { want: (e: P.ClientEvent) => boolean; done: (e: P.ClientEvent) => void }[] = [];
const MAIN = 'acc_demo-discord-main';

/** The next page event that matches (or one already heard): event-driven, no timers. */
function heard<T extends P.ClientEvent>(want: (e: P.ClientEvent) => boolean): Promise<T> {
  const had = events.find(want);
  if (had) return Promise.resolve(had as T);
  return new Promise((done) => waiters.push({ want, done: done as (e: P.ClientEvent) => void }));
}
const outcome = (nonce: string, state: P.InteractionState) => heard<Extract<P.ClientEvent, { t: 'interaction' }>>((e) => e.t === 'interaction' && e.interaction.nonce === nonce && e.interaction.state === state);

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

const general = () => store.one<{ id: string }>(`SELECT id FROM conversation WHERE network = 'discord' AND name = 'general' AND id IN (SELECT conversation_id FROM message WHERE native_id LIKE '%~helper-menu')`)!.id;
const menu = () => store.one<{ id: string; native_id: string }>(`SELECT id, native_id FROM message WHERE native_id LIKE '%~helper-menu'`)!;
const lastSent = () => sent.at(-1)!.cmd;
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppsError) return e;
    throw e;
  }
  throw new Error('it went through');
};

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  store.db.transaction(() => {
    for (const acc of createDemoAccounts(store)) {
      if (acc.network !== 'discord') continue;
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
        for (const e of store.flush()) {
          events.push(e);
          for (const w of [...waiters])
            if (w.want(e)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.done(e);
            }
        }
      });
    }
  })();
  store.flush();
  apps = new Apps({ ...deps, note: (_a, line) => notes.push(line) });
});

afterAll(() => {
  for (const a of adapters.values()) (a as unknown as { stop(): void }).stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('slash commands', () => {
  test('listed as the account has them here, with their app and its bot', async () => {
    const v = await apps.commands(general(), 'chat', MAIN);
    expect(v.accountId).toBe(MAIN);
    expect(v.commands.map((c) => c.name)).toEqual(['roll', 'remind me', 'ticket', 'thank', 'size']);
    expect(v.apps).toEqual([{ id: expect.any(String), name: 'Helper', identityId: expect.stringMatching(/^idn_/) }]);
    expect((await apps.commands(general(), 'message', MAIN)).commands.map((c) => c.name)).toEqual(['Quote this', 'Count words']);
    expect((await apps.commands(general(), 'user', MAIN)).reason).toMatch(/not built/);
  });

  test('run once, its option values checked first; the answer comes as the bot’s message', async () => {
    const roll = (await apps.commands(general(), 'chat', MAIN)).commands.find((c) => c.name === 'roll')!;
    const run = (options: { name: string; value: unknown }[]) => apps.interact(general(), { interaction: { kind: 'command', command: roll.id, app: roll.app, options } });
    expect((await refused(run([{ name: 'sides', value: 200 }]))).message).toBe('sides is at most 100');
    expect((await refused(run([{ name: 'sides', value: 2.5 }]))).message).toBe('sides is a whole number');
    expect((await refused(run([{ name: 'colour', value: 'red' }]))).message).toBe('/roll has no option colour');
    const before = sent.length;
    const { nonce } = await run([{ name: 'sides', value: 20 }]);
    expect(sent.length).toBe(before + 1);
    expect(lastSent()).toMatchObject({ t: 'interact', interaction: { kind: 'command', command: roll.id, options: [{ name: 'sides', value: 20 }] } });
    expect(nonce).toBeTruthy();
    await outcome(nonce, 'sending');
    await outcome(nonce, 'answered');
    const reply = await heard<Extract<P.ClientEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.body.startsWith('🎲') && e.message.rich?.interaction?.name === 'roll');
    expect(reply.message.conversationId).toBe(general());
    expect(notes.at(-1)).toBe('[app] ran /roll');
  });

  test('required options, choices, and a commands not listed here are refused', async () => {
    const list = (await apps.commands(general(), 'chat', MAIN)).commands;
    const remind = list.find((c) => c.name === 'remind me')!;
    const size = list.find((c) => c.name === 'size')!;
    expect((await refused(apps.interact(general(), { interaction: { kind: 'command', command: remind.id, app: remind.app, options: [{ name: 'when', value: 'tonight at 8' }] } }))).message).toBe('what is required');
    expect((await refused(apps.interact(general(), { interaction: { kind: 'command', command: size.id, app: size.app, options: [{ name: 'size', value: 'xl' }] } }))).message).toBe('size: that is not one of its choices');
    expect((await refused(apps.interact(general(), { interaction: { kind: 'command', command: 'nope', app: size.app, options: [] } }))).status).toBe(404);
  });

  test('a person option: a pick goes as their native id, a typed name as it is for the client to resolve', async () => {
    const thank = (await apps.commands(general(), 'chat', MAIN)).commands.find((c) => c.name === 'thank')!;
    const people = apps.choices(general(), 'user', 'pix').choices;
    expect(people.map((p) => p.name)).toContain('pixelfox');
    const pixel = people.find((p) => p.name === 'pixelfox')!;
    await apps.interact(general(), { interaction: { kind: 'command', command: thank.id, app: thank.app, options: [{ name: 'who', value: pixel.value }, { name: 'loud', value: true }] } });
    expect(lastSent().interaction.options).toEqual([{ name: 'who', value: store.nativeOf('identity', pixel.value)!.nativeId, ref: 'user' }, { name: 'loud', value: true }]);
    await apps.interact(general(), { interaction: { kind: 'command', command: thank.id, app: thank.app, options: [{ name: 'who', value: '@lev' }] } });
    expect(lastSent().interaction.options).toEqual([{ name: 'who', value: '@lev' }]);
    const channel = apps.choices(general(), 'channel', '').choices[0];
    expect((await refused(apps.interact(general(), { interaction: { kind: 'command', command: thank.id, app: thank.app, options: [{ name: 'who', value: channel.value }] } }))).message).toBe('who takes a user');
  });

  test('suggestions for an option that has them, through the account', async () => {
    const remind = (await apps.commands(general(), 'chat', MAIN)).commands.find((c) => c.name === 'remind me')!;
    const r = await apps.autocomplete(general(), { command: remind.id, app: remind.app, focused: 'when', query: 'to', options: [{ name: 'what', value: 'bins' }] });
    expect(r.choices.map((c) => c.name)).toEqual(['tonight at 8', 'tomorrow at 9']);
    expect(lastSent()).toMatchObject({ t: 'appAutocomplete', focused: 'when', query: 'to', options: [{ name: 'what', value: 'bins' }] });
    expect((await refused(apps.autocomplete(general(), { command: remind.id, app: remind.app, focused: 'what', query: 'x' }))).message).toBe('That option has no suggestions');
  });

  test('a message command runs on the message, by its native id', async () => {
    const quote = (await apps.commands(general(), 'message', MAIN)).commands[0];
    const { nonce } = await apps.interact(general(), { interaction: { kind: 'command', command: quote.id, app: quote.app, options: [], targetMessageId: menu().id } });
    expect(lastSent().interaction.target).toEqual({ kind: 'message', id: menu().native_id });
    await outcome(nonce, 'answered');
  });
});

describe('buttons and selects', () => {
  const press = (component: string, values?: string[]) => apps.interact(general(), { interaction: { kind: 'component', messageId: menu().id, component, ...(values ? { values } : {}) } });

  test('a press goes once, by the message’s native id; its outcome names the message', async () => {
    const { nonce } = await press('helper:roll');
    expect(lastSent()).toMatchObject({ t: 'interact', interaction: { kind: 'component', message: menu().native_id, component: 'helper:roll' } });
    const done = await outcome(nonce, 'answered');
    expect(done.interaction.messageId).toBe(menu().id);
    expect(notes.at(-1)).toBe('[app] pressed "Roll a die"');
  });

  test('refused before anything is sent: a link button, a control it lacks, values on a button, a choice it does not offer', async () => {
    const before = sent.length;
    expect((await refused(press('nope'))).status).toBe(404);
    expect((await refused(press('helper:roll', ['x']))).message).toBe('A button takes no values');
    expect((await refused(press('helper:roles', ['admin']))).message).toBe('That is not one of its options');
    expect((await refused(press('helper:roles', ['rust', 'routing', 'offtopic', 'rust']))).message).toBe('Choose 0 to 3');
    expect((await refused(press('helper:thank', ['someone']))).message).toBe('That is not something this select takes');
    expect((await refused(apps.interact(general(), { interaction: { kind: 'component', messageId: 'msg_nope', component: 'helper:roll' } }))).status).toBe(404);
    expect(sent.length).toBe(before);
  });

  test('a string select sends its values; a user select sends the picked person as a native id', async () => {
    const roles = await press('helper:roles', ['rust', 'routing']);
    expect(lastSent().interaction.values).toEqual(['rust', 'routing']);
    await outcome(roles.nonce, 'answered');
    const pixel = apps.choices(general(), 'user', 'pixelfox').choices[0];
    await press('helper:thank', [pixel.value]);
    expect(lastSent().interaction.values).toEqual([store.nativeOf('identity', pixel.value)!.nativeId]);
    const answer = await heard<Extract<P.ClientEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.body.startsWith('Thanks sent'));
    expect(answer.message.rich?.marks?.ephemeral).toBe(true);
  });

  test('a bot that does not answer: failed, in words', async () => {
    const { nonce } = await press('helper:broken');
    expect((await outcome(nonce, 'failed')).interaction.error).toBe('This interaction failed');
  });
});

describe('forms', () => {
  test('opened by a press, kept while open, checked, and sent once', async () => {
    const { nonce } = await apps.interact(general(), { interaction: { kind: 'component', messageId: menu().id, component: 'helper:ticket' } });
    const opened = await heard<Extract<P.ClientEvent, { t: 'appModal' }>>((e) => e.t === 'appModal' && e.modal.nonce === nonce);
    const form = opened.modal;
    expect(form).toMatchObject({ title: 'Open a ticket', conversationId: general(), accountId: MAIN, app: { name: 'Helper' } });
    expect(form.fields.map((f) => f.kind)).toEqual(['display', 'text', 'text', 'select', 'checkbox']);
    expect(apps.openForms(general()).map((f) => f.id)).toContain(form.id);
    const send = (values: P.ModalValue[]) => apps.interact(general(), { interaction: { kind: 'modal', modal: form.id, values } });
    expect((await refused(send([{ field: 'area', values: ['rust'] }]))).message).toBe('Subject is required');
    expect((await refused(send([{ field: 'subject', value: 'x' }, { field: 'area', values: ['nope'] }]))).message).toBe('Area: that is not one of its options');
    expect((await refused(send([{ field: 'subject', value: 'x' }, { field: 'area', values: ['rust'] }, { field: 'evil', value: 'x' }]))).message).toBe('That answers a field this form does not have');
    const r = await send([{ field: 'subject', value: 'Login loop' }, { field: 'area', values: ['rust'] }, { field: 'urgent', checked: true }]);
    expect(lastSent().interaction).toEqual({ kind: 'modal', modal: form.id, values: [{ field: 'subject', value: 'Login loop' }, { field: 'area', values: ['rust'] }, { field: 'urgent', checked: true }] });
    await outcome(r.nonce, 'answered');
    await heard((e) => e.t === 'message' && e.message.body === 'Ticket opened: **Login loop** (urgent).');
    expect((await refused(send([{ field: 'subject', value: 'again' }, { field: 'area', values: ['rust'] }]))).status).toBe(410);
    expect(apps.openForms(general()).map((f) => f.id)).not.toContain(form.id);
  });

  test('a form’s fields are kept only in known kinds, their strings bounded', () => {
    const f = cleanFields([
      { kind: 'text', id: 'a', label: 'x'.repeat(500), style: 'paragraph', maxLength: 99_999 },
      { kind: 'script', id: 'b' },
      { kind: 'select', id: 'c', select: 'everyone' },
      { kind: 'select', id: 'd', select: 'string', options: [{ label: 'One', value: '1' }, { value: 5 }] },
      { kind: 'display', text: '' },
    ]);
    expect(f).toEqual([
      { kind: 'text', id: 'a', label: 'x'.repeat(100), style: 'paragraph' },
      { kind: 'select', id: 'd', select: 'string', options: [{ label: 'One', value: '1' }] },
    ]);
  });
});

describe('picks and the route', () => {
  test('roles from the server’s About, channels of the server', () => {
    const conv = general();
    const space = communityOf(store, conv)!;
    expect(store.one<{ name: string }>('SELECT name FROM space WHERE id = ?', space)?.name).toBe('libdither');
    store.db.query('INSERT OR REPLACE INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?)').run(space, MAIN, JSON.stringify({ fields: {}, roles: [{ id: '123', name: 'Contributor', rank: 2, color: '#ff0000' }, { id: 'x', name: 'Bad', rank: 1 }] }), Date.now());
    const roles = apps.choices(conv, 'role', '').choices;
    expect(roles).toEqual([{ value: 'role:123', name: 'Contributor', kind: 'role', color: '#ff0000' }]);
    expect(apps.choices(conv, 'mentionable', 'contrib').choices.map((c) => c.kind)).toEqual(['role']);
    expect(apps.choices(conv, 'channel', 'gen').choices.map((c) => c.name)).toContain('general');
  });

  test('a write or a suggestion only from the app’s own page', async () => {
    const url = (p: string) => new URL(`http://hub${p}`);
    const path = `/api/conversations/${general()}/apps/interact`;
    const bare = await apps.route(new Request(url(path), { method: 'POST', body: JSON.stringify({ interaction: { kind: 'component', messageId: menu().id, component: 'helper:roll' } }) }), url(path), path);
    expect(bare!.status).toBe(403);
    const list = `/api/conversations/${general()}/apps/commands`;
    const r = await apps.route(new Request(url(`${list}?kind=chat`)), url(`${list}?kind=chat`), list);
    expect(((await r!.json()) as P.AppCommandsView).commands.length).toBe(5);
  });
});

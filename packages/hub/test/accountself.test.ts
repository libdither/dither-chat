/**
 * An account's own self (accountself.ts, docs/account-self.md): notices kept as the network says them, presence and
 * folders in the account's view, the routes under /api/self/ (block, ignore, note, presence, sessions, profile fields,
 * folders imported once), messages from someone blocked or ignored never alerting, and the opt-in Do not disturb
 * during quiet hours. Against the demo world's adapters run in process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { linkOf } from '../src/add.ts';
import { AccountSelf, ignoredOf, quietAuthor } from '../src/accountself.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { People } from '../src/people.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-self-'));
let store: Store;
let self: AccountSelf;
const offline = new Set<string>();
const notes: string[] = [];
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void; stop(): void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const uploads = new Map<string, P.OutgoingAttachment>();

const MAIN = 'acc_demo-discord-main';
const SIG = 'acc_demo-signal';

function command<T>(account: string, cmd: any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    adapters.get(account)!.command({ ...cmd, id });
  });
}

const page = { origin: 'http://hub' };
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = page): Promise<{ status: number; json: any }> {
  const req = new Request(`http://hub${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const url = new URL(req.url);
  const res = (await self.route(req, url, url.pathname))!;
  return { status: res.status, json: await res.json() };
}

const idn = (network: P.Network, handle: string) => store.one<{ id: string; native_id: string }>('SELECT id, native_id FROM identity WHERE network = ? AND handle = ?', network, handle)!;
const view = (acc = MAIN) => store.accountView(store.account(acc)!).self;

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  store.db.transaction(() => {
    for (const acc of createDemoAccounts(store)) {
      const adir = join(dir, acc.id);
      mkdirSync(adir, { recursive: true });
      const a = demoFactory(acc, adir)! as unknown as { command: (c: P.AdapterCommand) => void; stop(): void; start(e: (ev: P.AdapterEvent) => void): void };
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
  self = new AccountSelf({
    store,
    online: (a) => !offline.has(a),
    command,
    note: (_a, line) => notes.push(line),
    flush: () => store.flush(),
    uploads: { get: (ids) => (ids.every((i) => uploads.has(i)) ? ids.map((i) => uploads.get(i)!) : null), remove: (ids) => ids.forEach((i) => uploads.delete(i)) },
    quietHours: () => store.quietHours(),
  });
});

afterAll(() => {
  for (const a of adapters.values()) a.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('what the account says of itself', () => {
  test('after connect: presence, folders in hub ids and privacy lines; nothing for an account that says none', () => {
    const v = view()!;
    expect(v.presence).toEqual({ state: 'online' });
    expect(v.notices).toEqual([]);
    const projects = v.folders!.find((f) => f.name === 'Projects')!;
    expect(projects.spaces.length).toBe(2);
    expect(projects.spaces.every((id) => id.startsWith('spc_'))).toBe(true);
    expect(v.privacy?.[0].label).toBe('Direct messages from server members');
    expect(view(SIG)).toBeUndefined();
  });

  test('notices: the whole list each time, each keeps when it first came, junk dropped, an empty list clears', () => {
    const acc = store.account(MAIN)!;
    const phone: P.AccountNotice = { key: 'required:REQUIRE_VERIFIED_PHONE', kind: 'verify', title: 'Verify your phone number', message: 'Discord wants a verified phone number. Open the live view to do it.', liveView: true };
    store.ingest(acc, { t: 'notices', notices: [phone, { key: '', title: 'x', message: 'y' } as never] });
    const first = view()!.notices;
    expect(first).toEqual([{ ...phone, since: expect.any(Number) }]);
    store.ingest(acc, { t: 'notices', notices: [phone, { key: 'standing', kind: 'standing', title: 'Your account is limited', message: 'Open the live view.' }] });
    expect(view()!.notices[0].since).toBe(first[0].since);
    expect(view()!.notices.map((n) => n.key)).toEqual([phone.key, 'standing']);
    store.ingest(acc, { t: 'notices', notices: [] });
    expect(view()!.notices).toEqual([]);
  });
});

describe('block and ignore', () => {
  test('a write without Origin is refused, and an unknown person is a 404', async () => {
    const quinn = idn('discord', 'quinn.dev');
    expect((await call('POST', `/api/self/people/${quinn.id}/ignore`, { ignored: true }, {})).status).toBe(403);
    expect((await call('POST', '/api/self/people/idn_nobody/ignore', { ignored: true })).status).toBe(404);
    expect((await call('POST', `/api/self/people/${quinn.id}/ignore`, {})).status).toBe(400);
  });

  test('ignoring someone lists them, keeps their messages from alerting, and undoing it puts that back', async () => {
    const quinn = idn('discord', 'quinn.dev');
    const r = await call('POST', `/api/self/people/${quinn.id}/ignore`, { ignored: true });
    expect(r).toEqual({ status: 200, json: { ignored: true } });
    expect(ignoredOf(store.db, [quinn.id]).map((x) => x.accountId)).toContain(MAIN);
    expect(quietAuthor(store.db, quinn.id)).toBe('You ignore them');
    // The triage rule: silent before anything else weighs it.
    const triage = new Triage(store);
    triage.judge = async () => 0.99;
    const dm = store.one<{ native_id: string }>(`SELECT c.native_id FROM conversation c JOIN participant p ON p.conversation_id = c.id WHERE c.shape = 'direct' AND p.identity_id = ? LIMIT 1`, quinn.id);
    const conv = dm?.native_id ?? 'dm-quinn-test';
    if (!dm) store.ingest(store.account(MAIN)!, { t: 'conversation', conversation: { nativeId: conv, shape: 'direct', participants: [quinn.native_id] } });
    store.ingest(store.account(MAIN)!, { t: 'message', live: true, message: { nativeId: 'ign-1', conversation: conv, author: quinn.native_id, ts: Date.now(), body: 'call me now, urgent' } });
    const mid = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', 'ign-1')!.id;
    const d = await triage.decide(mid, Date.now());
    expect(d?.decision).toBe('silent');
    expect(d?.reasons[0]).toBe('You ignore them on Discord');
    expect((await call('POST', `/api/self/people/${quinn.id}/ignore`, { ignored: false })).json).toEqual({ ignored: false });
    expect(quietAuthor(store.db, quinn.id)).toBeNull();
  });

  test('blocking goes through the network and its list says it; refused for an account that is offline', async () => {
    const theo = idn('discord', 'theo.k');
    offline.add(MAIN);
    offline.add('acc_demo-discord-alt');
    expect((await call('POST', `/api/self/people/${theo.id}/block`, {})).status).toBe(409);
    offline.clear();
    const r = await call('POST', `/api/self/people/${theo.id}/block`, { accountId: MAIN });
    expect(r.json.relationship).toBe('blocked');
    expect(linkOf(store.db, MAIN, theo.id)).toBe('blocked');
    expect(quietAuthor(store.db, theo.id)).toBe('You blocked them');
  });
});

describe('notes', () => {
  test("a note is written to the network, and one it replaces is kept in your dither note first", async () => {
    const ravi = idn('discord', 'ravi_p');
    const people = new People({ store, online: () => true, command: (a, c, t) => command(a, c) as never });
    expect((await call('PUT', `/api/self/identities/${ravi.id}/note`, { note: 'x'.repeat(300) })).status).toBe(400);
    const first = await call('PUT', `/api/self/identities/${ravi.id}/note`, { note: 'met at RustConf' });
    expect(first.json).toEqual({ note: 'met at RustConf', personNote: null });
    // The profile carries it, asked the way a profile is.
    const about = await people.get(ravi.id, true);
    expect(about.note).toBe('met at RustConf');
    const second = await call('PUT', `/api/self/identities/${ravi.id}/note`, { note: 'owes me a review' });
    expect(second.json.note).toBe('owes me a review');
    expect(second.json.personNote).toContain('Discord note: met at RustConf');
    // Kept once: replacing it again with the same old text does not add it twice.
    await call('PUT', `/api/self/identities/${ravi.id}/note`, { note: 'met at RustConf' });
    const pid = store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', ravi.id)!.person_id;
    const kept = store.one<{ note: string }>('SELECT note FROM person WHERE id = ?', pid)!.note;
    expect(kept.match(/met at RustConf/g)!.length).toBe(1);
    expect(kept).toContain('owes me a review');
  });
});

describe('presence, sessions and profile', () => {
  test('presence and status set, checked and said back in the view', async () => {
    expect((await call('POST', `/api/self/${MAIN}/presence`, { state: 'away' })).status).toBe(400);
    expect((await call('POST', `/api/self/${MAIN}/presence`, {})).status).toBe(400);
    expect((await call('POST', `/api/self/${MAIN}/presence`, { status: { text: 'x'.repeat(129) } })).status).toBe(400);
    const r = await call('POST', `/api/self/${MAIN}/presence`, { state: 'idle', status: { text: 'reading', emoji: '📖' } });
    expect(r.json).toEqual({ state: 'idle', status: { text: 'reading', emoji: '📖' } });
    expect(view()!.presence).toEqual({ state: 'idle', status: { text: 'reading', emoji: '📖' } });
    expect((await call('POST', `/api/self/${MAIN}/presence`, { state: 'online', status: null })).json).toEqual({ state: 'online' });
    expect((await call('POST', `/api/self/${SIG}/presence`, { state: 'dnd' })).status).toBe(409);
  });

  test('sessions, asked when the list is opened', async () => {
    const r = await call('GET', `/api/self/${MAIN}/sessions`);
    expect(r.json.sessions.length).toBe(2);
    expect(r.json.sessions.filter((s: P.AccountSession) => s.current).length).toBe(1);
  });

  test('your name, pronouns and picture: checked, sent, the upload let go; a banner without Nitro is the network’s no', async () => {
    const me = store.account(MAIN)!.self_identity!;
    expect((await call('PUT', `/api/self/identities/${idn('discord', 'ravi_p').id}/profile`, { displayName: 'x' })).status).toBe(403);
    expect((await call('PUT', `/api/self/identities/${me}/profile`, { displayName: 'x'.repeat(33) })).status).toBe(400);
    expect((await call('PUT', `/api/self/identities/${me}/profile`, {})).status).toBe(400);
    const r = await call('PUT', `/api/self/identities/${me}/profile`, { displayName: 'Zed', pronouns: 'they/them' });
    expect(r.json.displayName).toBe('Zed');
    expect(r.json.pronouns).toBe('they/them');
    expect(store.one<{ display_name: string }>('SELECT display_name FROM identity WHERE id = ?', me)!.display_name).toBe('Zed');
    const path = join(dir, 'pic.png');
    writeFileSync(path, 'png');
    uploads.set('u1', { path, name: 'pic.png', mime: 'image/png', size: 3, kind: 'image' });
    expect((await call('PUT', `/api/self/identities/${me}/profile`, { avatar: 'u1' })).status).toBe(200);
    expect(uploads.has('u1')).toBe(false);
    expect((await call('PUT', `/api/self/identities/${me}/profile`, { avatar: 'u1' })).status).toBe(410);
    uploads.set('u2', { path, name: 'b.png', mime: 'image/png', size: 3, kind: 'image' });
    const banner = await call('PUT', `/api/self/identities/${me}/profile`, { banner: 'u2' });
    expect(banner.status).toBe(502);
    expect(banner.json.error).toContain('Nitro');
    expect(uploads.has('u2')).toBe(false);
  });
});

describe('folders', () => {
  test('imported once into new folders, never moving a space the owner already placed', async () => {
    const v = view()!;
    const [a, b] = v.folders!.find((f) => f.name === 'Projects')!.spaces;
    store.setFolders([{ id: '', name: 'Mine', icon: null, color: null, items: [{ kind: 'space', id: a }] }]);
    const r = await call('POST', `/api/self/${MAIN}/folders/import`);
    expect(r.json.made).toEqual([{ id: expect.any(String), name: 'Projects', spaces: 1 }]);
    const folders = store.folders();
    expect(folders.map((f) => f.name)).toEqual(['Mine', 'Projects']);
    expect(folders[0].items).toEqual([{ kind: 'space', id: a }]);
    expect(folders[1].items).toEqual([{ kind: 'space', id: b }]);
    expect(view()!.foldersImportedAt).toBeGreaterThan(0);
    const again = await call('POST', `/api/self/${MAIN}/folders/import`);
    expect(again.json.made).toEqual([]);
    expect(again.json.skipped).toEqual([{ name: 'Projects', why: 'its servers are in your folders already' }]);
    expect((await call('POST', `/api/self/${SIG}/folders/import`)).status).toBe(409);
  });
});

describe('Do not disturb during quiet hours', () => {
  const night: P.QuietHours = { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC', allowStarred: true };
  const at = (h: number) => Date.UTC(2026, 0, 5, h);

  test('off unless the owner opts in; then on at the start and back to what it was at the end', async () => {
    store.setQuietHours(night);
    await self.tick(at(23));
    expect(view()!.presence?.state).toBe('online');
    expect((await call('PUT', `/api/self/${SIG}/dnd-quiet`, { on: true })).status).toBe(409);
    expect((await call('PUT', `/api/self/${MAIN}/dnd-quiet`, { on: true })).json).toEqual({ on: true });
    expect(view()!.dndQuietHours).toBe(true);
    await call('POST', `/api/self/${MAIN}/presence`, { state: 'idle' });
    await self.tick(at(23));
    expect(view()!.presence?.state).toBe('dnd');
    await self.tick(at(23));
    expect(view()!.presence?.state).toBe('dnd');
    await self.tick(at(8));
    expect(view()!.presence?.state).toBe('idle');
  });

  test('a state the owner set during quiet hours is theirs: the end leaves it', async () => {
    await self.tick(at(23));
    expect(view()!.presence?.state).toBe('dnd');
    await call('POST', `/api/self/${MAIN}/presence`, { state: 'invisible' });
    await self.tick(at(8));
    expect(view()!.presence?.state).toBe('invisible');
    // Already Do not disturb by the owner's choice when it starts: left as it is after.
    await call('POST', `/api/self/${MAIN}/presence`, { state: 'dnd' });
    await self.tick(at(23));
    await self.tick(at(8));
    expect(view()!.presence?.state).toBe('dnd');
    await call('PUT', `/api/self/${MAIN}/dnd-quiet`, { on: false });
    expect(view()!.dndQuietHours).toBeUndefined();
  });
});

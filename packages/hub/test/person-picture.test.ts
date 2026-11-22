/**
 * A person's picture is signed through an account that saw one of their accounts (store.ts personPicture): a Zulip
 * or Matrix picture can only be fetched through an account. An account removed lets go of the people it saw, so the
 * account added again (or another that sees them) takes its place.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-personpic-'));
const path = join(dir, 'hub.sqlite');
/** Signs a URL as "<url>|<account or none>", so a test reads which account it went through. */
const sign = (raw: string | null | undefined, acc: string | null | undefined) => (raw ? `${raw}|${acc ?? 'none'}` : null);
let store = new Store(path, sign);
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const personOf = (nativeId: string) => store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE native_id = ?', nativeId)!.person_id;
const pictureOf = (nativeId: string) => store.personView(store.one('SELECT * FROM person WHERE id = ?', personOf(nativeId))!).avatar;
const seenVia = (nativeId: string) => store.one<{ seen_via: string | null }>('SELECT seen_via FROM identity WHERE native_id = ?', nativeId)!.seen_via;

function meet(acc: ReturnType<Store['createAccount']>, nativeId: string, avatarUrl: string) {
  store.ingest(acc, { t: 'identity', identity: { nativeId, displayName: 'Cy', avatarUrl } });
  // A chat with them, so they are someone (a person of their own).
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: `${nativeId}/dm`, shape: 'direct', participants: [nativeId] } });
}

test("a person's picture goes through the account that saw them, and notifications show it the same way", () => {
  const z = store.createAccount({ network: 'zulip', label: 'z', color: '#000', adapter: 'zulip' });
  meet(z, 'chat.example.org/u/7', 'zulip:/user_avatars/7.png');
  expect(pictureOf('chat.example.org/u/7')).toBe(`zulip:/user_avatars/7.png|${z.id}`);
  store.ingest(z, { t: 'message', message: { nativeId: 'chat.example.org/m/1', conversation: 'chat.example.org/u/7/dm', author: 'chat.example.org/u/7', ts: 1, body: 'hi' } });
  const mid = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', 'chat.example.org/m/1')!.id;
  const cid = store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', 'chat.example.org/u/7/dm')!.id;
  // The identity's own picture first; with none, the person's, through the same account.
  expect(store.notifyLook(cid, mid).icon).toBe(`zulip:/user_avatars/7.png|${z.id}`);
  store.db.query('UPDATE identity SET avatar_url = NULL WHERE native_id = ?').run('chat.example.org/u/7');
  expect(store.notifyLook(cid, mid).icon).toBe(`zulip:/user_avatars/7.png|${z.id}`);
});

test('of a person with several accounts, the picture goes through the account that saw the one it came from', () => {
  const m = store.createAccount({ network: 'matrix', label: 'm', color: '#111', adapter: 'matrix' });
  const z = store.createAccount({ network: 'zulip', label: 'z2', color: '#222', adapter: 'zulip' });
  meet(m, '@dee:example.org', 'mxc://example.org/dee');
  meet(z, 'chat.example.org/u/8', 'zulip:/user_avatars/8.png');
  store.mergePersons(personOf('@dee:example.org'), personOf('chat.example.org/u/8'));
  store.db.query('UPDATE person SET avatar_url = ? WHERE id = ?').run('zulip:/user_avatars/8.png', personOf('@dee:example.org'));
  expect(pictureOf('@dee:example.org')).toBe(`zulip:/user_avatars/8.png|${z.id}`);
  store.db.query('UPDATE person SET avatar_url = ? WHERE id = ?').run('mxc://example.org/dee', personOf('@dee:example.org'));
  expect(pictureOf('@dee:example.org')).toBe(`mxc://example.org/dee|${m.id}`);
});

test('an account removed lets go of the people it saw; the one added again takes its place', () => {
  const a = store.createAccount({ network: 'zulip', label: 'gone', color: '#333', adapter: 'zulip' });
  const b = store.createAccount({ network: 'zulip', label: 'stays', color: '#444', adapter: 'zulip' });
  meet(a, 'chat.example.org/u/9', 'zulip:/user_avatars/9.png');
  // Seen by another account too, so they stay when the first goes.
  store.ingest(b, { t: 'conversation', conversation: { nativeId: 'chat.example.org/u/9/dm', shape: 'direct', participants: ['chat.example.org/u/9'] } });
  expect(seenVia('chat.example.org/u/9')).toBe(a.id);
  store.deleteAccount(a.id);
  expect(seenVia('chat.example.org/u/9')).toBeNull();
  // Not through the account that is gone.
  expect(pictureOf('chat.example.org/u/9')).toBe('zulip:/user_avatars/9.png|none');
  const again = store.createAccount({ network: 'zulip', label: 'again', color: '#555', adapter: 'zulip' });
  store.ingest(again, { t: 'identity', identity: { nativeId: 'chat.example.org/u/9', displayName: 'Cy', avatarUrl: 'zulip:/user_avatars/9.png' } });
  expect(seenVia('chat.example.org/u/9')).toBe(again.id);
  expect(pictureOf('chat.example.org/u/9')).toBe(`zulip:/user_avatars/9.png|${again.id}`);
});

test('a database from before: an account removed is let go of when the hub starts', () => {
  const gone = 'acc_gone';
  store.db.query('UPDATE identity SET seen_via = ? WHERE native_id = ?').run(gone, 'chat.example.org/u/9');
  // From before the step: it runs once.
  store.db.query(`DELETE FROM meta WHERE key = 'seen_via_gone'`).run();
  store.db.close();
  store = new Store(path, sign);
  expect(seenVia('chat.example.org/u/9')).toBeNull();
  // One whose account is still here keeps it.
  expect(seenVia('chat.example.org/u/8')).not.toBeNull();
  // The bootstrap's people go through the same accounts as one person's view.
  const boot = store.bootstrap();
  for (const p of boot.persons) expect(p.avatar).toBe(store.personView(store.one('SELECT * FROM person WHERE id = ?', p.id)!).avatar);
  expect(boot.persons.some((p) => p.avatar?.endsWith('|none') === false && p.avatar?.startsWith('zulip:'))).toBe(true);
});

/**
 * A session check (auth.ts Auth.session) reads the session and then notes its use. The note is bookkeeping: when it
 * cannot be written (a full disk, a busy database) the session is still good, the request goes on, and the cookie is
 * not refreshed until a later note is really saved.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth, setPassword } from '../src/auth.ts';

const DAY = 86_400_000;
let dir: string;
let auth: Auth;
let now: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dither-auth-session-'));
  now = 1_700_000_000_000;
  await setPassword(dir, 'a-long-test-password', now - 1000);
  auth = new Auth(dir, () => now);
});

afterEach(() => {
  auth.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every write to the session table fails the way a full disk does, until `undo` runs. */
function failWrites(): () => void {
  for (const op of ['UPDATE', 'DELETE']) {
    auth.db.run(`CREATE TEMP TRIGGER fail_${op} BEFORE ${op} ON session BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END`);
  }
  return () => {
    for (const op of ['UPDATE', 'DELETE']) auth.db.run(`DROP TRIGGER temp.fail_${op}`);
  };
}

test('a good session stays good when its use cannot be noted, and is noted on a later request', () => {
  const s = auth.create('10.0.0.1', 'test')!;
  now += 2 * DAY;
  const undo = failWrites();
  const r = auth.session(s.token, '10.0.0.2');
  expect(r?.id).toStartWith('ses_');
  expect(r?.refresh).toBeNull();
  const row = () => auth.db.query('SELECT last_used, last_ip FROM session').get() as { last_used: number; last_ip: string };
  expect(row().last_used).toBe(now - 2 * DAY);

  undo();
  const again = auth.session(s.token, '10.0.0.2');
  expect(again?.id).toBe(r!.id);
  expect(again?.refresh).toBeGreaterThan(0);
  expect(row()).toEqual({ last_used: now, last_ip: '10.0.0.2' });
});

test('an ended session is refused even when it cannot be deleted', () => {
  const s = auth.create('10.0.0.1', 'test')!;
  now += 100 * DAY;
  failWrites();
  expect(auth.session(s.token, '10.0.0.1')).toBeNull();
});

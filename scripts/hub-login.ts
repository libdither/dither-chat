/**
 * Scripts and the hub's login (docs/login.md).
 *
 * A throwaway hub that is not a demo world (it has accounts of its own: the Matrix testbed, a fake Telegram) is behind
 * the login like any real one (docs/login.md). Before starting it, `prepareLogin(dataDir)` sets a password and the
 * service token in its fresh data dir; then programs send `bearer(dataDir)` and a browser page signs in with
 * `signInPage`. Never point these at the live data dir.
 *
 * A script that reads a hub it did not make (scripts/clicks.ts, the call lab) sends `bearer(hubDataDir())` and, for a
 * browser, `signInWithToken`.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureToken, setPassword, TOKEN_FILE, USER } from '../packages/hub/src/auth.ts';

/** The password of throwaway hubs only. */
export const THROWAWAY_PASSWORD = 'throwaway-hub-password';

export async function prepareLogin(dataDir: string): Promise<void> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  await setPassword(dataDir, THROWAWAY_PASSWORD);
  ensureToken(dataDir);
}

/** The header a program sends to the hub of `dataDir`. */
export const bearer = (dataDir: string): { authorization: string } => ({ authorization: `Bearer ${readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim()}` });

/** Signs the browser in: the page is opened on the hub, and its own fetch sets the session cookie. */
export async function signInPage(page: { goto(url: string): Promise<unknown>; eval<T = unknown>(expr: string): Promise<T> }, base: string): Promise<void> {
  await page.goto(`${base}/`);
  const status = await page.eval<number>(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(THROWAWAY_PASSWORD)} }) }).then((r) => r.status)`);
  if (status !== 200) throw new Error(`signing in to ${base}: ${status}`);
}

/** The hub's data dir, as the hub's CLI finds it: DITHER_DATA, else the usual one when it exists, else the repo's .data. */
export function hubDataDir(): string {
  const usual = join(homedir(), '.local/share/dither-chat');
  return process.env.DITHER_DATA ?? (existsSync(usual) ? usual : join(import.meta.dir, '../.data'));
}

/** Signs a browser in with the service token: the hub makes a session (POST /api/sessions), set as the page's cookie. */
export async function signInWithToken(page: { send<T = any>(method: string, params?: unknown): Promise<T> }, base: string, dataDir: string): Promise<void> {
  const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: bearer(dataDir) });
  if (!r.ok) throw new Error(`a session from ${base}: ${r.status} ${await r.text()}`);
  const { name, value } = (await r.json()) as { name: string; value: string };
  await page.send('Network.setCookie', { name, value, url: `${base}/`, httpOnly: true, sameSite: 'Lax' });
}

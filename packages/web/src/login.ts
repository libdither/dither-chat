/**
 * The hub's login, as the page sees it (docs/login.md). Its own module, importing nothing of state.ts or snapshot.ts,
 * so api.ts can tell it about a 401 without an import cycle.
 *
 * A 401 with `login` (no session, or one that ended or was signed out) shows the sign-in screen in place of the app
 * and forgets what this device kept of the hub: the snapshot and kept pages (IndexedDB) and the kept pictures (the
 * service worker's media cache). Signing out does the same, and the hub's answer also asks the browser to clear the
 * site's caches and storage (Clear-Site-Data), and drops sends still waiting (the outbox). Settings stay on a 401
 * (localStorage: the theme, layout choices).
 */
import { signal } from '@preact/signals';

/** Set while this device has to sign in: `setup` when the hub has no password yet. */
export const login = signal<{ setup: boolean } | null>(null);

/** The IndexedDB database the snapshot and kept pages live in (snapshot.ts DB_NAME). */
const DB_NAME = 'dither-chat';
/** Sends waiting for the hub (outbox.ts). */
const OUTBOX_DB = 'dither-chat-outbox';

export function needLogin(setup = false) {
  if (login.value && login.value.setup === setup) return;
  login.value = { setup };
  void forgetLocal();
}

/** What this device kept of the hub's answers: gone, so nothing of it outlives a session. */
async function forgetLocal(): Promise<void> {
  try {
    // An open connection holds the deletion until the page goes; signing in reloads it.
    indexedDB.deleteDatabase(DB_NAME);
  } catch {}
  try {
    if (typeof caches !== 'undefined') for (const k of await caches.keys()) if (k.startsWith('dither-media-')) await caches.delete(k);
  } catch {}
}

/** A 401 from the hub that means "sign in" (its body has `login`). */
export function isLoginRefusal(status: number, body: unknown): boolean {
  return status === 401 && !!body && typeof body === 'object' && (body as { login?: unknown }).login === true;
}

/** Signs in; null when it worked, else what to show. */
export async function signIn(username: string, password: string): Promise<string | null> {
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (r.ok) return null;
    const b = (await r.json().catch(() => null)) as { error?: string; setup?: boolean } | null;
    if (b?.setup) login.value = { setup: true };
    return b?.error ?? `The hub answered ${r.status}.`;
  } catch {
    return 'The hub did not answer.';
  }
}

/**
 * Signs this device out, forgets what it kept, and shows the sign-in screen. Sends that were waiting for the hub
 * (outbox.ts) go too: on a 401 alone they stay, to go out once you sign in again.
 */
export async function signOut(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  await forgetLocal();
  try {
    indexedDB.deleteDatabase(OUTBOX_DB);
  } catch {}
  location.reload();
}

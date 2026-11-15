/**
 * The sign-in screen, in place of the app while this device has no session (login.ts, docs/login.md), and Settings →
 * Signed-in devices.
 */
import { useEffect, useState } from 'preact/hooks';
import { login, signIn, signOut } from '../login.ts';
import { api } from '../api.ts';

export function LoginScreen() {
  const setup = login.value?.setup ?? false;
  const [user, setUser] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await signIn(user, password);
    setBusy(false);
    // A fresh start, with the session: the socket, the bootstrap and the snapshot from nothing.
    if (!err) location.reload();
    else setError(err);
  };
  return (
    <main class="login-screen">
      <div class="login-card">
        {setup ? (
          <>
            <h1>Set a password first</h1>
            <p class="login-help">This hub stays shut until it has a password. On the machine it runs on, from its folder:</p>
            <pre class="login-cmd">bun packages/hub/src/cli.ts set-password</pre>
            <p class="login-help">Pass --data with the hub's data folder if it is not the usual one. Then reload this page.</p>
            <button class="btn primary" type="button" onClick={() => location.reload()}>
              Reload
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1>Sign in to dither-chat</h1>
            {error && (
              <p class="login-error" role="alert">
                {error}
              </p>
            )}
            <label class="field-label" for="login-user">
              Username
            </label>
            <input id="login-user" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck={false} value={user} onInput={(e) => setUser((e.target as HTMLInputElement).value)} required />
            <label class="field-label" for="login-password">
              Password
            </label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} required autofocus />
            <button class="btn primary" type="submit" disabled={busy || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

interface SessionRow {
  id: string;
  createdAt: number;
  lastUsed: number;
  userAgent: string | null;
  lastIp: string | null;
  current: boolean;
}

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Settings → Signed-in devices: each session, signing one out, all others, or this one. */
export function SessionSettings() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);
  const load = () =>
    void api<{ sessions: SessionRow[] }>('/api/sessions')
      .then((r) => setRows(r.sessions))
      .catch(() => setRows([]));
  useEffect(() => {
    void fetch('/api/login', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b: { open?: boolean }) => setOpen(!!b.open))
      .catch(() => setOpen(false));
    load();
  }, []);
  if (open === null) return null;
  if (open)
    return (
      <section class="set-block" id="set-sessions">
        <h3>Signed-in devices</h3>
        <p class="set-help">This hub runs without a login: a demo world, with invented data only.</p>
      </section>
    );
  const others = (rows ?? []).filter((r) => !r.current);
  return (
    <section class="set-block" id="set-sessions">
      <h3>Signed-in devices</h3>
      <p class="set-help">Each browser and app signed in to this hub. A session ends 90 days after it was last used. Signing out here also forgets what this device kept.</p>
      {(rows ?? []).map((r) => (
        <div class="session-row" key={r.id}>
          <span>
            <b>{r.current ? 'This device' : (r.userAgent ?? 'Unknown browser').slice(0, 80)}</b>
            <small>
              Last used {day(r.lastUsed)}
              {r.lastIp ? ` from ${r.lastIp}` : ''}, signed in {day(r.createdAt)}
            </small>
          </span>
          {!r.current && (
            <button class="btn ghost small" type="button" onClick={() => void api(`/api/sessions/${r.id}`, { method: 'DELETE' }).then(load, load)}>
              Sign out
            </button>
          )}
        </div>
      ))}
      <div class="btn-row">
        {others.length > 0 && (
          <button class="btn ghost" type="button" onClick={() => void api('/api/sessions?others=1', { method: 'DELETE' }).then(load, load)}>
            Sign out other devices
          </button>
        )}
        <button class="btn danger" type="button" onClick={() => void signOut()}>
          Sign out here
        </button>
      </div>
    </section>
  );
}

/**
 * The desktop helper (packages/desk, docs/desktop.md): with it paired, links open in the desktop's default browser
 * and files in its own apps, instead of in the browser the app runs in. Without it, nothing here changes anything.
 */
import { signal } from '@preact/signals';
import { toast } from './state.ts';

const KEY = 'dither.desk';
export const DESK_PORT = 8475;

export interface DeskState {
  port: number;
  token: string;
  /** Open links in the default browser. */
  links: boolean;
  /** Open files in the desktop's apps. */
  files: boolean;
}

export interface DeskApp {
  id: string;
  name: string;
}

function load(): DeskState | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return s && typeof s.token === 'string' ? s : null;
  } catch {
    return null;
  }
}

export const desk = signal<DeskState | null>(load());

export function setDesk(s: DeskState | null) {
  desk.value = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {}
}

const base = (port: number) => `http://127.0.0.1:${port}`;

async function call<T>(path: string, opts: { port?: number; body?: unknown; timeout?: number; token?: string } = {}): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const s = desk.value;
  const token = opts.token ?? s?.token;
  const r = await fetch(base(opts.port ?? s?.port ?? DESK_PORT) + path, {
    method: opts.body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeout ?? 2000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

/** Is the helper there, and paired with this page? null when nothing answers (or it is paired with another page). */
export async function hello(port: number): Promise<{ version: string; paired: boolean } | null> {
  try {
    const r = await call<{ app: string; version: string; paired: boolean }>('/hello', { port, timeout: 1500 });
    return r.ok && r.data.app === 'dither-desk' ? r.data : null;
  } catch {
    return null;
  }
}

/** Pairs with the code `pair` printed. Returns an error to show, or null. */
export async function pair(port: number, code: string): Promise<string | null> {
  try {
    const r = await call<{ token: string; triesLeft?: number }>('/pair', { port, body: { code }, token: '' });
    if (!r.ok) return r.status === 403 && r.data.triesLeft !== undefined ? `Wrong code (${r.data.triesLeft} tries left).` : 'No code is waiting. Run the pair command again.';
    setDesk({ port, token: r.data.token, links: true, files: true });
    return null;
  } catch {
    return `Nothing answers on port ${port}.`;
  }
}

export async function unpair() {
  try {
    await call('/unpair', { body: {} });
  } catch {}
  setDesk(null);
}

const on = (k: 'links' | 'files') => !!desk.value?.[k];

/** Opens a link through the helper; false when it is off or did not take it (the caller then does what it did before). */
export async function openLink(url: string): Promise<boolean> {
  if (!on('links')) return false;
  try {
    const r = await call('/open', { body: { url } });
    if (r.status === 401) setDesk(null);
    return r.ok;
  } catch {
    return false;
  }
}

/** Downloads a hub file through the helper and opens it, with `app` if given. false when it is off or failed. */
export async function openFile(f: { url: string; name: string | null; mime: string | null }, app?: string): Promise<boolean> {
  if (!desk.value || (!app && !on('files'))) return false;
  const label = f.name ?? 'the file';
  try {
    const r = await call<{ saved?: string }>('/open-file', { body: { url: new URL(f.url, location.href).href, name: f.name, mime: f.mime?.split(';')[0].trim(), ...(app ? { app } : {}) }, timeout: 130_000 });
    if (r.status === 401) setDesk(null);
    if (r.ok) return true;
    // Saved but not opened (a kind that runs code): say so instead of opening it here.
    if (r.data.saved) {
      toast({ kind: 'info', title: `Saved ${r.data.saved}`, body: r.data.error ?? '' });
      return true;
    }
    toast({ kind: 'error', title: `Could not open ${label}`, body: r.data.error ?? `The helper answered ${r.status}.` });
    return false;
  } catch {
    return false;
  }
}

/** The desktop's apps for a type, default first; null when the helper is not there. */
export async function appsFor(mime: string | null): Promise<DeskApp[] | null> {
  const m = mime?.split(';')[0].trim();
  if (!desk.value || !m) return null;
  try {
    const r = await call<{ apps: DeskApp[] }>(`/apps?mime=${encodeURIComponent(m)}`);
    return r.ok ? r.data.apps : null;
  } catch {
    return null;
  }
}

/** A plain click on a link out of the app goes to the helper; if it does not answer, the link opens as before. */
export function installDeskLinks() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !on('links')) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.hasAttribute('download')) return;
    let u: URL;
    try {
      u = new URL(a.href);
    } catch {
      return;
    }
    if (!/^(https?|mailto):$/.test(u.protocol) || u.origin === location.origin) return;
    e.preventDefault();
    void openLink(u.href).then((ok) => ok || window.open(u.href, '_blank', 'noopener,noreferrer'));
  });
}

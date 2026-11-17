/**
 * Calls to the hub's HTTP API. Its own module, importing nothing of state.ts, so that modules state.ts imports
 * (ringing.ts) can call the hub without an import cycle (docs/testing.md "Import cycles"); state.ts re-exports both.
 */
import { reportApiFailure } from './errors.ts';
import { isLoginRefusal, needLogin } from './login.ts';

/** Told of every call before it goes out: the activity log counts sends, reactions and reads from these (activity.ts). */
export const apiHooks = new Set<(path: string, init?: { method?: string; body?: unknown }) => void>();

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  for (const h of apiHooks) h(path, init);
  const method = init?.method ?? (init?.body !== undefined ? 'POST' : 'GET');
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    });
  } catch (e) {
    // The hub not reached (not an abort, not while offline): to traces/errors.ndjson (errors.ts).
    reportApiFailure(method, path, e);
    throw e;
  }
  const text = await res.text();
  // Not everything here is JSON: the account log and the access gate's refusals are plain text.
  const json = res.headers.get('content-type')?.includes('json');
  const data = json && text ? JSON.parse(text) : text || null;
  if (!res.ok) {
    // No session (or one that ended): the sign-in screen (login.ts).
    if (isLoginRefusal(res.status, data)) needLogin(!!data?.setup);
    const e = Object.assign(new Error(data?.error ?? (text.slice(0, 200) || `${res.status}`)), { status: res.status });
    if (res.status >= 500) reportApiFailure(method, path, e, res.status);
    throw e;
  }
  return data as T;
}

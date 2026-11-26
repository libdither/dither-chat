/**
 * Calls to the hub's HTTP API. Its own module, importing nothing of state.ts, so that modules state.ts imports
 * (ringing.ts) can call the hub without an import cycle (docs/testing.md "Import cycles"); state.ts re-exports both.
 */
import { reportApiFailure } from './errors.ts';
import { isLoginRefusal, needLogin } from './login.ts';

/** Told of every call before it goes out: the activity log counts sends, reactions and reads from these (activity.ts). */
export const apiHooks = new Set<(path: string, init?: { method?: string; body?: unknown }) => void>();

interface HubCall {
  method?: string;
  body?: unknown;
  /**
   * Given up when nothing has come for this long: no answer yet, or no more of it. A request on a connection that died
   * without a word (a phone that slept, a NAT that forgot it) otherwise waits for TCP, which takes many minutes.
   */
  quiet?: number;
  /** Given up when this aborts: the live socket it was for was found dead (state.ts). */
  signal?: AbortSignal;
  /** Told when the answer begins: its status and headers are here. */
  onAnswer?: () => void;
  /**
   * Told as the answer comes: bytes read so far, unpacked, out of the total the hub said (`x-uncompressed-length`, or
   * the length of one sent unpacked), null where it did not. Read a piece at a time only where `quiet` or `signal` is set.
   */
  onBytes?: (got: number, total: number | null) => void;
  /** Asked for already (index.html's bootstrap, state.ts): its answer is read here, and `abort` gives it up. */
  early?: { res: Promise<Response>; abort: () => void };
}

/**
 * The hub's answer, as text. Given up (`quiet`, `signal`), it fails as a fetch that could not reach the hub does: a
 * TypeError, so every caller treats it as no answer at all, not as a refusal.
 */
export async function hubFetch(path: string, init: HubCall & { headers?: Record<string, string>; cache?: RequestCache } = {}): Promise<{ res: Response; text: string }> {
  const { quiet, signal, early } = init;
  const ctl = quiet || signal ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let why = '';
  const stop = (w: string) => () => ((why ||= w), ctl!.abort());
  const linkGone = stop('the link to the hub was dropped');
  const poke = () => {
    if (!quiet) return;
    clearTimeout(timer);
    timer = setTimeout(stop(`the hub did not answer for ${quiet / 1000} s`), quiet);
  };
  if (signal?.aborted) linkGone();
  signal?.addEventListener('abort', linkGone, { once: true });
  poke();
  if (early) ctl?.signal.addEventListener('abort', early.abort, { once: true });
  try {
    const res = await (early?.res ??
      fetch(path, {
        method: init.method,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        headers: init.headers,
        cache: init.cache,
        signal: ctl?.signal,
      }));
    init.onAnswer?.();
    if (!ctl || !res.body) return { res, text: await res.text() };
    // Read a piece at a time: a long answer on a slow link is still coming, which is not quiet.
    poke();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const h = res.headers;
    const total = init.onBytes ? Number(h.get('x-uncompressed-length') ?? (h.get('content-encoding') ? NaN : h.get('content-length'))) || null : null;
    let got = 0;
    init.onBytes?.(0, total);
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      got += value.byteLength;
      init.onBytes?.(got, total);
      poke();
    }
    return { res, text: text + dec.decode() };
  } catch (e) {
    if (why) throw Object.assign(new TypeError(why), { cause: e });
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', linkGone);
  }
}

/**
 * `ask` asked again alongside, every `every` ms while no answer has begun, at most `tries` times in all, two at most
 * waiting at once (the older given up, which closes its connection): the first answer wins and the rest are given up.
 *
 * After a phone sleeps, the browser's idle connections to the hub can all be dead without a word, and a request it puts
 * on one waits until TCP gives up, many minutes. Each try takes another connection, so one soon goes on a live one.
 * On a link that is only slow, the first try answers first and nothing is given up.
 */
export function hedged<T>(ask: (o: { signal: AbortSignal; onAnswer: () => void }) => Promise<T>, o: { every: number; tries: number; signal?: AbortSignal }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tries: AbortController[] = [];
    let settled = false;
    let begun = false;
    let failed = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', gone);
      for (const c of tries) c.abort();
    };
    const gone = () => {
      if (settled) return;
      end();
      reject(new TypeError('the link to the hub was dropped'));
    };
    const go = () => {
      if (settled) return;
      const waiting = tries.filter((c) => !c.signal.aborted);
      if (waiting.length >= 2) waiting[0].abort();
      const c = new AbortController();
      tries.push(c);
      ask({
        signal: c.signal,
        onAnswer: () => {
          begun = true;
          clearTimeout(timer);
        },
      }).then(
        (v) => {
          if (settled) return;
          end();
          resolve(v);
        },
        (e) => {
          if (settled) return;
          failed++;
          // A refusal is the answer, and so is the last try failing with none to come; otherwise the next try is due.
          if (!(e instanceof TypeError) || (failed === tries.length && (begun || tries.length >= o.tries))) {
            end();
            reject(e);
          }
        },
      );
      if (!begun && tries.length < o.tries) timer = setTimeout(go, o.every);
    };
    if (o.signal?.aborted) return gone();
    o.signal?.addEventListener('abort', gone, { once: true });
    go();
  });
}

export async function api<T = any>(path: string, init?: HubCall): Promise<T> {
  for (const h of apiHooks) h(path, init);
  const method = init?.method ?? (init?.body !== undefined ? 'POST' : 'GET');
  let got: { res: Response; text: string };
  try {
    got = await hubFetch(path, { ...init, method, headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined });
  } catch (e) {
    // The hub not reached (not an abort, not while offline, not given up with its socket): to traces/errors.ndjson
    // (errors.ts).
    if (!init?.signal?.aborted) reportApiFailure(method, path, e);
    throw e;
  }
  const { res, text } = got;
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

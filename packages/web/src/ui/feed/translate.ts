/**
 * Translations as the page asks for them (docs/translate.md): each post's text asks once; the asks of one render are
 * sent together (POST /api/translate, 40 at a time), and what comes back is kept for the page's life, per target.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { api } from '../../state.ts';

export type TrState = { s: 'loading' } | { s: 'done'; t: P.Translation } | { s: 'failed'; why: string };

const states = new Map<string, TrState>();
/** Bumped when any translation arrives: a text reading one re-renders. */
export const trRev = signal(0);
let waiting = new Map<string, P.TranslateItem>();
let timer: ReturnType<typeof setTimeout> | null = null;
let waitingTo = '';

const keyOf = (to: string, key: string) => `${to}\0${key}`;
export const trState = (to: string, key: string) => states.get(keyOf(to, key));

/** Ask for one text's translation into `to`, unless it was asked already (or `again`, after a failure). */
export function askTranslation(item: P.TranslateItem, to: string, again = false) {
  const k = keyOf(to, item.key);
  const had = states.get(k);
  if (had && !(again && had.s === 'failed')) return;
  states.set(k, { s: 'loading' });
  if (waitingTo && waitingTo !== to) flush();
  waitingTo = to;
  waiting.set(item.key, item);
  if (again) trRev.value++;
  timer ??= setTimeout(flush, 30);
}

function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const to = waitingTo;
  const items = [...waiting.values()];
  waiting = new Map();
  for (let i = 0; i < items.length; i += 40) {
    const batch = items.slice(i, i + 40);
    api<P.TranslateResult>('/api/translate', { method: 'POST', body: { items: batch, to } }).then(
      (r) => {
        for (const t of r.translations) states.set(keyOf(to, t.key), { s: 'done', t });
        for (const f of r.failed) states.set(keyOf(to, f.key), { s: 'failed', why: f.why });
        trRev.value++;
      },
      (e) => {
        for (const b of batch) states.set(keyOf(to, b.key), { s: 'failed', why: (e as Error).message });
        trRev.value++;
      },
    );
  }
}

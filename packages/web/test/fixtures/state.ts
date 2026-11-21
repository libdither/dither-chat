/**
 * The one mock of src/state.ts for the tests that need one (snapshot.test.ts, model-memo.test.ts, apps.test.ts, menu-toggle.test.ts, mention-complete.test.ts, reactions.test.ts, retention-load.test.ts, threadcache.test.ts). Bun's module mocks
 * are the whole process's, and the first test file to load state.ts fixes what it exports for the rest: so every such
 * test uses this, which has what each of them reads. Its `db` is a real empty one (syncmodel.ts). `selfIds`: the
 * identities a test calls yours (none unless it says).
 */
import { signal } from '@preact/signals';
import { emptyDb } from '../../src/syncmodel.ts';
import { dataVersion } from '../../src/versions.ts';

export const db = emptyDb();
export const selfIds = new Set<string>();
/** Whether the live socket is open, as state.ts says it. */
export const connected = signal(false);
/** What api() answers, by path; a path with no answer fails as an unreachable hub does (a TypeError). */
export const answers = new Map<string, () => unknown>();
/** Each path api() was called with, in order. */
export const asked: string[] = [];
/** What `api` answers for any path, for a test that asks the hub (threadcache.test.ts); `answers` comes first. */
export const hub: { answer: ((path: string) => Promise<unknown>) | null } = { answer: null };

/** This device's settings, as state.ts's pref() reads them and setPrefs() sets them. */
const settings: Record<string, unknown> = {};

export const stateMock = () => ({
  db,
  // No hub in a test: what asks one fails, as it does offline.
  api: async () => {
    throw new Error('no hub in tests');
  },
  dataVersion,
  eventHooks: new Set(),
  inbox: { value: [] },
  mailTriage: { value: [] },
  pref: (k: string) => settings[k],
  setPrefs: (p: Record<string, unknown>) => void Object.assign(settings, p),
  isSelfIdentity: (id: string | null | undefined) => !!id && selfIds.has(id),
  api: async () => ({}),
  toast: () => {},
  changed: () => {},
  patchMessage: () => {},
  loaded: { value: false },
  quoted: new Map(),
  rev: { value: 0 },
  route: { value: { view: 'inbox' } },
  timelines: new Map(),
  connected,
  api: async (path: string) => {
    asked.push(path);
    const answer = answers.get(path);
    if (answer) return answer();
    if (hub.answer) return hub.answer(path);
    throw new TypeError('Failed to fetch');
  },
  toast: () => {},
});

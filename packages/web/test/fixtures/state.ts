/**
 * The one mock of src/state.ts for the tests that need one (snapshot.test.ts, model-memo.test.ts, apps.test.ts, menu-toggle.test.ts). Bun's module mocks
 * are the whole process's, and the first test file to load state.ts fixes what it exports for the rest: so every such
 * test uses this, which has what each of them reads. Its `db` is a real empty one (syncmodel.ts). `selfIds`: the
 * identities a test calls yours (none unless it says).
 */
import { emptyDb } from '../../src/syncmodel.ts';
import { dataVersion } from '../../src/versions.ts';

export const db = emptyDb();
export const selfIds = new Set<string>();

export const stateMock = () => ({
  db,
  dataVersion,
  eventHooks: new Set(),
  inbox: { value: [] },
  mailTriage: { value: [] },
  prefs: { value: {} },
  isSelfIdentity: (id: string | null | undefined) => !!id && selfIds.has(id),
  api: async () => ({}),
  toast: () => {},
  loaded: { value: false },
  quoted: new Map(),
  rev: { value: 0 },
  route: { value: { view: 'inbox' } },
  timelines: new Map(),
  api: async () => {
    throw new Error('no hub in tests');
  },
  toast: () => {},
});

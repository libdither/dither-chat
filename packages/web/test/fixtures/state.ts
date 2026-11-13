/**
 * The one mock of src/state.ts for the tests that need one (snapshot.test.ts, model-memo.test.ts,
 * menu-toggle.test.ts, mention-complete.test.ts). Bun's module mocks are the whole process's, and the first test file to load state.ts fixes what
 * it exports for the rest: so every such test uses this, which has what each of them reads. Its `db` is a real empty one
 * (syncmodel.ts).
 */
import { emptyDb } from '../../src/syncmodel.ts';
import { dataVersion } from '../../src/versions.ts';

export const db = emptyDb();

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
  prefs: { value: {} },
  isSelfIdentity: () => false,
  loaded: { value: false },
  quoted: new Map(),
  rev: { value: 0 },
  route: { value: { view: 'inbox' } },
  timelines: new Map(),
  toast: () => {},
});

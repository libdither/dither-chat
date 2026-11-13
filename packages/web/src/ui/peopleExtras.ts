/**
 * SignalPeople.tsx in a chunk of its own (safety numbers, blocking, your own profile beyond the bio): loaded the first
 * time a profile or a group's page wants it, so the app's first load carries none of it.
 */
import { signal } from '@preact/signals';

type Extras = typeof import('./SignalPeople.tsx');
const extras = signal<Extras | null>(null);
let loading: Promise<Extras> | null = null;

/** The module once loaded, else null (and it starts loading); a component reading it draws again when it comes. */
export function peopleExtras(): Extras | null {
  loading ??= import('./SignalPeople.tsx').then(
    (m) => (extras.value = m),
    (e) => {
      loading = null;
      throw e;
    },
  );
  return extras.value;
}

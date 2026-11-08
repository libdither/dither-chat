/** "This is a person" / "Not a person" in a thread's menus (slice 8): the Mail row's, the reader's ⋯, the inbox row's. */
import type * as P from '@dither-chat/protocol';
import { personChoices, setPerson } from '../../mail/classify.ts';
import type { MenuEntry } from '../ContextMenu.tsx';

export function personItems(ts: P.MailThreadView[]): MenuEntry[] {
  if (ts.length !== 1) return [];
  const t = ts[0];
  return personChoices(t).map((c) =>
    c === 'is' ? { label: 'This is a person', icon: 'user', run: () => void setPerson(t, true) } : { label: 'Not a person', icon: 'users', run: () => void setPerson(t, false) },
  );
}

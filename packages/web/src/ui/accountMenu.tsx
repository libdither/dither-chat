/**
 * One account's actions, as its chip's right-click and the rail's Accounts menu list them. Its own module (not
 * ui/menus.tsx), so the account chip (bits.tsx) has its menu without importing every other menu, which import bits.tsx
 * back (docs/testing.md "Import cycles").
 */
import type * as P from '@dither-chat/protocol';
import { netName } from '../model.ts';
import { api, go, toast } from '../state.ts';
import { copy, groups, type MenuEntry, type MenuSpec } from './ContextMenu.tsx';

export function accountEntries(a: P.AccountView): MenuEntry[] {
  const disabled = a.status === 'disabled';
  const fail = (e: Error) => toast({ kind: 'error', title: 'That did not work', body: e.message });
  return groups(
    [
      { label: 'Open Account Page', icon: 'settings', run: () => go({ view: 'accounts', account: a.id }) },
      !disabled && { label: 'Reconnect', icon: 'refresh', run: () => api(`/api/accounts/${a.id}/action`, { body: { action: 'restart' } }).catch(fail) },
      { label: disabled ? 'Enable' : 'Disable', icon: 'power', run: () => api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { enabled: disabled } }).catch(fail) },
    ],
    [{ label: 'Copy Account ID', icon: 'idBadge', run: () => copy(a.id, 'ID copied') }],
  );
}

export function accountMenu(a: P.AccountView): MenuSpec {
  return { label: `${a.label} actions`, head: <div class="cm-sheet-title">{netName(a.network)} · {a.label}</div>, items: accountEntries(a) };
}

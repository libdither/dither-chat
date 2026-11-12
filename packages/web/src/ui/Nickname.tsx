/**
 * Your nickname for one account of someone's (docs/chats.md, Names): only you see it, it stands for that account's
 * name wherever the account's name shows, and a person's name is made of their accounts' names, so it follows. Set
 * from an account's tile on a profile, the identity menu, or the pencil by a one-route chat's name.
 */
import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { accountName } from '../chatroutes.ts';
import { netName } from '../model.ts';
import { api, isSelfIdentity, toast } from '../state.ts';
import type { MenuEntry } from './ContextMenu.tsx';

/** What the account calls itself on its network, without your nickname. */
export const ownName = (i: P.IdentityView) => accountName({ ...i, nickname: null });

/** Gives one account a nickname, or takes it away (null or empty). */
export async function saveNickname(identityId: string, nickname: string | null) {
  await api(`/api/identities/${identityId}`, { method: 'PATCH', body: { nickname: nickname?.trim() || null } }).catch((e) =>
    toast({ kind: 'error', title: 'Could not save that', body: e.message }),
  );
}

/** Whether you can give this account a nickname: anyone's but your own. */
export const nicknamable = (i: P.IdentityView | null | undefined): i is P.IdentityView => !!i && !isSelfIdentity(i.id);

/**
 * The menu's entries for an account's nickname. `edit` opens an inline editor where the menu has one (a profile's
 * tile, its name); without it the browser asks.
 */
export function nicknameEntries(i: P.IdentityView | null | undefined, edit?: () => void): MenuEntry[] {
  if (!nicknamable(i)) return [];
  const ask = () => {
    const v = prompt(`Nickname for ${ownName(i)} on ${netName(i.network)} (only you see it)`, i.nickname ?? '');
    if (v !== null) void saveNickname(i.id, v);
  };
  return [
    { label: i.nickname ? 'Change Nickname…' : 'Set Nickname…', icon: 'pencil', run: edit ?? ask },
    !!i.nickname && { label: 'Remove Nickname', icon: 'x', run: () => void saveNickname(i.id, null) },
  ].filter(Boolean) as MenuEntry[];
}

/** The inline editor: Enter or leaving it saves, Escape keeps what was there, empty takes the nickname away. */
export function NicknameInput({ i, onDone, class: cls = 'pair-nick-input' }: { i: P.IdentityView; onDone: () => void; class?: string }) {
  const save = (v: string) => {
    onDone();
    if (v.trim() === (i.nickname ?? '')) return;
    void saveNickname(i.id, v);
  };
  return (
    <input
      class={cls}
      value={i.nickname ?? ''}
      placeholder={ownName(i)}
      aria-label={`Nickname for ${ownName(i)} on ${netName(i.network)}`}
      title={`Only you see it. Leave it empty to call this account ${ownName(i)} again`}
      ref={(el) => {
        if (el && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save((e.target as HTMLInputElement).value);
        if (e.key === 'Escape') onDone();
      }}
      onBlur={(e) => save((e.target as HTMLInputElement).value)}
    />
  );
}

/**
 * A name that opens something, with a pencil (shown on hover) for the nickname of the account behind it: a one-route
 * chat's header, a one-account profile. `editing` and `setEditing` may come from outside, so a menu can open it.
 */
export function NicknamedName({
  i,
  label,
  title,
  onOpen,
  editing: outer,
  setEditing: setOuter,
  class: cls = 'conv-head-name',
}: {
  i: P.IdentityView;
  label: string;
  title: string;
  onOpen?: () => void;
  editing?: boolean;
  setEditing?: (on: boolean) => void;
  class?: string;
}) {
  const [inner, setInner] = useState(false);
  const editing = outer ?? inner;
  const setEditing = setOuter ?? setInner;
  if (editing) return <NicknameInput i={i} onDone={() => setEditing(false)} />;
  const pencil = i.nickname ? `Change or remove your nickname for ${ownName(i)} (only you see it)` : `Give ${ownName(i)} a nickname (only you see it)`;
  return (
    <>
      {onOpen ? (
        <button class={cls} data-track="name" title={title} onClick={onOpen}>
          {label}
        </button>
      ) : (
        <span class={cls}>{label}</span>
      )}
      <button class="pair-nick-edit" data-track="nickname" title={pencil} aria-label="Nickname" onClick={() => setEditing(true)}>
        ✎
      </button>
    </>
  );
}

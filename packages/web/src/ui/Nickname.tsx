/**
 * Your nicknames (docs/chats.md, Names), which only you see. One for a person, no account's: it is their name over
 * every account's, set from the pencil by their name on their profile or by a one-route chat's name. One for one account
 * of theirs: it stands for that account's name wherever the account's name shows, set from the account's row on a
 * profile or the identity menu.
 */
import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { accountName } from '../chatroutes.ts';
import { netName } from '../model.ts';
import { api, isSelfIdentity, toast } from '../state.ts';
import type { MenuEntry } from './ContextMenu.tsx';

/** What the account calls itself on its network, without your nickname. */
export const ownName = (i: P.IdentityView) => accountName({ ...i, nickname: null });

/** Gives one account a nickname, or takes it away (null or empty): whether it was saved. */
async function saveNickname(identityId: string, nickname: string | null) {
  return api(`/api/identities/${identityId}`, { method: 'PATCH', body: { nickname: nickname?.trim() || null } }).then(
    () => true,
    (e) => (toast({ kind: 'error', title: 'Could not save that', body: e.message }), false),
  );
}

/** Gives a person a nickname, no account's, or takes it away (null or empty): whether it was saved. */
async function savePersonNickname(personId: string, nickname: string | null) {
  return api(`/api/persons/${personId}`, { method: 'PATCH', body: { nickname: nickname?.trim() || null } }).then(
    () => true,
    (e) => (toast({ kind: 'error', title: 'Could not save that', body: e.message }), false),
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

/**
 * The inline editor: Enter or leaving it saves, Escape keeps what was there, empty takes the nickname away. With
 * `person`, the nickname is the person's (no account's); else account `i`'s.
 */
export function NicknameInput({ i, person, onDone, class: cls = 'pair-nick-input' }: { i: P.IdentityView; person?: P.PersonView; onDone: () => void; class?: string }) {
  const now = (person ? person.nickname : i.nickname) ?? '';
  const save = (v: string) => {
    onDone();
    if (v.trim() === now) return;
    void (person ? savePersonNickname(person.id, v) : saveNickname(i.id, v));
  };
  return (
    <input
      class={cls}
      value={now}
      placeholder={ownName(i)}
      aria-label={person ? `Your nickname for ${ownName(i)}` : `Nickname for ${ownName(i)} on ${netName(i.network)}`}
      title={person ? 'Only you see it, and no network is told. Leave it empty to call them by their accounts’ names again' : `Only you see it. Leave it empty to call this account ${ownName(i)} again`}
      ref={(el) => {
        if (el && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save((e.target as HTMLInputElement).value);
        if (e.key === 'Escape') (e.preventDefault(), onDone());
      }}
      onBlur={(e) => save((e.target as HTMLInputElement).value)}
    />
  );
}

/**
 * A name that opens something, with a pencil (shown on hover) for your nickname for the person behind it (`person`),
 * else for the account: a one-route chat's header. `editing` and `setEditing` may come from outside, so a menu can
 * open it.
 */
export function NicknamedName({
  i,
  person,
  label,
  title,
  onOpen,
  editing: outer,
  setEditing: setOuter,
  class: cls = 'conv-head-name',
}: {
  i: P.IdentityView;
  person?: P.PersonView;
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
  if (editing) return <NicknameInput i={i} person={person} onDone={() => setEditing(false)} />;
  const pencil = (person ? person.nickname : i.nickname) ? `Change or remove your nickname for ${ownName(i)} (only you see it)` : `Give ${ownName(i)} a nickname (only you see it)`;
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

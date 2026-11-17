/**
 * Typing indicators, drawn the way Discord draws them (docs/typing.md): a line above the composer, and three small
 * dots on the avatar of a DM or group row while someone there types.
 */
import { typingLine } from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { authorName, personOf } from '../model.ts';
import { db, typing } from '../state.ts';
import { typersIn, type Typer } from '../typers.ts';
import { typingNow } from '../typing.ts';
import { offline, OfflineNote } from './Offline.tsx';

function typerName(t: Typer): string {
  const p = personOf(t.identityId);
  if (t.name && !(p && !p.isSelf) && !db.identities.get(t.identityId)?.displayName) return t.name;
  const n = authorName(t.identityId);
  return n === 'Unknown' ? (t.name ?? 'Someone') : n;
}

function useTypers(convIds: string[]): Typer[] {
  void typingNow.value;
  return typersIn(typing.value, convIds, Date.now());
}

function TypingDots() {
  return (
    <span class="typing-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * Always there, empty or not, so someone starting to type never moves the timeline. A person's chat puts its route line
 * ("To Sam on Signal", ui/Pairs.tsx) at the start of this row, and who is typing goes to its end (docs/chats.md). With
 * the hub out of reach its end says what happens to a send instead, and the route's "last message via" gives way.
 */
export function TypingBar({ convIds, lead }: { convIds: string[]; lead?: ComponentChildren }) {
  const typers = useTypers(convIds);
  const off = offline.value;
  const line = off ? [] : typingLine(typers.map(typerName));
  const now = line.length > 0 && (
    <>
      <TypingDots />
      <span class="typing-text">{line.map((r) => (r.bold ? <b>{r.text}</b> : r.text))}</span>
    </>
  );
  const cls = `${line.length ? 'on' : ''} ${off ? 'offline' : ''}`;
  if (!lead)
    return (
      <div class={`typing-bar ${cls}`}>
        {now}
        {off && <OfflineNote />}
      </div>
    );
  return (
    <div class={`typing-bar with-lead ${cls}`}>
      <div class="typing-lead">{lead}</div>
      {now && <div class="typing-now">{now}</div>}
      {off && <OfflineNote />}
    </div>
  );
}

/** On a row's avatar, where Discord shows a DM's typing. */
export function RowTyping({ convIds }: { convIds: string[] }) {
  const typers = useTypers(convIds);
  if (!typers.length) return null;
  return (
    <span class="row-typing" title={typingLine(typers.map(typerName)).map((r) => r.text).join('')}>
      <TypingDots />
    </span>
  );
}

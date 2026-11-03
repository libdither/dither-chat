/**
 * Typing indicators, drawn the way Discord draws them (docs/typing.md): a line above the composer, and three small
 * dots on the avatar of a DM or group row while someone there types.
 */
import { typingLine } from '@dither-chat/protocol';
import { authorName, personOf } from '../model.ts';
import { db, typing } from '../state.ts';
import { typersIn, type Typer } from '../typers.ts';
import { typingNow } from '../typing.ts';

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

export function TypingDots() {
  return (
    <span class="typing-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/** Always there, empty or not, so someone starting to type never moves the timeline. */
export function TypingBar({ convIds }: { convIds: string[] }) {
  const line = typingLine(useTypers(convIds).map(typerName));
  return (
    <div class={`typing-bar ${line.length ? 'on' : ''}`}>
      {line.length > 0 && (
        <>
          <TypingDots />
          <span class="typing-text">{line.map((r) => (r.bold ? <b>{r.text}</b> : r.text))}</span>
        </>
      )}
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

/**
 * Sensitive messages in a chat (docs/sensitive.md): the hub gives each message the local model's chance that it is
 * sensitive; the settings put two lines on it. From the first a message is covered (blurred, or its words as black
 * bars), from the second hidden: folded to one line, or gone from the chat with a count at its top. Each covered or
 * hidden message asks whether the model was right; the answer is kept on the hub and scores the question it asks.
 * What you uncover stays uncovered until the page reloads.
 */
import type { ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { sensitiveLevel } from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { answerSensitive, sensitive, toast } from '../state.ts';
import type { MenuEntry } from './ContextMenu.tsx';

/** Messages you uncovered, and chats whose gone messages you asked to see, this session. */
const uncovered = signal<ReadonlySet<string>>(new Set());
const shownIn = signal<ReadonlySet<string>>(new Set());
const uncover = (ids: string[]) => (uncovered.value = new Set([...uncovered.value, ...ids]));

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** What the chat does with a message now: shown, covered or hidden, unless you uncovered it. */
export function levelOf(m: P.MessageView): P.SensitiveLevel {
  const level = sensitiveLevel(sensitive.value?.settings, m.sensitive);
  return level !== 'shown' && uncovered.value.has(m.id) ? 'shown' : level;
}

/** Above the hide line, in "gone" mode, and not asked to be shown in this chat: no row at all. */
export function goneHere(m: P.MessageView, chatKey: string): boolean {
  return levelOf(m) === 'hide' && sensitive.value?.settings.top === 'gone' && !shownIn.value.has(chatKey);
}

async function answer(m: P.MessageView, vote: boolean | null) {
  try {
    await answerSensitive(m, vote);
  } catch (e) {
    toast({ kind: 'error', title: 'Could not keep your answer', body: (e as Error).message });
  }
}

/** "Was the model right?": on a covered or hidden message, and on one you uncovered. Your answer, once given, shows. */
export function Answer({ m, level }: { m: P.MessageView; level: P.SensitiveLevel | 'uncovered' }) {
  const s = m.sensitive;
  if (!s) return null;
  if (s.vote !== undefined)
    return (
      <div class="sens-answer">
        You said: {s.vote ? 'sensitive' : 'fine to show'} · model {pct(s.p)}
        <button onClick={() => void answer(m, null)}>Undo</button>
      </div>
    );
  const said = level === 'shown' ? 'Model gives it' : level === 'uncovered' ? 'Was covered' : level === 'cover' ? 'Covered' : 'Hidden';
  return (
    <div class="sens-answer">
      {said} · {pct(s.p)} · Sensitive?
      <button class="yes" onClick={() => void answer(m, true)}>
        Yes
      </button>
      <button class="no" onClick={() => void answer(m, false)}>
        No, fine
      </button>
    </div>
  );
}

/** The message's words and files under a cover, with a button to uncover them; as they are when not covered. */
export function Cover({ m, children }: { m: P.MessageView; children: ComponentChildren }) {
  const level = levelOf(m);
  const wasCovered = level === 'shown' && uncovered.value.has(m.id);
  if (level !== 'cover')
    return (
      <>
        {children}
        {wasCovered && <Answer m={m} level="uncovered" />}
      </>
    );
  const style = sensitive.value?.settings.style ?? 'blur';
  return (
    <>
      <div class={`sens-cover sens-${style}`}>
        <div class="sens-inner" aria-hidden="true" inert>
          {children}
        </div>
        <button class="sens-reveal" onClick={() => uncover([m.id])}>
          Sensitive · show
        </button>
      </div>
      <Answer m={m} level="cover" />
    </>
  );
}

/** A hidden message folded to one line in its place. */
export function HiddenLine({ m }: { m: P.MessageView }) {
  return (
    <div class="sens-line" id={`m-${m.id}`}>
      <span>Sensitive message hidden · {m.sensitive ? pct(m.sensitive.p) : ''}</span>
      <button onClick={() => uncover([m.id])}>Show</button>
      <Answer m={m} level="hide" />
    </div>
  );
}

/** At the top of a chat, in "gone" mode: how many it holds back, and a way to see them. */
export function GoneBanner({ count, chatKey }: { count: number; chatKey: string }) {
  if (!count) return null;
  return (
    <div class="sens-gone">
      {count === 1 ? '1 sensitive message hidden here' : `${count} sensitive messages hidden here`}
      <button onClick={() => (shownIn.value = new Set([...shownIn.value, chatKey]))}>Show them</button>
    </div>
  );
}

/** The message menu's entry: say it is sensitive, or fine, whatever the model said. */
export function sensitiveEntry(m: P.MessageView): MenuEntry | false {
  if (!sensitive.value?.settings.on || m.kind === 'system' || m.deleted) return false;
  const vote = m.sensitive?.vote;
  return {
    label: 'Sensitive…',
    icon: 'eye',
    track: 'sensitive',
    sub: [
      { label: vote === true ? '✓ Sensitive' : 'Sensitive', track: 'sensitive (yes)', run: () => void answer(m, true) },
      { label: vote === false ? '✓ Fine to show' : 'Fine to show', track: 'sensitive (no)', run: () => void answer(m, false) },
      ...(vote !== undefined ? [{ label: 'Take back my answer', track: 'sensitive (undo)', run: () => void answer(m, null) }] : []),
    ],
  };
}

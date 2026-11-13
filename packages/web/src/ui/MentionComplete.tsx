/**
 * `@` mentions in the composer (docs/mentions.md). What rides in the app is only this: it watches the box for an `@`
 * being typed (mentionComplete.ts), and the first time one is, loads the list (MentionPicker.tsx), a chunk of its own,
 * which from then on draws it and owns its keys.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { findMentionTrigger } from '../mentionComplete.ts';

export interface MentionProps {
  ta: { current: HTMLTextAreaElement | null };
  convId: string;
  network?: P.Network;
  /** The account the composer sends from: the one the hub asks. */
  accountId?: string;
}

type Chunk = typeof import('./MentionPicker.tsx');
let chunk: Chunk | null = null;
let loading: Promise<Chunk> | null = null;

function load(): Promise<Chunk> {
  return (loading ??= import('./MentionPicker.tsx').then(
    (m) => (chunk = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

export function MentionComplete(props: MentionProps) {
  const [picker, setPicker] = useState<Chunk | null>(chunk);
  useEffect(() => {
    const el = props.ta.current;
    if (picker || !el) return;
    const look = () => {
      if (el.selectionStart === el.selectionEnd && findMentionTrigger(el.value, el.selectionStart)) load().then(setPicker, () => {});
    };
    el.addEventListener('input', look);
    el.addEventListener('click', look);
    return () => {
      el.removeEventListener('input', look);
      el.removeEventListener('click', look);
    };
  }, [props.ta.current, picker]);
  return picker ? <picker.MentionPicker {...props} find={findMentionTrigger} /> : null;
}

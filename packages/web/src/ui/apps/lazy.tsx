/**
 * Bots and apps (docs/apps.md) in the main bundle: only what decides whether to load the chunk (Apps.tsx), which has
 * the slash-command picker, the form dialog and a message's Apps. It loads the first time a body starts with "/"
 * where the account has slash commands, a bot opens a form, or a message's Apps are asked for.
 */
import { useEffect, useState } from 'preact/hooks';
import { appsFor, can, forms } from '../../apps.ts';

type Chunk = typeof import('./Apps.tsx');
let chunk: Chunk | null = null;
let loading: Promise<Chunk> | null = null;
const load = () =>
  (loading ??= import('./Apps.tsx').then(
    (c) => (chunk = c),
    (e) => {
      loading = null;
      throw e;
    },
  ));

function useChunk(want: boolean): Chunk | null {
  const [c, setC] = useState(chunk);
  useEffect(() => {
    if (want && !c) load().then(setC, () => {});
  }, [want]);
  return want ? c : null;
}

/** The composer's slash commands, over its box. */
export function SlashCommandsLazy({ ta, convId, accountId, text }: { ta: { current: HTMLTextAreaElement | null }; convId: string; accountId?: string; text: string }) {
  const c = useChunk(text.startsWith('/') && can(convId, 'interactCommands', accountId));
  return c ? <c.SlashCommands ta={ta} convId={convId} accountId={accountId} text={text} /> : null;
}

/** Forms bots opened and a message's Apps, over everything. */
export function AppsHostLazy() {
  const c = useChunk(forms.value.length > 0 || !!appsFor.value);
  return c ? <c.AppsHost /> : null;
}

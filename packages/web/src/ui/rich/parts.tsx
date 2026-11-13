/**
 * What a message carries beyond its text and files (docs/rich-messages.md), the light part: the lines above its text
 * (who ran the command a bot answers, where a crosspost came from), the marks beside its time, and the veil over a
 * spoilered or explicit picture. These are in the main bundle; a bot's controls, quotes of linked messages, the
 * voice-message player and the video player are a chunk of their own (Rich.tsx), loaded when a message has one.
 */
import type * as P from '@dither-chat/protocol';
import { waveformPoints } from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { clock } from '../../format.ts';
import { renderMarkdown } from '../../markdown.ts';
import { authorName, plainBody } from '../../model.ts';
import { db, openMessage } from '../../state.ts';
import { Icon } from '../icons.tsx';

/** What the chunk uses of the app, handed to it: importing these there would split them off the app's start. */
const kit = {
  md: (text: string, network: P.Network) => renderMarkdown(text, { network, user: () => null, room: () => null }),
  name: authorName,
  plain: plainBody,
  when: clock,
  open: openMessage,
  icon: (name: string, size: number) => <Icon name={name} size={size} />,
  points: waveformPoints,
};
export type Kit = typeof kit;

/** Who did what a bot's message answers, and where a crosspost came from: lines above the text. */
export function RichHead({ m }: { m: P.MessageView }) {
  const r = m.rich;
  if (!r?.interaction && !r?.crosspost) return null;
  const i = r.interaction;
  const who = i ? (i.user ? db.identityByNative.get(`${m.network}:${i.user}`) : undefined) : undefined;
  const name = who ? authorName(who) : (i?.userName ?? 'Someone');
  return (
    <>
      {i && (
        <div class="rich-line">
          <Icon name="reply" size={12} />
          <b>{name}</b> {i.kind === 'command' || i.kind === 'context' ? <>used <code>{i.kind === 'command' ? `/${i.name ?? 'a command'}` : (i.name ?? 'an app')}</code></> : i.kind === 'modal' ? 'filled in a form' : 'pressed a button'}
        </div>
      )}
      {r.crosspost && (
        <div class="rich-line">
          <Icon name="announcement" size={12} />
          from {[r.crosspost.channel ? `#${r.crosspost.channel}` : null, r.crosspost.server].filter(Boolean).join(' in ') || 'a followed channel'}
        </div>
      )}
    </>
  );
}

/** Marks beside the time: sent silently, only you can see it, the server's own, a suspended author. */
export function RichMarks({ m }: { m: P.MessageView }) {
  const r = m.rich;
  if (!r?.silent && !r?.marks) return null;
  const k = r.marks ?? {};
  return (
    <>
      {r.silent && (
        <span class="msg-pin" title="Sent silently: it notified no one" aria-label="Sent silently">
          <Icon name="bellOff" size={11} />
        </span>
      )}
      {k.ephemeral && <span class="rich-mark" title="Only you can see this message">Only you</span>}
      {k.official && <span class="rich-mark" title="An official message of this server">Official</span>}
      {k.hiddenSuspended && <span class="rich-mark" title="Its author's account is suspended">Suspended</span>}
    </>
  );
}

/** A spoilered or explicit picture or video: blurred, with a word on it, until clicked. */
export const veiled = (a: P.AttachmentView) => !!(a.spoiler || a.explicit);

export function Veil({ a, children }: { a: P.AttachmentView; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  // The same file shown again (an edit, a later page) starts veiled again only if it is a new one.
  useEffect(() => setOpen(false), [a.url]);
  if (open) return <>{children}</>;
  return (
    <span
      class="veil"
      role="button"
      tabindex={0}
      onClickCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
      }}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(true))}
    >
      {children}
      <b class="veil-word">{a.explicit ? 'May be explicit' : 'Spoiler'}</b>
    </span>
  );
}

/** A picture's alt text: a small ALT on it, saying the text on hover and when held. */
export function AltBadge({ alt }: { alt?: string }) {
  if (!alt) return null;
  return (
    <span class="alt-badge" title={alt} aria-label={`Alt text: ${alt}`}>
      ALT
    </span>
  );
}

type Chunk = typeof import('./Rich.tsx');
let chunk: Chunk | null = null;
let loading: Promise<Chunk> | null = null;
const load = () =>
  (loading ??= import('./Rich.tsx').then(
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

/** A bot's controls, an activity invite and quotes of the messages it links to, under the message. */
export function RichFoot({ m }: { m: P.MessageView }) {
  const r = m.rich;
  const c = useChunk(!!(r?.components?.length || r?.linked?.length || r?.activity));
  return c && r ? <c.RichFoot m={m} rich={r} kit={kit} /> : null;
}

/** A voice message's player, with its waveform and length. Until the chunk is in, the plain player. */
export function Voice({ a, index }: { a: P.AttachmentView; index: number }) {
  const c = useChunk(true);
  return c ? <c.VoicePlayer a={a} index={index} kit={kit} /> : <audio class="att-audio" data-att={index} src={a.url} controls preload="metadata" />;
}

/** An embed's video: a file played here, or a player page loaded only once clicked. */
export function EmbedVideo({ e }: { e: P.EmbedView }) {
  const c = useChunk(!!e.video);
  return c && e.video ? <c.EmbedVideo e={e} kit={kit} /> : null;
}

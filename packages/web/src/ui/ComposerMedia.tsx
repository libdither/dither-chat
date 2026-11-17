/**
 * The composer's stickers, GIFs, voice messages and view-once (docs/media-kinds.md): small buttons here, and the pickers and
 * the recorder in a chunk with stories (MediaParts.tsx), loaded the first time one is pressed. Each is offered
 * only where the sending account says it can (capabilities 'sendStickers', 'sendMedia' with or without 'sendVoice',
 * 'sendViewOnce').
 */
import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { signalStickerLink } from '@dither-chat/protocol';
import { db, toast } from '../state.ts';
import { Icon } from './icons.tsx';
import { LOTTIE_MIME, Sticker } from './Sticker.tsx';
import type { GifPick } from './ComposerMediaParts.tsx';

type Parts = typeof import('./MediaParts.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;
const load = (): Promise<Parts> =>
  (loading ??= import('./MediaParts.tsx').then(
    (m) => (parts = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));

function useParts(want: boolean): Parts | null {
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (want && !m) load().then(setM, () => {});
  }, [want]);
  return m;
}

/** What the sending account offers here. */
export function mediaOffer(acc: P.AccountView | undefined, canAttach: boolean) {
  const has = (c: P.Capability) => !!acc?.capabilities.includes(c);
  return { stickers: has('sendStickers'), record: canAttach, voice: canAttach && has('sendVoice'), viewOnce: canAttach && has('sendViewOnce') };
}

/** Starts loading the picker's chunk, so it opens whole (on the way to a button that opens it). */
export const preloadStickers = () => void load().catch(() => {});

/** The sticker picker beside `anchor` (the + menu's Sticker on a computer, the + sheet's on a phone). */
export function StickerPicker({ conversationId, accountId, anchor, onSend, onClose, inline }: { conversationId: string; accountId?: string; anchor?: DOMRect; onSend: (sticker: P.StickerView) => void; onClose: () => void; inline?: boolean }) {
  const m = useParts(true);
  if (!m) return null;
  return (
    <m.StickerPicker
      conversationId={conversationId}
      accountId={accountId}
      anchor={anchor}
      inline={inline}
      onPick={(s) => {
        // In the panel it stays, as Telegram's does, for another.
        if (!inline) onClose();
        onSend(s);
      }}
      onClose={onClose}
      draw={drawSticker}
    />
  );
}

/** The GIF picker beside `anchor` (the + menu's GIF on a computer), or in the phone's panel (`inline`). */
export function GifPicker({ conversationId, anchor, onSend, onClose, inline }: { conversationId: string; anchor?: DOMRect; onSend: (g: GifPick) => void; onClose: () => void; inline?: boolean }) {
  const m = useParts(true);
  if (!m) return null;
  return (
    <m.GifPicker
      conversationId={conversationId}
      anchor={anchor}
      inline={inline}
      onPick={(g) => {
        if (!inline) onClose();
        onSend(g);
      }}
      onClose={onClose}
    />
  );
}

/**
 * A picked GIF, as the chat's network takes one: on Discord its link where it has one (Discord draws it back as the
 * GIF, as its own picker sends it); elsewhere its file, marked as a GIF so a network with its own GIFs sends one.
 */
export async function gifSend(g: GifPick, network: P.Network): Promise<{ body: string } | { file: File }> {
  if (network === 'discord' && g.url) return { body: g.url };
  const r = await fetch(g.file);
  if (!r.ok) throw new Error(`The GIF did not load (${r.status})`);
  const blob = await r.blob();
  const ext = blob.type === 'video/mp4' ? 'mp4' : blob.type === 'video/webm' ? 'webm' : blob.type === 'image/svg+xml' ? 'svg' : 'gif';
  const base = (g.title ?? 'gif').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'gif';
  return { file: new File([blob], `${base}.${ext}`, { type: blob.type || 'image/gif' }) };
}

const drawSticker = (s: P.StickerView) =>
  s.mime === LOTTIE_MIME ? <Sticker a={{ id: s.id, kind: 'image', mime: s.mime, name: s.name, size: null, width: 160, height: 160, url: s.url }} index={0} /> : <img src={s.url} alt={s.name} loading="lazy" width={80} height={80} />;

/**
 * The microphone: the first press asks for the microphone (not before), records, and shows the recording to play,
 * throw away or send. `voice`: send it as the network's voice message; otherwise it goes as an audio file.
 */
export function VoiceButton({ conversationId, onPhone, voice, onSend }: { conversationId: string; onPhone: boolean; voice: boolean; onSend: (file: File, out: P.VoiceOut | null) => void }) {
  const [open, setOpen] = useState(false);
  const m = useParts(open);
  useEffect(() => setOpen(false), [conversationId]);
  return (
    <>
      <button class="send-btn composer-mic" data-track="record voice" aria-label="Record a voice message" title="Record a voice message" onPointerEnter={() => void load().catch(() => {})} onClick={() => setOpen(true)}>
        <Icon name="mic" size={onPhone ? 19 : 17} />
      </button>
      {open && m && (
        <m.VoiceRecorder
          voice={voice}
          onSend={(f, out) => {
            setOpen(false);
            onSend(f, out);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** "View once" for the files attached, where the network has it. */
export function ViewOnceChip({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  return (
    <button class={`view-once-chip ${on ? 'on' : ''}`} data-track="view once" aria-pressed={on} title="They can open these once, on their phone" onClick={() => set(!on)}>
      <Icon name={on ? 'eyeOff' : 'eye'} size={13} /> View once
    </button>
  );
}

/**
 * The account that would install a signal.art sticker pack this link names: the message's own Signal account, else
 * any that can (capability 'installStickers'). Null when the link is not one or none can.
 */
export function stickerInstaller(url: string, seenVia: string[] = []): P.AccountView | null {
  if (!signalStickerLink(url)) return null;
  const can = [...db.accounts.values()].filter((a) => a.capabilities.includes('installStickers') && a.status === 'online');
  return can.find((a) => seenVia.includes(a.id)) ?? can[0] ?? null;
}

/** Install it, on the owner's click in the link's menu, and say how it went. */
export async function installStickerLink(url: string, acc: P.AccountView) {
  try {
    const pack = await (await load()).installPack(acc.id, url);
    toast({ kind: 'info', title: 'Sticker pack installed', body: `${pack.name}, in ${acc.label}'s stickers` });
  } catch (e) {
    toast({ kind: 'error', title: 'Sticker pack not installed', body: (e as Error).message });
  }
}

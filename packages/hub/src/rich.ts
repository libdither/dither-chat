/**
 * The parts of a message beyond its text and files, as the hub keeps and shows them (docs/rich-messages.md):
 * attachment alt text, spoilers, explicit flags and voice messages; embeds in full; and the keys of protocol
 * rich.ts (a bot's controls, marks, crossposts, commands, activity invites, roles named), with the stored messages a
 * message links to. store.ts calls these; nothing here writes.
 */

import type * as P from '@dither-chat/protocol';
import { messageLinks } from '@dither-chat/protocol';

type Row = Record<string, any>;
type Media = (url: string | null | undefined) => string | null;

/** What of an attachment goes in its `extra` column, as JSON; null when nothing. Alt text has a column of its own. */
export function attachmentExtra(a: P.AttachmentFact): string | null {
  const x: Record<string, unknown> = {};
  if (a.spoiler) x.spoiler = true;
  if (a.explicit) x.explicit = true;
  if (a.voice && (a.voice.seconds !== undefined || a.voice.waveform)) {
    const v: P.VoiceFact = {};
    if (typeof a.voice.seconds === 'number' && Number.isFinite(a.voice.seconds) && a.voice.seconds >= 0) v.seconds = a.voice.seconds;
    if (typeof a.voice.waveform === 'string' && a.voice.waveform.length <= 2048) v.waveform = a.voice.waveform;
    x.voice = v;
  }
  return Object.keys(x).length ? JSON.stringify(x) : null;
}

/** An attachment row's alt text and extra, as AttachmentView fields. */
export function attachmentRich(r: Row): Partial<P.AttachmentView> {
  const out: Partial<P.AttachmentView> = {};
  if (r.alt) out.alt = r.alt;
  if (!r.extra) return out;
  try {
    const x = JSON.parse(r.extra) as { spoiler?: boolean; explicit?: boolean; voice?: P.VoiceFact };
    if (x.spoiler) out.spoiler = true;
    if (x.explicit) out.explicit = true;
    if (x.voice) out.voice = x.voice;
  } catch {}
  return out;
}

/** The message's own extra as stored: its embeds, the forward, and RichExtra's keys. */
export interface StoredExtra extends P.RichExtra {
  embeds?: P.EmbedView[];
  silent?: boolean;
}

/** A message's embeds as the app shows them, every picture through the hub; none when its author hid them. */
export function embedViews(x: StoredExtra, media: Media): P.EmbedView[] {
  if (!x.embeds?.length || x.marks?.suppressEmbeds) return [];
  return x.embeds.map((e) => {
    const v: P.EmbedView = { ...e, image: media(e.image) ?? undefined };
    if (e.footerIcon !== undefined) v.footerIcon = media(e.footerIcon) ?? undefined;
    if (e.authorIcon !== undefined) v.authorIcon = media(e.authorIcon) ?? undefined;
    if (e.video) {
      // A player page is loaded by the app only when clicked, and only from a host it knows; a file goes through the hub.
      if (e.video.player) v.video = e.video;
      else {
        const url = media(e.video.url);
        v.video = url ? { ...e.video, url } : undefined;
        if (!url) delete v.video;
      }
    }
    return v;
  });
}

/** What may follow a message link: the stored message it points at, or nothing. */
export type FindLinked = (network: P.Network, nativeId: string) => Row | null;

/** MessageView.rich: what the stored extra has of RichExtra, sent silently, and the messages its links point at. */
export function richView(x: StoredExtra, network: P.Network, body: string, find: FindLinked): P.RichView | undefined {
  const v: P.RichView = {};
  if (x.components?.length) v.components = x.components;
  if (x.application) v.application = x.application;
  if (x.marks && Object.keys(x.marks).length) v.marks = x.marks;
  if (x.crosspost) v.crosspost = x.crosspost;
  if (x.interaction) v.interaction = x.interaction;
  if (x.activity) v.activity = x.activity;
  if (x.roles?.length) v.roles = x.roles;
  if (x.silent) v.silent = true;
  if (network === 'discord') {
    const linked: P.LinkedMessageView[] = [];
    for (const l of messageLinks(body)) {
      const r = find(l.network, l.message);
      if (!r || r.deleted) continue;
      linked.push({ messageId: r.id, conversationId: r.conversation_id, authorId: r.author_id ?? null, ts: r.ts, text: String(r.body ?? '').slice(0, 300), ...(r.attachments ? { attachments: r.attachments } : {}) });
    }
    if (linked.length) v.linked = linked;
  }
  return Object.keys(v).length ? v : undefined;
}

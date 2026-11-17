/**
 * GIFs drawn as just the GIF (docs/media-kinds.md "GIFs"), the setting "Show GIFs as plain GIFs" (on unless switched
 * off on this device): a Discord GIF link with no link text or card, as Discord's own app draws one, and the networks'
 * GIF videos looping silently with no player.
 */
import type * as P from '@dither-chat/protocol';
import { prefs } from './state.ts';

export const plainGifs = () => prefs.value.plainGifs !== false;

/**
 * A message that is just a GIF's link which Discord drew as a GIF (one gifv embed, no files): that embed, where the
 * setting is on; else null.
 */
export function gifLinkOf(m: P.MessageView): P.EmbedView | null {
  if (!plainGifs() || m.embeds.length !== 1 || m.attachments.length) return null;
  const e = m.embeds[0];
  if (!e.video?.gifv || e.video.player || !e.video.url) return null;
  return /^<?https?:\/\/\S+?>?$/.test(m.body.trim()) ? e : null;
}

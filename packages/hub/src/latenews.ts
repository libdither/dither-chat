/**
 * A message heard late (`late` on a message event, protocol attention.ts): one that concerns you, which the network's
 * own list told of after the fact (Discord's recent mentions, for places its client had not loaded). It goes in as
 * backfill does, unread; and while it is younger than LATE_NEWS_MS by its own time it is triaged as a live one, so a
 * true mention found a minute late still reaches you, and one found an hour late never buzzes.
 */
import type * as P from '@dither-chat/protocol';
import { LATE_NEWS_MS } from '@dither-chat/protocol';

export function lateNews(ev: Extract<P.AdapterEvent, { t: 'message' }>, now = Date.now()): boolean {
  if (ev.live || ev.late !== true) return false;
  const ts = ev.message?.ts;
  return typeof ts === 'number' && Number.isFinite(ts) && ts >= now - LATE_NEWS_MS && ts <= now + LATE_NEWS_MS;
}

/**
 * Where opening a conversation goes. Its own module (not ui/Sidebar.tsx), so a component the sidebar draws can open a
 * conversation without importing the sidebar back (docs/testing.md "Import cycles").
 */
import type * as P from '@dither-chat/protocol';
import { convsUnder, placeConv, rootCommunity } from './model.ts';
import { go, route, type Route } from './state.ts';

/** Open a conversation, keeping the current sidebar context when it contains it. */
export function openConv(c: P.ConversationView, ctx: Route = route.value) {
  if (ctx.view === 'folder') return go({ view: 'folder', folder: ctx.folder, conv: c.id });
  if (ctx.view === 'inbox') return go({ view: 'inbox', conv: c.id });
  if (ctx.view === 'search') return go({ view: 'search', q: ctx.q, conv: c.id });
  if (ctx.view === 'space' && convsUnder(ctx.space).some((x) => x.id === c.id)) return go({ view: 'space', space: ctx.space, conv: c.id });
  return go(homeRoute(c));
}

export function homeRoute(c: P.ConversationView): Route {
  if (c.shape === 'direct' && c.peerPersonId) return { view: 'people', person: c.peerPersonId };
  const base = placeConv(c);
  if (base.spaceIds.length) {
    const root = rootCommunity(base.spaceIds[0]);
    if (root) return { view: 'space', space: root.id, conv: c.id };
  }
  // Group chats, rooms outside a space and notes to self live in the inbox.
  return { view: 'inbox', conv: c.id };
}

/** About lives on the place's profile page now (PlaceProfile.tsx). */
export function openAbout(kind: 'space' | 'conversation', id: string) {
  go(kind === 'space' ? { view: 'profile', space: id } : { view: 'profile', conv: id });
}

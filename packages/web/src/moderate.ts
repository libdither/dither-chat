/**
 * A moderator's actions on others' messages (docs/moderation.md): deleting one for everyone and taking reactions off,
 * offered only where the conversation's reaction context (asked as it opens, reactions.ts) says this account may.
 * Each after a confirm; the hub asks the network again first.
 */
import type * as P from '@dither-chat/protocol';
import { authorName } from './model.ts';
import { knownReactionContext } from './reactions.ts';
import { api, isSelfIdentity, toast } from './state.ts';

/** What this account may do to this message as a moderator, as far as is known now. */
export function modOf(m: P.MessageView): P.MessageModeration | null {
  if (m.deleted || isSelfIdentity(m.authorId)) return null;
  return knownReactionContext(m.conversationId)?.moderation ?? null;
}

export function moderatorDelete(m: P.MessageView) {
  if (!confirm(`Delete ${authorName(m.authorId)}'s message for everyone? You may as a moderator here; it goes to the network and cannot be undone.`)) return;
  api(`/api/messages/${m.id}/moderate-delete`, { body: {} }).catch((e) => toast({ kind: 'error', title: 'Could not delete', body: e.message }));
}

/** All reactions (no key), one emoji's, or one person's. */
export function clearReactions(m: P.MessageView, key?: string, identityId?: string, label?: string) {
  const what = identityId ? `${authorName(identityId)}'s ${label ?? key} reaction` : key ? `every ${label ?? key} reaction` : 'every reaction';
  if (!confirm(`Remove ${what} from this message? You may as a moderator here.`)) return;
  api(`/api/messages/${m.id}/clear-reactions`, { body: { ...(key ? { key } : {}), ...(identityId ? { identityId } : {}) } satisfies P.ClearReactionsRequest }).catch((e) =>
    toast({ kind: 'error', title: 'Could not remove the reactions', body: e.message }),
  );
}

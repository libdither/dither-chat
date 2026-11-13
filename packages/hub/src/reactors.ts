/**
 * Who liked or reposted a post, in the order they are likely to matter to you (docs/feed.md "Who reacted"). The
 * network's own order (X ranks likers when asked) is one signal among what the hub knows: how much you talk with
 * them anywhere, how often they react to your posts, whether you follow each other, and how many follow them.
 * Nothing here asks the network or reads what anyone said.
 */
import type * as P from '@dither-chat/protocol';
import type { Store } from './store.ts';

type Row = Record<string, any>;

export interface ReactorIn {
  identityId: string;
  followers?: number;
  followsYou?: boolean;
  following?: boolean;
  ts?: number;
}

const DAY = 86_400_000;
/** Talk counts over this long. */
const TALK_WINDOW = 180 * DAY;

/** Weights of the score's parts; they add to 1. */
export const REACTOR_WEIGHTS = { talk: 0.32, engage: 0.18, bond: 0.2, reach: 0.22, order: 0.08 } as const;

/** "12K followers" */
const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}K` : String(n));

/**
 * The list ranked. Parts, each 0 to 1:
 * - talk: messages between you and their person in direct chats in the last half year (log, 200 is full);
 * - engage: their reactions and replies in your feeds (log, 30 is full);
 * - bond: you follow each other 1, they follow you 0.6, you follow them 0.5;
 * - reach: their followers (log10, a million is full), from the network's answer or their kept profile;
 * - order: their place in the network's own list.
 */
export function rankReactors(store: Store, people: readonly ReactorIn[], now = Date.now()): P.ReactorView[] {
  const n = people.length;
  const out = people.map((r, i): P.ReactorView => {
    const ident = store.one<Row>('SELECT person_id FROM identity WHERE id = ?', r.identityId);
    let talk = 0;
    if (ident?.person_id) {
      const convs = store.personDirects(ident.person_id);
      if (convs.length) {
        const ph = convs.map(() => '?').join(',');
        talk = store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM message WHERE conversation_id IN (${ph}) AND deleted = 0 AND ts > ?`, ...convs, now - TALK_WINDOW)?.n ?? 0;
      }
    }
    const engage = store.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE c.variant = 'feed' AND m.author_id = ? AND m.deleted = 0`,
      r.identityId,
    )?.n ?? 0;
    // What their kept profile says, where the network's answer did not.
    let followers = r.followers;
    let followsYou = r.followsYou;
    let following = r.following;
    if (followers === undefined || followsYou === undefined || following === undefined) {
      const a = store.one<{ data: string }>('SELECT data FROM about WHERE target_id = ? ORDER BY fetched_at DESC LIMIT 1', r.identityId);
      try {
        const about = a ? (JSON.parse(a.data) as P.PersonAbout) : null;
        followers ??= about?.counts?.followers;
        followsYou ??= about?.followsYou;
        following ??= about?.relationship === 'following' || about?.relationship === 'friend' ? true : undefined;
      } catch {}
    }
    const bond = followsYou && following ? 1 : followsYou ? 0.6 : following ? 0.5 : 0;
    const parts = {
      talk: Math.min(1, Math.log1p(talk) / Math.log1p(200)),
      engage: Math.min(1, Math.log1p(engage) / Math.log1p(30)),
      bond,
      reach: followers ? Math.min(1, Math.log10(1 + followers) / 6) : 0,
      order: n > 1 ? 1 - i / (n - 1) : 1,
    };
    const score = Object.entries(REACTOR_WEIGHTS).reduce((s, [k, w]) => s + w * parts[k as keyof typeof parts], 0);
    const why: string[] = [];
    if (talk >= 3) why.push(talk >= 50 ? 'You talk often' : 'You talk');
    if (followsYou && following) why.push('You follow each other');
    else if (followsYou) why.push('Follows you');
    else if (following) why.push('You follow them');
    if (engage >= 2) why.push(`Reacted to your posts ${engage} times`);
    if (followers && followers >= 1000) why.push(`${short(followers)} followers`);
    return {
      identityId: r.identityId,
      score: Math.round(score * 1000) / 1000,
      why,
      ...(followers !== undefined ? { followers } : {}),
      ...(followsYou !== undefined ? { followsYou } : {}),
      ...(following !== undefined ? { following } : {}),
      ...(r.ts ? { ts: r.ts } : {}),
    };
  });
  // Ties keep the network's order.
  return out.map((v, i) => ({ v, i })).sort((a, b) => b.v.score - a.v.score || a.i - b.i).map((x) => x.v);
}

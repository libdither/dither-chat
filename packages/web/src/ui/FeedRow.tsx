/**
 * The inbox's row for a network's notifications about you (docs/feed.md), under Requests: the network, how many new,
 * who (their pictures), what the newest card says ("Alice and 3 others liked your post") and when. One per feed, while
 * it has something unread or something from the last day. It counts on no badge. Opening it is the feed's page.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect } from 'preact/hooks';
import { feedRow, isFeedConv } from '../feed.ts';
import { ago } from '../format.ts';
import { authorName, netName } from '../model.ts';
import { db, go, loadTimeline, route, timelineKey, timelineRev, timelines } from '../state.ts';
import { Avatar, NetBadge } from './bits.tsx';

/** The feeds, one per account that has one. */
export const feedConvs = (): P.ConversationView[] => [...db.conversations.values()].filter(isFeedConv);

function FeedRow({ c }: { c: P.ConversationView }) {
  const tkey = timelineKey('c', c.id);
  timelineRev(tkey).value;
  const unread = c.vantages.some((v) => v.unread > 0);
  // Who and what come from the feed's newest page: what the hub stored, without asking the network (a glance).
  useEffect(() => void (unread && loadTimeline(tkey, false, { glance: true })), [unread, tkey]);
  const row = feedRow(c, timelines.get(tkey)?.messages ?? null, authorName);
  if (!row) return null;
  const r = route.value;
  const active = 'conv' in r && r.conv === c.id;
  const net = netName(c.network);
  return (
    <button class={`row feed-row ${active ? 'active' : ''} ${row.count ? 'unread' : ''}`} data-track="feed row" data-feed={c.id} onClick={() => go({ view: 'inbox', conv: c.id })} title={`What happened on ${net}: likes, reposts, replies, mentions, quotes and follows`}>
      <span class="row-avatar">
        <NetBadge network={c.network} size={36} class="feed-row-net" />
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            {net} notifications {row.count > 0 && <span class="requests-count">{row.count}</span>}
          </span>
          <span class="row-time">{ago(row.lastAt)}</span>
        </span>
        <span class="row-bottom">
          {row.who.length > 0 && (
            <span class="feed-row-who" aria-hidden="true">
              {row.who.map((id) => {
                const i = db.identities.get(id);
                return <Avatar id={id} name={authorName(id)} url={i?.avatar} size={18} />;
              })}
            </span>
          )}
          <span class="row-preview">{row.what}</span>
        </span>
      </span>
    </button>
  );
}

export function FeedRows() {
  return (
    <>
      {feedConvs().map((c) => (
        <FeedRow key={c.id} c={c} />
      ))}
    </>
  );
}

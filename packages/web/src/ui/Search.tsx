import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { clock } from '../format.ts';
import { authorName, communitiesOf, convLabel, convTitle, netName } from '../model.ts';
import { api, db, go, rev } from '../state.ts';
import { Avatar, Empty, NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';

export function SearchPane({ q, activeConv }: { q: string; activeConv?: string }) {
  rev.value;
  const [results, setResults] = useState<P.MessageView[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api<P.MessagePage>(`/api/search?q=${encodeURIComponent(q)}`)
      .then((p) => {
        p.identities.forEach((i) => db.identities.set(i.id, i));
        setResults(p.messages.slice().reverse());
      })
      .finally(() => setLoading(false));
  }, [q]);
  return (
    <section class="pane">
      <header class="conv-head">
        <span class="conv-head-icon">
          <span class="conv-head-variant">
            <Icon name="search" size={18} />
          </span>
        </span>
        <div class="conv-head-text">
          <h2>“{q}”</h2>
          <div class="conv-head-sub">{results ? `${results.length} matches across every network` : 'Searching…'}</div>
        </div>
      </header>
      <div class="search-results">
        {loading && <div class="timeline-loading">Searching…</div>}
        {results && results.length === 0 && <Empty icon="search" title="No matches" >Nothing stored on the hub matches that.</Empty>}
        {results?.map((m) => {
          const c = db.conversations.get(m.conversationId);
          if (!c) return null;
          const com = communitiesOf(c)[0];
          return (
            <button class={`search-hit ${m.conversationId === activeConv ? 'active' : ''}`} onClick={() => go({ view: 'search', q, conv: c.id })}>
              <Avatar id={m.authorId ?? m.id} name={authorName(m.authorId)} url={db.identities.get(m.authorId ?? '')?.avatar} size={30} network={m.network} />
              <span class="search-hit-main">
                <span class="search-hit-top">
                  <b>{authorName(m.authorId)}</b>
                  <span class="search-hit-place">
                    <NetGlyph network={m.network} size={10} /> {c.shape === 'direct' ? convTitle(c) : convLabel(c)}
                    {com ? ` · ${com.name}` : ''}
                  </span>
                  <span class="search-hit-time">{clock(m.ts)}</span>
                </span>
                <span class="search-hit-body">{m.body.slice(0, 240)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

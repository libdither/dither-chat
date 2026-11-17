/**
 * A profile's "Maybe the same person" card (docs/same-person.md): the Same person? suggestions with this person in
 * them, with why, Merge and Not the same. The whole list is at People → Same person?.
 */
import type * as P from '@dither-chat/protocol';
import { MATCH_STRONG } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api, go, toast } from '../state.ts';
import { Avatar, NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Card } from './ProfileShell.tsx';

const ICON: Record<P.MatchEvidenceKind, string> = {
  claims: 'link',
  contact: 'phone',
  bridge: 'merge',
  picture: 'image',
  name: 'idBadge',
  friends: 'users',
  bio: 'fileText',
  handoff: 'repeat',
  model: 'sparkles',
  against: 'alert',
};

/** `side`: the person's id, or the identity's when no person holds it. */
export function SameBox({ side }: { side: string }) {
  const [list, setList] = useState<P.MatchSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () =>
    api<P.MatchesView>(`/api/matches?side=${encodeURIComponent(side)}`)
      .then((v) => setList(v.suggestions.slice(0, 4)))
      .catch(() => setList([]));
  useEffect(() => void load(), [side]);
  if (!list.length) return null;
  const merge = async (s: P.MatchSuggestion) => {
    setBusy(s.key);
    try {
      const r = await api<{ person: string }>('/api/matches/merge', { body: { sides: [s.a.id, s.b.id] } });
      toast({ kind: 'info', title: 'Merged', body: `${s.a.name} and ${s.b.name} are one person now.` }, 4000);
      go({ view: 'profile', person: r.person });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not merge', body: (e as Error).message });
    }
    setBusy(null);
  };
  const no = async (s: P.MatchSuggestion) => {
    setBusy(s.key);
    await api('/api/matches/decide', { body: { key: s.key, decision: 'no' } }).catch(() => {});
    setBusy(null);
    setList(list.filter((x) => x.key !== s.key));
  };
  return (
    <Card title="Maybe the same person" icon="merge" count={list.length} extra={<button class="link-btn" onClick={() => go({ view: 'people', same: true })}>All</button>}>
      {list.map((s) => {
        const other = s.a.id === side ? s.b : s.a;
        return (
          <div class="pf-same-row">
            <button class="sp-side" onClick={() => go(other.id.startsWith('per_') ? { view: 'profile', person: other.id } : { view: 'profile', identity: other.id })}>
              <Avatar id={other.id} name={other.name} url={other.avatar} size={32} />
              <span class="sp-side-text">
                <b>{other.name}</b>
                <span class="sp-ids">
                  {other.identities.slice(0, 3).map((i) => (
                    <span class="sp-id">
                      <NetBadge network={i.network} size={12} />
                      <span>{i.handle ?? i.name ?? ''}</span>
                    </span>
                  ))}
                </span>
              </span>
            </button>
            <span class={`sp-odds ${s.p >= MATCH_STRONG ? 'strong' : s.p >= 0.6 ? 'mid' : 'weak'}`} style={{ '--p': String(s.p) }}>
              {Math.round(s.p * 100)}%
            </span>
            <ul class="sp-evs">
              {s.evidence.slice(0, 3).map((e) => (
                <li class={`sp-ev ${e.weight < 0 ? 'against' : e.weight >= 4 ? 'strong' : ''}`}>
                  <Icon name={ICON[e.kind]} size={13} />
                  <span>{e.text}</span>
                </li>
              ))}
            </ul>
            <div class="sp-actions">
              <button class="btn small" disabled={busy === s.key} onClick={() => void merge(s)}>
                <Icon name="merge" size={14} /> Merge
              </button>
              <button class="btn small ghost" disabled={busy === s.key} onClick={() => void no(s)}>
                Not the same
              </button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

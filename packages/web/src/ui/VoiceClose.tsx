/**
 * Two parts of a person's profile (docs/profile.md "Voice", "In common"):
 *  - Voice: their time in voice channels, from the adversarial voice log (absent with it off or nothing logged): their
 *    minutes this month and lately, who they are in voice with most, and their latest stretches in a channel.
 *  - People in common: the friends you share and the people they are most tied to, as the people graph ties them
 *    (replies, reactions, turns, time in voice together, friendships), each with what counted.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago, fullTime } from '../format.ts';
import { communitiesOf, convTitle, identityName, netName } from '../model.ts';
import { api, db, go, isSelfIdentity, openProfile, rev } from '../state.ts';
import { changed } from '../versions.ts';
import { Avatar, NetGlyph } from './bits.tsx';
import { Card } from './ProfileShell.tsx';

const SHOWN = 5;

/** Minutes as "45 min", "3 h 20 min", "12 h". */
function minutesText(m: number): string {
  if (m < 60) return `${Math.max(0, Math.round(m))} min`;
  const h = Math.floor(m / 60);
  const r = Math.round(m - h * 60);
  return r && h < 10 ? `${h} h ${r} min` : `${h} h`;
}

/** Loads one of the two, keeping the identities it names. */
function useLoad<T>(path: string, pick: (r: any) => T): T | undefined {
  const [v, setV] = useState<T | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setV(undefined);
    api<{ identities: P.IdentityView[] }>(path).then(
      (r) => {
        if (!live) return;
        let any = false;
        for (const i of r.identities) if (!db.identities.has(i.id)) (db.identities.set(i.id, i), (any = true));
        if (any) changed('identity');
        setV(pick(r));
      },
      () => live && setV(pick({})),
    );
    return () => void (live = false);
  }, [path]);
  return v;
}

/** Someone, as a picture and a name you can click, with a line under it. */
function Someone({ id, sub, title }: { id: string; sub: string; title?: string }) {
  const i = db.identities.get(id);
  const p = i?.personId ? db.persons.get(i.personId) : null;
  const n = isSelfIdentity(id) ? 'You' : (p?.name ?? identityName(id));
  return (
    <button class="pf-row" onClick={() => openProfile(id)} title={title ?? n}>
      <Avatar id={p?.id ?? id} name={n} url={p?.avatar ?? i?.avatar} size={28} />
      <span class="pf-row-text">
        <b>{n}</b>
        <small>{sub}</small>
      </span>
    </button>
  );
}

/** `base`: /api/persons/:id or /api/identities/:id. */
export function VoiceCard({ base, self }: { base: string; self: boolean }) {
  rev.value;
  const v = useLoad(`${base}/voice`, (r) => (r.voice ?? null) as P.PersonVoiceView | null);
  const [all, setAll] = useState(false);
  if (!v || !v.sessions.length) return null;
  const { minutes: m } = v;
  const summary = [
    `${minutesText(m.month)} this month`,
    m.days30 !== m.month ? `${minutesText(m.days30)} in the past 30 days` : null,
    v.since ? `seen since ${new Date(v.since).toLocaleDateString()}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card title="Voice" icon="voice" count={v.sessions.length}>
      <p class="pf-hint">{summary}</p>
      {v.with.length > 0 && (
        <>
          <h4 class="pf-voice-h">{self ? 'Most in voice with' : 'Usually in voice with'}</h4>
          <div class="pf-rows">
            {v.with.map((w) => (
              <Someone id={w.identityId} sub={`${minutesText(w.minutes)} together in the past 90 days`} />
            ))}
          </div>
        </>
      )}
      <h4 class="pf-voice-h">Latest</h4>
      <div class="pf-rows">
        {(all ? v.sessions : v.sessions.slice(0, SHOWN)).map((s) => {
          const c = db.conversations.get(s.conversationId);
          const long = ((s.to ?? Date.now()) - s.from) / 60_000;
          return (
            <button class="pf-row" disabled={!c} onClick={() => c && go({ view: 'profile', conv: c.id })} title={`${fullTime(s.from)} to ${s.to ? fullTime(s.to) : 'now'}`}>
              <span class="pf-row-text">
                <b>{c ? convTitle(c) : 'A voice channel'}</b>
                <small>
                  {c && communitiesOf(c)[0] ? `${communitiesOf(c)[0].name} · ` : ''}
                  {s.to ? minutesText(long) : `in it now, for ${minutesText(long)}`}
                </small>
              </span>
              <span class="pf-row-time">{ago(s.from)}</span>
            </button>
          );
        })}
      </div>
      {!all && v.sessions.length > SHOWN && (
        <button class="btn ghost small" onClick={() => setAll(true)}>
          Show all {v.sessions.length}
        </button>
      )}
    </Card>
  );
}

/** Someone they are tied to: from the people graph's ties, from a profile's friends list, or both. */
interface Tie {
  key: string;
  identityId: string;
  strength: number;
  /** Networks where they and you are both friends with this person. */
  friendOn: P.Network[];
  close: P.CloseView | null;
}

/** The people graph's ties of theirs (`base`: /api/persons/:id or /api/identities/:id), strongest first; undefined while loading. */
export function useCloseTo(base: string): P.CloseView[] | undefined {
  rev.value;
  return useLoad(`${base}/close?limit=200`, (r) => (r.close ?? []) as P.CloseView[]);
}

/**
 * People in common (docs/profile.md "People in common"): the people graph's ties and the friends you share, one row a
 * person, the friends first, each part strongest first. Friendship counts either way: their profile naming the friend, or the friend's profile naming them,
 * which the hub's ties carry (`friends`).
 */
export function tiesOf(close: P.CloseView[], said: P.PersonAboutView[]): Tie[] {
  const keyOf = (iid: string) => db.identities.get(iid)?.personId ?? iid;
  const out = new Map<string, Tie>();
  for (const c of close) out.set(c.key, { key: c.key, identityId: c.identityId, strength: c.strength, friendOn: c.friends ? [db.identities.get(c.identityId)?.network ?? 'discord'] : [], close: c });
  for (const a of said)
    for (const iid of a.mutualFriends ?? []) {
      if (isSelfIdentity(iid)) continue;
      const k = keyOf(iid);
      const t = out.get(k) ?? { key: k, identityId: iid, strength: 0, friendOn: [], close: null };
      t.friendOn = [...new Set([...t.friendOn.filter((n) => n !== db.identities.get(iid)?.network), a.network])];
      out.set(k, t);
    }
  const friend = (t: Tie) => (t.friendOn.length ? 1 : 0);
  return [...out.values()].sort((x, y) => friend(y) - friend(x) || y.strength - x.strength || x.key.localeCompare(y.key));
}

/** What tied them, in words; `short` for a row. */
function why(t: Tie, short = false): string {
  const c = t.close;
  const n = (k: number | undefined, one: string, many: string) => (k ? `${k.toLocaleString()} ${k === 1 ? one : many}` : null);
  return (
    [
      t.friendOn.length ? `friends${short ? '' : ` on ${t.friendOn.map(netName).join(' and ')}`}` : null,
      n(c?.replies, 'reply', 'replies'),
      n(c?.reactions, 'reaction', 'reactions'),
      short ? null : n(c?.turns, 'turn in a small chat', 'turns in small chats'),
      c?.voiceMinutes ? `${minutesText(c.voiceMinutes)} in voice` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'seen together'
  );
}

/** The list: how many are friends, then a row a person with what counted and how strong the tie is. Null with nobody. */
export function PeopleInCommon({ ties, shown = 8 }: { ties: Tie[]; shown?: number }) {
  const [all, setAll] = useState(false);
  if (!ties.length) return null;
  const friends = ties.filter((t) => t.friendOn.length).length;
  return (
    <div class="pf-ties">
      <p class="pf-people-sum">
        {friends > 0 && (
          <span>
            <b>{friends}</b> friend{friends === 1 ? '' : 's'} in common
          </span>
        )}
        {ties.length > friends && (
          <span>
            <b>{ties.length - friends}</b> more they talk with
          </span>
        )}
      </p>
      <div class="pf-rows">
        {(all ? ties : ties.slice(0, shown)).map((t) => {
          const i = db.identities.get(t.identityId);
          const p = i?.personId ? db.persons.get(i.personId) : null;
          const name = p?.name ?? identityName(t.identityId);
          return (
            <button class="pf-row pf-tie" onClick={() => openProfile(t.identityId)} title={`${name}: ${why(t)}`}>
              <Avatar id={p?.id ?? t.identityId} name={name} url={p?.avatar ?? i?.avatar} size={26} />
              <span class="pf-row-text">
                <b>{name}</b>
                <small>
                  {t.friendOn.map((n) => (
                    <NetGlyph network={n} size={10} decorative />
                  ))}{' '}
                  {why(t, true)}
                </small>
              </span>
              {t.close && (
                <span class="pf-meter" title={`Tied ${Math.round(t.strength * 100)}% of the most two people can be`}>
                  <i style={{ width: `${Math.max(6, Math.min(100, t.strength * 250))}%` }} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {ties.length > shown && (
        <button class="link-btn pf-more" onClick={() => setAll(!all)}>
          {all ? 'Fewer' : `All ${ties.length}`}
        </button>
      )}
    </div>
  );
}

/**
 * Two cards on a person's profile (docs/profile.md "Voice", "Close to"):
 *  - Voice: their time in voice channels, from the adversarial voice log (absent with it off or nothing logged): their
 *    minutes this month and lately, who they are in voice with most, and their latest stretches in a channel.
 *  - Close to: the people they are most tied to, as the people graph ties them (replies, reactions, turns, time in voice
 *    together, friendships), each with what counted.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago, fullTime } from '../format.ts';
import { communitiesOf, convTitle, identityName } from '../model.ts';
import { api, db, go, isSelfIdentity, openProfile, rev } from '../state.ts';
import { changed } from '../versions.ts';
import { Avatar } from './bits.tsx';
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

/** What a tie counted, in words. */
function why(c: P.CloseView): string {
  const n = (k: number, one: string, many: string) => (k ? `${k.toLocaleString()} ${k === 1 ? one : many}` : null);
  return (
    [
      n(c.replies, 'reply', 'replies'),
      n(c.reactions, 'reaction', 'reactions'),
      n(c.turns, 'turn in a small chat', 'turns in small chats'),
      c.voiceMinutes ? `${minutesText(c.voiceMinutes)} in voice` : null,
      c.friends ? 'friends' : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'a little of everything'
  );
}

export function CloseCard({ base }: { base: string }) {
  rev.value;
  const list = useLoad(`${base}/close`, (r) => (r.close ?? []) as P.CloseView[]);
  if (!list?.length) return null;
  return (
    <Card title="Close to" icon="users" count={list.length}>
      <div class="pf-rows">
        {list.map((c) => (
          <Someone id={c.identityId} sub={why(c)} title={`Tied ${Math.round(c.strength * 100)}% of the most two people can be`} />
        ))}
      </div>
    </Card>
  );
}

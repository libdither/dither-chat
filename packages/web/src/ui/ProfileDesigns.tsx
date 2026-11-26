/**
 * Draft layouts of a person's profile, to choose between (a picker at the bottom of the page; the choice is kept in this
 * browser). Each lays out the same blocks, and three blocks are merged here:
 *  - People in common: the friends you share and the people they are tied to (Close to) in one list, friendship known
 *    either way (their profile's mutual friends, or a friend's profile naming them), with what counted.
 *  - Between you: their recent messages and your mail with them, newest first, in one list.
 *  - Accounts with how each of yours stands with each of theirs (Profile.tsx).
 */
import type * as P from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { identityName, netName } from '../model.ts';
import { api, db, isSelfIdentity, openProfile, rev } from '../state.ts';
import { changed } from '../versions.ts';
import { Avatar, NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';

const KEY = 'dither.profileDesign';
export const DESIGNS: [string, string][] = [
  ['', 'Now'],
  ['a', 'A · Tidy'],
  ['b', 'B · Tabs'],
  ['c', 'C · Digest'],
  ['d', 'D · Three columns'],
];
const read = () => {
  try {
    const v = localStorage.getItem(KEY) ?? '';
    return DESIGNS.some(([k]) => k === v) ? v : '';
  } catch {
    return '';
  }
};
export const profileDesign = signal(read());
const pick = (v: string) => {
  profileDesign.value = v;
  try {
    localStorage.setItem(KEY, v);
  } catch {}
};

/** The picker: which draft the page is drawn in. */
export function DesignBar() {
  const on = profileDesign.value;
  return (
    <div class="pfd-bar" role="radiogroup" aria-label="Profile design">
      <span class="pfd-bar-label">Design</span>
      {DESIGNS.map(([k, label]) => (
        <button class={`chip-btn ${on === k ? 'on' : ''}`} role="radio" aria-checked={on === k} onClick={() => pick(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Minutes as "45 min", "3 h 20 min", "12 h". */
function minutesText(m: number): string {
  if (m < 60) return `${Math.max(0, Math.round(m))} min`;
  const h = Math.floor(m / 60);
  const r = Math.round(m - h * 60);
  return r && h < 10 ? `${h} h ${r} min` : `${h} h`;
}

interface Tie {
  key: string;
  identityId: string;
  strength: number;
  /** Networks a profile says you are both friends with them on. */
  friendOn: P.Network[];
  close: P.CloseView | null;
}

/** Everyone they are tied to, from the hub's ties and the profiles' friends lists, strongest first. */
function usePeople(base: string, said: P.PersonAboutView[]): Tie[] | null {
  rev.value;
  const [close, setClose] = useState<P.CloseView[] | null>(null);
  useEffect(() => {
    let live = true;
    setClose(null);
    api<{ close: P.CloseView[]; identities: P.IdentityView[] }>(`${base}/close?limit=200`).then(
      (r) => {
        if (!live) return;
        let any = false;
        for (const i of r.identities) if (!db.identities.has(i.id)) (db.identities.set(i.id, i), (any = true));
        if (any) changed('identity');
        setClose(r.close);
      },
      () => live && setClose([]),
    );
    return () => void (live = false);
  }, [base]);
  if (!close) return null;
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
  return [...out.values()].sort((x, y) => y.strength - x.strength || x.key.localeCompare(y.key));
}

/** What tied them, in words. */
function reasons(t: Tie, short = false): string {
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

function who(iid: string) {
  const i = db.identities.get(iid);
  const p = i?.personId ? db.persons.get(i.personId) : null;
  return { i, p, name: p?.name ?? identityName(iid) };
}

/**
 * People in common. `faces`: pictures in a grid, the reasons on hover; else rows with the reasons under each name.
 * Returns null with nobody.
 */
export function PeopleList({ base, said, faces, shown = 8 }: { base: string; said: P.PersonAboutView[]; faces?: boolean; shown?: number }) {
  const list = usePeople(base, said);
  const [all, setAll] = useState(false);
  if (!list?.length) return null;
  const friends = list.filter((t) => t.friendOn.length).length;
  const top = all ? list : list.slice(0, shown);
  return (
    <div class="pfd-people">
      <p class="pfd-sum">
        {friends > 0 && (
          <span>
            <b>{friends}</b> friend{friends === 1 ? '' : 's'} in common
          </span>
        )}
        {list.length > friends && (
          <span>
            <b>{list.length - friends}</b> more they talk with
          </span>
        )}
      </p>
      <div class={faces ? 'pfd-faces' : 'pf-rows'}>
        {top.map((t) => {
          const { i, p, name } = who(t.identityId);
          return faces ? (
            <button class="pfd-face" onClick={() => openProfile(t.identityId)} title={`${name}: ${reasons(t)}`}>
              <Avatar id={p?.id ?? t.identityId} name={name} url={p?.avatar ?? i?.avatar} size={36} />
              {t.friendOn.length > 0 && <span class="pfd-face-friend" aria-label="Friends">
                <Icon name="users" size={9} />
              </span>}
              <span class="pfd-face-name">{name}</span>
            </button>
          ) : (
            <button class="pf-row pfd-person" onClick={() => openProfile(t.identityId)} title={reasons(t)}>
              <Avatar id={p?.id ?? t.identityId} name={name} url={p?.avatar ?? i?.avatar} size={26} />
              <span class="pf-row-text">
                <b>{name}</b>
                <small>
                  {t.friendOn.map((n) => (
                    <NetGlyph network={n} size={10} decorative />
                  ))}{' '}
                  {reasons(t, true)}
                </small>
              </span>
              <span class="pfd-meter" title={`Tied ${Math.round(t.strength * 100)}% of the most two people can be`}>
                <i style={{ width: `${Math.max(6, Math.min(100, t.strength * 250))}%` }} />
              </span>
            </button>
          );
        })}
      </div>
      {list.length > shown && (
        <button class="link-btn pfd-more" onClick={() => setAll(!all)}>
          {all ? 'Fewer' : `All ${list.length}`}
        </button>
      )}
    </div>
  );
}

/** A row of the Between you list: a message or a mail thread, drawn by Profile.tsx. */
export interface BetweenRow {
  key: string;
  ts: number;
  kind: 'chat' | 'mail';
  el: ComponentChildren;
}

/** Their messages and your mail with them, newest first, with a filter when there are both. */
export function Between({ rows, shown = 6, foot }: { rows: BetweenRow[]; shown?: number; foot?: ComponentChildren }) {
  const [only, setOnly] = useState<'chat' | 'mail' | null>(null);
  const [all, setAll] = useState(false);
  const kinds = new Set(rows.map((r) => r.kind));
  const list = rows.filter((r) => !only || r.kind === only).sort((a, b) => b.ts - a.ts);
  if (!rows.length) return null;
  return (
    <div class="pfd-between">
      {kinds.size > 1 && (
        <div class="pf-friend-nets" role="radiogroup" aria-label="Show">
          {(
            [
              [null, 'All', rows.length],
              ['chat', 'Messages', rows.filter((r) => r.kind === 'chat').length],
              ['mail', 'Mail', rows.filter((r) => r.kind === 'mail').length],
            ] as const
          ).map(([k, label, n]) => (
            <button class={`chip-btn ${only === k ? 'on' : ''}`} role="radio" aria-checked={only === k} onClick={() => setOnly(k)}>
              <b>{label}</b> {n}
            </button>
          ))}
        </div>
      )}
      <div class="pf-rows">{(all ? list : list.slice(0, shown)).map((r) => r.el)}</div>
      <div class="pfd-foot">
        {list.length > shown && (
          <button class="link-btn" onClick={() => setAll(!all)}>
            {all ? 'Fewer' : `All ${list.length}`}
          </button>
        )}
        {foot}
      </div>
    </div>
  );
}

/** Tabs over a page's parts; the first with something in it is open. */
export function Tabs({ tabs }: { tabs: { key: string; label: string; count?: number; body: ComponentChildren }[] }) {
  const [on, setOn] = useState<string | null>(null);
  const cur = tabs.find((t) => t.key === on) ?? tabs[0];
  return (
    <div class="pfd-tabs">
      <div class="pfd-tab-row" role="tablist">
        {tabs.map((t) => (
          <button class={`pfd-tab ${t === cur ? 'on' : ''}`} role="tab" aria-selected={t === cur} onClick={() => setOn(t.key)}>
            {t.label}
            {t.count ? <span class="pf-count">{t.count}</span> : null}
          </button>
        ))}
      </div>
      <div class="pfd-tab-body" role="tabpanel">
        {cur?.body}
      </div>
    </div>
  );
}

/** A part of the digest: a line saying what is in it, opened for more. */
export function Section({ title, line, open, children }: { title: string; line?: ComponentChildren; open?: boolean; children: ComponentChildren }) {
  return (
    <details class="pfd-section" open={open}>
      <summary>
        <b>{title}</b>
        {line && <span class="pfd-line">{line}</span>}
        <Icon name="chevronDown" size={13} />
      </summary>
      <div class="pfd-section-body">{children}</div>
    </details>
  );
}

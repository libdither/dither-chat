/**
 * A person's profile (docs/profile.md): who they are on each network, as the networks say it (bio, pronouns, status,
 * links), what you share (servers with their nickname and roles there, group chats, friends), what they said lately,
 * and how you stand with them (accounts, notifications, your note). The actions from their menu sit in the hero.
 */
import type * as P from '@dither-chat/protocol';
import { RELATIONSHIP_LABEL, withList } from '@dither-chat/protocol';
import { connections, connectionTags, withChanges } from '../connections.ts';
import { useEffect, useRef, useState } from 'preact/hooks';
import { memoOn } from './memo.ts';
import type { ComponentChildren } from 'preact';
import { ago, fullTime, localTime } from '../format.ts';
import { bioEditor, bioLeft } from '../bio.ts';
import { openers } from '../direct.ts';
import { composeTo } from '../mail/people.ts';
import { senderLine } from '../mail/model.ts';
import { countText, countTitle } from '../msgcount.ts';
import { communitiesOf, convLabel, convTitle, directsOf, externalProfile, identityName, kindLabel, netName, bioText, plainBody, rootCommunity } from '../model.ts';
import { api, db, go, isSelfIdentity, metaRev, openMessage, openProfile, rev, setRule, toast } from '../state.ts';
import { messageSomeone } from './Palette.tsx';
import { Avatar, Empty, Linked, NetBadge, NetGlyph } from './bits.tsx';
import { isQuietConv } from '../feed.ts';
import { copy, groups, useMenu, type MenuEntry, type MenuSpec } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import { nicknamable, nicknameEntries, NicknameInput, ownName, saveNickname } from './Nickname.tsx';
import { ActivityCard } from './ActivityCard.tsx';
import { SameBox } from './SameBox.tsx';
import { HistoryCard } from './HistoryCard.tsx';
import { PeopleInCommon, tiesOf, useCloseTo, VoiceCard } from './VoiceClose.tsx';
import { copyEntries, identityMenu, personMenu } from './menus.tsx';
import { alsoNames, nameEntries, nameRows, pictureChoices } from '../namechoices.ts';
import { HeroName } from './HeroName.tsx';
import { viewer } from '../viewer.ts';
import { Action, Card, Columns, Facts, Hero, monthYear, ProfilePage, StatusEmoji, Tag, viewPicture } from './ProfileShell.tsx';
import { ConnectActions, ProfileConnections } from './Requests.tsx';
import { openConv } from '../opening.ts';
import { Loading } from './Loader.tsx';
import { peopleExtras } from './peopleExtras.ts';
import { Stories } from './StoriesLazy.tsx';
import { usePictureEditor } from './PictureEditorLazy.tsx';
import type { PictureStart, PictureTarget } from './PictureEditor.tsx';

import { signal } from '@preact/signals';

/** Your note on their network, Block and Ignore, badges, your own fields (ProfileSelf.tsx): a chunk of its own, loaded with the first profile. */
type Self = typeof import('./ProfileSelf.tsx');
const selfParts = signal<Self | null>(null);
let selfLoading: Promise<unknown> | null = null;
const loadSelf = () => (selfLoading ??= import('./ProfileSelf.tsx').then((m) => (selfParts.value = m), () => (selfLoading = null)));
import { RecentPostsLazy } from './feed/lazy.tsx';
import { clip, feedVerb, postKey } from '../feed.ts';

/** A feed item in their Recent messages (docs/feed.md): "Liked your post: “…”" ("Favourited" on Mastodon), or what they wrote. */
function feedLine(f: P.FeedItem, body: string, network: P.Network): string {
  const said = feedVerb(f.type, network);
  if (f.type === 'reply' || f.type === 'mention' || f.type === 'quote') return `${said[0]!.toUpperCase()}${said.slice(1)}: ${clip(f.theirs?.text ?? body, 140)}`;
  if (f.type === 'other') return f.text ?? body;
  const verb = `${said[0]!.toUpperCase()}${said.slice(1)}`;
  return f.post?.text ? `${verb}: “${clip(f.post.text)}”` : verb;
}

/** What a network's profile holds at most, for when it says little. */
const WHAT_NETWORKS_SHARE: Record<P.Network, string> = {
  discord: 'Bio, pronouns, status, banner, connections, mutual servers and friends, as Discord shows them on a profile.',
  signal: 'Profile name, About and avatar. Signal has no directory, and no mutual friends.',
  matrix: 'Display name and avatar, and pronouns or time zone where their server keeps them.',
  whatsapp: 'The name in your address book, their About and picture, and whether it is a business.',
  telegram: 'Name, username, bio and photo, and their phone number or last seen only where they allow it.',
  gmessages: 'The name and number in your contacts. Messages has no profiles.',
  messenger: 'Name and profile picture, as Facebook shows them to you.',
  instagram: 'Username, name, bio and picture, and whether the account is private.',
  x: 'Name, handle, bio and picture, as their X profile shows them.',
  email: 'An address, and the name their mail is sent under. Mail has no profiles.',
  calendar: 'The calendar talks for itself: it has no profile.',
  t3: 'A coding agent in T3 Code: it has no profile.',
  mastodon: 'Name, handle, bio, picture and profile fields, as their Mastodon profile shows them.',
  reddit: 'Username, bio, picture and karma, as their Reddit profile shows them.',
  lemmy: 'Name, handle, bio and picture, as their Lemmy profile shows them.',
  substack: 'Name, handle, bio and picture, and the publications they write.',
  bluesky: 'Name, handle, bio and picture, as their Bluesky profile shows them.',
  lesswrong: 'Name, bio and karma, as their LessWrong profile shows them.',
  zulip: 'Name, picture and role in the organization, their status, time zone and the profile fields the organization asks for.',
  luma: 'Name, username, picture, a short bio and the links they chose (X, Instagram, LinkedIn, TikTok, YouTube, a website), as their Luma profile shows them, and the events you saw them at.',
  partiful: 'Name, picture, bio and the links they chose, as Partiful shows them on an event, and the events you saw them at.',
};

/** What a network says when someone wrote nothing. */
const STOCK_BIO = /^(available|busy|at work|hey there! i am using whatsapp\.?|urgent calls only)$/i;

/** Someone on two networks is one row. */
function onePerPerson(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((iid) => {
    const k = db.identities.get(iid)?.personId ?? iid;
    return !seen.has(k) && seen.add(k);
  });
}

/** The same line from two accounts on one network once. */
const dedupe = (rows: [string, string][]) => rows.filter((r, i) => rows.findIndex((x) => x[0] === r[0] && x[1] === r[1]) === i);

/** The people a fact names, each a link to their profile. */
function FactPeople({ ids }: { ids: string[] }) {
  return (
    <>
      {ids.map((id, i) => {
        const p = db.identities.get(id)?.personId ? db.persons.get(db.identities.get(id)!.personId!) : null;
        return (
          <>
            {i > 0 && ', '}
            <button class="pf-fact-who" onClick={() => openProfile(id)}>
              {p?.name ?? identityName(id)}
            </button>
          </>
        );
      })}
    </>
  );
}

const normalized = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** What a conversation's picture shows: its own, else its server's. */
function placePicture(c: P.ConversationView) {
  const com = c.spaceIds.length ? rootCommunity(c.spaceIds[0]) : null;
  if (com) return { id: com.id, name: com.name, url: com.icon, square: true, network: c.network };
  const person = c.peerPersonId ? db.persons.get(c.peerPersonId) : null;
  return { id: person?.id ?? c.id, name: convTitle(c), url: person?.avatar ?? c.avatar, square: c.shape !== 'direct', network: c.network };
}

/**
 * A conversation's picture. Drawn again only when what it shows changes (memoOn): a profile draws its lists again for
 * a name you give someone, and the places' pictures mostly stay (docs/perf.md "Every click").
 */
const PlaceIcon = memoOn(
  'PlaceIcon',
  function PlaceIcon({ c, size = 22 }: { c: P.ConversationView; size?: number }) {
    return <Avatar {...placePicture(c)} size={size} />;
  },
  ({ c, size }) => {
    const p = placePicture(c);
    return `${size ?? ''}\n${p.id}\n${p.name}\n${p.url ?? ''}\n${p.square}\n${p.network}`;
  },
);

/** One account's handle or id, a button that copies it. */
function HandleChip({ i }: { i: P.IdentityView }) {
  return (
    <button class="pf-handle" title={i.network === 'email' ? 'Copy address' : `Copy ${netName(i.network)} ${i.handle ? 'username' : 'id'}`} onClick={() => copy(i.handle ?? i.nativeId, 'Copied')}>
      <NetGlyph network={i.network} size={12} />
      {i.handle ?? i.displayName ?? i.nativeId}
    </button>
  );
}

/**
 * One of several accounts of a person, on their profile (docs/profile.md "Their accounts"): its own picture with its
 * network's badge, its own name, its handle (copies), and when it joined its network; Main or Picture when it speaks
 * for them. A button goes to it (its chat, or starts one, or a mail); Edit opens what its menu (right-click or hold)
 * has as buttons under it: make it the main account, use its picture, your nickname for it, copy, open on the
 * network, split. Its bio is in About, with the others'.
 */
function AccountRow({ i, since, main, chosen, picture, go: open, goLabel, menu: menuOf }: { i: P.IdentityView; since?: string; main: boolean; chosen: boolean; picture: boolean; go?: () => void; goLabel?: string; menu: (editNickname: () => void) => MenuSpec }) {
  metaRev.value; // its name, which a nickname changes
  const [naming, setNaming] = useState(false);
  const [editing, setEditing] = useState(false);
  const menu = () => menuOf(() => setNaming(true));
  const ctx = useMenu(menu);
  const name = identityName(i.id);
  const net = netName(i.network);
  // The menu's entries as buttons; the way to it is the button beside the name already.
  const entries = editing ? menu().items.filter((e): e is Extract<MenuEntry, { run?: () => void }> => 'run' in e && !!e.run && e.label !== goLabel) : [];
  return (
    <div class={`pf-acct ${editing ? 'editing' : ''}`} data-identity={i.id} data-main={main || undefined} data-chosen={chosen || undefined} {...ctx}>
      <Avatar id={i.id} name={name} url={i.avatar} size={36} network={i.network} />
      <div class="pf-acct-text">
        <div class="pf-acct-top">
          {naming ? (
            <NicknameInput i={i} onDone={() => setNaming(false)} class="pair-nick-input pf-acct-nick-input" />
          ) : (
            <b class="pf-acct-name" title={i.nickname ? `${name}: your nickname (only you see it)` : name}>
              {name}
            </b>
          )}
          {main && (
            <span class="pf-acct-mark" title={chosen ? 'You made it their main account: its name, picture and bio speak for them' : 'Its name, picture and bio speak for them for now, as the account you talked with last; Make Main Account keeps one'}>
              Main
            </span>
          )}
          {picture && (
            <span class="pf-acct-mark" title="Their picture is this account's">
              Picture
            </span>
          )}
          {open && (
            <button class="icon-btn small" title={goLabel} aria-label={goLabel} onClick={open}>
              <Icon name={i.network === 'email' ? 'mail' : 'send'} size={14} />
            </button>
          )}
          <button class="btn ghost small pf-acct-edit-btn" aria-expanded={editing} aria-label={`${editing ? 'Done with' : 'Edit'} ${name} on ${net}`} data-track="account edit" onClick={() => setEditing(!editing)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        </div>
        {i.nickname && <small class="pf-acct-own">their name: {ownName(i)}</small>}
        <span class="pf-acct-handle">
          <HandleChip i={i} />
          <small>
            {net}
            {since ? ` · since ${since}` : ''}
          </small>
        </span>
        {editing && (
          <div class="pf-acct-edit" role="group" aria-label={`${name} on ${net}`}>
            {entries.map((e) => (
              <button class={`btn small ${e.checked ? 'on' : ''}`} data-track={e.track} aria-pressed={e.checked} onClick={() => e.run!()}>
                {e.icon && <Icon name={e.icon} size={13} />}
                {e.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** What a network calls the people on your list there: Discord's friends, a phone network's contacts, a follow network's mutual follows. */
const FRIEND_WORD: Partial<Record<P.Network, string>> = {
  signal: 'contacts',
  whatsapp: 'contacts',
  telegram: 'contacts',
  gmessages: 'contacts',
  x: 'mutuals',
  bluesky: 'mutuals',
  mastodon: 'mutuals',
  lemmy: 'mutuals',
  substack: 'mutuals',
};
const friendWord = (n: P.Network) => FRIEND_WORD[n] ?? 'friends';
const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Your friends on your own profile, or the friends you share on someone's (docs/profile.md "Friends"), saying which
 * network each is from: a chip per network with its count, in its own word (friends, contacts, mutuals), which shows
 * only that network's; and each row's networks at its end. Someone on two networks is one row, with both.
 */
function FriendsCard({ said, of, mutual }: { said: P.PersonAboutView[]; of: (a: P.PersonAboutView) => string[] | undefined; mutual?: boolean }) {
  metaRev.value; // who is you, and who is the same person
  const [only, setOnly] = useState<P.Network | null>(null);
  const byNet = new Map<P.Network, string[]>();
  for (const a of said) {
    const list = (of(a) ?? []).filter((iid) => !isSelfIdentity(iid));
    if (list.length) byNet.set(a.network, [...new Set([...(byNet.get(a.network) ?? []), ...list])]);
  }
  if (!byNet.size) return null;
  const key = (iid: string) => db.identities.get(iid)?.personId ?? iid;
  const netsOf = new Map<string, P.Network[]>();
  for (const [n, list] of byNet) for (const iid of list) netsOf.set(key(iid), [...new Set([...(netsOf.get(key(iid)) ?? []), n])]);
  const all = onePerPerson([...byNet.values()].flat());
  const on = only && byNet.has(only) ? only : null;
  const list = on ? onePerPerson(byNet.get(on)!) : all;
  const several = byNet.size > 1;
  const twice = [...netsOf.values()].filter((x) => x.length > 1).length;
  const words = [...new Set([...byNet.keys()].map(friendWord))];
  const title = mutual ? `${words.includes('friends') ? 'Mutual' : 'Shared'} ${andList(words)}` : andList(words);
  return (
    <Card title={title[0].toUpperCase() + title.slice(1)} icon="users" count={all.length} class="pf-friends">
      <div class="pf-friend-nets" role={several ? 'radiogroup' : undefined} aria-label={several ? 'Show' : undefined}>
        {several && (
          <button class={`chip-btn ${on ? '' : 'on'}`} role="radio" aria-checked={!on} data-track="friends (all)" onClick={() => setOnly(null)}>
            <b>All</b> {all.length.toLocaleString()}
          </button>
        )}
        {[...byNet].map(([n, l]) => {
          const label = `${l.length.toLocaleString()} ${l.length === 1 ? friendWord(n).replace(/s$/, '') : friendWord(n)} on ${netName(n)}`;
          return several ? (
            <button class={`chip-btn ${on === n ? 'on' : ''}`} role="radio" aria-checked={on === n} data-network={n} data-track="friends (network)" title={label} onClick={() => setOnly(on === n ? null : n)}>
              <NetGlyph network={n} size={12} decorative />
              <b>{l.length.toLocaleString()}</b> {friendWord(n)}
            </button>
          ) : (
            <span class="pf-friend-net" data-network={n}>
              <NetGlyph network={n} size={12} decorative /> {label}
            </span>
          );
        })}
      </div>
      <div class="pf-people">
        {list.slice(0, 60).map((iid) => {
          const i = db.identities.get(iid);
          const p = i?.personId ? db.persons.get(i.personId) : null;
          const n = p?.name ?? identityName(iid);
          const where = netsOf.get(key(iid)) ?? [];
          return (
            <button class="pf-person" onClick={() => openProfile(iid)} title={`${n}: ${where.map(netName).join(', ')}`}>
              <Avatar id={p?.id ?? iid} name={n} url={p?.avatar ?? i?.avatar} size={30} />
              <span class="pf-person-name">{n}</span>
              {several && (
                <span class="pf-person-nets">
                  {where.map((w) => (
                    <NetGlyph network={w} size={11} />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {(list.length > 60 || (several && !on && twice > 0)) && (
        <p class="pf-empty">
          {list.length > 60 && `and ${(list.length - 60).toLocaleString()} more`}
          {list.length > 60 && several && !on && twice > 0 && ' · '}
          {several && !on && twice > 0 && `${twice.toLocaleString()} on more than one network`}
        </p>
      )}
    </Card>
  );
}

/** The profile and what each network says, the kept answers first and fresh ones as they come. */
function useProfile(personId?: string, identityId?: string) {
  const person = personId ? db.persons.get(personId) : undefined;
  const signature = person ? `${person.identityIds.join()}|${person.name}` : identityId;
  const [profile, setProfile] = useState<P.ProfileView | null | 'none'>(null);
  const [abouts, setAbouts] = useState<Record<string, P.PersonAboutView>>({});
  const [asking, setAsking] = useState(0);
  const [counts, setCounts] = useState<Record<string, P.MessageCountEstimate>>({});
  const learn = (a: P.PersonAboutView) => {
    a.identities.forEach((i) => db.identities.set(i.id, i));
    setAbouts((x) => ({ ...x, [a.identityId]: a }));
  };
  const ask = (all: string[], fresh = false) => {
    // Mail has no profiles to ask for.
    const ids = all.filter((id) => db.identities.get(id)?.network !== 'email');
    setAsking((n) => n + ids.length);
    for (const id of ids)
      api<P.PersonAboutView>(`/api/identities/${id}/about${fresh ? '?fresh=1' : ''}`)
        .then(learn, () => {})
        .finally(() => setAsking((n) => n - 1));
  };
  useEffect(() => {
    let live = true;
    setAbouts({});
    api<P.ProfileView>(personId ? `/api/persons/${personId}/profile` : `/api/identities/${identityId}/profile`)
      .then((p) => {
        if (!live) return;
        [...p.identities, ...p.mentioned].forEach((i) => db.identities.set(i.id, i));
        p.abouts.forEach(learn);
        setProfile(p);
        ask(p.identityIds);
      })
      .catch(() => live && setProfile('none'));
    // Their message count per server, estimated from what the hub holds: after the profile, it can wait.
    setCounts({});
    api<P.ActivityView>(personId ? `/api/persons/${personId}/activity` : `/api/identities/${identityId}/activity`)
      .then((v) => live && setCounts(Object.fromEntries(v.spaces.map((e) => [e.spaceId, e]))))
      .catch(() => {});
    return () => void (live = false);
  }, [personId, identityId, signature]);
  // A change made from this page (ProfileSelf.tsx: a note, an ignore, a block), until the profile is fetched again.
  const update = (patch: Partial<P.ProfileView>) => setProfile((p) => (p && p !== 'none' ? { ...p, ...patch } : p));
  return { profile, abouts, counts, learn, update, asking: asking > 0, refresh: () => profile && profile !== 'none' && ask(profile.identityIds, true) };
}

/** Your own bio on one network, and a way to change it, within the network's limit. */
function OwnBio({ identity, about, account, label, onSaved }: { identity: P.IdentityView; about?: P.PersonAboutView; account: P.AccountView; label: boolean; onSaved: (a: P.PersonAboutView) => void }) {
  metaRev.value; // the names its mentions show
  const st = (identity.network === 'signal' || identity.network === 'whatsapp') && identity.status;
  const bio = (st && (!about || st.at > about.fetchedAt) ? st.text : about?.bio) ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const net = netName(identity.network);
  const room = draft !== null ? bioLeft(identity.network, draft) : null;
  const left = room?.left ?? null;
  const save = async () => {
    if (draft === null || busy) return;
    if (draft === bio) return setDraft(null);
    if (left !== null && left < 0) return setError(`Too long for ${net}: ${-left} over.`);
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<P.PersonAboutView>(`/api/identities/${identity.id}/about`, { method: 'PUT', body: { bio: draft } }));
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tag = label && (
    <span class="pf-bio-net">
      <NetGlyph network={identity.network} size={11} /> {net}
      {account.label && account.label !== net ? ` · ${account.label}` : ''}
    </span>
  );
  if (draft === null)
    return (
      <div class="pf-bio pf-own-bio">
        {tag}
        <div class="about-text multi">
          <p>{bio ? <Linked text={bioText(bio, identity.network)} network={identity.network} /> : <em>No bio on {net} yet</em>}</p>
          <button class="icon-btn small about-pencil" title={`Change your bio on ${net}`} aria-label={`Change your bio on ${net}`} onClick={() => (setDraft(bio), setError(null))}>
            <Icon name="pencil" size={13} />
          </button>
        </div>
      </div>
    );
  return (
    <div class="pf-bio pf-own-bio">
      {tag}
      <div class="about-edit multi">
        <textarea
          class="about-input"
          rows={3}
          value={draft}
          aria-label={`Your bio on ${net}`}
          aria-invalid={left !== null && left < 0}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), setDraft(null), setError(null));
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) (e.preventDefault(), void save());
          }}
          ref={(el) => void (el && document.activeElement !== el && !busy && el.focus())}
        />
        {error && <p class="pf-bio-error" role="alert">{error}</p>}
        <div class="about-edit-btns">
          {room && (
            <span class={`pf-bio-count ${room.left < 0 ? 'over' : room.left <= 10 ? 'near' : ''}`} title={`${net} takes up to ${room.limit} characters`}>
              {room.left < 0 ? `${-room.left} over ${room.limit}` : `${room.left} of ${room.limit} left`}
            </span>
          )}
          <button class="btn ghost small" onClick={() => (setDraft(null), setError(null))}>
            Cancel
          </button>
          <button class="btn primary small" disabled={busy || (left !== null && left < 0)} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A row of Between you: a message of theirs or a mail thread with them. */
interface BetweenRow {
  key: string;
  ts: number;
  kind: 'chat' | 'mail';
  el: ComponentChildren;
}

/**
 * Between you (docs/profile.md): their recent messages and your mail with them, newest first, in one list, with
 * Messages and Mail chips when there are both, the first few shown.
 */
function Between({ rows, shown = 6, foot }: { rows: BetweenRow[]; shown?: number; foot?: ComponentChildren }) {
  const [only, setOnly] = useState<'chat' | 'mail' | null>(null);
  const [all, setAll] = useState(false);
  const kinds = new Set(rows.map((r) => r.kind));
  const list = rows.filter((r) => !only || r.kind === only).sort((a, b) => b.ts - a.ts);
  return (
    <div class="pf-between">
      {kinds.size > 1 && (
        <div class="pf-friend-nets" role="radiogroup" aria-label="Show">
          {(
            [
              [null, 'All', rows.length],
              ['chat', 'Messages', rows.filter((r) => r.kind === 'chat').length],
              ['mail', 'Mail', rows.filter((r) => r.kind === 'mail').length],
            ] as const
          ).map(([k, label, n]) => (
            <button class={`chip-btn ${only === k ? 'on' : ''}`} role="radio" aria-checked={only === k} data-track={`between (${label.toLowerCase()})`} onClick={() => setOnly(k)}>
              <b>{label}</b> {n}
            </button>
          ))}
        </div>
      )}
      <div class="pf-rows">{(all ? list : list.slice(0, shown)).map((r) => r.el)}</div>
      <div class="pf-between-foot">
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

/** What an event's role and RSVP say of them, in words. */
const EVENT_ROLE: Record<string, string> = { going: 'going', maybe: 'maybe', interested: 'interested', waitlist: 'on the waitlist', pending: 'asked to come', declined: "can't go", invited: 'invited' };

/**
 * The events they were seen at (docs/events.md "People"): hosting first, then upcoming, then past. Each opens the event
 * on the Feed page.
 */
function EventsCard({ events }: { events: P.PersonEventView[] }) {
  const now = Date.now();
  return (
    <Card title="Events" icon="calendar" count={events.length} class="pf-events">
      <div class="pf-rows">
        {events.map((e) => {
          const role = e.role === 'host' ? 'Hosting' : e.rsvp ? `Guest, ${EVENT_ROLE[e.rsvp] ?? e.rsvp}` : 'On the guest list';
          // A short day on the row ("Nov 26", the year when it is another), the full time on hover.
          const day = e.start ? new Date(e.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(new Date(e.start).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) }) : '';
          const when = e.start ? day : `seen ${ago(e.seenAt)}`;
          return (
            <button class="pf-row pf-event-row" onClick={() => go({ view: 'feed', source: 'events', post: postKey(e.network, e.event) })} title={e.url ?? ''}>
              <NetBadge network={e.network} size={28} />
              <span class="pf-row-text">
                <b>{e.title || 'An event'}</b>
                <small>
                  {role}
                  {e.place ? ` · ${e.place}` : ''}
                </small>
              </span>
              <span class="pf-row-time" title={e.start ? `${e.start >= now ? '' : 'Was '}${fullTime(e.start)}` : undefined}>
                {when}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

export function ProfilePane({ personId, identityId, onBack }: { personId?: string; identityId?: string; onBack: () => void }) {
  rev.value;
  const { profile, abouts, counts, learn, update, asking, refresh } = useProfile(personId, identityId);
  const S = selfParts.value;
  useEffect(() => void loadSelf(), []);
  const [merging, setMerging] = useState(false);
  // The hero's nickname editor, in place of the name: the account it names (Nickname.tsx), from the name's menu or More.
  const [naming, setNaming] = useState<string | null>(null);
  // How this page changed where an account stands with them (`account|identity` → the newest word), until the profile
  // is fetched again: ended (stranger), or made (Add friend, Accept). connections.ts withChanges.
  const [changed, setChanged] = useState<Record<string, P.PersonRelationship>>({});
  useEffect(() => setChanged({}), [personId, identityId]);
  const change = (accountId: string | null, identityId: string, rel: P.PersonRelationship) => accountId && setChanged((x) => ({ ...x, [`${accountId}|${identityId}`]: rel }));
  const [filter, setFilter] = useState('');
  const person = personId ? db.persons.get(personId) : undefined;
  // Same person? suggestions with them in: by their person, or the identity when no person holds it.
  const sameSide = personId ?? (identityId ? (db.identities.get(identityId)?.personId ?? identityId) : null);
  // The hub's merge search: people by any name or handle (an email address too), and email identities no person holds.
  const [found, setFound] = useState<{ q: string; persons: P.PersonView[]; identities: P.IdentityView[] } | null>(null);
  const q = filter.trim();
  useEffect(() => {
    if (!merging || !q) return;
    const t = setTimeout(
      () =>
        api<{ persons: P.PersonView[]; identities: P.IdentityView[] }>(`/api/persons/candidates?q=${encodeURIComponent(q)}${person ? `&except=${person.id}` : ''}`)
          .then((r) => setFound({ q, ...r }))
          .catch(() => {}),
      150,
    );
    return () => clearTimeout(t);
  }, [merging, q, person?.id]);

  // Your own picture (PictureEditor.tsx): only your own profile's Abouts list what you may change.
  // The people graph's ties of theirs, for People in common and the glance.
  const closeTo = useCloseTo(personId ? `/api/persons/${personId}` : `/api/identities/${identityId}`);
  const pe = usePictureEditor(Object.values(abouts).some((a) => a.editable?.includes('avatar')));
  // The editor, open on a picture, ticked to the network it came from (an account tile's menu), else the page's.
  const [picturing, setPicturing] = useState<(PictureStart & { came?: string }) | null>(null);
  // The editor's target, kept while it is open: the Abouts are asked again (and empty for a moment) as the picture
  // changes, and the editor must not close and open again meanwhile.
  const editing = useRef<PictureTarget | null>(null);

  if (profile === 'none')
    return (
      <ProfilePage title="Profile" label="Profile" onBack={onBack}>
        <Empty icon="user" title="Nobody by that id" />
      </ProfilePage>
    );
  if (!profile)
    return (
      <ProfilePage title="Profile" label="Profile" onBack={onBack}>
        <Loading label="Loading profile…" />
      </ProfilePage>
    );

  const ids = (person ? person.identityIds : profile.identityIds).map((id) => db.identities.get(id)).filter((i): i is P.IdentityView => !!i);
  const first = ids[0];
  const name = person?.name ?? identityName(first?.id);
  const isSelf = !!person?.isSelf || ids.some((i) => isSelfIdentity(i.id));
  const directs = person ? directsOf(person.id) : [];
  const nets = [...new Set(ids.map((i) => i.network))];
  // Networks with chats: mail is not one.
  const chatNets = nets.filter((n) => n !== 'email');
  const accounts = [...db.accounts.values()];
  // One way in per network they are on and you have no DM on. A network whose adapter cannot do it shows nothing.
  const startable = isSelf ? [] : nets.filter((n) => !directs.some((d) => d.network === n)).map((n) => ids.find((i) => i.network === n)!).filter((i) => openers(accounts, i.network).length > 0);
  const rule = person ? db.rules.find((x) => x.scope === 'person' && x.target === person.id) : undefined;
  const said = ids.map((i) => abouts[i.id]).filter((a): a is P.PersonAboutView => !!a);
  // Safety numbers, blocking and your own profile beyond the bio: their own chunk, loaded once a profile shows.
  const extras = peopleExtras();
  const discord = said.find((a) => a.network === 'discord');

  /** Person actions need a Person; someone seen only in a channel gets one the first time you act. */
  const ensure = async () => {
    if (person) return person.id;
    const { personId: pid } = await api<{ personId: string }>(`/api/identities/${first.id}/person`, { body: {} });
    go({ view: 'profile', person: pid }, true);
    return pid;
  };
  const patch = async (body: Record<string, unknown>) => {
    const pid = await ensure();
    await api(`/api/persons/${pid}`, { method: 'PATCH', body }).catch((e) => toast({ kind: 'error', title: 'Could not save that', body: e.message }));
  };

  // ---- what you share
  const convs = profile.conversations.map((x) => ({ ...x, c: db.conversations.get(x.id) })).filter((x): x is typeof x & { c: P.ConversationView } => !!x.c);
  const spaces = new Map<string, { s: P.SpaceView; messages: number; nick?: string; roles?: { name: string; color?: string }[]; bio?: string; pronouns?: string }>();
  for (const a of said)
    for (const m of a.mutualSpaces ?? []) {
      const s = m.spaceId ? db.spaces.get(m.spaceId) : null;
      if (s) spaces.set(s.id, { s, messages: 0, nick: m.nick, roles: m.roles, bio: m.bio, pronouns: m.pronouns });
    }
  // Servers your accounts saw them in as a member (the adversarial members setting), where no profile said so.
  for (const m of profile.memberOf ?? []) {
    const s = db.spaces.get(m.spaceId);
    if (!s) continue;
    const cur = spaces.get(s.id);
    if (!cur) spaces.set(s.id, { s, messages: 0, nick: m.nick, roles: m.roles?.map((name) => ({ name })) });
    else if (!cur.nick && !cur.roles?.length) spaces.set(s.id, { ...cur, nick: m.nick, roles: m.roles?.map((name) => ({ name })) });
  }
  for (const x of convs) {
    for (const com of communitiesOf(x.c)) {
      const root = rootCommunity(com.id) ?? com;
      const cur = spaces.get(root.id) ?? { s: root, messages: 0 };
      cur.messages += x.messages;
      spaces.set(root.id, cur);
    }
  }
  const sharedSpaces = [...spaces.values()].sort((a, b) => b.messages - a.messages || a.s.name.localeCompare(b.s.name));
  // A network's notifications are not a place you share (docs/feed.md): what they did there is in Recent messages.
  const groupChats = convs.filter((x) => !isQuietConv(x.c) && (x.c.shape === 'group' || (x.c.shape === 'channel' && !x.c.spaceIds.length)));

  // ---- who they are
  // Your own bio, on each network that lets you change it from here: shown with its editor, not below.
  const editable = isSelf ? ids.map((i) => ({ i, account: bioEditor(db.accounts.values(), i.id) })).filter((x): x is { i: P.IdentityView; account: P.AccountView } => !!x.account) : [];
  // The richest first; a network's stock line ("Available") says nothing.
  const bios = said
    .filter((a) => !editable.some((x) => x.i.id === a.identityId))
    .map((a) => {
      // A newer About heard since the profile was asked replaces its bio.
      const st = (a.network === 'signal' || a.network === 'whatsapp') && db.identities.get(a.identityId)?.status;
      return st && st.at > a.fetchedAt ? { ...a, bio: st.text ?? '' } : a;
    })
    .filter((a) => a.bio?.trim() && !STOCK_BIO.test(a.bio.trim()))
    .sort((a, b) => Number(b.identityId === person?.faceId) - Number(a.identityId === person?.faceId) || b.bio!.length - a.bio!.length);
  const pronouns = said.find((a) => a.pronouns)?.pronouns;
  // The newest heard: an adapter's live status on an identity, else what a profile said. On Signal and WhatsApp the
  // live status is their About, which shows as the bio instead.
  const live = ids
    .filter((i) => i.network !== 'signal' && i.network !== 'whatsapp')
    .map((i) => i.status)
    .filter((x): x is NonNullable<P.IdentityView['status']> => !!(x?.text || x?.emoji))
    .sort((a, b) => b.at - a.at)[0];
  const heard = live ?? (said.find((a) => a.status?.text) ?? said.find((a) => a.status?.emoji))?.status;
  // A custom emoji (`:name:`) with the picture a profile gave for it (Zulip's organization emoji).
  const emojiPic = heard?.emoji?.startsWith(':') ? said.find((a) => a.status?.emoji === heard.emoji && a.status?.emojiUrl)?.status?.emojiUrl : undefined;
  const status = heard && emojiPic ? { ...heard, emojiUrl: emojiPic } : heard;
  const changesPath = person ? `/api/persons/${person.id}/changes` : `/api/identities/${first.id}/changes`;
  const chartPath = `/api/people/${person?.id ?? first.id}/activity`;
  // One number written two ways is one link.
  const seen = new Set<string>();
  const links = said
    .flatMap((a) => (a.links ?? []).map((l) => ({ ...l, network: a.network })))
    .filter((l) => {
      const k = `${l.label}|${l.label === 'Phone' ? l.value.replace(/\D/g, '') : l.value}`;
      return !seen.has(k) && seen.add(k);
    });
  // Their time zone (Zulip's): the profile's own field, else a "Time zone" fact from an older extractor.
  const zone = [...said.map((a) => a.timeZone), ...said.flatMap((a) => a.facts ?? []).map((f) => (f.label === 'Time zone' ? f.value : undefined))].find((z) => z && localTime(z));
  const localNow = zone ? localTime(zone) : null;
  // The Local time row names the zone, so its bare fact goes.
  const facts = said.flatMap((a) => (a.facts ?? []).filter((f) => !(localNow && f.label === 'Time zone' && f.value === zone)).map((f) => ({ ...f, network: a.network })));
  // How your accounts stand with them, in one vocabulary (connections.ts), with what this page changed laid over it.
  const now = withChanges(profile.links ?? [], abouts, changed);
  const conns = isSelf ? [] : connections(ids, now.links, now.abouts);
  const askedBy = said.filter((a) => a.relationship === 'requesting');

  // ---- merging
  const candidates = [...db.persons.values()].filter((x) => x.id !== person?.id && !x.isSelf);
  const myNames = new Set(ids.flatMap((i) => [normalized(i.displayName), normalized(i.handle)]).concat(normalized(name)).filter(Boolean));
  const similar = candidates.filter((x) => myNames.has(normalized(x.name)) || x.identityIds.some((id) => myNames.has(normalized(db.identities.get(id)?.displayName)) || myNames.has(normalized(db.identities.get(id)?.handle))));
  const needle = filter.trim().toLowerCase();
  const named = (x: P.PersonView) => x.name.toLowerCase().includes(needle) || x.identityIds.some((id) => [db.identities.get(id)?.handle, db.identities.get(id)?.displayName].some((v) => v?.toLowerCase().includes(needle)));
  const local = needle ? candidates.filter(named).slice(0, 12) : similar;
  const fromHub = found && found.q === filter.trim() ? found : null;
  const matches = needle ? [...local, ...(fromHub?.persons ?? []).filter((x) => !x.isSelf && !local.some((l) => l.id === x.id))] : local;
  const looseMail = needle ? (fromHub?.identities ?? []).filter((i) => i.network === 'email' && !i.personId) : [];
  const shownAs = new Map((fromHub?.identities ?? []).map((i) => [i.id, i]));
  const nameOf = (id: string) => db.identities.get(id) ?? shownAs.get(id);
  /** "Sam Rivera on Signal", "Sam Rivera <sam@rivera.example>": who that is, by where they are. */
  const elsewhere = (x: P.PersonView) => {
    const is = x.identityIds.map(nameOf).filter((i): i is P.IdentityView => !!i);
    const mail = is.find((i) => i.network === 'email');
    const chat = [...new Set(is.filter((i) => i.network !== 'email').map((i) => netName(i.network)))];
    return `${x.name}${mail ? ` <${mail.nativeId}>` : ''}${chat.length ? ` on ${chat.join(' and ')}` : ''}`;
  };
  const mergeIdentity = async (identity: string) => {
    const { personId: from } = await api<{ personId: string }>(`/api/identities/${identity}/person`, { body: {} });
    await merge(from);
  };
  const merge = async (from: string) => {
    const into = await ensure();
    await api('/api/persons/merge', { body: { into, from } });
    setMerging(false);
    setFilter('');
    toast({ kind: 'info', title: 'Merged', body: 'They now count as one person, on this hub only.' });
  };

  // ---- actions
  // Their addresses, while the composer can start a mail (slice 5).
  const emails = isSelf || !composeTo.run ? [] : ids.filter((i) => i.network === 'email');
  const email = (i: P.IdentityView) => composeTo.run?.({ name: i.displayName, email: i.nativeId, identityId: i.id, ...(i.personId ? { personId: i.personId } : {}) });
  // Message opens your chat with them, every route together; which accounts it goes between is chosen there (the
  // message box's line). Only with no chat yet does it offer where to start one (an account's own menu always can).
  const messageMenu = (): MenuSpec => ({
    label: 'Message',
    items: groups(
      startable.map((i): MenuEntry => ({ label: `Start on ${netName(i.network)}`, icon: 'plus', run: () => messageSomeone(i.id) })),
      emails.map((i): MenuEntry => ({ label: `Email ${i.nativeId}`, icon: 'mail', run: () => email(i) })),
    ),
  });
  const messageOptions = directs.length ? 1 : startable.length + emails.length;
  const message = () => {
    if (directs.length > 1 && person) go({ view: 'people', person: person.id });
    else if (directs.length) go({ view: 'inbox', conv: [...directs].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))[0].id });
    else if (startable.length === 1) messageSomeone(startable[0].id);
    else if (emails.length === 1) email(emails[0]);
  };
  const moreMenu = (): MenuSpec | null => {
    const base = person ? personMenu(person) : identityMenu(first?.id);
    const extra: MenuEntry[] = groups(
      // One account's nickname is theirs (with several, each tile has its own).
      ids.length === 1 && !first?.isBot ? nicknameEntries(first, () => setNaming(first!.id)) : [],
      [{ label: 'Ask the Networks Again', icon: 'refresh', run: refresh }],
      // Ignore on their networks (ProfileSelf.tsx).
      isSelf || !S ? [] : S.selfEntries(ids, profile, profile.links ?? [], update),
    );
    // What the page already shows as a button is not repeated.
    const shown = new Set(['Profile', 'Message', 'Copy']);
    const items = (base?.items ?? [])
      .filter((e) => !('label' in e && shown.has(e.label as string)))
      .filter((e, i, xs) => e.kind !== 'sep' || (i > 0 && i < xs.length - 1 && xs[i - 1].kind !== 'sep'));
    return { label: `${name} actions`, items: groups(items, extra) };
  };
  // Block or unblock, where an account can (Signal): asked again after, so the page says how you stand.
  const blocks = isSelf ? [] : (extras?.blockEntries(ids, profile.links ?? [], abouts, () => void refresh()) ?? []);

  // ---- each account: one account is the hero's chip and a row on the right; several are rows of their own
  const several = ids.length > 1;
  // The account they are shown by, their face (docs/chats.md "Names"), and the one whose picture they show instead.
  const speaker = (several && ids.find((i) => i.id === person?.faceId)) || null;
  const pictureChosen = (several && ids.find((i) => i.id === person?.pictureIdentityId)) || null;
  // It shows only while it has a picture and is not the main account's own; its entry stays to clear it.
  const pictureOf = pictureChosen?.avatar && pictureChosen.id !== speaker?.id ? pictureChosen : null;
  // Their name chosen from another account than the main one (the hero's pencil), for the Accounts card's note.
  const nameAcct = (person?.nameFrom && person.nameFrom.identityId !== speaker?.id && ids.find((i) => i.id === person.nameFrom!.identityId)) || null;
  /** Saved, or false where it could not be (said in a toast). */
  const sources = async (patch: { face?: string | null; picture?: string | null; nameFrom?: P.NameFrom | null }) =>
    !!person &&
    api(`/api/persons/${person.id}`, { method: 'PATCH', body: patch }).then(
      () => true,
      (e) => (toast({ kind: 'error', title: 'Could not save that', body: e.message }), false),
    );
  const sinceOf = new Map(said.filter((a) => a.createdAt).map((a) => [a.identityId, monthYear(a.createdAt!)]));
  /** How to reach one account: its chat (the person's page, sending there), else start one, else mail it. */
  const reach = (i: P.IdentityView): { run: () => void; label: string } | null => {
    if (isSelf) return null;
    const who = `${identityName(i.id)} on ${netName(i.network)}`;
    if (i.network === 'email') return composeTo.run ? { run: () => email(i), label: `Email ${i.nativeId}` } : null;
    const dm = directs.filter((d) => d.participantIds.includes(i.id)).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))[0];
    if (dm) return { run: () => go({ view: 'inbox', conv: dm.id }), label: `Message ${who}` };
    if (openers(accounts, i.network).length) return { run: () => messageSomeone(i.id), label: `Start a chat with ${who}` };
    return null;
  };
  const split = (i: P.IdentityView) => api(`/api/identities/${i.id}/split`, { body: {} }).then(() => toast({ kind: 'info', title: 'Split', body: `${i.displayName ?? i.handle ?? 'That identity'} is its own person again.` }));
  const accountMenu = (i: P.IdentityView, editNickname?: () => void): MenuSpec => {
    const r = reach(i);
    const link = externalProfile(i);
    return {
      label: `${identityName(i.id)} on ${netName(i.network)}`,
      items: groups(
        [r && { label: r.label, icon: i.network === 'email' ? 'mail' : 'send', run: r.run }],
        nicknameEntries(i, editNickname),
        [
          { label: i.handle ? `Copy ${i.handle}` : 'Copy ID', icon: 'copy', run: () => copy(i.handle ?? i.nativeId, 'Copied') },
          !!i.handle && i.handle !== i.nativeId && { label: 'Copy ID', icon: 'copy', run: () => copy(i.nativeId, 'Copied') },
          !!link && { label: `Open on ${netName(i.network)}`, icon: 'external', run: () => void window.open(link, '_blank', 'noreferrer') },
        ],
        // Which account speaks for them (docs/chats.md "Names"): their face, whose name, picture and bio come first,
        // kept once you make it the main account, else chosen by the hub; a picture from another.
        several && !isSelf && !!person
          ? [
              speaker?.id === i.id && person.facePinned
                ? { label: 'Main Account', icon: 'star', checked: true, track: 'main account', run: () => void sources({ face: null }) }
                : { label: 'Make Main Account', icon: 'star', track: 'main account', run: () => void sources({ face: i.id }) },
              (pictureChosen?.id === i.id || (!!i.avatar && speaker?.id !== i.id)) && { label: pictureChosen?.id === i.id ? 'Their Picture' : 'Use Its Picture', icon: 'image', checked: pictureChosen?.id === i.id, track: 'use picture', run: () => void sources({ picture: pictureChosen?.id === i.id ? null : i.id }) },
            ]
          : [],
        [several && !isSelf && { label: 'Split Into Its Own Person', icon: 'unlink', run: () => void split(i) }],
        [!!ownPicture?.dests.some((d) => d.key === i.id) && { label: 'Change Picture…', icon: 'image', track: 'change picture', run: () => setPicturing({ came: i.id }) }],
      ),
    };
  };
  // Grouped by network, in the order the person's accounts first name them.
  const tiles = [...ids].sort((a, b) => nets.indexOf(a.network) - nets.indexOf(b.network));

  // The main account's banner where it has one, else Discord's (the one network with banners and accents).
  const look = (speaker && said.find((a) => a.identityId === speaker.id && (a.banner || a.accent))) || discord;
  const accent = look?.accent ?? null;
  const banner = look?.banner ?? null;
  const picture = person?.avatar ?? first?.avatar ?? said.find((a) => a.avatar)?.avatar;
  const picTarget = (came?: string) => (isSelf && pe ? pe.selfTarget({ ids, abouts, came: came ?? identityId, picture: picture ?? null, historyPath: changesPath, onSaved: learn }) : null);
  const ownPicture = picTarget();
  editing.current = picturing ? ((picturing.came ? picTarget(picturing.came) : ownPicture) ?? editing.current) : null;

  // Which name and which picture show for them, chosen in the hero (docs/profile.md "Which account speaks for them").
  // In the Accounts card's order (by network), the main account's first.
  const mainAcct = speaker ?? first;
  const entries = isSelf ? [] : nameEntries(tiles, mainAcct?.id);
  const nameRowsOf = !isSelf && person ? nameRows(entries, person, identityName(mainAcct?.id), several) : [];
  // A name typed in the hero is your nickname for their mainAcct account, and the name shown (a choice made goes back to it).
  const mayNickname = !isSelf && nicknamable(mainAcct) && !mainAcct.isBot;
  const nicknameMain = async (text: string) => {
    if (!mainAcct || !(await saveNickname(mainAcct.id, text))) return;
    if (person?.nameFrom) void sources({ nameFrom: null });
  };
  const pictures = several && !isSelf && person ? pictureChoices(ids, person, speaker) : [];
  // Their pictures, full screen, the one shown first in view: swipe or page through them and use another.
  const viewPictures = () => {
    const on = Math.max(0, pictures.findIndex((c) => c.on));
    viewer.value = {
      images: pictures.map((c) => ({ url: c.url, name: c.label, detail: c.detail, fill: true })),
      index: on,
      choose: { on, pick: (k) => sources({ picture: pictures[k].id === speaker?.id ? null : pictures[k].id }) },
    };
  };

  const hero = (
    <Hero
      id={person?.id ?? first?.id ?? ''}
      name={name}
      picture={picture}
      onPicture={ownPicture ? (e) => pe!.pictureMenu(e, ownPicture, setPicturing, picture ? () => viewPicture(picture, name) : undefined) : undefined}
      onView={pictures.length > 1 ? viewPictures : undefined}
      presence={isSelf ? undefined : person ? { person: person.id } : { identity: first?.id }}
      network={nets.length === 1 ? nets[0] : undefined}
      banner={banner}
      accent={accent}
      title={
        isSelf ? (
          <h1>{name}</h1>
        ) : (
          <HeroName
            name={name}
            also={alsoNames(entries, name)}
            rows={nameRowsOf}
            nickname={mayNickname}
            editing={naming !== null}
            setEditing={(on) => setNaming(on ? (mainAcct?.id ?? '') : null)}
            onPick={(r) => void sources({ nameFrom: r.from })}
            onNickname={(t) => void nicknameMain(t)}
          />
        )
      }
      sub={
        <span class="pf-handles">
          {several ? (
            <button class="pf-handle pf-acct-sum" title="Their accounts, below" onClick={() => document.querySelector('.pf-accounts')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              {nets.map((n) => (
                <NetGlyph network={n} size={12} />
              ))}
              {ids.length} accounts
            </button>
          ) : (
            ids.map((i) => <HandleChip i={i} />)
          )}
        </span>
      }
      tags={
        <>
          {isSelf && <Tag tone="accent">You</Tag>}
          {first?.isBot && <Tag tone="muted">Bot</Tag>}
          {pronouns && <Tag>{pronouns}</Tag>}
          {/* The words a tag stands for ("Friends on Discord; You follow each other on X") are its hover and, hidden, what a screen reader says. */}
          {connectionTags(conns).map((t) => (
            <Tag icon={t.kind === 'friend' ? 'users' : t.kind === 'blocked' ? 'x' : 'user'} tone={t.kind === 'friend' ? 'accent' : t.kind === 'blocked' ? 'warn' : undefined} title={t.title} kind={t.kind} networks={t.networks}>
              {t.label}
              {t.networks.map((n) => (
                <NetGlyph network={n} size={11} decorative />
              ))}
              <span class="sr-only">: {t.title}</span>
            </Tag>
          ))}
          {/* They asked you: a request, not a connection yet; Accept and Decline are in the row below. */}
          {!isSelf && askedBy.length > 0 && (
            <Tag icon="userPlus" tone="accent" title={`Wants to be friends on ${askedBy.map((a) => netName(a.network)).join(' and ')}`} kind="requesting" networks={askedBy.map((a) => a.network)}>
              {RELATIONSHIP_LABEL.requesting}
              {askedBy.map((a) => (
                <NetGlyph network={a.network} size={11} decorative />
              ))}
              <span class="sr-only"> on {askedBy.map((a) => netName(a.network)).join(' and ')}</span>
            </Tag>
          )}
          {!isSelf &&
            S?.ignoredNets(ids, profile).map((n) => (
              <Tag icon="bellOff" tone="muted" title={`You ignore them on ${netName(n)}: their messages never alert`}>
                Ignored{nets.length > 1 && <NetGlyph network={n} size={11} />}
              </Tag>
            ))}
        </>
      }
      status={
        status && (
          <>
            <StatusEmoji status={status} />
            {status.text}
          </>
        )
      }
      actions={
        <>
          {!isSelf && messageOptions > 0 && (messageOptions === 1 ? <Action primary icon="send" label="Message" onClick={message} /> : <Action primary icon="send" label="Message" menu={messageMenu} />)}
          {!isSelf && <Action icon="merge" label="Merge" title="Merge another identity in" onClick={() => setMerging(!merging)} />}
          {!isSelf && (
            <ConnectActions
              identities={ids}
              abouts={abouts}
              onChanged={(a) => {
                if (a.relationship) change(a.accountId, a.identityId, a.relationship);
                learn(a);
              }}
            />
          )}
          {ids.length > 0 && <Action icon="copy" label="Copy" menu={() => ({ label: 'Copy', items: copyEntries(ids) })} />}
          {blocks.length > 0 && <Action icon="x" label="Block" menu={() => ({ label: 'Block', items: blocks })} />}
          <Action icon="more" label="More" menu={moreMenu} />
        </>
      }
    />
  );

  const mergeUi = (
    <>
      {!isSelf && similar.length > 0 && !merging && (
        <p class="pf-hint">
          Same name elsewhere: {similar.slice(0, 3).map(elsewhere).join(', ')}.{' '}
          <button class="link-btn" onClick={() => setMerging(true)}>
            Merge?
          </button>
        </p>
      )}
      {!isSelf && merging && (
        <div class="merge-box">
          <input class="input" placeholder="Search people to merge in" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} ref={(el) => void (el && document.activeElement !== el && !filter && el.focus())} />
          {matches.map((o) => (
            <button class="link-row" onClick={() => merge(o.id)}>
              <Avatar id={o.id} name={o.name} url={o.avatar} size={22} /> {o.name}
              <span class="row-nets">
                {[...new Set(o.identityIds.map((x) => db.identities.get(x)?.network).filter(Boolean))].map((n) => (
                  <NetBadge network={n as P.Network} size={13} />
                ))}
              </span>
            </button>
          ))}
          {looseMail.map((i) => (
            <button class="link-row" onClick={() => mergeIdentity(i.id)}>
              <Avatar id={i.id} name={i.displayName ?? i.nativeId} size={22} /> {i.displayName ? `${i.displayName} <${i.nativeId}>` : i.nativeId}
              <span class="row-nets">
                <NetBadge network="email" size={13} />
              </span>
            </button>
          ))}
          {needle && !matches.length && !looseMail.length && <p class="pf-hint">Nobody by that name.</p>}
          <button class="btn ghost small" onClick={() => setMerging(false)}>
            Done
          </button>
        </div>
      )}
    </>
  );

  const sameBox = (
    <>
      {!isSelf && sameSide && <SameBox side={sameSide} />}
    </>
  );

  const aboutCard = (
    <>
      <Card title="About" icon="info" extra={asking ? <span class="pf-asking">Asking…</span> : undefined}>
        {editable.map(({ i, account }) => (
          <>
            <OwnBio identity={i} about={abouts[i.id]} account={account} label={editable.length + bios.length > 1 || nets.length > 1} onSaved={learn} />
            {extras && <extras.OwnProfileExtras identity={i} about={abouts[i.id]} onSaved={learn} />}
          </>
        ))}
        {isSelf && S && ids.map((i) => <S.OwnProfileFields identity={i} about={abouts[i.id]} onSaved={learn} />)}
        {bios.length || editable.length ? (
          bios.map((a) => (
            <div class="pf-bio" data-identity={a.identityId}>
              {(bios.length > 1 || nets.length > 1) && (
                <span class="pf-bio-net">
                  <NetGlyph network={a.network} size={11} /> {netName(a.network)}
                  {/* Two accounts on one network: which one. */}
                  {ids.filter((i) => i.network === a.network).length > 1 && ` · ${identityName(a.identityId)}`}
                  {a.identityId === speaker?.id && ' · main'}
                </span>
              )}
              <p>
                <Linked text={bioText(a.bio!, a.network)} network={a.network} />
              </p>
            </div>
          ))
        ) : asking ? (
          <Loading inline label="Asking the networks…" />
        ) : (
          <p class="pf-empty" title={nets.map((n) => `${netName(n)}: ${WHAT_NETWORKS_SHARE[n]}`).join('\n')}>
            No bio on {several ? 'any of their accounts' : netName(nets[0])}.
          </p>
        )}
        {links.length > 0 && (
          <div class="pf-links">
            {links.map((l) =>
              l.url ? (
                <a class="pf-link" href={l.url} target="_blank" rel="noreferrer" title={`${l.label}: ${l.value}`}>
                  <NetGlyph network={l.network} size={11} />
                  <b>{l.label}</b> {l.value}
                  {l.verified && <Icon name="check" size={11} />}
                </a>
              ) : (
                <span class="pf-link">
                  <b>{l.label}</b> {l.value}
                </span>
              ),
            )}
          </div>
        )}
        {/* Counts are facts about their account; whether they follow you is a connection (Connections, the hero). */}
        {said.some((a) => a.counts) && (
          <div class="pf-follow">
            {said
              .filter((a) => a.counts)
              .map((a) => (
                <span class="pf-follow-line" data-network={a.network}>
                  {(said.length > 1 || nets.length > 1) && <NetGlyph network={a.network} size={11} />}
                  {a.counts?.followers !== undefined && (
                    <span>
                      <b>{a.counts.followers.toLocaleString()}</b> followers
                    </span>
                  )}
                  {a.counts?.following !== undefined && (
                    <span>
                      <b>{a.counts.following.toLocaleString()}</b> following
                    </span>
                  )}
                  {a.counts?.posts !== undefined && (
                    <span>
                      <b>{a.counts.posts.toLocaleString()}</b> posts
                    </span>
                  )}
                </span>
              ))}
          </div>
        )}
        <Facts
          rows={[
            ...dedupe([
              ...said.filter((a) => a.createdAt).map((a): [string, string] => [`On ${netName(a.network)} since`, monthYear(a.createdAt!)]),
              ...facts.map((f): [string, string] => [f.label, f.value]),
            ]).map(([k, v]): [string, ComponentChildren] => {
              // A fact that names people (a bot's owner, a person field) links each to their profile.
              const named = facts.find((f) => f.label === k && f.value === v && f.people?.length)?.people;
              return [k, named ? <FactPeople ids={named} /> : v];
            }),
            localNow ? ['Local time', localNow] : null,
            profile.totalMessages > 0 && [
              'Messages stored',
              `${profile.totalMessages.toLocaleString()}${profile.firstSeenTs ? ` since ${new Date(profile.firstSeenTs).toLocaleDateString()}` : ''}`,
            ],
          ]}
        />
        {S && <S.ProfileExtras said={said} />}
        {said.filter((a) => a.unasked && !a.stale).map((a) => (
          <p class="pf-stale">
            <NetGlyph network={a.network} size={11} /> <span title={fullTime(a.fetchedAt)}>As {netName(a.network)} showed them in your notifications.</span>
          </p>
        ))}
        {said.filter((a) => a.stale).map((a) => (
          <p class="pf-stale">
            <NetGlyph network={a.network} size={11} /> {a.stale}
          </p>
        ))}
      </Card>
    </>
  );

  const postsCard = (
    <>
      {said.some((a) => a.posts?.length) && (
        <Card title="Recent posts" icon="send" count={said.reduce((n, a) => n + (a.posts?.length ?? 0), 0)} class="pf-posts">
          <RecentPostsLazy abouts={said} />
        </Card>
      )}
    </>
  );

  const activityCard = (
    <>
      <ActivityCard
        path={changesPath}
        chartPath={chartPath}
        self={isSelf}
        chart={profile.totalMessages > 0 || profile.conversations.length > 0}
        status={status}
        at={live && heard === live ? live.at : undefined}
        presence={isSelf ? undefined : person ? { person: person.id } : { identity: first?.id }}
      />
    </>
  );

  const voiceCard = (
    <>
      <VoiceCard base={person ? `/api/persons/${person.id}` : `/api/identities/${first.id}`} self={isSelf} />
    </>
  );

  const storiesEl = (
    <>
      {ids
        .filter((i) => i.network === 'signal' && !isSelfIdentity(i.id))
        .map((i) => (
          <Stories identityId={i.id} network={i.network} />
        ))}
    </>
  );

  const eventsCard = (
    <>
      {!!profile.events?.length && <EventsCard events={profile.events} />}
    </>
  );

  const historyCard = (
    <>
      <HistoryCard path={`${changesPath}?except=status,presence,voice`} person />
    </>
  );

  const friendsCard = (
    <>
      {isSelf ? <FriendsCard said={said} of={(a) => a.friends} /> : <FriendsCard said={said} of={(a) => a.mutualFriends} mutual />}
    </>
  );

  const safetyCard = (
    <>
      {!isSelf && extras && <extras.SafetyCard abouts={said} name={name} onChanged={learn} />}
    </>
  );

  const ended = (identityId: string, accountId: string) => {
    change(accountId, identityId, 'stranger');
    const a = abouts[identityId];
    if (a && a.accountId === accountId) learn({ ...a, relationship: 'stranger' });
  };
  // Their accounts, each with how yours stand with it (connections.ts: friends, contacts, follows, with Remove friend
  // and the like) under it. An account named as the person leads with its handle.
  const accountsCard = (
    <Card title="Accounts" icon="idBadge" count={ids.length > 1 ? ids.length : undefined} class="pf-accounts">
      <div class="pf-acct-list">
        {tiles.map((i) => {
          const r = reach(i);
          const mine = conns.filter((c) => c.identityId === i.id);
          return (
            <div class="pf-acct-item" data-same={identityName(i.id) === name || undefined}>
              <AccountRow key={i.id} i={i} since={sinceOf.get(i.id)} main={speaker?.id === i.id} chosen={speaker?.id === i.id && !!person?.facePinned} picture={pictureOf?.id === i.id} go={r?.run} goLabel={r?.label} menu={(edit) => accountMenu(i, edit)} />
              {mine.length > 0 && <ProfileConnections identities={ids} list={mine} onEnded={ended} />}
            </div>
          );
        })}
      </div>
      {!isSelf && person && several && (
        <p class="pf-acct-note">
          {speaker ? (
            <span>
              <NetGlyph network={speaker.network} size={11} /> {identityName(speaker.id)} speaks for them{person.facePinned ? '' : ' for now'}
              {nameAcct ? `; their name is from ${netName(nameAcct.network)}` : ''}
              {pictureOf ? `; their picture is from ${netName(pictureOf.network)}` : ''}.
            </span>
          ) : (
            <>No account speaks for them yet.</>
          )}
        </p>
      )}
      {mergeUi}
    </Card>
  );
  const msgRow = (m: P.ProfileView['recent'][number]): BetweenRow => {
    const c = db.conversations.get(m.conversationId);
    return {
      key: m.id,
      ts: m.ts,
      kind: 'chat',
      el: (
        <button class="pf-row pf-msg" onClick={() => openMessage(m.conversationId, m.id)} title={fullTime(m.ts)}>
          {c && !isQuietConv(c) ? <PlaceIcon c={c} size={24} /> : <NetBadge network={m.network} size={24} />}
          <span class="pf-row-text">
            <small class="pf-msg-where">{c ? (c.shape === 'direct' ? `Direct message · ${netName(c.network)}` : c.variant === 'feed' ? `${netName(c.network)} notifications` : c.variant === 'posts' ? `${netName(c.network)} posts` : convLabel(c)) : 'Unknown'}</small>
            <span class="pf-msg-body">{m.feed ? feedLine(m.feed, m.body, m.network) : plainBody(m.body, m.network) || (m.attachments.length ? 'Attachment' : m.kind === 'encrypted' ? 'Encrypted message' : '')}</span>
          </span>
          <span class="pf-row-time">{ago(m.ts)}</span>
        </button>
      ),
    };
  };
  const mailRow = (t: P.MailThreadView): BetweenRow => ({
    key: t.id,
    ts: t.lastAt,
    kind: 'mail',
    el: (
      <button
        class={`pf-row pf-msg pf-mail-row ${t.unread ? 'unread' : ''}`}
        onClick={() => {
          db.mail.threads.set(t.id, t);
          go({ view: 'inbox', conv: t.id });
        }}
        title={fullTime(t.lastAt)}
      >
        <NetBadge network="email" size={24} />
        <span class="pf-row-text">
          <small class="pf-msg-where">
            Mail · {senderLine(t)}
            {t.count > 1 ? ` · ${t.count}` : ''}
          </small>
          <span class="pf-msg-body">
            <b>{t.subject || '(no subject)'}</b>
            {t.preview ? ` — ${t.preview}` : ''}
          </span>
        </span>
        <span class="pf-row-time">{ago(t.lastAt)}</span>
      </button>
    ),
  });
  const betweenRows = [...profile.recent.map(msgRow), ...(profile.mail?.threads ?? []).map(mailRow)];
  const mailTotal = profile.mail?.total ?? 0;
  // Their messages and your mail with them, in one list (docs/profile.md "Between you").
  const betweenCard = betweenRows.length > 0 && (
    <Card title={isSelf ? 'Your messages' : 'Between you'} icon="send" count={profile.recent.length + mailTotal || undefined} class="pf-between-card">
      <Between
        rows={betweenRows}
        foot={
          mailTotal > 0 && (
            <button class="link-btn pf-mail-all" onClick={() => go({ view: 'inbox', mail: withList(person?.id ?? first.id) })}>
              {mailTotal > (profile.mail?.threads.length ?? 0) ? `All ${mailTotal.toLocaleString()} mail threads` : 'All mail'}
            </button>
          )
        }
      />
    </Card>
  );
  const placesN = sharedSpaces.length + groupChats.length;
  const placesEl = placesN > 0 && (
    <div class="pf-rows pf-places">
      {sharedSpaces.map(({ s, messages, nick, roles, bio, pronouns }) => {
        const est = counts[s.id]?.observed ? counts[s.id] : undefined;
        return (
          <button class="pf-row" onClick={() => go({ view: 'space', space: s.id })} title={[s.name, est && countTitle(est, fullTime), pronouns, bio].filter(Boolean).join('\n')}>
            <Avatar id={s.id} name={s.name} url={s.icon} size={24} square network={s.network} />
            <span class="pf-row-text">
              <b>{s.name}</b>
              <small>{[nick && `as ${nick}`, est ? countText(est) : messages ? `${messages.toLocaleString()} messages` : 'member', roles?.length ? roles.slice(0, 2).map((r) => r.name).join(', ') : null].filter(Boolean).join(' · ')}</small>
            </span>
          </button>
        );
      })}
      {groupChats.map(({ c, messages, lastTs }) => (
        <button class="pf-row" onClick={() => openConv(c)}>
          <PlaceIcon c={c} size={24} />
          <span class="pf-row-text">
            <b>{convTitle(c)}</b>
            <small>
              {kindLabel(c)}
              {messages ? ` · ${messages.toLocaleString()} from ${isSelf ? 'you' : 'them'}` : ''}
            </small>
          </span>
          {lastTs && <span class="pf-row-time">{ago(lastTs)}</span>}
        </button>
      ))}
    </div>
  );
  const ties = !isSelf && closeTo ? tiesOf(closeTo, said) : null;
  // The friends you share and the people they talk with, then the servers and groups you are both in.
  const commonCard = (
    <>
      {isSelf && friendsCard}
      {(ties?.length || placesN > 0) && (
        <Card title={isSelf ? 'Your places' : 'In common'} icon="layers" count={placesN || undefined} class="pf-common">
          {!!ties?.length && (
            <>
              <h4 class="pf-sub-h">People</h4>
              <PeopleInCommon ties={ties} />
            </>
          )}
          {placesN > 0 && !isSelf && <h4 class="pf-sub-h">Places</h4>}
          {placesEl}
        </Card>
      )}
    </>
  );
  const yoursCard = (
    <Card title={isSelf ? 'Note' : 'Yours'} icon="pencil" class="pf-yours">
      {!isSelf && (
        <label class="toggle-row">
          <input
            type="checkbox"
            checked={rule?.level === 'all'}
            onChange={async (e) => {
              const on = (e.target as HTMLInputElement).checked;
              setRule('person', await ensure(), on ? 'all' : null);
            }}
          />
          <span>
            <b>Always alert</b>
            <small>Every message of theirs, everywhere.</small>
          </span>
        </label>
      )}
      <textarea class="input pf-note" rows={2} placeholder="A note only you see" value={profile.note ?? ''} onChange={(e) => patch({ note: (e.target as HTMLTextAreaElement).value })} />
    </Card>
  );
  const rest = (
    <>
      {voiceCard}
      {postsCard}
      {storiesEl}
      {eventsCard}
    </>
  );
  // At a glance: how you stand, what you share, when you last heard from them, in a sentence or three.
  const placeNames = [...sharedSpaces.map((x) => x.s.name), ...groupChats.map((x) => convTitle(x.c))];
  const mutualIds = ties ? ties.filter((t) => t.friendOn.length).map((t) => t.identityId) : onePerPerson(said.flatMap((a) => a.mutualFriends ?? []).filter((i) => !isSelfIdentity(i)));
  const mutualNames = mutualIds.map((i) => db.persons.get(db.identities.get(i)?.personId ?? '')?.name ?? identityName(i));
  const when = (ts: number) => {
    const a = ago(ts);
    return a === 'now' ? 'just now' : /\d[mh]$/.test(a) ? `${a} ago` : `on ${a}`;
  };
  const newest = [...profile.recent].sort((a, b) => b.ts - a.ts)[0];
  const newestConv = newest && db.conversations.get(newest.conversationId);
  const STANDING: Record<string, string> = { friend: 'friends on', contact: 'in your contacts on', following: 'you follow them on', follower: 'they follow you on', requested: 'you asked them on', blocked: 'blocked on' };
  const standingText = connectionTags(conns)
    .map((t) => `${STANDING[t.kind] ?? t.label} ${andList(t.networks.map(netName))}`)
    .join(', ');
  const standing = standingText.charAt(0).toUpperCase() + standingText.slice(1);
  const glance = !isSelf && (
    <p class="pf-glance">
      {conns.length > 0 && <span>{standing}. </span>}
      {(placeNames.length > 0 || mutualNames.length > 0) && (
        <span>
          You share {placeNames.length > 0 && <b>{andList([...placeNames.slice(0, 3), ...(placeNames.length > 3 ? [`${placeNames.length - 3} more`] : [])])}</b>}
          {placeNames.length > 0 && mutualNames.length > 0 && ' and '}
          {mutualNames.length > 0 && (
            <>
              {mutualNames.length} friend{mutualNames.length === 1 ? '' : 's'} ({andList(mutualNames.slice(0, 3))}
              {mutualNames.length > 3 ? '…' : ''})
            </>
          )}
          .{' '}
        </span>
      )}
      {newest && (
        <span>
          Last heard {when(newest.ts)}{newestConv ? (newestConv.shape === 'direct' ? ` in your ${netName(newestConv.network)} chat` : ` in ${convTitle(newestConv)}`) : ''}
          {mailTotal > 0 && profile.mail?.threads[0] ? `; last mail ${when(profile.mail.threads[0].lastAt)}` : ''}.
        </span>
      )}
    </p>
  );
  // Who they are and what passes between you on the left, their accounts and what you share on the right. One column
  // (900px and narrower) takes each side's lead first: the glance, About, Between you, Accounts and In common, then the
  // rest.
  const layout = (
    <Columns
      main={
        <>
          <div class="pf-lead">
            {glance}
            {sameBox}
            {aboutCard}
            {betweenCard}
          </div>
          {activityCard}
          {rest}
          {historyCard}
        </>
      }
      side={
        <>
          <div class="pf-lead">
            {accountsCard}
            {commonCard}
          </div>
          {safetyCard}
          {yoursCard}
        </>
      }
    />
  );

  return (
    <ProfilePage title={name} label={`${name}'s profile`} onBack={onBack}>
      {hero}
      {!isSelf && !directs.length && !startable.length && chatNets.length > 0 && (
        <p class="pf-hint pf-banner-note">
          No direct chat yet, and no connected account can start one on {chatNets.map(netName).join(' or ')}. Start it in the network's own app; it appears here once it exists.
        </p>
      )}
      {layout}
      {ownPicture && pe && <pe.PictureDrop open={setPicturing} />}
      {pe && picturing && editing.current && <pe.PictureEditor target={editing.current} start={picturing} onClose={() => setPicturing(null)} />}
    </ProfilePage>
  );
}

/**
 * A person's profile (docs/profile.md): who they are on each network, as the networks say it (bio, pronouns, status,
 * links), what you share (servers with their nickname and roles there, group chats, friends), what they said lately,
 * and how you stand with them (accounts, notifications, your note). The actions from their menu sit in the hero.
 */
import type * as P from '@dither-chat/protocol';
import { RELATIONSHIP_LABEL, withList } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago, fullTime } from '../format.ts';
import { bioEditor, bioLeft } from '../bio.ts';
import { openers } from '../direct.ts';
import { composeTo } from '../mail/people.ts';
import { senderLine } from '../mail/model.ts';
import { countText, countTitle } from '../msgcount.ts';
import { communitiesOf, convLabel, convTitle, directsOf, externalProfile, identityName, kindLabel, netName, plainBody, rootCommunity } from '../model.ts';
import { profileLinks } from '../requests.ts';
import { api, db, go, isSelfIdentity, openMessage, openProfile, rev, setRule, toast } from '../state.ts';
import { messageSomeone } from './Palette.tsx';
import { Avatar, Empty, NetBadge, NetGlyph } from './bits.tsx';
import { copy, groups, openMenu, useMenu, type MenuEntry, type MenuSpec } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import { nicknamable, nicknameEntries, NicknamedName, NicknameInput, ownName } from './Nickname.tsx';
import { ActivityCard } from './ActivityCard.tsx';
import { HistoryCard } from './HistoryCard.tsx';
import { identityMenu, personMenu } from './menus.tsx';
import { Action, Card, Columns, Facts, Hero, monthYear, ProfilePage, Tag } from './ProfileShell.tsx';
import { ConnectActions, ProfileLinks } from './Requests.tsx';
import { openConv } from './Sidebar.tsx';
import { Loading } from './Loader.tsx';
import { peopleExtras } from './peopleExtras.ts';
import { Stories } from './StoriesLazy.tsx';

import { signal } from '@preact/signals';

/** Your note on their network, Block and Ignore, badges, your own fields (ProfileSelf.tsx): a chunk of its own, loaded with the first profile. */
type Self = typeof import('./ProfileSelf.tsx');
const selfParts = signal<Self | null>(null);
let selfLoading: Promise<unknown> | null = null;
const loadSelf = () => (selfLoading ??= import('./ProfileSelf.tsx').then((m) => (selfParts.value = m), () => (selfLoading = null)));
import { RecentPostsLazy } from './feed/lazy.tsx';
import { clip, FEED_VERB } from '../feed.ts';

/** A feed item in their Recent messages (docs/feed.md): "Liked your post: “…”", or what they wrote. */
function feedLine(f: P.FeedItem, body: string): string {
  if (f.type === 'reply' || f.type === 'mention' || f.type === 'quote') return `${FEED_VERB[f.type][0].toUpperCase()}${FEED_VERB[f.type].slice(1)}: ${clip(f.theirs?.text ?? body, 140)}`;
  if (f.type === 'other') return f.text ?? body;
  const verb = `${FEED_VERB[f.type][0].toUpperCase()}${FEED_VERB[f.type].slice(1)}`;
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

const normalized = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A conversation's picture: its own, else its server's. */
export function PlaceIcon({ c, size = 22 }: { c: P.ConversationView; size?: number }) {
  const com = c.spaceIds.length ? rootCommunity(c.spaceIds[0]) : null;
  if (com) return <Avatar id={com.id} name={com.name} url={com.icon} size={size} square network={c.network} />;
  const person = c.peerPersonId ? db.persons.get(c.peerPersonId) : null;
  return <Avatar id={person?.id ?? c.id} name={convTitle(c)} url={person?.avatar ?? c.avatar} size={size} square={c.shape !== 'direct'} network={c.network} />;
}

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
 * One of several accounts of a person, on their profile: its own picture with its network's badge, its own name, its
 * handle (copies), what it says about itself (`bio`), and when it joined its network. A button goes to it (its chat,
 * or starts one, or a mail), and its menu (⋯, right-click or hold) has the rest: your nickname for it, copy, open
 * on the network, split. With a nickname, the tile says it as the name and the account's own beneath it.
 */
function AccountTile({ i, bio, since, go: open, goLabel, menu: menuOf }: { i: P.IdentityView; bio?: string; since?: string; go?: () => void; goLabel?: string; menu: (editNickname: () => void) => MenuSpec }) {
  const [editing, setEditing] = useState(false);
  const menu = () => menuOf(() => setEditing(true));
  const ctx = useMenu(menu);
  const name = identityName(i.id);
  return (
    <div class="pf-acct" data-identity={i.id} {...ctx}>
      <Avatar id={i.id} name={name} url={i.avatar} size={44} network={i.network} />
      <div class="pf-acct-text">
        <div class="pf-acct-top">
          {editing ? (
            <NicknameInput i={i} onDone={() => setEditing(false)} class="pair-nick-input pf-acct-nick-input" />
          ) : (
            <b class="pf-acct-name" title={i.nickname ? `${name}: your nickname (only you see it)` : name}>
              {name}
            </b>
          )}
          {open && (
            <button class="icon-btn small" title={goLabel} aria-label={goLabel} onClick={open}>
              <Icon name={i.network === 'email' ? 'mail' : 'send'} size={14} />
            </button>
          )}
          <button class="icon-btn small" title={`${name} on ${netName(i.network)}`} aria-label={`More for ${name} on ${netName(i.network)}`} onClick={(e) => openMenu(anchorOf(e), menu(), e.currentTarget)}>
            <Icon name="more" size={14} />
          </button>
        </div>
        {i.nickname && <small class="pf-acct-own">their name: {ownName(i)}</small>}
        <span class="pf-acct-handle">
          <HandleChip i={i} />
          <small>
            {netName(i.network)}
            {since ? ` · since ${since}` : ''}
          </small>
        </span>
        {bio && <p class="pf-acct-bio">{plainBody(bio, i.network)}</p>}
      </div>
    </div>
  );
}

/** Where a menu opened from a button goes: under it. */
const anchorOf = (e: MouseEvent) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
};

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
          <p>{bio ? plainBody(bio, identity.network) : <em>No bio on {net} yet</em>}</p>
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
            if (e.key === 'Escape') (e.stopPropagation(), setDraft(null), setError(null));
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

/** How each of your accounts stands with them, from the accounts' own lists, with Remove friend and the like. */
function ProfileLinksCard({ ids, links, abouts, onEnded }: { ids: P.IdentityView[]; links: P.PersonLinkView[]; abouts: Record<string, P.PersonAboutView | undefined>; onEnded: (identityId: string, accountId: string) => void }) {
  if (!profileLinks(ids, links, abouts).length) return null;
  return (
    <Card title="How you stand" icon="users" class="pf-standing">
      <ProfileLinks identities={ids} links={links} abouts={abouts} onEnded={onEnded} />
    </Card>
  );
}

/** Mail with them: their newest threads, how many, and all of it in Mail (hub mail/people.ts). */
function MailCard({ mail, list, name }: { mail: NonNullable<P.ProfileView['mail']>; list: string; name: string }) {
  const open = (t: P.MailThreadView) => {
    db.mail.threads.set(t.id, t);
    go({ view: 'mail', thread: t.id });
  };
  return (
    <Card title="Mail" icon="mail" count={mail.total || undefined} class="pf-mail">
      {!mail.threads.length && <p class="pf-empty">No mail with them on this hub.</p>}
      <div class="pf-rows">
        {mail.threads.map((t) => (
          <button class={`pf-row pf-mail-row ${t.unread ? 'unread' : ''}`} onClick={() => open(t)} title={fullTime(t.lastAt)}>
            <NetBadge network="email" size={28} />
            <span class="pf-row-text">
              <b>{t.subject || '(no subject)'}</b>
              <small>
                {senderLine(t)}
                {t.count > 1 ? ` · ${t.count}` : ''}
                {t.preview ? ` — ${t.preview}` : ''}
              </small>
            </span>
            <span class="pf-row-time">{ago(t.lastAt)}</span>
          </button>
        ))}
      </div>
      {mail.total > 0 && (
        <button class="link-btn pf-mail-all" onClick={() => go({ view: 'mail', list })}>
          {mail.total > mail.threads.length ? `All ${mail.total.toLocaleString()} threads with ${name}` : `All mail with ${name}`}
        </button>
      )}
    </Card>
  );
}

export function ProfilePane({ personId, identityId, onBack }: { personId?: string; identityId?: string; onBack: () => void }) {
  rev.value;
  const { profile, abouts, counts, learn, update, asking, refresh } = useProfile(personId, identityId);
  const S = selfParts.value;
  useEffect(() => void loadSelf(), []);
  const [merging, setMerging] = useState(false);
  // The hero's pencil, for a person of one account: its nickname (Nickname.tsx).
  const [naming, setNaming] = useState(false);
  // Links ended from this page (`account|identity`), until the profile is fetched again.
  const [ended, setEnded] = useState<string[]>([]);
  useEffect(() => setEnded([]), [personId, identityId]);
  const [filter, setFilter] = useState('');
  const person = personId ? db.persons.get(personId) : undefined;
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
  const spaces = new Map<string, { s: P.SpaceView; messages: number; nick?: string; roles?: { name: string; color?: string }[] }>();
  for (const a of said)
    for (const m of a.mutualSpaces ?? []) {
      const s = m.spaceId ? db.spaces.get(m.spaceId) : null;
      if (s) spaces.set(s.id, { s, messages: 0, nick: m.nick, roles: m.roles });
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
  const groupChats = convs.filter((x) => x.c.variant !== 'feed' && (x.c.shape === 'group' || (x.c.shape === 'channel' && !x.c.spaceIds.length)));
  const mutualFriends = onePerPerson([...new Set(said.flatMap((a) => a.mutualFriends ?? []))]);
  const friends = onePerPerson([...new Set(said.flatMap((a) => a.friends ?? []))]).filter((iid) => !isSelfIdentity(iid));

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
    .sort((a, b) => b.bio!.length - a.bio!.length);
  const pronouns = said.find((a) => a.pronouns)?.pronouns;
  // The newest heard: an adapter's live status on an identity, else what a profile said. On Signal and WhatsApp the
  // live status is their About, which shows as the bio instead.
  const live = ids
    .filter((i) => i.network !== 'signal' && i.network !== 'whatsapp')
    .map((i) => i.status)
    .filter((x): x is NonNullable<P.IdentityView['status']> => !!(x?.text || x?.emoji))
    .sort((a, b) => b.at - a.at)[0];
  const status = live ?? (said.find((a) => a.status?.text) ?? said.find((a) => a.status?.emoji))?.status;
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
  const facts = said.flatMap((a) => (a.facts ?? []).map((f) => ({ ...f, network: a.network })));
  // A sent request and following show as the buttons that say so (Requests.tsx ConnectActions).
  const relations = said.filter((a) => a.relationship && a.relationship !== 'stranger' && (isSelf || (a.relationship !== 'requested' && a.relationship !== 'following')));

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
      ids.length === 1 && !first?.isBot ? nicknameEntries(first, () => setNaming(true)) : [],
      [!isSelf && { label: 'Merge Another Identity In', icon: 'merge', run: () => setMerging(true) }, { label: 'Ask the Networks Again', icon: 'refresh', run: refresh }],
      // Block or unblock, where an account can (Signal): asked again after, so the page says how you stand.
      isSelf ? [] : (peopleExtras()?.blockEntries(ids, profile.links ?? [], abouts, () => void refresh()) ?? []),
      // Ignore on their networks (ProfileSelf.tsx).
      isSelf || !S ? [] : S.selfEntries(ids, profile, profile.links ?? [], update),
    );
    // What the page already shows as a button is not repeated.
    const shown = new Set(['Profile', 'Message']);
    const items = (base?.items ?? [])
      .filter((e) => !('label' in e && shown.has(e.label as string)))
      .filter((e, i, xs) => e.kind !== 'sep' || (i > 0 && i < xs.length - 1 && xs[i - 1].kind !== 'sep'));
    return { label: `${name} actions`, items: groups(items, extra) };
  };

  // ---- each account: one account is the hero's chip and a row on the right; several are tiles of their own
  const several = ids.length > 1;
  const bioOf = new Map(bios.map((a) => [a.identityId, a.bio!]));
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
        [several && !isSelf && { label: 'Split Into Its Own Person', icon: 'unlink', run: () => void split(i) }],
      ),
    };
  };
  // Grouped by network, in the order the person's accounts first name them.
  const tiles = [...ids].sort((a, b) => nets.indexOf(a.network) - nets.indexOf(b.network));

  const accent = discord?.accent ?? null;
  const banner = discord?.banner ?? null;
  const picture = person?.avatar ?? first?.avatar ?? said.find((a) => a.avatar)?.avatar;

  const hero = (
    <Hero
      id={person?.id ?? first?.id ?? ''}
      name={name}
      picture={picture}
      network={nets.length === 1 ? nets[0] : undefined}
      banner={banner}
      accent={accent}
      title={
        <h1>
          {/* One account: their name is its name, and the pencil gives that account a nickname. */}
          {!several && nicknamable(first) && !first.isBot ? <NicknamedName i={first} label={name} title={first.nickname ? `Your nickname for ${ownName(first)}` : name} editing={naming} setEditing={setNaming} class="pf-name" /> : name}
        </h1>
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
          {[...new Set(relations.map((a) => a.relationship!))].map((rel) => {
            const where = relations.filter((a) => a.relationship === rel).map((a) => a.network);
            return (
              <Tag icon={rel === 'friend' ? 'users' : rel === 'blocked' ? 'x' : 'user'} tone={rel === 'friend' ? 'accent' : rel === 'blocked' ? 'warn' : undefined} title={`${RELATIONSHIP_LABEL[rel]} on ${where.map(netName).join(' and ')}`}>
                {RELATIONSHIP_LABEL[rel]}
                {nets.length > 1 && where.map((n) => <NetGlyph network={n} size={11} />)}
              </Tag>
            );
          })}
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
            {status.emoji && <span class="pf-status-emoji">{status.emoji}</span>}
            {status.text}
          </>
        )
      }
      actions={
        <>
          {!isSelf && messageOptions > 0 && (messageOptions === 1 ? <Action primary icon="send" label="Message" onClick={message} /> : <Action primary icon="send" label="Message" menu={messageMenu} />)}
          {!isSelf && <ConnectActions identities={ids} abouts={abouts} onChanged={learn} />}
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

  const main = (
    <>
      {several && (
        <Card title="Accounts" icon="idBadge" count={ids.length} class="pf-accounts">
          <div class="pf-acct-grid">
            {tiles.map((i) => {
              const r = reach(i);
              return <AccountTile i={i} bio={bioOf.get(i.id)} since={sinceOf.get(i.id)} go={r?.run} goLabel={r?.label} menu={(edit) => accountMenu(i, edit)} />;
            })}
          </div>
          {mergeUi}
        </Card>
      )}
      <Card title="About" icon="info" extra={asking ? <span class="pf-asking">Asking…</span> : undefined}>
        {editable.map(({ i, account }) => (
          <>
            <OwnBio identity={i} about={abouts[i.id]} account={account} label={editable.length + bios.length > 1 || nets.length > 1} onSaved={learn} />
            {extras && <extras.OwnProfileExtras identity={i} about={abouts[i.id]} onSaved={learn} />}
          </>
        ))}
        {isSelf && S && ids.map((i) => <S.OwnProfileFields identity={i} about={abouts[i.id]} onSaved={learn} />)}
        {several ? (
          // Each account's bio is on its tile (Accounts, above).
          !bios.length && !editable.length && !asking && <p class="pf-empty">No bio on any of their accounts.</p>
        ) : bios.length || editable.length ? (
          bios.map((a) => (
            <div class="pf-bio">
              {(bios.length > 1 || nets.length > 1) && (
                <span class="pf-bio-net">
                  <NetGlyph network={a.network} size={11} /> {netName(a.network)}
                </span>
              )}
              <p>{plainBody(a.bio!, a.network)}</p>
            </div>
          ))
        ) : asking ? (
          <Loading inline label="Asking the networks…" />
        ) : (
          <p class="pf-empty" title={nets.map((n) => `${netName(n)}: ${WHAT_NETWORKS_SHARE[n]}`).join('\n')}>
            No bio on {nets.length > 1 ? 'any of their networks' : netName(nets[0])}.
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
        {said.some((a) => a.counts || a.followsYou) && (
          <div class="pf-follow">
            {said
              .filter((a) => a.counts || a.followsYou)
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
                  {a.followsYou && <Tag tone="accent">Follows you</Tag>}
                </span>
              ))}
          </div>
        )}
        <Facts
          rows={[
            ...dedupe([
              ...said.filter((a) => a.createdAt).map((a): [string, string] => [`On ${netName(a.network)} since`, monthYear(a.createdAt!)]),
              ...facts.map((f): [string, string] => [f.label, f.value]),
            ]),
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

      {said.some((a) => a.posts?.length) && (
        <Card title="Recent posts" icon="send" count={said.reduce((n, a) => n + (a.posts?.length ?? 0), 0)} class="pf-posts">
          <RecentPostsLazy abouts={said} />
        </Card>
      )}

      <ActivityCard
        path={changesPath}
        chartPath={chartPath}
        self={isSelf}
        chart={profile.totalMessages > 0 || profile.conversations.length > 0}
        status={status}
        at={live && status === live ? live.at : undefined}
      />

      {(sharedSpaces.length > 0 || groupChats.length > 0) && (
        <Card title={isSelf ? 'Your places' : 'In common'} icon="layers" count={sharedSpaces.length + groupChats.length}>
          {sharedSpaces.length > 0 && (
            <div class="pf-spaces">
              {sharedSpaces.map(({ s, messages, nick, roles }) => {
                const est = counts[s.id]?.observed ? counts[s.id] : undefined;
                return (
                  <button class="pf-space" onClick={() => go({ view: 'space', space: s.id })} title={s.name}>
                    <Avatar id={s.id} name={s.name} url={s.icon} size={40} square network={s.network} />
                    <span class="pf-space-text">
                      <b>{s.name}</b>
                      {(nick || !est) && <small>{nick ? `as ${nick}` : messages ? `${messages.toLocaleString()} message${messages === 1 ? '' : 's'}` : 'member'}</small>}
                      {est && (
                        <small class="pf-msgcount" title={countTitle(est, fullTime)}>
                          {countText(est)}
                        </small>
                      )}
                      {roles && roles.length > 0 && (
                        <span class="pf-roles">
                          {roles.slice(0, 3).map((r) => (
                            <span class="pf-role" style={r.color ? { '--role': r.color } : undefined}>
                              {r.name}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {groupChats.length > 0 && (
            <div class="pf-rows">
              {groupChats.map(({ c, messages, lastTs }) => (
                <button class="pf-row" onClick={() => openConv(c)}>
                  <PlaceIcon c={c} size={28} />
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
          )}
        </Card>
      )}

      {ids
        .filter((i) => i.network === 'signal' && !isSelfIdentity(i.id))
        .map((i) => (
          <Stories identityId={i.id} network={i.network} />
        ))}
      {profile.mail && <MailCard mail={profile.mail} list={withList(person?.id ?? first.id)} name={name} />}

      {(profile.recent.length > 0 || chatNets.length > 0) && (
        <Card title="Recent messages" icon="send" count={profile.recent.length || undefined}>
          {!profile.recent.length && <p class="pf-empty">None stored. The hub only has what your accounts have fetched.</p>}
          <div class="pf-rows">
            {profile.recent.map((m) => {
              const c = db.conversations.get(m.conversationId);
              return (
                <button class="pf-row pf-msg" onClick={() => openMessage(m.conversationId, m.id)} title={fullTime(m.ts)}>
                  {c && c.variant !== 'feed' ? <PlaceIcon c={c} size={28} /> : <NetBadge network={m.network} size={28} />}
                  <span class="pf-row-text">
                    <small class="pf-msg-where">{c ? (c.shape === 'direct' ? `Direct message · ${netName(c.network)}` : c.variant === 'feed' ? `${netName(c.network)} notifications` : convLabel(c)) : 'Unknown'}</small>
                    <span class="pf-msg-body">{m.feed ? feedLine(m.feed, m.body) : plainBody(m.body, m.network) || (m.attachments.length ? 'Attachment' : m.kind === 'encrypted' ? 'Encrypted message' : '')}</span>
                  </span>
                  <span class="pf-row-time">{ago(m.ts)}</span>
                </button>
              );
            })}
          </div>
        </Card>
      )}
      <HistoryCard path={`${changesPath}?except=status,presence`} />
    </>
  );

  const people = (list: string[]) => (
    <div class="pf-people">
      {list.slice(0, 60).map((iid) => {
        const i = db.identities.get(iid);
        const p = i?.personId ? db.persons.get(i.personId) : null;
        const n = p?.name ?? identityName(iid);
        return (
          <button class="pf-person" onClick={() => openProfile(iid)} title={n}>
            <Avatar id={p?.id ?? iid} name={n} url={p?.avatar ?? i?.avatar} size={30} />
            <span>{n}</span>
          </button>
        );
      })}
      {list.length > 60 && <p class="pf-empty">and {list.length - 60} more</p>}
    </div>
  );

  const side = (
    <>
      {isSelf
        ? friends.length > 0 && (
            <Card title="Friends" icon="users" count={friends.length}>
              {people(friends)}
            </Card>
          )
        : mutualFriends.length > 0 && (
            <Card title="Mutual friends" icon="users" count={mutualFriends.length}>
              {people(mutualFriends)}
            </Card>
          )}

      {!isSelf && extras && <extras.SafetyCard abouts={said} name={name} onChanged={learn} />}

      {!isSelf && (
        <ProfileLinksCard
          ids={ids}
          links={(profile.links ?? []).filter((l) => !ended.includes(`${l.accountId}|${l.identityId}`))}
          abouts={Object.fromEntries(Object.entries(abouts).map(([k, a]) => [k, a && ended.includes(`${a.accountId}|${k}`) ? { ...a, relationship: 'stranger' as const } : a]))}
          onEnded={(identityId, accountId) => {
            setEnded((x) => [...x, `${accountId}|${identityId}`]);
            const a = abouts[identityId];
            if (a && a.accountId === accountId) learn({ ...a, relationship: 'stranger' });
          }}
        />
      )}

      {!several && (
        <Card title="Accounts" icon="idBadge">
          {ids.map((i) => {
            const link = externalProfile(i);
            return (
              <div class="pf-identity">
                <NetBadge network={i.network} size={24} />
                <span class="pf-row-text">
                  <b>{identityName(i.id)}</b>
                  <small>
                    {netName(i.network)} · {i.handle ?? i.nativeId}
                    {i.nickname ? ` · their name: ${ownName(i)}` : ''}
                  </small>
                </span>
                {link && (
                  <a class="icon-btn small" href={link} target="_blank" rel="noreferrer" title={`Open on ${netName(i.network)}`}>
                    <Icon name="external" size={14} />
                  </a>
                )}
              </div>
            );
          })}
          {mergeUi}
        </Card>
      )}

      {!isSelf && (
        <Card title="Notifications" icon="bell">
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
              <small>Every message of theirs is an alert, on every network, even in busy groups. A place you muted still stays silent.</small>
            </span>
          </label>
        </Card>
      )}

      <Card title="Note" icon="pencil">
        <textarea class="input pf-note" rows={3} placeholder="Only you see this. It stays on the hub." value={profile.note ?? ''} onChange={(e) => patch({ note: (e.target as HTMLTextAreaElement).value })} />
      </Card>
    </>
  );

  return (
    <ProfilePage title={name} label={`${name}'s profile`} onBack={onBack}>
      {hero}
      {!isSelf && !directs.length && !startable.length && chatNets.length > 0 && (
        <p class="pf-hint pf-banner-note">
          No direct chat yet, and no connected account can start one on {chatNets.map(netName).join(' or ')}. Start it in the network's own app; it appears here once it exists.
        </p>
      )}
      <Columns main={main} side={side} />
    </ProfilePage>
  );
}

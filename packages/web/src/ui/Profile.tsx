/** A person: merged identities with their sources, and everything the hub has stored about them. */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago, fullTime } from '../format.ts';
import { openers } from '../direct.ts';
import { communitiesOf, convLabel, convTitle, directsOf, identityName, kindLabel, netName, plainBody, rootCommunity } from '../model.ts';
import { api, db, go, newMessage, openMessage, rev, setRule, toast } from '../state.ts';
import { Avatar, Empty, NetBadge, NetGlyph, Skeleton } from './bits.tsx';
import { Icon } from './icons.tsx';
import { openConv } from './Sidebar.tsx';

/** What each network tells us, so an empty section is not mistaken for an empty person. */
const WHAT_NETWORKS_SHARE: Record<P.Network, string> = {
  discord: 'Name, handle and avatar. Bio, roles and mutual servers are not fetched: no adapter command does that yet.',
  signal: 'Profile name and avatar from your contacts. Signal has no public profile or directory to ask.',
  matrix: 'Display name and avatar, which is all a Matrix profile holds.',
  whatsapp: 'The name in your phone’s address book, else the name they chose, their number and profile picture. About and status are not fetched.',
};

function externalProfile(i: P.IdentityView): string | null {
  if (i.network === 'discord') return /^\d+$/.test(i.nativeId) ? `https://discord.com/users/${i.nativeId}` : null;
  if (i.network === 'matrix') return `https://matrix.to/#/${encodeURIComponent(i.nativeId)}`;
  if (i.network === 'whatsapp') return /^\+\d{6,}$/.test(i.handle ?? '') ? `https://wa.me/${i.handle!.slice(1)}` : null;
  return null;
}

function normalized(s: string | null | undefined) {
  return (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function ProfilePane({ personId, identityId, onBack }: { personId?: string; identityId?: string; onBack: () => void }) {
  const r = rev.value;
  const [profile, setProfile] = useState<P.ProfileView | null | 'none'>(null);
  const [merging, setMerging] = useState(false);
  const [filter, setFilter] = useState('');
  const person = personId ? db.persons.get(personId) : undefined;
  const signature = person ? `${person.identityIds.join()}|${person.name}` : identityId;
  useEffect(() => {
    let live = true;
    api<P.ProfileView>(personId ? `/api/persons/${personId}/profile` : `/api/identities/${identityId}/profile`)
      .then((p) => {
        if (!live) return;
        [...p.identities, ...p.mentioned].forEach((i) => db.identities.set(i.id, i));
        setProfile(p);
      })
      .catch(() => live && setProfile('none'));
    return () => {
      live = false;
    };
  }, [personId, identityId, signature]);

  const head = (title: string) => (
    <header class="conv-head">
      <button class="icon-btn back-btn profile-back" onClick={onBack} aria-label="Back">
        <Icon name="back" />
      </button>
      <div class="conv-head-text">
        <h2>{title}</h2>
      </div>
    </header>
  );
  if (profile === 'none') return <section class="pane">{head('Profile')}<Empty icon="user" title="Nobody by that id" /></section>;
  if (!profile) return <section class="pane">{head('Profile')}<Skeleton rows={4} /></section>;

  const ids = (person ? person.identityIds : profile.identityIds).map((id) => db.identities.get(id)).filter((i): i is P.IdentityView => !!i);
  const first = ids[0];
  const name = person?.name ?? identityName(first?.id);
  const isSelf = !!person?.isSelf;
  const directs = person ? directsOf(person.id) : [];
  const nets = [...new Set(ids.map((i) => i.network))];
  const accounts = [...db.accounts.values()];
  // One way in per network they are on and you have no DM on. A network whose adapter cannot do it shows nothing.
  const startable = isSelf ? [] : nets.filter((n) => !directs.some((d) => d.network === n)).map((n) => ids.find((i) => i.network === n)!).filter((i) => openers(accounts, i.network).length > 0);
  const rule = person ? db.rules.find((x) => x.scope === 'person' && x.target === person.id) : undefined;

  /** Person actions need a Person; someone seen only in a channel gets one the first time you act. */
  const ensure = async () => {
    if (person) return person.id;
    const { personId: pid } = await api<{ personId: string }>(`/api/identities/${first.id}/person`, { body: {} });
    go({ view: 'profile', person: pid }, true);
    return pid;
  };
  const patch = async (body: Record<string, unknown>) => {
    const pid = await ensure();
    await api(`/api/persons/${pid}`, { method: 'PATCH', body });
  };

  const convs = profile.conversations.map((x) => ({ ...x, c: db.conversations.get(x.id) })).filter((x): x is typeof x & { c: P.ConversationView } => !!x.c);
  const spaces = new Map<string, { s: P.SpaceView; messages: number }>();
  for (const x of convs) {
    for (const com of communitiesOf(x.c)) {
      const root = rootCommunity(com.id) ?? com;
      const cur = spaces.get(root.id) ?? { s: root, messages: 0 };
      cur.messages += x.messages;
      spaces.set(root.id, cur);
    }
  }
  const groupChats = convs.filter((x) => x.c.shape === 'group' || (x.c.shape === 'channel' && !x.c.spaceIds.length));

  const candidates = [...db.persons.values()].filter((x) => x.id !== person?.id && !x.isSelf);
  const myNames = new Set(ids.flatMap((i) => [normalized(i.displayName), normalized(i.handle)]).concat(normalized(name)).filter(Boolean));
  const similar = candidates.filter((x) => myNames.has(normalized(x.name)) || x.identityIds.some((id) => { const i = db.identities.get(id); return myNames.has(normalized(i?.displayName)) || myNames.has(normalized(i?.handle)); }));
  const needle = filter.trim().toLowerCase();
  const matches = needle ? candidates.filter((x) => x.name.toLowerCase().includes(needle)).slice(0, 12) : similar;
  const merge = async (from: string) => {
    const into = await ensure();
    await api('/api/persons/merge', { body: { into, from } });
    setMerging(false);
    setFilter('');
    toast({ kind: 'info', title: 'Merged', body: 'They now count as one person, on this hub only.' });
  };

  return (
    <section class="pane profile" data-rev={r}>
      {head(name)}
      <div class="settings-scroll profile-scroll">
        <section class="profile-top">
          <Avatar id={person?.id ?? first?.id ?? ''} name={name} url={person?.avatar ?? first?.avatar} size={84} />
          <div class="profile-top-text">
            <h2>
              {name}
              {person?.starred && <Icon name="star" size={16} class="row-star" />}
            </h2>
            <span class="profile-nets">
              {nets.map((n) => (
                <span class="source-chip"><NetGlyph network={n} size={11} /> {netName(n)}</span>
              ))}
              {first?.isBot && <span class="bot-tag">BOT</span>}
              {isSelf && <span class="bot-tag">YOU</span>}
            </span>
            <small>
              {profile.totalMessages} message{profile.totalMessages === 1 ? '' : 's'} stored
              {profile.firstSeenTs ? ` since ${new Date(profile.firstSeenTs).toLocaleDateString()}` : ''}
            </small>
          </div>
        </section>

        {!isSelf && (
          <div class="btn-row profile-actions">
            {directs.map((d) => (
              <button class="btn small" onClick={() => go({ view: 'inbox', conv: d.id })}>
                <Icon name="send" size={13} /> Message on {netName(d.network)}
              </button>
            ))}
            {startable.map((i) => (
              <button class="btn small" onClick={() => (newMessage.value = { identityId: i.id })}>
                <Icon name="send" size={13} /> Message on {netName(i.network)}
              </button>
            ))}
            {directs.length > 1 && person && (
              <button class="btn ghost small" onClick={() => go({ view: 'people', person: person.id })}>
                <Icon name="merge" size={13} /> Merged thread
              </button>
            )}
            <button class={`btn ghost small ${person?.starred ? 'on' : ''}`} onClick={() => patch({ starred: !person?.starred })}>
              <Icon name="star" size={13} /> {person?.starred ? 'Starred' : 'Star'}
            </button>
          </div>
        )}
        {!isSelf && !directs.length && !startable.length && (
          <p class="set-help">No direct chat yet, and no connected account can start one on {nets.map(netName).join(' or ')}. Start it in the network's own app, or reconnect the account. It appears here once it exists.</p>
        )}

        <section class="set-block">
          <h3>Identities</h3>
          {ids.map((i) => {
            const link = externalProfile(i);
            return (
              <div class="identity">
                <NetBadge network={i.network} size={22} />
                <span>
                  <b>{i.displayName ?? i.handle ?? i.nativeId}</b>
                  <small>
                    {netName(i.network)} · {i.handle ?? i.nativeId}
                  </small>
                </span>
                {link && (
                  <a class="icon-btn small" href={link} target="_blank" rel="noreferrer" title={`Open on ${netName(i.network)}`}>
                    <Icon name="external" size={14} />
                  </a>
                )}
                {ids.length > 1 && !isSelf && (
                  <button
                    class="icon-btn small"
                    title="Unmerge: split this identity into its own person"
                    onClick={() => api(`/api/identities/${i.id}/split`, { body: {} }).then(() => toast({ kind: 'info', title: 'Split', body: `${i.displayName ?? i.handle ?? 'That identity'} is its own person again.` }))}
                  >
                    <Icon name="unlink" size={14} />
                  </button>
                )}
              </div>
            );
          })}
          {!isSelf && similar.length > 0 && !merging && (
            <p class="set-help">
              Same name elsewhere: {similar.slice(0, 3).map((x) => x.name).join(', ')}. That is only a hint, and nothing merges unless you do it.
            </p>
          )}
          {!isSelf &&
            (merging ? (
              <div class="merge-box">
                <input class="input" placeholder="Search people to merge in" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
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
                {needle && !matches.length && <p class="set-help">Nobody by that name.</p>}
              </div>
            ) : (
              <button class="btn ghost small" onClick={() => setMerging(true)}>
                <Icon name="merge" size={13} /> Merge another identity in
              </button>
            ))}
        </section>

        {!isSelf && (
          <section class="set-block">
            <h3>Notifications</h3>
            <label class="toggle-row">
              <input type="checkbox" checked={!!person?.starred} onChange={(e) => patch({ starred: (e.target as HTMLInputElement).checked })} />
              <span>
                <b>Star</b>
                <small>Always push messages from them, on every network, even in busy groups.</small>
              </span>
            </label>
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
                <b>Always notify, without starring</b>
                <small>The same push, for someone you would rather not list as starred. A place set to Off still stays silent.</small>
              </span>
            </label>
          </section>
        )}

        <section class="set-block">
          <h3>Note</h3>
          <textarea class="input profile-note" rows={2} placeholder="Only you see this. It stays on the hub." value={profile.note ?? ''} onChange={(e) => patch({ note: (e.target as HTMLTextAreaElement).value })} />
        </section>

        {spaces.size > 0 && (
          <section class="set-block">
            <h3>Shared communities ({spaces.size})</h3>
            {[...spaces.values()].map(({ s, messages }) => (
              <button class="link-row" onClick={() => go({ view: 'space', space: s.id })}>
                <Avatar id={s.id} name={s.name} url={s.icon} size={22} square /> <NetGlyph network={s.network} size={12} /> {s.name}
                <small>{messages ? `${messages} messages` : 'member'}</small>
              </button>
            ))}
          </section>
        )}
        {groupChats.length > 0 && (
          <section class="set-block">
            <h3>Shared groups ({groupChats.length})</h3>
            {groupChats.map(({ c, messages }) => (
              <button class="link-row" onClick={() => openConv(c)}>
                <NetGlyph network={c.network} size={12} /> {convTitle(c)} <small>{kindLabel(c)}{messages ? ` · ${messages} messages` : ''}</small>
              </button>
            ))}
          </section>
        )}

        <section class="set-block">
          <h3>Recent messages</h3>
          {!profile.recent.length && <p class="set-help">None stored. The hub only has what your accounts have fetched.</p>}
          {profile.recent.map((m) => {
            const c = db.conversations.get(m.conversationId);
            return (
              <button class="profile-msg" onClick={() => openMessage(m.conversationId, m.id)} title={fullTime(m.ts)}>
                <span class="profile-msg-where">
                  <NetGlyph network={m.network} size={11} /> {c ? (c.shape === 'direct' ? 'Direct message' : convLabel(c)) : 'Unknown'} · {ago(m.ts)}
                </span>
                <span class="profile-msg-body">{plainBody(m.body, m.network) || (m.attachments.length ? 'Attachment' : m.kind === 'encrypted' ? 'Encrypted message' : '')}</span>
              </button>
            );
          })}
        </section>

        <section class="set-block">
          <h3>What this is based on</h3>
          {nets.map((n) => (
            <p class="set-help"><b>{netName(n)}:</b> {WHAT_NETWORKS_SHARE[n]}</p>
          ))}
          <p class="set-help">Shared communities come from messages and member lists the hub has stored. Big servers do not list every member, so this can undercount.</p>
        </section>
      </div>
    </section>
  );
}

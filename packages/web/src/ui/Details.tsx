import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { LEVEL_LABEL, communitiesOf, convLabel, convTitle, deepLink, directsOf, effectiveLevel, identityName, kindLabel, netName, placeConv, threadsOf } from '../model.ts';
import { api, db, go, isSelfIdentity, openProfile, prefs, rev, setRule } from '../state.ts';
import { AccountChip, Avatar, NetBadge, NetGlyph, levelIcon } from './bits.tsx';
import { Icon } from './icons.tsx';
import { showDetails } from './Pager.ts';
import { openConv } from './Sidebar.tsx';
import { Menuable } from './ContextMenu.tsx';
import { identityMenu } from './menus.tsx';
import { openAbout } from './About.tsx';

function Section({ title, children }: { title: string; children: any }) {
  return (
    <section class="det-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      class="native-id"
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      <code>{text}</code>
      <Icon name={done ? 'check' : 'link'} size={12} />
    </button>
  );
}

const ORDER = ['this conversation', 'thread parent', 'section', 'server / space', 'account', 'network', 'global', 'default for its shape'];

export function ConversationDetails({ convId }: { convId: string }) {
  rev.value;
  const c = db.conversations.get(convId);
  if (!c) return null;
  const eff = effectiveLevel(c);
  const base = placeConv(c);
  const coms = communitiesOf(c);
  const link = deepLink(c);
  const parts = c.participantIds.map((id) => db.identities.get(id)).filter((i): i is P.IdentityView => !!i);
  const threads = threadsOf(c.id);
  return (
    <aside class="details">
      <header class="det-head">
        <span class="det-net" style={{ '--net': NETWORK_META[c.network].color } as any}>
          <NetBadge network={c.network} size={28} />
        </span>
        <div>
          <h2>{convLabel(c)}</h2>
          <span class="det-kind">{kindLabel(c)}</span>
        </div>
        <button class="icon-btn" onClick={() => showDetails(false)} aria-label="Close details">
          <Icon name="x" />
        </button>
      </header>
      <div class="det-scroll">
        <button class="btn ghost small det-about" onClick={() => openAbout('conversation', c.id)}>
          <Icon name="info" size={13} /> About and settings
        </button>
        {c.shape === 'direct' && c.peerPersonId && (
          <div class="btn-row phone-only">
            <button class="btn ghost small" onClick={() => go({ view: 'profile', person: c.peerPersonId! })}>
              <Icon name="info" size={13} /> Profile
            </button>
            <button class="btn ghost small" onClick={() => go({ view: 'people', person: c.peerPersonId! })}>
              <Icon name="user" size={13} /> All chats with them
            </button>
          </div>
        )}
        <Section title="Source">
          <dl class="kv">
            <dt>Network</dt>
            <dd>
              <NetGlyph network={c.network} size={12} /> {netName(c.network)}
              {c.encrypted && (
                <span class="det-e2ee">
                  <Icon name="lock" size={11} /> end-to-end encrypted
                </span>
              )}
            </dd>
            <dt>Seen through</dt>
            <dd class="det-accs">
              {c.vantages.map((v) => {
                const a = db.accounts.get(v.accountId);
                return a ? (
                  <span class="det-acc">
                    <AccountChip account={a} small />
                    <span class={`status-dot ${a.status}`} title={a.status} />
                    {v.unread > 0 && <small>{v.unread} unread</small>}
                  </span>
                ) : null;
              })}
            </dd>
            {coms.length > 0 && (
              <>
                <dt>{coms.length > 1 ? 'In spaces' : NETWORK_META[c.network].spaceNoun === 'server' ? 'Server' : 'Space'}</dt>
                <dd>
                  {coms.map((s) => (
                    <button class="link-btn" onClick={() => go({ view: 'space', space: s.id })}>
                      {s.name}
                    </button>
                  ))}
                  {base.spaceIds.length > 1 && <small class="det-note">This room is listed in {base.spaceIds.length} spaces; Matrix containment is a graph, not a tree.</small>}
                </dd>
              </>
            )}
            {base !== c && (
              <>
                <dt>Thread of</dt>
                <dd>
                  <button class="link-btn" onClick={() => openConv(base)}>
                    {convLabel(base)}
                  </button>
                </dd>
              </>
            )}
            <dt>Native id</dt>
            <dd>
              <Copyable text={c.nativeId} />
            </dd>
          </dl>
          {link && (
            <a class="btn ghost small" href={link} target="_blank" rel="noreferrer">
              <Icon name="external" size={13} /> Open in {c.network === 'discord' ? 'Discord' : 'Element (matrix.to)'}
            </a>
          )}
        </Section>

        <Section title="Notifications">
          <div class={`det-level ${eff.level}`}>
            <Icon name={levelIcon(eff.level)} size={18} />
            <div>
              <b>{LEVEL_LABEL[eff.level]}</b>
              <small>{eff.explicit ? `Set on ${eff.source}` : `Inherited: ${eff.source}`}</small>
            </div>
          </div>
          <div class="level-row">
            {(['all', 'smart', 'mentions', 'digest', 'none'] as const).map((l) => (
              <button class={`chip-btn ${eff.level === l && eff.scope === 'conversation' ? 'on' : ''}`} onClick={() => setRule('conversation', c.id, l)} title={LEVEL_LABEL[l]}>
                <Icon name={levelIcon(l)} size={13} /> {LEVEL_LABEL[l]}
              </button>
            ))}
            {eff.scope === 'conversation' && (
              <button class="chip-btn" onClick={() => setRule('conversation', c.id, null)}>
                Inherit
              </button>
            )}
          </div>
          <details class="det-order">
            <summary>How the level is chosen</summary>
            <ol>
              {ORDER.map((o) => (
                <li>{o}</li>
              ))}
            </ol>
            <p>The most specific rule wins. A mute set in the native app caps inherited levels at Digest. People set to always notify, and keywords, can still push.</p>
          </details>
        </Section>

        {parts.length > 0 && (
          <Section title={c.shape === 'direct' ? 'Person' : `Members (${parts.length})`}>
            <div class="members">
              {parts.map((i) => {
                const p = i.personId ? db.persons.get(i.personId) : null;
                const self = isSelfIdentity(i.id);
                return (
                  <Menuable build={() => identityMenu(i.id)}>{(ctx) => <button class="member" onClick={() => openProfile(i.id)} {...ctx}>
                    <Avatar id={p?.id ?? i.id} name={p?.name ?? identityName(i.id)} url={p?.avatar ?? i.avatar} size={28} />
                    <span>
                      <b>{self ? 'You' : (p?.name ?? identityName(i.id))}</b>
                      <small>{i.handle ?? i.nativeId}</small>
                    </span>
                    {p && !self && p.identityIds.length > 1 && (
                      <span class="member-nets" title="Also reachable on">
                        {[...new Set(p.identityIds.map((x) => db.identities.get(x)?.network).filter(Boolean))].map((n) => (
                          <NetBadge network={n as P.Network} size={13} />
                        ))}
                      </span>
                    )}
                  </button>}</Menuable>
                );
              })}
            </div>
          </Section>
        )}

        {threads.length > 0 && (
          <Section title={c.variant === 'forum' ? `Posts (${threads.length})` : `Threads (${threads.length})`}>
            {threads.map((t) => (
              <button class="link-row" onClick={() => openConv(t)}>
                <Icon name="thread" size={13} /> {convTitle(t)}
              </button>
            ))}
          </Section>
        )}
      </div>
    </aside>
  );
}

export function PersonDetails({ personId }: { personId: string }) {
  rev.value;
  const p = db.persons.get(personId);
  const [merging, setMerging] = useState(false);
  if (!p) return null;
  const directs = directsOf(p.id);
  const ids = p.identityIds.map((id) => db.identities.get(id)).filter((i): i is P.IdentityView => !!i);
  const always = db.rules.some((r) => r.scope === 'person' && r.target === p.id && r.level === 'all');
  const others = [...db.persons.values()].filter((x) => x.id !== p.id && !x.isSelf).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <aside class="details">
      <header class="det-head">
        <Avatar id={p.id} name={p.name} url={p.avatar} size={40} />
        <div>
          <h2>{p.name}</h2>
          <span class="det-kind">
            Person · {ids.length} {ids.length === 1 ? 'identity' : 'identities'}
          </span>
        </div>
        <button class="icon-btn" onClick={() => showDetails(false)} aria-label="Close details">
          <Icon name="x" />
        </button>
      </header>
      <div class="det-scroll">
        <button class="btn ghost small" onClick={() => go({ view: 'profile', person: p.id })}>
          <Icon name="user" size={13} /> Full profile
        </button>
        <Section title="Identities">
          <p class="det-note">A person is hub-only: it joins identities you know are the same human. Networks never see it.</p>
          {ids.map((i) => (
            <div class="identity">
              <NetBadge network={i.network} size={22} />
              <span>
                <b>{i.displayName ?? i.handle}</b>
                <small>
                  {netName(i.network)} · {i.handle ?? i.nativeId}
                </small>
              </span>
              {ids.length > 1 && (
                <button class="icon-btn small" title="Split this identity into its own person" onClick={() => api(`/api/identities/${i.id}/split`, { body: {} })}>
                  <Icon name="unlink" size={14} />
                </button>
              )}
            </div>
          ))}
          {merging ? (
            <select
              class="select"
              onChange={(e) => {
                const from = (e.target as HTMLSelectElement).value;
                if (from) api('/api/persons/merge', { body: { into: p.id, from } }).then(() => setMerging(false));
              }}
            >
              <option value="">Merge which person into {p.name}?</option>
              {others.map((o) => (
                <option value={o.id}>
                  {o.name} ({o.identityIds.map((x) => db.identities.get(x)?.network).filter(Boolean).join(', ')})
                </option>
              ))}
            </select>
          ) : (
            <button class="btn ghost small" onClick={() => setMerging(true)}>
              <Icon name="merge" size={13} /> Merge another identity in
            </button>
          )}
        </Section>
        <Section title="Notifications">
          <label class="toggle-row">
            <input
              type="checkbox"
              checked={always}
              onChange={(e) => setRule('person', p.id, (e.target as HTMLInputElement).checked ? 'all' : null)}
            />
            <span>
              <b>Always notify</b>
              <small>Push messages from {p.name}, on every network, even in busy groups.</small>
            </span>
          </label>
        </Section>
        <Section title={`Chats (${directs.length})`}>
          {directs.map((d) => (
            <button class="link-row" onClick={() => go({ view: 'inbox', conv: d.id })}>
              <NetGlyph network={d.network} size={12} /> {kindLabel(d)}
              {d.vantages.map((v) => {
                const a = db.accounts.get(v.accountId);
                return a && prefs.value ? <AccountChip account={a} small /> : null;
              })}
            </button>
          ))}
        </Section>
      </div>
    </aside>
  );
}

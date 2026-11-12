/**
 * A conversation's or a space's profile (docs/profile.md, docs/group-settings.md): the same frame as a person's
 * (ProfileShell.tsx). What it is and its description, its settings, pins and members on the left; how you are there
 * (whose view, notifications, the invite link, who may do what, the details) on the right. Everything editable only
 * where the network says your account may, with the reason where it may not.
 */
import type * as P from '@dither-chat/protocol';
import { ABOUT_LABEL, ABOUT_RULES, NETWORK_META, RULE_LABEL, RULE_LEVELS } from '@dither-chat/protocol';
import { fullTime } from '../format.ts';
import { AUTOMATIC, convTitle, deepLink, effectiveLevel, heldHere, netName, OLDER_RULE, ruleHelp, ruleOn, unreadOf } from '../model.ts';
import { db, go, href, isSelfIdentity, markRead, openMessage, rev, setRule } from '../state.ts';
import { AccountChip, Empty, variantIcon } from './bits.tsx';
import { copy } from './ContextMenu.tsx';
import { EditableText, InviteSection, MembersSection, PinnedSection, RulesList, SettingRow, settingKeys, useAbout, valueText, type AboutTarget } from './About.tsx';
import { openPalette } from './Palette.tsx';
import { HistoryCard } from './HistoryCard.tsx';
import { retention, setShowIn } from '../history.ts';
import { Icon } from './icons.tsx';
import { conversationMenu, spaceMenu } from './menus.tsx';
import { placeConvs } from './Organize.tsx';
import { Action, Card, Columns, Facts, Hero, ProfilePage, Tag } from './ProfileShell.tsx';
import { openConv } from './Sidebar.tsx';
import { Loading } from './Loader.tsx';
import { canIndex, startIndexing } from './Indexing.tsx';

/** "Seen 12 of 1,287 listed (1%) · 214 online": honest about how little that may be. */
export function coverageText(c: P.MemberCoverageView): string {
  const seen = c.seen.toLocaleString();
  if (!c.total) return c.seen ? `Seen ${seen}; no member count from the network yet` : 'None seen yet';
  const f = c.fraction ?? 0;
  const pct = f > 0 && f < 0.01 ? 'under 1%' : `${Math.round(f * 100)}%`;
  return `Seen ${seen} of ${c.total.toLocaleString()} listed (${pct})${c.online != null ? ` · ${c.online.toLocaleString()} online when counted` : ''}`;
}

export function PlaceProfile({ kind, id, onBack }: { kind: AboutTarget['kind']; id: string; onBack: () => void }) {
  rev.value;
  const conv = kind === 'conversation' ? db.conversations.get(id) : undefined;
  const space = kind === 'space' ? db.spaces.get(id) : undefined;
  const { view, error, busy, as, setAs, change, replace } = useAbout({ kind, id });
  // Add people (docs/group-settings.md): the palette's picker for this group, as the account this page is seen as.
  const addPeople = () => view && kind === 'conversation' && openPalette({ kind: 'add', conversationId: id, accountId: view.accountId, adding: view.adding, onDone: replace });
  const network = (conv ?? space)?.network;
  if (!network)
    return (
      <ProfilePage title="About" label="About" onBack={onBack}>
        <Empty icon="info" title="Nothing by that id" />
      </ProfilePage>
    );

  const title = conv ? convTitle(conv) : space!.name;
  const noun = view?.noun ?? (space ? (space.kind === 'section' ? NETWORK_META[network].sectionNoun : NETWORK_META[network].spaceNoun) : conv!.shape === 'direct' ? 'Chat' : 'Conversation');
  const f = view?.fields ?? {};
  const keys = settingKeys(network, kind, f);
  const picture = (f.avatar?.value as string | null | undefined) ?? conv?.avatar ?? space?.icon ?? null;
  const accountIds = conv ? conv.vantages.map((v) => v.accountId) : (space?.accountIds ?? []);
  const members = view?.members ? (view.members.total ?? view.members.list.length) : (conv?.participantIds.length ?? 0);
  const peer = conv?.shape === 'direct' && conv.peerPersonId ? db.persons.get(conv.peerPersonId) : null;
  const children = space ? placeConvs('space', space.id) : [];
  const link = conv ? (deepLink(conv) ?? `${location.origin}${location.pathname}${href({ view: 'inbox', conv: conv.id })}`) : space?.network === 'discord' ? `https://discord.com/channels/${space.nativeId}` : space?.network === 'matrix' ? `https://matrix.to/#/${encodeURIComponent(space.nativeId)}` : null;
  const ruleOf = ruleOn(kind, id);
  const eff = conv ? effectiveLevel(conv) : null;
  const unread = conv ? unreadOf(conv).unread : 0;
  // A section is a community's category: the community is what gets indexed.
  const indexable = space?.kind !== 'section' && conv?.shape !== 'self' && canIndex(kind, id);

  const hero = (
    <Hero
      id={id}
      name={title}
      picture={picture}
      square={conv?.shape !== 'direct'}
      network={network}
      title={<EditableText setting={f.name} fallback={title} label="Name" busy={busy === 'name'} big onSave={(v) => change({ key: 'name', value: v }, 'Name changed')} max={ABOUT_RULES[network].nameMax} />}
      sub={
        <span class="pf-kind">
          {netName(network)} {noun.toLowerCase()}
          {members > 0 && ` · ${members.toLocaleString()} member${members === 1 ? '' : 's'}`}
          {space && children.length > 0 && ` · ${children.length} channel${children.length === 1 ? '' : 's'}`}
        </span>
      }
      tags={
        <>
          {(conv?.encrypted || f.encrypted?.value === true) && <Tag icon="lock">End-to-end encrypted</Tag>}
          {f.nsfw?.value === true && <Tag tone="warn">Age-restricted</Tag>}
          {f.announceOnly?.value === true && <Tag>Only admins send</Tag>}
          {view?.you?.role && <Tag tone="accent">You: {view.you.role}</Tag>}
          {ruleOf === 'none' && <Tag icon="bellOff" tone="muted">Muted</Tag>}
        </>
      }
      actions={
        <>
          {conv && <Action primary icon="send" label={conv.shape === 'direct' ? 'Open chat' : 'Open'} onClick={() => openConv(conv)} />}
          {space && <Action primary icon="layers" label={`Open ${noun.toLowerCase()}`} onClick={() => go({ view: 'space', space: space.id })} />}
          {peer && <Action icon="user" label="Their profile" onClick={() => go({ view: 'profile', person: peer.id })} />}
          {conv && view?.adding?.can && <Action icon="userPlus" label={view.adding.mode === 'invite' ? 'Invite people' : 'Add people'} onClick={addPeople} />}
          {conv && unread > 0 && <Action icon="check" label="Mark read" onClick={() => markRead(conv.id)} />}
          <Action icon={ruleOf === 'none' ? 'bell' : 'bellOff'} label={ruleOf === 'none' ? 'Unmute' : 'Mute'} onClick={() => setRule(kind, id, ruleOf === 'none' ? null : 'none')} />
          {conv && <Action icon="search" label="Search" onClick={() => go({ view: 'search', q: `in:${conv.id}` })} />}
          {link && <Action icon="link" label="Copy link" onClick={() => copy(link, 'Link copied')} />}
          {indexable && <Action icon="archive" label="Index…" kind="index" title={`Index this ${noun.toLowerCase()}: its whole history, and its members`} onClick={() => startIndexing(kind, id)} />}
          <Action icon="more" label="More" menu={() => (conv ? conversationMenu(conv) : spaceMenu(space!))} />
        </>
      }
    />
  );

  const main = (
    <>
      <Card title="About" icon="info">
        {f.topic || view === null ? (
          <EditableText setting={f.topic} fallback={conv?.topic ?? space?.topic ?? ''} label="Description" multiline busy={busy === 'topic'} onSave={(v) => change({ key: 'topic', value: v }, 'Description changed')} max={ABOUT_RULES[network].topicMax} />
        ) : (
          <p class="pf-empty">{conv?.topic ?? space?.topic ?? `${netName(network)} keeps no description for this ${noun.toLowerCase()}.`}</p>
        )}
        {error && <p class="about-error">{error}</p>}
        {!view && !error && <Loading inline label={`Asking ${netName(network)}…`} />}
        {view?.stale && (
          <p class="pf-stale">
            <Icon name="alert" size={12} /> {view.stale}
          </p>
        )}
        <Facts rows={(view?.facts ?? []).map((x): [string, string] => [x.label, x.value])} />
      </Card>

      {view && keys.length > 0 && (
        <Card title="Settings" icon="settings" class="pf-settings">
          {keys.map((k) => (
            <SettingRow network={network} k={k} s={f[k]!} busy={busy === k} onChange={(v) => change({ key: k, value: v } as P.AboutChange, `${ABOUT_LABEL[k]}: ${valueText(k, v)}`)} />
          ))}
        </Card>
      )}

      {view?.pinned && (view.pinned.messages.length + view.pinned.missing > 0 || view.pinned.canEdit) && (
        <div class="pf-card pf-embed">
          <PinnedSection p={view.pinned} network={network} onOpen={(m) => openMessage(m.conversationId, m.id)} onUnpin={(m) => change({ key: 'pin', message: m.nativeId, remove: true }, 'Unpinned')} />
        </div>
      )}

      {space && children.length > 0 && (
        <Card title="Channels" icon="hash" count={children.length}>
          <div class="pf-rows">
            {children
              .slice()
              .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
              .slice(0, 12)
              .map((c) => (
                <button class="pf-row" onClick={() => openConv(c)}>
                  <span class="pf-chan-icon">
                    <Icon name={variantIcon(c.variant, c.shape)} size={16} />
                  </span>
                  <span class="pf-row-text">
                    <b>{convTitle(c)}</b>
                    {c.topic && <small>{c.topic}</small>}
                  </span>
                </button>
              ))}
          </div>
        </Card>
      )}

      {view?.members && (
        <div class="pf-card pf-embed">
          <MembersSection m={view.members} adding={view.adding} onAdd={addPeople} />
        </div>
      )}
      <HistoryCard path={`/api/${kind === 'space' ? 'spaces' : 'conversations'}/${id}/changes`} network={network} />
    </>
  );

  const side = (
    <>
      {accountIds.length > 1 && (
        <Card title="Seen as" icon="eye">
          <div class="about-as" role="radiogroup" aria-label="Whose view">
            {accountIds.map((aid) => {
              const a = db.accounts.get(aid);
              return a ? (
                <button class={`chip-btn ${(view?.accountId ?? as) === aid ? 'on' : ''}`} role="radio" aria-checked={(view?.accountId ?? as) === aid} onClick={() => setAs(aid)}>
                  <AccountChip account={a} small />
                </button>
              ) : null;
            })}
          </div>
          <p class="pf-hint">Each account may see and change different things here.</p>
        </Card>
      )}

      <Card title="Notifications" icon="bell">
        <label class="pf-level">
          <select class="select" value={ruleOf ?? ''} onChange={(e) => setRule(kind, id, ((e.target as HTMLSelectElement).value || null) as P.RuleLevel | null)}>
            {/* A rule from before the tiers: shown as what is set, and any of the others replaces it. */}
            {ruleOf === 'mentions' && (
              <option value="mentions" disabled>
                {OLDER_RULE}
              </option>
            )}
            <option value="">{AUTOMATIC}</option>
            {RULE_LEVELS.map((l) => (
              <option value={l}>{RULE_LABEL[l]}</option>
            ))}
          </select>
        </label>
        <p class="pf-hint">
          {ruleHelp(ruleOf)}.{!ruleOf && eff ? ` Now: ${heldHere(eff)}.` : ''}
        </p>
      </Card>

      {conv && retention.value.adversarial && <KeptHere conversationId={conv.id} />}

      {view?.invite && (
        <div class="pf-card pf-embed">
          <InviteSection inv={view.invite} busy={busy === 'invite'} onChange={(op) => change({ key: 'invite', op }, op === 'create' ? 'New invite link made' : 'Invite link turned off')} />
        </div>
      )}

      {view?.coverage && (
        <Card title="Members seen" icon="users">
          <p>{coverageText(view.coverage)}</p>
          <p class="pf-hint">
            Only those your accounts' clients loaded on their own: message authors and the member list as it showed. Never everyone
            {view.coverage.total ? `, and ${netName(network)} lists at most part of a big server` : ''}.
            {view.coverage.lastSeenAt ? ` Last seen ${fullTime(view.coverage.lastSeenAt)}.` : ''}
          </p>
        </Card>
      )}

      {view?.rules && view.rules.length > 0 && (
        <Card title="Who can do what" icon="lock">
          <RulesList rules={view.rules} />
        </Card>
      )}

      <Card title="Details" icon="idBadge">
        <Facts
          rows={[
            !!view?.you?.role && ['You are', view.you.role],
            !!view?.accountId && !!db.accounts.get(view.accountId) && ['Seen as', <AccountChip account={db.accounts.get(view.accountId)!} small />],
            conv && conv.shape === 'direct' && peer && ['With', peer.name],
            [
              `${noun} ID`,
              <button class="pf-copy" onClick={() => copy((conv ?? space)!.nativeId, 'ID copied')} title="Copy">
                <code>{(conv ?? space)!.nativeId}</code>
                <Icon name="copy" size={11} />
              </button>,
            ],
            view && ['As of', fullTime(view.fetchedAt)],
          ]}
        />
      </Card>
    </>
  );

  // Your own messages make a self chat; nothing else here applies to it.
  const selfChat = conv?.shape === 'self' || (conv?.shape === 'direct' && conv.participantIds.every(isSelfIdentity));
  return (
    <ProfilePage title={title} label={`About ${title}`} onBack={onBack}>
      {hero}
      <Columns main={main} side={selfChat ? null : side} />
    </ProfilePage>
  );
}

/** Kept deleted and disappeared messages in this chat: shown or hidden, or as Settings → Adversarial features says. */
function KeptHere({ conversationId }: { conversationId: string }) {
  const r = retention.value;
  const own = r.showIn[conversationId] ?? null;
  const label = (v: 'shown' | 'hidden') => (v === 'shown' ? 'Shown' : 'Hidden');
  return (
    <Card title="Kept messages" icon="clock">
      <label class="pf-level">
        <select class="select" value={own ?? ''} onChange={(e) => void setShowIn(conversationId, ((e.target as HTMLSelectElement).value || null) as 'shown' | 'hidden' | null)}>
          <option value="">Default ({label(r.show)})</option>
          <option value="shown">Shown</option>
          <option value="hidden">Hidden</option>
        </select>
      </label>
      <p class="pf-hint">Deleted and disappeared messages the hub kept in this chat. Hidden only hides them here; nothing is forgotten.</p>
    </Card>
  );
}

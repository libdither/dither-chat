/**
 * The head of every place (docs/places.md "The head"): a chat, a person, a channel, a stream, a mail thread, a post's
 * thread. One order, whatever the place: Back, the tile, the name and the line under it, then the buttons: the hub out
 * of reach, the place's own (a call, Archive, Follow replies, About), Search, the notification bell, Details and ⋯.
 * A button a place has no use for is simply not there. On a phone the place's own buttons and Search stay; the bell,
 * Details and what the place puts in `phoneItems` (its profile or about page) move under ⋯.
 *
 * In the app's start, so the Timeline chunk (chats, mail threads) and the feed chunk (a post's thread, through `kit`
 * in ui/feed/lazy.tsx) draw the same head without either pulling in the other.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, RULE_LABEL, RULE_LEVELS } from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { AUTOMATIC, AUTOMATIC_HELP, OLDER_RULE, OLDER_RULE_HELP, RULE_HELP, convLabel, effectiveLevel, heldHere, ruleIcon, ruleName, ruleOn } from '../model.ts';
import { db, rev, setRule } from '../state.ts';
import { phone } from '../phone.ts';
import { Menu } from './bits.tsx';
import { Icon } from './icons.tsx';
import { HeadOrb } from './Offline.tsx';
import { detailsShown, showDetails } from './Pager.ts';
import { groups, openMenu, useMenu, type MenuEntry, type MenuSpec } from './ContextMenu.tsx';

export interface PlaceHeadProps {
  /** Back, where the page has one (a phone, a thread opened from another). */
  back?: () => void;
  backLabel?: string;
  backClass?: string;
  /** The picture with its network's badge, or a kind's glyph (the envelope). */
  tile: ComponentChildren;
  /** The tile as a button: what a press opens, and its title. Else it is a picture only. */
  onTile?: () => void;
  tileTitle?: string;
  /** In the h2: the name, and what follows it (a lock, a nickname pencil). */
  name: ComponentChildren;
  /** The line under the name, whatever the place gives. */
  sub?: ComponentChildren;
  subClass?: string;
  class?: string;
  /** The place's own buttons, after the orb and before Search. */
  extras?: ComponentChildren;
  search?: { label: string; run: () => void };
  /** The notification bell, for a place that is a conversation with a rule of its own. */
  bell?: { c: P.ConversationView; also?: P.ConversationView[] };
  /** Details: the panel beside the page (App.tsx). */
  details?: boolean;
  /** The place's own entries in ⋯, on every screen. */
  more?: () => MenuEntry[];
  /** First in ⋯ on a phone only: what a computer has as a button or in the tile (a profile, an about page). */
  phoneItems?: () => MenuEntry[];
  /** What ⋯ is about, over its sheet on a phone. */
  moreTitle?: string;
  /** Right-click or long-press on the head. */
  menu?: () => MenuSpec | null;
}

export function PlaceHead(p: PlaceHeadProps) {
  // redraws: the parent draws it from what it reads; `phone` and the details panel are signals read here.
  const press = useMenu(() => p.menu?.() ?? null);
  const hasMore = !!(p.more || p.phoneItems || p.details || p.bell);
  const openMore = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const onPhone = phone.value;
    const det: MenuEntry | false = !!p.details && { label: 'Details', icon: 'panel', track: 'details', checked: detailsShown(), run: () => showDetails(!detailsShown()) };
    const items = groups(
      p.more?.() ?? [],
      onPhone ? [...(p.phoneItems?.() ?? []), det] : [],
      onPhone && p.bell ? [{ kind: 'row', render: (close: () => void) => <div class="sheet-menu"><LevelItems c={p.bell!.c} also={p.bell!.also} close={close} /></div> } as MenuEntry] : [],
    );
    openMenu(
      { x: r.left, y: r.bottom + 4 },
      { items, label: p.moreTitle ?? 'More', track: 'header menu', flipY: r.top - 4, ...(p.moreTitle ? { head: <div class="cm-sheet-title">{p.moreTitle}</div> } : {}) },
      e.currentTarget,
    );
  };
  return (
    <header class={`conv-head ${p.class ?? ''}`} data-track-area="chat header" {...(p.menu ? press : {})}>
      {p.back && (
        <button class={`icon-btn back ${p.backClass ?? ''}`} data-track="pager: back button" onClick={p.back} aria-label={p.backLabel ?? 'Back'}>
          <Icon name="back" />
        </button>
      )}
      {p.onTile ? (
        <button class="conv-head-icon conv-head-who" tabIndex={-1} data-track="picture" title={p.tileTitle} onClick={p.onTile}>
          {p.tile}
        </button>
      ) : (
        <span class="conv-head-icon" title={p.tileTitle}>
          {p.tile}
        </span>
      )}
      <div class="conv-head-text">
        <h2>{p.name}</h2>
        {p.sub !== undefined && <div class={`conv-head-sub ${p.subClass ?? ''}`}>{p.sub}</div>}
      </div>
      <div class="conv-head-actions">
        <HeadOrb />
        {p.extras}
        {p.search && (
          <button class="hdr-btn" data-track="search here" title={p.search.label} aria-label={p.search.label} onClick={p.search.run}>
            <Icon name="search" size={16} />
          </button>
        )}
        {p.bell && <LevelMenu c={p.bell.c} also={p.bell.also} />}
        {p.details && (
          <button class={`hdr-btn phone-hide ${detailsShown() ? 'on' : ''}`} data-track="details" onClick={() => showDetails(!detailsShown())} title="Details" aria-label="Details">
            <Icon name="panel" size={16} />
          </button>
        )}
        {hasMore && (
          <button class={`hdr-btn ${p.more ? '' : 'phone-only'}`} data-track="header menu" title="More" aria-label="More" aria-haspopup="menu" onClick={openMore}>
            <Icon name="more" size={18} />
          </button>
        )}
      </div>
    </header>
  );
}

/**
 * A conversation's notification rule, from its head: Automatic (no rule), Always alert, List only or Mute. With no
 * rule of its own, the line under Automatic says what holds: a rule above it, or what the network does here.
 */
function LevelMenu({ c, also }: { c: P.ConversationView; /** A person's other chats, which take the same rule (all chats together). */ also?: P.ConversationView[] }) {
  rev.value; // rules change without the place changing
  const eff = effectiveLevel(c);
  // The button says the rule that holds; with none, Automatic. A place muted on its network looks kept to the list.
  const held = eff.rule === 'mentions' ? 'Mentions only' : ruleName(eff.rule);
  const look = eff.rule ?? (eff.level === 'digest' ? 'digest' : 'auto');
  return (
    <Menu
      align="right"
      trigger={(toggle) => (
        // A bell, with a dot where a rule other than Automatic holds; the rule's own icon says which.
        <button class={`hdr-btn level ${look} phone-hide`} data-track="notification level" onClick={toggle} title={`Notifications: ${ruleName(eff.rule)} (${eff.source})`} aria-label={`Notifications: ${held}`}>
          <Icon name={eff.rule ? ruleIcon(eff.rule) : 'bell'} size={16} />
          {eff.rule && <span class="hdr-dot" aria-hidden="true" />}
        </button>
      )}
    >
      {(close) => <LevelItems c={c} also={also} close={close} />}
    </Menu>
  );
}

/** The notification rules, as the head's bell lists them and a phone's ⋯ does. */
function LevelItems({ c, also, close }: { c: P.ConversationView; also?: P.ConversationView[]; close: () => void }) {
  // redraws: drawn in an open menu, which is drawn again when it opens.
  const eff = effectiveLevel(c);
  const own = ruleOn('conversation', c.id);
  const com = c.spaceIds[0] ?? (c.parentId ? db.conversations.get(c.parentId)?.spaceIds[0] : undefined);
  const pick = (l: P.RuleLevel | null) => () => {
    for (const x of [c, ...(also ?? [])]) setRule('conversation', x.id, l);
    close();
  };
  return (
    <div class="level-menu">
      <div class="menu-title">Notify me about {convLabel(c)}</div>
      {own === 'mentions' && (
        <div class="menu-item on" data-rule="mentions">
          <Icon name={ruleIcon(own)} size={15} />
          <span>
            <b>{OLDER_RULE}</b>
            <small>{OLDER_RULE_HELP}</small>
          </span>
        </div>
      )}
      <button data-track="notification level (automatic)" data-rule="" class={`menu-item ${own === null ? 'on' : ''}`} onClick={pick(null)}>
        <Icon name={ruleIcon(null)} size={15} />
        <span>
          <b>{AUTOMATIC}</b>
          <small>
            {AUTOMATIC_HELP}
            {own === null && `. Now: ${heldHere(eff)}`}
          </small>
        </span>
      </button>
      {RULE_LEVELS.map((l) => (
        <button key={l} data-track={`notification level (${l})`} data-rule={l} class={`menu-item ${own === l ? 'on' : ''}`} onClick={pick(l)}>
          <Icon name={ruleIcon(l)} size={15} />
          <span>
            <b>{RULE_LABEL[l]}</b>
            <small>{RULE_HELP[l]}</small>
          </span>
        </button>
      ))}
      {com && (
        <div class="menu-foot">
          Whole {NETWORK_META[c.network].spaceNoun}:
          {(['digest', 'none'] as const).map((l) => (
            <button
              key={l}
              class="chip-btn"
              data-track={`notification level (whole community, ${l})`}
              onClick={() => {
                const root = db.spaces.get(com);
                const top = root?.kind === 'section' ? (db.parents.get(com)?.[0]?.parentId ?? com) : com;
                setRule('space', top, l);
                close();
              }}
            >
              {RULE_LABEL[l]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

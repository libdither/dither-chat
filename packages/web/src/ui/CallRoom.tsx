/**
 * The room view (docs/calls.md "The room view"): a call as the conversation's whole page, its people sorted into zones
 * by role (room.ts). Speakers on top, big, with who is talking ringed; the audience below, small, with a count past
 * what fits; on the side, who asks to speak (a moderator gets Invite on each) and the channel's chat. The buttons at
 * the bottom are your role's. A chunk of its own, loaded the first time a room opens (CallRoomLazy.tsx).
 *
 * Nothing here is a network's own: a stage today, and any other room with roles later, as long as its call state says
 * the roles (CallParticipant.stage) and the room's own facts (CallState.stage).
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect } from 'preact/hooks';
import { type ActiveCall, callCan, callNetwork, isCallSelf, leaveCall, setMuted, stageAction } from '../call.ts';
import { convTitle } from '../model.ts';
import { type Room, roomCounts, roomOf } from '../room.ts';
import { db, isSelfIdentity, loadTimeline, timelineKey, timelineRev, timelines } from '../state.ts';
import { Avatar, NetBadge } from './bits.tsx';
import { openMenu, type MenuEntry } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import './CallRoom.css';

/** How many of the audience show by face before "+N more". */
const AUDIENCE_SHOWN = 18;
/** How many of the chat's newest messages the side column shows. */
const CHAT_SHOWN = 6;

function personName(identityId: string): string {
  const i = db.identities.get(identityId);
  const person = i?.personId && !isSelfIdentity(identityId) ? db.persons.get(i.personId) : null;
  return person?.name ?? i?.displayName ?? i?.handle ?? 'Someone';
}

/**
 * One face in the room: a square box with the picture inside and the speaking ring drawn by the box's own ::after, so
 * it stays round whatever the picture's box does, and one badge slot at the corner. Moves to PR 2's CallAvatar
 * (speaking indicators) once that lands.
 */
function Face({ p, size, badge }: { p: P.CallParticipant; size: number; badge?: 'muted' | 'hand' | 'invited' | null }) {
  const idn = db.identities.get(p.id);
  const who = personName(p.id);
  return (
    <span class={`croom-av ${p.speaking ? 'speaking' : ''}`} style={{ '--s': `${size}px` }}>
      {/* No network badge: the room's header says the network, and the corner is the state badge's. */}
      <Avatar id={idn?.personId ?? p.id} name={who} url={idn?.avatar ?? null} size={size} />
      {badge && (
        <span class={`croom-badge ${badge}`} title={badge === 'hand' ? 'Asking to speak' : badge === 'invited' ? 'Invited to speak' : 'Muted'}>
          {badge === 'hand' ? '✋' : badge === 'invited' ? <Icon name="stage" size={Math.round(size / 5)} /> : <Icon name="micOff" size={Math.round(size / 5)} />}
        </span>
      )}
    </span>
  );
}

/** What a moderator's tap on someone offers: invite them up, or move them back down. */
function modMenu(call: ActiveCall, room: Room, p: P.CallParticipant): MenuEntry[] {
  if (!room.moderator || !callCan('stage') || isCallSelf(call, p.id)) return [];
  const up = p.stage === 'speaker' || p.stage === 'invited';
  return up ? [{ label: 'Move to the audience', icon: 'users', track: 'stage audience', run: () => stageAction('audience', p.id) }] : [{ label: 'Invite to speak', icon: 'stage', track: 'stage invite', run: () => stageAction('invite', p.id) }];
}

function tap(call: ActiveCall, room: Room, p: P.CallParticipant) {
  const items = modMenu(call, room, p);
  if (!items.length) return undefined;
  return (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu({ x: r.left + r.width / 2, y: r.bottom }, { items, head: <b>{personName(p.id)}</b>, track: 'room person menu' }, e.currentTarget);
  };
}

function Speaker({ call, room, p }: { call: ActiveCall; room: Room; p: P.CallParticipant }) {
  const who = personName(p.id);
  const you = isCallSelf(call, p.id);
  const label = room.staged ? (p.stageModerator ? 'Moderator' : 'Speaker') : '';
  const onClick = tap(call, room, p);
  return (
    <li class="croom-speaker" data-role="speaker" data-who={p.id}>
      <button class="croom-person" onClick={onClick} disabled={!onClick} aria-label={`${who}${you ? ' (you)' : ''}${label ? `, ${label.toLowerCase()}` : ''}${p.speaking ? ', speaking' : ''}${p.muted ? ', muted' : ''}`}>
        <Face p={p} size={64} badge={p.muted || p.serverMuted ? 'muted' : null} />
        <span class="croom-name">{you ? `${who} (you)` : who}</span>
        {label && <small class="croom-role">{label}</small>}
      </button>
    </li>
  );
}

function Listener({ call, room, p }: { call: ActiveCall; room: Room; p: P.CallParticipant }) {
  const who = personName(p.id);
  const you = isCallSelf(call, p.id);
  const onClick = tap(call, room, p);
  const badge = p.stage === 'hand' ? 'hand' : p.stage === 'invited' ? 'invited' : null;
  return (
    <li class="croom-listener" data-role={p.stage ?? 'audience'} data-who={p.id}>
      <button class="croom-person" onClick={onClick} disabled={!onClick} aria-label={`${who}${you ? ' (you)' : ''}${badge === 'hand' ? ', asking to speak' : badge === 'invited' ? ', invited to speak' : ''}`}>
        <Face p={p} size={32} badge={badge} />
        <span class="croom-name">{you ? 'You' : who}</span>
      </button>
    </li>
  );
}

/** The side column's hands: Invite on each for a moderator, the faces for everyone else. */
function Hands({ call, room }: { call: ActiveCall; room: Room }) {
  if (!room.staged) return null;
  if (room.moderator && callCan('stage'))
    return (
      <section class="croom-side-part croom-requests">
        <h4>Asking to speak · {room.hands.length}</h4>
        {room.hands.length === 0 && <p class="croom-quiet">No hands up.</p>}
        {room.hands.map((p) => (
          <div class="croom-request" data-who={p.id}>
            <Face p={p} size={24} />
            <span class="croom-name">{isCallSelf(call, p.id) ? 'You' : personName(p.id)}</span>
            {!isCallSelf(call, p.id) && (
              <button class="croom-invite" onClick={() => stageAction('invite', p.id)} data-track="stage invite">
                Invite
              </button>
            )}
          </div>
        ))}
      </section>
    );
  if (!room.hands.length) return null;
  return (
    <section class="croom-side-part">
      <h4>Hands up · {room.hands.length}</h4>
      <div class="croom-hand-faces">
        {room.hands.slice(0, 12).map((p) => (
          <span title={personName(p.id)}>
            <Face p={p} size={28} />
          </span>
        ))}
      </div>
    </section>
  );
}

/** The channel's newest messages, when it has any. The whole chat is a tap away (the Chat switch). */
function SideChat({ conversationId, onChat }: { conversationId: string; onChat: () => void }) {
  const key = timelineKey('c', conversationId);
  timelineRev(key).value;
  useEffect(() => void loadTimeline(key, false, { glance: true }).catch(() => {}), [key]);
  const msgs = (timelines.get(key)?.messages ?? []).filter((m) => !m.deleted && m.kind !== 'system' && m.body).slice(-CHAT_SHOWN);
  if (!msgs.length) return null;
  return (
    <section class="croom-side-part croom-chat">
      <h4>Chat</h4>
      {msgs.map((m) => (
        <p class="croom-line">
          <b>{m.authorId ? personName(m.authorId) : 'Someone'}</b> <span>{m.body}</span>
        </p>
      ))}
      <button class="croom-open-chat" onClick={onChat} data-track="room open chat">
        Open the chat
      </button>
    </section>
  );
}

/** The buttons your role has. */
function Controls({ call, room }: { call: ActiveCall; room: Room }) {
  const can = callCan('stage');
  const ended = call.phase === 'ended';
  const quietly = (
    <button class="croom-btn" onClick={leaveCall} disabled={ended} data-track="room leave quietly">
      Leave quietly
    </button>
  );
  if (!room.staged || room.me === 'speaker')
    return (
      <div class="croom-controls">
        <button
          class={`croom-btn round ${call.muted ? 'off' : ''}`}
          onClick={() => setMuted(!call.muted)}
          disabled={ended || call.listenOnly}
          aria-label={call.muted ? 'Unmute' : 'Mute'}
          title={call.listenOnly ? 'No microphone: listening only' : call.muted ? 'Unmute' : 'Mute'}
          data-track="room mic"
        >
          <Icon name={call.muted ? 'micOff' : 'mic'} size={18} />
        </button>
        {room.staged && can && (
          <button class="croom-btn" onClick={() => stageAction('listen')} disabled={ended} data-track="stage listen">
            Move to audience
          </button>
        )}
        <button class="croom-btn leave" onClick={leaveCall} disabled={ended} data-track="room leave">
          Leave
        </button>
      </div>
    );
  if (room.me === 'invited')
    return (
      <div class="croom-controls">
        <span class="croom-note">You're invited to speak</span>
        {can && (
          <button class="croom-btn go" onClick={() => stageAction('speak')} disabled={ended} data-track="stage speak">
            Speak
          </button>
        )}
        {can && (
          <button class="croom-btn" onClick={() => stageAction('listen')} disabled={ended} data-track="stage stay">
            Stay in the audience
          </button>
        )}
        {quietly}
      </div>
    );
  return (
    <div class="croom-controls">
      {can && room.me === 'hand' && (
        <button class="croom-btn hand" onClick={() => stageAction('lowerHand')} disabled={ended} data-track="stage lower hand">
          ✋ Lower hand
        </button>
      )}
      {can && room.me === 'audience' && (
        <button class="croom-btn hand" onClick={() => stageAction('raiseHand')} disabled={ended} data-track="stage raise hand">
          ✋ Ask to speak
        </button>
      )}
      {can && room.moderator && (
        <button class="croom-btn go" onClick={() => stageAction('speak')} disabled={ended} data-track="stage speak">
          Speak
        </button>
      )}
      {quietly}
    </div>
  );
}

/** The whole room, for the call in this conversation. `onChat`: switch the page to the channel's chat. */
export function CallRoom({ call, onChat }: { call: ActiveCall; onChat: () => void }) {
  const room = roomOf(call.participants, (id) => isCallSelf(call, id), call.stage);
  const c = db.conversations.get(call.conversationId);
  const network = callNetwork(call);
  const title = call.stage?.topic ?? (c ? convTitle(c) : 'Call');
  const kind = room.staged ? 'Stage' : 'Call';
  const shown = room.audience.slice(0, AUDIENCE_SHOWN);
  const more = room.audience.length - shown.length;
  return (
    <div class="croom" data-me={room.me} data-moderator={room.moderator ? '1' : undefined}>
      <div class="croom-main">
        <header class="croom-head">
          <NetBadge network={network} size={22} />
          <div class="croom-title">
            <b>{title}</b>
            <span>
              {kind}
              {c && call.stage?.topic ? ` in ${convTitle(c)}` : ''} · {call.phase === 'connecting' ? 'joining…' : roomCounts(room)}
            </span>
          </div>
        </header>
        <section class="croom-zone">
          <h4>{room.staged ? 'Speakers' : 'In the call'}</h4>
          <ul class="croom-speakers">
            {room.speakers.map((p) => (
              <Speaker call={call} room={room} p={p} />
            ))}
            {room.speakers.length === 0 && <li class="croom-quiet">Nobody is speaking yet.</li>}
          </ul>
        </section>
        {room.staged && room.audience.length > 0 && (
          <section class="croom-zone">
            <h4>Audience</h4>
            <ul class="croom-audience">
              {shown.map((p) => (
                <Listener call={call} room={room} p={p} />
              ))}
              {more > 0 && (
                <li class="croom-listener">
                  <span class="croom-more">+{more}</span>
                  <span class="croom-name">more</span>
                </li>
              )}
            </ul>
          </section>
        )}
        <Controls call={call} room={room} />
      </div>
      <aside class="croom-side" aria-label={`Beside the ${NETWORK_META[network].name} ${kind.toLowerCase()}`}>
        <Hands call={call} room={room} />
        <SideChat conversationId={call.conversationId} onChat={onChat} />
      </aside>
    </div>
  );
}

/**
 * The room view (docs/calls.md "The room view"): a call as the conversation's page, its people sorted into zones by
 * role (room.ts). Speakers on top, big, with who is talking ringed; who asks to speak, oldest first (a moderator gets
 * Invite on each); the audience below, small, with "+N more" opening the whole list, searchable, people you know
 * first. The buttons at the bottom are your role's (CallControls, the same as every call surface). The channel's chat
 * sits beside it on a wide pane (Timeline.tsx). A chunk of its own, loaded the first time a room opens (CallRoomLazy.tsx).
 *
 * Nothing here is a network's own: a Discord stage today, an X Space later, as long as the call state says the roles
 * (CallParticipant.stage, stageRank) and what you may do (CallState.stage, call.ts callStageCan).
 */
import type * as P from '@dither-chat/protocol';
import { stageMoveFits } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { type ActiveCall, callName, callNetwork, callRole, callStageCan, isCallSelf, roomOnPage, roomRequests, stageAction } from '../call.ts';
import { BADGE_WORDS } from '../callmarks.ts';
import { convTitle } from '../model.ts';
import { audienceList, RANK_WORDS, type Room, roomCounts, roomOf } from '../room.ts';
import { db } from '../state.ts';
import { NetBadge } from './bits.tsx';
import { CallAvatar, callMarks } from './CallAvatar.tsx';
import { CallControls } from './CallControls.tsx';
import { openMenu, type MenuEntry } from './ContextMenu.tsx';
import './CallRoom.css';

/** How many of the audience show by face before "+N more". */
const AUDIENCE_SHOWN = 18;

/** What you may do to others here, worked out once a draw. */
interface Can {
  call: ActiveCall;
  canOn: P.StageMove[];
}

/** A moderator's moves on someone: invite them up, or move them back down; each only where it fits their role. */
function movesOn(can: Can, p: P.CallParticipant): MenuEntry[] {
  if (isCallSelf(can.call, p.id)) return [];
  const r = p.stage ?? 'audience';
  const out: MenuEntry[] = [];
  if (can.canOn.includes('invite') && stageMoveFits('invite', r)) out.push({ label: 'Invite to speak', icon: 'stage', track: 'stage invite', run: () => void stageAction('invite', p.id) });
  if (can.canOn.includes('audience') && stageMoveFits('audience', r)) out.push({ label: 'Move to the audience', icon: 'users', track: 'stage audience', run: () => void stageAction('audience', p.id) });
  return out;
}

/** "Lev (you), moderator, speaking, muted": the words a face is read as, from the same marks it draws. */
function personWords(call: ActiveCall, p: P.CallParticipant, role?: string): string {
  const m = callMarks(call, p);
  return [`${m.name}${isCallSelf(call, p.id) ? ' (you)' : ''}`, role?.toLowerCase(), m.speaking ? 'speaking' : '', m.badge ? BADGE_WORDS[m.badge] : ''].filter(Boolean).join(', ');
}

/**
 * One person: their face and name. With something you may do to them it is a button that opens a menu; without, a
 * plain element (nothing to press).
 */
function Person({ can, p, size, role }: { can: Can; p: P.CallParticipant; size: number; role?: string }) {
  const you = isCallSelf(can.call, p.id);
  const name = callName(p.id);
  const items = movesOn(can, p);
  const body = (
    <>
      <CallAvatar {...callMarks(can.call, p)} size={size} />
      <span class="croom-name">{you ? (size > 40 ? `${name} (you)` : 'You') : name}</span>
      {role && <small class="croom-role">{role}</small>}
    </>
  );
  const words = personWords(can.call, p, role);
  if (!items.length)
    return (
      <div class="croom-person" role="group" aria-label={words}>
        {body}
      </div>
    );
  return (
    <button
      class="croom-person"
      aria-haspopup="menu"
      aria-label={words}
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu({ x: r.left + r.width / 2, y: r.bottom }, { items, head: <b>{name}</b>, track: 'room person menu' }, e.currentTarget);
      }}
    >
      {body}
    </button>
  );
}

/** Invite one person to speak: a real button, big enough to tap. */
function InviteButton({ p }: { p: P.CallParticipant }) {
  return (
    <button class="croom-invite" onClick={() => void stageAction('invite', p.id)} aria-label={`Invite ${callName(p.id)} to speak`} data-track="stage invite">
      Invite
    </button>
  );
}

/**
 * Who asks to speak, oldest first, above the audience. You may invite: each with Invite. You may not: their faces and
 * names, so you know the queue you would join.
 */
function Requests({ can, room }: { can: Can; room: Room }) {
  const asks = roomRequests(can.call);
  if (can.canOn.includes('invite'))
    return (
      <section class="croom-zone croom-requests" aria-label="Asking to speak">
        <h4>Asking to speak · {asks.length}</h4>
        {asks.length === 0 ? (
          <p class="croom-quiet">No hands up.</p>
        ) : (
          <ul class="croom-request-list">
            {asks.map((p) => (
              <li key={p.id} class="croom-request" data-who={p.id}>
                <CallAvatar {...callMarks(can.call, p)} size={28} badge={null} />
                <span class="croom-name">{callName(p.id)}</span>
                <InviteButton p={p} />
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  const others = room.hands.filter((p) => !isCallSelf(can.call, p.id));
  if (!others.length) return null;
  return (
    <section class="croom-zone croom-requests" aria-label="Hands up">
      <h4>Hands up · {others.length}</h4>
      <ul class="croom-request-list">
        {others.slice(0, 12).map((p) => (
          <li key={p.id} class="croom-request" data-who={p.id}>
            <CallAvatar {...callMarks(can.call, p)} size={24} badge={null} />
            <span class="croom-name">{callName(p.id)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How well you know someone, for the audience list's order: starred, then people you have a direct chat with. */
function knownness(): (identityId: string) => number {
  const direct = new Set<string>();
  for (const c of db.conversations.values()) if (c.shape === 'direct' && c.peerPersonId) direct.add(c.peerPersonId);
  return (id) => {
    const pid = db.identities.get(id)?.personId;
    const person = pid ? db.persons.get(pid) : null;
    if (!person || person.isSelf) return 0;
    return person.starred ? 2 : direct.has(person.id) ? 1 : 0;
  };
}

/** The whole audience, searchable, people you know first; Invite on each for a moderator. Esc or Done closes it. */
function AudienceList({ can, room, onClose }: { can: Can; room: Room; onClose: () => void }) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => input.current?.focus(), []);
  const list = audienceList(room.audience, q, callName, knownness());
  const invite = can.canOn.includes('invite');
  return (
    <section
      class="croom-zone croom-all"
      aria-label="Everyone listening"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div class="croom-all-head">
        <h4>Listening · {room.listening.toLocaleString('en')}</h4>
        <button class="chip-btn" onClick={onClose} data-track="room audience done">
          Done
        </button>
      </div>
      <input ref={input} class="croom-search" type="search" placeholder="Find someone listening" aria-label="Find someone listening" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      {room.listening > room.audience.length && <p class="croom-quiet">Showing the {room.audience.length.toLocaleString('en')} the room sent.</p>}
      <ul class="croom-all-list">
        {list.map((p) => {
          const m = callMarks(can.call, p);
          return (
            <li key={p.id} class="croom-all-row" data-who={p.id}>
              <CallAvatar {...m} size={28} />
              <span class="croom-name">{isCallSelf(can.call, p.id) ? `${m.name} (you)` : m.name}</span>
              {m.badge && <small class="croom-role">{BADGE_WORDS[m.badge]}</small>}
              {invite && !isCallSelf(can.call, p.id) && stageMoveFits('invite', p.stage ?? 'audience') && <InviteButton p={p} />}
            </li>
          );
        })}
        {list.length === 0 && <li class="croom-quiet">Nobody listening by that name.</li>}
      </ul>
    </section>
  );
}

/** The room's say on what you are invited to: read out when it comes (a live region, always there). */
function InvitedNote({ invited }: { invited: boolean }) {
  return (
    <p class={`croom-note ${invited ? '' : 'sr-only'}`} role="status">
      {invited ? "You're invited to speak" : ''}
    </p>
  );
}

/** The whole room, for the call in this conversation. */
export function CallRoom({ call }: { call: ActiveCall }) {
  const c = db.conversations.get(call.conversationId);
  const room = roomOf(call.participants, (id) => isCallSelf(call, id), call.stage, !!call.stage || c?.variant === 'stage');
  const can: Can = { call, canOn: callStageCan(call).canOn };
  const network = callNetwork(call);
  const title = call.stage?.topic ?? (c ? convTitle(c) : 'Call');
  const kind = room.staged ? 'Stage' : 'Call';
  const [all, setAll] = useState(false);
  const shown = room.audience.slice(0, AUDIENCE_SHOWN);
  const more = room.listening - shown.length;
  // Say when the room is on screen (a narrow pane's Chat hides it), so the dock and the header leave out its buttons.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const id = call.conversationId;
    const seen = () => {
      const on = el.getClientRects().length > 0;
      if (on && roomOnPage.value !== id) roomOnPage.value = id;
      else if (!on && roomOnPage.value === id) roomOnPage.value = null;
    };
    const ro = new ResizeObserver(seen);
    ro.observe(el);
    seen();
    return () => {
      ro.disconnect();
      if (roomOnPage.value === id) roomOnPage.value = null;
    };
  }, [call.conversationId]);
  const rank = (p: P.CallParticipant) => (room.staged ? (p.stageRank ? RANK_WORDS[p.stageRank] : 'Speaker') : undefined);
  return (
    <div class="croom" ref={box} data-me={room.staged ? callRole(call) ?? 'audience' : 'speaker'} data-moderator={can.canOn.length ? '1' : undefined}>
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
      <section class="croom-zone" aria-label={room.staged ? 'Speakers' : 'In the call'}>
        <h4>{room.staged ? 'Speakers' : 'In the call'}</h4>
        <ul class="croom-speakers">
          {room.speakers.map((p) => (
            <li key={p.id} class="croom-speaker" data-role="speaker" data-who={p.id}>
              <Person can={can} p={p} size={64} role={rank(p)} />
            </li>
          ))}
          {room.speakers.length === 0 && <li class="croom-quiet">Nobody is speaking yet.</li>}
        </ul>
      </section>
      {room.staged && <Requests can={can} room={room} />}
      {room.staged && room.audience.length > 0 && !all && (
        <section class="croom-zone" aria-label="Audience">
          <h4>Audience</h4>
          <ul class="croom-audience">
            {shown.map((p) => (
              <li key={p.id} class="croom-listener" data-role={p.stage ?? 'audience'} data-who={p.id}>
                <Person can={can} p={p} size={32} />
              </li>
            ))}
            {more > 0 && (
              <li class="croom-listener">
                <button class="croom-more" onClick={() => setAll(true)} aria-label={`${more.toLocaleString('en')} more listening: show everyone`} data-track="room audience more">
                  <span class="croom-more-n">+{more.toLocaleString('en')}</span>
                  <span class="croom-name">more</span>
                </button>
              </li>
            )}
          </ul>
        </section>
      )}
      {room.staged && all && <AudienceList can={can} room={room} onClose={() => setAll(false)} />}
      <div class="croom-controls">
        <InvitedNote invited={room.me === 'invited'} />
        <CallControls call={call} />
      </div>
    </div>
  );
}

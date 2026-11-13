/**
 * The open call dock (docs/calls.md "In a call"), a chunk of its own loaded the first time the dock opens: the people
 * in the call with what each is doing (camera, Go Live, muted by a moderator, a hand up on a stage), and a tap on one
 * for their volume and mute for this account only, a stage moderator's invite or move to the audience, and a server
 * moderator's mute, deafen, move and disconnect (each after a confirm; the hub asks the network again first). A stage's
 * topic and your own hand, and the soundboard where the account may play sounds.
 */
import type * as P from '@dither-chat/protocol';
import { modVerb, VOLUME_MAX } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { type ActiveCall, askSounds, callCan, playSound, setPersonVolume, stageAction } from '../call.ts';
import { convTitle } from '../model.ts';
import { api, db, go, isSelfIdentity, toast } from '../state.ts';
import { Avatar } from './bits.tsx';
import { groups, type MenuEntry, openMenu } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import './CallPanel.css';

const STAGE_WORDS: Record<P.StageRole, string> = { speaker: 'Speaking', audience: 'Listening', hand: 'Asking to speak', invited: 'Invited to speak' };

export function name(identityId: string): string {
  const i = db.identities.get(identityId);
  const person = i?.personId ? db.persons.get(i.personId) : null;
  return person?.name ?? i?.displayName ?? i?.handle ?? 'Someone';
}

function kb(n: number) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;
}

/** The voice channel's About, for what moderating it allows: asked once per call, only where the account moderates. */
function useCallAbout(call: ActiveCall): P.AboutView | null {
  const [view, setView] = useState<P.AboutView | null>(null);
  const c = db.conversations.get(call.conversationId);
  const want = !!c && (c.variant === 'voice' || c.variant === 'stage') && callCan('moderate');
  useEffect(() => {
    if (!want) return;
    let live = true;
    api<P.AboutView>(`/api/conversations/${call.conversationId}/about?account=${encodeURIComponent(call.accountId)}`)
      .then((v) => live && setView(v))
      .catch(() => {});
    return () => void (live = false);
  }, [want, call.conversationId, call.accountId]);
  return view;
}

/** A moderator's action on someone in voice, after the owner's confirm; the network's sentence when it refuses. */
async function moderate(call: ActiveCall, action: P.ModAction, question: string, done: string, setView: (v: P.AboutView) => void) {
  if (!confirm(question)) return;
  try {
    setView(await api<P.AboutView>(`/api/conversations/${call.conversationId}/moderate`, { body: { action, accountId: call.accountId } satisfies P.ModerateRequest }));
    toast({ kind: 'info', title: done, body: '' }, 2500);
  } catch (e) {
    toast({ kind: 'error', title: `Could not ${modVerb('discord', action).toLowerCase()}`, body: (e as Error).message });
  }
}

/** Other voice channels this one's people can be moved to: the same network, sharing a server or category with it. */
function moveTargets(conversationId: string): P.ConversationView[] {
  const here = db.conversations.get(conversationId);
  if (!here) return [];
  const spaces = new Set(here.spaceIds);
  return [...db.conversations.values()].filter((c) => c.id !== here.id && c.network === here.network && (c.variant === 'voice' || c.variant === 'stage') && c.spaceIds.some((s) => spaces.has(s)));
}

/** What a tap on someone in the call offers. */
function personMenu(call: ActiveCall, p: P.CallParticipant, about: P.AboutView | null, setAbout: (v: P.AboutView) => void): MenuEntry[] {
  if (isSelfIdentity(p.id)) return [];
  const who = name(p.id);
  const volume = p.volume ?? 100;
  const mod = about?.moderation;
  const stageMod = !!call.stage?.moderator && callCan('stage');
  const moves = mod?.voiceMove?.can ? moveTargets(call.conversationId) : [];
  return groups(
    callCan('callVolume')
      ? [
          { kind: 'label', label: `Volume for you: ${volume}%` },
          {
            kind: 'row',
            render: () => (
              <input
                class="call-volume"
                type="range"
                min={0}
                max={VOLUME_MAX}
                step={5}
                value={volume}
                aria-label={`${who}'s volume for you`}
                onChange={(e) => setPersonVolume(p.id, { volume: Number((e.target as HTMLInputElement).value) })}
              />
            ),
          },
          { label: p.localMute ? 'Unmute for you' : 'Mute for you', icon: p.localMute ? 'mic' : 'micOff', checked: !!p.localMute, track: 'call local mute', run: () => setPersonVolume(p.id, { muted: !p.localMute }) },
        ]
      : [],
    stageMod && p.stage && p.stage !== 'speaker' && p.stage !== 'invited' ? [{ label: 'Invite to speak', icon: 'stage', track: 'stage invite', run: () => stageAction('invite', p.id) }] : [],
    stageMod && (p.stage === 'speaker' || p.stage === 'invited') ? [{ label: 'Move to the audience', icon: 'users', track: 'stage audience', run: () => stageAction('audience', p.id) }] : [],
    [
      mod?.voiceMute?.can && {
        label: p.serverMuted ? 'Server unmute' : 'Server mute',
        icon: 'micOff',
        danger: !p.serverMuted,
        track: 'mod voice mute',
        run: () => void moderate(call, { op: 'voiceMute', who: p.id, on: !p.serverMuted }, p.serverMuted ? `Let ${who} talk again?` : `Server mute ${who}? Nobody in the server hears them until a moderator unmutes them.`, p.serverMuted ? `${who} is unmuted` : `${who} is server muted`, setAbout),
      },
      mod?.voiceDeafen?.can && {
        label: p.serverDeafened ? 'Server undeafen' : 'Server deafen',
        icon: 'headphonesOff',
        danger: !p.serverDeafened,
        track: 'mod voice deafen',
        run: () => void moderate(call, { op: 'voiceDeafen', who: p.id, on: !p.serverDeafened }, p.serverDeafened ? `Let ${who} hear again?` : `Server deafen ${who}? They hear nobody in the server until a moderator undeafens them.`, p.serverDeafened ? `${who} is undeafened` : `${who} is server deafened`, setAbout),
      },
      moves.length > 0 && {
        label: 'Move to',
        icon: 'forward',
        sub: moves.map((c): MenuEntry => ({ label: convTitle(c), icon: c.variant === 'stage' ? 'stage' : 'voice', track: 'mod voice move', run: () => void moderate(call, { op: 'move', who: p.id, to: c.id }, `Move ${who} to ${convTitle(c)}?`, `${who} moved`, setAbout) })),
      },
      mod?.voiceMove?.can && {
        label: 'Disconnect',
        icon: 'phoneOff',
        danger: true,
        track: 'mod voice disconnect',
        run: () => void moderate(call, { op: 'disconnect', who: p.id }, `Disconnect ${who} from voice? They can join again.`, `${who} disconnected`, setAbout),
      },
    ].filter(Boolean) as MenuEntry[],
  );
}

function Person({ call, p, about, setAbout }: { call: ActiveCall; p: P.CallParticipant; about: P.AboutView | null; setAbout: (v: P.AboutView) => void }) {
  const idn = db.identities.get(p.id);
  const who = name(p.id);
  const states = [
    p.serverMuted ? 'muted by a moderator' : p.muted ? 'muted' : '',
    p.serverDeafened ? 'deafened by a moderator' : p.deafened ? 'deafened' : '',
    p.video ? 'camera on (video is not shown here yet)' : '',
    p.streaming ? 'live (watching is not built here yet)' : '',
    p.localMute ? 'muted for you' : p.volume !== undefined && p.volume !== 100 ? `${p.volume}% for you` : '',
    p.stage ? STAGE_WORDS[p.stage].toLowerCase() : '',
  ].filter(Boolean);
  const open = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu({ x: r.left + r.width / 2, y: r.bottom }, { items: personMenu(call, p, about, setAbout), head: <b>{who}</b>, track: 'call person menu' });
  };
  return (
    <li class={`${p.speaking ? 'speaking' : ''} ${p.localMute ? 'local-mute' : ''}`}>
      <button class="call-person" onClick={open} disabled={isSelfIdentity(p.id)} title={states.length ? `${who}: ${states.join(', ')}` : who} aria-label={states.length ? `${who}, ${states.join(', ')}` : who}>
        <span class="call-avatar">
          <Avatar id={idn?.personId ?? p.id} name={who} url={idn?.avatar ?? null} size={40} network="discord" />
        </span>
        <span class="call-name">{who}</span>
        {(p.muted || p.deafened || p.localMute) && <Icon name={p.deafened ? 'headphonesOff' : 'micOff'} size={14} class={`call-flag ${p.serverMuted || p.serverDeafened ? 'server' : ''}`} />}
        <span class="call-tags">
          {p.stage === 'hand' && <span title="Asking to speak">✋</span>}
          {p.video && <Icon name="camera" size={12} />}
          {p.streaming && <span class="live-tag">LIVE</span>}
          {p.volume !== undefined && p.volume !== 100 && !p.localMute && <span class="call-vol">{p.volume}%</span>}
        </span>
      </button>
    </li>
  );
}

/** A stage: its topic, and your own hand, speaking and listening. */
function StageBar({ call }: { call: ActiveCall }) {
  const me = call.participants.find((p) => isSelfIdentity(p.id));
  const role = me?.stage ?? 'audience';
  const s = call.stage!;
  const can = callCan('stage');
  return (
    <div class="call-stage">
      <div class="call-stage-topic">
        <Icon name="stage" size={14} /> {s.topic ?? 'Stage'}
      </div>
      <div class="call-stage-you">
        <span>{STAGE_WORDS[role]}</span>
        {can && role === 'audience' && (
          <button class="chip-btn" onClick={() => stageAction('raiseHand')}>
            ✋ Raise hand
          </button>
        )}
        {can && role === 'hand' && (
          <button class="chip-btn" onClick={() => stageAction('lowerHand')}>
            Lower hand
          </button>
        )}
        {can && (role === 'invited' || ((role === 'audience' || role === 'hand') && s.moderator)) && (
          <button class="chip-btn on" onClick={() => stageAction('speak')}>
            Speak
          </button>
        )}
        {can && (role === 'speaker' || role === 'invited') && (
          <button class="chip-btn" onClick={() => stageAction('listen')}>
            {role === 'invited' ? 'Stay in the audience' : 'Move to the audience'}
          </button>
        )}
      </div>
    </div>
  );
}

function Sounds({ call }: { call: ActiveCall }) {
  const [open, setOpen] = useState(false);
  const s = call.sounds;
  return (
    <div class="call-sounds">
      <button
        class="chip-btn"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          askSounds();
        }}
      >
        🔊 Soundboard
      </button>
      {open && s === null && <p class="call-sounds-note">Asking Discord…</p>}
      {open && s && !s.list.length && <p class="call-sounds-note">{s.reason ?? 'No sounds here.'}</p>}
      {open && s && s.list.length > 0 && (
        <div class="call-sounds-grid">
          {s.list.map((x) => (
            <button class="call-sound" onClick={() => playSound(x)} title={`Play ${x.name} to everyone in the call`} data-track="play sound">
              {x.emoji && <span>{x.emoji}</span>}
              {x.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The dock's open body. */
export function CallPanel({ call }: { call: ActiveCall }) {
  const [about, setAbout] = useState<P.AboutView | null>(null);
  const fetched = useCallAbout(call);
  const view = about ?? fetched;
  const c = db.conversations.get(call.conversationId);
  const title = c ? convTitle(c) : 'Call';
  const on = (r?: P.StageRole) => (call.stage ? call.participants.filter((p) => (r === 'speaker' ? p.stage === 'speaker' : p.stage !== 'speaker')) : call.participants);
  const list = (people: P.CallParticipant[]) => people.map((p) => <Person call={call} p={p} about={view} setAbout={setAbout} />);
  return (
    <div class="call-dock-body">
      {call.stage && <StageBar call={call} />}
      {call.stage ? (
        <>
          <h4 class="call-section">Speakers</h4>
          <ul class="call-people">{list(on('speaker'))}</ul>
          <h4 class="call-section">Listening</h4>
          <ul class="call-people">{list(on())}</ul>
        </>
      ) : (
        <ul class="call-people">
          {list(call.participants)}
          {call.participants.length === 0 && <li class="call-empty">{call.phase === 'connecting' ? 'Joining…' : 'Nobody else is here yet.'}</li>}
        </ul>
      )}
      {call.phase === 'live' && callCan('soundboard') && <Sounds call={call} />}
      {call.stats && (
        <p class="call-stats">
          {call.stats.codec ?? 'audio'} · {call.stats.path ?? '?'} · {call.stats.rttMs ?? '?'} ms · ↑{kb(call.stats.sent)} ↓{kb(call.stats.received)}
        </p>
      )}
      {c && (
        <button class="call-goto" onClick={() => go({ view: 'inbox', conv: c.id })}>
          Open {title}
        </button>
      )}
    </div>
  );
}

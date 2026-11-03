import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { activeCall, canCall, leaveCall, setDeafened, setMuted, startCall } from '../call.ts';
import { db, go, prefs, rev } from '../state.ts';
import { convTitle } from '../model.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';

/** The header's join button, on conversations an online account can call in. */
export function JoinCallButton({ c }: { c: P.ConversationView }) {
  rev.value;
  const accountId = canCall(c);
  const call = activeCall.value;
  if (!accountId) return null;
  const here = call && call.conversationId === c.id && call.phase !== 'ended';
  return (
    <button
      class={`hdr-btn call-join ${here ? 'on' : ''}`}
      title={here ? 'Leave the call' : 'Join the call'}
      aria-label={here ? 'Leave the call' : 'Join the call'}
      onClick={() => (here ? leaveCall() : void startCall(c.id, accountId, prefs.value.callMode))}
    >
      <Icon name={here ? 'phoneOff' : 'phone'} size={16} />
      <span class="hdr-btn-label">{here ? 'Leave' : 'Join'}</span>
    </button>
  );
}

function elapsed(since: number, now: number) {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function kb(n: number) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;
}

/** The call in progress, wherever you are in the app. Tap it for the people in it. */
export function CallDock() {
  rev.value;
  const call = activeCall.value;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!call) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [!!call]);
  if (!call) return null;
  const c = db.conversations.get(call.conversationId);
  const title = c ? convTitle(c) : 'Call';
  const speaking = call.participants.filter((p) => p.speaking);
  const status = call.phase === 'connecting' ? 'Connecting…' : call.phase === 'ended' ? (call.note ?? 'Call ended') : elapsed(call.since, now);
  return (
    <section class={`call-dock ${open ? 'open' : ''} ${call.phase}`} aria-label="Call" data-call-stats={call.stats ? JSON.stringify(call.stats) : undefined} data-call-phase={call.phase}>
      <div class="call-dock-bar">
        <button class="call-dock-title" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span class={`call-dot ${call.phase}`} />
          <span class="call-dock-text">
            <b>{title}</b>
            <small>
              {status}
              {call.phase === 'live' && ` · ${call.mode === 'direct' ? 'direct' : 'bridge'}`}
              {speaking.length > 0 && ` · ${speaking.map((p) => name(p.id)).join(', ')}`}
            </small>
          </span>
        </button>
        <div class="call-dock-buttons">
          <button class={`call-btn ${call.muted ? 'off' : ''}`} onClick={() => setMuted(!call.muted)} aria-label={call.muted ? 'Unmute' : 'Mute'} title={call.muted ? 'Unmute' : 'Mute'} disabled={call.phase === 'ended'}>
            <Icon name={call.muted ? 'micOff' : 'mic'} size={18} />
          </button>
          <button class={`call-btn ${call.deafened ? 'off' : ''}`} onClick={() => setDeafened(!call.deafened)} aria-label={call.deafened ? 'Undeafen' : 'Deafen'} title={call.deafened ? 'Undeafen' : 'Deafen'} disabled={call.phase === 'ended'}>
            <Icon name={call.deafened ? 'headphonesOff' : 'headphones'} size={18} />
          </button>
          <button class="call-btn leave" onClick={leaveCall} aria-label="Leave the call" title="Leave the call" disabled={call.phase === 'ended'}>
            <Icon name="phoneOff" size={18} />
          </button>
        </div>
      </div>
      {open && (
        <div class="call-dock-body">
          <ul class="call-people">
            {call.participants.map((p) => {
              const idn = db.identities.get(p.id);
              return (
                <li class={p.speaking ? 'speaking' : ''}>
                  <span class="call-avatar">
                    <Avatar id={idn?.personId ?? p.id} name={name(p.id)} url={idn?.avatar ?? null} size={40} network="discord" />
                  </span>
                  <span class="call-name">{name(p.id)}</span>
                  {(p.muted || p.deafened) && <Icon name={p.deafened ? 'headphonesOff' : 'micOff'} size={14} class="call-flag" />}
                </li>
              );
            })}
            {call.participants.length === 0 && <li class="call-empty">{call.phase === 'connecting' ? 'Joining…' : 'Nobody else is here yet.'}</li>}
          </ul>
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
      )}
    </section>
  );
}

function name(identityId: string): string {
  const i = db.identities.get(identityId);
  const person = i?.personId ? db.persons.get(i.personId) : null;
  return person?.name ?? i?.displayName ?? i?.handle ?? 'Someone';
}

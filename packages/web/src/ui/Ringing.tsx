/**
 * Calls ringing you (ringing.ts, docs/calls.md "Ringing"): a card per call, over everything, with Answer where this
 * account can join calls from here and Decline where it can stop the ringing; else where to answer it. It goes when
 * the call stops ringing for you, answered or declined on any device.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { applyCalls, ringingCalls, voice } from '../ringing.ts';
import { startCall } from '../call.ts';
import { api, db, go, prefs, rev, toast } from '../state.ts';
import { convTitle } from '../model.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';

/** Answer: join the call from this device (a click: the microphone needs it). */
function answer(c: P.CallView) {
  void startCall(c.conversationId, c.accountId, prefs.value.callMode);
}

/** Decline: the network's own, through the hub; it stops ringing everywhere. Says why when the network refuses. */
async function decline(c: P.CallView) {
  try {
    const r = await api<{ call: P.CallView | null }>(`/api/calls/${c.id}/decline`, { method: 'POST', body: {} });
    if (r.call) applyCalls([r.call]);
  } catch (e: any) {
    toast({ kind: 'error', title: 'Could not decline the call', body: String(e?.message ?? e) });
  }
}

/** Where a call that cannot be answered here is answered. */
function answerElsewhere(c: P.CallView): string {
  return `Answer in ${NETWORK_META[c.network]?.name ?? c.network} on your phone`;
}

function who(identityId: string | null): { name: string; avatar: string | null; personId: string | null } {
  const i = identityId ? db.identities.get(identityId) : undefined;
  const person = i?.personId ? db.persons.get(i.personId) : null;
  return { name: person?.name ?? i?.displayName ?? i?.handle ?? 'Someone', avatar: i?.avatar ?? null, personId: i?.personId ?? null };
}

function RingCard({ c }: { c: P.CallView }) {
  const caller = who(c.callerId);
  const conv = db.conversations.get(c.conversationId);
  const where = conv && conv.shape === 'group' ? ` in ${convTitle(conv)}` : '';
  const net = NETWORK_META[c.network]?.name ?? c.network;
  return (
    <div class="ring-card" role="alertdialog" aria-label={`${caller.name} is calling`} data-call={c.id}>
      <button class="ring-who" onClick={() => go({ view: 'inbox', conv: c.conversationId })} title="Open the chat">
        <Avatar id={caller.personId ?? c.callerId ?? c.id} name={caller.name} url={caller.avatar} size={40} network={c.network} />
        <span class="ring-text">
          <b>{caller.name} is calling</b>
          <small>
            {net} {c.video ? 'video call' : 'call'}
            {where}
            {!c.canAnswer && ` · ${answerElsewhere(c)}`}
          </small>
        </span>
      </button>
      <div class="ring-buttons">
        {c.canDecline && (
          <button class="call-btn leave" data-track="decline call" onClick={() => void decline(c)} aria-label="Decline" title="Decline">
            <Icon name="phoneOff" size={18} />
          </button>
        )}
        {c.canAnswer && (
          <button class="call-btn answer" data-track="answer call" onClick={() => answer(c)} aria-label="Answer" title="Answer">
            <Icon name="phone" size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Every call ringing you now. */
export function RingCards() {
  rev.value;
  const ringing = ringingCalls();
  if (!ringing.length) return null;
  return (
    <section class="ring-cards" aria-label="Calls ringing you">
      {ringing.map((c) => (
        <RingCard key={c.id} c={c} />
      ))}
    </section>
  );
}

/** Who is in a voice channel, and its status line, for its row and its page. Nothing when nobody is and it has none. */
export function VoicePeople({ conversationId, size = 18, names, class: cls = '', style }: { conversationId: string; size?: number; names?: boolean; class?: string; style?: Record<string, string> }) {
  const v = voice.value.get(conversationId);
  if (!v || (!v.members.length && !v.status)) return null;
  return (
    <span class={`voice-people ${cls}`} style={style} data-voice={conversationId}>
      {v.status && <span class="voice-status">{v.status}</span>}
      {v.members.map((m) => {
        const p = who(m.identityId);
        return (
          <span class="voice-person" title={`${p.name}${m.muted ? ' (muted)' : ''}${m.deafened ? ' (deafened)' : ''}${m.streaming ? ' (live)' : ''}`}>
            <Avatar id={p.personId ?? m.identityId} name={p.name} url={p.avatar} size={size} network="discord" />
            {names && <span class="voice-name">{p.name}</span>}
            {(m.muted || m.deafened) && <Icon name={m.deafened ? 'headphonesOff' : 'micOff'} size={12} class="call-flag" />}
          </span>
        );
      })}
    </span>
  );
}

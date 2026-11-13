/**
 * The device's side of a call (see protocol/src/call.ts for the two modes).
 *
 * One /api/call socket per call. Bridge mode is one peer connection to the account's sandbox:
 * this device's microphone goes up, the call's mixed audio comes down. Direct mode hands the
 * voice session to the network's own voice client (voice/*.ts), which runs here and reaches the
 * voice server only through the hub.
 */

import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { changed, db, toast } from './state.ts';

export interface CallStats {
  /** Media bytes this device sent and received so far. */
  sent: number;
  received: number;
  /** Round trip to whatever this device's media talks to (the sandbox, or the TURN relay). */
  rttMs: number | null;
  jitterMs: number | null;
  packetsLost: number;
  codec: string | null;
  /** Which way the media actually goes: host, srflx, relay. */
  path: string | null;
}

export interface ActiveCall {
  conversationId: string;
  accountId: string;
  mode: P.CallMode;
  phase: 'connecting' | 'live' | 'ended';
  muted: boolean;
  deafened: boolean;
  participants: P.CallParticipant[];
  since: number;
  note?: string;
  stats?: CallStats;
}

export const activeCall = signal<ActiveCall | null>(null);

/** What a mode needs to provide. */
export interface Transport {
  start(joined: Extract<P.CallServerMessage, { t: 'joined' }>): Promise<void>;
  signal(data: unknown): void;
  setMuted(muted: boolean): void;
  setDeafened(deafened: boolean): void;
  stats(): Promise<CallStats | null>;
  stop(): void;
}

export interface TransportHost {
  mic: MediaStream;
  speaker: HTMLAudioElement;
  sendSignal(data: unknown): void;
  /** Direct mode: news the account's sandbox should mirror (e.g. speaking). */
  note(data: unknown): void;
  /** Direct mode reports speaking itself; bridge mode gets it from the account's client. */
  setSpeaking(userId: string, speaking: boolean): void;
  fail(message: string): void;
}

let ws: WebSocket | null = null;
let transport: Transport | null = null;
let mic: MediaStream | null = null;
let speaker: HTMLAudioElement | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
/** Direct mode's own speaking news, laid over the sandbox's participant list. */
const speakingLocal = new Map<string, boolean>();

const patch = (p: Partial<ActiveCall>) => {
  if (activeCall.value) activeCall.value = { ...activeCall.value, ...p };
};

export function canCall(c: P.ConversationView): string | null {
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && a.capabilities.includes('calls') && a.status === 'online');
  if (c.variant !== 'voice') return null;
  return accounts[0]?.id ?? null;
}

/**
 * A direct or group conversation an online account can start a call in, ringing the others (capability 'ringCalls').
 */
export function canRing(c: P.ConversationView): string | null {
  if (c.shape !== 'direct' && c.shape !== 'group') return null;
  const a = c.vantages.map((v) => db.accounts.get(v.accountId)).find((a) => !!a && a.capabilities.includes('calls') && a.capabilities.includes('ringCalls') && a.status === 'online');
  return a?.id ?? null;
}

/** Start from a click: the microphone prompt and audio playback both need the gesture. `ring`: ring the others (a DM or group). */
export async function startCall(conversationId: string, accountId: string, mode: P.CallMode, ring = false) {
  if (activeCall.value && activeCall.value.phase !== 'ended') leaveCall();
  speaker = new Audio();
  speaker.autoplay = true;
  // Unlocks playback on iOS while the click still counts.
  speaker.play().catch(() => {});
  activeCall.value = { conversationId, accountId, mode, phase: 'connecting', muted: false, deafened: false, participants: [], since: Date.now() };
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (e: any) {
    end(`No microphone: ${e?.message ?? e}`);
    return;
  }
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/call`);
  ws = sock;
  sock.onopen = () => sock.send(JSON.stringify({ op: 'join', account: accountId, conversation: conversationId, mode, ...(ring ? { ring: true } : {}) } satisfies P.CallClientMessage));
  sock.onmessage = (e) => onServer(JSON.parse(e.data) as P.CallServerMessage);
  sock.onclose = () => {
    if (ws === sock) end(activeCall.value?.note ?? 'Call ended');
  };
}

async function onServer(m: P.CallServerMessage) {
  const cur = activeCall.value;
  if (!cur) return;
  switch (m.t) {
    case 'joined': {
      const host: TransportHost = {
        mic: mic!,
        speaker: speaker!,
        sendSignal: (data) => send({ op: 'signal', data }),
        note: (data) => send({ op: 'note', data }),
        setSpeaking: (id, on) => {
          speakingLocal.set(id, on);
          const a = activeCall.value;
          if (a) patch({ participants: a.participants.map((p) => (p.id === id || db.identities.get(p.id)?.nativeId === id ? { ...p, speaking: on } : p)) });
        },
        fail: (message) => {
          patch({ note: message });
          leaveCall();
        },
      };
      transport = m.mode === 'direct' ? await directTransport(host) : bridgeTransport(host);
      try {
        await transport.start(m);
      } catch (e: any) {
        host.fail(String(e?.message ?? e));
        return;
      }
      patch({ phase: 'live', since: Date.now() });
      statsTimer = setInterval(async () => {
        const s = await transport?.stats().catch(() => null);
        if (s) patch({ stats: s });
      }, 2000);
      return;
    }
    case 'signal':
      transport?.signal(m.data);
      return;
    case 'state': {
      const st = m.state as P.CallState & { identities?: P.IdentityView[] };
      for (const i of st.identities ?? []) db.identities.set(i.id, i);
      if (st.identities?.length) changed('shown');
      const participants = st.participants.map((p) => {
        const native = db.identities.get(p.id)?.nativeId;
        const local = native ? speakingLocal.get(native) : undefined;
        return cur.mode === 'direct' && local !== undefined ? { ...p, speaking: local } : p;
      });
      patch({ participants });
      return;
    }
    case 'ended':
      patch({ note: m.reason });
      end(m.reason);
      return;
    case 'error':
      toast({ kind: 'error', title: 'Call', body: m.message });
      patch({ note: m.message });
      return;
  }
}

function send(m: P.CallClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

export function leaveCall() {
  send({ op: 'leave' });
  end(activeCall.value?.note ?? 'You left');
}

export function setMuted(muted: boolean) {
  const a = activeCall.value;
  if (!a) return;
  // Undeafening by unmuting, as Discord does.
  const deafened = muted ? a.deafened : false;
  transport?.setMuted(muted);
  transport?.setDeafened(deafened);
  patch({ muted, deafened });
  send({ op: 'mute', muted, deafened });
}

export function setDeafened(deafened: boolean) {
  const a = activeCall.value;
  if (!a) return;
  const muted = deafened ? true : a.muted;
  transport?.setMuted(muted);
  transport?.setDeafened(deafened);
  patch({ muted, deafened });
  send({ op: 'mute', muted, deafened });
}

function end(reason: string) {
  if (activeCall.value?.phase !== 'ended') console.warn('call ended:', reason);
  const sock = ws;
  ws = null;
  try {
    sock?.close();
  } catch {}
  transport?.stop();
  transport = null;
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  if (speaker) speaker.srcObject = null;
  speaker = null;
  speakingLocal.clear();
  if (activeCall.value && activeCall.value.phase !== 'ended') {
    patch({ phase: 'ended', note: reason });
    const ended = activeCall.value;
    setTimeout(() => {
      if (activeCall.value === ended) activeCall.value = null;
    }, 4000);
  }
}

// ------------------------------------------------------------------ bridge

function bridgeTransport(host: TransportHost): Transport {
  let pc: RTCPeerConnection | null = null;
  return {
    async start(joined) {
      pc = new RTCPeerConnection({ iceServers: joined.iceServers });
      const track = host.mic.getAudioTracks()[0]!;
      pc.addTransceiver(track, { direction: 'sendrecv', streams: [host.mic] });
      pc.ontrack = (e) => {
        host.speaker.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        host.speaker.play().catch(() => {});
      };
      pc.onicecandidate = (e) => host.sendSignal({ candidate: e.candidate ? e.candidate.toJSON() : null });
      pc.onconnectionstatechange = () => {
        if (pc?.connectionState === 'failed') host.fail('The audio link to the account dropped.');
      };
      await pc.setLocalDescription(await pc.createOffer());
      host.sendSignal({ type: 'offer', sdp: pc.localDescription!.sdp, iceServers: joined.iceServers });
    },
    signal(data: any) {
      if (!pc) return;
      if (data?.type === 'answer') void pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      else if (data && 'candidate' in data && data.candidate) void pc.addIceCandidate(data.candidate).catch(() => {});
    },
    setMuted(muted) {
      host.mic.getAudioTracks().forEach((t) => (t.enabled = !muted));
    },
    setDeafened(deafened) {
      host.speaker.muted = deafened;
    },
    stats: () => (pc ? peerStats(pc) : Promise.resolve(null)),
    stop() {
      pc?.close();
      pc = null;
    },
  };
}

/** Lazy: the direct client and its crypto load only when a direct call starts. */
async function directTransport(host: TransportHost): Promise<Transport> {
  const { discordTransport } = await import('./voice/discord.ts');
  return discordTransport(host);
}

export async function peerStats(pc: RTCPeerConnection): Promise<CallStats> {
  const report = await pc.getStats();
  let sent = 0;
  let received = 0;
  let rttMs: number | null = null;
  let jitterMs: number | null = null;
  let packetsLost = 0;
  let codec: string | null = null;
  let path: string | null = null;
  const byId = new Map<string, any>();
  report.forEach((r: any) => byId.set(r.id, r));
  report.forEach((r: any) => {
    if (r.type === 'transport') {
      sent += r.bytesSent ?? 0;
      received += r.bytesReceived ?? 0;
      const pair = byId.get(r.selectedCandidatePairId);
      if (pair) {
        rttMs = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : rttMs;
        const l = byId.get(pair.localCandidateId);
        const r = byId.get(pair.remoteCandidateId);
        // A relayed path names its relay protocol; otherwise the candidate type says how direct it is.
        path = l ? `${l.relayProtocol ? `relay/${l.relayProtocol}` : l.candidateType} ${l.address ?? ''}→${r?.address ?? ''}:${r?.port ?? ''}` : null;
      }
    }
    if (r.type === 'inbound-rtp' && r.kind === 'audio') {
      jitterMs = r.jitter != null ? Math.round(r.jitter * 1000) : jitterMs;
      packetsLost += r.packetsLost ?? 0;
      codec = byId.get(r.codecId)?.mimeType ?? codec;
    }
  });
  return { sent, received, rttMs, jitterMs, packetsLost, codec, path };
}

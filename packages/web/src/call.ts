/**
 * The device's side of a call (see protocol/src/call.ts for the two modes).
 *
 * One /api/call socket per call. Bridge mode is one peer connection to the account's sandbox:
 * this device's microphone goes up, the call's mixed audio comes down. Direct mode hands the
 * voice session to the network's own voice client (voice/*.ts), which runs here and reaches the
 * voice server only through the hub.
 */

import { pauseNowPlaying } from './nowplaying.ts';
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { BRIDGE_MIDS, CALL_INPUT_DEFAULT, callInput, NETWORK_META } from '@dither-chat/protocol';
import { AUTO_GATE_DB, type CallControl, type CallStatus, controlsFor, featuredPicker, levelShown, smoothLevel, speakingHold, stageCan, statusFor, talkGate } from './callmarks.ts';
import { requestsOf } from './room.ts';
import { playCallSound, preloadCallSounds, soundLog } from './callsounds.ts';
import { changed, db, isSelfIdentity, pref, toast } from './state.ts';

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
  /** Video this device receives and sends: frames a second and size, the best of each. */
  videoIn?: { fps: number; width: number; height: number; kbps?: number } | null;
  videoOut?: { fps: number; width: number; height: number } | null;
  /** The loudest incoming audio's level now, 0 to 1 (what the call sounds like here). */
  inLevel?: number | null;
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
  /** Present when the call is a stage. */
  stage?: P.CallStage;
  /** Sounds and emoji others sent in the last few seconds, newest last. */
  effects: { at: number; effect: P.CallEffect }[];
  /** The soundboard's sounds, once asked for (null while asking). */
  sounds?: { list: P.CallSound[]; reason?: string } | null;
  /** The account's own client in the call, as it last said (CallState.self). */
  self?: P.CallSelf;
  /** Bridge mode: others' video on the bridge's slots (hub identity ids). */
  video: P.CallVideo[];
  /** This device sends its camera, its screen. */
  camera: boolean;
  screen: boolean;
  /** No microphone: the call goes on listening only. */
  listenOnly?: boolean;
  /** How long joining took, ms from the click (for the call lab and the perf checks). */
  timing: { socket?: number; mic?: number; joined?: number; live?: number; connected?: number; firstAudio?: number };
}

/** The media that goes with the call: this device's own camera and screen, and the bridge's video slots (mid -> stream). */
export const callMedia = signal<{ camera: MediaStream | null; screen: MediaStream | null; slots: Map<string, MediaStream> }>({ camera: null, screen: null, slots: new Map() });
/** This device's microphone loudness, 0 to 1, about ten times a second while a call is on. */
export const micLevel = signal(0);
/**
 * Direct mode only: how loud each person speaking is, 0 to 1, by identity id (their own receive slot's level). Bridge
 * mode gets one mixed stream, so it has no level per person and this stays empty.
 */
export const callLevels = signal<ReadonlyMap<string, number>>(new Map());
/** You are muted and your microphone hears you talking: on after half a second of talk, off after three of quiet. */
export const mutedTalking = signal(false);
/**
 * Whom to feature (the call bar's face, the video window's Speaker): the latest to start talking, never you, kept
 * 1.5 s at least (callmarks.ts featuredPicker). Null when nobody else talks.
 */
export const featuredSpeaker = signal<string | null>(null);
/**
 * The conversation whose room is on screen now (ui/CallRoom.tsx says, as its box comes and goes; a narrow pane's Chat
 * hides it): the call's other surfaces leave out the buttons the room has, so one Leave shows.
 */
export const roomOnPage = signal<string | null>(null);

/**
 * Speaking, held (callmarks.ts speakingHold): every participant's `speaking` in activeCall is the held value, so each
 * mark that reads it (rings, the status line, video tiles, the featured face) is steady through the gaps between words.
 * What the network said last, before the hold, is `rawSpeaking`.
 */
let rawSpeaking = new Set<string>();
let patching = false;
const speakingHeld = speakingHold(() => {
  const a = activeCall.value;
  if (a && !patching) activeCall.value = { ...a, participants: withHeld(a.participants) };
  feature();
});
const picker = featuredPicker((id) => (featuredSpeaker.value = id));
const mutedGate = talkGate((on) => (mutedTalking.value = on));

function withHeld(list: P.CallParticipant[]): P.CallParticipant[] {
  const on = speakingHeld.on;
  return list.map((p) => (p.speaking === on.has(p.id) ? p : { ...p, speaking: on.has(p.id) }));
}

function feature() {
  const a = activeCall.value;
  if (!a || a.phase === 'ended') picker.clear();
  else picker.update(speakingHeld.on, db.accounts.get(a.accountId)?.selfIdentityId);
}

/** What the network says now about who speaks (identity ids), before the hold. */
function heard(ids: Set<string>) {
  rawSpeaking = ids;
  patching = true;
  try {
    speakingHeld.update(ids);
  } finally {
    patching = false;
  }
}

/** How long a sound or an emoji someone sent stays on the call's bar. */
const EFFECT_MS = 6000;

export const activeCall = signal<ActiveCall | null>(null);

/** What a mode needs to provide. */
export interface Transport {
  start(joined: Extract<P.CallServerMessage, { t: 'joined' }>): Promise<void>;
  signal(data: unknown): void;
  setMuted(muted: boolean): void;
  setDeafened(deafened: boolean): void;
  /** Direct mode: the people's volumes and mutes for this account, by native user id, as the call's state says them. */
  setVolumes?(byUser: Map<string, { volume: number; muted: boolean }>): void;
  /** Direct mode: when the microphone counts as speaking. */
  setInput?(input: P.CallInput): void;
  /** Bridge mode: this device's camera, screen and the screen's sound, sent on their own m-lines (null: off). */
  setCamera?(track: MediaStreamTrack | null): Promise<void>;
  setScreen?(video: MediaStreamTrack | null, audio: MediaStreamTrack | null): Promise<void>;
  stats(): Promise<CallStats | null>;
  /** The microphone's level as the browser measures what it sends, 0 to 1 (no audio graph of its own). */
  micLevel?(): Promise<number | null>;
  /** Direct mode: how loud each person is now, 0 to 1, by native user id (each has a receive slot of their own). */
  peerLevels?(): Map<string, number>;
  /** The host's microphone changed (a stage's listener began speaking, or went back to listening): send the new one. */
  setMic?(): Promise<void>;
  stop(): void;
}

export interface TransportHost {
  /** The microphone as it is now: a silent one while you only listen on a stage (setMic says when it changes). */
  readonly mic: MediaStream;
  speaker: HTMLAudioElement;
  /** Started with the click that started the call, so it may play: where a person at another volume plays from. */
  ctx: AudioContext | null;
  input: P.CallInput;
  sendSignal(data: unknown): void;
  /** Direct mode: news the account's sandbox should mirror (e.g. speaking). */
  note(data: unknown): void;
  /** Direct mode reports speaking itself; bridge mode gets it from the account's client. */
  setSpeaking(userId: string, speaking: boolean): void;
  /** Bridge mode: the track on one of the receive slots (BRIDGE_MIDS.video). */
  setSlot?(mid: string, track: MediaStreamTrack): void;
  /** The first audio from the call arrived. */
  heard?(): void;
  fail(message: string): void;
}

let ws: WebSocket | null = null;
let transport: Transport | null = null;
let mic: MediaStream | null = null;
/**
 * The microphone is a real one, from the browser. On a stage you join listening with a silent one instead, and the
 * browser's microphone opens only when you speak (takeMic) and closes when you go back to listening (releaseMic).
 */
let micOpen = false;
let speaker: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let meterTimer: ReturnType<typeof setInterval> | null = null;
let clickAt = 0;
/** Direct mode's own speaking news, laid over the sandbox's participant list. */
const speakingLocal = new Map<string, boolean>();

/** Change the call. Participants always carry the held speaking value; what the network said goes through heard(). */
const patch = (p: Partial<ActiveCall>) => {
  if (!activeCall.value) return;
  activeCall.value = { ...activeCall.value, ...p, ...(p.participants ? { participants: withHeld(p.participants) } : {}) };
  if (p.participants || p.phase) feature();
};

/** The network a call goes over, from its account. */
export function callNetwork(call: Pick<ActiveCall, 'accountId'>): P.Network {
  return db.accounts.get(call.accountId)?.network ?? 'discord';
}

/**
 * A voice or stage channel's account to call from: the one chosen to send as in this chat, else the first online one
 * that can (on a stage, one with the capability 'stage', so it can take part beyond listening).
 */
export function canCall(c: P.ConversationView): string | null {
  if (c.variant !== 'voice' && c.variant !== 'stage') return null;
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && a.capabilities.includes('calls') && (c.variant !== 'stage' || a.capabilities.includes('stage')) && a.status === 'online');
  return (accounts.find((a) => a.id === pref('sendAs')[c.id]) ?? accounts[0])?.id ?? null;
}

/**
 * A direct or group conversation an online account can start a call in, ringing the others (capability 'ringCalls').
 */
export function canRing(c: P.ConversationView): string | null {
  if (c.shape !== 'direct' && c.shape !== 'group') return null;
  const able = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && a.capabilities.includes('calls') && a.capabilities.includes('ringCalls') && a.status === 'online');
  return (able.find((a) => a.id === pref('sendAs')[c.id]) ?? able[0])?.id ?? null;
}

/** The microphone this device uses in calls (Settings → Calls), and its handling. */
function micConstraints(input: P.CallInput): MediaTrackConstraints {
  const id = pref('callMicId');
  return { echoCancellation: true, noiseSuppression: input.noiseSuppression, autoGainControl: true, ...(id ? { deviceId: { ideal: id } } : {}) };
}

/** A silent microphone, for listening without one. */
function silentMic(): MediaStream {
  if (ctx) return ctx.createMediaStreamDestination().stream;
  return new MediaStream();
}

/**
 * Start from a click: the microphone prompt and audio playback both need the gesture. `ring`: ring the others (a DM or
 * group). The call's socket opens while the browser asks for the microphone, so the account starts joining at once.
 */
export async function startCall(conversationId: string, accountId: string, mode: P.CallMode, ring = false) {
  if (activeCall.value && activeCall.value.phase !== 'ended') leaveCall();
  // A voice message or video playing stops for the call (nowplaying.ts).
  pauseNowPlaying();
  clickAt = performance.now();
  speaker = new Audio();
  speaker.autoplay = true;
  // Unlocks playback on iOS while the click still counts.
  speaker.play().catch(() => {});
  try {
    ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    preloadCallSounds(ctx, callNetwork({ accountId }));
  } catch {
    ctx = null;
  }
  activeCall.value = { conversationId, accountId, mode, phase: 'connecting', muted: false, deafened: false, participants: [], since: Date.now(), effects: [], video: [], camera: false, screen: false, timing: {} };
  callMedia.value = { camera: null, screen: null, slots: new Map() };
  stageWas = null;
  speakAsked = false;
  const input = myInput();
  // A stage is joined listening: no microphone until you speak (takeMic), so nothing is open that nobody hears.
  const listening = db.conversations.get(conversationId)?.variant === 'stage';
  if (listening) mic = silentMic();
  const micReady = (listening ? Promise.resolve(null) : navigator.mediaDevices.getUserMedia({ audio: micConstraints(input), video: false }))
    .then((m) => {
      if (!m) return true;
      mic = m;
      micOpen = true;
      mark('mic');
      return true;
    })
    .catch((e: any) => {
      // Listening still works: a silent microphone, muted, and a word on why.
      mic = silentMic();
      patch({ listenOnly: true, muted: true, note: `No microphone (${e?.message ?? e}): listening only` });
      toast({ kind: 'error', title: 'No microphone', body: `${e?.message ?? e}. You can still listen.` });
      return false;
    });
  pendingMic = micReady;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/call`);
  ws = sock;
  sock.onopen = () => {
    mark('socket');
    sock.send(JSON.stringify({ op: 'join', account: accountId, conversation: conversationId, mode, ...(ring ? { ring: true } : {}), input } satisfies P.CallClientMessage));
  };
  sock.onmessage = (e) => void onServer(JSON.parse(e.data) as P.CallServerMessage);
  sock.onclose = () => {
    if (ws === sock) end(activeCall.value?.note ?? 'Call ended');
  };
}

let pendingMic: Promise<boolean> | null = null;

/** When a step of joining happened, ms after the click. */
function mark(step: keyof ActiveCall['timing']) {
  const a = activeCall.value;
  if (a && a.timing[step] === undefined) patch({ timing: { ...a.timing, [step]: Math.round(performance.now() - clickAt) } });
}

/** A call sound, if this device plays them (Settings → Calls). */
function sound(name: P.CallSoundName) {
  if (pref('callSounds') === false) return;
  const net = activeCall.value ? callNetwork(activeCall.value) : 'discord';
  void playCallSound(ctx, name, 0.6, net).then((as) => {
    if (as !== 'skipped') soundLog.push({ name, as, at: Date.now() });
  });
}
// For the call lab and the integration tests: the call as it stands, and the sounds it played.
Object.assign(globalThis, { __callSounds: soundLog, __activeCall: activeCall });

async function onServer(m: P.CallServerMessage) {
  const cur = activeCall.value;
  if (!cur) return;
  switch (m.t) {
    case 'joined': {
      mark('joined');
      // The hub carries a call in bridge mode where the network has no direct mode (every network but Discord).
      if (m.mode !== cur.mode) patch({ mode: m.mode });
      await pendingMic;
      if (!activeCall.value || activeCall.value.phase === 'ended') return;
      const host: TransportHost = {
        get mic() {
          return mic!;
        },
        speaker: speaker!,
        ctx,
        input: myInput(),
        sendSignal: (data) => send({ op: 'signal', data }),
        note: (data) => send({ op: 'note', data }),
        setSlot: (mid, track) => {
          const slots = new Map(callMedia.value.slots);
          slots.set(mid, new MediaStream([track]));
          callMedia.value = { ...callMedia.value, slots };
        },
        heard: () => mark('firstAudio'),
        setSpeaking: (id, on) => {
          speakingLocal.set(id, on);
          const a = activeCall.value;
          if (!a) return;
          const next = new Set(rawSpeaking);
          for (const p of a.participants) if (p.id === id || db.identities.get(p.id)?.nativeId === id) on ? next.add(p.id) : next.delete(p.id);
          heard(next);
          patch({ participants: a.participants });
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
      mark('live');
      // Direct mode is connected once its own transport is; bridge mode waits for the account's client to say so.
      if (m.mode === 'direct') connected();
      if (activeCall.value?.muted) transport.setMuted(true);
      startMeter();
      watchMutedMic();
      transport.setVolumes?.(volumesOf(activeCall.value?.participants ?? []));
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
      if (st.identities?.length) changed('identity');
      const participants = st.participants.map((p) => {
        const native = db.identities.get(p.id)?.nativeId;
        const local = native ? speakingLocal.get(native) : undefined;
        return cur.mode === 'direct' && local !== undefined ? { ...p, speaking: local } : p;
      });
      const before = cur.participants;
      heard(new Set(participants.filter((p) => p.speaking).map((p) => p.id)));
      patch({ participants, stage: st.stage, video: st.video ?? [], ...(st.self ? { self: st.self } : {}) });
      followStageRole();
      transport?.setVolumes?.(volumesOf(participants));
      if (st.self?.connected) connected();
      // Others coming and going, once this account is in (the list it finds on joining plays nothing).
      if (activeCall.value?.timing.connected !== undefined && before.length) {
        const was = new Set(before.map((p) => p.id));
        const now = new Set(participants.map((p) => p.id));
        if (participants.some((p) => !was.has(p.id) && !isCallSelf(cur, p.id))) sound('user_join');
        else if (before.some((p) => !now.has(p.id) && !isCallSelf(cur, p.id))) sound('user_leave');
        const live = (list: P.CallParticipant[]) => new Set(list.filter((p) => p.streaming && !isCallSelf(cur, p.id)).map((p) => p.id));
        const liveBefore = live(before);
        if ([...live(participants)].some((id) => !liveBefore.has(id))) sound('stream_started');
      }
      return;
    }
    case 'effect': {
      const now = Date.now();
      patch({ effects: [...cur.effects.filter((e) => now - e.at < EFFECT_MS), { at: now, effect: m.effect }].slice(-5) });
      setTimeout(() => {
        const a = activeCall.value;
        if (a) patch({ effects: a.effects.filter((e) => Date.now() - e.at < EFFECT_MS) });
      }, EFFECT_MS + 50);
      return;
    }
    case 'sounds':
      patch({ sounds: { list: m.sounds, ...(m.reason ? { reason: m.reason } : {}) } });
      return;
    case 'ended':
      patch({ note: m.reason });
      end(m.reason);
      return;
    case 'error':
      // A Speak the network refused: back to listening, microphone closed.
      if (speakAsked) {
        speakAsked = false;
        if (activeCall.value && callRole(activeCall.value) !== 'speaker') releaseMic();
      }
      toast({ kind: 'error', title: 'Call', body: m.message });
      patch({ note: m.message });
      return;
  }
}

function send(m: P.CallClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

export function leaveCall() {
  if (activeCall.value && activeCall.value.phase !== 'ended') sound('disconnect');
  send({ op: 'leave' });
  end(activeCall.value?.note ?? 'You left');
}

/** This account is in: its client's voice connection is up (bridge), or this device's own is (direct). Once a call. */
function connected() {
  const a = activeCall.value;
  if (!a || a.timing.connected !== undefined) return;
  mark('connected');
  sound('user_join');
}

export function setMuted(muted: boolean) {
  const a = activeCall.value;
  if (!a) return;
  // Undeafening by unmuting, as Discord does.
  const deafened = muted ? a.deafened : false;
  transport?.setMuted(muted);
  transport?.setDeafened(deafened);
  if (a.deafened && !deafened) sound('undeafen');
  else sound(muted ? 'mute' : 'unmute');
  patch({ muted, deafened });
  send({ op: 'mute', muted, deafened });
  watchMutedMic();
}

export function setDeafened(deafened: boolean) {
  const a = activeCall.value;
  if (!a) return;
  const muted = deafened ? true : a.muted;
  transport?.setMuted(muted);
  transport?.setDeafened(deafened);
  sound(deafened ? 'deafen' : 'undeafen');
  patch({ muted, deafened });
  send({ op: 'mute', muted, deafened });
  watchMutedMic();
}

/** This device's microphone choices (Settings → Calls). */
export function myInput(): P.CallInput {
  return callInput(pref('callInput') ?? CALL_INPUT_DEFAULT);
}

/** The people's volumes and mutes for this account, by native user id (what the direct transport plays by). */
function volumesOf(participants: P.CallParticipant[]): Map<string, { volume: number; muted: boolean }> {
  const out = new Map<string, { volume: number; muted: boolean }>();
  for (const p of participants) {
    const native = db.identities.get(p.id)?.nativeId;
    if (native && (p.volume !== undefined || p.localMute)) out.set(native, { volume: p.volume ?? 100, muted: !!p.localMute });
  }
  return out;
}

/**
 * Is this participant the account in the call itself? Not "any of the owner's identities": a call between two of the
 * owner's own accounts has the other one in it as anybody else.
 */
export function isCallSelf(call: Pick<ActiveCall, 'accountId'>, identityId: string): boolean {
  return db.accounts.get(call.accountId)?.selfIdentityId === identityId;
}

/** A person in a call, by name: another of the owner's own accounts is named as that account, not "You". */
export function callName(identityId: string): string {
  const i = db.identities.get(identityId);
  const person = i?.personId && !isSelfIdentity(identityId) ? db.persons.get(i.personId) : null;
  return person?.name ?? i?.displayName ?? i?.handle ?? 'Someone';
}

/** Your role in the call: a stage role, or null in a call without an audience. */
export function callRole(call: ActiveCall): P.StageRole | null {
  if (!call.stage) return null;
  return call.participants.find((p) => isCallSelf(call, p.id))?.stage ?? 'audience';
}

/** What you may do on this stage now, for yourself and to others (callmarks.ts stageCan): nothing outside a stage. */
export function callStageCan(call: ActiveCall): { can: P.StageSelfAction[]; canOn: P.StageMove[] } {
  return stageCan(call, { role: callRole(call), rank: call.participants.find((p) => isCallSelf(call, p.id))?.stageRank, stage: !!db.accounts.get(call.accountId)?.capabilities.includes('stage') });
}

/**
 * Who asks to speak, oldest first, when you may invite them (an empty list otherwise): what a room's Room tab counts
 * and a call bar can show to a moderator who isn't looking at the room.
 */
export function roomRequests(call: ActiveCall | null): P.CallParticipant[] {
  if (!call?.stage || call.phase === 'ended' || !callStageCan(call).canOn.includes('invite')) return [];
  return requestsOf(call.participants, (id) => isCallSelf(call, id));
}

/** The call's status line (callmarks.ts statusFor): Connecting…, Connecting to Discord…, 1:15:03, why it ended; and a hint. */
export function callStatus(call: ActiveCall, now: number): CallStatus {
  return statusFor(call, now, NETWORK_META[callNetwork(call)].name);
}

/** The buttons your role and the call's state give you (callmarks.ts controlsFor); ui/CallControls.tsx draws them. */
export function callControls(call: ActiveCall): CallControl[] {
  const rank = call.participants.find((p) => isCallSelf(call, p.id))?.stageRank;
  return controlsFor(call, { role: callRole(call), ...(rank ? { rank } : {}), video: activeCall.value === call && canVideo(), share: canShareScreen(), stage: !!db.accounts.get(call.accountId)?.capabilities.includes('stage') });
}

/** Can the account in this call do it? */
export function callCan(cap: P.Capability): boolean {
  const a = activeCall.value;
  return !!a && !!db.accounts.get(a.accountId)?.capabilities.includes(cap);
}

/** One person's volume (0 to VOLUME_MAX) or mute in this call, for this account only. Shown at once; the state confirms. */
export function setPersonVolume(identityId: string, change: { volume?: number; muted?: boolean }) {
  const a = activeCall.value;
  if (!a) return;
  const participants = a.participants.map((p) => (p.id === identityId ? { ...p, ...(change.volume !== undefined ? { volume: change.volume } : {}), ...(change.muted !== undefined ? { localMute: change.muted } : {}) } : p));
  patch({ participants });
  transport?.setVolumes?.(volumesOf(participants));
  send({ op: 'local', user: identityId, ...change });
}

/** The microphone's handling changed in Settings: the live call follows. */
export function applyCallInput(input: P.CallInput) {
  if (!activeCall.value || activeCall.value.phase === 'ended') return;
  mic?.getAudioTracks().forEach((t) => void t.applyConstraints({ ...t.getConstraints(), noiseSuppression: input.noiseSuppression }).catch(() => {}));
  transport?.setInput?.(input);
  send({ op: 'input', input });
}

/**
 * A stage action; `user` (an identity id) for a moderator's invite or move to the audience. Speak opens the
 * microphone first (from the click, so the browser may ask), and goes ahead only once it is open; going back to
 * listening closes it.
 */
export async function stageAction(action: P.StageAction, user?: string) {
  if (action === 'speak') {
    if (!(await takeMic())) return;
    speakAsked = true;
  }
  send({ op: 'stage', action, ...(user ? { user } : {}) });
  if (action === 'listen') releaseMic();
}

/** Your stage role as the last state said it, to see it change. */
let stageWas: P.StageRole | null = null;
/** A Speak went out and the stage has not made you a speaker yet. */
let speakAsked = false;

/** Your role changed on the stage: made a speaker, the microphone opens; moved back to the audience, it closes. */
function followStageRole() {
  const a = activeCall.value;
  const role = a && a.phase !== 'ended' ? callRole(a) : null;
  const was = stageWas;
  stageWas = role;
  if (!role || role === was) return;
  if (role === 'speaker') {
    speakAsked = false;
    if (!micOpen) void takeMic();
  } else if (was === 'speaker') releaseMic();
}

let micTaking: Promise<boolean> | null = null;

/** The browser's microphone into the call, in place of the silent one. False when there is none (said in a toast). */
function takeMic(): Promise<boolean> {
  if (micOpen) return Promise.resolve(true);
  return (micTaking ??= (async () => {
    const t = transport;
    let m: MediaStream;
    try {
      m = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(myInput()), video: false });
    } catch (e: any) {
      toast({ kind: 'error', title: 'No microphone', body: `${e?.message ?? e}. You can still listen.` });
      return false;
    }
    // The call ended (or another began) while the browser asked.
    if (!t || !sameCall(t)) {
      m.getTracks().forEach((x) => x.stop());
      return false;
    }
    const silent = mic;
    mic = m;
    micOpen = true;
    const muted = !!activeCall.value?.muted;
    m.getAudioTracks().forEach((x) => (x.enabled = !muted));
    await t.setMic?.();
    silent?.getTracks().forEach((x) => x.stop());
    if (activeCall.value?.listenOnly) patch({ listenOnly: false, note: undefined });
    watchMutedMic();
    return true;
  })().finally(() => (micTaking = null)));
}

/** Back to the silent microphone: the browser's closes, so nothing listens while you only listen. */
function releaseMic() {
  if (!micOpen) return;
  const real = mic;
  mic = silentMic();
  micOpen = false;
  void transport?.setMic?.();
  real?.getTracks().forEach((x) => x.stop());
  watchMutedMic();
}

/** Ask once for the sounds this account may play here. */
export function askSounds() {
  const a = activeCall.value;
  if (!a || a.sounds !== undefined) return;
  patch({ sounds: null });
  send({ op: 'sounds' });
}

export function playSound(s: P.CallSound) {
  send({ op: 'sound', sound: s.id, guild: s.guild });
}

/** Video goes through bridge mode, from an account whose adapter can send it. */
function canVideo(): boolean {
  const a = activeCall.value;
  return !!a && a.mode === 'bridge' && a.phase === 'live' && callCan('callVideo') && !!transport?.setCamera;
}

/** This device's camera into the call, as the account's camera; or off. */
/** The call a camera or screen was asked for is still the one going on, after waiting on the browser's prompt. */
function sameCall(t: Transport): boolean {
  return transport === t && activeCall.value?.phase !== 'ended';
}

export async function setCamera(on: boolean) {
  const a = activeCall.value;
  const t = transport;
  if (!a || !t?.setCamera) return;
  if (on) {
    let cam: MediaStream;
    try {
      const id = pref('callCameraId');
      cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, ...(id ? { deviceId: { ideal: id } } : {}) }, audio: false });
    } catch (e: any) {
      toast({ kind: 'error', title: 'No camera', body: String(e?.message ?? e) });
      return;
    }
    // The call ended (or another began) while the browser asked for the camera.
    if (!sameCall(t)) return cam.getTracks().forEach((x) => x.stop());
    const track = cam.getVideoTracks()[0]!;
    track.contentHint = 'motion';
    track.addEventListener('ended', () => void setCamera(false));
    await t.setCamera(track);
    callMedia.value = { ...callMedia.value, camera: cam };
    patch({ camera: true });
    sound('camera_on');
  } else {
    callMedia.value.camera?.getTracks().forEach((x) => x.stop());
    await t.setCamera(null);
    callMedia.value = { ...callMedia.value, camera: null };
    if (a.camera) sound('camera_off');
    patch({ camera: false });
  }
  sendVideo();
}

/** Can this browser share a screen or a window at all (phones' browsers cannot). */
const canShareScreen = () => typeof navigator.mediaDevices?.getDisplayMedia === 'function';

/** This device's screen, a window or a tab into the call, as the account's Go Live; or off. */
export async function setScreen(on: boolean) {
  const a = activeCall.value;
  const t = transport;
  if (!a || !t?.setScreen) return;
  if (on) {
    let scr: MediaStream;
    try {
      scr = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    } catch (e: any) {
      if (e?.name !== 'NotAllowedError') toast({ kind: 'error', title: 'Could not share', body: String(e?.message ?? e) });
      return;
    }
    // The call ended (or another began) while the browser asked what to share.
    if (!sameCall(t)) return scr.getTracks().forEach((x) => x.stop());
    const video = scr.getVideoTracks()[0]!;
    video.contentHint = 'detail';
    // The browser's own Stop sharing ends it here too.
    video.addEventListener('ended', () => void setScreen(false));
    await t.setScreen(video, scr.getAudioTracks()[0] ?? null);
    callMedia.value = { ...callMedia.value, screen: scr };
    patch({ screen: true });
    sound('stream_started');
  } else {
    callMedia.value.screen?.getTracks().forEach((x) => x.stop());
    await t.setScreen(null, null);
    callMedia.value = { ...callMedia.value, screen: null };
    if (a.screen) sound('stream_ended');
    patch({ screen: false });
  }
  sendVideo();
}

function sendVideo() {
  const a = activeCall.value;
  if (!a) return;
  send({ op: 'video', camera: a.camera, screen: a.screen, ...(callMedia.value.screen?.getAudioTracks().length ? { screenAudio: true } : {}) });
}

/** Watch someone's Go Live (their screen comes on a video slot), or stop. */
export function watchStream(identityId: string, on: boolean) {
  send({ op: 'watch', user: identityId, on });
}

/**
 * The microphone's loudness for the dock's meter, four times a second, from what the browser says it sends (its stats'
 * audioLevel): no Web Audio graph of its own, which would keep the audio thread busy for the whole call.
 */
function startMeter() {
  meterTimer = setInterval(async () => {
    const level = await transport?.micLevel?.().catch(() => null);
    if (level !== null && level !== undefined) {
      // audioLevel is linear 0 to 1: shown as -60 dBFS to 0, in steps the eye can tell.
      const shown = Math.round(levelShown(level) * 20) / 20;
      if (shown !== micLevel.value) micLevel.value = shown;
    }
    readLevels();
  }, 250);
}

/**
 * Direct mode, on the meter's own tick and only while someone speaks: each speaking person's loudness, so their ring's
 * strength follows it; yours is the microphone's. Bridge mode has one mixed stream, so no level per person.
 */
function readLevels() {
  const a = activeCall.value;
  const speaking = a?.participants.filter((p) => p.speaking) ?? [];
  if (!a || a.mode !== 'direct' || !transport?.peerLevels || !speaking.length) {
    if (callLevels.value.size) callLevels.value = new Map();
    return;
  }
  const got = transport.peerLevels();
  const next = new Map<string, number>();
  for (const p of speaking) {
    const native = db.identities.get(p.id)?.nativeId;
    const raw = isCallSelf(a, p.id) ? micLevel.value : native !== undefined && got.has(native) ? levelShown(got.get(native)!) : null;
    if (raw !== null) next.set(p.id, Math.round(smoothLevel(callLevels.value.get(p.id) ?? 0, raw) * 20) / 20);
  }
  callLevels.value = next;
}

/**
 * The microphone while muted: off to the call, but listened to here (a clone of it, through a Web Audio analyser only
 * while muted), against your sensitivity or the automatic gate's level, so you can be told you are talking into a muted
 * microphone (callmarks.ts talkGate: after half a second of talk, until three seconds of quiet).
 */
let mutedWatch: (() => void) | null = null;
function watchMutedMic() {
  const a = activeCall.value;
  const track = mic?.getAudioTracks()[0];
  if (!a || !a.muted || a.phase !== 'live' || a.listenOnly || !micOpen || !track || !ctx) {
    mutedWatch?.();
    mutedWatch = null;
    mutedGate.clear();
    return;
  }
  if (mutedWatch) return;
  const copy = track.clone();
  copy.enabled = true;
  const src = ctx.createMediaStreamSource(new MediaStream([copy]));
  const meter = ctx.createAnalyser();
  meter.fftSize = 1024;
  src.connect(meter);
  const buf = new Float32Array(meter.fftSize);
  const timer = setInterval(() => {
    meter.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    const db = 10 * Math.log10(sum / buf.length + 1e-12);
    const s = myInput().sensitivity;
    mutedGate.update(db > (s === 'auto' ? AUTO_GATE_DB : s));
  }, 100);
  mutedWatch = () => {
    clearInterval(timer);
    src.disconnect();
    copy.stop();
  };
}

/** The level of what a peer connection sends from the microphone, from its stats. */
export async function sentAudioLevel(pc: RTCPeerConnection, track: MediaStreamTrack | undefined): Promise<number | null> {
  if (!track) return null;
  let level: number | null = null;
  (await pc.getStats(track)).forEach((r: any) => {
    if (r.type === 'media-source' && r.kind === 'audio' && typeof r.audioLevel === 'number') level = r.audioLevel;
  });
  return level;
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
  micOpen = false;
  stageWas = null;
  speakAsked = false;
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = null;
  micLevel.value = 0;
  watchMutedMic();
  rawSpeaking = new Set();
  speakingHeld.clear();
  picker.clear();
  callLevels.value = new Map();
  callMedia.value.camera?.getTracks().forEach((t) => t.stop());
  callMedia.value.screen?.getTracks().forEach((t) => t.stop());
  callMedia.value = { camera: null, screen: null, slots: new Map() };
  if (speaker) speaker.srcObject = null;
  speaker = null;
  // A moment for the hang-up sound to finish.
  const closing = ctx;
  setTimeout(() => void closing?.close().catch(() => {}), 1500);
  ctx = null;
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
  const t: Record<string, RTCRtpTransceiver> = {};
  return {
    async start(joined) {
      pc = new RTCPeerConnection({ iceServers: joined.iceServers });
      // Fixed m-lines (protocol BRIDGE_MIDS), in this order: nothing renegotiates when a camera or a stream starts.
      const track = host.mic.getAudioTracks()[0];
      t.audio = pc.addTransceiver(track ?? 'audio', { direction: 'sendrecv', streams: [host.mic] });
      t.camera = pc.addTransceiver('video', { direction: 'sendonly', sendEncodings: [{ maxBitrate: 1_500_000, maxFramerate: 30 }] });
      t.screen = pc.addTransceiver('video', { direction: 'sendonly', sendEncodings: [{ maxBitrate: 2_500_000, maxFramerate: 30 }] });
      t.screenAudio = pc.addTransceiver('audio', { direction: 'sendonly' });
      for (const _ of BRIDGE_MIDS.video) pc.addTransceiver('video', { direction: 'recvonly' });
      pc.ontrack = (e) => {
        const mid = e.transceiver?.mid;
        if (e.track.kind === 'video') {
          if (mid && (BRIDGE_MIDS.video as readonly string[]).includes(mid)) host.setSlot?.(mid, e.track);
          return;
        }
        if (mid !== BRIDGE_MIDS.audio) return;
        host.speaker.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        host.speaker.play().catch(() => {});
        e.track.addEventListener('unmute', () => host.heard?.(), { once: true });
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
    async setCamera(track) {
      await t.camera?.sender.replaceTrack(track);
    },
    async setScreen(video, audio) {
      await t.screen?.sender.replaceTrack(video);
      await t.screenAudio?.sender.replaceTrack(audio);
    },
    async setMic() {
      await t.audio?.sender.replaceTrack(host.mic.getAudioTracks()[0] ?? null);
    },
    stats: () => (pc ? peerStats(pc) : Promise.resolve(null)),
    micLevel: () => (pc ? sentAudioLevel(pc, host.mic.getAudioTracks()[0]) : Promise.resolve(null)),
    stop() {
      pc?.close();
      pc = null;
    },
  };
}

/** The loudest of what a receiver gets now, 0 to 1 (its RTP level header; no stats, no audio graph). */
export function receiverLevel(r: RTCRtpReceiver): number {
  let level = 0;
  for (const s of r.getSynchronizationSources?.() ?? []) level = Math.max(level, s.audioLevel ?? 0);
  return level;
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
  let videoIn: CallStats['videoIn'] = null;
  let videoOut: CallStats['videoOut'] = null;
  let inLevel: number | null = null;
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
    if (r.type === 'inbound-rtp' && r.kind === 'video' && (r.framesPerSecond ?? 0) > (videoIn?.fps ?? -1)) videoIn = { fps: Math.round(r.framesPerSecond ?? 0), width: r.frameWidth ?? 0, height: r.frameHeight ?? 0 };
    if (r.type === 'outbound-rtp' && r.kind === 'video' && (r.framesPerSecond ?? 0) > (videoOut?.fps ?? -1)) videoOut = { fps: Math.round(r.framesPerSecond ?? 0), width: r.frameWidth ?? 0, height: r.frameHeight ?? 0 };
    if (r.type === 'inbound-rtp' && r.kind === 'audio' && typeof r.audioLevel === 'number') inLevel = Math.max(inLevel ?? 0, r.audioLevel);
    if (r.type === 'inbound-rtp' && r.kind === 'audio') {
      jitterMs = r.jitter != null ? Math.round(r.jitter * 1000) : jitterMs;
      packetsLost += r.packetsLost ?? 0;
      codec = byId.get(r.codecId)?.mimeType ?? codec;
    }
  });
  return { sent, received, rttMs, jitterMs, packetsLost, codec, path, videoIn, videoOut, inLevel };
}

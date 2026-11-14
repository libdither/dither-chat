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
import { BRIDGE_MIDS, CALL_INPUT_DEFAULT, callInput } from '@dither-chat/protocol';
import { playCallSound, preloadCallSounds, soundLog } from './callsounds.ts';
import { changed, db, prefs, toast } from './state.ts';

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
  stop(): void;
}

export interface TransportHost {
  mic: MediaStream;
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
let speaker: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let meterTimer: ReturnType<typeof setInterval> | null = null;
let clickAt = 0;
/** Direct mode's own speaking news, laid over the sandbox's participant list. */
const speakingLocal = new Map<string, boolean>();

const patch = (p: Partial<ActiveCall>) => {
  if (activeCall.value) activeCall.value = { ...activeCall.value, ...p };
};

/** A voice channel's account to call from: the one chosen to send as in this chat, else the first online one that can. */
export function canCall(c: P.ConversationView): string | null {
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && a.capabilities.includes('calls') && a.status === 'online');
  if (c.variant !== 'voice') return null;
  return (accounts.find((a) => a.id === prefs.value.sendAs[c.id]) ?? accounts[0])?.id ?? null;
}

/**
 * A direct or group conversation an online account can start a call in, ringing the others (capability 'ringCalls').
 */
export function canRing(c: P.ConversationView): string | null {
  if (c.shape !== 'direct' && c.shape !== 'group') return null;
  const able = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a && a.capabilities.includes('calls') && a.capabilities.includes('ringCalls') && a.status === 'online');
  return (able.find((a) => a.id === prefs.value.sendAs[c.id]) ?? able[0])?.id ?? null;
}

/** The microphone this device uses in calls (Settings → Calls), and its handling. */
function micConstraints(input: P.CallInput): MediaTrackConstraints {
  const id = prefs.value.callMicId;
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
  clickAt = performance.now();
  speaker = new Audio();
  speaker.autoplay = true;
  // Unlocks playback on iOS while the click still counts.
  speaker.play().catch(() => {});
  try {
    ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    preloadCallSounds(ctx);
  } catch {
    ctx = null;
  }
  activeCall.value = { conversationId, accountId, mode, phase: 'connecting', muted: false, deafened: false, participants: [], since: Date.now(), effects: [], video: [], camera: false, screen: false, timing: {} };
  callMedia.value = { camera: null, screen: null, slots: new Map() };
  const input = myInput();
  const micReady = navigator.mediaDevices
    .getUserMedia({ audio: micConstraints(input), video: false })
    .then((m) => {
      mic = m;
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
  if (prefs.value.callSounds === false) return;
  void playCallSound(ctx, name).then((as) => {
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
      await pendingMic;
      if (!activeCall.value || activeCall.value.phase === 'ended') return;
      const host: TransportHost = {
        mic: mic!,
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
      mark('live');
      // Direct mode is connected once its own transport is; bridge mode waits for the account's client to say so.
      if (m.mode === 'direct') connected();
      if (activeCall.value?.muted) transport.setMuted(true);
      startMeter();
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
      if (st.identities?.length) changed('shown');
      const participants = st.participants.map((p) => {
        const native = db.identities.get(p.id)?.nativeId;
        const local = native ? speakingLocal.get(native) : undefined;
        return cur.mode === 'direct' && local !== undefined ? { ...p, speaking: local } : p;
      });
      const before = cur.participants;
      patch({ participants, stage: st.stage, video: st.video ?? [], ...(st.self ? { self: st.self } : {}) });
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
}

/** This device's microphone choices (Settings → Calls). */
export function myInput(): P.CallInput {
  return callInput(prefs.value.callInput ?? CALL_INPUT_DEFAULT);
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

/** A stage action; `user` (an identity id) for a moderator's invite or move to the audience. */
export function stageAction(action: P.StageAction, user?: string) {
  send({ op: 'stage', action, ...(user ? { user } : {}) });
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
export function canVideo(): boolean {
  const a = activeCall.value;
  return !!a && a.mode === 'bridge' && a.phase === 'live' && callCan('callVideo') && !!transport?.setCamera;
}

/** This device's camera into the call, as the account's camera; or off. */
export async function setCamera(on: boolean) {
  const a = activeCall.value;
  if (!a || !transport?.setCamera) return;
  if (on) {
    let cam: MediaStream;
    try {
      const id = prefs.value.callCameraId;
      cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, ...(id ? { deviceId: { ideal: id } } : {}) }, audio: false });
    } catch (e: any) {
      toast({ kind: 'error', title: 'No camera', body: String(e?.message ?? e) });
      return;
    }
    const track = cam.getVideoTracks()[0]!;
    track.contentHint = 'motion';
    track.addEventListener('ended', () => void setCamera(false));
    await transport.setCamera(track);
    callMedia.value = { ...callMedia.value, camera: cam };
    patch({ camera: true });
    sound('camera_on');
  } else {
    callMedia.value.camera?.getTracks().forEach((t) => t.stop());
    await transport.setCamera(null);
    callMedia.value = { ...callMedia.value, camera: null };
    if (a.camera) sound('camera_off');
    patch({ camera: false });
  }
  sendVideo();
}

/** Can this browser share a screen or a window at all (phones' browsers cannot). */
export const canShareScreen = () => typeof navigator.mediaDevices?.getDisplayMedia === 'function';

/** This device's screen, a window or a tab into the call, as the account's Go Live; or off. */
export async function setScreen(on: boolean) {
  const a = activeCall.value;
  if (!a || !transport?.setScreen) return;
  if (on) {
    let scr: MediaStream;
    try {
      scr = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    } catch (e: any) {
      if (e?.name !== 'NotAllowedError') toast({ kind: 'error', title: 'Could not share', body: String(e?.message ?? e) });
      return;
    }
    const video = scr.getVideoTracks()[0]!;
    video.contentHint = 'detail';
    // The browser's own Stop sharing ends it here too.
    video.addEventListener('ended', () => void setScreen(false));
    await transport.setScreen(video, scr.getAudioTracks()[0] ?? null);
    callMedia.value = { ...callMedia.value, screen: scr };
    patch({ screen: true });
    sound('stream_started');
  } else {
    callMedia.value.screen?.getTracks().forEach((t) => t.stop());
    await transport.setScreen(null, null);
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
    if (level === null || level === undefined) return;
    // audioLevel is linear 0 to 1: shown as -60 dBFS to 0, in steps the eye can tell.
    const shown = Math.round(Math.max(0, Math.min(1, (20 * Math.log10(level + 1e-9) + 60) / 60)) * 20) / 20;
    if (shown !== micLevel.value) micLevel.value = shown;
  }, 250);
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
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = null;
  micLevel.value = 0;
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
    stats: () => (pc ? peerStats(pc) : Promise.resolve(null)),
    micLevel: () => (pc ? sentAudioLevel(pc, host.mic.getAudioTracks()[0]) : Promise.resolve(null)),
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

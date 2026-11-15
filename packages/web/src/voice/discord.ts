/**
 * Discord's voice protocol, spoken by this device (direct mode).
 *
 * The account's sandbox joins the channel and hands over a voice server and a token for this one
 * connection (see adapter-discord's hook). This client then does what Discord's web client does:
 *
 *   voice gateway  JSON + binary frames over a WebSocket, which the hub forwards (/api/call/<id>/voice)
 *   media          one RTCPeerConnection, relayed through the hub's TURN server, so Discord sees
 *                  the hub's address and never this device's
 *   encryption     DAVE, in a worker running Discord's own libdave (dave-worker.ts)
 *
 * Written from a study of the public web client's behaviour (docs/calls.md), not from its code.
 * Audio only for now (video: docs/calls.md "Receiving camera video"). Each person's audio arrives on its own receive
 * slot, so a person muted for this account is left out of what plays here, and one at another volume plays through a
 * gain of its own.
 */

import type * as P from '@dither-chat/protocol';
import { VOLUME_MAX } from '@dither-chat/protocol';
import { peerStats, sentAudioLevel, type Transport, type TransportHost } from '../call.ts';
import { daveWorkerSource } from './dave-worker.ts';
import { answer, codecPt, firstSsrc, offerForServer } from './sdp.ts';

const GATEWAY_VERSION = 9;
/** Close codes after which the server will not take this session back. */
const FINAL = new Set([4004, 4006, 4011, 4014, 4015, 4016]);

type Session = P.DirectVoiceSession;

export function discordTransport(host: TransportHost): Transport {
  let joined: Extract<P.CallServerMessage, { t: 'joined' }>;
  let session: Session;
  let ws: WebSocket | null = null;
  let pc: RTCPeerConnection | null = null;
  let worker: Worker | null = null;
  let workerOrigin = '';
  let maxDave = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lastSeq = -1;
  let ownSsrc = 0;
  let serverSdp = '';
  let opusPt = 111;
  let stopped = false;
  let speaking = false;
  let vadStop: (() => void) | null = null;
  const remote = new MediaStream();
  /** user id -> audio ssrc */
  const userSsrc = new Map<string, number>();
  /** mid -> the remote stream assigned to it */
  const assigned = new Map<string, { id: string; ssrc: number }>();
  const freeSlots: RTCRtpTransceiver[] = [];
  let renegotiating: Promise<void> = Promise.resolve();
  const counts = { encrypted: 0, decrypted: 0, dropped: 0, passthrough: 0 };
  let secureVersion = 0;
  /** mid -> the remote audio track on it. */
  const tracks = new Map<string, MediaStreamTrack>();
  /** mid -> its own way out, for a person at another volume. */
  const routed = new Map<string, { gain: GainNode; src: MediaStreamAudioSourceNode; el: HTMLAudioElement }>();
  let volumes = new Map<string, { volume: number; muted: boolean }>();
  let deaf = false;
  let vadLevel = vadLevelOf(host.input);

  const send = (op: number, d: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op, d }));
  const sendBinary = (op: number, data: Uint8Array) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const buf = new Uint8Array(data.byteLength + 1);
    buf[0] = op;
    buf.set(data, 1);
    ws.send(buf);
  };

  // ---------------------------------------------------------------- DAVE worker

  async function startWorker(): Promise<void> {
    const info = await fetch('/api/voice/dave').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!info?.module) return; // no library on the hub: identify with DAVE 0 and let the server decide
    const src = daveWorkerSource();
    // A data: URL gives the worker an opaque origin. Some browsers refuse those; then it is a blob of this origin.
    const make = (url: string) => new Worker(url, { type: 'module', name: 'dave' });
    let w: Worker;
    try {
      w = make('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
    } catch {
      w = make(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    }
    worker = w;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.t === 'ready') {
          maxDave = m.maxVersion;
          workerOrigin = m.origin;
          clearTimeout(timer);
          resolve();
        } else if (m.t === 'load-failed') {
          console.warn('DAVE did not load:', m.error);
          clearTimeout(timer);
          resolve();
        } else onWorker(m);
      };
      w.onerror = () => {
        clearTimeout(timer);
        resolve();
      };
      w.postMessage({ t: 'load', url: new URL(info.module, location.href).href });
    });
    w.onmessage = (e) => onWorker(e.data);
  }

  function onWorker(m: any) {
    switch (m.t) {
      case 'send-binary':
        sendBinary(m.op, m.data);
        return;
      case 'transition-ready':
        if (m.tid !== 0) send(23, { transition_id: m.tid });
        return;
      case 'invalid':
        send(31, { transition_id: m.tid });
        return;
      case 'secure':
        secureVersion = m.version;
        return;
      case 'counts':
        Object.assign(counts, m);
        return;
      case 'mls-failure':
      case 'error':
        console.warn('DAVE:', m);
        return;
    }
  }

  // ---------------------------------------------------------------- gateway

  function connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${joined.direct!.socket}?v=${GATEWAY_VERSION}`;
    const sock = new WebSocket(url);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () =>
      send(0, {
        server_id: session.serverId,
        channel_id: session.channelId,
        user_id: session.userId,
        session_id: session.sessionId,
        token: session.token,
        max_dave_protocol_version: maxDave,
        video: false,
        streams: [],
      });
    sock.onmessage = (e) => (typeof e.data === 'string' ? onJson(JSON.parse(e.data)) : onBinary(new Uint8Array(e.data)));
    sock.onclose = (e) => {
      if (ws !== sock || stopped) return;
      if (heartbeat) clearInterval(heartbeat);
      host.fail(FINAL.has(e.code) ? `Discord ended the voice session (${e.code}${e.reason ? `: ${e.reason}` : ''}).` : `The voice connection closed (${e.code}${e.reason ? `: ${e.reason}` : ''}).`);
    };
  }

  function onJson(m: { op: number; d: any; seq?: number }) {
    if (m.seq) lastSeq = m.seq;
    const d = m.d;
    switch (m.op) {
      case 8: // HELLO
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = setInterval(() => send(3, { t: Date.now(), seq_ack: lastSeq }), Math.min(d.heartbeat_interval, 5000));
        return;
      case 2: // READY
        send(16, {});
        void startMedia();
        return;
      case 4: // SESSION_DESCRIPTION
        void onSessionDescription(d);
        return;
      case 5: // SPEAKING
        if (d.user_id && d.user_id !== session.userId) onRemoteSpeaking(String(d.user_id), Number(d.ssrc), Number(d.speaking));
        return;
      case 11: // CLIENTS_CONNECT
        worker?.postMessage({ t: 'user-add', ids: (d.user_ids as string[]).map(String) });
        return;
      case 13: // CLIENT_DISCONNECT
        onRemoteLeft(String(d.user_id));
        return;
      case 21:
        worker?.postMessage({ t: 'prepare-transition', tid: d.transition_id, version: d.protocol_version });
        return;
      case 22:
        worker?.postMessage({ t: 'execute-transition', tid: d.transition_id });
        return;
      case 24:
        worker?.postMessage({ t: 'prepare-epoch', epoch: d.epoch, version: d.protocol_version });
        return;
    }
  }

  /** Server binary frames: [seq u16][op u8][payload]; ops 29 and 30 carry [transition id u16] first. */
  function onBinary(b: Uint8Array) {
    if (b.byteLength < 3) return;
    lastSeq = (b[0]! << 8) | b[1]!;
    const op = b[2]!;
    const payload = b.slice(3);
    const tid = payload.byteLength >= 2 ? (payload[0]! << 8) | payload[1]! : 0;
    switch (op) {
      case 25:
        worker?.postMessage({ t: 'external-sender', data: payload });
        return;
      case 27:
        worker?.postMessage({ t: 'proposals', data: payload });
        return;
      case 29:
        worker?.postMessage({ t: 'commit', tid, data: payload.slice(2) });
        return;
      case 30:
        worker?.postMessage({ t: 'welcome', tid, data: payload.slice(2) });
        return;
    }
  }

  // ---------------------------------------------------------------- media

  function transforms(t: RTCRtpTransceiver, send: boolean) {
    if (!worker) return;
    const RST = (globalThis as any).RTCRtpScriptTransform;
    if (RST) {
      if (send) (t.sender as any).transform = new RST(worker, { operation: 0 });
      (t.receiver as any).transform = new RST(worker, { operation: 1 });
      return;
    }
    // Chrome before RTCRtpScriptTransform: the legacy streams API.
    const pair = (end: any, operation: number) => {
      const { readable, writable } = end.createEncodedStreams();
      worker!.postMessage({ t: 'rtc-transform', operation, readable, writable }, [readable, writable]);
    };
    if (send) pair(t.sender, 0);
    pair(t.receiver, 1);
  }

  async function startMedia() {
    const relay = joined.direct!.relayOnly;
    const legacy = !!worker && !(globalThis as any).RTCRtpScriptTransform;
    pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: joined.iceServers, iceTransportPolicy: relay ? 'relay' : 'all', ...(legacy ? { encodedInsertableStreams: true } : {}) } as RTCConfiguration);
    const track = host.mic.getAudioTracks()[0]!;
    const t0 = pc.addTransceiver(track, { direction: 'sendrecv', streams: [host.mic], sendEncodings: [{ maxBitrate: 64_000 }] });
    transforms(t0, true);
    pc.ontrack = (e) => {
      if (e.track.kind !== 'audio') return;
      const mid = e.transceiver?.mid;
      if (mid) tracks.set(mid, e.track);
      else remote.addTrack(e.track);
      host.speaker.srcObject = remote;
      outputs();
      host.speaker.play().catch(() => {});
      e.track.addEventListener('unmute', () => host.heard?.(), { once: true });
    };
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'failed') {
        send(32, {}); // NO_ROUTE
        host.fail('The media link through the hub failed.');
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    const local = pc.localDescription!.sdp;
    ownSsrc = firstSsrc(local);
    opusPt = codecPt(local, 'opus') ?? 111;
    send(1, {
      protocol: 'webrtc',
      data: offerForServer(local),
      sdp: offerForServer(local),
      codecs: [{ name: 'opus', type: 'audio', priority: 1000, payload_type: opusPt, rtx_payload_type: null }],
      rtc_connection_id: crypto.randomUUID(),
    });
  }

  async function onSessionDescription(d: any) {
    serverSdp = String(d.sdp ?? '');
    worker?.postMessage({ t: 'codec', audio: d.audio_codec ?? 'opus' });
    const v = Number(d.dave_protocol_version ?? 0);
    if (v > 0) worker?.postMessage({ t: 'init', version: v, channelId: session.channelId, userId: session.userId });
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer(serverSdp, pc.localDescription!.sdp, assigned, opusPt) });
    for (const [id, ssrc] of userSsrc) giveSlot(id, ssrc);
    send(15, { any: 100 });
    vadStop = startVad(host.mic, () => vadLevel, (on) => {
      speaking = on;
      send(5, { speaking: on ? 1 : 0, delay: 0, ssrc: ownSsrc });
    });
  }

  function onRemoteSpeaking(id: string, ssrc: number, flags: number) {
    host.setSpeaking(id, (flags & 1) === 1);
    if (!ssrc || userSsrc.get(id) === ssrc) return;
    userSsrc.set(id, ssrc);
    worker?.postMessage({ t: 'user-add', ids: [id] });
    worker?.postMessage({ t: 'ssrc', id, ssrc });
    // The server announces users already in the channel before our session description: those wait for it.
    if (serverSdp) giveSlot(id, ssrc);
  }

  /** A receive slot for a user's stream, replacing any older one of theirs. */
  function giveSlot(id: string, ssrc: number) {
    queueRenegotiate(() => {
      for (const [mid, a] of assigned) if (a.id === id) assigned.delete(mid);
      let t = freeSlots.pop();
      if (!t) {
        t = pc!.addTransceiver('audio', { direction: 'recvonly' });
        transforms(t, false);
      }
      return { t, id, ssrc };
    });
  }

  function onRemoteLeft(id: string) {
    host.setSpeaking(id, false);
    userSsrc.delete(id);
    worker?.postMessage({ t: 'user-remove', id });
    for (const [mid, a] of assigned) {
      if (a.id !== id) continue;
      assigned.delete(mid);
      const t = pc?.getTransceivers().find((x) => x.mid === mid);
      if (t) freeSlots.push(t);
    }
    queueRenegotiate(() => null);
  }

  /** Renegotiation never reaches the server: a new local offer, and an answer made up from the server's first one. */
  function queueRenegotiate(change: () => { t: RTCRtpTransceiver; id: string; ssrc: number } | null) {
    renegotiating = renegotiating.then(async () => {
      if (!pc || !serverSdp || stopped) return;
      const c = change();
      await pc.setLocalDescription(await pc.createOffer());
      if (c?.t.mid) assigned.set(c.t.mid, { id: c.id, ssrc: c.ssrc });
      await pc.setRemoteDescription({ type: 'answer', sdp: answer(serverSdp, pc.localDescription!.sdp, assigned, opusPt) });
      outputs();
    }).catch((e) => console.warn('renegotiation failed', e));
  }

  /**
   * Each receive slot's track goes where its person's volume says: with everyone else (100), nowhere (muted for this
   * account), or through a gain of its own. Chrome feeds a remote track into Web Audio only while an element plays it,
   * so a routed track also plays, muted, in an element of its own.
   */
  function outputs() {
    for (const [mid, track] of tracks) {
      if (track.readyState === 'ended') {
        tracks.delete(mid);
        unroute(mid);
        continue;
      }
      const who = assigned.get(mid)?.id;
      const v = who ? volumes.get(who) : undefined;
      const own = !!v && !v.muted && v.volume !== 100 && !!host.ctx;
      const inMix = !v || (!v.muted && !own);
      if (inMix && !remote.getTracks().includes(track)) remote.addTrack(track);
      if (!inMix && remote.getTracks().includes(track)) remote.removeTrack(track);
      if (!own) {
        unroute(mid);
        continue;
      }
      let r = routed.get(mid);
      if (!r) {
        const ctx = host.ctx!;
        const stream = new MediaStream([track]);
        const el = new Audio();
        el.muted = true;
        el.srcObject = stream;
        el.play().catch(() => {});
        const src = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        src.connect(gain);
        gain.connect(ctx.destination);
        routed.set(mid, (r = { gain, src, el }));
      }
      r.gain.gain.value = deaf ? 0 : Math.max(0, Math.min(VOLUME_MAX, v!.volume)) / 100;
    }
  }
  function unroute(mid: string) {
    const r = routed.get(mid);
    if (!r) return;
    routed.delete(mid);
    try {
      r.src.disconnect();
      r.gain.disconnect();
    } catch {}
    r.el.srcObject = null;
  }

  return {
    async start(j) {
      joined = j;
      session = j.direct!.session;
      await startWorker();
      connect();
    },
    signal(data: any) {
      // The voice server moved: start over against the new one.
      if (data?.kind === 'voice-server' && data.endpoint && data.token) {
        session = { ...session, endpoint: data.endpoint, token: data.token };
        teardown(false);
        stopped = false;
        void startWorker().then(connect);
      }
    },
    setMuted(muted) {
      host.mic.getAudioTracks().forEach((t) => (t.enabled = !muted));
      if (muted && speaking) send(5, { speaking: 0, delay: 0, ssrc: ownSsrc });
    },
    setDeafened(deafened) {
      host.speaker.muted = deafened;
      deaf = deafened;
      outputs();
    },
    setVolumes(byUser) {
      volumes = byUser;
      outputs();
    },
    setInput(input) {
      vadLevel = vadLevelOf(input);
    },
    async stats() {
      if (!pc) return null;
      const s = await peerStats(pc);
      return { ...s, dave: { version: secureVersion, ...counts, sandboxed: workerOrigin === 'null' } } as any;
    },
    micLevel: () => (pc ? sentAudioLevel(pc, host.mic.getAudioTracks()[0]) : Promise.resolve(null)),
    stop() {
      teardown(true);
    },
  };

  function teardown(final: boolean) {
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    vadStop?.();
    vadStop = null;
    try {
      ws?.close(1000);
    } catch {}
    ws = null;
    pc?.close();
    pc = null;
    worker?.terminate();
    worker = null;
    assigned.clear();
    userSsrc.clear();
    freeSlots.length = 0;
    serverSdp = '';
    for (const mid of [...routed.keys()]) unroute(mid);
    tracks.clear();
    if (final) remote.getTracks().forEach((t) => remote.removeTrack(t));
  }
}

// ------------------------------------------------------------------ speaking

/** The level gate's threshold, as RMS: 'auto' is this client's own default; a level in dB is the owner's choice. */
export function vadLevelOf(input: P.CallInput): number {
  return input.sensitivity === 'auto' ? 0.015 : Math.pow(10, input.sensitivity / 20);
}

/** A plain level gate: speaking above the threshold, with a short hangover so words don't flicker. */
function startVad(mic: MediaStream, level: () => number, onChange: (speaking: boolean) => void): () => void {
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(mic);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let on = false;
  let last = 0;
  const timer = setInterval(() => {
    const track = mic.getAudioTracks()[0];
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const loud = !!track?.enabled && Math.sqrt(sum / buf.length) > level();
    const now = Date.now();
    if (loud) last = now;
    const next = loud || now - last < 400;
    if (next !== on) onChange((on = next));
  }, 50);
  return () => {
    clearInterval(timer);
    void ctx.close();
  };
}

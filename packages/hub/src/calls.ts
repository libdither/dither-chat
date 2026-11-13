/**
 * Voice calls between a device and an account's adapter (see protocol/src/call.ts).
 *
 * A device opens /api/call and sends `join`. The hub asks the adapter to join; from then on it only
 * passes messages between that one socket and the adapter. In direct mode it also forwards the
 * device's voice socket (/api/call/<id>/voice) to the voice server the adapter named, and hands out
 * short-lived TURN credentials so the device's media leaves from this machine too.
 *
 * The hub never lets a device pick where a socket goes: the voice endpoint comes from the adapter,
 * and only the network's own voice hosts are accepted.
 */

import type { ServerWebSocket } from 'bun';
import { createHmac } from 'node:crypto';
import type * as P from '@dither-chat/protocol';
import { callInput, STAGE_ACTIONS, VOLUME_MAX } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { Store } from './store.ts';
import type { Supervisor } from './supervisor.ts';

/** An adapter command as the hub sends it, before the supervisor gives it an id. */
type CommandIn = P.AdapterCommand extends infer C ? (C extends { id: string } ? Omit<C, 'id'> : C) : never;

export type CallSocketData = { kind: 'call'; call?: string };
export type VoiceSocketData = { kind: 'voice'; call: string; upstreamUrl: string; ua?: string; upstream?: WebSocket; queue: (string | Uint8Array)[] };

export interface TurnConfig {
  /** e.g. ['turn:100.64.0.10:3478?transport=udp', 'turn:100.64.0.10:3478?transport=tcp'] */
  urls: string[];
  /** coturn's static-auth-secret. */
  secret: string;
  ttlSeconds?: number;
}

/** Only the network's own voice hosts. */
const VOICE_HOSTS: Record<string, RegExp> = {
  discord: /^[a-z0-9-]+(\.[a-z0-9-]+)*\.discord\.media(:\d{1,5})?$/i,
};

interface Live {
  id: string;
  ws: ServerWebSocket<CallSocketData>;
  accountId: string;
  network: P.Network;
  conversation: string;
  mode: P.CallMode;
  direct?: P.DirectVoiceSession;
  voice: Set<ServerWebSocket<VoiceSocketData>>;
  started: number;
  bytes: { up: number; down: number };
}

export interface CallStats {
  id: string;
  accountId: string;
  conversation: string;
  mode: P.CallMode;
  seconds: number;
  /** Voice-socket bytes this hub forwarded (direct mode); media goes through TURN and is not counted here. */
  socketBytes: { up: number; down: number };
}

export class Calls {
  private live = new Map<string, Live>();
  private byAccount = new Map<string, string>();

  constructor(
    private store: Store,
    private sup: Supervisor,
    private opts: {
      turn?: TurnConfig;
      /** The account to use for a conversation: the requested one if it can see it. */
      pickAccount: (conversationId: string, requested?: string) => string | null;
    },
  ) {}

  stats(): CallStats[] {
    return [...this.live.values()].map((c) => ({
      id: c.id,
      accountId: c.accountId,
      conversation: c.conversation,
      mode: c.mode,
      seconds: Math.round((Date.now() - c.started) / 1000),
      socketBytes: { ...c.bytes },
    }));
  }

  // ------------------------------------------------------------ device socket

  message(ws: ServerWebSocket<CallSocketData>, raw: string | Buffer) {
    let msg: P.CallClientMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }
    const call = ws.data.call ? this.live.get(ws.data.call) : undefined;
    if (msg.op === 'join') {
      if (ws.data.call) return send(ws, { t: 'error', message: 'This socket already has a call.' });
      this.join(ws, msg).catch((e) => {
        send(ws, { t: 'error', message: String(e?.message ?? e) });
        ws.close(1000, 'join failed');
      });
      return;
    }
    if (!call) return;
    if (msg.op === 'leave') {
      this.end(call, 'left', true);
      return;
    }
    let cmd: CommandIn | null;
    try {
      cmd = this.inCall(call, msg);
    } catch (e) {
      return send(ws, { t: 'error', message: String((e as Error).message) });
    }
    if (!cmd) return;
    const pending = this.sup.command<{ sounds?: P.CallSound[]; reason?: string }>(call.accountId, cmd, 15_000);
    pending
      .then((r) => {
        if (msg.op === 'sounds') send(ws, { t: 'sounds', sounds: Array.isArray(r?.sounds) ? r.sounds : [], ...(r?.reason ? { reason: r.reason } : {}) });
      })
      .catch((e) => (msg.op === 'sounds' ? send(ws, { t: 'sounds', sounds: [], reason: String(e?.message ?? e) }) : send(ws, { t: 'error', message: String(e?.message ?? e) })));
  }

  /** What a device's message in a call asks of the adapter, checked and in native ids; null for nothing. Throws a refusal in words. */
  private inCall(call: Live, msg: P.CallClientMessage): CommandIn | null {
    const base = { t: 'call' as const, call: call.id };
    const need = (cap: P.Capability, what: string) => {
      if (!this.caps(call.accountId).includes(cap)) throw new Error(`${what} isn't available for this account.`);
    };
    const native = (identityId: unknown) => {
      const n = typeof identityId === 'string' ? this.store.nativeOf('identity', identityId) : null;
      if (!n || n.network !== call.network) throw new Error('Nobody by that id in this call.');
      return n.nativeId;
    };
    switch (msg.op) {
      case 'mute':
        return { ...base, op: 'mute', muted: !!msg.muted, deafened: !!msg.deafened };
      case 'signal':
      case 'note':
        return { ...base, op: msg.op, data: msg.data };
      case 'local': {
        need('callVolume', 'Changing one person\'s volume');
        const volume = typeof msg.volume === 'number' && Number.isFinite(msg.volume) ? Math.max(0, Math.min(VOLUME_MAX, Math.round(msg.volume))) : undefined;
        if (volume === undefined && typeof msg.muted !== 'boolean') throw new Error('A volume or a mute.');
        return { ...base, op: 'local', user: native(msg.user), ...(volume !== undefined ? { volume } : {}), ...(typeof msg.muted === 'boolean' ? { muted: msg.muted } : {}) };
      }
      case 'input':
        // Direct mode applies these on the device; the account's client only sends in bridge mode, but keeps them for it.
        if (!this.caps(call.accountId).includes('callInput')) return null;
        return { ...base, op: 'input', input: callInput(msg.input) };
      case 'stage':
        need('stage', 'Stages');
        if (!STAGE_ACTIONS.includes(msg.action)) throw new Error('Not a stage action.');
        if ((msg.action === 'invite' || msg.action === 'audience') !== (msg.user !== undefined)) throw new Error(msg.user === undefined ? 'Whom?' : 'That is about yourself.');
        return { ...base, op: 'stage', action: msg.action, ...(msg.user !== undefined ? { user: native(msg.user) } : {}) };
      case 'sounds':
        need('soundboard', 'The soundboard');
        return { ...base, op: 'sounds' };
      case 'sound':
        need('soundboard', 'The soundboard');
        if (typeof msg.sound !== 'string' || !/^\d{1,20}$/.test(msg.sound) || typeof msg.guild !== 'string' || !/^\d{1,20}$/.test(msg.guild)) throw new Error('Which sound?');
        return { ...base, op: 'sound', sound: msg.sound, guild: msg.guild };
      default:
        return null;
    }
  }

  private caps(accountId: string): P.Capability[] {
    return JSON.parse(this.store.account(accountId)?.capabilities || '[]');
  }

  close(ws: ServerWebSocket<CallSocketData>) {
    const call = ws.data.call ? this.live.get(ws.data.call) : undefined;
    if (call && call.ws === ws) this.end(call, 'device left', true);
  }

  private async join(ws: ServerWebSocket<CallSocketData>, msg: Extract<P.CallClientMessage, { op: 'join' }>) {
    if (msg.mode !== 'bridge' && msg.mode !== 'direct') throw new Error('mode must be bridge or direct');
    const accountId = this.opts.pickAccount(msg.conversation, msg.account);
    if (!accountId || accountId !== msg.account) throw new Error('That account cannot see this conversation.');
    const acc = this.store.account(accountId);
    if (!acc || !this.sup.online(accountId)) throw new Error('That account is not connected.');
    if (!JSON.parse(acc.capabilities || '[]').includes('calls')) throw new Error('This account cannot join calls.');
    const native = this.store.nativeOf('conversation', msg.conversation);
    if (!native) throw new Error('No such conversation.');
    if (msg.mode === 'direct' && !VOICE_HOSTS[acc.network]) throw new Error(`Direct calls are not available for ${acc.network}.`);

    // One call per account: the network itself allows no more.
    const prev = this.byAccount.get(accountId);
    if (prev) this.end(this.live.get(prev)!, 'replaced by a call from another device', false);

    const id = crypto.randomUUID();
    const call: Live = { id, ws, accountId, network: acc.network as P.Network, conversation: msg.conversation, mode: msg.mode, voice: new Set(), started: Date.now(), bytes: { up: 0, down: 0 } };
    this.live.set(id, call);
    this.byAccount.set(accountId, id);
    ws.data.call = id;

    let result: { direct?: P.DirectVoiceSession } | undefined;
    try {
      // Ringing the others only where the adapter can, and only in a direct or group conversation.
      const ring = !!msg.ring && JSON.parse(acc.capabilities || '[]').includes('ringCalls') && !!this.store.db.query(`SELECT 1 FROM conversation WHERE id = ? AND shape IN ('direct', 'group')`).get(msg.conversation);
      const input = msg.input !== undefined && JSON.parse(acc.capabilities || '[]').includes('callInput') ? { input: callInput(msg.input) } : {};
      result = await this.sup.command(accountId, { t: 'call', call: id, op: 'join', conversation: native.nativeId, mode: msg.mode, muted: msg.muted, deafened: msg.deafened, ...(ring ? { ring: true } : {}), ...input }, 45_000);
    } catch (e) {
      this.end(call, 'join failed', false);
      throw e;
    }
    if (!this.live.has(id)) return; // ended while joining
    if (msg.mode === 'direct') {
      const s = result?.direct;
      if (!s || !VOICE_HOSTS[acc.network]!.test(s.endpoint)) {
        this.end(call, 'no voice server', true);
        throw new Error('The network did not give a usable voice server.');
      }
      call.direct = s;
    }
    const iceServers = this.iceServers(id);
    send(ws, {
      t: 'joined',
      call: id,
      mode: msg.mode,
      iceServers,
      ...(call.direct ? { direct: { session: call.direct, socket: `/api/call/${id}/voice`, relayOnly: iceServers.length > 0 } } : {}),
    });
  }

  /** coturn's REST-API credentials: username "<expiry>:<call>", password base64(HMAC-SHA1(secret, username)). */
  private iceServers(callId: string): P.IceServer[] {
    const t = this.opts.turn;
    if (!t?.urls.length || !t.secret) return [];
    const username = `${Math.floor(Date.now() / 1000) + (t.ttlSeconds ?? 12 * 3600)}:${callId}`;
    const credential = createHmac('sha1', t.secret).update(username).digest('base64');
    return [{ urls: t.urls, username, credential }];
  }

  private end(call: Live, reason: string, tellAdapter: boolean) {
    if (!this.live.delete(call.id)) return;
    if (this.byAccount.get(call.accountId) === call.id) this.byAccount.delete(call.accountId);
    if (tellAdapter) this.sup.command(call.accountId, { t: 'call', call: call.id, op: 'leave' }, 15_000).catch(() => {});
    for (const v of call.voice) {
      try {
        v.close(1000, reason);
      } catch {}
    }
    send(call.ws, { t: 'ended', reason });
    try {
      call.ws.close(1000, reason.slice(0, 100));
    } catch {}
  }

  // ------------------------------------------------------------ adapter side

  onAdapterEvent(accountId: string, ev: Extract<P.AdapterEvent, { t: 'call' }>) {
    const call = this.live.get(ev.call);
    if (!call || call.accountId !== accountId) return;
    // The voice server moved: the device may now open its socket to the new endpoint.
    const moved = ev.signal as { kind?: string; endpoint?: string; token?: string } | undefined;
    if (moved?.kind === 'voice-server' && call.direct) {
      if (!moved.endpoint || !VOICE_HOSTS[call.network]?.test(moved.endpoint) || !moved.token) return;
      call.direct = { ...call.direct, endpoint: moved.endpoint, token: moved.token };
    }
    if (ev.signal !== undefined) send(call.ws, { t: 'signal', data: ev.signal });
    if (ev.state) send(call.ws, { t: 'state', state: this.hubState(call, ev.state) });
    if (ev.effect && typeof ev.effect.who === 'string') {
      const who = hubId('idn', call.network, ev.effect.who);
      send(call.ws, { t: 'effect', effect: { ...ev.effect, who } });
    }
    if (ev.ended) this.end(call, ev.ended, false);
  }

  /** The adapter disconnected: its calls are gone. */
  onAdapterGone(accountId: string) {
    const id = this.byAccount.get(accountId);
    if (id) this.end(this.live.get(id)!, 'the account disconnected', false);
  }

  /** Native user ids become hub identity ids, with the identities alongside so the device can draw them. */
  private hubState(call: Live, st: P.CallState): P.CallState & { identities: P.IdentityView[] } {
    const participants = st.participants.map((p) => ({ ...p, id: hubId('idn', call.network, p.id) }));
    return { conversation: call.conversation, participants, ...(st.stage ? { stage: st.stage } : {}), identities: this.store.identitiesByIds(participants.map((p) => p.id)) };
  }

  // ------------------------------------------------------------ voice socket (direct mode)

  /** Upgrade /api/call/<id>/voice. The query carries only the protocol version. */
  upgradeVoice(req: Request, server: { upgrade(req: Request, o: { data: VoiceSocketData }): boolean }, callId: string, url: URL): Response | undefined {
    const call = this.live.get(callId);
    if (!call?.direct) return new Response('no such direct call', { status: 404 });
    const v = url.searchParams.get('v') ?? '8';
    if (!/^\d{1,2}$/.test(v)) return new Response('bad version', { status: 400 });
    const upstreamUrl = `wss://${call.direct.endpoint.replace(/:443$/, '')}/?v=${v}`;
    // The upstream opens in voiceOpen, once the device's socket exists.
    const data: VoiceSocketData = { kind: 'voice', call: callId, upstreamUrl, ua: req.headers.get('user-agent') ?? undefined, queue: [] };
    if (!server.upgrade(req, { data })) return new Response('upgrade failed', { status: 400 });
    return undefined;
  }

  voiceOpen(ws: ServerWebSocket<VoiceSocketData>) {
    const call = this.live.get(ws.data.call);
    if (!call) return ws.close(1000, 'call ended');
    call.voice.add(ws);
    const { upstreamUrl, ua } = ws.data;
    // Bun's WebSocket takes headers; the device's own browser is the client, so it is named as such.
    const up = new WebSocket(upstreamUrl, { headers: ua ? { 'User-Agent': ua } : {} } as any);
    up.binaryType = 'arraybuffer';
    ws.data.upstream = up;
    up.onopen = () => {
      for (const m of ws.data.queue) up.send(m);
      ws.data.queue = [];
    };
    up.onmessage = (e) => {
      const d = typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer);
      call.bytes.down += typeof d === 'string' ? Buffer.byteLength(d) : d.byteLength;
      try {
        ws.send(d);
      } catch {}
    };
    up.onclose = (e) => {
      try {
        ws.close(e.code >= 4000 && e.code < 5000 ? e.code : 1000, (e.reason || 'voice server closed').slice(0, 100));
      } catch {}
    };
    up.onerror = () => {
      try {
        ws.close(1011, 'voice server unreachable');
      } catch {}
    };
  }

  voiceMessage(ws: ServerWebSocket<VoiceSocketData>, msg: string | Buffer) {
    const call = this.live.get(ws.data.call);
    if (!call) return;
    const d = typeof msg === 'string' ? msg : new Uint8Array(msg);
    call.bytes.up += typeof d === 'string' ? Buffer.byteLength(d) : d.byteLength;
    const up = ws.data.upstream;
    if (up && up.readyState === WebSocket.OPEN) up.send(d);
    else ws.data.queue.push(d);
  }

  voiceClose(ws: ServerWebSocket<VoiceSocketData>) {
    this.live.get(ws.data.call)?.voice.delete(ws);
    try {
      ws.data.upstream?.close(1000);
    } catch {}
  }
}

function send(ws: ServerWebSocket<CallSocketData>, m: P.CallServerMessage | (Omit<Extract<P.CallServerMessage, { t: 'state' }>, 'state'> & { state: unknown })) {
  try {
    ws.send(JSON.stringify(m));
  } catch {}
}

/**
 * The demo world's voice calls (docs/calls.md "Demo calls"). A real call's far end is the account's own Discord client
 * in its sandbox; a demo hub has none, so it hands every demo Discord call to one stand-in: a page, the call room
 * (demo-callroom.html, served at /demo/callroom.html), open in any browser, which plays the account's client for every
 * call at once. It answers each device's bridge offer, mixes everyone's microphone for everyone else, carries cameras
 * and shared screens between devices on the bridge's slots, and brings a bot of its own that talks, has its camera on
 * and is live. The integration tests (scripts/verify-calls-demo.ts) open it in a headless browser; a person trying the
 * demo opens it in a tab.
 *
 * Only on demo hubs. The room speaks to the hub over /api/demo/callroom: the hub sends it the call commands of demo
 * accounts (with the account's own id and the call's channel), and it answers them and sends the call's events back.
 */
import type { ServerWebSocket } from 'bun';
import type * as P from '@dither-chat/protocol';

export type CallRoomSocketData = { kind: 'callroom' };

type Emit = (ev: P.AdapterEvent) => void;
type CallCommand = Extract<P.AdapterCommand, { t: 'call' }>;

/** Who the room's bot is in the demo world, and the account a command comes from. */
export interface RoomContext {
  self: string;
  bot: { id: string; name: string };
}

export class DemoCallRoom {
  private ws: ServerWebSocket<CallRoomSocketData> | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Call id -> the adapter it belongs to. */
  private owners = new Map<string, Emit>();

  get open(): boolean {
    return !!this.ws;
  }

  attach(ws: ServerWebSocket<CallRoomSocketData>) {
    // One room at a time: a newer page takes over, and the calls in the old one end.
    if (this.ws && this.ws !== ws) this.ws.close(1000, 'another call room opened');
    this.dropAll('the demo call room was replaced');
    this.ws = ws;
  }

  detach(ws: ServerWebSocket<CallRoomSocketData>) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.dropAll('the demo call room closed');
  }

  private dropAll(reason: string) {
    for (const [call, emit] of this.owners) emit({ t: 'call', call, ended: reason });
    this.owners.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  message(raw: string | Buffer) {
    let m: { t?: string; id?: number; ok?: boolean; result?: unknown; error?: string; call?: string; ev?: Record<string, unknown> };
    try {
      m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }
    if (m.t === 'reply' && typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error ?? 'the call room refused'));
      return;
    }
    if (m.t === 'event' && typeof m.call === 'string' && m.ev) {
      const emit = this.owners.get(m.call);
      if (!emit) return;
      const ev = m.ev as Omit<Extract<P.AdapterEvent, { t: 'call' }>, 't' | 'call'>;
      emit({ t: 'call', call: m.call, ...ev });
      if (ev.ended) this.owners.delete(m.call);
    }
  }

  /** One call command from a demo Discord account: to the room, and its answer back. */
  command(emit: Emit, ctx: RoomContext, cmd: CallCommand): Promise<unknown> {
    if (!this.ws) return Promise.reject(new Error('No demo call room is open: open /demo/callroom.html in a browser tab (it plays the far end of demo calls).'));
    if (cmd.op === 'join') this.owners.set(cmd.call, emit);
    const id = ++this.seq;
    const { id: _cmdId, ...rest } = cmd as CallCommand & { id?: string };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('the demo call room did not answer'));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ t: 'command', id, cmd: rest, self: ctx.self, bot: ctx.bot }));
    }).finally(() => {
      if (cmd.op === 'leave') this.owners.delete(cmd.call);
    });
  }
}

/** The one room of this hub process (a demo hub has one demo world). */
export const demoCallRoom = new DemoCallRoom();

/** What demo Discord accounts can do in a call: everything the bridge carries. */
export const DEMO_CALL_CAPS = ['calls', 'callVideo', 'watchStreams'] as const satisfies readonly P.Capability[];

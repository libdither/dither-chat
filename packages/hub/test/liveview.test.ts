/**
 * A local adapter's live view: the hub carries the page's socket to the sandbox's VNC on its Unix socket (x11vnc
 * listens on no TCP port), and to nothing else: not a TCP port an older adapter reports, not a path that is not a
 * socket.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnixSocketListener } from 'bun';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

let dir: string;
let store: Store;
let hub: HubServer;
let port: number;
let vnc: UnixSocketListener<undefined>;
const atVnc: string[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-liveview-'));
  // A stand-in VNC server on a Unix socket, as a sandbox's x11vnc is.
  vnc = Bun.listen({ unix: join(dir, 'vnc.sock'), socket: { open: (s) => void s.write('RFB 003.008\n'), data: (_s, d) => void atVnc.push(Buffer.from(d).toString()) } });
  writeFileSync(join(dir, 'not-a-socket'), 'RFB 003.008\n');
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const view = (id: string, liveView: unknown) => {
    store.createAccount({ id, network: 'discord', label: id, color: '#5CC8FF', adapter: 'discord' });
    store.updateAccount(id, { live_view: JSON.stringify(liveView) });
  };
  view('acc_socket0000001', { vncSocket: join(dir, 'vnc.sock'), width: 800, height: 600 });
  view('acc_port00000001', { vncPort: 1, width: 800, height: 600 }); // an older adapter's port (nothing there)
  view('acc_notSocket0001', { vncSocket: join(dir, 'not-a-socket'), width: 800, height: 600 });
  const sup = { authorize: () => null, online: () => true, command: async () => ({}), note() {}, liveViewUrl: () => null } as any;
  hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
  port = hub.start().port;
});

afterAll(() => {
  hub.stop();
  vnc.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/** Open the page's live view socket: its first message, or how it closed. */
const open = (id: string) =>
  new Promise<{ first?: string; code?: number }>((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/liveview/${id}`, ['binary']);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      res({ first: Buffer.from(e.data as ArrayBuffer).toString() });
      ws.send(new TextEncoder().encode('RFB 003.008\n'));
      setTimeout(() => ws.close(), 100);
    };
    ws.onclose = (e) => res({ code: e.code });
  });

test('carried to the VNC socket, both ways', async () => {
  expect(await open('acc_socket0000001')).toEqual({ first: 'RFB 003.008\n' });
  for (let i = 0; i < 60 && !atVnc.join('').includes('RFB 003.008'); i++) await Bun.sleep(50);
  expect(atVnc.join('')).toContain('RFB 003.008');
});

test('a TCP port is never connected to, nor a path that is not a socket', async () => {
  const upgrade = { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' };
  expect((await fetch(`http://127.0.0.1:${port}/api/liveview/acc_port00000001`, { headers: upgrade })).status).toBe(404);
  expect(await open('acc_notSocket0001')).toEqual({ code: 1011 });
});

/**
 * The demo world's calls (democalls.ts): demo accounts' call commands go to the call room and its answers come back;
 * its events reach the adapter of the call they belong to; a room that closes ends its calls; no room, a refusal in
 * words. And the call sounds' table (scripts/dave/sounds.ts), read from a made-up build.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { DemoCallRoom } from '../src/democalls.ts';
import { soundTable } from '../../../scripts/dave/sounds.ts';

function room() {
  const r = new DemoCallRoom();
  const sent: any[] = [];
  const ws = { data: { kind: 'callroom' }, send: (m: string) => sent.push(JSON.parse(m)), close() {} } as any;
  return { r, ws, sent };
}
const ctx = { self: '700000000000000001', bot: { id: '700000000000000009', name: 'Lev' } };
const join = { t: 'call', id: 'c1', call: 'call-1', op: 'join', conversation: '300000000000000201', mode: 'bridge' } as any;

describe('demo call room', () => {
  test('no room open: refused in words', async () => {
    const { r } = room();
    await expect(r.command(() => {}, ctx, join)).rejects.toThrow('/demo/callroom.html');
  });

  test('a command goes to the room with the account and the bot, and its answer comes back', async () => {
    const { r, ws, sent } = room();
    r.attach(ws);
    const events: any[] = [];
    const answer = r.command((ev) => events.push(ev), ctx, join);
    expect(sent[0]).toMatchObject({ t: 'command', self: ctx.self, bot: ctx.bot, cmd: { op: 'join', call: 'call-1', conversation: '300000000000000201' } });
    expect(sent[0].cmd.id).toBeUndefined();
    r.message(JSON.stringify({ t: 'reply', id: sent[0].id, ok: true, result: { ok: 1 } }));
    expect(await answer).toEqual({ ok: 1 });

    // The room's events reach the adapter whose call it is.
    r.message(JSON.stringify({ t: 'event', call: 'call-1', ev: { signal: { type: 'answer', sdp: 'v=0' } } }));
    r.message(JSON.stringify({ t: 'event', call: 'someone-else', ev: { signal: {} } }));
    expect(events).toEqual([{ t: 'call', call: 'call-1', signal: { type: 'answer', sdp: 'v=0' } }]);

    // A refusal is the room's sentence.
    const bad = r.command(() => {}, ctx, { ...join, op: 'watch', user: '1', on: true });
    r.message(JSON.stringify({ t: 'reply', id: sent[1].id, ok: false, error: 'nope' }));
    await expect(bad).rejects.toThrow('nope');
  });

  test('the room closing ends its calls and what was waiting', async () => {
    const { r, ws, sent } = room();
    r.attach(ws);
    const events: any[] = [];
    const joined = r.command((ev) => events.push(ev), ctx, join);
    r.message(JSON.stringify({ t: 'reply', id: sent[0].id, ok: true, result: {} }));
    await joined;
    const waiting = r.command(() => {}, ctx, { ...join, op: 'mute', muted: true, deafened: false });
    r.detach(ws);
    await expect(waiting).rejects.toThrow('closed');
    expect(events).toEqual([{ t: 'call', call: 'call-1', ended: 'the demo call room closed' }]);
    expect(r.open).toBe(false);
  });
});

describe('call sounds table', () => {
  test("names to asset files, from the client's sound context module, whatever the module ids", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'sounds-'));
    // Shaped like a build's chunk by hand: a context module of sound names, and one module per file.
    writeFileSync(
      pathJoin(dir, 'a.js'),
      `(self.x=self.x||[]).push([[1],{111(e,t,n){var i={"./user_join.mp3":"222","./mute.mp3":"333","./message1.mp3":"444"};function r(e){return n(a(e))}e.exports=r},` +
        `222(e,t,n){"use strict";e.exports=n.p+"0123456789abcdef.mp3"},333(e){"use strict";e.exports="/assets/fedcba9876543210.mp3"}}]);`,
    );
    const t = soundTable([pathJoin(dir, 'a.js')]);
    expect(t.get('user_join')).toBe('0123456789abcdef.mp3');
    expect(t.get('mute')).toBe('fedcba9876543210.mp3');
    // A name whose module is nowhere: left out.
    expect(t.has('message1')).toBe(false);
  });

  test('no sound table: an anchor error', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'sounds-'));
    writeFileSync(pathJoin(dir, 'a.js'), 'console.log(1)');
    expect(() => soundTable([pathJoin(dir, 'a.js')])).toThrow('sound table');
  });
});

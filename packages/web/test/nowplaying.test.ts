/** src/nowplaying.ts: which players count, where a player sits, and what the system is told of it. */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { counts, describe: describePlaying, placeOf } = await import('../src/nowplaying.ts');

test('a player you listen to counts; a GIF, a muted preview or one out of the page does not', () => {
  expect(counts({ muted: false, loop: false, isConnected: true })).toBe(true);
  expect(counts({ muted: true, loop: false, isConnected: true })).toBe(false);
  expect(counts({ muted: false, loop: true, isConnected: true })).toBe(false);
  expect(counts({ muted: false, loop: false, isConnected: false })).toBe(false);
});

/** A stand-in for an element: `closest` answers from the selectors it is given. */
const at = (parents: Record<string, { id?: string; att?: string }>) => ({
  closest: (sel: string) => {
    const p = parents[sel];
    return p ? { id: p.id, getAttribute: (n: string) => (n === 'data-att' ? (p.att ?? null) : null) } : null;
  },
});

test('the message comes from the row, the file from data-att', () => {
  expect(placeOf(at({ '[id^="m-"]': { id: 'm-msg_1' }, '[data-att]': { att: '2' } }))).toEqual({ messageId: 'msg_1', att: 2 });
  expect(placeOf(at({}))).toEqual({ messageId: null, att: null });
  expect(placeOf(at({ '[data-att]': { att: 'x' } }))).toEqual({ messageId: null, att: null });
});

const msg = (attachments: Partial<P.AttachmentView>[]): P.MessageView => ({ id: 'msg_1', conversationId: 'cnv_a', authorId: 'idn_ann', attachments }) as any;
const chat = (id: string) => (id === 'cnv_a' ? 'Book club' : null);
const sender = (id: string) => (id === 'idn_ann' ? 'Ann' : 'Unknown');

test('a voice message is called one, with who sent it and where', () => {
  expect(describePlaying(msg([{ voice: { seconds: 3 } } as any]), 0, false, chat, sender)).toEqual({
    title: 'Voice message',
    artist: 'Ann',
    album: 'Book club',
    conversationId: 'cnv_a',
    messageId: 'msg_1',
  });
});

test('a file goes by its name, and a player outside a message by what it is', () => {
  expect(describePlaying(msg([{ name: 'a.png' }, { name: 'song.mp3' }]), 1, false, chat, sender).title).toBe('song.mp3');
  expect(describePlaying(null, null, true, chat, sender)).toEqual({ title: 'Video', artist: '', album: '', conversationId: null, messageId: null });
  expect(describePlaying(null, null, false, chat, sender).title).toBe('Sound');
});

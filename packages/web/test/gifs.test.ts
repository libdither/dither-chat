/**
 * GIFs drawn as just the GIF (gifs.ts, docs/media-kinds.md "GIFs"): which messages are a Discord GIF link drawn back as
 * the GIF, and the setting that turns it off.
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { gifLinkOf, plainGifs } = await import('../src/gifs.ts');
const { setPrefs } = await import('../src/state.ts');

const link = 'https://gifs.example.com/party';
const gifv: P.EmbedView = { url: link, provider: 'Klipy', video: { url: '/media/abc/def', width: 220, height: 160, gifv: true } };
const msg = (body: string, embeds: P.EmbedView[], attachments: P.AttachmentView[] = []) => ({ body, embeds, attachments }) as unknown as P.MessageView;

test("a message that is only a GIF's link, drawn by Discord as a GIF, is just the GIF", () => {
  expect(gifLinkOf(msg(link, [gifv]))).toBe(gifv);
  expect(gifLinkOf(msg(`  <${link}>  `, [gifv]))).toBe(gifv);
});

test('words beside the link, a card that is not a GIF, a player, or files keep the message as it is', () => {
  expect(gifLinkOf(msg(`lol ${link}`, [gifv]))).toBeNull();
  expect(gifLinkOf(msg(link, [{ url: link, title: 'A page' }]))).toBeNull();
  expect(gifLinkOf(msg(link, [{ ...gifv, video: { ...gifv.video!, player: true } }]))).toBeNull();
  expect(gifLinkOf(msg(link, [gifv, gifv]))).toBeNull();
  expect(gifLinkOf(msg(link, [gifv], [{ id: 'a', kind: 'image', mime: 'image/png', name: null, size: null, width: null, height: null, url: '/x' }]))).toBeNull();
});

test('on unless switched off on this device', () => {
  expect(plainGifs()).toBe(true);
  setPrefs({ plainGifs: false });
  expect(plainGifs()).toBe(false);
  expect(gifLinkOf(msg(link, [gifv]))).toBeNull();
  setPrefs({ plainGifs: undefined });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { messageLinks, waveformPoints } from '@dither-chat/protocol';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

// docs/rich-messages.md: what a message carries beyond its text, kept and shown.
describe('rich messages', () => {
  let dir: string;
  let store: Store;
  let triage: Triage;
  let d: AccountRow;
  let n = 0;
  const T0 = Date.UTC(2026, 10, 3, 12);
  const put = (m: Partial<P.MessageFact> & { body?: string }, conversation = 'dm', author = 'ann') => {
    const nativeId = m.nativeId ?? `1000000000000${String(++n).padStart(5, '0')}`;
    store.ingest(d, { t: 'message', message: { nativeId, conversation, author, ts: T0 + n, body: '', ...m }, live: true });
    return store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
  };
  const view = (id: string) => store.messageViews([store.one('SELECT * FROM message WHERE id = ?', id)!])[0];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-rich-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    triage = new Triage(store);
    triage.judge = async (text) => (/\bnow\b/.test(text) ? 0.9 : 0.01);
    d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
    store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: '300000000000000001', shape: 'channel', name: 'general' } });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a message sent silently never alerts: it stays a Conversation, and says why', async () => {
    const loud = await triage.decide(put({ body: 'the door is locked, come now' }));
    expect(loud?.decision).toBe('push');
    const quiet = await triage.decide(put({ body: 'the door is locked, come now', silent: true }));
    expect(quiet?.decision).toBe('quiet');
    expect(quiet?.reasons[0]).toBe('Sent silently: it never alerts');
  });

  test('not even a keyword set to always alert makes a silent message alert', async () => {
    store.setRule('keyword', 'deploy', 'all');
    const r = await triage.decide(put({ body: 'the deploy failed', silent: true }, '300000000000000001'));
    expect(r?.decision).toBe(r?.facts?.conv ? 'quiet' : 'digest');
    expect(r?.reasons.slice(0, 2)).toEqual(['Sent silently: it never alerts', 'Matches keyword “deploy”']);
    store.setRule('keyword', 'deploy', null);
  });

  test('alt text, spoilers, explicit flags and voice messages are kept with their files', () => {
    const id = put({
      kind: 'media',
      attachments: [
        { nativeId: 'a1', kind: 'image', url: 'https://cdn.example/a.png', alt: 'a heron standing in reeds', spoiler: true },
        { nativeId: 'a2', kind: 'image', url: 'https://cdn.example/b.png', explicit: true },
        { nativeId: 'a3', kind: 'audio', mime: 'audio/ogg', url: 'https://cdn.example/voice-message.ogg', voice: { seconds: 4.2, waveform: btoa('\x00\x80\xff') } },
      ],
    });
    const [a, b, c] = view(id).attachments;
    expect(a).toMatchObject({ alt: 'a heron standing in reeds', spoiler: true });
    expect(a.explicit).toBeUndefined();
    expect(b).toMatchObject({ explicit: true });
    expect(b.alt).toBeUndefined();
    expect(c.voice).toEqual({ seconds: 4.2, waveform: btoa('\x00\x80\xff') });
    expect(waveformPoints(c.voice!.waveform).map((x) => Math.round(x * 100))).toEqual([0, 50, 100]);
  });

  test('alt text is found by search when no message text has the words', () => {
    const page = store.search('heron');
    expect(page.hits.map((h) => h.message.attachments[0]?.alt)).toEqual(['a heron standing in reeds']);
  });

  test("embeds come in full, their pictures through the hub; a message whose author hid them shows none", () => {
    const embed: P.EmbedView = {
      title: 'Clip',
      url: 'https://www.youtube.com/watch?v=abc',
      color: '#ff0000',
      footer: 'YouTube',
      footerIcon: 'https://cdn.example/f.png',
      timestamp: T0,
      authorIcon: 'https://cdn.example/i.png',
      video: { url: 'https://www.youtube.com/embed/abc', width: 1280, height: 720, player: true },
      image: 'https://cdn.example/thumb.jpg',
    };
    const shown = view(put({ body: 'look', extra: { embeds: [embed] } }));
    expect(shown.embeds[0]).toMatchObject({ color: '#ff0000', footer: 'YouTube', timestamp: T0, video: embed.video });
    const hidden = view(put({ body: 'look', extra: { embeds: [embed], marks: { suppressEmbeds: true } } }));
    expect(hidden.embeds).toEqual([]);
    expect(hidden.rich?.marks).toEqual({ suppressEmbeds: true });
  });

  test("a bot's controls, crosspost, command and roles come through as `rich`; a plain message has none", () => {
    const extra: P.RichExtra = {
      components: [[{ kind: 'button', id: 'go', label: 'Go', style: 'primary' }, { kind: 'button', label: 'Docs', style: 'link', url: 'https://example.org' }], [{ kind: 'select', id: 'pick', select: 'string', options: [{ label: 'A', value: 'a' }] }]],
      application: '555',
      crosspost: { channel: 'news', server: 'Elsewhere' },
      interaction: { kind: 'command', name: 'roll', user: 'ann', userName: 'Ann' },
      roles: [{ id: '42', name: 'Helpers', color: '#5c7cfa' }],
    };
    const v = view(put({ body: 'Pick one <@&42>', extra: extra as Record<string, unknown>, silent: true }));
    expect(v.rich).toEqual({ ...extra, silent: true });
    expect(view(put({ body: 'plain' })).rich).toBeUndefined();
  });

  test('a link to a Discord message the hub has shows it; one it does not have shows nothing', () => {
    const target = put({ nativeId: '200000000000000777', body: 'the original words' }, '300000000000000001');
    const link = 'https://discord.com/channels/400000000000000000/300000000000000001/200000000000000777';
    const v = view(put({ body: `see ${link} and https://discord.com/channels/@me/300000000000000002/200000000000000999` }));
    expect(v.rich?.linked).toEqual([expect.objectContaining({ messageId: target, text: 'the original words' })]);
    expect(messageLinks(`${link} ${link}`)).toHaveLength(1);
  });
});

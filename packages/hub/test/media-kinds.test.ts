/**
 * Stickers, voice messages, view-once and stories through the hub (media.ts, docs/media-kinds.md), against the demo
 * world's adapters run in process: the sticker picker's pages with the hub's picture addresses, installing a pack from
 * a link, what a send's sticker, recording and view-once come to, and stories kept apart from messages, gone after a
 * day, opened and answered through the account that heard them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { STORY_LIFETIME_MS, waveformBase64 } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { ingestStories, Media, MediaError, pruneStories, sendMediaProblem } from '../src/media.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-media-kinds-'));
let store: Store;
let media: Media;
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const sent: { account: string; cmd: { t: string; [k: string]: unknown } }[] = [];
const DISCORD = 'acc_demo-discord-main';
const SIGNAL = 'acc_demo-signal';
let now = Date.now();

const conv = (network: P.Network, name: string) => {
  const r = store.one<{ id: string }>(`SELECT id FROM conversation WHERE network = ? AND name = ?`, network, name);
  if (!r) throw new Error(`no conversation ${name}`);
  return r.id;
};
const identity = (network: P.Network, name: string) => {
  const r = store.one<{ id: string }>(`SELECT id FROM identity WHERE network = ? AND display_name = ?`, network, name);
  if (!r) throw new Error(`no identity ${name}`);
  return r.id;
};
const refused = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return e as MediaError;
  }
  throw new Error('it went through');
};
/** Lets the in-process adapter's reply land. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const deps = {
  get store() {
    return store;
  },
  online: () => true,
  command: <T>(account: string, cmd: any) => {
    sent.push({ account, cmd });
    return new Promise<T>((resolve, rej) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject: rej });
      adapters.get(account)!.command({ ...cmd, id });
    });
  },
  pickAccount: (c: string, requested?: string) => {
    const vs = store.vantageAccounts('conversation', c);
    return requested && vs.includes(requested) ? requested : (vs[0] ?? null);
  },
  now: () => now,
};

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  store.db.transaction(() => {
    for (const acc of createDemoAccounts(store)) {
      const adir = join(dir, acc.id);
      mkdirSync(adir, { recursive: true });
      const a = demoFactory(acc, adir)!;
      adapters.set(acc.id, a);
      a.start((ev) => {
        if (ev.t === 'reply') {
          const p = pending.get(ev.id);
          pending.delete(ev.id);
          if (ev.ok) p?.resolve(ev.result);
          else p?.reject(new Error(ev.error));
          return;
        }
        store.ingest(store.account(acc.id)!, ev);
      });
    }
  })();
  store.flush();
  media = new Media({ ...deps });
});

afterAll(() => {
  for (const a of adapters.values()) (a as unknown as { stop(): void }).stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('what a send carries', () => {
  const all: P.Capability[] = ['sendStickers', 'sendVoice', 'sendViewOnce'];
  test('a sticker needs the capability and goes without files', () => {
    expect(sendMediaProblem({ sticker: '1', files: 0 }, all, 'main on Discord')).toEqual({});
    expect(sendMediaProblem({ sticker: '1', files: 0 }, [], 'main on Discord').error).toBe('main on Discord cannot send stickers');
    expect(sendMediaProblem({ sticker: '1', files: 1 }, all, 'x').error).toBe('A sticker goes on its own, without files');
  });

  test('a recording is a voice message where the network has them, an ordinary file elsewhere', () => {
    const waveform = waveformBase64([0, 0.5, 1]);
    expect(sendMediaProblem({ files: 1, voice: { seconds: 3.456, waveform } }, all, 'x')).toEqual({ voice: { seconds: 3.46, waveform } });
    // No voice messages here: the file goes as it is.
    expect(sendMediaProblem({ files: 1, voice: { seconds: 3 } }, ['sendStickers'], 'x')).toEqual({});
    // Two files are not a voice message.
    expect(sendMediaProblem({ files: 2, voice: { seconds: 3 } }, all, 'x')).toEqual({});
    expect(sendMediaProblem({ files: 1, voice: { seconds: 0 } }, all, 'x').error).toBe('That recording has no length the network takes');
    // A waveform that is not base64 is left off, not passed on.
    expect(sendMediaProblem({ files: 1, voice: { seconds: 2, waveform: '<b>' } }, all, 'x')).toEqual({ voice: { seconds: 2 } });
  });

  test('view-once needs the capability and a file', () => {
    expect(sendMediaProblem({ files: 1, viewOnce: true }, all, 'x')).toEqual({ viewOnce: true });
    expect(sendMediaProblem({ files: 0, viewOnce: true }, all, 'x').error).toBe('View-once needs a picture or video');
    expect(sendMediaProblem({ files: 1, viewOnce: true }, ['sendVoice'], 'personal on Signal').error).toBe('personal on Signal cannot send view-once files');
  });

  test("Discord's waveform: at most 256 bytes, averaged down", () => {
    const b = atob(waveformBase64(Array.from({ length: 1000 }, (_, i) => (i < 500 ? 1 : 0))));
    expect(b.length).toBe(256);
    expect(b.charCodeAt(0)).toBe(255);
    expect(b.charCodeAt(255)).toBe(0);
    expect(atob(waveformBase64([1, 0])).split('').map((c) => c.charCodeAt(0))).toEqual([255, 0]);
  });
});

describe('the sticker picker', () => {
  test('a page at a time, nothing asked until the picker opens, with the hub serving the pictures', async () => {
    const before = sent.length;
    const c = conv('discord', 'general');
    const first = await media.stickers(c, DISCORD, undefined);
    expect(sent.slice(before).map((s) => s.cmd.t)).toEqual(['stickers']);
    expect(first).toMatchObject({ next: '1', canInstall: false, note: 'Stickers from other servers need Nitro' });
    expect(first.packs.map((p) => [p.name, p.source])).toEqual([['Pixel Pals', 'server']]);
    expect(first.packs[0].stickers.map((s) => s.name)).toEqual(['wave', 'party', 'thinking']);
    expect(first.packs[0].cover).toBe(first.packs[0].stickers[0].url);
    expect(first.accountId).toStartWith('acc_demo-discord');
    const second = await media.stickers(c, first.accountId!, first.next!);
    expect(second.packs.map((p) => p.name)).toEqual(['Wumpus Beyond']);
    expect(second.next).toBeNull();
  });

  test('an account without stickers says so and asks nothing', async () => {
    const before = sent.length;
    const page = await media.stickers(conv('matrix', 'Rust'), undefined, undefined).catch(() => null);
    if (page) {
      expect(page.packs).toEqual([]);
      expect(page.note).toBe('This account cannot send stickers.');
    }
    expect(sent.slice(before).length).toBe(0);
  });

  test('Signal installs a pack from a signal.art link, and refuses anything else', async () => {
    const c = conv('signal', 'Climbing crew 🧗');
    expect((await media.stickers(c, SIGNAL, undefined)).canInstall).toBe(true);
    const bad = await refused(media.install(SIGNAL, 'https://example.com/pack'));
    expect(bad.message).toBe('That is not a signal.art sticker pack link');
    const id = 'ab'.repeat(16);
    const pack = await media.install(SIGNAL, `https://signal.art/addstickers/#pack_id=${id}&pack_key=${'cd'.repeat(32)}`);
    expect(pack).toMatchObject({ id, source: 'installed' });
    const page = await media.stickers(c, SIGNAL, '1');
    expect(page.packs.map((p) => p.id)).toEqual([id]);
    expect((await refused(media.install(DISCORD, 'x'))).status).toBe(409);
  });
});

describe('stories', () => {
  test("on their author's page and their group's, never as messages", () => {
    const alice = media.stories({ identityId: identity('signal', 'Alice Chen') });
    expect(alice.map((s) => s.text?.text)).toEqual(['First swim of the year 🌊']);
    expect(alice[0]).toMatchObject({ accountId: SIGNAL, conversationId: null, allowsReplies: true, viewed: false, attachment: null });
    const sam = media.stories({ identityId: identity('signal', 'Sam Rivera') });
    expect(sam[0].attachment).toMatchObject({ kind: 'image', mime: 'image/svg+xml' });
    const group = media.stories({ conversationId: conv('signal', 'Climbing crew 🧗') });
    expect(group.map((s) => s.text?.text)).toEqual(['Group trip photos coming']);
    expect(store.one(`SELECT 1 FROM message WHERE body LIKE '%First swim%'`)).toBeNull();
  });

  test('kept only from an account with stories, and never past a day', () => {
    const acc = store.account(DISCORD)!;
    ingestStories(store, acc, { t: 'story', story: { nativeId: 'x:1', author: 'someone', ts: now, expiresAt: now + 1000, allowsReplies: true, text: { text: 'hi' } } }, now);
    expect(store.one(`SELECT 1 FROM story WHERE native_id = 'x:1'`)).toBeNull();
    const sig = store.account(SIGNAL)!;
    // An adapter that says a week is held to Signal's day.
    ingestStories(store, sig, { t: 'story', story: { nativeId: 'y:1', author: 'someone', ts: now, expiresAt: now + 7 * STORY_LIFETIME_MS, allowsReplies: true, text: { text: 'hi' } } }, now);
    expect(store.one<{ expires_at: number }>(`SELECT expires_at FROM story WHERE native_id = 'y:1'`)!.expires_at).toBe(now + STORY_LIFETIME_MS);
    // Already over: not kept at all.
    ingestStories(store, sig, { t: 'story', story: { nativeId: 'z:1', author: 'someone', ts: now - 2 * STORY_LIFETIME_MS, expiresAt: now - STORY_LIFETIME_MS, allowsReplies: true, text: { text: 'old' } } }, now);
    expect(store.one(`SELECT 1 FROM story WHERE native_id = 'z:1'`)).toBeNull();
  });

  test('a story its author deleted is gone', () => {
    const sig = store.account(SIGNAL)!;
    ingestStories(store, sig, { t: 'story', story: { nativeId: 'g:1', author: 'someone', ts: now, expiresAt: now + 1000, allowsReplies: true, text: { text: 'oops' } } }, now);
    ingestStories(store, sig, { t: 'storyGone', nativeId: 'g:1' }, now);
    expect(store.one(`SELECT 1 FROM story WHERE native_id = 'g:1'`)).toBeNull();
  });

  test('opening one tells the adapter once', async () => {
    const [s] = media.stories({ identityId: identity('signal', 'Alice Chen') });
    const before = sent.length;
    expect(media.viewed(s.id)).toEqual({ sent: true });
    expect(media.viewed(s.id)).toEqual({ sent: false });
    expect(sent.slice(before).map((x) => [x.cmd.t, x.cmd.story])).toEqual([['storyViewed', s.id && store.one<{ native_id: string }>('SELECT native_id FROM story WHERE id = ?', s.id)!.native_id]]);
    expect(media.stories({ identityId: identity('signal', 'Alice Chen') })[0].viewed).toBe(true);
    await settle();
  });

  test('a reply goes through the account that heard it, to the group of a group story', async () => {
    const [s] = media.stories({ identityId: identity('signal', 'Sam Rivera') });
    const r = await media.reply(s.id, { body: 'nice view' });
    expect(r.nativeId).toBeString();
    const last = sent[sent.length - 1];
    expect(last.cmd).toMatchObject({ t: 'storyReply', body: 'nice view' });
    expect(last.cmd.conversation).toBeUndefined();
    store.flush();
    const msg = store.one<{ extra: string }>('SELECT extra FROM message WHERE id = ?', hubId('msg', 'signal', r.nativeId!));
    expect(JSON.parse(msg!.extra).storyReply).toMatchObject({ author: expect.any(String) });
    const react = await media.reply(s.id, { emoji: '❤️' });
    expect(react.nativeId).toBeString();
    expect(sent[sent.length - 1].cmd).toMatchObject({ t: 'storyReply', emoji: '❤️' });
  });

  test('replies turned off, or nothing written, are refused before the network', async () => {
    const [g] = media.stories({ conversationId: conv('signal', 'Climbing crew 🧗') });
    const before = sent.length;
    expect((await refused(media.reply(g.id, { body: 'hi' }))).message).toBe('Its author turned replies off.');
    const [s] = media.stories({ identityId: identity('signal', 'Sam Rivera') });
    expect((await refused(media.reply(s.id, { body: '  ' }))).status).toBe(400);
    expect(sent.length).toBe(before);
    expect((await refused(() => media.viewed('sty_nothing'))).status).toBe(404);
  });

  test('a day on, they are all gone', () => {
    expect(pruneStories(store.db, now + STORY_LIFETIME_MS + 1)).toBeGreaterThanOrEqual(1);
    expect(store.one(`SELECT 1 FROM story WHERE native_id = 'y:1'`)).toBeNull();
    expect(media.stories({ identityId: identity('signal', 'Alice Chen') })).toEqual([]);
  });
});

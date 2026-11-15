/**
 * How chats show pictures (docs/pictures.md), on the hub's side: the setting for every chat (arrange), a chat's or a
 * server's own (place_pref), and a picture that came without its size, which has the media archive keep it now.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { MediaArchiver } from '../src/mediaarchive.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { UsageStore } from '../src/usage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-pictures-'));
const store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
store.db.exec('PRAGMA synchronous = OFF');
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

let acc = store.createAccount({ id: 'acc_sg', network: 'signal', label: 'phone', color: '#000', adapter: 'signal' });
store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true } });
acc = store.account('acc_sg')!;
const T0 = Date.UTC(2026, 4, 1);
const picture = (id: string, att: Partial<P.AttachmentFact>): P.MessageFact => ({
  nativeId: id,
  conversation: 'dm1',
  author: 'friend',
  ts: T0 + Number(id) * 1000,
  body: '',
  attachments: [{ kind: 'image', url: `https://cdn.example/${id}.png`, mime: 'image/png', ...att }],
});

describe('the setting for every chat', () => {
  test('absent until set; only the five ways are kept', () => {
    const usage = new UsageStore(store.db);
    expect(usage.arrange().pictures).toBeUndefined();
    expect(usage.patchArrange({ pictures: 'rows' }).pictures).toBe('rows');
    expect(usage.patchArrange({ pictures: 'huge' }).pictures).toBe('rows');
    expect(usage.patchArrange({ sort: { rail: 'az' } })).toMatchObject({ pictures: 'rows', sort: { rail: 'az' } });
  });
});

describe("a chat's or a server's own way", () => {
  test('set, left alone by other changes, and taken away with null', () => {
    store.patchPlacePrefs([{ kind: 'conversation', id: 'cv1', pictures: 'fold' }, { kind: 'space', id: 'sp1', pictures: 'small' }]);
    const of = (id: string) => store.placePrefs().find((p) => p.id === id);
    expect(of('cv1')?.pictures).toBe('fold');
    expect(of('sp1')?.pictures).toBe('small');
    store.patchPlacePrefs([{ kind: 'conversation', id: 'cv1', pinned: true }]);
    expect(of('cv1')).toMatchObject({ pictures: 'fold', pinned: true });
    store.patchPlacePrefs([{ kind: 'conversation', id: 'cv1', pictures: 'huge' as P.PictureLayout }]);
    expect(of('cv1')?.pictures).toBe('fold');
    store.patchPlacePrefs([{ kind: 'conversation', id: 'cv1', pictures: null }]);
    expect(of('cv1')?.pictures).toBeUndefined();
    expect(of('sp1')?.pictures).toBe('small');
  });
});

describe('a picture without its size', () => {
  test('flags the store, which has the media archive keep the new file now once it has started', async () => {
    store.sizelessPictures = false;
    store.ingest(acc, { t: 'message', message: picture('1', { width: 640, height: 480 }), live: true });
    expect(store.sizelessPictures).toBe(false);
    store.ingest(acc, { t: 'message', message: picture('2', {}), live: true });
    expect(store.sizelessPictures).toBe(true);

    const cache = join(dir, 'media-cache');
    mkdirSync(cache, { recursive: true });
    const fetched: string[] = [];
    const key = (u: string) => new Bun.CryptoHasher('sha256').update(u).digest('hex');
    const archive = new MediaArchiver(store, cache, async (url) => {
      fetched.push(url);
      writeFileSync(join(cache, key(url)), 'x');
      return true;
    });
    // Not started (a hub that is still starting, or one that keeps nothing): a nudge does nothing.
    await archive.nudge();
    expect(fetched).toEqual([]);
    await archive.start(3_600_000);
    expect(fetched).toEqual(['https://cdn.example/1.png', 'https://cdn.example/2.png']);
    store.ingest(acc, { t: 'message', message: picture('3', {}), live: true });
    await archive.nudge();
    archive.stop();
    expect(fetched).toEqual(['https://cdn.example/1.png', 'https://cdn.example/2.png', 'https://cdn.example/3.png']);
  });
});

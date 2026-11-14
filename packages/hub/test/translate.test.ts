/** Translating posts (translate.ts, docs/translate.md): the network's own, a translation server, settings, the route. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { needsTranslation, TRANSLATE_DEFAULTS } from '@dither-chat/protocol';
import { DEMO_X_ACCOUNT, DemoX } from '../src/demo-x.ts';
import { mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { serverUrlOf, TranslateError, Translator } from '../src/translate.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-translate-'));
let store: Store;
let acc: AccountRow;
let adapter: DemoX;
let online = true;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const sent: P.AdapterCommand[] = [];
const pid = (n: number) => String(1_900_000_000_000_000_000n + BigInt(n) * 104_729n);

function command<T>(cmd: P.AdapterCommand): Promise<T> {
  sent.push(cmd);
  return new Promise<T>((resolve, reject) => {
    if ('id' in cmd) pending.set(cmd.id, { resolve: resolve as (v: unknown) => void, reject });
    adapter.command(cmd);
  });
}
/** A LibreTranslate stand-in: what it was asked, and its answer. */
const asked: Record<string, unknown>[] = [];
let serverAnswer: (b: Record<string, unknown>) => Response = (b) => Response.json({ translatedText: `[${b.target}] ${b.q}`, detectedLanguage: { language: 'fr', confidence: 90 } });
const fakeFetch = (async (_url: string, init: RequestInit) => {
  const b = JSON.parse(String(init.body));
  asked.push(b);
  return serverAnswer(b);
}) as unknown as typeof fetch;
const make = () => new Translator({ store, online: () => online, command: <T,>(_: string, cmd: object) => command<T>({ ...cmd, id: crypto.randomUUID() } as P.AdapterCommand), fetch: fakeFetch });

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  acc = store.createAccount({ ...DEMO_X_ACCOUNT, adapter: 'demo', demo: true, config: { epoch: Date.now() } });
  const adir = join(dir, acc.id);
  mkdirSync(adir, { recursive: true });
  adapter = new DemoX(acc, adir);
  store.db.transaction(() =>
    adapter.start((ev) => {
      if (ev.t === 'reply') {
        const p = pending.get(ev.id);
        pending.delete(ev.id);
        if (ev.ok) p?.resolve(ev.result);
        else p?.reject(new Error(ev.error));
        return;
      }
      store.ingest(store.account(acc.id)!, ev);
    }),
  )();
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('what needs translating', () => {
  test('a known language other than the target; not "und", media-only or hashtag-only', () => {
    expect(needsTranslation('ja', 'en')).toBe(true);
    expect(needsTranslation('en-GB', 'en')).toBe(false);
    expect(needsTranslation('pt', 'pt-BR')).toBe(false);
    for (const none of [undefined, '', 'und', 'zxx', 'qme', 'qht']) expect(needsTranslation(none, 'en')).toBe(false);
  });
});

describe('the network translates its own posts', () => {
  test("X's translation, labelled by who did it, and asked once for the same post", async () => {
    const t = make();
    expect(t.networks()).toEqual(['x']);
    const r = await t.translate([{ key: 'a', text: '面白い結果ですね。', lang: 'ja', network: 'x', post: pid(60) }]);
    expect(r.failed).toEqual([]);
    expect(r.translations[0]).toEqual({ key: 'a', text: 'Interesting result. That number without landmarks is surprising.', from: 'ja', by: 'Grok via X' });
    expect(sent.at(-1)).toMatchObject({ t: 'translate', post: pid(60), to: 'en', lang: 'ja' });
    const n = sent.length;
    const again = await t.translate([{ key: 'b', text: '面白い結果ですね。', lang: 'ja', network: 'x', post: pid(60) }]);
    expect(again.translations[0]).toMatchObject({ key: 'b', by: 'Grok via X' });
    expect(sent.length).toBe(n);
  });

  test('X refusing, with no server set: said why, per item; the others still come', async () => {
    const r = await make().translate([
      { key: 'ok', text: '¿Funciona?', lang: 'es', network: 'x', post: pid(61) },
      { key: 'no', text: 'Bonjour', lang: 'fr', network: 'x', post: pid(1) },
    ]);
    expect(r.translations.map((x) => x.key)).toEqual(['ok']);
    expect(r.failed).toEqual([{ key: 'no', why: 'X: X has no translation for this post' }]);
  });
});

describe('a translation server', () => {
  test('stands in where the network cannot: the server is asked LibreTranslate’s way', async () => {
    const t = make();
    t.setSettings({ serverUrl: 'http://127.0.0.1:5000/' });
    const r = await t.translate([{ key: 'm', text: 'Bonjour tout le monde', network: 'x', post: pid(1) }]);
    expect(r.translations[0]).toEqual({ key: 'm', text: '[en] Bonjour tout le monde', from: 'fr', by: 'Translation server' });
    expect(asked.at(-1)).toEqual({ q: 'Bonjour tout le monde', source: 'auto', target: 'en', format: 'text' });
    // A text with no post (a message) goes to the server only.
    const m = await t.translate([{ key: 'x', text: 'Hallo', lang: 'de' }], 'ja');
    expect(m.translations[0]).toMatchObject({ text: '[ja] Hallo' });
    expect(asked.at(-1)).toMatchObject({ source: 'de', target: 'ja' });
  });

  test('first when the settings say so; X when the server fails', async () => {
    const t = make();
    t.setSettings({ provider: 'server', serverUrl: 'http://127.0.0.1:5000' });
    const r = await t.translate([{ key: 'k', text: '面白い', lang: 'ja', network: 'x', post: pid(60) }]);
    expect(r.translations[0]!.by).toBe('Translation server');
    serverAnswer = () => Response.json({ error: 'no model for ja' }, { status: 400 });
    const f = await t.translate([{ key: 'k', text: '面白いですね', lang: 'ja', network: 'x', post: pid(60) }]);
    expect(f.translations[0]!.by).toBe('Grok via X');
    online = false;
    const none = await t.translate([{ key: 'k', text: 'もう一度', lang: 'ja', network: 'x', post: pid(60) }]);
    expect(none.failed[0]!.why).toBe('the translation server: no model for ja');
    online = true;
    t.setSettings({ provider: 'network', serverUrl: null });
  });
});

describe('settings', () => {
  test('defaults; each checked; kept', () => {
    store.setMetaValue('translate', null);
    const t = make();
    expect(t.settings()).toEqual(TRANSLATE_DEFAULTS);
    expect(t.setSettings({ auto: false, show: 'replace', to: 'pt-BR' })).toMatchObject({ auto: false, show: 'replace', to: 'pt-BR' });
    expect(make().settings()).toMatchObject({ auto: false, show: 'replace', to: 'pt-BR' });
    for (const bad of [{ show: 'side' }, { to: 'english' }, { provider: 'google' }, { serverUrl: 'ftp://x' }, { serverUrl: 'http://u:p@h' }]) expect(() => t.setSettings(bad)).toThrow(TranslateError);
    expect(serverUrlOf('https://translate.example/api/')).toBe('https://translate.example/api');
    t.setSettings({ auto: true, show: 'below', to: 'en' });
  });

  test('a call: items needed, at most 40, keys and texts, a target that is a language', async () => {
    const t = make();
    await expect(t.translate([])).rejects.toThrow('items');
    await expect(t.translate(Array.from({ length: 41 }, (_, i) => ({ key: `${i}`, text: 'x' })))).rejects.toThrow('at most 40');
    await expect(t.translate([{ text: 'x' }])).rejects.toThrow('a key and its text');
    await expect(t.translate([{ key: 'a', text: 'x' }], 'nope!')).rejects.toThrow('to:');
    const blank = await t.translate([{ key: 'a', text: '   ' }]);
    expect(blank.translations[0]).toMatchObject({ key: 'a', text: '' });
  });
});

/** Sensitive messages (sensitive.ts, docs/sensitive.md): chances kept per question, your answers, trying a question. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sensitiveLevel, SENSITIVE_DEFAULTS } from '@dither-chat/protocol';
import { agreementOf, judgeText, Sensitive, type SensitiveJudge } from '../src/sensitive.ts';
import { Store } from '../src/store.ts';

describe('agreement', () => {
  test('counts the cover line against your answers, and finds the line that agrees most', () => {
    const a = agreementOf(1, [
      { p: 0.9, vote: true },
      { p: 0.5, vote: true },
      { p: 0.45, vote: false },
      { p: 0.1, vote: false },
      { p: null, vote: true },
    ], 0.4);
    expect(a.n).toBe(4);
    expect(a.unjudged).toBe(1);
    expect(a.matrix).toEqual({ yesSensitive: 2, yesFine: 1, noSensitive: 0, noFine: 1 });
    expect(a.agreement).toBe(0.75);
    expect(a.best).toEqual({ line: 0.5, agreement: 1 });
    expect(a.ap).toBe(1);
  });

  test('no answers: nothing to say', () => {
    const a = agreementOf(1, [], 0.4);
    expect(a.agreement).toBeNull();
    expect(a.best).toBeNull();
    expect(a.ap).toBeNull();
  });
});

describe('levels', () => {
  const on = { ...SENSITIVE_DEFAULTS, on: true, cover: 0.4, hide: 0.75 };
  test('shown, covered, hidden by the chance; your answer wins', () => {
    expect(sensitiveLevel(on, { p: 0.1, v: 1 })).toBe('shown');
    expect(sensitiveLevel(on, { p: 0.5, v: 1 })).toBe('cover');
    expect(sensitiveLevel(on, { p: 0.8, v: 1 })).toBe('hide');
    expect(sensitiveLevel(on, { p: 0.8, v: 1, vote: false })).toBe('shown');
    expect(sensitiveLevel(on, { p: 0.1, v: 1, vote: true })).toBe('cover');
    expect(sensitiveLevel({ ...on, on: false }, { p: 0.9, v: 1 })).toBe('shown');
  });
});

test('the text the model reads names the files', () => {
  expect(judgeText('look', ['image/png', 'audio/ogg'])).toBe('look [picture] [voice message]');
  expect(judgeText('', [])).toBeNull();
});

describe('in the hub', () => {
  let dir: string;
  let store: Store;
  let sensitive: Sensitive;
  /** The questions asked and the texts, and a stand-in model: "scan" is sensitive to question 1, "bank" to any other. */
  const asked: { q: string; n: number }[] = [];
  const judge: SensitiveJudge = async (q, texts) => {
    asked.push({ q, n: texts.length });
    const first = q.startsWith('Is this message sensitive');
    return texts.map((t) => (/scan/.test(t) ? 0.9 : /bank/.test(t) ? (first ? 0.2 : 0.8) : 0.05));
  };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dither-sensitive-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    let acc = store.createAccount({ network: 'matrix', label: 'a', color: '#000', adapter: 'matrix' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    acc = store.account(acc.id)!;
    store.ingest(acc, { t: 'identity', identity: { nativeId: 'sam', displayName: 'Sam', contact: true } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['me', 'sam'] } });
    const bodies = { hello: 'hello there', scan: 'here is the scan', bank: 'the bank called again', lunch: 'lunch?' };
    let ts = Date.UTC(2026, 9, 1);
    for (const [k, body] of Object.entries(bodies)) {
      store.ingest(acc, { t: 'message', message: { nativeId: k, conversation: 'dm', author: 'sam', ts: ts++, body }, live: true });
      ids[k] = (store.db.query('SELECT id FROM message WHERE native_id = ?').get(k) as { id: string }).id;
    }
    store.flush();
    sensitive = new Sensitive({ store, judge, model: 'test', flush: () => store.flush(), messages: () => ({ messages: [], identities: [] }) });
    store.sensitiveMarks = (x) => sensitive.marks(x);
    sensitive.later(Object.values(ids));
    await sensitive.idle();
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const view = (k: string) => store.messageViews(store.raw('SELECT * FROM message WHERE id = ?', ids[k]))[0];

  test('each message carries its chance from the question in use', () => {
    expect(view('scan').sensitive).toEqual({ p: 0.9, v: 1 });
    expect(view('bank').sensitive).toEqual({ p: 0.2, v: 1 });
    expect(asked).toEqual([{ q: expect.stringMatching(/^Is this message sensitive/), n: 4 }]);
  });

  test('answers are kept on the message and score the question', () => {
    sensitive.vote(ids.scan, true);
    sensitive.vote(ids.bank, true);
    sensitive.vote(ids.hello, false);
    expect(view('bank').sensitive).toEqual({ p: 0.2, v: 1, vote: true });
    const a = sensitive.state().agreement;
    expect(a.n).toBe(3);
    expect(a.matrix).toEqual({ yesSensitive: 1, yesFine: 0, noSensitive: 1, noFine: 1 });
    expect(sensitive.disagreements(1).map((d) => d.messageId)).toEqual([ids.bank]);
  });

  test('a new question is tried on your answers only, and is not in use until adopted', async () => {
    asked.length = 0;
    const t = await sensitive.trial('Would I mind someone seeing this over my shoulder?');
    expect(t.prompt).toMatchObject({ version: 2, inUse: false, adoptedAt: null });
    expect(asked).toEqual([{ q: 'Would I mind someone seeing this over my shoulder?', n: 3 }]);
    expect(t.agreement.agreement).toBe(1);
    expect(t.inUse.agreement).toBeCloseTo(2 / 3);
    // Still the first question's chance on the message.
    expect(view('bank').sensitive?.v).toBe(1);

    sensitive.adopt(2);
    await sensitive.idle();
    expect(sensitive.version()).toBe(2);
    expect(view('bank').sensitive).toEqual({ p: 0.8, v: 2, vote: true });
    expect(view('lunch').sensitive).toEqual({ p: 0.05, v: 2 });
  });

  test('settings keep their lines in order', () => {
    expect(sensitive.setSettings({ on: true, cover: 0.9 })).toMatchObject({ on: true, cover: 0.9, hide: 0.9 });
    expect(sensitive.setSettings({ hide: 0.3 })).toMatchObject({ cover: 0.3, hide: 0.3 });
    expect(sensitive.setSettings({ style: 'bar', top: 'gone' })).toMatchObject({ style: 'bar', top: 'gone' });
  });
});

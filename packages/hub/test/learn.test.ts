/**
 * The decision model (learn.ts, docs/notifications.md): two chances for a message, each from its own start (the local
 * model's answer against a bar for an alert, the network's own setting for importance) and moved by your marks as far
 * as the hierarchy allows; the tier those chances and the Conversation rule give; the backtest; and the model in
 * words. The whole loop through a store is in triage-tiers.test.ts and marks.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  agrees,
  ALERT_BAR,
  alertBar,
  backtest,
  contextOf,
  describe as say,
  describeWeight,
  emptyModel,
  features,
  HEADS,
  HEAD_NAME,
  importance,
  isTier,
  labels,
  labelsOf,
  lambda,
  NOTIFIED,
  OLD_VOTE,
  predict,
  prior,
  STOOD,
  STOOD_PER_PLACE,
  THRESHOLDS,
  tierFrom,
  TIER_NAME,
  TIERS,
  topWeights,
  train,
  UNJUDGED,
  validModel,
  voteWeight,
  words,
  type Example,
  type Facts,
  type Model,
  type TierContext,
} from '../src/learn.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 12);

/** A Signal DM from someone you know, which Signal itself would notify you about. */
const facts = (f: Partial<Facts> = {}): Facts => ({
  network: 'signal',
  shape: 'direct',
  conversation: 'c1',
  spaces: [],
  author: 'p1',
  bot: false,
  mention: false,
  everyone: false,
  reply: false,
  question: false,
  urgent: false,
  active: false,
  media: false,
  base: 'drop',
  native: 'all',
  notify: true,
  score: 0.15,
  known: true,
  conv: true,
  ...f,
});
/** A mark of yours: what it says for each chance. */
const mark = (f: Partial<Facts>, y: Example['y'], ws: string[] = [], at = NOW): Example => ({ facts: facts(f), words: ws, y, weight: 1, vote: true, at });
/** Something that stood: an alert left unmarked, or a Conversation message that did not alert. */
const stood = (f: Partial<Facts>, y: Example['y']): Example => ({ facts: facts(f), words: [], y, weight: STOOD, vote: false, at: NOW - DAY });
const names = { conversation: (id: string) => `#${id}`, space: (id: string) => `Server ${id}`, person: (id: string) => `Person ${id}`, network: (id: string) => id };
/** The tier a model gives a message: its two chances, with the context kept in its facts. */
const tier = (m: Model, f: Partial<Facts> = {}, ws: string[] = []) => tierFrom(predict(m, facts(f), ws).probs, contextOf(facts(f)));
const logit = (p: number) => Math.log(p / (1 - p));

describe('the start, before any mark', () => {
  test('alert: the local model’s answer against the bar, even odds exactly at it', () => {
    expect(ALERT_BAR).toEqual({ direct: 0.05, other: 0.2 });
    // A DM: the lower bar.
    expect(prior(facts({ judge: 0.05 })).alert).toBeCloseTo(0.5, 10);
    expect(prior(facts({ judge: 0.06 })).alert).toBeGreaterThan(0.5);
    expect(prior(facts({ judge: 0.04 })).alert).toBeLessThan(0.5);
    // In log-odds it is the answer less the bar: an answer of 0.3 against 0.05.
    expect(logit(prior(facts({ judge: 0.3 })).alert)).toBeCloseTo(logit(0.3) - logit(0.05), 6);
    // A group chat you only take part in: the higher one, unless the message is about you.
    const group = { shape: 'group', conversation: 'g' };
    expect(prior(facts({ ...group, judge: 0.2 })).alert).toBeCloseTo(0.5, 10);
    expect(prior(facts({ ...group, judge: 0.05 })).alert).toBeLessThan(0.2);
    expect(prior(facts({ ...group, judge: 0.05, mention: true })).alert).toBeCloseTo(0.5, 10);
    expect(prior(facts({ ...group, judge: 0.05, reply: true })).alert).toBeCloseTo(0.5, 10);
    // @everyone is not you by name.
    expect(prior(facts({ ...group, judge: 0.05, everyone: true })).alert).toBeLessThan(0.2);
    expect(alertBar({ shape: 'direct', mention: false, reply: false })).toBe(ALERT_BAR.direct);
    expect(alertBar({ shape: 'channel', mention: false, reply: false })).toBe(ALERT_BAR.other);
    expect(alertBar({ shape: 'channel', mention: false, reply: true })).toBe(ALERT_BAR.direct);
  });

  test('alert: without an answer, the chance of a message nobody read; an answer of 0 or 1 stays a chance', () => {
    expect(UNJUDGED).toBe(0.02);
    expect(prior(facts()).alert).toBe(UNJUDGED);
    expect(prior(facts({ shape: 'group', mention: true })).alert).toBe(UNJUDGED);
    const never = prior(facts({ judge: 0 })).alert;
    const always = prior(facts({ judge: 1 })).alert;
    expect(never).toBeGreaterThan(0);
    expect(never).toBeLessThan(0.05);
    expect(always).toBeLessThan(1);
    expect(always).toBeGreaterThan(0.99);
  });

  test('importance: 80% where the network would notify; else by how much it is about you, at most 60%', () => {
    expect(NOTIFIED).toBe(0.8);
    expect(prior(facts()).important).toBe(0.8);
    const quiet = { notify: false, native: 'mentions' as const };
    expect(prior(facts({ ...quiet, score: 0.15 })).important).toBeCloseTo(0.05 + 0.75 * 0.15, 10);
    expect(prior(facts({ ...quiet, score: 0.4 })).important).toBeCloseTo(0.35, 10);
    expect(prior(facts({ ...quiet, score: 0 })).important).toBeCloseTo(0.05, 10);
    expect(prior(facts({ ...quiet, score: 0.8 })).important).toBe(0.6);
    expect(prior(facts({ ...quiet, score: 1 })).important).toBe(0.6);
    // No score kept: as little about you as a message can be.
    expect(prior(facts({ ...quiet, score: undefined })).important).toBeCloseTo(0.1625, 10);
    // Neither chance looks at the other's start.
    expect(prior(facts({ ...quiet, score: 0.4, judge: 0.9 })).important).toBeCloseTo(0.35, 10);
    expect(prior(facts({ judge: 0.9 })).important).toBe(0.8);
  });

  test('importance: half from a bot; a rule of yours (List only) does not raise it', () => {
    expect(prior(facts({ bot: true })).important).toBeCloseTo(0.4, 10);
    expect(prior(facts({ bot: true, notify: false, score: 0.4 })).important).toBeCloseTo(0.175, 10);
    expect(prior(facts({ bot: true, notify: false, score: 1 })).important).toBeCloseTo(0.3, 10);
    expect(prior(facts({ notify: false, score: 0.15, cap: true, explicit: true })).important).toBeCloseTo(0.1625, 10);
  });

  test('importance: facts from before `notify` was kept say it by where the rules put them', () => {
    const old = (base: Facts['base'], score = 0.4) => prior(facts({ notify: undefined, base, score })).important;
    expect(old('push')).toBe(0.8);
    expect(old('quiet')).toBe(0.8);
    expect(old('digest')).toBeCloseTo(0.35, 10);
    expect(old('drop')).toBeCloseTo(0.35, 10);
    // Once kept, `notify` wins over the base.
    expect(prior(facts({ notify: false, base: 'push', score: 0.4 })).important).toBeCloseTo(0.35, 10);
    expect(prior(facts({ notify: true, base: 'drop', score: 0.4 })).important).toBe(0.8);
  });
});

describe('the tier', () => {
  const ctx = (c: Partial<TierContext> = {}): TierContext => ({ conv: false, eligible: false, judged: false, ...c });
  const all = { conv: true, eligible: true, judged: true };

  test('an alert needs all three: it may alert, the local model answered, and the chance is even or better', () => {
    expect(THRESHOLDS).toEqual({ alert: 0.5, important: 0.6 });
    expect(tierFrom({ alert: 0.5, important: 0.1 }, ctx(all))).toBe('push');
    expect(tierFrom({ alert: 0.99, important: 0.1 }, ctx(all))).toBe('push');
    expect(tierFrom({ alert: 0.49, important: 0.99 }, ctx(all))).toBe('quiet');
    // No answer from the local model: nothing alerts by chance, however high.
    expect(tierFrom({ alert: 0.99, important: 0.1 }, ctx({ ...all, judged: false }))).toBe('quiet');
    // Not one that may alert.
    expect(tierFrom({ alert: 0.99, important: 0.7 }, ctx({ judged: true }))).toBe('digest');
    expect(tierFrom({ alert: 0.99, important: 0.1 }, ctx({ conv: true, judged: true }))).toBe('quiet');
    // A place you marked may alert without being a Conversation; under the bar it goes by its importance.
    expect(tierFrom({ alert: 0.6, important: 0.1 }, ctx({ eligible: true, judged: true }))).toBe('push');
    expect(tierFrom({ alert: 0.4, important: 0.7 }, ctx({ eligible: true, judged: true }))).toBe('digest');
    expect(tierFrom({ alert: 0.4, important: 0.1 }, ctx({ eligible: true, judged: true }))).toBe('drop');
  });

  test('a Conversation is one whatever its importance; the rest is on the list at your level or more, or below it', () => {
    expect(tierFrom({ alert: 0.02, important: 0.01 }, ctx({ conv: true }))).toBe('quiet');
    expect(tierFrom({ alert: 0.02, important: 0.99 }, ctx({ conv: true }))).toBe('quiet');
    expect(tierFrom({ alert: 0.02, important: 0.6 }, ctx())).toBe('digest');
    expect(tierFrom({ alert: 0.02, important: 0.599 }, ctx())).toBe('drop');
    // Your own level, and another bar for alerts.
    expect(tierFrom({ alert: 0.02, important: 0.35 }, ctx(), { alert: 0.5, important: 0.3 })).toBe('digest');
    expect(tierFrom({ alert: 0.02, important: 0.8 }, ctx(), { alert: 0.5, important: 0.9 })).toBe('drop');
    expect(tierFrom({ alert: 0.6, important: 0.1 }, ctx(all), { alert: 0.7, important: 0.6 })).toBe('quiet');
  });

  test('List only is a cap: never an alert or a Conversation, the list or below it by importance', () => {
    const capped = ctx({ ...all, listOnly: true });
    expect(tierFrom({ alert: 0.99, important: 0.8 }, capped)).toBe('digest');
    expect(tierFrom({ alert: 0.99, important: 0.2 }, capped)).toBe('drop');
    expect(tierFrom({ alert: 0.02, important: 0.6 }, capped)).toBe('digest');
  });

  test('the context kept with the facts', () => {
    expect(contextOf(facts({ conv: true, judge: 0.3 }))).toEqual({ conv: true, eligible: true, judged: true, listOnly: false });
    expect(contextOf(facts({ conv: false }))).toEqual({ conv: false, eligible: false, judged: false, listOnly: false });
    expect(contextOf(facts({ conv: undefined, judge: 0 }))).toEqual({ conv: false, eligible: false, judged: true, listOnly: false });
    // A marked place: it may alert though it is no Conversation.
    expect(contextOf(facts({ conv: false, judge: 0.3 }), true)).toEqual({ conv: false, eligible: true, judged: true, listOnly: false });
    expect(contextOf(facts({ cap: true }))).toMatchObject({ listOnly: true });
  });

  test('before any mark: a DM that reads urgent alerts, one that does not is a Conversation; elsewhere the network’s setting decides', () => {
    const m = emptyModel();
    expect(tier(m, { judge: 0.3 })).toBe('push');
    expect(tier(m, { judge: 0.01 })).toBe('quiet');
    expect(tier(m)).toBe('quiet');
    const channel = { shape: 'channel', network: 'discord', conversation: 'ch', spaces: ['hub'], conv: false };
    expect(tier(m, { ...channel })).toBe('digest');
    expect(tier(m, { ...channel, notify: false, native: 'mentions', score: 0.4 })).toBe('drop');
    expect(tier(m, { ...channel, bot: true })).toBe('drop');
    expect(TIERS).toEqual(['drop', 'digest', 'quiet', 'push']);
    expect(isTier('quiet')).toBe(true);
    expect(isTier('silent')).toBe(false);
    expect(importance({ alert: 0.9, important: 0.123456 })).toBe(0.123);
  });
});

describe('learning from marks', () => {
  // A DM whose message the local model read as just under the bar.
  const under = { judge: 0.03 };

  test('one mark moves its conversation: "should have alerted" there makes the next one like it alert', () => {
    expect(tier(emptyModel(), under)).toBe('quiet');
    const m = train([mark(under, { alert: 1 })]);
    expect(m.w.alert['conv:c1']).toBeGreaterThan(0.25);
    expect(tier(m, under)).toBe('push');
    expect(predict(m, facts(under)).probs.alert).toBeGreaterThan(prior(facts(under)).alert + 0.2);
    // Another DM, with someone else: one mark there is not enough to move it.
    expect(tier(m, { ...under, conversation: 'c2', author: 'p2' })).toBe('quiet');
    // And the other way: "the alert was wrong" stops the next one like it.
    const over = { judge: 0.08 };
    expect(tier(emptyModel(), over)).toBe('push');
    const wrong = train([mark(over, { alert: 0 })]);
    expect(wrong.w.alert['conv:c1']).toBeLessThan(-0.25);
    expect(tier(wrong, over)).toBe('quiet');
    expect(tier(wrong, { ...over, conversation: 'c2', author: 'p2' })).toBe('push');
  });

  test('the hierarchy: on the same examples a conversation moves most, then a person, a server, a network', () => {
    expect(lambda('conv:c1')).toBe(0.5);
    expect(lambda('author:p1')).toBe(1);
    expect(lambda('w:deploy')).toBe(1);
    expect(lambda('space:hub')).toBe(4);
    expect(lambda('network:signal')).toBe(40);
    expect(lambda('shape:direct')).toBe(40);
    expect(lambda('mention')).toBe(40);
    expect(lambda('all')).toBe(80);
    // A scope with whether it is about you moves first.
    expect(lambda('conv:c1&!you')).toBe(0.25);
    expect(lambda('space:hub&you')).toBe(2);
    const here = { shape: 'channel', network: 'discord', conversation: 'ch', spaces: ['hub'], conv: false };
    const m = train([mark(here, { important: 0 }), mark(here, { important: 0 }), mark(here, { important: 0 })]);
    const w = (k: string) => Math.abs(m.w.important[k] ?? 0);
    expect(w('conv:ch')).toBeGreaterThan(w('author:p1'));
    expect(w('author:p1')).toBeGreaterThan(w('space:hub'));
    expect(w('space:hub')).toBeGreaterThan(w('network:discord'));
    expect(w('network:discord')).toBeGreaterThan(w('all'));
    expect(w('conv:ch')).toBeGreaterThan(10 * w('network:discord'));
    for (const k of ['conv:ch', 'author:p1', 'space:hub']) expect(m.w.important[k]).toBeLessThan(0);
  });

  test('"less like this" twice in one Signal chat takes it off the list, and leaves the rest of Signal on it', () => {
    const group = { shape: 'group', conversation: 'g', conv: false };
    expect(tier(emptyModel(), group)).toBe('digest');
    const m = train([mark(group, { important: 0 }), mark(group, { important: 0 })]);
    expect(tier(m, group)).toBe('drop');
    expect(tier(m, { ...group, conversation: 'g2', author: 'p9' })).toBe('digest');
    expect(predict(m, facts({ ...group, conversation: 'g2', author: 'p9' })).probs.important).toBeGreaterThan(0.75);
  });

  test('marks across a server, not about you, teach the server; a mention there stays on the list', () => {
    const ch = (c: string, f: Partial<Facts> = {}) => ({ network: 'discord', shape: 'channel', conversation: c, spaces: ['hub'], author: `a-${c}`, conv: false, ...f });
    const m = train(['a', 'b', 'c', 'd'].flatMap((c) => [mark(ch(c), { important: 0 }), mark(ch(c), { important: 0 })]));
    expect(tier(emptyModel(), ch('e'))).toBe('digest');
    expect(tier(m, ch('e'))).toBe('drop');
    expect(m.w.important['space:hub&!you']).toBeLessThan(0);
    // About you: the marks said nothing of that.
    expect(predict(m, facts(ch('e', { mention: true }))).probs.important).toBeGreaterThanOrEqual(THRESHOLDS.important);
    // Another server is where it was.
    expect(tier(m, { ...ch('x'), spaces: ['other'] })).toBe('digest');
  });

  test('words: what you marked down for what it says moves other messages that say it', () => {
    const m = train(['a', 'b', 'c', 'd', 'e'].map((c) => mark({ conversation: c, author: `p-${c}` }, { important: 0 }, ['standup', 'notes', c + 'x'])));
    const elsewhere = facts({ conversation: 'z', author: 'pz' });
    const with_ = predict(m, elsewhere, ['standup', 'notes']).probs.important;
    const without = predict(m, elsewhere, ['lunch', 'today']).probs.important;
    expect(m.w.important['w:standup']).toBeLessThan(0);
    expect(with_).toBeLessThan(without - 0.05);
  });

  test('an example teaches only the chances it labels', () => {
    const less = train([mark({}, { important: 0 }), mark({}, { important: 0 })]);
    expect(Object.keys(less.w.important).length).toBeGreaterThan(0);
    expect(less.w.alert).toEqual({});
    expect(predict(less, facts(under)).probs.alert).toBe(prior(facts(under)).alert);
    const alert = train([mark(under, { alert: 1 })]);
    expect(Object.keys(alert.w.alert).length).toBeGreaterThan(0);
    expect(alert.w.important).toEqual({});
    expect(predict(alert, facts(under)).probs.important).toBe(0.8);
    // A mark may say both.
    const both = train([mark({ judge: 0.08 }, { alert: 0, important: 0 })]);
    expect(both.w.alert['conv:c1']).toBeLessThan(0);
    expect(both.w.important['conv:c1']).toBeLessThan(0);
    // And one that says nothing teaches nothing.
    expect(train([mark({}, {})])).toEqual(emptyModel());
  });

  test('a vote from before the tiers is about importance only: Important or Active was worth seeing, Digest or below was not', () => {
    expect(labels('push')).toEqual({ important: 1 });
    expect(labels('quiet')).toEqual({ important: 1 });
    expect(labels('digest')).toEqual({ important: 0 });
    expect(labels('drop')).toEqual({ important: 0 });
    expect(labelsOf({ label: 'digest' })).toEqual({ important: 0 });
    // What an example says outright wins over its old label; one with neither says nothing.
    expect(labelsOf({ label: 'push', y: { alert: 0 } })).toEqual({ alert: 0 });
    expect(labelsOf({})).toEqual({});
    expect(OLD_VOTE).toBe(0.5);
    const old = (label: Example['label'], f: Partial<Facts> = {}): Example => ({ facts: facts(f), words: [], label, weight: OLD_VOTE, vote: true, at: NOW });
    const quiet = { notify: false, native: 'mentions' as const, score: 0.4, shape: 'channel', conversation: 'ch', conv: false };
    const up = train([old('quiet', quiet), old('push', quiet)]);
    expect(up.w.alert).toEqual({});
    expect(predict(up, facts(quiet)).probs.important).toBeGreaterThan(0.35);
    const down = train([old('digest'), old('drop')]);
    expect(down.w.alert).toEqual({});
    expect(predict(down, facts()).probs.important).toBeLessThan(0.8);
    // Half a mark: it moves less than a mark does.
    const full = train([mark({}, { important: 0 }), mark({}, { important: 0 })]);
    expect(predict(full, facts()).probs.important).toBeLessThan(predict(down, facts()).probs.important);
  });

  test('what stood counts a little: the alerts left alone in a chat do not undo one mark there, and marks fade but never to nothing', () => {
    expect(STOOD).toBe(0.05);
    // As many as are ever taken from one conversation: together half a mark.
    expect(STOOD_PER_PLACE * STOOD).toBe(0.5);
    const over = { judge: 0.08 };
    const left = Array.from({ length: STOOD_PER_PLACE }, () => stood(over, { alert: 1 }));
    const m = train([mark(over, { alert: 0 }), ...left]);
    expect(tier(m, over)).toBe('quiet');
    // By themselves they say the alert was right: surer than the start, less sure than after one mark saying so.
    const alone = predict(train(left), facts(over)).probs.alert;
    expect(alone).toBeGreaterThan(prior(facts(over)).alert);
    expect(alone).toBeLessThan(predict(train([mark(over, { alert: 1 })]), facts(over)).probs.alert);
    expect(voteWeight(NOW, NOW)).toBe(1);
    expect(voteWeight(NOW - 90 * DAY, NOW)).toBeCloseTo(0.5, 10);
    expect(voteWeight(NOW - 5 * 365 * DAY, NOW)).toBe(0.25);
  });

  test('a feature you had it forget is never learned', () => {
    const m = train([mark(under, { alert: 1 })], new Set(['conv:c1', 'conv:c1&!you']));
    expect(m.w.alert['conv:c1']).toBeUndefined();
    expect(m.w.alert['conv:c1&!you']).toBeUndefined();
    expect(m.w.alert['author:p1']).toBeGreaterThan(0);
  });

  test('numeric features keep their own hold, apart from the rest', () => {
    expect(lambda('#rr:conv')).toBe(10);
    expect(lambda('#emb')).toBe(5);
    expect(lambda('#jev:ask')).toBe(5);
    expect(lambda('#something:new')).toBe(10);
    // Not the conversation's, though the name after '#' could be read as one.
    expect(lambda('#conv:c1')).toBe(10);
  });

  test('fits twenty thousand examples, in work that grows with their features', () => {
    const ex = Array.from({ length: 20_000 }, (_, i) =>
      i % 50 ? stood({ conversation: `c${i % 2000}`, author: `p${i % 700}`, spaces: [`s${i % 40}`], judge: 0.01 }, { alert: 0 }) : mark({ conversation: `c${i % 2000}` }, { important: 0 }, ['alpha', 'beta']),
    );
    // A fit is at most 12 sweeps × 2 chances × every example's features: kept small by count, not by a clock.
    expect(HEADS).toEqual(['alert', 'important']);
    expect(ex.reduce((n, e) => Math.max(n, features(e.facts, e.words, e.x).length), 0)).toBeLessThanOrEqual(20);
    const m = train(ex);
    expect(Object.keys(m.w.important).length).toBeGreaterThan(0);
  });
});

describe('the backtest', () => {
  // Three marks: two the starting chances get wrong, one they get right; and something that stood, which is no mark.
  const ex = [
    mark({ judge: 0.03 }, { alert: 1 }, [], NOW - 2 * DAY),
    mark({ conversation: 'c2', author: 'p2', shape: 'group', conv: false }, { important: 0 }, [], NOW - DAY),
    mark({ conversation: 'c3', author: 'p3', judge: 0.01 }, { alert: 0 }, [], NOW),
    stood({ conversation: 'c4', author: 'p4', judge: 0.2 }, { alert: 0 }),
  ];

  test('agrees: every chance an example labels must fall on its side of the threshold', () => {
    expect(agrees({ alert: 0.6, important: 0.1 }, { y: { alert: 1 } })).toBe(true);
    expect(agrees({ alert: 0.4, important: 0.9 }, { y: { alert: 1 } })).toBe(false);
    expect(agrees({ alert: 0.4, important: 0.9 }, { y: { alert: 0 } })).toBe(true);
    expect(agrees({ alert: 0.4, important: 0.9 }, { y: { alert: 0, important: 0 } })).toBe(false);
    expect(agrees({ alert: 0.4, important: 0.5 }, { y: { alert: 0, important: 0 } })).toBe(true);
    // An old vote: by its level's label; at your own level of importance.
    expect(agrees({ alert: 0.01, important: 0.7 }, { label: 'quiet' })).toBe(true);
    expect(agrees({ alert: 0.01, important: 0.7 }, { label: 'digest' })).toBe(false);
    expect(agrees({ alert: 0.01, important: 0.7 }, { label: 'digest' }, { alert: 0.5, important: 0.9 })).toBe(true);
    expect(agrees({ alert: 0.01, important: 0.7 }, {})).toBe(true);
  });

  test('marks wrong with what it learned and without; what stood is not counted', () => {
    const before = backtest(emptyModel(), ex);
    expect(before).toMatchObject({ votes: 3, errors: 2, baseline: 2 });
    // The newest of the wrong ones first.
    expect(before.wrong.map((e) => e.facts.conversation)).toEqual(['c2', 'c1']);
    expect(backtest(train(ex), ex)).toMatchObject({ votes: 3, errors: 0, baseline: 2, wrong: [] });
    // At a stricter level for the list, the starting chance was right about the second.
    expect(backtest(emptyModel(), ex, { alert: 0.5, important: 0.9 })).toMatchObject({ votes: 3, errors: 1, baseline: 1 });
  });
});

describe('features and the model in words', () => {
  test('words: distinct, lower case, three letters or more; no links, mentions, code, numbers or filler', () => {
    expect(words('Hey <@123> the STANDUP notes: https://x.y/z `code` standup 2026')).toEqual(['hey', 'standup', 'notes']);
    expect(words("Don't forget: it's Sam’s ‘birthday’ dinner")).toEqual(['forget', "sam's", 'birthday', 'dinner']);
    expect(words('```\nlet x = 1\n```\nreview please <#general> <:wave:1>')).toEqual(['review', 'please']);
    expect(words('one two three four five six seven eight nine ten', 3)).toEqual(['three', 'four', 'five']);
    expect(words('ok no')).toEqual([]);
  });

  test('features: the place, the person, the flags and their absence, each scope with whether it is about you', () => {
    const fs = new Map(features(facts({ mention: true, spaces: ['s', 't', 'u', 'v'], native: 'mentions', link: true })));
    for (const k of ['all', 'conv:c1', 'network:signal', 'shape:direct', 'space:s', 'space:t', 'space:u', 'author:p1', 'mention', '!reply', '!question', '!active', 'known', 'link', 'native:mentions', 'notify', 'conv:c1&you', 'space:s&you', 'author:p1&you'])
      expect(fs.get(k)).toBe(1);
    // At most three spaces, nearest first; a flag whose absence says nothing is left out; one never kept, too.
    expect(fs.has('space:v')).toBe(false);
    expect(fs.has('!link')).toBe(false);
    expect(fs.has('!mention')).toBe(false);
    const plain = features(facts({ notify: false, known: undefined, author: null })).map(([k]) => k);
    expect(plain).toEqual(expect.arrayContaining(['!mention', '!notify', 'conv:c1&!you']));
    expect(plain.some((k) => k.startsWith('author:') || k.includes('known'))).toBe(false);
    // What decides the tier besides the chances is not a feature: the weights never see it.
    const tiered = features(facts({ conv: true, judge: 0.4, cap: true, explicit: true })).map(([k]) => k);
    expect(tiered).toEqual(features(facts({ conv: false })).map(([k]) => k));
  });

  test('features: the words share one feature’s worth; numeric ones are named apart and left out at zero', () => {
    const fs = features(facts(), ['a', 'b', 'c', 'd'], { 'rr:conv': 2, engaged: 0, 'since:seen': Number.NaN });
    expect(fs.filter(([k]) => k.startsWith('w:'))).toEqual([['w:a', 0.5], ['w:b', 0.5], ['w:c', 0.5], ['w:d', 0.5]]);
    expect(fs.filter(([k]) => k.startsWith('#'))).toEqual([['#rr:conv', 2]]);
  });

  test('predict: the start plus the weights of its features, and the ones that moved it most', () => {
    const m: Model = { w: { alert: { 'conv:c1': 1.2, 'author:p1': -0.5, known: 0.1 }, important: { 'w:standup': -3 } } };
    const f = facts({ judge: 0.05 });
    const p = predict(m, f, ['standup']);
    expect(logit(p.probs.alert)).toBeCloseTo(0 + 1.2 - 0.5 + 0.1, 6);
    expect(logit(p.probs.important)).toBeCloseTo(logit(0.8) - 3, 6);
    // Under a quarter of a log-odd is not worth saying.
    expect(p.why).toEqual([
      { feature: 'w:standup', head: 'important', by: -3 },
      { feature: 'conv:c1', head: 'alert', by: 1.2 },
      { feature: 'author:p1', head: 'alert', by: -0.5 },
    ]);
    // A start given outright, and an empty model, which is the start.
    expect(predict(m, f, [], { alert: 0.5, important: 0.5 }).probs.important).toBeCloseTo(0.5, 10);
    expect(predict(emptyModel(), f).probs).toEqual({ alert: prior(f).alert, important: prior(f).important });
    expect(predict(emptyModel(), f).why).toEqual([]);
  });

  test('in words', () => {
    expect(say('conv:c1&!you', names)).toBe('In #c1, not about you');
    expect(say('space:hub&you', names)).toBe('In Server hub, about you');
    expect(say('w:standup', names)).toBe('Says “standup”');
    expect(say('space:hub', names)).toBe('In Server hub');
    expect(say('author:p1', names)).toBe('From Person p1');
    expect(say('network:signal', names)).toBe('On signal');
    expect(say('shape:direct', names)).toBe('In DMs');
    expect(say('all', names)).toBe('Anything');
    expect(say('mention', names)).toBe('Mentions you');
    expect(say('!known', names)).toBe('From a stranger');
    expect(say('notify', names)).toBe('The network would notify');
    expect(say('native:mentions', names)).toBe('Where the network notifies only mentions');
    expect(say('#rr:conv', names)).toBe('How often you answer');
    expect(describeWeight('conv:c1', 'alert', 1.2, names)).toBe('More likely to alert: In #c1');
    expect(describeWeight('w:standup', 'important', -0.4, names)).toBe('Less likely to matter: Says “standup”');
    expect(TIER_NAME).toEqual({ push: 'Alert', quiet: 'Conversation', digest: 'List', drop: 'Below the list' });
    expect(HEAD_NAME).toEqual({ alert: 'alert', important: 'matter' });
  });

  test('the biggest weights, strongest first, at most so many per chance, none too small to matter', () => {
    const m: Model = { w: { alert: { 'conv:a': 1.5, all: 0.1, 'author:q': -0.2 }, important: { 'w:x': -2, 'author:p': 0.3 } } };
    expect(topWeights(m)).toEqual([
      { feature: 'w:x', head: 'important', weight: -2 },
      { feature: 'conv:a', head: 'alert', weight: 1.5 },
      { feature: 'author:p', head: 'important', weight: 0.3 },
      { feature: 'author:q', head: 'alert', weight: -0.2 },
    ]);
    expect(topWeights(m, 1).map((w) => w.feature)).toEqual(['w:x', 'conv:a']);
    expect(topWeights(emptyModel())).toEqual([]);
  });

  test('a model saved before the tiers had other chances: it is not one of these', () => {
    expect(validModel(emptyModel())).toBe(true);
    expect(validModel(train([mark({}, { important: 0 })]))).toBe(true);
    expect(validModel({ w: { ping: {}, active: {}, interesting: {} } })).toBe(false);
    expect(validModel({ w: { alert: {} } })).toBe(false);
    expect(validModel({})).toBe(false);
    expect(validModel(null)).toBe(false);
  });
});

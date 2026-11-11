/**
 * The tiers, decided end to end on a real store (triage.ts, docs/notifications.md): a message is an alert, a
 * Conversation, on the list or below it, by your rules first, then the Conversation rule, the local model's answer
 * (stood in for here) and the importance the network's own settings start it at. Each decision says why.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ALERT_BAR, UNJUDGED } from '../src/learn.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { JUDGE_CHARS, MARKED_FOR, STOP_QUESTION, Triage, type Decision } from '../src/triage.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let store: Store;
let triage: Triage;
let d: AccountRow;
let sig: AccountRow;
/** The texts the local model was asked about, in order. */
let asked: string[] = [];
/** The time of the next message: each one a minute after the last, so the fold of who wrote when sees them in order. */
let clock = Date.now() - 2 * DAY;
let n = 0;

/** The local model, stood in for: "now" cannot wait (0.3), "soon" hardly can (0.1), the rest can (0.01). */
const judge = async (text: string) => {
  asked.push(text);
  return /\bnow\b/.test(text) ? 0.3 : /\bsoon\b/.test(text) ? 0.1 : 0.01;
};
const URGENT = "Reads as urgent: the local model's answer is 0.3 against a bar of";
const conv = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', nativeId)!.id;
const person = (nativeId: string) => store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE native_id = ?', nativeId)!.person_id;

interface Extra {
  mentionsSelf?: boolean;
  mentionsAll?: boolean;
  replyTo?: string;
  /** Jump the clock this far ahead before the message. */
  after?: number;
}
/** A live message; returns its id. */
function post(acc: AccountRow, conversation: string, author: string, body: string, x: Extra = {}): string {
  clock += x.after ?? MIN;
  const nativeId = `m${++n}`;
  const { after: _, ...rest } = x;
  store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts: clock, body, ...rest }, live: true });
  return store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
}
/** Decide on a message as of when it came, and keep the decision as main.ts does. */
async function decide(id: string): Promise<Decision> {
  const dec = (await triage.decide(id, clock))!;
  store.setTriage(id, dec, dec.facts);
  return dec;
}
const say = async (acc: AccountRow, conversation: string, author: string, body: string, x: Extra = {}) => decide(post(acc, conversation, author, body, x));

beforeAll(() => {
  store = new Store(':memory:', (raw) => raw ?? null);
  triage = new Triage(store);
  d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
  sig = store.createAccount({ network: 'signal', label: 's', color: '#111', adapter: 'signal' });
  for (const [a, me] of [[d, 'me'], [sig, 'sigme']] as const) store.ingest(a, { t: 'status', status: 'online', self: { nativeId: me, isSelf: true, displayName: 'Me' } });
  d = store.account(d.id)!;
  sig = store.account(sig.id)!;
  store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'bob', displayName: 'Bob' } });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'helper', displayName: 'Helper', isBot: true } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann', 'me'] } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm-bot', shape: 'direct', participants: ['helper', 'me'] } });
  // A server that notifies only mentions; one channel set to every message, one muted there.
  store.ingest(d, { t: 'space', space: { nativeId: 'guild', kind: 'community', name: 'Hub', mute: { level: 'mentions' } } });
  for (const [c, mute] of [['general', undefined], ['alerts', { level: 'all' as const }], ['muted', { level: 'none' as const }], ['side', undefined], ['help', undefined], ['rules', undefined], ['marked', undefined]] as const)
    store.ingest(d, { t: 'conversation', conversation: { nativeId: c, shape: 'channel', name: c, spaces: [{ nativeId: 'guild' }], ...(mute ? { mute } : {}) } });
  // Two timed mutes there: one that has run out, one that still runs.
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'was-muted', shape: 'channel', name: 'was-muted', spaces: [{ nativeId: 'guild' }], mute: { level: 'none', until: Date.now() - DAY } } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'snoozed', shape: 'channel', name: 'snoozed', spaces: [{ nativeId: 'guild' }], mute: { level: 'all', until: Date.now() + 365 * DAY } } });
  for (const g of ['club', 'crew']) store.ingest(sig, { t: 'conversation', conversation: { nativeId: `group:${g}`, shape: 'group', name: g, participants: ['x', 'y', 'z', 'w', 'v', 'u', 'sigme'] } });
});
afterAll(() => store.db.close());
beforeEach(() => {
  triage.judge = judge;
  triage.judgeTimeoutMs = 3000;
  asked = [];
});

describe('alerts and Conversations', () => {
  test('a DM that reads urgent is an alert; one that does not stays a Conversation', async () => {
    const id = post(d, 'dm', 'ann', 'the stove is on, come now');
    const a = await decide(id);
    expect(a.decision).toBe('push');
    expect(a.reasons).toEqual([`${URGENT} ${ALERT_BAR.direct}`, 'A direct message', 'Discord notifies every message here']);
    expect(a.decidedBy).toBe('rules');
    expect(a.facts).toMatchObject({ shape: 'direct', conv: true, judge: 0.3, notify: true, native: 'all', base: 'drop' });
    // The answer against the bar: 0.3 against 0.05 is about nine to one.
    expect(a.probs).toEqual({ alert: 0.891, important: 0.8 });
    expect(a.score).toBe(0.8);
    expect(asked).toEqual(['the stove is on, come now']);
    // The app reads it all with the message: the tier, why, the two chances, the local model's answer.
    expect(store.messageViews([store.one('SELECT * FROM message WHERE id = ?', id)!])[0].triage).toEqual({ decision: 'push', score: 0.8, reasons: a.reasons, decidedBy: 'rules', feedback: null, probs: { alert: 0.891, important: 0.8 }, judge: 0.3, bar: ALERT_BAR.direct });

    const c = await say(d, 'dm', 'ann', 'see you tomorrow');
    expect(c.decision).toBe('quiet');
    expect(c.reasons).toEqual(['A direct message', 'Discord notifies every message here']);
    expect(c.facts).toMatchObject({ conv: true, judge: 0.01 });
    expect(c.probs!.alert).toBeLessThan(0.5);
    expect(asked).toHaveLength(2);
  });

  test('the local model reads the start of the text, and is not asked about a message with none', async () => {
    const long = `${'word '.repeat(150)}now`;
    const far = await say(d, 'dm', 'ann', long);
    expect(asked).toEqual([long.slice(0, JUDGE_CHARS).trim()]);
    expect(asked[0].length).toBeLessThanOrEqual(JUDGE_CHARS);
    // "now" came after what it reads.
    expect(far.decision).toBe('quiet');
    const empty = await say(d, 'dm', 'ann', '   ');
    expect(asked).toHaveLength(1);
    expect(empty.decision).toBe('quiet');
    expect(empty.facts!.judge).toBeUndefined();
    expect(empty.unjudged).toBeUndefined();
    expect(empty.probs!.alert).toBe(UNJUDGED);
    expect(STOP_QUESTION).toBe('Does this message need the reader to stop what they are doing and act or reply within the next hour or two?');
  });

  test('about you in a channel: a Conversation, read at the lower bar; @everyone is not you', async () => {
    const mention = await say(d, 'general', 'bob', 'can you look at this soon', { mentionsSelf: true });
    // 0.1 is over the bar for messages to you (0.05), under the one for other chats (0.2).
    expect(mention.decision).toBe('push');
    expect(mention.reasons).toEqual(["Reads as urgent: the local model's answer is 0.1 against a bar of 0.05", 'About you', 'Mentions you']);
    const calm = await say(d, 'general', 'bob', 'thanks for earlier', { mentionsSelf: true });
    expect(calm.decision).toBe('quiet');
    expect(calm.reasons).toEqual(['About you', 'Mentions you']);
    expect(calm.facts).toMatchObject({ mention: true, conv: true, notify: true, native: 'mentions' });
    const mine = post(d, 'side', 'me', 'anyone seen the keys?');
    const reply = await say(d, 'rules', 'bob', 'on the shelf', { replyTo: store.one<{ native_id: string }>('SELECT native_id FROM message WHERE id = ?', mine)!.native_id });
    expect(reply.decision).toBe('quiet');
    expect(reply.reasons).toEqual(['About you', 'Replies to your message']);
    asked = [];
    const everyone = await say(d, 'general', 'bob', 'meeting now', { mentionsSelf: true, mentionsAll: true });
    // The network would have notified you, so it is on the list; nobody asks whether it can wait.
    expect(everyone.decision).toBe('digest');
    expect(everyone.reasons).toEqual(['On the list: importance 80%, at or over your level of 60%', 'Pings @everyone']);
    expect(everyone.facts).toMatchObject({ mention: false, everyone: true, conv: false });
    expect(asked).toEqual([]);
  });

  test('a chat you wrote in during the last day: a Conversation, read at the higher bar', async () => {
    const before = await say(sig, 'group:club', 'x', 'dinner at 7, come now');
    // You never wrote here: not a Conversation, so nobody asks the local model; Signal notifies it, so it is listed.
    expect(before.decision).toBe('digest');
    expect(before.reasons).toEqual(['On the list: importance 80%, at or over your level of 60%', 'Signal notifies every message here']);
    expect(asked).toEqual([]);
    // In another group you write first (so no one is answered), then others write.
    post(sig, 'group:crew', 'sigme', 'who is in for Sunday?');
    const soon = await say(sig, 'group:crew', 'y', 'tell me soon', { after: 2 * HOUR });
    expect(soon.decision).toBe('quiet');
    expect(soon.reasons).toEqual(['You wrote here in the last day', 'Signal notifies every message here']);
    expect(soon.facts).toMatchObject({ conv: true, judge: 0.1 });
    const now = await say(sig, 'group:crew', 'y', 'we leave now');
    expect(now.decision).toBe('push');
    expect(now.reasons[0]).toBe(`${URGENT} ${ALERT_BAR.other}`);
    expect(now.probs!.alert).toBeCloseTo(0.632, 3);
    // More than a day after you last wrote there: no Conversation any more.
    asked = [];
    const later = await say(sig, 'group:crew', 'y', 'are you coming now', { after: 25 * HOUR });
    expect(later.decision).toBe('digest');
    expect(later.facts!.conv).toBe(false);
    expect(asked).toEqual([]);
  });

  test('a chat where you usually answer: a Conversation, days after you last wrote there', async () => {
    post(d, 'help', 'bob', 'how do I reset the router?');
    post(d, 'help', 'me', 'hold the button for ten seconds');
    const days = await say(d, 'help', 'bob', 'it worked, thanks', { after: 3 * DAY });
    expect(days.decision).toBe('quiet');
    expect(days.reasons).toEqual(['You usually answer here', 'Discord notifies only mentions here']);
    // Its importance is still the channel's: under the list. A Conversation is one whatever that says.
    expect(days.probs!.important).toBeLessThan(0.6);
    expect(asked).toEqual(['it worked, thanks']);
  });

  test('a bot is never a Conversation, in a DM either: half the importance, never read for urgency', async () => {
    const b = await say(d, 'dm-bot', 'helper', 'your build is failing now');
    expect(b.decision).toBe('drop');
    expect(b.reasons).toEqual(['Below the list: importance 40%, under your level of 60%', 'From a bot', 'Discord notifies every message here']);
    expect(b.facts).toMatchObject({ bot: true, conv: false });
    expect(asked).toEqual([]);
  });
});

describe('the list', () => {
  test('a channel message the network would notify is on the list; one it would not is below it', async () => {
    const listed = await say(d, 'alerts', 'bob', 'deploy 41 finished');
    expect(listed.decision).toBe('digest');
    expect(listed.reasons).toEqual(['On the list: importance 80%, at or over your level of 60%', 'Discord notifies every message here']);
    expect(listed.facts).toMatchObject({ conv: false, notify: true, native: 'all' });
    expect(listed.probs).toEqual({ alert: UNJUDGED, important: 0.8 });
    const below = await say(d, 'general', 'bob', 'anyone watching the game');
    expect(below.decision).toBe('drop');
    expect(below.reasons).toEqual(['Below the list: importance 16%, under your level of 60%', 'Discord notifies only mentions here']);
    expect(below.facts).toMatchObject({ conv: false, notify: false, native: 'mentions', score: 0.15 });
    // More about you raises it, though not to the list by itself.
    const asap = await say(d, 'general', 'bob', 'need this asap');
    expect(asap.decision).toBe('drop');
    expect(asap.reasons).toEqual(['Below the list: importance 39%, under your level of 60%', 'Discord notifies only mentions here', 'About you: sounds time-sensitive']);
    // Neither is read for urgency: they are not Conversations.
    expect(asked).toEqual([]);
  });

  test('your level moves the list: lower and more is on it, higher and less', async () => {
    expect(store.listLevel()).toBeNull();
    expect(triage.thresholds()).toEqual({ alert: 0.5, important: 0.6 });
    store.setListLevel(0.1);
    expect(triage.thresholds()).toEqual({ alert: 0.5, important: 0.1 });
    const low = await say(d, 'general', 'bob', 'anyone watching the game');
    expect(low.decision).toBe('digest');
    expect(low.reasons[0]).toBe('On the list: importance 16%, at or over your level of 10%');
    store.setListLevel(0.9);
    const high = await say(d, 'alerts', 'bob', 'deploy 42 finished');
    expect(high.decision).toBe('drop');
    expect(high.reasons[0]).toBe('Below the list: importance 80%, under your level of 90%');
    // Alerts and Conversations do not go by it.
    expect((await say(d, 'dm', 'ann', 'see you tomorrow')).decision).toBe('quiet');
    expect((await say(d, 'dm', 'ann', 'come now')).decision).toBe('push');
    store.setListLevel(0.6);
    expect((await say(d, 'alerts', 'bob', 'deploy 43 finished')).decision).toBe('digest');
  });
});

describe('your rules', () => {
  test('List only is a cap: never a Conversation or an alert, and it does not raise importance', async () => {
    store.setRule('conversation', conv('dm'), 'digest');
    const dm = await say(d, 'dm', 'ann', 'the stove is on, come now');
    expect(dm.decision).toBe('digest');
    expect(dm.reasons).toEqual(['On the list: importance 80%, at or over your level of 60%', 'List only: this conversation']);
    expect(dm.facts).toMatchObject({ cap: true, conv: false, explicit: true });
    expect(dm.facts!.judge).toBeUndefined();
    expect(asked).toEqual([]);
    store.setRule('conversation', conv('dm'), null);
    expect((await say(d, 'dm', 'ann', 'come now')).decision).toBe('push');

    // On a server: its channels. A mention there is listed (Discord would have notified it), not a Conversation.
    const guild = store.one<{ id: string }>(`SELECT id FROM space WHERE native_id = 'guild'`)!.id;
    store.setRule('space', guild, 'digest');
    asked = [];
    const mention = await say(d, 'general', 'bob', 'look at this now', { mentionsSelf: true });
    expect(mention.decision).toBe('digest');
    expect(mention.reasons[1]).toMatch(/^List only: Hub/);
    const plain = await say(d, 'general', 'bob', 'anyone watching the game');
    expect(plain.decision).toBe('drop');
    // What it was without the rule: 5% and three quarters of how much it is about you (15%).
    expect(plain.probs!.important).toBeCloseTo(0.1625, 2);
    expect(asked).toEqual([]);
    store.setRule('space', guild, null);
  });

  test('a place muted on its network is kept to the list the same way', async () => {
    const m = await say(d, 'muted', 'bob', 'look at this now', { mentionsSelf: true });
    // Discord would not have notified it: by how much it is about you, which is under the list.
    expect(m.decision).toBe('drop');
    expect(m.reasons).toEqual(['Below the list: importance 54%, under your level of 60%', 'Muted in Discord: kept to the list']);
    expect(m.facts).toMatchObject({ cap: true, conv: false, native: 'none', notify: false, explicit: false });
    expect(asked).toEqual([]);
    store.setListLevel(0.5);
    expect((await say(d, 'muted', 'bob', 'and this now', { mentionsSelf: true })).decision).toBe('digest');
    store.setListLevel(0.6);
  });

  test('a mute on the network that has run out no longer counts; one still running does', async () => {
    const over = await say(d, 'was-muted', 'bob', 'back again', { mentionsSelf: true });
    // As the server has it: mentions notify, and this is one.
    expect(over.facts).toMatchObject({ native: 'mentions', notify: true, conv: true });
    expect(over.facts!.cap).toBeUndefined();
    expect(over.decision).toBe('quiet');
    const running = await say(d, 'snoozed', 'bob', 'hello again', { mentionsSelf: true });
    expect(running.facts).toMatchObject({ native: 'none', notify: false, cap: true, conv: false });
    expect(running.decision).toBe('drop');
    expect(running.reasons).toContain('Muted in Discord: kept to the list');
  });

  test('a person set to always alert, a keyword and a place set to always alert make an alert, and nobody asks the local model', async () => {
    store.setRule('person', person('ann'), 'all');
    const p = await say(d, 'dm', 'ann', 'see you tomorrow');
    expect(p).toMatchObject({ decision: 'push', forced: true, alwaysNotify: true, decidedBy: 'rules' });
    expect(p.reasons).toEqual(['From Ann, who is set to always alert']);
    expect(p.facts).toMatchObject({ base: 'push', conv: true });
    expect(p.facts!.judge).toBeUndefined();
    // The chances are still kept, for the list's order and for learning.
    expect(p.probs).toEqual({ alert: UNJUDGED, important: 0.8 });
    // In a channel she is no Conversation in, too.
    expect((await say(d, 'general', 'ann', 'hello all')).decision).toBe('push');
    store.setRule('person', person('ann'), null);

    store.setRule('keyword', 'deploy', 'all');
    const k = await say(d, 'general', 'bob', 'the Deploy is done');
    expect(k).toMatchObject({ decision: 'push', forced: true, keyword: true });
    expect(k.alwaysNotify).toBeUndefined();
    expect(k.reasons).toEqual(['Matches keyword “deploy”']);
    // A whole word, as typed: not part of another, not inside a mention token.
    expect((await say(d, 'general', 'bob', 'the deployment is done')).decision).toBe('drop');
    expect((await say(d, 'general', 'bob', 'ask <@deploy> about it')).decision).toBe('drop');
    store.setRule('keyword', 'deploy', null);

    store.setRule('conversation', conv('rules'), 'all');
    const place = await say(d, 'rules', 'bob', 'anyone watching the game');
    expect(place).toMatchObject({ decision: 'push', forced: true });
    expect(place.reasons).toEqual(['Always alert: this conversation']);
    store.setRule('conversation', conv('rules'), null);
    expect(asked).toEqual([]);
    expect((await say(d, 'general', 'bob', 'the deploy is done')).decision).toBe('drop');
  });

  test('Mute is absolute: silent, with nothing kept to mark or learn from', async () => {
    store.setRule('conversation', conv('dm'), 'none');
    const m = await say(d, 'dm', 'ann', 'the stove is on, come now');
    expect(m).toMatchObject({ decision: 'silent', score: null, decidedBy: 'rules' });
    expect(m.reasons).toEqual(['Silenced: this conversation']);
    expect(m.facts).toBeUndefined();
    expect(m.probs).toBeUndefined();
    expect(asked).toEqual([]);
    // Not even someone set to always alert, or a keyword, gets through a mute.
    store.setRule('person', person('ann'), 'all');
    store.setRule('keyword', 'stove', 'all');
    expect((await say(d, 'dm', 'ann', 'the stove is on, come now')).decision).toBe('silent');
    store.setRule('person', person('ann'), null);
    store.setRule('keyword', 'stove', null);
    store.setRule('conversation', conv('dm'), null);
    // A server muted: its channels, mentions too.
    const guild = store.one<{ id: string }>(`SELECT id FROM space WHERE native_id = 'guild'`)!.id;
    store.setRule('space', guild, 'none');
    const ch = await say(d, 'general', 'bob', 'look now', { mentionsSelf: true });
    expect(ch.decision).toBe('silent');
    expect(ch.reasons[0]).toMatch(/^Silenced: Hub/);
    store.setRule('space', guild, null);
    expect((await say(d, 'dm', 'ann', 'come now')).decision).toBe('push');
  });

  test('rules from before the tiers: "mentions" still reads as the network notifying only mentions there, "smart" as no rule', async () => {
    // Discord notifies every message in #alerts; your older rule says only mentions.
    store.setRule('conversation', conv('alerts'), 'mentions');
    const plain = await say(d, 'alerts', 'bob', 'deploy 44 finished');
    expect(plain.decision).toBe('drop');
    expect(plain.reasons).toEqual(['Below the list: importance 16%, under your level of 60%', 'Mentions only: this conversation']);
    expect(plain.facts).toMatchObject({ notify: false, explicit: true });
    expect(plain.facts!.cap).toBeUndefined();
    const mention = await say(d, 'alerts', 'bob', 'deploy 45 needs you', { mentionsSelf: true });
    expect(mention.decision).toBe('quiet');
    expect(mention.reasons).toEqual(['About you', 'Mentions you']);
    store.setRule('conversation', conv('alerts'), 'smart');
    const smart = await say(d, 'alerts', 'bob', 'deploy 46 finished');
    expect(smart.decision).toBe('digest');
    expect(smart.reasons).toEqual(['On the list: importance 80%, at or over your level of 60%', 'Discord notifies every message here']);
    expect(triage.effectiveLevel(conv('alerts'))).toMatchObject({ level: 'all', explicit: false, native: true });
    store.setRule('conversation', conv('alerts'), null);
  });
});

describe('the local model, slow or missing', () => {
  test('too slow: the message goes out a Conversation, and says the answer is still owed', async () => {
    triage.judge = () => new Promise<number | null>(() => {});
    triage.judgeTimeoutMs = 5;
    const slow = await say(d, 'dm', 'ann', 'the stove is on, come now');
    expect(slow.decision).toBe('quiet');
    expect(slow.unjudged).toBe(true);
    expect(slow.facts!.judge).toBeUndefined();
    expect(slow.probs!.alert).toBe(UNJUDGED);
    expect(slow.reasons).toEqual(['A direct message', 'Discord notifies every message here']);
    // Asked again once it answers (main.ts does, a little later): an alert after all.
    triage.judge = judge;
    const late = await triage.decide(store.one<{ id: string }>('SELECT id FROM message ORDER BY rowid DESC LIMIT 1')!.id, clock);
    expect(late).toMatchObject({ decision: 'push' });
    expect(late!.unjudged).toBeUndefined();
  });

  test('no answer, or an error: nothing alerts by chance, and nothing is owed', async () => {
    triage.judge = async () => null;
    const none = await say(d, 'dm', 'ann', 'come now');
    expect(none.decision).toBe('quiet');
    expect(none.unjudged).toBeUndefined();
    expect(none.facts!.judge).toBeUndefined();
    triage.judge = async () => {
      throw new Error('the local model is down');
    };
    const down = await say(d, 'dm', 'ann', 'come now');
    expect(down.decision).toBe('quiet');
    expect(down.unjudged).toBeUndefined();
  });

  test('no local model at all: only your rules alert', async () => {
    triage.judge = null;
    const dm = await say(d, 'dm', 'ann', 'urgent: the stove is on, come now');
    expect(dm.decision).toBe('quiet');
    expect(dm.probs!.alert).toBe(UNJUDGED);
    expect(dm.unjudged).toBeUndefined();
    store.setRule('keyword', 'stove', 'all');
    expect((await say(d, 'dm', 'ann', 'the stove is on')).decision).toBe('push');
    store.setRule('keyword', 'stove', null);
  });
});

describe('places and people you marked "should have alerted"', () => {
  test('they are read for urgency though they are no Conversation, for ninety days', async () => {
    expect(MARKED_FOR).toBe(90 * DAY);
    // A channel you never wrote in: nobody asks, and it stays below the list.
    const missed = post(d, 'marked', 'bob', 'the server room is flooding now');
    expect((await decide(missed)).decision).toBe('drop');
    expect(asked).toEqual([]);
    expect(triage.marked(clock)).toMatchObject({ convs: new Set(), authors: new Set() });
    // You mark it. From then on the place, and Bob anywhere, may alert.
    store.triageMark(missed, { alert: true }, clock);
    triage.forgetMarked();
    const marks = triage.marked(clock);
    expect([...marks.convs]).toEqual([conv('marked')]);
    expect(marks.authors.size).toBe(1);
    const next = await say(d, 'marked', 'ann', 'it is flooding again now');
    expect(next.decision).toBe('push');
    // Not to you by name: the higher bar. And no Conversation reason, for it is none.
    expect(next.reasons).toEqual([`${URGENT} ${ALERT_BAR.other}`, 'Discord notifies only mentions here']);
    expect(next.facts).toMatchObject({ conv: false, judge: 0.3 });
    expect(asked).toEqual(['it is flooding again now']);
    // Under the bar it goes by its importance, as before.
    const calm = await say(d, 'marked', 'ann', 'all dry, will mop soon');
    expect(calm.decision).toBe('drop');
    expect(calm.facts!.judge).toBe(0.1);
    // Bob, whose message you marked, in another channel.
    const bob = await say(d, 'side', 'bob', 'come to the server room now');
    expect(bob.decision).toBe('push');
    // Someone else there: not read.
    asked = [];
    expect((await say(d, 'side', 'ann', 'come to the kitchen now')).decision).toBe('drop');
    expect(asked).toEqual([]);

    // Ninety days on, the mark no longer makes them eligible.
    const old = await say(d, 'marked', 'ann', 'flooding now, third time', { after: MARKED_FOR + DAY });
    expect(old.decision).toBe('drop');
    expect(asked).toEqual([]);
    expect(triage.marked(clock).convs.size).toBe(0);
  });

  test('"the alert was wrong" and a mark taken back do not; List only still caps a marked place', async () => {
    const id = post(d, 'rules', 'bob', 'fire drill now');
    await decide(id);
    store.triageMark(id, { alert: false }, clock);
    triage.forgetMarked();
    expect(triage.marked(clock).convs.has(conv('rules'))).toBe(false);
    store.triageMark(id, { alert: true }, clock);
    triage.forgetMarked();
    expect(triage.marked(clock).convs.has(conv('rules'))).toBe(true);
    store.setRule('conversation', conv('rules'), 'digest');
    asked = [];
    const capped = await say(d, 'rules', 'ann', 'fire drill again now');
    expect(capped.decision).toBe('drop');
    expect(asked).toEqual([]);
    store.setRule('conversation', conv('rules'), null);
    store.triageMark(id, { alert: null }, clock);
    triage.forgetMarked();
    expect(triage.marked(clock).convs.has(conv('rules'))).toBe(false);
  });

  test('the marks are read at most once a minute, until told one was made', async () => {
    const id = post(d, 'general', 'bob', 'pipe burst now');
    await decide(id);
    triage.forgetMarked();
    expect(triage.marked(clock).convs.has(conv('general'))).toBe(false);
    store.triageMark(id, { alert: true }, clock);
    // Not told: the same answer for a minute.
    expect(triage.marked(clock + 30_000).convs.has(conv('general'))).toBe(false);
    expect(triage.marked(clock + 61_000).convs.has(conv('general'))).toBe(true);
    store.triageMark(id, { alert: null }, clock);
    triage.forgetMarked();
    expect(triage.marked(clock + 61_000).convs.has(conv('general'))).toBe(false);
  });
});

test('a message that is not there has no decision', async () => {
  expect(await triage.decide('msg_nothing')).toBeNull();
});

test('the inbox page holds every tier but the silenced: alerts, Conversations, the list, and the newest of what fell below it', async () => {
  // One of each, now: the page's window for what fell below the list is its last two days.
  const made: Record<string, string> = {};
  for (const [name, c, author, body] of [['push', 'dm', 'ann', 'come now'], ['quiet', 'dm', 'ann', 'see you'], ['digest', 'alerts', 'bob', 'deploy 50 finished'], ['drop', 'general', 'bob', 'anyone watching the game']] as const) {
    const id = post(d, c, author, body);
    expect((await decide(id)).decision).toBe(name);
    made[name] = id;
  }
  store.setRule('conversation', conv('side'), 'none');
  const silent = post(d, 'side', 'bob', 'nobody hears this');
  expect((await decide(silent)).decision).toBe('silent');
  store.setRule('conversation', conv('side'), null);
  const page = store.inbox(clock - 7 * DAY, clock);
  const tiers = new Map<string, string>(page.items.map((i) => [i.message.id, i.message.triage!.decision]));
  for (const [name, id] of Object.entries(made)) expect(tiers.get(id)).toBe(name);
  expect(tiers.has(silent)).toBe(false);
  expect([...tiers.values()]).not.toContain('silent');
  // Newest first.
  expect(page.items.every((x, i) => i === 0 || page.items[i - 1].message.ts >= x.message.ts)).toBe(true);
  expect(page.items.find((i) => i.message.id === made.push)!.message.triage).toMatchObject({ decision: 'push', judge: 0.3, probs: { alert: 0.891, important: 0.8 } });
});

/**
 * Mail in the learned order (rank.ts, rankhistory.ts, ranker.ts, docs/inbox.md "Mail in the learned order"): a mail
 * row's own features, mail opens rebuilt from the log as moments to learn from, the order with mail worked out in
 * shadow beside the formula (DITHER_INBOX_MAIL), and the scorecard comparing the two. Invented people and mail only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityStore, cleanVisit } from '../src/activity.ts';
import { Attention, freshState, scoreConversation, type ScoreInput } from '../src/attention.ts';
import { mailAttention } from '../src/mail/attention.ts';
import { mailClassifier } from '../src/mail/classify.ts';
import { FakeMailBackend, type FakeInput } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailPeople } from '../src/mail/people.ts';
import { bondAt, FEATURES, MAIL_FEATURES, mailRankFeatures, predict, PRIOR, rankFeatures, type RankModel } from '../src/rank.ts';
import { InboxRanker, MAIL_MODEL_VERSION, mailRankMode } from '../src/ranker.ts';
import { isChoice, loadWorld, momentOf, mutedBy, Rebuild, seenAt } from '../src/rankhistory.ts';
import { dayBounds, dayOf, scoreAll } from '../src/scorecard.ts';
import { whole } from '../src/slices.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const ACC = 'acc_rankMail';
const ME = { name: 'Me', email: 'me@example.com' };
const SAM = { name: 'Sam Rivera', email: 'sam@rivera.example' };
const JO = { name: 'Jo Park', email: 'jo@park.example' };
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 10, 1, 12);

const input = (o: Partial<ScoreInput> = {}): ScoreInput => ({
  now: T0,
  shape: 'direct',
  members: 2,
  lastMessageAt: T0 - H,
  state: freshState(),
  author: null,
  authorName: null,
  unread: 1,
  mentions: 1,
  pinged: null,
  muted: null,
  usage: null,
  ...o,
});

describe('a mail row as the model sees it', () => {
  test('a chat’s row says nothing of mail; a mail row says it is mail, how it reached you and from whom', () => {
    const x = input();
    const s = scoreConversation(x);
    const chat = rankFeatures(x, s);
    for (const f of MAIL_FEATURES) expect(chat[f]).toBe(0);
    const mail = mailRankFeatures(x, s, { addressed: 'cc', unknown: true, flagged: true, account: 'proton', known: true, bond: 40 });
    expect(mail).toMatchObject({ mail: 1, mailTo: 0, mailCc: 1, mailUnknown: 1, mailFlagged: 1, mailGoogle: 0, mailProton: 1, mailKnown: 1 });
    expect(mail.mailBond).toBeCloseTo(Math.log1p(40) / 5, 9);
    // The features they share are the same.
    for (const f of FEATURES.filter((f) => !MAIL_FEATURES.includes(f))) expect(mail[f]).toBe(chat[f]);
    // Under the prior, mail's own features weigh nothing: a mail row scores its formula points, as before.
    expect(predict(PRIOR, mail).points).toBe(predict(PRIOR, chat).points);
  });

  test('closeness before now: the months before this one, each halved every three months back', () => {
    const m = (y: number, mo: number) => y * 12 + mo;
    const t = Date.UTC(2026, 10, 15);
    // 10 in October (a month back), 20 in July (four back), 50 this month (not over: left out).
    const months = [m(2026, 6), 200, m(2026, 9), 100, m(2026, 10), 500];
    expect(bondAt(months, t)).toBeCloseTo(10 + 20 * 2 ** -1, 9);
    expect(bondAt(undefined, t)).toBe(0);
    expect(bondAt([], t)).toBe(0);
  });

  test('DITHER_INBOX_MAIL: shadow unless model or off', () => {
    expect(mailRankMode(undefined)).toBe('shadow');
    expect(mailRankMode('model')).toBe('model');
    expect(mailRankMode('off')).toBe('off');
    expect(mailRankMode('nonsense')).toBe('shadow');
  });

  test('a stay remembers where its row stood in the shadow order, kept once', () => {
    expect(cleanVisit({ id: 'v1', device: 'd', view: 'mail', conversationId: 'mth_x', source: 'inbox', rank: 3, shadowRank: 7 }, T0)).toMatchObject({ view: 'mail', conversationId: 'mth_x', shadowRank: 7 });
    expect(cleanVisit({ id: 'v1', device: 'd', view: 'mail', source: 'inbox', shadowRank: -4 }, T0)!.shadowRank).toBe(0);
    expect(cleanVisit({ id: 'v1', device: 'd', view: 'mail', source: 'inbox' }, T0)!.shadowRank).toBeNull();
  });
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** Sam and Jo are people you have written to, long ago. */
async function world(seed: (put: (i: FakeInput) => void) => void, at = T0 + 10 * DAY) {
  const clock = { now: at };
  const dir = mkdtempSync(join(tmpdir(), 'dither-rank-mail-'));
  const file = join(dir, 'hub.sqlite');
  const chat = new Store(file, (raw) => raw ?? null);
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME.email, name: ME.name });
  fake.put(ACC, { mailboxId: 'Sent', messageId: '<hello@x>', from: [ME], to: [SAM, JO], subject: 'Hello all', receivedAt: T0 - 60 * DAY, flags: { seen: true } });
  seed((i) => void fake.put(ACC, { flags: { seen: true }, ...i }));
  const hub = new MailHub({ db: chat.db, backend: fake, log: () => {}, now: () => clock.now });
  const triage = new Triage(chat);
  const attention = new Attention(chat, triage, () => clock.now);
  mailPeople(hub)!.connect(chat);
  mailAttention(hub)!.connect(chat, attention, () => clock.now);
  hub.start();
  await hub.sync(ACC)!.whenSynced();
  while (!mailClassifier(hub)!.idle || !mailPeople(hub)!.idle) await new Promise((r) => setImmediate(r));
  cleanup = () => {
    mailPeople(hub)?.stop();
    hub.stop();
    chat.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const tid = (messageId: string) => hub.store.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE message_id_hdr = ?', messageId)!.thread_id;
  return { clock, chat, hub, triage, attention, file, tid, dir };
}

/** The order with mail as a model that likes mail more than the prior does. */
const likesMail = (): RankModel => ({ ...PRIOR, open: { ...PRIOR.open, mail: 1.5 }, fitAt: T0, moments: 10, rows: 100, v: MAIL_MODEL_VERSION });

describe('the order with mail, in the hub', () => {
  test('in shadow a mail row keeps its formula points and carries the order with mail’s as `shadow`', async () => {
    const w = await world((put) => put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: T0 + 10 * DAY - 2 * H, flags: { seen: false } }));
    const r = new InboxRanker(w.chat, w.triage, 'model', undefined, () => w.clock.now, false, 'shadow');
    r.mailModel = likesMail();
    w.attention.judge = r;
    w.attention.rescoreAll();
    const t = w.tid('<s1@x>');
    const v = w.attention.list().find((x) => x.id === t)!;
    const e = w.attention.explain(t) as any;
    expect(v.kind).toBe('mail');
    expect(v.score).toBeCloseTo(e.score, 6);
    expect(v.shadow!).toBeGreaterThan(v.score + 5);
    // What the order with mail read of it: To you, from a person the hub knows, a google-less IMAP-like fake account.
    expect(e.learned.mail).toMatchObject({ addressed: 'to', unknown: false, flagged: false });
    expect(e.learned.withMail).toMatchObject({ mode: 'shadow', shadow: v.shadow });
  });

  test('`model` sorts mail by it; `off` neither scores nor sends a shadow', async () => {
    const w = await world((put) => put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: T0 + 10 * DAY - 2 * H, flags: { seen: false } }));
    const t = w.tid('<s1@x>');
    const formula = (w.attention.explain(t) as any).score as number;
    const on = new InboxRanker(w.chat, w.triage, 'model', undefined, () => w.clock.now, false, 'model');
    on.mailModel = likesMail();
    w.attention.judge = on;
    w.attention.rescoreAll();
    const v = w.attention.list().find((x) => x.id === t)!;
    expect(v.score).toBeGreaterThan(formula + 5);
    expect(v.shadow).toBeUndefined();
    expect(v.reasons.at(-1)).toBe('Higher: you often open mail like this at times like this');
    const off = new InboxRanker(w.chat, w.triage, 'model', undefined, () => w.clock.now, false, 'off');
    off.mailModel = likesMail();
    w.attention.judge = off;
    w.attention.rescoreAll();
    const o = w.attention.list().find((x) => x.id === t)!;
    expect(o.score).toBeCloseTo(formula, 6);
    expect(o.shadow).toBeUndefined();
  });

  test('mail opens rebuilt from the log: the thread listed then, with mail’s features, and what you opened', async () => {
    const at = T0 + 10 * DAY;
    const w = await world((put) => {
      put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: at - 5 * H, flags: { seen: false } });
      put({ messageId: '<j1@x>', from: [JO], to: [SAM], cc: [ME], subject: 'Lease', receivedAt: at - 4 * H, flags: { seen: false } });
    });
    const sam = w.tid('<s1@x>');
    const jo = w.tid('<j1@x>');
    const activity = new ActivityStore(w.chat);
    // The log starts before the mail came (before it, everything counts as read): a glance elsewhere, not a choice.
    activity.visits([{ id: 'v0', device: 'd1', view: 'person', personId: 'per_nobody', start: at - 6 * H, end: at - 6 * H + MIN, active: 1, source: 'rail', sent: 0, reactions: 0, history: 0, threads: 0, attachments: 0, closed: true }], at);
    // An open from the inbox's third row, and the old shape: a thread opened from the inbox as a `conversation` stay.
    activity.visits([{ id: 'v1', device: 'd1', view: 'mail', conversationId: sam, start: at - 3 * H, end: at - 3 * H + 2 * MIN, active: 60, source: 'inbox', rank: 2, shadowRank: 0, sent: 0, reactions: 0, history: 0, threads: 0, attachments: 0, closed: true }], at);
    activity.visits([{ id: 'v2', device: 'd1', view: 'conversation', conversationId: jo, start: at - 2 * H, end: at - 2 * H + MIN, active: 30, source: 'list', sent: 0, reactions: 0, history: 0, threads: 0, attachments: 0, closed: true }], at);
    const exported = [...activity.exportLog()].map((l) => JSON.parse(l)).filter((r) => r.type === 'visit');
    expect(exported.find((r) => r.id === 'v1')).toMatchObject({ view: 'mail', conversationId: sam, shadowRank: 0 });

    // Without mail: no mail stays, no mail candidates.
    const plain = loadWorld(w.chat.db, mutedBy(w.triage));
    expect(plain.stays.some((s) => s.targets.includes(sam))).toBe(false);
    expect(plain.convs.has(sam)).toBe(false);

    const lw = loadWorld(w.chat.db, mutedBy(w.triage), 0, undefined, { mail: true, bonds: null });
    const opens = lw.stays.filter((s) => isChoice(s) && s.targets.length);
    expect(opens.map((s) => [s.key, s.shadowRank ?? null])).toEqual([
      [`mail:${sam}`, 0],
      [`mail:${jo}`, null],
    ]);
    const seen: ReturnType<typeof seenAt>[] = [];
    const moments: NonNullable<ReturnType<typeof momentOf>>[] = [];
    let i = 0;
    new Rebuild(w.chat.db, lw, opens.map((s) => s.start), (t, wd) => {
      const s = seenAt(wd, t);
      seen.push(s);
      const m = momentOf(wd, opens[i++], t, s);
      if (m) moments.push(m);
      // A moment of chats alone has no mail to choose from.
      expect(momentOf(wd, opens[i - 1], t, s.filter((x) => !x.mail))).toBeNull();
    }).run();
    const first = new Map(seen[0].map((s) => [s.conv.id, s]));
    expect(first.get(sam)!.mail).toMatchObject({ addressed: 'to', known: true });
    expect(first.get(jo)!.mail).toMatchObject({ addressed: 'cc' });
    expect(first.get(sam)!.input.mentions).toBe(1);
    expect(moments).toHaveLength(2);
    const chosen = moments[0].rows.find((r) => r.chosen)!;
    expect(chosen).toMatchObject({ mail: true, open: { source: 'inbox', rank: 2 } });
    expect(chosen.x).toMatchObject({ mail: 1, mailTo: 1, mailKnown: 1 });
    // Jo's thread was opened within the horizon after Sam's moment, from a list.
    expect(moments[0].rows.find((r) => !r.chosen)!.open).toMatchObject({ source: 'list' });
  });

  test('a refit learns the order with mail beside the first, saves it with its version, and a stale one is fitted again', async () => {
    const at = T0 + 10 * DAY;
    const w = await world((put) => put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: at - 8 * H, flags: { seen: false } }));
    const sam = w.tid('<s1@x>');
    new ActivityStore(w.chat).visits([{ id: 'v1', device: 'd1', view: 'mail', conversationId: sam, start: at - 6 * H, end: at - 6 * H + MIN, active: 60, source: 'inbox', rank: 0, sent: 0, reactions: 0, history: 0, threads: 0, attachments: 0, closed: true }], at);
    let bondsAsked = 0;
    const r = new InboxRanker(w.chat, w.triage, 'model', w.file, () => at, false, 'shadow');
    r.bonds = async () => (bondsAsked++, {});
    expect(r.due()).toBe(true);
    await r.refit({ stepMs: 5, pauseMs: 0 });
    expect(bondsAsked).toBe(1);
    expect(r.mailModel).toMatchObject({ fitAt: at, moments: 1, v: MAIL_MODEL_VERSION });
    // No chat was opened: the first model learned nothing.
    expect(r.model.moments).toBe(0);
    expect(r.due()).toBe(false);
    const again = new InboxRanker(w.chat, w.triage, 'model', undefined, () => at, false, 'shadow');
    expect(again.mailModel).toEqual(r.mailModel);
    // Saved at another version: the prior, and due at once.
    w.chat.db.query(`UPDATE meta SET value = ? WHERE key = 'inbox_rank_mail'`).run(JSON.stringify({ ...r.mailModel, v: MAIL_MODEL_VERSION - 1 }));
    const stale = new InboxRanker(w.chat, w.triage, 'model', undefined, () => at, false, 'shadow');
    expect(stale.mailModel).toEqual(PRIOR);
    expect(stale.due()).toBe(true);
    // Off: never fitted, never due for it.
    const off = new InboxRanker(w.chat, w.triage, 'model', undefined, () => at, false, 'off');
    off.model = { ...PRIOR, fitAt: at };
    expect(off.due()).toBe(false);
    expect(off.view().withMail).toEqual({ mode: 'off' });
  });
});

describe('the scorecard: the order shown against the order with mail', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test('mean 1 ÷ row as shown and as it would have stood, for every row and for mail rows alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'dither-rank-mail-score-'));
    const store = new Store(join(dir, 'hub.sqlite'), () => null);
    const now = Date.now();
    const day = dayOf(now - 3 * DAY);
    const [from] = dayBounds(day);
    let n = 0;
    const visit = (conv: string, rank: number, shadow: number | null) =>
      store.db
        .query(`INSERT INTO visit (id, device, view, conversation_id, start_at, end_at, active, source, rank, shadow_rank, updated_at) VALUES (?, 'd1', ?, ?, ?, ?, 30, 'inbox', ?, ?, ?)`)
        .run(`v${++n}`, conv.startsWith('mth_') ? 'mail' : 'conversation', conv, from + n * H, from + n * H + MIN, rank, shadow, from);
    visit('cnv_a', 0, 1);
    visit('mth_a', 3, 0);
    visit('mth_b', 1, 4);
    // From before the shadow order: counted in inbox.mrr only.
    visit('mth_c', 9, null);
    const rows = Object.fromEntries(whole(scoreAll(store.db, now)).filter((r) => r.day === day).map((r) => [r.metric, r]));
    store.db.close();
    expect(rows['inbox.mrr'].n).toBe(4);
    expect(rows['inbox.mrr_live']).toMatchObject({ n: 3 });
    expect(rows['inbox.mrr_live'].value).toBeCloseTo((1 + 1 / 4 + 1 / 2) / 3, 9);
    expect(rows['inbox.mrr_shadow'].value).toBeCloseTo((1 / 2 + 1 + 1 / 5) / 3, 9);
    expect(rows['inbox.mail_mrr']).toMatchObject({ n: 2, extra: { opens: 3 } });
    expect(rows['inbox.mail_mrr'].value).toBeCloseTo((1 / 4 + 1 / 2) / 2, 9);
    expect(rows['inbox.mail_mrr_shadow'].value).toBeCloseTo((1 + 1 / 5) / 2, 9);
  });
});

/**
 * The loudness scale's learning and its settings (docs/notifications.md): what your answers say, routed to the one
 * part of the model each is about, and the models fitted again after each answer (loudness.ts trainAttn) and once a
 * day, when what you did (answered, opened, swiped away) joins in at low weight.
 *
 * Where each answer goes:
 *  - The calibration feed's Sound / Show / Inbox (calfeed.ts): what it should have been. With no part named, want and
 *    can-wait move toward it for this kind of message (Sound: wanted, now; Show: wanted, not within minutes; Inbox:
 *    could wait hours), and a sound's cost at that moment a little. With parts named ("What was it wrong about?"),
 *    only those move: the person (want and owed), the chat, the topic (its words), how long it can wait, the moment
 *    (a sound's cost then); delivery teaches nothing (a fault of how it was sent, not of the message). Each answer is
 *    weighted back by the chance its card was drawn with (calfeed.ts ipsWeight).
 *  - Worth it: want and can't-wait up, for this kind of message. Shouldn't have reached me: want down. Could have
 *    waited: can-wait longer (want unchanged), and a sound at that moment a little dearer. Wish I'd known sooner:
 *    can't-wait up, want up, a sound a little cheaper. Fine where it was: nothing moves.
 *  - Louder / Quieter for a person or a chat: that person's or chat's weight only, on both chances. They also stand as
 *    today's marks (votes.ts: should have alerted, the alert was wrong, less like this), so the tiers keep learning.
 *  - The why, when given, replaces what its answer taught with what it names: how long it could have waited (a label
 *    for the can-wait buckets), this chat, this person (want and owed, across networks), this topic (the words), the
 *    moment (a sound's cost then, not the message), or "I'd already seen it" (nothing learned: a delivery fault).
 *  - Your own words are read by the local model only, turned into one of the reasons, and never kept.
 *  - The marks given in place, wherever they were given (syncMarks: kept as answers of source 'mark', read again at
 *    each start, so the ones from before the scale count too): Should have alerted as Sound (want, and needed within
 *    minutes); Alert was wrong as not a sound (not needed within minutes; want unchanged); Less like this as want down
 *    and can wait hours (toward the inbox and unread). The votes from before the tiers as the band they asked for, at
 *    half weight. Notices' and mail's marks (votes.ts `others`) the same way, from where they are kept.
 *
 * Label weights: answers and marks 1 (votes from before the tiers 0.5); you answered 0.3; an open of 5 s or more that did not follow a sound 0.1; a
 * row swiped away unopened 0.05; an open right after a sound 0 (the sound caused it).
 */
import type * as P from '@dither-chat/protocol';
import { bandOf, DEFAULT_ATTENTION_PREFS, CAL_ANSWERS, LOUDER_WHY, QUIETER_WHY } from '@dither-chat/protocol';
import { OLD_VOTE, words, type Example, type Facts, type Namer } from './learn.ts';
import { answerWeight, ATTN_WEIGHTS, emptyAttnModel, learnedList, loudness, partPoints, trainAttn, validAttnModel, type AttnExample, type AttnModel, type LoudInput } from './loudness.ts';
import { CalibrationFeed, IN_PLACE, ipsWeight, lateWeight, newId } from './calfeed.ts';
import { gatherOutcomes, LATE, OPEN_DWELL, type Outcome } from './labels.ts';
import { previewText, type Store } from './store.ts';
import { jobFailed } from './errors.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** What you did is learned from over this long, at most this many per chat (the newest). */
const IMPLICIT_WINDOW = 14 * DAY;
const IMPLICIT_PER_PLACE = 10;
/** An open this soon after a sound was the sound's doing. */
const AFTER_SOUND = 2 * MIN;
/** "Could have waited" / "Wish I'd known sooner" move a sound's cost at that moment this much; the moment's own reasons more. */
const MOMENT_NUDGE = 0.1;
const MOMENT_STEP = 0.3;

/** Answers that may be followed by "why", and which side's reasons it offers. */
const WHY_SIDE: Partial<Record<P.AttnAnswer, 'quieter' | 'louder'>> = { quieter: 'quieter', could_wait: 'quieter', shouldnt: 'quieter', louder: 'louder', sooner: 'louder' };

/** What each reason means, as the local model is asked about your words. Fixed strings: jev caches by them. */
const REASON_QUESTION: Record<P.WhyReason, string> = {
  could_wait: 'Does this say the message could have waited until later?',
  not_chat: 'Does this say the reader does not care about this chat or channel?',
  not_person: 'Does this say the reader does not care about messages from this person?',
  not_topic: 'Does this say the reader does not care about this topic?',
  bad_moment: 'Does this say it was a bad time to be interrupted?',
  seen: 'Does this say the reader had already seen it?',
  time_sensitive: 'Does this say the message was time-sensitive or urgent?',
  person_matters: 'Does this say this person matters to the reader?',
  chat_matters: 'Does this say this chat or channel matters to the reader?',
  topic_matters: 'Does this say this topic matters to the reader?',
  was_free: 'Does this say the reader was free and could have been interrupted?',
};

/** Asks the local model one yes/no question about a text: the chance of yes, or null. */
type Ask = (question: string, text: string) => Promise<number | null>;

interface Saved {
  model: AttnModel;
  rejected: string[];
  /** Learned with the marks given in place (since 2026-11-27): a model from before learns them at the first round. */
  marks?: boolean;
}

export class LoudLearner {
  readonly feed: CalibrationFeed;
  /** What it learned (loudness.ts), read by triage at each decision. */
  model: AttnModel = emptyAttnModel();
  private rejected: string[] = [];
  private implicitCache: { at: number; examples: AttnExample[] } | null = null;
  /** The local model, for your words (main.ts: jev; a demo hub: keywords). */
  ask: Ask | null = null;
  /** Mirrors Louder / Quieter onto today's marks (votes.ts), so the tiers keep learning. */
  mark: ((messageId: string, marks: P.TriageMarks) => void) | null = null;
  namer: Namer | null = null;
  /** Notices' and mail's marks (votes.ts `others`), as the tiers learn them. */
  others: ((now: number) => Example[]) | null = null;
  private otherCache: { at: number; examples: AttnExample[] } | null = null;
  /** Marks found at start that the model has not learned yet: the first round learns them. */
  private stale = false;

  constructor(
    private store: Store,
    readonly mode: P.AttentionMode,
  ) {
    const saved = store.metaValue<Saved>('attn_model');
    if (saved && validAttnModel(saved.model)) {
      this.model = saved.model;
      this.rejected = saved.rejected ?? [];
    }
    this.feed = new CalibrationFeed(store.db, (id) => this.describe(id), { loudNow: (id) => this.loudNow(id), points: (id) => this.points(id), signals: (now) => this.signals(now) });
    // The marks as answers, every start: the ones from before the scale, and any a hub without the scale kept.
    this.stale = this.syncMarks() > 0 || !saved?.marks;
  }

  /**
   * The marks on chat messages (triage.alert_mark, less_mark, and the votes from before the tiers) kept as answers of
   * source 'mark', one per mark with an id of its own, so this is safe to run again: a mark changed changes its
   * answer, a mark taken back takes it away. A mark that an answer already stands for (Louder, Quieter, Could have
   * waited, Shouldn't have reached me, or a feed answer against what was done: they set the marks) is not kept twice.
   * Returns how many answers changed.
   */
  syncMarks(messageId?: string): number {
    const db = this.store.db;
    const one = messageId ? ' AND t.message_id = ?' : '';
    const args = messageId ? [messageId] : [];
    const rows = db
      .query(
        `SELECT t.message_id, t.alert_mark, t.less_mark, t.marked_at, t.feedback, t.feedback_at, t.loud, m.conversation_id, COALESCE(i.person_id, m.author_id) AS author,
           EXISTS (SELECT 1 FROM notification n WHERE n.message_id = t.message_id AND n.alert = 1) AS sounded,
           EXISTS (SELECT 1 FROM attn_answer a WHERE a.message_id = t.message_id AND a.source != 'mark'
             AND (a.answer IN ('louder', 'quieter', 'could_wait', 'shouldnt') OR (a.source = 'feed' AND ((a.sounded = 1 AND a.answer != 'sound') OR (a.sounded = 0 AND a.answer = 'sound'))))) AS mirrored
         FROM triage t JOIN message m ON m.id = t.message_id LEFT JOIN identity i ON i.id = m.author_id
         WHERE (t.marked_at IS NOT NULL OR t.feedback IS NOT NULL) AND t.facts IS NOT NULL${one}`,
      )
      .all(...args) as Row[];
    const want = new Map<string, { r: Row; answer: P.AttnAnswer | P.CalAnswer; at: number }>();
    for (const r of rows) {
      if (r.mirrored) continue;
      if (r.marked_at != null && r.alert_mark != null) want.set(`mk_a_${r.message_id}`, { r, answer: r.alert_mark ? 'should_alert' : 'alert_wrong', at: r.marked_at });
      if (r.marked_at != null && r.less_mark) want.set(`mk_l_${r.message_id}`, { r, answer: 'less', at: r.marked_at });
      // A vote from before the tiers, unless a mark says more (as votes.ts reads them).
      const vote = r.feedback === 'push' ? 'sound' : r.feedback === 'quiet' ? 'show' : r.feedback === 'digest' ? 'inbox' : r.feedback === 'drop' ? 'less' : null;
      if (vote && r.marked_at == null) want.set(`mk_v_${r.message_id}`, { r, answer: vote, at: r.feedback_at ?? 0 });
    }
    const had = db.query(`SELECT id, answer, at FROM attn_answer WHERE source = 'mark'${messageId ? ' AND message_id = ?' : ''}`).all(...args) as Row[];
    let changed = 0;
    db.transaction(() => {
      for (const h of had) {
        const w = want.get(h.id);
        if (w && w.answer === h.answer && w.at === h.at) want.delete(h.id);
        else if (!w) {
          db.query('DELETE FROM attn_answer WHERE id = ?').run(h.id);
          changed++;
        }
      }
      const put = db.query(
        `INSERT INTO attn_answer (id, message_id, conversation_id, author, answer, source, band, sounded, at) VALUES (?, ?, ?, ?, ?, 'mark', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET answer = excluded.answer, band = excluded.band, sounded = excluded.sounded, at = excluded.at`,
      );
      for (const [id, w] of want) {
        put.run(id, w.r.message_id, w.r.conversation_id, w.r.author, w.answer, w.r.loud != null ? bandOf(w.r.loud) : null, w.r.sounded ? 1 : 0, w.at);
        changed++;
      }
    })();
    return changed;
  }

  /** Answers and marks given in place, the feed's own aside: what the feed waits for before it asks (calfeed.ts FITTED_AT). */
  signals(now = Date.now()): number {
    const n = this.store.one<Row>(`SELECT COUNT(*) AS n FROM attn_answer WHERE ${IN_PLACE} AND (until IS NULL OR until > ?)`, now)?.n ?? 0;
    return n + this.otherExamples(now).length;
  }

  /** Notices' and mail's marks as what they teach (markRouted), read again at most every ten minutes. */
  otherExamples(now = Date.now(), fresh = false): AttnExample[] {
    if (!this.others) return [];
    if (!fresh && this.otherCache && now - this.otherCache.at < 10 * MIN && now >= this.otherCache.at) return this.otherCache.examples;
    const out: AttnExample[] = [];
    for (const x of this.others(now)) {
      const base: AttnExample = { facts: x.facts, words: x.words, why: [], importance: 0.3, weight: 0, at: x.at };
      const e = (y: Partial<AttnExample>): AttnExample => ({ ...base, ...y, weight: x.weight, at: x.at });
      const marks: string[] = [];
      if (x.y?.alert === 1) marks.push('should_alert');
      if (x.y?.alert === 0) marks.push('alert_wrong');
      if (x.y?.important === 0) marks.push('less');
      if (!x.y && x.label) marks.push(x.label === 'push' ? 'sound' : x.label === 'quiet' ? 'show' : x.label === 'digest' ? 'inbox' : 'less');
      for (const m of marks) out.push(...markRouted(m, e));
    }
    this.otherCache = { at: now, examples: out };
    return out;
  }

  prefs(): P.AttentionPrefs {
    const s = this.store.metaValue<Partial<P.AttentionPrefs>>('attention_prefs') ?? {};
    const d = DEFAULT_ATTENTION_PREFS;
    return { readily: s.readily ?? d.readily, computerFirst: s.computerFirst ?? d.computerFirst, ask: s.ask ?? d.ask, drifting: s.drifting ?? d.drifting };
  }

  setPrefs(p: Partial<P.AttentionPrefs>): P.AttentionPrefs {
    const next = { ...this.prefs() };
    if (p.readily === 'less' || p.readily === 'learned' || p.readily === 'more') next.readily = p.readily;
    if (typeof p.computerFirst === 'boolean') next.computerFirst = p.computerFirst;
    if (p.ask === 'never' || p.ask === 'rarely' || p.ask === 'often') next.ask = p.ask;
    if (typeof p.drifting === 'boolean') next.drifting = p.drifting;
    this.store.setMetaValue('attention_prefs', next);
    return next;
  }

  /** A message's title and one line, who wrote it and where, for the calibration feed. */
  private describe(messageId: string): { title: string; preview: string; conversationId: string | null; network: string | null; shape: string | null; author: string | null; chat: string | null } | null {
    const s = this.store;
    const m = s.one<Row>(
      `SELECT m.body, m.kind, m.conversation_id, c.name, c.shape, c.network, COALESCE(p.name, i.display_name, i.handle) AS author
       FROM message m JOIN conversation c ON c.id = m.conversation_id LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN person p ON p.id = i.person_id WHERE m.id = ?`,
      messageId,
    );
    if (!m) return null;
    const where = m.shape === 'direct' ? (m.author ?? 'Direct message') : `${m.name ?? 'A chat'}${m.author ? ` · ${m.author}` : ''}`;
    return { title: where, preview: previewText(m.body ?? '', m.kind).slice(0, 160), conversationId: m.conversation_id, network: m.network ?? null, shape: m.shape ?? null, author: m.author ?? null, chat: m.name ?? null };
  }

  // ------------------------------------------------------------ answers

  /**
   * An answer about a message (the Why sheet, a notification's action). Louder / Quieter also stand as
   * today's marks. Says whether to ask why: at most one a chat a day, and never twice in a row for the same answer.
   */
  answer(b: P.AttnAnswerBody, now = Date.now()): P.AttnAnswerResult {
    const s = this.store;
    const t = s.one<Row>(
      `SELECT t.decision, t.loud, m.conversation_id, COALESCE(i.person_id, m.author_id) AS author,
         EXISTS (SELECT 1 FROM notification n WHERE n.message_id = m.id AND n.alert = 1) AS sounded
       FROM message m LEFT JOIN triage t ON t.message_id = m.id LEFT JOIN identity i ON i.id = m.author_id WHERE m.id = ?`,
      b.messageId,
    );
    if (!t) throw new Error('No such message');
    const id = newId('ans');
    const side = WHY_SIDE[b.answer];
    const asked = side ? this.whyDue(t.conversation_id, b.answer, now) : false;
    s.db
      .query(
        `INSERT INTO attn_answer (id, message_id, conversation_id, author, answer, source, scope, band, sounded, why_asked, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, b.messageId, t.conversation_id, t.author, b.answer, b.source, b.scope ?? null, t.loud != null ? bandOf(t.loud) : null, t.sounded ? 1 : 0, asked ? 1 : 0, now);
    // The tiers keep learning from these as from the marks they replace: Louder as "Should have alerted"; Quieter as
    // "Alert was wrong" on an alert, else "Less like this"; "Could have waited" on an alert as "Not urgent" did;
    // "Shouldn't have reached me" as both.
    const push = t.decision === 'push';
    const asMark: P.TriageMarks | null =
      b.answer === 'louder' ? { alert: true }
      : b.answer === 'quieter' ? (push ? { alert: false } : { less: true })
      : b.answer === 'could_wait' ? (push ? { alert: false } : null)
      : b.answer === 'shouldnt' ? (push ? { alert: false, less: true } : { less: true })
      : null;
    if (this.mark && t.decision && t.decision !== 'silent' && asMark) {
      try {
        this.mark(b.messageId, asMark);
      } catch (e) {
        console.error('attention: the mark could not be kept', e);
      }
    }
    this.learn(now);
    return { ok: true, answerId: id, ...(asked ? { why: side } : {}) };
  }

  /**
   * A mark from the old route (POST /api/messages/:id/feedback, on a chat message, a notice or mail): kept as the
   * answer it is (syncMarks; a notice's or mail's where it lies), and learned at once.
   */
  fromMark(messageId: string, marks: P.TriageMarks, now = Date.now()) {
    // A mark taken back also takes back the answer an older hub kept it as (source 'sheet').
    const back: P.AttnAnswer[] = [];
    if ('alert' in marks && marks.alert == null) back.push('louder', 'quieter');
    if ('less' in marks && marks.less === false) back.push('quieter');
    if (back.length) this.store.db.query(`DELETE FROM attn_answer WHERE message_id = ? AND source = 'sheet' AND answer IN (${back.map(() => '?').join(', ')})`).run(messageId, ...back);
    this.syncMarks(messageId);
    this.otherCache = null;
    this.learn(now);
  }

  private whyDue(conversationId: string | null, answer: P.AttnAnswer, now: number): boolean {
    const s = this.store;
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    if (conversationId && s.one(`SELECT 1 FROM attn_answer WHERE conversation_id = ? AND why_asked = 1 AND at >= ?`, conversationId, day.getTime())) return false;
    const last = s.one<Row>(`SELECT answer FROM attn_answer WHERE why_asked = 1 ORDER BY at DESC LIMIT 1`);
    return last?.answer !== answer;
  }

  /** The why after an answer: a chip, or your words mapped to one by the local model; an optional end date. */
  async why(b: P.WhyBody, now = Date.now()): Promise<P.WhyResult> {
    const s = this.store;
    const a = s.one<Row>('SELECT * FROM attn_answer WHERE id = ?', b.answerId);
    if (!a) throw new Error('No such answer');
    const side = WHY_SIDE[a.answer as P.AttnAnswer] ?? 'quieter';
    const allowed = side === 'quieter' ? QUIETER_WHY : LOUDER_WHY;
    let reason: P.WhyReason | null = b.reason && allowed.includes(b.reason) ? b.reason : null;
    let texted = false;
    if (!reason && b.text?.trim()) {
      reason = await this.readWords(b.text.trim().slice(0, 500), allowed);
      texted = !!reason;
    }
    const waits = side === 'quieter' ? ['10min', 'hour', 'tonight', 'never'] : ['now', 'within_hour', 'today'];
    const wait = b.wait && waits.includes(b.wait) ? b.wait : null;
    // "How long" alone says it was about waiting.
    if (!reason && wait) reason = side === 'quieter' ? 'could_wait' : 'time_sensitive';
    const until = typeof b.until === 'number' && b.until > now ? Math.round(b.until) : null;
    s.db.query('UPDATE attn_answer SET reason = ?, wait = ?, texted = ?, until = ?, why_at = ? WHERE id = ?').run(reason, wait, texted ? 1 : 0, until, now, a.id);
    this.learn(now);
    return { ok: true, reason };
  }

  /** Your words, as the reason the local model finds most likely (above even odds), else a few plain keywords. */
  private async readWords(text: string, allowed: readonly P.WhyReason[]): Promise<P.WhyReason | null> {
    if (this.ask) {
      let best: { r: P.WhyReason; p: number } | null = null;
      for (const r of allowed) {
        const p = await this.ask(REASON_QUESTION[r], text).catch(() => null);
        if (p !== null && (!best || p > best.p)) best = { r, p };
      }
      if (best && best.p >= 0.5) return best.r;
      if (best) return null;
    }
    const t = text.toLowerCase();
    const hit = (re: RegExp, r: P.WhyReason) => (allowed.includes(r) && re.test(t) ? r : null);
    return (
      hit(/\b(later|wait|tonight|tomorrow|not urgent)\b/, 'could_wait') ??
      hit(/\b(seen|already|read it)\b/, 'seen') ??
      hit(/\b(busy|meeting|asleep|sleeping|driving|bad time)\b/, 'bad_moment') ??
      hit(/\b(free|bored|wasn't busy)\b/, 'was_free') ??
      hit(/\b(urgent|asap|deadline|soon|now)\b/, 'time_sensitive') ??
      hit(/\b(channel|chat|group|server)\b/, allowed.includes('not_chat') ? 'not_chat' : 'chat_matters') ??
      hit(/\b(he|she|they|person|friend|boss)\b/, allowed.includes('not_person') ? 'not_person' : 'person_matters') ??
      hit(/\b(about|topic|anything)\b/, allowed.includes('not_topic') ? 'not_topic' : 'topic_matters')
    );
  }

  // ------------------------------------------------------------ the calibration feed

  /**
   * Sound / Show / Inbox on a feed item: kept as an answer, mirrored on today's marks where it says the alert was
   * wrong or missing (so the tiers learn too), learned at once. Says the chances before and after. Answering again
   * replaces the earlier answer.
   */
  feedAnswer(id: string, answer: P.CalAnswer, now = Date.now()): P.CalAnswerResult {
    if (!CAL_ANSWERS.includes(answer)) throw new Error(`Say one of ${CAL_ANSWERS.join(', ')}`);
    const it = this.feed.get(id);
    if (!it) throw new Error('No such item');
    const s = this.store;
    if (it.answer_id) this.takeBack(it);
    // Its loudness worked out again before the answer is learned: what "after" is measured against (calfeed.ts afterOf).
    const base = typeof it.loud_base === 'number' ? it.loud_base : this.loudNow(it.message_id);
    const t = s.one<Row>(`SELECT t.decision, m.conversation_id, COALESCE(i.person_id, m.author_id) AS author FROM message m LEFT JOIN triage t ON t.message_id = m.id LEFT JOIN identity i ON i.id = m.author_id WHERE m.id = ?`, it.message_id);
    const answerId = newId('ans');
    s.db
      .query(`INSERT INTO attn_answer (id, message_id, conversation_id, author, answer, source, checkin_id, band, sounded, chance, at) VALUES (?, ?, ?, ?, ?, 'feed', ?, ?, ?, ?, ?)`)
      .run(answerId, it.message_id, t?.conversation_id ?? it.conversation_id, t?.author ?? it.author, answer, id, bandOf(it.loud), it.did === 'sound' ? 1 : 0, it.chance, now);
    this.feed.answered(id, answer, answerId, base, now);
    const mark = feedMark(it.did, answer);
    if (mark && this.mark && t?.decision && t.decision !== 'silent') this.tryMark(it.message_id, mark);
    this.learn(now);
    const after = this.feed.afterOf(this.feed.get(id)!) ?? (JSON.parse(it.p) as P.Trio);
    this.feed.settleAfter(id, after, now);
    return { ok: true, answerId, before: JSON.parse(it.p), after };
  }

  /** "What was it wrong about?": the answer moves only these parts from now on. */
  feedParts(id: string, parts: P.CalPart[], now = Date.now()): P.CalPartsResult {
    const it = this.feed.get(id);
    if (!it?.answer_id) throw new Error('Answer it first');
    const ok = parts.filter((p, i) => (['person', 'chat', 'topic', 'wait', 'moment', 'delivery'] as const).includes(p) && parts.indexOf(p) === i);
    this.store.db.query('UPDATE attn_answer SET parts = ? WHERE id = ?').run(ok.length ? JSON.stringify(ok) : null, it.answer_id);
    this.feed.setParts(id, ok);
    this.learn(now);
    const after = this.feed.afterOf(this.feed.get(id)!) ?? (JSON.parse(it.p) as P.Trio);
    this.store.db.query('UPDATE cal_item SET after = ? WHERE id = ?').run(JSON.stringify(after), id);
    return { ok: true, after };
  }

  /** A past answer come back: Keep it; Only that once (kept, but it teaches nothing from now); Undo (taken back). */
  feedSettle(id: string, how: P.CalSettle, now = Date.now()) {
    const it = this.feed.get(id);
    if (!it?.answer_id) throw new Error('Nothing answered');
    if (how === 'once') this.store.db.query('UPDATE attn_answer SET until = ? WHERE id = ?').run(now, it.answer_id);
    if (how === 'undo') this.takeBack(it);
    this.feed.settle(id, how);
    if (how !== 'keep') this.learn(now);
  }

  /** An answer taken back, and the mark it stood as. */
  private takeBack(it: Row) {
    this.store.db.query('DELETE FROM attn_answer WHERE id = ?').run(it.answer_id);
    if (it.answer && feedMark(it.did, it.answer)) this.tryMark(it.message_id, { alert: null });
  }

  private tryMark(messageId: string, marks: P.TriageMarks) {
    try {
      this.mark?.(messageId, marks);
    } catch (e) {
      console.error('attention: the mark could not be kept', e);
    }
  }

  /** A message's loudness with what is learned now (or `model`), as triage would work it out again. */
  loudNow(messageId: string, model: AttnModel = this.model): number | null {
    const i = this.inputOf(messageId);
    return i ? loudness(i, model, this.prefs().readily).loudness : null;
  }

  /** How many points each part of the model gives it now. */
  points(messageId: string) {
    const i = this.inputOf(messageId);
    return i ? partPoints(i, this.model, this.prefs().readily) : null;
  }

  /** What triage worked its loudness out from, as it kept it: the moment from its kinds, the rule from its words. */
  private inputOf(messageId: string): LoudInput | null {
    const r = this.store.one<Row>(`SELECT t.facts, t.probs, t.loud_view, m.body FROM triage t JOIN message m ON m.id = t.message_id WHERE t.message_id = ? AND t.facts IS NOT NULL AND t.loud_view IS NOT NULL`, messageId);
    const base = r && baseOf(r);
    if (!base) return null;
    const lv = JSON.parse(r!.loud_view) as { moment?: string[]; parts?: P.LoudParts; rule?: string };
    const keys = lv.moment ?? [];
    const hour = keys.includes('hour:night') ? 2 : keys.includes('hour:morning') ? 9 : keys.includes('hour:evening') ? 20 : 14;
    return {
      facts: base.facts,
      words: base.words,
      importance: base.importance,
      ...(base.alert !== undefined ? { alert: base.alert } : {}),
      why: base.why as LoudInput['why'],
      owed: null,
      moment: { desk: keys.includes('desk'), hour, sinceSound: keys.includes('burst5') ? MIN : keys.includes('burst30') ? 10 * MIN : null, quiet: !!lv.parts?.quiet },
      ...(lv.rule === 'Always alert' ? { rule: 'always' as const } : lv.rule === 'List only' ? { rule: 'list' as const } : {}),
    };
  }

  // ------------------------------------------------------------ learning

  /** Every answer, as examples routed to the part each names. */
  answerExamples(now = Date.now()): AttnExample[] {
    const s = this.store;
    const out: AttnExample[] = [];
    const rows = s.raw<Row>(
      `SELECT a.*, t.facts, t.probs, t.loud_view, m.body, m.ts AS message_ts FROM attn_answer a JOIN triage t ON t.message_id = a.message_id JOIN message m ON m.id = a.message_id
       WHERE t.facts IS NOT NULL ORDER BY a.at DESC LIMIT 5000`,
    );
    for (const r of rows) {
      if (r.until != null && r.until <= now) continue;
      const base = baseOf(r);
      if (!base) continue;
      // A check-in or feed answer long after the message counts a little less (calfeed.ts lateWeight); a feed card
      // drawn with a small chance more (ipsWeight).
      const late = (r.source === 'checkin' || r.source === 'feed') && typeof r.message_ts === 'number' ? lateWeight(r.at - r.message_ts) : 1;
      const drawn = r.source === 'feed' ? ipsWeight(r.chance) : 1;
      // A mark counts as an answer; a vote from before the tiers half.
      const kind = r.source !== 'mark' ? ATTN_WEIGHTS.answer : String(r.id).startsWith('mk_v_') ? ATTN_WEIGHTS.mark * OLD_VOTE : ATTN_WEIGHTS.mark;
      out.push(...routed(r, base, answerWeight(r.at, now) * kind * late * drawn));
    }
    out.push(...this.otherExamples(now));
    // For you's answers (from before the feed): want, for the chat and the author.
    for (const r of s.raw<Row>(
      `SELECT c.answer, c.answered_at, t.facts, t.probs, t.loud_view, m.body, m.ts AS message_ts FROM checkin c JOIN triage t ON t.message_id = c.message_id JOIN message m ON m.id = c.message_id
       WHERE c.side = 'foryou' AND c.answer IS NOT NULL AND t.facts IS NOT NULL ORDER BY c.answered_at DESC LIMIT 2000`,
    )) {
      const base = baseOf(r);
      if (base) out.push({ ...base, want: r.answer === 'glad' ? 1 : 0, weight: answerWeight(r.answered_at, now) * lateWeight(r.answered_at - r.message_ts) });
    }
    return out;
  }

  /** What you did after the last two weeks' messages, at the low weights of the table. */
  implicitExamples(now = Date.now(), fresh = false): AttnExample[] {
    if (!fresh && this.implicitCache && now - this.implicitCache.at <= DAY && now >= this.implicitCache.at) return this.implicitCache.examples;
    const s = this.store;
    const row = s.db.query(`SELECT t.facts, t.probs, t.loud_view, m.body FROM triage t JOIN message m ON m.id = t.message_id WHERE t.message_id = ? AND t.loud_view IS NOT NULL`);
    const per = new Map<string, number>();
    const out: AttnExample[] = [];
    const outcomes = [...gatherOutcomes(s.db, now - IMPLICIT_WINDOW, now, { now }).values()].sort((a, b) => b.ts - a.ts);
    for (const o of outcomes) {
      const l = behaviourLabel(o);
      if (!l) continue;
      const n = per.get(o.conv) ?? 0;
      if (n >= IMPLICIT_PER_PLACE) continue;
      const r = row.get(o.id) as Row | null;
      const base = r && baseOf(r);
      if (!base) continue;
      per.set(o.conv, n + 1);
      out.push({ ...base, want: l.want, weight: l.weight, at: o.ts });
    }
    this.implicitCache = { at: now, examples: out };
    return out;
  }

  /** Fit again: after each answer (what you did as last read), and daily (read again). */
  learn(now = Date.now(), daily = false) {
    this.stale = false;
    try {
      const ex = [...this.answerExamples(now), ...this.implicitExamples(now, daily)];
      this.model = trainAttn(ex, new Set(this.rejected), now);
      this.store.setMetaValue('attn_model', { model: this.model, rejected: this.rejected, marks: true } satisfies Saved);
    } catch (e) {
      console.error('attention: could not learn', e);
      jobFailed('attention: learn', e);
    }
  }

  daily(now = Date.now()) {
    if (this.stale || !this.model.learnedAt || now - this.model.learnedAt > DAY || now < this.model.learnedAt) this.learn(now, true);
  }

  /** Forget something learned, for good, or let it be learned again (keys as learnedList gives them). */
  forget(key: string, rejected: boolean, now = Date.now()) {
    this.rejected = rejected ? [...new Set([...this.rejected, key])] : this.rejected.filter((k) => k !== key);
    this.learn(now);
  }

  /** For you's factor from what you said was worth seeing: the chat's and the author's want, 0 to 2, 1 knowing nothing. */
  worth(c: { conv: string; author: string | null }): number {
    const z = (this.model.want[`conv:${c.conv}`] ?? 0) + (c.author ? (this.model.want[`author:${c.author}`] ?? 0) : 0);
    return 2 / (1 + Math.exp(-z));
  }

  view(now = Date.now()): P.AttentionStateView {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    const sounds = this.store.one<Row>(`SELECT COUNT(*) AS n FROM triage INDEXED BY triage_created WHERE created_at >= ? AND decision = 'push'`, day.getTime())?.n ?? 0;
    return {
      mode: this.mode,
      prefs: this.prefs(),
      soundsToday: sounds,
      asked: this.feed.cardsToday(now),
      answered: this.feed.answeredToday(now),
      pending: this.feed.pendingCount(now),
      learned: learnedList(this.model, this.namer),
    };
  }
}

/** A stored decision as the start of an example: its facts, words, reasons, and where want and urgency began. */
function baseOf(r: Row): AttnExample | null {
  let facts: Facts;
  try {
    facts = JSON.parse(r.facts);
  } catch {
    return null;
  }
  const probs = r.probs ? (JSON.parse(r.probs) as Partial<P.TriageProbs>) : {};
  const lv = r.loud_view ? (JSON.parse(r.loud_view) as { why?: string[]; moment?: string[] }) : {};
  return {
    facts,
    words: words(r.body ?? ''),
    why: lv.why ?? [],
    importance: typeof probs.important === 'number' ? probs.important : 0.3,
    ...(facts.judge !== undefined && typeof probs.alert === 'number' ? { alert: probs.alert } : {}),
    ...(lv.moment ? { moment: { keys: lv.moment, by: 0 } } : {}),
    weight: 0,
    at: r.at ?? 0,
  };
}

const QUIETER_WAIT: Record<string, AttnExample['wait']> = { '10min': [0, 1, undefined], hour: [0, 0, 1], tonight: [0, 0, 0], never: [0, 0, 0] };
const LOUDER_WAIT: Record<string, AttnExample['wait']> = { now: [1, 1, 1], within_hour: [0, 1, 1], today: [0, 0, 1] };

/** One answer (and its why) as what it teaches, each part at the scope it names. */
export function routed(a: Row, base: AttnExample, weight: number): AttnExample[] {
  const keys = base.moment?.keys ?? [];
  const e = (x: Partial<AttnExample>): AttnExample => ({ ...base, moment: undefined, ...x, weight, at: a.at });
  const scope = a.scope === 'chat' ? 'conv' : a.scope === 'person' ? 'author' : undefined;
  if (a.source === 'feed' && (CAL_ANSWERS as readonly string[]).includes(a.answer)) return feedRouted(a, base, e, keys);
  if (a.source === 'mark') return markRouted(a.answer, e);
  const reason = a.reason as P.WhyReason | null;
  if (reason) {
    switch (reason) {
      case 'could_wait':
        return [e({ wait: QUIETER_WAIT[a.wait] ?? [undefined, 0, undefined], ...(a.wait === 'never' ? { want: 0 } : {}), moment: { keys, by: MOMENT_NUDGE } })];
      case 'time_sensitive':
        return [e({ wait: LOUDER_WAIT[a.wait] ?? [undefined, 1, 1] })];
      case 'not_chat':
      case 'chat_matters':
        return [e({ want: reason === 'chat_matters' ? 1 : 0, only: 'conv' })];
      case 'not_person':
      case 'person_matters':
        return [e({ want: reason === 'person_matters' ? 1 : 0, owed: reason === 'person_matters' ? 1 : 0, only: 'author' })];
      case 'not_topic':
      case 'topic_matters':
        return base.words.length ? [e({ want: reason === 'topic_matters' ? 1 : 0, only: 'words' })] : [];
      case 'bad_moment':
      case 'was_free':
        return keys.length ? [e({ moment: { keys, by: reason === 'bad_moment' ? MOMENT_STEP : -MOMENT_STEP } })] : [];
      case 'seen':
        return [];
    }
  }
  switch (a.answer as P.AttnAnswer) {
    case 'worth':
      return [e({ want: 1, wait: [undefined, 1, 1] })];
    case 'could_wait':
      return [e({ wait: [undefined, 0, undefined], moment: { keys, by: MOMENT_NUDGE } })];
    case 'shouldnt':
      return [e({ want: 0 })];
    case 'sooner':
      return [e({ want: 1, wait: [undefined, 1, 1], moment: { keys, by: -MOMENT_NUDGE } })];
    case 'louder':
      return [e({ want: 1, wait: [undefined, 1, 1], ...(scope ? { only: scope } : {}), ...(scope === 'author' ? { owed: 1 } : {}) })];
    case 'quieter':
      return [e({ want: 0, wait: [undefined, 0, undefined], ...(scope ? { only: scope } : {}), ...(scope === 'author' ? { owed: 0 } : {}) })];
    default:
      return [];
  }
}

/** The answers' order, quietest first: which way a feed answer said it should have gone. */
const RANK: Record<P.CalAnswer, number> = { inbox: 0, show: 1, sound: 2 };
const asAnswer = (band: unknown): P.CalAnswer => (band === 'sound' ? 'sound' : band === 'show' || band === 'next' ? 'show' : 'inbox');

/** A feed answer as the mark it stands for on the tiers: it should have sounded, or the sound was wrong. */
function feedMark(did: P.CalAnswer, answer: P.CalAnswer): P.TriageMarks | null {
  if (did === 'sound' && answer !== 'sound') return { alert: false };
  if (did !== 'sound' && answer === 'sound') return { alert: true };
  return null;
}

/** What each answer says of how long it can wait: needed within 10 minutes, an hour, the day. */
const FEED_WAIT: Record<P.CalAnswer, AttnExample['wait']> = { sound: [1, 1, 1], show: [0, undefined, 1], inbox: [0, 0, undefined] };

/**
 * A feed answer (Sound / Show / Inbox) as what it teaches: with no parts named, want and can-wait toward it and a
 * sound's cost at that moment a little; with parts named, only those parts (above). `y`: louder than what the model
 * gave (1) or quieter (0); the same, the answer's own side.
 */
export function feedRouted(a: Row, base: AttnExample, e: (x: Partial<AttnExample>) => AttnExample, keys: string[]): AttnExample[] {
  const ans = a.answer as P.CalAnswer;
  const gave = asAnswer(a.band);
  const dir = Math.sign(RANK[ans] - RANK[gave]);
  const y: 0 | 1 = dir > 0 ? 1 : dir < 0 ? 0 : ans === 'inbox' ? 0 : 1;
  let parts: P.CalPart[] = [];
  try {
    parts = a.parts ? (JSON.parse(a.parts) as P.CalPart[]) : [];
  } catch {}
  // A sound it gave wrongly makes one at that moment a little dearer; one it should have given, a little cheaper.
  const nudge = dir && (ans === 'sound' || gave === 'sound') ? { moment: { keys, by: dir > 0 ? -MOMENT_NUDGE : MOMENT_NUDGE } } : {};
  if (!parts.length) return [e({ ...(ans === 'inbox' ? {} : { want: 1 as const }), wait: FEED_WAIT[ans], ...nudge })];
  const out: AttnExample[] = [];
  for (const p of parts) {
    if (p === 'person') out.push(e({ want: y, owed: y, only: 'author' }));
    if (p === 'chat') out.push(e({ want: y, only: 'conv' }));
    if (p === 'topic' && base.words.length) out.push(e({ want: y, only: 'words' }));
    if (p === 'wait') out.push(e({ wait: FEED_WAIT[ans] }));
    if (p === 'moment' && keys.length && dir) out.push(e({ moment: { keys, by: dir > 0 ? -MOMENT_STEP : MOMENT_STEP } }));
    // delivery: how it was sent, not the message: nothing to learn.
  }
  return out;
}

/**
 * A mark given in place as what it teaches: Should have alerted, a sound (wanted, needed within minutes); Alert was
 * wrong, not a sound (not needed within minutes; want unchanged); Less like this, toward the inbox and unread (want
 * down, can wait hours); a vote from before the tiers, the band it asked for.
 */
export function markRouted(answer: string, e: (x: Partial<AttnExample>) => AttnExample): AttnExample[] {
  switch (answer) {
    case 'should_alert':
      return [e({ want: 1, wait: [1, 1, 1] })];
    case 'alert_wrong':
      return [e({ wait: [0, undefined, undefined] })];
    case 'less':
      return [e({ want: 0, wait: [0, 0, undefined] })];
    case 'sound':
    case 'show':
      return [e({ want: 1, wait: FEED_WAIT[answer] })];
    case 'inbox':
      return [e({ wait: FEED_WAIT.inbox })];
    default:
      return [];
  }
}

/** What you did, as a label of want: answered (0.3), opened and stayed, not right after a sound (0.1), swiped away unopened (0.05). */
export function behaviourLabel(o: Outcome): { want: 0 | 1; weight: number } | null {
  if (o.engaged || o.seenLive || o.suppressed) return null;
  if ((o.answered && o.nextOwn !== null && o.nextOwn <= LATE) || o.reacted) return { want: 1, weight: ATTN_WEIGHTS.replied };
  const sounded = o.decision === 'push' && o.notified;
  const tapped = o.tapped !== null && (o.tapDwell ?? o.openDwell ?? OPEN_DWELL) >= OPEN_DWELL;
  const opened = o.opened !== null && o.opened <= DAY && (o.openDwell ?? OPEN_DWELL) >= OPEN_DWELL;
  if (tapped || opened) {
    const at = tapped ? o.tapped! : o.opened!;
    if (sounded && at <= AFTER_SOUND) return null;
    return { want: 1, weight: ATTN_WEIGHTS.opened };
  }
  if (o.dismissed && o.opened === null) return { want: 0, weight: ATTN_WEIGHTS.swiped };
  return null;
}

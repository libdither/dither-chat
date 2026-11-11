/**
 * Notification triage: which tier a message lands in (docs/notifications.md).
 *
 * Three tiers and what is below them. Alert ('push': the phone sounds, the desktop notifies) is for what cannot wait
 * an hour or two. Conversation ('quiet': a silent row of its own on the phone) is people talking with you. List
 * ('digest': a silent row in the phone's ranked list) is whatever else is important enough; the rest ('drop') stays
 * unread in its chat. The codes are those of the four levels the tiers replaced.
 *
 * For each message, in order:
 *   1. A place you muted, or a held message request: silent.
 *   2. A person or place you set to always alert, or one of your keywords: an alert.
 *   3. Its importance, a chance (learn.ts): it starts from the network's own setting for the place and moves with
 *      what you opened, swiped away and marked.
 *   4. Is it a Conversation? A rule (tiers.ts): a DM, about you, or a chat you take part in.
 *   5. If it is (or you marked this place or person "should have alerted" lately), the local model reads it
 *      (`judge`), and it alerts when its alert chance is even or better. That chance starts from the model's answer
 *      and moves with your marks.
 *   6. Else a Conversation stays one; anything else is on the list at your level of importance or more, or below it.
 *
 * A place's rule, most specific first:
 *   conversation > thread parent > containing spaces (nearest first) > account > network > global
 * With none of those set it is Automatic, and the network's own settings say what it would have notified you about.
 * A place set to List only, or muted on its network, is never a Conversation or an alert. 'none' is absolute.
 *
 * Quiet hours come last: an alert decided during them is held (it stays a Conversation or a list row, silent), and
 * one summary goes out when they end.
 *
 * Every decision is stored with its reasons so the UI can explain it, and with its facts so your marks can be
 * learned from and every change to the rules backtested against them.
 */

import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { previewText, type Store } from './store.ts';
import { describeActivity, type ActivityStore, type Features } from './activity.ts';
import { ALERT_BAR, alertBar, describeWeight, emptyModel, importance, predict, prior, THRESHOLDS, tierFrom, TIER_NAME, words, type Facts, type Level, type Model, type Namer, type TierContext } from './learn.ts';
import { InteractionLog } from './interact.ts';
import { conversing, CONVERSING_REASON } from './tiers.ts';
import { requestHeld } from './add.ts';

type Row = Record<string, any>;

export interface Decision {
  decision: P.TriageDecision;
  /** Its importance, 0 to 1. */
  score: number | null;
  reasons: string[];
  decidedBy: 'rules' | 'model' | 'learned';
  title: string;
  /** What it was decided from; absent for silenced places, which are not marked. */
  facts?: Facts;
  /** The model's two chances. */
  probs?: P.TriageProbs;
  body: string;
  /** From a person set to always alert: may get through quiet hours. */
  alwaysNotify?: boolean;
  /** What the activity log said about this place when deciding (DITHER_ACTIVITY_FEATURES), kept for training. */
  features?: Features;
  /** Matched one of your keywords. */
  keyword?: boolean;
  /** A rule of yours made it an alert: the model does not decide. */
  forced?: boolean;
  /** The local model was asked and did not answer in time: the caller may decide again later (`late`). */
  unjudged?: boolean;
  /** The candidate model's chances, kept next to the live ones; it never decides (shadow.ts). */
  shadow?: P.TriageProbs;
}

/** The local model's reading of a message: its chance, 0 to 1, that it cannot wait an hour or two; null when it did not answer. */
export type Judge = (text: string) => Promise<number | null>;
/** The one question the local model is asked. A fixed string: jev caches by it. */
export const STOP_QUESTION = 'Does this message need the reader to stop what they are doing and act or reply within the next hour or two?';
export const JUDGE_INSTRUCT = 'Given a chat message someone received, judge whether it meets the description';
/** At most this much of a message is read. */
export const JUDGE_CHARS = 500;
/** A place or person you marked "should have alerted" may alert for this long, Conversation or not. */
export const MARKED_FOR = 90 * 86_400_000;

/** What the networks do where nothing is set: DMs and group chats notify on every message, channels on mentions. */
export const NATIVE_DEFAULT: Record<P.Shape, 'all' | 'mentions' | 'none'> = { direct: 'all', group: 'all', channel: 'mentions', thread: 'mentions', self: 'none' };

/** Local weekday and minutes since midnight in a time zone. */
function localTime(tz: string, now: number): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), minutes: +get('hour') * 60 + +get('minute') };
}

const toMinutes = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

/** Are these quiet hours on right now? A window past midnight belongs to the day it started on. */
export function inQuietHours(q: P.QuietHours | null, now: number): boolean {
  if (!q?.enabled) return false;
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  if (start === end) return false;
  const { day, minutes } = localTime(q.timezone, now);
  const startedOn = (d: number) => !q.days?.length || q.days.includes(d);
  if (start < end) return minutes >= start && minutes < end && startedOn(day);
  if (minutes >= start) return startedOn(day);
  return minutes < end && startedOn((day + 6) % 7);
}

export function validQuietHours(q: Partial<P.QuietHours>): q is P.QuietHours {
  const time = (s: unknown) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  if (!time(q.start) || !time(q.end) || typeof q.timezone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: q.timezone });
    return true;
  } catch {
    return false;
  }
}

export const URGENT = /\b(urgent|asap|emergency|right now|call me|help!|deadline|today|tonight|are you (around|there|free))\b/i;
export class Triage {
  /** What your marks taught (votes.ts keeps it). */
  learned: Model = emptyModel();
  /** Names places and people, for reasons in words (votes.ts). */
  namer: Namer | null = null;
  /** The candidate model, run in shadow (votes.ts keeps it). */
  candidate: Model | null = null;
  /** The local model (main.ts: jev). Without one nothing alerts by chance: only your rules do. */
  judge: Judge | null = null;
  /** How long a decision waits for the local model. */
  judgeTimeoutMs = 3000;
  /**
   * Content features of a message (embeddings.ts: `emb`, `knn`), when DITHER_EMBEDDINGS is on. Like the interaction
   * features, only the shadow model weighs them.
   */
  content: ((messageId: string) => Record<string, number>) | null = null;
  private interactions: InteractionLog | null = null;
  private markedCache: { at: number; convs: Set<string>; authors: Set<string> } | null = null;

  constructor(
    private store: Store,
    private activity?: ActivityStore,
  ) {}

  /** The thresholds in force: an alert at even odds, the list at your level. */
  thresholds(): P.TriageProbs {
    return { alert: THRESHOLDS.alert, important: this.store.listLevel() ?? THRESHOLDS.important };
  }

  /** The fold of who wrote when (interact.ts), caught up to now. */
  private interact(): InteractionLog {
    this.interactions ??= new InteractionLog(this.store.db);
    this.interactions.catchUp();
    return this.interactions;
  }

  /** Places and people you marked "should have alerted" in the last `MARKED_FOR`: they may alert, Conversation or not. */
  marked(now = Date.now()): { convs: Set<string>; authors: Set<string> } {
    const c = this.markedCache;
    if (c && now - c.at < 60_000 && now >= c.at) return c;
    const convs = new Set<string>();
    const authors = new Set<string>();
    for (const r of this.store.raw<Row>(
      `SELECT m.conversation_id AS conv, COALESCE(i.person_id, m.author_id) AS author FROM triage t JOIN message m ON m.id = t.message_id
       LEFT JOIN identity i ON i.id = m.author_id WHERE t.alert_mark = 1 AND t.marked_at > ?`,
      now - MARKED_FOR,
    )) {
      convs.add(r.conv);
      if (r.author) authors.add(r.author);
    }
    this.markedCache = { at: now, convs, authors };
    return this.markedCache;
  }

  /** A mark was made: read them again at the next decision. */
  forgetMarked() {
    this.markedCache = null;
  }

  /** Human-readable name of where a conversation lives, for titles and reasons. */
  placeName(c: Row): string {
    const s = this.store;
    if (c.shape === 'direct') {
      const peer = s.one<Row>(
        `SELECT COALESCE(p.name, i.display_name, i.handle, i.native_id) AS n FROM participant pa JOIN identity i ON i.id = pa.identity_id
         LEFT JOIN person p ON p.id = i.person_id WHERE pa.conversation_id = ? AND (p.is_self IS NULL OR p.is_self = 0) LIMIT 1`,
        c.id,
      );
      return peer?.n ?? 'Direct message';
    }
    if (c.shape === 'thread' && c.parent_id) {
      const parent = s.one<Row>('SELECT * FROM conversation WHERE id = ?', c.parent_id);
      return `${c.name ?? 'Thread'} in ${parent ? this.placeName(parent) : 'a channel'}`;
    }
    if (c.shape === 'channel') {
      const sp = this.ancestors(c.id)[0];
      const top = sp ? this.communityOf(sp.id) : null;
      return `#${c.name ?? 'channel'}${top ? ` · ${top.name}` : ''}`;
    }
    return c.name ?? 'Group';
  }

  communityOf(spaceId: string): Row | null {
    let cur = this.store.one<Row>('SELECT * FROM space WHERE id = ?', spaceId);
    const seen = new Set<string>();
    while (cur && cur.kind === 'section' && !seen.has(cur.id)) {
      seen.add(cur.id);
      const up = this.store.one<Row>(`SELECT s.* FROM space_edge e JOIN space s ON s.id = e.parent_id WHERE e.child_kind = 'space' AND e.child_id = ? LIMIT 1`, cur.id);
      if (!up) break;
      cur = up;
    }
    return cur;
  }

  /** Spaces containing a conversation, breadth-first (nearest first). Cycles in Matrix space graphs are tolerated. */
  ancestors(conversationId: string): Row[] {
    const out: Row[] = [];
    const seen = new Set<string>();
    let frontier = this.store.raw<Row>(
      `SELECT s.* FROM space_edge e JOIN space s ON s.id = e.parent_id WHERE e.child_kind = 'conversation' AND e.child_id = ?`,
      conversationId,
    );
    while (frontier.length) {
      const next: Row[] = [];
      for (const sp of frontier) {
        if (seen.has(sp.id)) continue;
        seen.add(sp.id);
        out.push(sp);
        next.push(...this.store.raw<Row>(`SELECT s.* FROM space_edge e JOIN space s ON s.id = e.parent_id WHERE e.child_kind = 'space' AND e.child_id = ?`, sp.id));
      }
      frontier = next;
    }
    return out;
  }

  /** The effective level for a conversation and where it came from. Also used by the UI's "why" panel. */
  effectiveLevel(conversationId: string): { level: P.NotifyLevel; source: string; explicit: boolean; native?: boolean } {
    const s = this.store;
    const c = s.one<Row>('SELECT * FROM conversation WHERE id = ?', conversationId);
    if (!c) return { level: 'mentions', source: 'default', explicit: false };
    // 'smart' is from before the tiers: no rule.
    const rules = new Map(
      s
        .rules()
        .filter((r) => r.level !== 'smart')
        .map((r) => [`${r.scope}:${r.target ?? ''}`, r.level]),
    );
    const hit = (scope: string, target: string | null) => rules.get(`${scope}:${target ?? ''}`);
    const label = (x: Row) => `${x.name}${x.kind === 'section' ? '' : ` (${NETWORK_META[x.network as P.Network].spaceNoun})`}`;

    let l = hit('conversation', c.id);
    if (l) return { level: l, source: 'this conversation', explicit: true };
    const parent = c.shape === 'thread' && c.parent_id ? s.one<Row>('SELECT * FROM conversation WHERE id = ?', c.parent_id) : null;
    if (parent && (l = hit('conversation', parent.id))) return { level: l, source: `#${parent.name ?? 'parent'}`, explicit: true };
    for (const sp of this.ancestors(parent?.id ?? c.id)) {
      if ((l = hit('space', sp.id))) return { level: l, source: label(sp), explicit: true };
    }
    const accounts = s.vantageAccounts('conversation', c.id);
    const mute = this.nativeMute(c.id, parent?.id);
    const base = (() => {
      for (const a of accounts) {
        const r = hit('account', a);
        if (r) return { level: r, source: `account ${s.account(a)?.label ?? a}` };
      }
      if ((l = hit('network', c.network))) return { level: l, source: `all of ${NETWORK_META[c.network as P.Network].name}` };
      if ((l = hit('global', null))) return { level: l, source: 'global default' };
      // Nothing set: as the network has it, every message, mentions only, or muted (kept to the list).
      const n = this.nativeLevel(c);
      return { level: (n === 'none' ? 'digest' : n) as P.NotifyLevel, source: `as in ${NETWORK_META[c.network as P.Network].name}`, native: true };
    })();
    // Nothing set by you: the network's own settings decide, mutes included (nativeLevel).
    if ('native' in base) return { ...base, explicit: false };
    if (mute && rank(base.level) > rank(mute.level)) {
      return { level: mute.level, source: `muted in ${NETWORK_META[c.network as P.Network].name}`, explicit: false };
    }
    return { ...base, explicit: false };
  }

  private nativeMute(cid: string, parentId?: string): { level: P.NotifyLevel } | null {
    const now = Date.now();
    const rows = this.store.raw<Row>(
      `SELECT native_mute FROM vantage WHERE native_mute IS NOT NULL AND (
         (target_kind = 'conversation' AND target_id IN (?, ?))
         OR (target_kind = 'space' AND target_id IN (SELECT parent_id FROM space_edge WHERE child_kind = 'conversation' AND child_id IN (?, ?))))`,
      cid,
      parentId ?? cid,
      cid,
      parentId ?? cid,
    );
    let best: P.NotifyLevel | null = null;
    for (const r of rows) {
      const m = JSON.parse(r.native_mute) as P.NativeMute;
      const muted = m.level === 'none' || (m.until !== undefined && m.until > now);
      const lv: P.NotifyLevel | null = muted ? 'digest' : m.level === 'mentions' ? 'mentions' : null;
      if (lv && (!best || rank(lv) < rank(best))) best = lv;
    }
    return best ? { level: best } : null;
  }

  /**
   * What the network itself does with a conversation's messages: notify on every one, only on mentions, or not at
   * all. The most specific setting wins: the conversation, its parent channel, its categories, its server; a mute
   * that has run out no longer counts. Across accounts, the loudest. Else the network's default for its shape.
   */
  nativeLevel(c: Row, now = Date.now()): 'all' | 'mentions' | 'none' {
    const loud = { none: 0, mentions: 1, all: 2 } as const;
    const at = (kind: 'conversation' | 'space', id: string): 'all' | 'mentions' | 'none' | null => {
      let best: 'all' | 'mentions' | 'none' | null = null;
      for (const r of this.store.raw<Row>(`SELECT native_mute FROM vantage WHERE target_kind = ? AND target_id = ? AND native_mute IS NOT NULL`, kind, id)) {
        const m = JSON.parse(r.native_mute) as P.NativeMute;
        if (m.until !== undefined && m.until <= now) continue;
        const lv = m.until !== undefined ? 'none' : m.level;
        if (lv && (!best || loud[lv] > loud[best])) best = lv;
      }
      return best;
    };
    const parent = c.shape === 'thread' && c.parent_id ? (c.parent_id as string) : null;
    const chain: ['conversation' | 'space', string][] = [['conversation', c.id], ...(parent ? [['conversation', parent] as ['conversation', string]] : []), ...this.ancestors(parent ?? c.id).map((sp) => ['space', sp.id] as ['space', string])];
    for (const [kind, id] of chain) {
      const lv = at(kind, id);
      if (lv) return lv;
    }
    return NATIVE_DEFAULT[c.shape as P.Shape] ?? 'mentions';
  }

  async decide(messageId: string, now = Date.now()): Promise<Decision | null> {
    const d = this.decideByRules(messageId);
    if (d) this.withActivity(d, messageId, now);
    if (d?.facts) await this.withModel(d, messageId, now);
    if (d?.decision !== 'push') return d;
    const q = this.store.quietHours();
    if (!inQuietHours(q, now) || (q!.allowStarred && d.alwaysNotify)) return d;
    // Held: it stays where it would be without the alert, silent.
    d.decision = d.facts?.conv ? 'quiet' : 'digest';
    d.reasons.unshift(`Held by quiet hours until ${q!.end}`);
    const held = this.store.quietHeld();
    const conversationId = this.store.one<Row>('SELECT conversation_id FROM message WHERE id = ?', messageId)!.conversation_id;
    this.store.setQuietHeld({ count: (held?.count ?? 0) + 1, conversationId, messageId });
    return d;
  }

  /**
   * The tier: is it a Conversation (tiers.ts), what the local model makes of it when it may alert, then the two
   * chances from where they start plus what your marks taught. Moved by your marks, it says by what.
   */
  private async withModel(d: Decision, messageId: string, now: number) {
    const f = d.facts!;
    const m = this.store.one<Row>('SELECT conversation_id, ts, body FROM message WHERE id = ?', messageId)!;
    const fold = this.interact().fold;
    const why = conversing(f, { lastOwn: fold.lastOwn(m.conversation_id), answerRate: fold.answerRate(m.conversation_id, m.ts) }, m.ts);
    f.conv = !!why;
    const marked = this.marked(now);
    const eligible = !f.cap && (f.conv || marked.convs.has(m.conversation_id) || (!!f.author && marked.authors.has(f.author)));
    if (eligible && !d.forced) {
      const j = await this.ask(m.body ?? '');
      if (j === undefined) d.unjudged = true;
      else if (j !== null) f.judge = Math.round(j * 1000) / 1000;
    }
    const ws = words(m.body ?? '');
    const p = predict(this.learned, f, ws);
    d.probs = rounded(p.probs);
    d.score = importance(p.probs);
    const content = this.content?.(messageId);
    if (content && Object.keys(content).length && d.features) d.features.x = { ...d.features.x, ...content };
    if (this.candidate) d.shadow = rounded(predict(this.candidate, f, ws, undefined, d.features?.x ?? content).probs);
    if (d.forced) return;
    const ctx: TierContext = { conv: f.conv, eligible, judged: f.judge !== undefined, listOnly: !!f.cap };
    const t = this.thresholds();
    const tier = tierFrom(p.probs, ctx, t);
    const before = tierFrom(prior(f), ctx, t);
    d.decision = tier;
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    if (why) d.reasons.unshift(CONVERSING_REASON[why]);
    if (tier === 'push') d.reasons.unshift((f.judge ?? 0) >= alertBar(f) ? `Reads as urgent: the local model's answer is ${f.judge} against a bar of ${alertBar(f)}` : `The local model's answer is ${f.judge}, under its bar of ${alertBar(f)}: your marks made it an alert`);
    else if (tier === 'digest') d.reasons.unshift(`On the list: importance ${pct(p.probs.important)}, at or over your level of ${pct(t.important)}`);
    else if (tier === 'drop') d.reasons.unshift(`Below the list: importance ${pct(p.probs.important)}, under your level of ${pct(t.important)}`);
    if (tier !== before) {
      const n = this.namer;
      const head = tier === 'push' || before === 'push' ? 'alert' : 'important';
      const said = n
        ? p.why
            .filter((w) => w.head === head)
            .slice(0, 2)
            .map((w) => describeWeight(w.feature, w.head, w.by, n))
        : [];
      d.reasons.unshift(`${TIER_NAME[tier]}, learned from your marks (was ${TIER_NAME[before]})`, ...said);
      d.decidedBy = 'learned';
    }
  }

  /** Ask the local model, for at most `judgeTimeoutMs`. null: it has no answer; undefined: it did not answer in time. */
  private async ask(body: string): Promise<number | null | undefined> {
    const text = body.slice(0, JUDGE_CHARS).trim();
    if (!this.judge || !text) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.judge(text).catch(() => null),
        new Promise<undefined>((r) => {
          timer = setTimeout(() => r(undefined), this.judgeTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Where the rules put a stored message, with its facts, before the model and quiet hours: for the replay. */
  rulesFor(messageId: string): Decision | null {
    return this.decideByRules(messageId);
  }

  /** The facts for a stored message, for a vote on one decided before facts were kept. */
  factsFor(messageId: string, base: Level): Facts | null {
    const s = this.store;
    const m = s.one<Row>('SELECT * FROM message WHERE id = ?', messageId);
    if (!m) return null;
    const c = s.one<Row>('SELECT * FROM conversation WHERE id = ?', m.conversation_id);
    if (!c) return null;
    const author = m.author_id ? s.one<Row>('SELECT * FROM identity WHERE id = ?', m.author_id) : null;
    return { ...this.facts(m, c, author), base };
  }

  /** Everything a decision is made from, as flags. Read from the message's text: a question, urgency. */
  private facts(m: Row, c: Row, author: Row | null): Omit<Facts, 'base'> {
    const s = this.store;
    const repliedTo = m.reply_to_id ? s.one<Row>('SELECT author_id FROM message WHERE id = ?', m.reply_to_id) : null;
    const parent = c.shape === 'thread' && c.parent_id ? c.parent_id : null;
    const recentSelf = s.one<Row>(
      `SELECT 1 FROM message WHERE conversation_id = ? AND ts > ? AND ts < ? AND author_id IN (SELECT self_identity FROM account WHERE self_identity IS NOT NULL) LIMIT 1`,
      c.id,
      m.ts - 30 * 60_000,
      m.ts,
    );
    return {
      network: c.network,
      shape: c.shape,
      conversation: c.id,
      spaces: this.ancestors(parent ?? c.id).map((x) => x.id as string),
      author: author?.person_id ?? author?.id ?? null,
      bot: !!author?.is_bot,
      mention: !!m.mentions_self && !m.mentions_all,
      everyone: !!m.mentions_self && !!m.mentions_all,
      reply: !!repliedTo && s.isSelf(repliedTo.author_id),
      question: /\?\s*$|\?\s/.test(m.body),
      urgent: URGENT.test(m.body),
      active: !!recentSelf,
      media: m.kind === 'media' || m.kind === 'sticker',
      link: /https?:\/\//.test(m.body),
      long: m.body.length > 280,
      known: !!author?.person_id,
    };
  }

  /** Triage's own sense of how addressed to you a message is, 0 to 1, and why. */
  private addressed(f: Omit<Facts, 'base'>, c: Row): { score: number; why: string[] } {
    let score = 0.15;
    const why: string[] = [];
    if (f.mention) (score += 0.5), why.push('mentions you');
    else if (f.everyone) (score += 0.2), why.push('pings @everyone');
    if (f.reply) (score += 0.4), why.push('replies to you');
    const addressed = f.mention || f.reply || c.shape === 'direct';
    if (f.question && (addressed || c.shape === 'group')) (score += 0.15), why.push('asks a question');
    if (f.urgent) (score += 0.3), why.push('sounds time-sensitive');
    const members = this.store.one<Row>('SELECT COUNT(*) AS n FROM participant WHERE conversation_id = ?', c.id)?.n ?? 0;
    if (members && members <= 6) (score += 0.1), why.push(`small group (${members})`);
    if (f.active) (score += 0.25), why.push("you're active here");
    if (c.variant === 'announcement') (score -= 0.1), why.push('announcement channel');
    return { score: Math.round(Math.max(0, Math.min(1, score)) * 100) / 100, why };
  }

  /**
   * Behind DITHER_ACTIVITY_FEATURES: what the activity log says about this place becomes a reason, and the features
   * go with the decision so the model's training sees what was known then (docs/activity.md), interaction features
   * (interact.ts) among them. The live decision does not use them; the shadow model does.
   */
  private withActivity(d: Decision, messageId: string, now: number) {
    const a = this.activity;
    if (!a?.featuresInTriage || !a.enabled) return;
    const cid = this.store.one<Row>('SELECT conversation_id FROM message WHERE id = ?', messageId)?.conversation_id;
    const f = cid ? a.features(cid, now) : null;
    if (!f) return;
    const m = this.store.one<Row>('SELECT m.ts, COALESCE(i.person_id, m.author_id) AS author FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.id = ?', messageId);
    this.interactions ??= new InteractionLog(this.store.db);
    d.features = m ? { ...f, x: this.interactions.features(cid!, m.author, m.ts) } : f;
    const said = describeActivity(f.person ?? f.conversation);
    if (said) d.reasons.push(said);
  }

  /** Quiet hours are over and something was held: what to say about it, once. */
  takeHeldSummary(now = Date.now()): { title: string; body: string; conversationId: string; messageId: string } | null {
    const held = this.store.quietHeld();
    if (!held || inQuietHours(this.store.quietHours(), now)) return null;
    this.store.setQuietHeld(null);
    return { title: 'Quiet hours are over', body: `${held.count} message${held.count === 1 ? '' : 's'} held for you`, conversationId: held.conversationId, messageId: held.messageId };
  }

  private decideByRules(messageId: string): Decision | null {
    const s = this.store;
    const m = s.one<Row>('SELECT * FROM message WHERE id = ?', messageId);
    if (!m) return null;
    const c = s.one<Row>('SELECT * FROM conversation WHERE id = ?', m.conversation_id)!;
    const author = m.author_id ? s.one<Row>('SELECT * FROM identity WHERE id = ?', m.author_id) : null;
    const person = author?.person_id ? s.one<Row>('SELECT * FROM person WHERE id = ?', author.person_id) : null;
    const authorName = person?.name ?? author?.display_name ?? author?.handle ?? 'Someone';
    const reasons: string[] = [];

    const eff = this.effectiveLevel(c.id);
    const where = this.placeName(c);
    const title = c.shape === 'direct' ? `${where} · ${NETWORK_META[c.network as P.Network].name}` : where;
    const body = `${c.shape === 'direct' ? '' : authorName + ': '}${previewText(m.body, m.kind) || (m.kind === 'media' ? 'Sent an attachment' : '')}`;

    if (eff.level === 'none') {
      reasons.push(`Silenced: ${eff.source}`);
      return { decision: 'silent', score: null, reasons, decidedBy: 'rules', title, body };
    }
    if (requestHeld(s.db, c.id)) {
      reasons.push('A message request: it waits under Requests until you accept it');
      return { decision: 'silent', score: null, reasons, decidedBy: 'rules', title, body };
    }

    const f = this.facts(m, c, author);
    const how = this.addressed(f, c);
    const native = this.nativeLevel(c);
    const net = NETWORK_META[c.network as P.Network].name;
    const about = f.mention || f.reply || f.everyone;
    // Would the network itself have notified you? Replies to you ping on Discord, @everyone wherever mentions do. A
    // place you once set to mentions only says the same of itself.
    const mentionsOnly = eff.level === 'mentions' && !eff.native;
    const notify = mentionsOnly ? about : native === 'all' || (native === 'mentions' && about);
    // Kept to the list: your rule (List only), or muted on its network.
    const cap = eff.level === 'digest';
    // Keywords match what people typed, not mention tokens like <@123>.
    const plain = m.body.replace(/<[@#][^>]+>/g, ' ');
    const keyword = s
      .rules()
      .filter((r) => r.scope === 'keyword' && r.target && r.level === 'all')
      .find((r) => new RegExp(`\\b${r.target!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(plain));
    const personRule = person ? s.rules().find((r) => r.scope === 'person' && r.target === person.id) : null;
    const always = eff.level === 'all' && !eff.native;
    const forced = personRule?.level === 'all' || !!keyword || always;
    const facts: Facts = { ...f, base: forced ? 'push' : 'drop', score: how.score, explicit: eff.explicit, native, notify, ...(cap ? { cap } : {}) };
    const done = (decision: Level, extra: Partial<Decision> = {}): Decision => ({ decision, score: null, reasons, decidedBy: 'rules', title, body, facts, ...extra });

    if (personRule?.level === 'all') {
      reasons.push(`From ${authorName}, who is set to always alert`);
      return done('push', { alwaysNotify: true, forced: true });
    }
    if (keyword) {
      reasons.push(`Matches keyword “${keyword.target}”`);
      return done('push', { keyword: true, forced: true });
    }
    if (always) {
      reasons.push(`Always alert: ${eff.source}`);
      return done('push', { forced: true });
    }
    if (author?.is_bot) reasons.push('From a bot');
    if (cap) reasons.push(eff.native ? `Muted in ${net}: kept to the list` : `List only: ${eff.source}`);
    else if (notify) reasons.push(mentionsOnly || native !== 'all' ? (f.mention ? 'Mentions you' : f.reply ? 'Replies to your message' : 'Pings @everyone') : `${net} notifies every message here`);
    else {
      reasons.push(mentionsOnly ? `Mentions only: ${eff.source}` : native === 'none' ? `Muted in ${net}` : `${net} notifies only mentions here`);
      if (how.why.length) reasons.push(`About you: ${how.why.join(', ')}`);
    }
    // The model decides between Conversation, the list and below it (`withModel`).
    return done('drop');
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const rounded = (p: P.TriageProbs): P.TriageProbs => ({ alert: round(p.alert), important: round(p.important) });

function rank(l: P.NotifyLevel): number {
  return { none: 0, digest: 1, mentions: 2, smart: 3, all: 4 }[l];
}

export { ALERT_BAR };

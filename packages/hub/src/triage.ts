/**
 * Notification triage: where the network's own settings (or yours) put a message, then the decision model that
 * learned from your votes.
 *
 * Four levels (docs/notifications.md): Important ('push': the phone buzzes, the desktop notifies), Active ('quiet':
 * a silent notification on the phone), Digest, and below the digest ('drop'). Every decision keeps the facts it was
 * made from; the model (learn.ts, votes.ts) predicts three chances from them and the message's words (worth a ping,
 * worth a silent notification, interesting enough for the digest), starting from where the rules put it.
 *
 * Level resolution, most specific first:
 *   conversation > thread parent > containing spaces (nearest first) > account > network > global
 * With none of those set, the network's own: what Discord, Signal, WhatsApp or Matrix would notify you about
 * (its per-channel, per-category and per-server settings and mutes) is Important, the rest goes by how addressed to
 * you it is. A native mute caps the level at 'digest' unless you set a hub rule on the conversation or one of its
 * spaces. Starred people and keywords raise a message to 'push'; 'none' is absolute.
 *
 * Quiet hours come last: a push decided during them becomes a digest entry with the reason attached, and one
 * summary push goes out when they end.
 *
 * The daily digest is one notification about what was held back as digest since the last one. Quiet hours hold it
 * too: it goes out when they end, and takes the place of their summary if both are due.
 *
 * Every decision is stored with its reasons so the UI can explain it, and with its facts so your votes can be
 * learned from and every set of rules backtested against them.
 */

import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { previewText, type Store } from './store.ts';
import { describeActivity, type ActivityStore, type Features } from './activity.ts';
import { describeWeight, emptyModel, importance, levelFrom, predict, prior, TIER_NAME, words, type Facts, type Level, type Model, type Namer } from './learn.ts';
import { InteractionLog } from './interact.ts';
import { explore, exploreCounts, EXPLORE_DOWN_REASON, EXPLORE_UP_REASON } from './shadow.ts';

type Row = Record<string, any>;

export interface Decision {
  decision: P.TriageDecision;
  score: number | null;
  reasons: string[];
  decidedBy: 'rules' | 'model' | 'learned';
  title: string;
  /** What it was decided from; absent for silenced places, which are not voted on. */
  facts?: Facts;
  /** The model's three chances. */
  probs?: P.TriageProbs;
  /** A local model's chances, which stand in for the rules' as the starting point. */
  llm?: P.TriageProbs;
  body: string;
  /** From a starred person or one set to always notify: may get through quiet hours. */
  starred?: boolean;
  /** What the activity log said about this place when deciding (DITHER_ACTIVITY_FEATURES), kept for training. */
  features?: Features;
  /** Matched one of your keywords. */
  keyword?: boolean;
  /** The candidate model's chances, kept next to the live ones; it never decides (shadow.ts). */
  shadow?: P.TriageProbs;
  /** Exploration changed the decision (DITHER_TRIAGE_EXPLORE), and the chance of what was done when it drew. */
  explore?: 'up' | 'down' | null;
  propensity?: number | null;
}

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

/**
 * The local date of the latest time the digest was due. A later slot than the last one handled means it is due again,
 * so an hour lost or repeated to daylight saving, or days of downtime, still come to one digest.
 */
export function digestSlot(d: Pick<P.DailyDigest, 'time' | 'timezone'>, now: number): string {
  const { minutes } = localTime(d.timezone, now);
  const date = (at: number) => new Intl.DateTimeFormat('en-CA', { timeZone: d.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  if (minutes >= toMinutes(d.time)) return date(now);
  // Noon of the local day before: a day of 23 or 25 hours cannot move that across a date.
  return date(now - (minutes + 12 * 60) * 60_000);
}

export function validDailyDigest(d: Partial<P.DailyDigest>): d is P.DailyDigest {
  return validQuietHours({ start: d.time, end: d.time, timezone: d.timezone });
}

export const URGENT = /\b(urgent|asap|emergency|right now|call me|help!|deadline|today|tonight|are you (around|there|free))\b/i;
/** Smart places: at or above this score Important, at or above `SMART_ACTIVE` Active, else Digest. */
const SMART_THRESHOLD = 0.55;
const SMART_ACTIVE = 0.3;
const smartTier = (score: number): Level => (score >= SMART_THRESHOLD ? 'push' : score >= SMART_ACTIVE ? 'quiet' : 'digest');

export class Triage {
  /** What your votes taught (votes.ts keeps it). */
  learned: Model = emptyModel();
  /** Names places and people, for reasons in words (votes.ts). */
  namer: Namer | null = null;
  /** The local model's prompt as last written from it; null for the built-in one. */
  prompt: string | null = null;
  /** The candidate model, run in shadow (votes.ts keeps it). */
  candidate: Model | null = null;
  /** Silent exploration (shadow.ts), off unless DITHER_TRIAGE_EXPLORE is 1 (both ways) or `up` (only upward). */
  exploring: boolean | 'up' = process.env.DITHER_TRIAGE_EXPLORE === '1' || (process.env.DITHER_TRIAGE_EXPLORE === 'up' && 'up');
  /** The draw for exploration; tests replace it. */
  rng: () => number = Math.random;
  /**
   * Content features of a message (embeddings.ts: `emb`, `knn`, `jev:<q>`), when DITHER_EMBEDDINGS is on. Like the
   * interaction features, only the shadow model weighs them.
   */
  content: ((messageId: string) => Record<string, number>) | null = null;
  private interactions: InteractionLog | null = null;

  constructor(
    private store: Store,
    readonly model?: { url: string; name: string },
    private activity?: ActivityStore,
  ) {}

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
    const rules = new Map(s.rules().map((r) => [`${r.scope}:${r.target ?? ''}`, r.level]));
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
      // Nothing set: as the network has it, every message, mentions only, or muted (held for the digest).
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
    const d = await this.decideByRules(messageId);
    if (d) this.withActivity(d, messageId, now);
    if (d?.facts) {
      const ws = words(this.store.one<Row>('SELECT body FROM message WHERE id = ?', messageId)?.body ?? '');
      this.withModel(d, d.facts, ws, d.llm);
      const content = this.content?.(messageId);
      if (content && Object.keys(content).length && d.features) d.features.x = { ...d.features.x, ...content };
      const x = d.features?.x ?? content;
      if (this.candidate) d.shadow = rounded(predict(this.candidate, d.facts, ws, d.llm, x).probs);
      if (this.exploring) this.withExploration(d, messageId, now);
    }
    if (d?.decision !== 'push' && d?.decision !== 'quiet') return d;
    const q = this.store.quietHours();
    if (!inQuietHours(q, now) || (q!.allowStarred && d.starred)) return d;
    d.decision = 'digest';
    d.reasons.unshift(`Held by quiet hours until ${q!.end}`);
    const held = this.store.quietHeld();
    const conversationId = this.store.one<Row>('SELECT conversation_id FROM message WHERE id = ?', messageId)!.conversation_id;
    this.store.setQuietHeld({ count: (held?.count ?? 0) + 1, conversationId, messageId });
    return d;
  }

  /**
   * The model's three chances, from where the rules put it plus what your votes taught. Below the digest when not
   * even interesting enough for it; moved by your votes, it says by what.
   */
  private withModel(d: Decision, f: Facts, ws: string[], llm?: P.TriageProbs) {
    const p = predict(this.learned, f, ws, llm);
    d.probs = rounded(p.probs);
    d.score = importance(p.probs);
    const before = llm ? levelFrom(llm) : levelFrom(prior(f));
    if (p.level !== before) {
      const n = this.namer;
      const why = n ? p.why.slice(0, 2).map((w) => describeWeight(w.feature, w.head, w.by, n)) : [];
      d.reasons.unshift(`${TIER_NAME[p.level]}, learned from your votes (was ${TIER_NAME[before]})`, ...why);
      d.decidedBy = 'learned';
    } else if (p.level === 'drop') d.reasons.unshift(`Not interesting enough for the digest (${Math.round(p.probs.interesting * 100)}%)`);
    d.decision = p.level;
  }

  /** Where the rules put a stored message, with its facts, before the model and quiet hours: for the replay. */
  rulesFor(messageId: string): Promise<Decision | null> {
    return this.decideByRules(messageId);
  }

  /**
   * Silent exploration (shadow.ts): maybe try a message just under Active as Active, or hold an Important one in a
   * busy conversation to Active. Logs what it did and with what chance.
   */
  private withExploration(d: Decision, messageId: string, now: number) {
    const s = this.store;
    const m = s.one<Row>('SELECT m.conversation_id, m.ts, c.shape FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE m.id = ?', messageId);
    if (!m || !d.facts || !d.probs || !isLevel(d.decision)) return;
    const counts = exploreCounts(s.db, m.conversation_id, m.shape, m.ts, now);
    const e = explore({ upOnly: this.exploring === 'up', level: d.decision, probs: d.probs, shadow: d.shadow, facts: d.facts, starred: !!d.starred, keyword: !!d.keyword, quietHours: inQuietHours(s.quietHours(), now), ...counts }, this.rng);
    d.propensity = e.propensity;
    if (!e.explore) return;
    d.decision = e.level;
    d.explore = e.explore;
    d.reasons.unshift(e.explore === 'up' ? EXPLORE_UP_REASON : EXPLORE_DOWN_REASON);
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

  /** Save the setting. Neither turning it on nor moving the time sends anything at once, or a second one on the same day. */
  setDailyDigest(d: P.DailyDigest, now = Date.now()) {
    const s = this.store;
    const was = s.dailyDigest();
    const st = s.digestState();
    s.setDailyDigest(d);
    if (!d.enabled) return;
    const slot = digestSlot(d, now);
    // What piled up while it was off is not news.
    s.setDigestState({ slot: st && st.slot > slot ? st.slot : slot, since: was?.enabled && st ? st.since : now });
  }

  /** The digest, if one is due now and has anything to say. Handled once per slot, sent or not, so a crash loses one rather than repeating it. */
  takeDailyDigest(now = Date.now()): { title: string; body: string } | null {
    const s = this.store;
    const d = s.dailyDigest();
    const st = s.digestState();
    if (!d?.enabled || !st || inQuietHours(s.quietHours(), now)) return null;
    const slot = digestSlot(d, now);
    if (slot <= st.slot) return null;
    s.setDigestState({ slot, since: now });
    const convs = s.digestSummary(st.since, now);
    if (!convs.length) return null;
    const total = convs.reduce((n, c) => n + c.count, 0);
    const top = convs.slice(0, 3).map((c) => `${this.placeName(s.one<Row>('SELECT * FROM conversation WHERE id = ?', c.id)!)} (${c.count})`);
    const more = convs.length - top.length;
    const held = s.quietHeld();
    // Held messages are digest entries, so this already counts them: no separate summary on top.
    if (held) s.setQuietHeld(null);
    return {
      title: `Daily digest: ${total} message${total === 1 ? '' : 's'}`,
      body: `${top.join(', ')}${more ? `, and ${more} more place${more === 1 ? '' : 's'}` : ''}.${held ? ` Includes ${held.count} held by quiet hours.` : ''}`,
    };
  }

  private async decideByRules(messageId: string): Promise<Decision | null> {
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
    const done = (decision: P.TriageDecision, decidedBy: Decision['decidedBy'] = 'rules'): Decision => ({
      decision,
      score: null,
      reasons,
      decidedBy,
      title,
      body,
      ...(decision !== 'silent' ? { facts: { ...f, base: decision as Level, score: how.score, explicit: eff.explicit, native, notify } } : {}),
    });

    if (eff.level === 'none') {
      reasons.push(`Silenced: ${eff.source}`);
      return done('silent');
    }

    const f = this.facts(m, c, author);
    const how = this.addressed(f, c);
    const native = this.nativeLevel(c);
    const net = NETWORK_META[c.network as P.Network].name;
    // Would the network itself have notified you? Replies to you ping on Discord, @everyone wherever mentions do.
    const notify = native === 'all' || (native === 'mentions' && (f.mention || f.reply || f.everyone));
    const replyToSelf = f.reply;
    const mention = !!m.mentions_self;
    // Keywords match what people typed, not mention tokens like <@123>.
    const plain = m.body.replace(/<[@#][^>]+>/g, ' ');
    const keyword = s
      .rules()
      .filter((r) => r.scope === 'keyword' && r.target && r.level !== 'none' && r.level !== 'digest')
      .find((r) => new RegExp(`\\b${r.target!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(plain));
    const personRule = person ? s.rules().find((r) => r.scope === 'person' && r.target === person.id) : null;

    if (person?.starred || personRule?.level === 'all') {
      reasons.push(`From ${authorName}, who is starred`);
      return { ...done('push'), starred: true };
    }
    if (keyword) {
      reasons.push(`Matches keyword “${keyword.target}”`);
      return { ...done('push'), keyword: true };
    }
    if (author?.is_bot && eff.level !== 'all' && !mention) {
      reasons.push('From a bot');
      return done('digest');
    }

    // Nothing set here by you: what the network itself would do.
    if (eff.native) {
      if (notify) {
        reasons.push(native === 'all' ? `${net} notifies every message here` : f.mention ? 'Mentions you' : f.reply ? 'Replies to your message' : 'Pings @everyone');
        return done('push');
      }
      reasons.push(native === 'none' ? `Muted in ${net}` : `${net} notifies only mentions here`);
      if (how.why.length) reasons.push(`Interesting: ${how.why.join(', ')}`);
      return done('digest');
    }

    switch (eff.level) {
      case 'all':
        reasons.push(`Notify on every message: ${eff.source}`);
        return done('push');
      case 'digest':
        reasons.push(`Digest only: ${eff.source}`);
        if (mention) reasons.push('Mentions you, but this place is digest-only');
        return done('digest');
      case 'mentions':
        if (f.mention) reasons.push('Mentions you');
        if (replyToSelf) reasons.push('Replies to your message');
        if (f.mention || replyToSelf) return done('push');
        // @everyone reaches you, but it is not about you: a silent one.
        if (f.everyone) {
          reasons.push('Pings @everyone');
          return done('quiet');
        }
        reasons.push(`Mentions only: ${eff.source}`);
        return done('digest');
      case 'smart': {
        const llm = this.model ? await this.askModel(m, c, authorName, where).catch(() => null) : null;
        if (llm) {
          reasons.push(`Model: ${llm.reason}`);
          return { ...done(levelFrom(llm.probs), 'model'), llm: llm.probs };
        }
        reasons.push(how.why.length ? `Smart: ${how.why.join(', ')}` : 'Smart: nothing addressed to you');
        return done(smartTier(how.score));
      }
    }
    return done('digest');
  }

  /**
   * Optional local model (Ollama). Its instructions are written from the rules your votes taught (votes.ts), with the
   * votes they still get wrong as examples; then the place's recent messages.
   */
  private async askModel(m: Row, c: Row, author: string, where: string): Promise<{ probs: P.TriageProbs; reason: string } | null> {
    const s = this.store;
    const context = s
      .raw<Row>(
        `SELECT m.body, COALESCE(p.name, i.display_name, i.handle) AS who FROM message m LEFT JOIN identity i ON i.id = m.author_id
         LEFT JOIN person p ON p.id = i.person_id WHERE m.conversation_id = ? AND m.ts <= ? ORDER BY m.ts DESC LIMIT 8`,
        c.id,
        m.ts,
      )
      .reverse()
      .map((r) => `${r.who}: ${previewText(r.body, 'text')}`)
      .join('\n');
    const prompt = `${this.prompt ?? DEFAULT_PROMPT}

Place: ${where}. Author: ${author}.
Recent messages:
${context}
Reply with JSON {"ping": 0-1, "active": 0-1, "interesting": 0-1, "reason": "<8 words"} for the last message.`;
    const res = await fetch(`${this.model!.url}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: this.model!.name, prompt, stream: false, format: 'json' }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const out = JSON.parse(((await res.json()) as any).response);
    const chance = (x: unknown) => (typeof x === 'number' && x >= 0 && x <= 1 ? Math.min(0.99, Math.max(0.01, x)) : null);
    const [ping, active, interesting] = [chance(out.ping), chance(out.active), chance(out.interesting)];
    if (ping === null || active === null || interesting === null) return null;
    return { probs: { ping, active: Math.max(active, ping), interesting: Math.max(interesting, active, ping) }, reason: String(out.reason ?? '').slice(0, 80) };
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const rounded = (p: P.TriageProbs): P.TriageProbs => ({ ping: round(p.ping), active: round(p.active), interesting: round(p.interesting) });
const isLevel = (d: P.TriageDecision): d is Level => d !== 'silent';

const DEFAULT_PROMPT = `You read incoming chat messages for one person and answer three questions about each, as chances from 0 to 1:
- ping: should their phone buzz and their computer show a notification? For what they would drop things for.
- active: is it worth at least a silent notification on their phone, to see soon?
- interesting: is it worth reading later in their digest at all?`;

function rank(l: P.NotifyLevel): number {
  return { none: 0, digest: 1, mentions: 2, smart: 3, all: 4 }[l];
}

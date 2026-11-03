/**
 * Notification triage: rules first, then a score for 'smart' conversations.
 *
 * Level resolution, most specific first:
 *   conversation > thread parent > containing spaces (nearest first) > account > network > global > default by shape
 * A native mute (set in Discord / Element / Signal) caps the level at 'digest'
 * unless the user set a hub rule on the conversation or one of its spaces.
 * Starred people and keywords can raise a message to 'push'; 'none' is absolute.
 *
 * Quiet hours come last: a push decided during them becomes a digest entry with the reason attached, and one
 * summary push goes out when they end.
 *
 * The daily digest is one notification about what was held back as digest since the last one. Quiet hours hold it
 * too: it goes out when they end, and takes the place of their summary if both are due.
 *
 * Every decision is stored with its reasons so the UI can explain it and the
 * user's corrections can become few-shot examples for a local model.
 */

import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { previewText, type Store } from './store.ts';
import { describeActivity, type ActivityStore, type Features } from './activity.ts';

type Row = Record<string, any>;

export interface Decision {
  decision: P.TriageDecision;
  score: number | null;
  reasons: string[];
  decidedBy: 'rules' | 'model';
  title: string;
  body: string;
  /** From a starred person or one set to always notify: may get through quiet hours. */
  starred?: boolean;
  /** What the activity log said about this place when deciding (DITHER_ACTIVITY_FEATURES), kept for training. */
  features?: Features;
}

export const DEFAULT_LEVEL: Record<P.Shape, P.NotifyLevel> = {
  direct: 'all',
  group: 'smart',
  channel: 'mentions',
  thread: 'mentions',
  self: 'none',
};

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

const URGENT = /\b(urgent|asap|emergency|right now|call me|help!|deadline|today|tonight|are you (around|there|free))\b/i;
const SMART_THRESHOLD = 0.55;

export class Triage {
  constructor(
    private store: Store,
    private model?: { url: string; name: string },
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

  private communityOf(spaceId: string): Row | null {
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
  effectiveLevel(conversationId: string): { level: P.NotifyLevel; source: string; explicit: boolean } {
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
      return { level: DEFAULT_LEVEL[c.shape as P.Shape] ?? 'mentions', source: `default for ${c.shape}s` };
    })();
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

  async decide(messageId: string, now = Date.now()): Promise<Decision | null> {
    const d = await this.decideByRules(messageId);
    if (d) this.withActivity(d, messageId, now);
    if (d?.decision !== 'push') return d;
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
   * Behind DITHER_ACTIVITY_FEATURES: what the activity log says about this place becomes a reason, and the features
   * go with the decision so the model's training sees what was known then (docs/activity.md). The decision itself
   * does not change yet.
   */
  private withActivity(d: Decision, messageId: string, now: number) {
    const a = this.activity;
    if (!a?.featuresInTriage || !a.enabled) return;
    const cid = this.store.one<Row>('SELECT conversation_id FROM message WHERE id = ?', messageId)?.conversation_id;
    const f = cid ? a.features(cid, now) : null;
    if (!f) return;
    d.features = f;
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
    const done = (decision: P.TriageDecision, score: number | null = null, decidedBy: Decision['decidedBy'] = 'rules'): Decision => ({
      decision,
      score,
      reasons,
      decidedBy,
      title,
      body,
    });

    if (eff.level === 'none') {
      reasons.push(`Silenced: ${eff.source}`);
      return done('silent');
    }

    const repliedTo = m.reply_to_id ? s.one<Row>('SELECT author_id FROM message WHERE id = ?', m.reply_to_id) : null;
    const replyToSelf = !!repliedTo && s.isSelf(repliedTo.author_id);
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
      return done('push');
    }
    if (author?.is_bot && eff.level !== 'all' && !mention) {
      reasons.push('From a bot');
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
        if (mention) reasons.push('Mentions you');
        if (replyToSelf) reasons.push('Replies to your message');
        if (mention || replyToSelf) return done('push');
        reasons.push(`Mentions only: ${eff.source}`);
        return done('digest');
      case 'smart': {
        let score = 0.15;
        const why: string[] = [];
        if (mention) (score += 0.5), why.push('mentions you');
        if (replyToSelf) (score += 0.4), why.push('replies to you');
        const addressed = mention || replyToSelf || c.shape === 'direct';
        if (/\?\s*$|\?\s/.test(m.body) && (addressed || c.shape === 'group')) (score += 0.15), why.push('asks a question');
        if (URGENT.test(m.body)) (score += 0.3), why.push('sounds time-sensitive');
        const members = s.one<Row>('SELECT COUNT(*) AS n FROM participant WHERE conversation_id = ?', c.id)?.n ?? 0;
        if (members && members <= 6) (score += 0.1), why.push(`small group (${members})`);
        const recentSelf = s.one<Row>(
          `SELECT 1 FROM message WHERE conversation_id = ? AND ts > ? AND author_id IN (SELECT self_identity FROM account WHERE self_identity IS NOT NULL) LIMIT 1`,
          c.id,
          m.ts - 30 * 60_000,
        );
        if (recentSelf) (score += 0.25), why.push("you're active here");
        if (c.variant === 'announcement') (score -= 0.1), why.push('announcement channel');
        score = Math.max(0, Math.min(1, score));

        const llm = this.model ? await this.askModel(m, c, authorName, where).catch(() => null) : null;
        if (llm) {
          reasons.push(`Model: ${llm.reason}`);
          return done(llm.score >= SMART_THRESHOLD ? 'push' : 'digest', llm.score, 'model');
        }
        reasons.push(why.length ? `Smart: ${why.join(', ')}` : 'Smart: nothing addressed to you');
        return done(score >= SMART_THRESHOLD ? 'push' : 'digest', Math.round(score * 100) / 100);
      }
    }
    return done('digest');
  }

  /** Optional local model (Ollama). Recent context plus the user's corrections as few-shot examples. */
  private async askModel(m: Row, c: Row, author: string, where: string): Promise<{ score: number; reason: string } | null> {
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
    const examples = s
      .raw<Row>(`SELECT m.body, t.feedback FROM triage t JOIN message m ON m.id = t.message_id WHERE t.feedback IS NOT NULL ORDER BY t.created_at DESC LIMIT 6`)
      .map((r) => `- "${previewText(r.body, 'text')}" -> ${r.feedback === 'should_push' ? 'notify' : 'do not notify'}`)
      .join('\n');
    const prompt = `You decide whether a chat message should interrupt the user with a phone notification.
Place: ${where}. Author: ${author}.
Recent messages:
${context}
${examples ? `The user corrected these before:\n${examples}\n` : ''}Reply with JSON {"score": 0..1, "reason": "<8 words"} for the last message.`;
    const res = await fetch(`${this.model!.url}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: this.model!.name, prompt, stream: false, format: 'json' }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const out = JSON.parse(((await res.json()) as any).response);
    if (typeof out.score !== 'number') return null;
    return { score: out.score, reason: String(out.reason ?? '').slice(0, 80) };
  }
}

function rank(l: P.NotifyLevel): number {
  return { none: 0, digest: 1, mentions: 2, smart: 3, all: 4 }[l];
}

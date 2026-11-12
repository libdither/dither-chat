import type { Store } from './store.ts';
import { previewText } from './store.ts';
import type { Triage } from './triage.ts';

type Row = Record<string, any>;
/** The tiers that reach a device: an alert, a Conversation, the list. */
type Level = 'push' | 'quiet' | 'digest';
const ORDER: Record<Level, number> = { digest: 0, quiet: 1, push: 2 };

/** A burst: messages less than this apart make one notification that buzzes once. */
export const BURST_MS = 5 * 60_000;
/** A chat's row in the phone's list is brought up to date at most this often: a busy channel is one row, not a stream of pushes. */
export const LIST_EVERY = 10 * 60_000;
/** Someone using a page on a computer this recently: a phone buzz adds nothing. */
export const ACTIVE_MS = 2 * 60_000;
const LINES = 6;
const BODY = 200;
/** A push carries about 4 KB, encrypted; what goes in stays under this. */
const BUDGET = 3500;
/**
 * A notification nobody read for this long is not followed any more. Rows stay in the phone's shade for days, and
 * reading one then still takes it away.
 */
export const FORGET_MS = 3 * 24 * 3_600_000;
const PHONE = /android|iphone|ipad|\bios\b/i;

export interface Line {
  author: string;
  key: string;
  body: string;
  ts: number;
}

/** What a push about a message carries besides its title and body (docs/notifications.md, "One per conversation"). */
export interface Grouped {
  alert: boolean;
  /**
   * The highest tier among the lines it shows: the row's tier. A list message in a chat whose unread alert or
   * Conversation message is still showing updates that row, it does not turn it into a list row.
   */
  tier?: Level;
  count: number;
  conv: { title: string; shape: 'direct' | 'group' | 'channel'; icon?: string };
  sender: { name: string; key: string; icon?: string };
  lines: Line[];
  icons: Record<string, string>;
}

interface Showing {
  /** When the last push about it went out, and the newest message it showed. */
  at: number;
  ts: number;
  /** The highest tier in this burst: a rise to an alert sounds again. */
  top: Level;
}

/**
 * Delivery is per conversation, while triage stays per message: each conversation has one notification on a device,
 * updated as messages come. Only an alert sounds: on the first one after a quiet spell, when the tier rises to an
 * alert, or for one to you; every other update changes the row silently. Reading the conversation anywhere takes it
 * off the phones.
 */
/** Threads that are not chat conversations (mail/triage.ts): their lines, and when they were read. */
export interface OtherThreads {
  gather(id: string, messageId: string): Omit<Grouped, 'alert'> | null;
  /** Read up to this time (the newest shown at or before it counts as read); null: not one of its own. */
  readTs(id: string): number | null;
}

export class Delivery {
  private showing = new Map<string, Showing>();
  /** Mail threads (mail/triage.ts). */
  other: OtherThreads | null = null;

  constructor(
    private store: Store,
    private triage: Triage,
  ) {}

  /**
   * After a restart: what went out lately and may still be showing, from the activity log's notifications, so reading
   * those chats still takes them off the phones. Without the log (activity off) nothing is known, as before.
   */
  restore(now = Date.now()): number {
    const rows = this.store.raw<Row>(
      `SELECT n.conversation_id AS cid, MAX(n.sent_at) AS at, MAX(m.ts) AS ts, MAX(CASE t.decision WHEN 'push' THEN 2 WHEN 'quiet' THEN 1 ELSE 0 END) AS top
       FROM notification n JOIN message m ON m.id = n.message_id LEFT JOIN triage t ON t.message_id = n.message_id
       WHERE n.kind = 'message' AND n.conversation_id IS NOT NULL AND n.sent_at > ? GROUP BY n.conversation_id`,
      now - FORGET_MS,
    );
    const tops: Level[] = ['digest', 'quiet', 'push'];
    for (const r of rows) if (!this.showing.has(r.cid)) this.showing.set(r.cid, { at: r.at, ts: r.ts, top: tops[r.top ?? 0] });
    return rows.length;
  }

  /** The rule alone, for one message in one conversation. */
  static alert(prev: Showing | undefined, level: Level, addressed: boolean, now: number): boolean {
    if (level !== 'push') return false;
    if (!prev || now - prev.at >= BURST_MS) return true;
    return prev.top !== 'push' || addressed;
  }

  /** May a list row for this conversation go out now? Not when one went out in the last `LIST_EVERY`. */
  listDue(conversationId: string, now = Date.now()): boolean {
    const prev = this.showing.get(conversationId);
    return !prev || now - prev.at >= LIST_EVERY;
  }

  /** Decide whether this push sounds, note it as showing, and gather what the devices draw. */
  plan(conversationId: string, messageId: string, level: Level, addressed: boolean, now = Date.now()): Grouped | null {
    const prev = this.showing.get(conversationId);
    const fresh = prev && now - prev.at < BURST_MS ? prev : undefined;
    const alert = Delivery.alert(fresh, level, addressed, now) && !this.elsewhere(now);
    const g = this.gather(conversationId, messageId);
    if (!g) return null;
    const ts = g.lines.at(-1)?.ts ?? now;
    this.showing.set(conversationId, { at: now, ts: Math.max(ts, prev?.ts ?? 0), top: fresh && ORDER[fresh.top] > ORDER[level] ? fresh.top : level });
    return { ...g, alert };
  }

  /** Someone is at a computer with the app in use. Phones pass this way only while their app is open, which suppresses anyway. */
  private elsewhere(now: number): boolean {
    const rows = this.store.raw<Row>('SELECT device_label FROM visit WHERE end_at >= ? AND active > 0 AND closed = 0', now - ACTIVE_MS);
    return rows.some((r) => !PHONE.test(r.device_label ?? ''));
  }

  /**
   * Conversations read since their notification went out: on any device, in the app or in the network's own client
   * (its read receipt for you), or by writing there. Each is returned once and forgotten.
   */
  read(now = Date.now()): string[] {
    const out: string[] = [];
    for (const [cid, s] of this.showing) {
      const ts = this.other?.readTs(cid) ?? this.store.one<Row>(`SELECT MAX(last_read_ts) AS ts FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`, cid)?.ts;
      if ((ts ?? 0) >= s.ts) out.push(cid);
      else if (now - s.at > FORGET_MS) this.showing.delete(cid);
    }
    for (const cid of out) this.showing.delete(cid);
    return out;
  }

  /** The conversation's unread lines from others, oldest first and ending with this message, within the push's budget. */
  gather(conversationId: string, messageId: string): Omit<Grouped, 'alert'> | null {
    const s = this.store;
    const c = s.one<Row>('SELECT * FROM conversation WHERE id = ?', conversationId);
    if (!c) return this.other?.gather(conversationId, messageId) ?? null;
    const m = s.one<Row>('SELECT ts FROM message WHERE id = ?', messageId);
    if (!m) return null;
    const via = s.vantageAccounts('conversation', c.id)[0] ?? null;
    const readTs = s.one<Row>(`SELECT MAX(last_read_ts) AS ts, MAX(unread) AS unread FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`, c.id);
    const rows = s.raw<Row>(
      `SELECT m.id, m.ts, m.body, m.kind, m.deleted, m.author_id, i.display_name, i.handle, i.avatar_url, i.seen_via, i.person_id,
              p.name AS person_name, p.avatar_url AS person_avatar, t.decision
       FROM message m LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN person p ON p.id = i.person_id LEFT JOIN triage t ON t.message_id = m.id
       WHERE m.conversation_id = ? AND m.ts <= ? ORDER BY m.ts DESC, m.id DESC LIMIT 40`,
      c.id,
      m.ts,
    );
    const lines: Line[] = [];
    const icons: Record<string, string> = {};
    let sender: Grouped['sender'] | null = null;
    let others = 0;
    let top: Level | null = null;
    for (const r of rows) {
      const own = r.id === messageId;
      // Lines start after your last read or your last word here, whichever is later.
      if (!own && (s.isSelf(r.author_id) || r.ts <= (readTs?.ts ?? 0))) break;
      if (r.deleted) continue;
      others++;
      if (!own && !['push', 'quiet', 'digest'].includes(r.decision)) continue;
      if (r.decision in ORDER && (!top || ORDER[r.decision as Level] > ORDER[top])) top = r.decision as Level;
      if (lines.length >= LINES && !own) continue;
      const key = r.person_id ?? r.author_id ?? 'someone';
      const author = r.person_name ?? r.display_name ?? r.handle ?? 'Someone';
      const body = (previewText(r.body, r.kind) || (r.kind === 'media' ? 'Sent an attachment' : '')).slice(0, BODY);
      lines.push({ author, key, body, ts: r.ts });
      const icon = r.avatar_url ? s.media(r.avatar_url, r.seen_via ?? via) : r.person_avatar ? s.media(r.person_avatar, null) : null;
      if (icon && small(icon)) icons[key] ??= icon;
      if (own) sender = { name: author, key, ...(icons[key] ? { icon: icons[key] } : {}) };
    }
    if (!sender) return null;
    lines.reverse();
    const shape = c.shape === 'direct' ? 'direct' : c.shape === 'channel' || c.shape === 'thread' ? 'channel' : 'group';
    const convIcon = shape === 'direct' ? sender.icon : this.groupIcon(c, via);
    const g: Omit<Grouped, 'alert'> = {
      count: Math.max(readTs?.unread ?? 0, others),
      conv: { title: this.triage.placeName(c), shape, ...(convIcon ? { icon: convIcon } : {}) },
      sender,
      lines,
      icons,
      ...(top ? { tier: top } : {}),
    };
    return fit(g);
  }

  /** A group's own picture; a channel's is its server's. */
  private groupIcon(c: Row, via: string | null): string | undefined {
    const s = this.store;
    let raw: string | null = c.avatar_url;
    if (!raw && (c.shape === 'channel' || c.shape === 'thread')) {
      const parent = c.shape === 'thread' && c.parent_id ? c.parent_id : c.id;
      const sp = this.triage.ancestors(parent)[0];
      raw = (sp ? this.triage.communityOf(sp.id) : null)?.icon_url ?? null;
    }
    const icon = raw ? s.media(raw, via) : null;
    return icon && small(icon) ? icon : undefined;
  }
}

/** An inline picture only goes when it is small; links always do. */
const small = (icon: string) => !icon.startsWith('data:') || icon.length < 1500;

/** Under the budget: first the oldest lines go, then the pictures. */
export function fit<T extends Omit<Grouped, 'alert'>>(g: T): T {
  const size = () => JSON.stringify(g).length;
  while (size() > BUDGET && g.lines.length > 1) {
    const gone = g.lines.shift()!;
    if (!g.lines.some((l) => l.key === gone.key)) delete g.icons[gone.key];
  }
  if (size() > BUDGET) g.icons = {};
  if (size() > BUDGET) delete g.conv.icon;
  return g;
}

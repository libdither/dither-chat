import type { Store } from './store.ts';
import { previewText } from './store.ts';
import type { Triage } from './triage.ts';

type Row = Record<string, any>;
type Level = 'push' | 'quiet';

/** A burst: messages less than this apart make one notification that buzzes once. */
export const BURST_MS = 5 * 60_000;
/** Someone using a page on a computer this recently: a phone buzz adds nothing. */
export const ACTIVE_MS = 2 * 60_000;
const LINES = 6;
const BODY = 200;
/** A push carries about 4 KB, encrypted; what goes in stays under this. */
const BUDGET = 3500;
/** A notification nobody read for a day is not followed any more. */
const FORGET_MS = 24 * 3_600_000;
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
  /** The highest level in this burst: a rise to Important buzzes again. */
  top: Level;
}

/**
 * Delivery is per conversation, while triage stays per message: each conversation has one notification on a device,
 * updated as messages come. It buzzes on the first message after a quiet spell, when the level rises from Active to
 * Important, or for a message to you; every other update changes it silently. Reading the conversation anywhere
 * takes it off the phones.
 */
export class Delivery {
  private showing = new Map<string, Showing>();

  constructor(
    private store: Store,
    private triage: Triage,
  ) {}

  /** The rule alone, for one message in one conversation. */
  static alert(prev: Showing | undefined, level: Level, addressed: boolean, now: number): boolean {
    if (level === 'quiet') return false;
    if (!prev || now - prev.at >= BURST_MS) return true;
    return prev.top !== 'push' || addressed;
  }

  /** Decide whether this push buzzes, note it as showing, and gather what the devices draw. */
  plan(conversationId: string, messageId: string, level: Level, addressed: boolean, now = Date.now()): Grouped | null {
    const prev = this.showing.get(conversationId);
    const fresh = prev && now - prev.at < BURST_MS ? prev : undefined;
    const alert = Delivery.alert(fresh, level, addressed, now) && !this.elsewhere(now);
    const g = this.gather(conversationId, messageId);
    if (!g) return null;
    const ts = g.lines.at(-1)?.ts ?? now;
    this.showing.set(conversationId, { at: now, ts: Math.max(ts, prev?.ts ?? 0), top: fresh?.top === 'push' || level === 'push' ? 'push' : 'quiet' });
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
      const r = this.store.one<Row>(`SELECT MAX(last_read_ts) AS ts FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`, cid);
      if ((r?.ts ?? 0) >= s.ts) out.push(cid);
      else if (now - s.at > FORGET_MS) this.showing.delete(cid);
    }
    for (const cid of out) this.showing.delete(cid);
    return out;
  }

  /** The conversation's unread lines from others, oldest first and ending with this message, within the push's budget. */
  gather(conversationId: string, messageId: string): Omit<Grouped, 'alert'> | null {
    const s = this.store;
    const c = s.one<Row>('SELECT * FROM conversation WHERE id = ?', conversationId);
    const m = s.one<Row>('SELECT ts FROM message WHERE id = ?', messageId);
    if (!c || !m) return null;
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
    for (const r of rows) {
      const own = r.id === messageId;
      // Lines start after your last read or your last word here, whichever is later.
      if (!own && (s.isSelf(r.author_id) || r.ts <= (readTs?.ts ?? 0))) break;
      if (r.deleted) continue;
      others++;
      if (!own && !['push', 'quiet', 'digest'].includes(r.decision)) continue;
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
function fit<T extends Omit<Grouped, 'alert'>>(g: T): T {
  const size = () => JSON.stringify(g).length;
  while (size() > BUDGET && g.lines.length > 1) {
    const gone = g.lines.shift()!;
    if (!g.lines.some((l) => l.key === gone.key)) delete g.icons[gone.key];
  }
  if (size() > BUDGET) g.icons = {};
  if (size() > BUDGET) delete g.conv.icon;
  return g;
}

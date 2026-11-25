/**
 * Where and how you came across a message (docs/notifications.md, "Where you saw it"), for the Notification
 * calibration page: the notification that carried it, as the hub composed it (activity.ts `composed`), each device it
 * went to and what that device said of it (shown where, sounded or not, locked, what else was showing beside it), the
 * push it skipped, the first time you opened its chat and from which list, and For you's serving of it. What the log
 * does not say is said too, in words, rather than guessed.
 *
 * Everything here is read from the hub's own database; nothing is sent anywhere.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { PHONE } from './delivery.ts';

type Row = Record<string, any>;
const MIN = 60_000;

/** A visit counts as finding the message when it starts at most this long before it came (a chat already open). */
const OPEN_SLACK = 2 * MIN;

const parse = <T>(s: unknown): T | null => {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

const hasTable = (db: Database, name: string) => !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

/** The notification that carried a message: its own, else a later one of its chat whose lines show it. */
function carrier(db: Database, messageId: string, conversationId: string | null, ts: number): Row | null {
  const own = db.query('SELECT * FROM notification WHERE message_id = ? ORDER BY sent_at LIMIT 1').get(messageId) as Row | null;
  if (own || !conversationId) return own;
  // A line in a later push of the same chat (one notification per conversation): the first whose lines reach it.
  const later = db.query('SELECT * FROM notification WHERE conversation_id = ? AND sent_at >= ? AND sent_at < ? ORDER BY sent_at LIMIT 20').all(conversationId, ts, ts + 60 * MIN) as Row[];
  return later.find((n) => (parse<P.SeenSent>(n.look)?.lines ?? []).some((l) => l.ts === ts)) ?? null;
}

/** The newest notification of a chat sent at or before `at`: what a device's `beside` tag showed then. */
function besideOf(db: Database, tags: string[], at: number, own: string | null): { title: string; body: string; at: number }[] {
  const q = db.query('SELECT title, body, look, sent_at FROM notification WHERE conversation_id = ? AND sent_at <= ? ORDER BY sent_at DESC LIMIT 1');
  const out: { title: string; body: string; at: number }[] = [];
  for (const tag of tags) {
    if (tag === own) continue;
    const n = q.get(tag, at + MIN) as Row | null;
    if (n?.title) out.push({ title: n.title, body: n.body ?? '', at: n.sent_at });
  }
  return out;
}

interface SeenRow {
  title: string;
  preview: string;
  at: number;
  network: string | null;
  shape: string | null;
  conversationId: string | null;
}

export function seenContext(db: Database, messageId: string, row: SeenRow): P.SeenContext {
  const unknown: string[] = [];
  const n = hasTable(db, 'notification') ? carrier(db, messageId, row.conversationId, row.at) : null;
  let sent: P.SeenSent | null = null;
  if (n) {
    const look = parse<{ network?: string; icon?: string; tier?: P.SeenSent['tier']; count?: number; conv?: P.SeenSent['conv']; lines?: P.SeenSent['lines'] }>(n.look);
    const events = db.query('SELECT device, event, at, seen FROM notification_event WHERE notification_id = ? ORDER BY at').all(n.id) as Row[];
    const regs = db.query('SELECT device, label, android, sounds FROM notification_device WHERE notification_id = ?').all(n.id) as Row[];
    const ids = [...new Set([...regs.map((r) => r.device as string), ...events.map((e) => e.device as string).filter(Boolean)])];
    const devices: P.SeenDevice[] = ids.map((id) => {
      const reg = regs.find((r) => r.device === id);
      const evs = events.filter((e) => e.device === id);
      const at = (k: string) => evs.find((e) => e.event === k)?.at ?? null;
      const seen = evs.map((e) => parse<P.NotificationSeen>(e.seen)).find((s) => !!s) ?? null;
      // A page's toast: the device is the page's id, named by its latest visit.
      const label = reg?.label ?? ((db.query('SELECT device_label FROM visit WHERE device = ? AND device_label IS NOT NULL ORDER BY start_at DESC LIMIT 1').get(id) as Row | null)?.device_label as string | undefined) ?? 'This app';
      const kind: P.SeenDevice['kind'] = reg ? (reg.android ? 'android' : 'browser') : 'page';
      return {
        label,
        kind,
        phone: kind === 'android' || PHONE.test(label),
        meantToSound: !!reg?.sounds,
        surface: seen?.surface ?? (at('inapp') ? 'toast' : null),
        sound: seen?.sound ?? null,
        locked: seen?.locked ?? null,
        screenOn: seen?.screenOn ?? null,
        pageOpen: seen?.pageOpen ?? null,
        delivered: at('delivered'),
        shown: at('shown') ?? at('inapp'),
        suppressed: at('suppressed'),
        tapped: at('tapped'),
        dismissed: at('dismissed'),
        beside: seen?.beside ? besideOf(db, seen.beside, n.sent_at, n.conversation_id) : null,
      };
    });
    sent = {
      at: n.sent_at,
      title: n.title ?? null,
      body: n.body ?? null,
      lines: look?.lines ?? [],
      count: look?.count ?? 1,
      conv: look?.conv ?? null,
      network: look?.network ?? row.network,
      icon: look?.icon ?? null,
      tier: look?.tier ?? (n.alert ? 'push' : 'quiet'),
      sounded: n.alert === 1,
      computerInUse: n.computer_in_use === null || n.computer_in_use === undefined ? null : !!n.computer_in_use,
      devices,
    };
    if (!sent.title) unknown.push("Its words are no longer kept with the notification, so it is drawn from the message instead.");
    if (!devices.length) unknown.push('The hub does not know which devices it reached (sent before this was kept, or no device was registered).');
    else if (!devices.some((d) => d.shown || d.suppressed || d.tapped || d.dismissed)) unknown.push("No device said it showed this, so we don't know if you saw it.");
    else if (devices.some((d) => d.shown && !d.surface)) unknown.push("A device showed it but didn't say where or whether it sounded (an app from before it was asked).");
    if (sent.computerInUse === null) unknown.push('Whether a computer was in use then was not kept.');
  }
  const skip = !n && hasTable(db, 'push_skip') ? (db.query('SELECT why FROM push_skip WHERE message_id = ? ORDER BY at LIMIT 1').get(messageId) as Row | null) : null;
  const notSent = skip?.why === 'watched' || skip?.why === 'capped' ? (skip.why as 'watched' | 'capped') : null;
  if (!n && !notSent) unknown.push('No notification went out for it: it waited in the inbox, so it only showed as a row there.');
  const v = row.conversationId
    ? (db.query('SELECT start_at, source, device_label FROM visit WHERE conversation_id = ? AND start_at >= ? ORDER BY start_at LIMIT 1').get(row.conversationId, row.at - OPEN_SLACK) as Row | null)
    : null;
  const opened = v ? { at: v.start_at as number, source: v.source as string, device: (v.device_label as string | null) ?? 'a device', phone: PHONE.test(v.device_label ?? '') } : null;
  if (!opened) unknown.push("You haven't opened its chat since, as far as the log says.");
  let forYou: P.SeenContext['forYou'] = null;
  if (hasTable(db, 'foryou_item')) {
    const f = db.query('SELECT id, position, created_at FROM foryou_item WHERE message_id = ? ORDER BY created_at LIMIT 1').get(messageId) as Row | null;
    if (f) {
      const shown = db.query(`SELECT at, ms FROM foryou_event WHERE item_id = ? AND kind = 'shown' ORDER BY at LIMIT 1`).get(f.id) as Row | null;
      forYou = { position: f.position, servedAt: f.created_at, shownAt: shown?.at ?? null, ms: shown?.ms ?? null };
    }
  }
  return { sent, notSent, opened, forYou, row: { title: row.title, preview: row.preview, at: row.at, network: row.network, shape: row.shape }, unknown };
}

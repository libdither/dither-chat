/**
 * A demo world's Notification calibration page (docs/notifications.md, "Asking, without nagging"): questions waiting
 * about the demo's own messages, each with an invented place it was seen (an Android phone's lock screen or shade, a
 * laptop's browser, the open app, or no notification at all), and a few answered ones for the numbers. Invented
 * devices, the demo's invented messages; only ever in a demo world.
 */
import type { Database } from 'bun:sqlite';
import { newId } from './checkin.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;

const PHONE = { id: 'demo_sub_phone', label: 'Android phone' };
const LAPTOP = { id: 'demo_sub_laptop', label: 'Firefox on a laptop' };

interface Scene {
  side: 'sounded' | 'quiet' | 'foryou';
  /** How long after the message the question went on the page (never later than now). */
  asked: number;
  answer?: string;
  notification?: {
    alert: boolean;
    tier: 'push' | 'quiet' | 'digest';
    computerInUse: boolean;
    devices: { sub: typeof PHONE; android: boolean; seen?: Record<string, unknown>; tapped?: number; dismissed?: number; besideN?: number }[];
  };
  skip?: 'watched' | 'capped';
  opened?: { after: number; source: string; label: string };
}

const SCENES: Scene[] = [
  { side: 'sounded', asked: 25 * MIN, notification: { alert: true, tier: 'push', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: { surface: 'heads_up', sound: 'sound', locked: false, screenOn: true }, besideN: 0 }] }, opened: { after: 3 * MIN, source: 'notification', label: 'Android phone' } },
  {
    side: 'sounded',
    asked: 25 * MIN,
    notification: {
      alert: true,
      tier: 'push',
      computerInUse: true,
      devices: [
        { sub: PHONE, android: true, seen: { surface: 'lock', sound: 'vibrate', locked: true, screenOn: false }, besideN: 2 },
        { sub: LAPTOP, android: false, seen: { surface: 'browser', sound: 'sound', pageOpen: true }, besideN: 1, dismissed: 40_000 },
      ],
    },
  },
  { side: 'quiet', asked: 25 * MIN, notification: { alert: false, tier: 'quiet', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: { surface: 'shade', sound: 'silent', locked: false, screenOn: true }, besideN: 1 }] }, opened: { after: 2 * HOUR, source: 'inbox', label: 'Firefox on a laptop' } },
  { side: 'quiet', asked: 25 * MIN, opened: { after: 40 * MIN, source: 'inbox', label: 'Android phone' } },
  { side: 'quiet', asked: 25 * MIN, skip: 'watched' },
  { side: 'sounded', asked: 25 * MIN, notification: { alert: true, tier: 'push', computerInUse: true, devices: [{ sub: LAPTOP, android: false, seen: { surface: 'browser', sound: 'sound', pageOpen: false }, besideN: 0 }] } },
  { side: 'foryou', asked: 6 * HOUR },
  // Answered, for the numbers.
  { side: 'sounded', asked: 25 * MIN, answer: 'worth' },
  { side: 'sounded', asked: 25 * MIN, answer: 'could_wait' },
  { side: 'sounded', asked: 25 * MIN, answer: 'worth' },
  { side: 'quiet', asked: 25 * MIN, answer: 'fine' },
  { side: 'quiet', asked: 25 * MIN, answer: 'sooner' },
  { side: 'sounded', asked: 25 * MIN, answer: 'shouldnt' },
];

/** Seeds once, when the demo world has messages from others to ask about. Returns whether it did. */
export function seedDemoCalibration(db: Database, now = Date.now()): boolean {
  if (db.query(`SELECT 1 FROM meta WHERE key = 'demo_calibration'`).get()) return true;
  const self = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL)`;
  // Others' messages with a decision and a loudness, in chats the demo has not notified about (each scene's
  // notification is its own), newest first, one per chat while they last.
  const ms = db
    .query(
      `SELECT m.id, m.ts, m.body, m.conversation_id, c.name, c.shape, c.network, COALESCE(p.name, i.display_name, i.handle) AS author
       FROM message m JOIN triage t ON t.message_id = m.id JOIN conversation c ON c.id = m.conversation_id
       LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN person p ON p.id = i.person_id
       WHERE m.author_id NOT IN ${self} AND t.loud_view IS NOT NULL AND m.body IS NOT NULL AND m.body != ''
         AND NOT EXISTS (SELECT 1 FROM notification n WHERE n.conversation_id = m.conversation_id)
       ORDER BY m.ts DESC LIMIT 200`,
    )
    .all() as Row[];
  const byConv = new Map<string, Row>();
  for (const m of ms) if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, m);
  const pool = [...byConv.values(), ...ms.filter((m) => byConv.get(m.conversation_id) !== m)];
  if (pool.length < SCENES.length) return false;
  db.transaction(() => {
    SCENES.forEach((sc, k) => {
      const m = pool[k];
      // The demo's messages keep their times: each scene happens when its message came.
      const at = m.ts as number;
      const direct = m.shape === 'direct';
      const title = direct ? (m.author ?? 'Direct message') : (m.name ?? 'A chat');
      const body = direct ? m.body : `${m.author ?? 'Someone'}: ${m.body}`;
      const n = sc.notification;
      if (n) {
        const nid = newId('ndemo');
        const look = { network: m.network, tier: n.tier, count: 1, conv: { title: direct ? (m.author ?? 'Direct message') : (m.name ?? 'A chat'), shape: m.shape }, lines: [{ author: m.author ?? 'Someone', body: m.body, ts: at }] };
        db.query(`INSERT INTO notification (id, kind, message_id, conversation_id, sent_at, devices, accepted, alert, title, body, look, computer_in_use) VALUES (?, 'message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          nid, m.id, m.conversation_id, at + 2000, n.devices.length, n.devices.length, +n.alert, title, body, JSON.stringify(look), +n.computerInUse,
        );
        for (const d of n.devices) {
          db.query('INSERT OR REPLACE INTO notification_device (notification_id, device, label, android, sounds, ok) VALUES (?, ?, ?, ?, ?, 1)').run(nid, d.sub.id, d.sub.label, +d.android, +n.alert);
          // What was showing beside it: the latest messages of other chats, as quiet notifications a few minutes before.
          const beside: string[] = [];
          for (const o of pool.slice(SCENES.length).filter((o) => o.conversation_id !== m.conversation_id)) {
            if (beside.length >= (d.besideN ?? 0)) break;
            if (beside.includes(o.conversation_id)) continue;
            const od = o.shape === 'direct';
            db.query(`INSERT INTO notification (id, kind, message_id, conversation_id, sent_at, devices, accepted, alert, title, body) VALUES (?, 'message', ?, ?, ?, 1, 1, 0, ?, ?)`).run(
              newId('ndemo'), o.id, o.conversation_id, at - (beside.length + 1) * 4 * MIN, od ? (o.author ?? 'Direct message') : (o.name ?? 'A chat'), od ? o.body : `${o.author ?? 'Someone'}: ${o.body}`,
            );
            beside.push(o.conversation_id);
          }
          const ev = db.query('INSERT OR IGNORE INTO notification_event (notification_id, device, event, at, seen) VALUES (?, ?, ?, ?, ?)');
          ev.run(nid, d.sub.id, 'delivered', at + 3000, null);
          ev.run(nid, d.sub.id, 'shown', at + 3500, JSON.stringify({ ...d.seen, beside }));
          if (d.tapped) ev.run(nid, d.sub.id, 'tapped', at + d.tapped, null);
          if (d.dismissed) ev.run(nid, d.sub.id, 'dismissed', at + d.dismissed, null);
        }
      }
      if (sc.skip) db.query('INSERT INTO push_skip (message_id, conversation_id, why, at) VALUES (?, ?, ?, ?)').run(m.id, m.conversation_id, sc.skip, at + 1000);
      if (sc.opened) {
        const start = Math.min(now - MIN, at + sc.opened.after);
        db.query(`INSERT INTO visit (id, device, device_label, view, conversation_id, start_at, end_at, active, source, updated_at) VALUES (?, 'demo_dev', ?, 'conversation', ?, ?, ?, 20, ?, ?)`).run(
          newId('vdemo'), sc.opened.label, m.conversation_id, start, start + 2 * MIN, sc.opened.source, now,
        );
      }
      let itemId: string | null = null;
      if (sc.side === 'foryou') {
        itemId = newId('fydemo');
        db.query(`INSERT INTO foryou_item (id, epoch, message_id, conversation_id, position, slot, propensity, created_at) VALUES (?, 'demo', ?, ?, 2, 'rank', 1, ?)`).run(itemId, m.id, m.conversation_id, at + 20 * MIN);
        db.query(`INSERT OR IGNORE INTO foryou_event (item_id, device, kind, at, ms) VALUES (?, 'demo_dev', 'shown', ?, 4200)`).run(itemId, at + 21 * MIN);
      }
      const asked = Math.min(now, at + sc.asked);
      db.query(`INSERT INTO checkin (id, side, message_id, item_id, arm, propensity, pool, created_at, answer, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('chk'), sc.side, m.id, itemId, k % 2 ? 'unsure' : 'random', k % 2 ? 0.5 : 0.1, 5, asked, sc.answer ?? null, sc.answer ? Math.min(now, asked + ((k % 3) + 1) * 3 * HOUR) : null,
      );
    });
    db.query(`INSERT INTO meta (key, value) VALUES ('demo_calibration', '1')`).run();
  })();
  return true;
}

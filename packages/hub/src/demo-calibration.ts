/**
 * A demo world's calibration feed (docs/notifications.md, "The calibration feed"): the demo's own messages, each with
 * an invented notification and an invented place it was seen (an Android phone's shade or lock screen, a laptop's
 * browser), and an invented thing you did with it. First the marks that fit the model (Should have alerted, Less like
 * this, on the demo's other messages: enough for FITTED_AT), then what the feed then shows: a sound it missed (shown
 * silently, tapped within a minute), a sound you did not want (it would have sounded; swiped away in seconds) and a
 * past answer come back; and what it keeps to itself: a silent mix-up, a notification nothing you did says anything
 * about, and a message that only sat in the inbox. Invented devices, the demo's invented messages; only in a demo world.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { FITTED_AT, newId } from './calfeed.ts';
import type { LoudLearner } from './loudlearn.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const PHONE = { id: 'demo_sub_phone', label: 'Android phone' };
const LAPTOP = { id: 'demo_sub_laptop', label: 'Firefox on a laptop' };

interface Scene {
  /** card / past: on the page; row: kept but not asked about (a mix-up, or nothing known); none: never on the feed. */
  kind: 'card' | 'row' | 'past' | 'none';
  /** The model's loudness for it, where the scene needs one band. */
  loud?: number;
  notification?: {
    alert: boolean;
    tier: 'push' | 'quiet' | 'digest';
    computerInUse: boolean;
    devices: { sub: typeof PHONE; android: boolean; seen?: Record<string, unknown>; tapped?: number; dismissed?: number; besideN?: number }[];
  };
  /** When you opened its chat, after it came (says nothing of the message itself). */
  opened?: { after: number; source: string; label: string };
}

const shade = (sound: 'sound' | 'silent' | 'vibrate', surface = 'shade', extra: Record<string, unknown> = {}) => ({ surface, sound, locked: surface === 'lock', screenOn: surface !== 'lock', ...extra });

const SCENES: Scene[] = [
  // Shown silently in the shade, tapped within a minute: a sound it missed.
  { kind: 'card', loud: 48, notification: { alert: false, tier: 'quiet', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: shade('silent'), tapped: 50_000, besideN: 2 }] } },
  // It would have sounded; on the laptop, swiped away in three seconds: a sound you did not want.
  { kind: 'card', loud: 88, notification: { alert: true, tier: 'push', computerInUse: true, devices: [{ sub: LAPTOP, android: false, seen: { surface: 'browser', sound: 'sound', pageOpen: true }, dismissed: 3000 }] } },
  // Answered a day and a half ago, an answer the model had given little chance: back once.
  { kind: 'past', loud: 20, notification: { alert: false, tier: 'quiet', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: shade('vibrate', 'lock'), tapped: 40_000, besideN: 1 }] } },
  // Shown silently, swiped away after a while: a silent mix-up, not worth a card.
  { kind: 'row', loud: 50, notification: { alert: false, tier: 'quiet', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: shade('silent'), dismissed: 20 * MIN }] } },
  // Shown silently, nothing you did says anything (the chat opened hours later is not about it).
  { kind: 'row', loud: 40, notification: { alert: false, tier: 'quiet', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: shade('silent') }] }, opened: { after: 2 * HOUR, source: 'inbox', label: 'Android phone' } },
  // Only ever in the inbox, opened later: never on the feed.
  { kind: 'none', loud: 15, opened: { after: 9 * HOUR, source: 'inbox', label: 'Android phone' } },
];

/** Seeds once, when the demo world has messages from others to put on it. Returns whether it did. */
export function seedDemoCalibration(db: Database, loud: Pick<LoudLearner, 'feed' | 'feedAnswer' | 'syncMarks' | 'learn'>, prefs: P.AttentionPrefs, now = Date.now()): boolean {
  if (db.query(`SELECT 1 FROM meta WHERE key = 'demo_calibration'`).get()) return true;
  const self = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL)`;
  // Others' messages of the last three days with a loudness, newest first, one per chat while they last. A scene's
  // notification is its own: what the demo hub sent for that message itself is taken away first.
  const ms = db
    .query(
      `SELECT m.id, m.ts, m.body, m.conversation_id, c.name, c.shape, c.network, COALESCE(p.name, i.display_name, i.handle) AS author, t.loud, t.facts IS NOT NULL AS facts
       FROM message m JOIN triage t ON t.message_id = m.id JOIN conversation c ON c.id = m.conversation_id
       LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN person p ON p.id = i.person_id
       WHERE m.author_id NOT IN ${self} AND t.loud_view IS NOT NULL AND t.decision != 'silent' AND m.body IS NOT NULL AND m.body != ''
         AND m.ts > ? AND m.ts < ?
       ORDER BY m.ts DESC LIMIT 400`,
    )
    .all(now - 3 * DAY, now - 3 * HOUR) as Row[];
  const byConv = new Map<string, Row>();
  for (const m of ms) if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, m);
  const pool = [...byConv.values(), ...ms.filter((m) => byConv.get(m.conversation_id) !== m)];
  // The marks that fit the model: on the demo's other messages, the oldest first.
  const scenes = new Set(pool.slice(0, SCENES.length).map((m) => m.id));
  const marked = (
    db
      .query(`SELECT t.message_id FROM triage t JOIN message m ON m.id = t.message_id WHERE m.author_id NOT IN ${self} AND t.facts IS NOT NULL AND t.decision != 'silent' ORDER BY m.ts LIMIT ?`)
      .all(FITTED_AT + 4 + SCENES.length) as Row[]
  )
    .filter((r) => !scenes.has(r.message_id))
    .slice(0, FITTED_AT + 4);
  if (pool.length < SCENES.length + 3 || marked.length < FITTED_AT) return false;
  db.transaction(() => {
    // What the feed drew before the seed (the page asked early): the seed's scenes are the feed.
    db.query('DELETE FROM cal_item').run();
    marked.forEach((r, k) => {
      const at = now - 4 * DAY - k * HOUR;
      // Mostly "less like this", now and then "should have alerted", as a person marks.
      db.query('UPDATE triage SET alert_mark = ?, less_mark = ?, marked_at = ? WHERE message_id = ?').run(k % 4 === 0 ? 1 : null, k % 4 === 0 ? null : 1, at, r.message_id);
    });
    SCENES.forEach((sc, k) => {
      const m = pool[k];
      db.query('DELETE FROM notification_event WHERE notification_id IN (SELECT id FROM notification WHERE message_id = ?)').run(m.id);
      db.query('DELETE FROM notification_device WHERE notification_id IN (SELECT id FROM notification WHERE message_id = ?)').run(m.id);
      db.query('DELETE FROM notification WHERE message_id = ?').run(m.id);
      db.query('DELETE FROM notification WHERE conversation_id = ? AND sent_at >= ? AND sent_at < ?').run(m.conversation_id, m.ts, m.ts + HOUR);
      if (sc.loud !== undefined) db.query('UPDATE triage SET loud = ? WHERE message_id = ?').run(sc.loud, m.id);
      const at = m.ts as number;
      const direct = m.shape === 'direct';
      const title = direct ? (m.author ?? 'Direct message') : (m.name ?? 'A chat');
      const body = direct ? m.body : `${m.author ?? 'Someone'}: ${m.body}`;
      const n = sc.notification;
      if (n) {
        const nid = newId('ndemo');
        const look = { network: m.network, tier: n.tier, count: 1, conv: { title, shape: m.shape }, lines: [{ author: m.author ?? 'Someone', body: m.body, ts: at }] };
        db.query(`INSERT INTO notification (id, kind, message_id, conversation_id, sent_at, devices, accepted, alert, title, body, look, computer_in_use) VALUES (?, 'message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          nid, m.id, m.conversation_id, at + 2000, n.devices.length, n.devices.length, +n.alert, title, body, JSON.stringify(look), +n.computerInUse,
        );
        for (const d of n.devices) {
          db.query('INSERT OR REPLACE INTO notification_device (notification_id, device, label, android, sounds, ok) VALUES (?, ?, ?, ?, ?, 1)').run(nid, d.sub.id, d.sub.label, +d.android, +n.alert);
          // What was showing beside it: other chats' latest messages, as quiet notifications a few minutes before.
          const beside: string[] = [];
          for (const o of pool.slice(SCENES.length).filter((o) => o.conversation_id !== m.conversation_id)) {
            if (beside.length >= (d.besideN ?? 0)) break;
            if (beside.includes(o.conversation_id) || db.query('SELECT 1 FROM notification WHERE message_id = ?').get(o.id)) continue;
            const od = o.shape === 'direct';
            db.query(`INSERT INTO notification (id, kind, message_id, conversation_id, sent_at, devices, accepted, alert, title, body) VALUES (?, 'message', ?, ?, ?, 1, 1, 0, ?, ?)`).run(
              newId('ndemo'), o.id, o.conversation_id, at - (beside.length + 1) * 4 * MIN, od ? (o.author ?? 'Direct message') : (o.name ?? 'A chat'), od ? o.body : `${o.author ?? 'Someone'}: ${o.body}`,
            );
            beside.push(o.conversation_id);
          }
          const ev = db.query('INSERT OR IGNORE INTO notification_event (notification_id, device, event, at, seen) VALUES (?, ?, ?, ?, ?)');
          ev.run(nid, d.sub.id, 'delivered', at + 3000, null);
          ev.run(nid, d.sub.id, 'shown', at + 3500, JSON.stringify({ ...d.seen, beside }));
          if (d.tapped) {
            ev.run(nid, d.sub.id, 'tapped', at + d.tapped, null);
            db.query('UPDATE notification SET tapped_at = ? WHERE id = ?').run(at + d.tapped, nid);
          }
          if (d.dismissed) {
            ev.run(nid, d.sub.id, 'dismissed', at + d.dismissed, null);
            db.query('UPDATE notification SET dismissed_at = ? WHERE id = ?').run(at + d.dismissed, nid);
          }
        }
      }
      if (sc.opened) {
        const start = Math.min(now - MIN, at + sc.opened.after);
        db.query(`INSERT INTO visit (id, device, device_label, view, conversation_id, start_at, end_at, active, source, updated_at) VALUES (?, 'demo_dev', ?, 'conversation', ?, ?, ?, 20, ?, ?)`).run(
          newId('vdemo'), sc.opened.label, m.conversation_id, start, start + 2 * MIN, sc.opened.source, now,
        );
      }
    });
    db.query(`INSERT INTO meta (key, value) VALUES ('demo_calibration', '1')`).run();
  })();
  // The marks as the answers the model learns from, and learned.
  loud.syncMarks();
  loud.learn(now);
  const feed = loud.feed;
  const placed: { id: string; scene: Scene }[] = [];
  SCENES.forEach((sc, k) => {
    if (sc.kind === 'none') return;
    const id = feed.place(pool[k].id, sc.kind === 'past' ? 'card' : sc.kind, sc.kind === 'past' ? now - 2 * DAY : now);
    if (id) placed.push({ id, scene: sc });
  });
  // A past answer: the one the model gave least, a day and a half ago, so it is back now.
  for (const { id } of placed.filter((p) => p.scene.kind === 'past')) {
    const it = feed.get(id)!;
    const p = JSON.parse(it.p) as P.Trio;
    const least = (['sound', 'show', 'inbox'] as const)[p.indexOf(Math.min(...p))];
    loud.feedAnswer(id, least, now - 1.5 * DAY);
    db.query('UPDATE cal_item SET returns_at = ? WHERE id = ?').run(now - 12 * HOUR, id);
  }
  // The rest of the last days, as any hub puts them: the two cards above fill the day, so no more are picked.
  feed.fill(prefs, now, true);
  return true;
}

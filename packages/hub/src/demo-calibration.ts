/**
 * A demo world's calibration feed (docs/notifications.md, "The calibration feed"): the demo's own messages, each with
 * an invented place it was seen (an Android phone's shade or lock screen, a laptop's browser, the open app, or no
 * notification at all) and an invented time you opened it, put on the feed as every kind it has: cards, rows, a past
 * answer come back, and a person it is sure of (30 invented answers about them) hidden under its fold, one of them
 * shown at random. Invented devices, the demo's invented messages; only ever in a demo world.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { newId } from './calfeed.ts';
import type { LoudLearner } from './loudlearn.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const PHONE = { id: 'demo_sub_phone', label: 'Android phone' };
const LAPTOP = { id: 'demo_sub_laptop', label: 'Firefox on a laptop' };

interface Scene {
  kind: 'card' | 'row' | 'past';
  notification?: {
    alert: boolean;
    tier: 'push' | 'quiet' | 'digest';
    computerInUse: boolean;
    devices: { sub: typeof PHONE; android: boolean; seen?: Record<string, unknown>; tapped?: number; dismissed?: number; besideN?: number }[];
  };
  skip?: 'watched' | 'capped';
  /** When you opened its chat, after it came. */
  opened?: { after: number; source: string; label: string };
}

const shade = (sound: 'sound' | 'silent' | 'vibrate', surface = 'shade', extra: Record<string, unknown> = {}) => ({ surface, sound, locked: surface === 'lock', screenOn: surface !== 'lock', ...extra });

const SCENES: Scene[] = [
  // Shown silently in the shade, opened within a minute: it should have sounded.
  { kind: 'card', notification: { alert: false, tier: 'quiet', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: shade('silent'), besideN: 2 }] }, opened: { after: MIN, source: 'notification', label: 'Android phone' } },
  // Sounded on the laptop, dismissed in seconds, opened hours later: it could have waited.
  { kind: 'card', notification: { alert: true, tier: 'push', computerInUse: true, devices: [{ sub: LAPTOP, android: false, seen: { surface: 'browser', sound: 'sound', pageOpen: true }, dismissed: 3000 }] }, opened: { after: 5 * HOUR, source: 'inbox', label: 'Firefox on a laptop' } },
  // No notification (one had gone out minutes before), opened two hours later.
  { kind: 'card', skip: 'capped', opened: { after: 2 * HOUR, source: 'inbox', label: 'Android phone' } },
  // On the lock screen, vibrating, opened 40 minutes later.
  { kind: 'card', notification: { alert: true, tier: 'push', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: shade('vibrate', 'lock'), besideN: 1 }] }, opened: { after: 40 * MIN, source: 'notification', label: 'Android phone' } },
  // Answered a day and a half ago, an answer the model had given little chance: back once.
  { kind: 'past', notification: { alert: true, tier: 'push', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: shade('sound', 'heads_up') }] }, opened: { after: 30_000, source: 'notification', label: 'Android phone' } },
  { kind: 'past', opened: { after: 20 * HOUR, source: 'inbox', label: 'Firefox on a laptop' } },
  // Rows.
  { kind: 'row', notification: { alert: false, tier: 'quiet', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: shade('silent'), besideN: 1 }] }, opened: { after: 2 * HOUR, source: 'notification', label: 'Android phone' } },
  { kind: 'row', notification: { alert: true, tier: 'push', computerInUse: false, devices: [{ sub: PHONE, android: true, seen: shade('sound', 'heads_up') }] }, opened: { after: 40_000, source: 'notification', label: 'Android phone' } },
  { kind: 'row', skip: 'watched' },
  { kind: 'row', notification: { alert: false, tier: 'quiet', computerInUse: true, devices: [{ sub: LAPTOP, android: false, seen: { surface: 'toast', sound: 'silent' } }] }, opened: { after: 26 * HOUR, source: 'inbox', label: 'Firefox on a laptop' } },
  { kind: 'row', opened: { after: 9 * HOUR, source: 'inbox', label: 'Android phone' } },
];
/** Answers seeded about the person it is sure of: as many as being sure needs. */
const SURE_ANSWERS = 32;

/** Seeds once, when the demo world has messages from others to put on it. Returns whether it did. */
export function seedDemoCalibration(db: Database, loud: Pick<LoudLearner, 'feed' | 'feedAnswer'>, prefs: P.AttentionPrefs, now = Date.now()): boolean {
  if (db.query(`SELECT 1 FROM meta WHERE key = 'demo_calibration'`).get()) return true;
  const self = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL)`;
  // Others' messages of the last three days with a loudness, newest first, one per chat while they last. A scene's
  // notification is its own: what the demo hub sent for that message itself is taken away first.
  const ms = db
    .query(
      `SELECT m.id, m.ts, m.body, m.conversation_id, c.name, c.shape, c.network, COALESCE(p.name, i.display_name, i.handle) AS author, COALESCE(i.person_id, m.author_id) AS who, t.loud
       FROM message m JOIN triage t ON t.message_id = m.id JOIN conversation c ON c.id = m.conversation_id
       LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN person p ON p.id = i.person_id
       WHERE m.author_id NOT IN ${self} AND t.loud_view IS NOT NULL AND t.decision != 'silent' AND m.body IS NOT NULL AND m.body != ''
         AND m.ts > ? AND m.ts < ?
       ORDER BY m.ts DESC LIMIT 400`,
    )
    .all(now - 3 * DAY, now - 3 * HOUR) as Row[];
  // The person it will be sure of: the one with the most quiet messages (loudness under 15) in one chat.
  const quiet = new Map<string, Row[]>();
  for (const m of ms) if (m.loud < 15 && m.who) (quiet.get(`${m.who}|${m.conversation_id}`) ?? quiet.set(`${m.who}|${m.conversation_id}`, []).get(`${m.who}|${m.conversation_id}`)!).push(m);
  const sureOf = [...quiet.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const sureIds = new Set(sureOf.slice(0, 4).map((m) => m.id));
  const byConv = new Map<string, Row>();
  for (const m of ms) if (!sureIds.has(m.id) && !byConv.has(m.conversation_id) && (!sureOf[0] || m.conversation_id !== sureOf[0].conversation_id)) byConv.set(m.conversation_id, m);
  const pool = [...byConv.values(), ...ms.filter((m) => !sureIds.has(m.id) && byConv.get(m.conversation_id) !== m)];
  if (pool.length < SCENES.length + 3 || sureIds.size < 2) return false;
  const placed: { id: string; scene: Scene }[] = [];
  db.transaction(() => {
    // What the feed drew before the seed (the page asked early): the seed's scenes are the feed.
    db.query('DELETE FROM cal_item').run();
    SCENES.forEach((sc, k) => {
      const m = pool[k];
      db.query('DELETE FROM notification_event WHERE notification_id IN (SELECT id FROM notification WHERE message_id = ?)').run(m.id);
      db.query('DELETE FROM notification_device WHERE notification_id IN (SELECT id FROM notification WHERE message_id = ?)').run(m.id);
      db.query('DELETE FROM notification WHERE message_id = ?').run(m.id);
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
    });
    // The person it is sure of: answers about them, all agreeing, from over a month ago.
    const s0 = sureOf[0];
    if (s0) {
      const put = db.query(`INSERT INTO attn_answer (id, message_id, conversation_id, author, answer, source, band, at) VALUES (?, ?, ?, ?, 'inbox', 'feed', 'inbox', ?)`);
      for (let i = 0; i < SURE_ANSWERS; i++) put.run(newId('ans'), s0.id, s0.conversation_id, s0.who, now - 40 * DAY - i * HOUR);
    }
    db.query(`INSERT INTO meta (key, value) VALUES ('demo_calibration', '1')`).run();
  })();
  const feed = loud.feed;
  SCENES.forEach((sc, k) => {
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
  // The sure ones: hidden under their fold, but for one shown at random.
  [...sureIds].forEach((mid, i) => feed.place(mid, i === 0 ? 'row' : 'sure', now));
  const first = [...sureIds][0];
  if (first) db.query('UPDATE cal_item SET sure_shown = 1, chance = ? WHERE message_id = ?').run(1 / 20, first);
  // The rest of the last days, drawn as any hub draws them.
  feed.fill(prefs, now, true);
  return true;
}

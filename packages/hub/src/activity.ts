/**
 * The activity log (docs/activity.md): every stay on a screen or place, as the devices measure it, and what each
 * notification led to. Labelled data for triage and the planned local decision model, kept on the hub only and
 * never sent to other clients. Ids, times and counts: never what was said or searched.
 *
 * Devices send visits with an id of their own and send them again while they last; the hub keeps the latest of
 * each (counts and times only grow), so a resent batch changes nothing. Notifications get an id here that rides
 * in the push payload; devices report what happened to it, and a visit that started from a tap names it.
 */
import type * as P from '@dither-chat/protocol';
import { DEFAULT_ACTIVITY, NOTIFICATION_EVENTS, RETENTION_CHOICES, VISIT_SOURCES, VISIT_VIEWS } from '@dither-chat/protocol';
import type { Store } from './store.ts';
import type { NumericFeatures } from './interact.ts';

type Row = Record<string, any>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Opened within this long of a push (or of the last message of a burst nobody was pushed for) counts as opened. */
export const OPEN_WINDOW = HOUR;
/** A message from you within this long of opening counts as a reply. */
export const REPLY_AFTER = 10 * MIN;
/** Unpushed messages closer together than this are one burst: one chance to open the chat anyway. */
export const BURST_GAP = 30 * MIN;
/** Features look back this far. */
export const FEATURE_WINDOW = 90 * DAY;
/** Features are worked out again after this long. */
const FEATURE_TTL = 5 * MIN;
/** Hard caps, whatever the retention: the oldest rows go first. */
export const MAX_VISITS = 200_000;
export const MAX_NOTIFICATIONS = 100_000;
const PRUNE_EVERY = 10 * MIN;

const EVENT_COLUMN: Partial<Record<P.NotificationEventKind, string>> = {
  delivered: 'delivered_at',
  shown: 'shown_at',
  suppressed: 'suppressed_at',
  tapped: 'tapped_at',
  dismissed: 'dismissed_at',
  replied: 'replied_at',
};

/** Identities that are you: the accounts' own, and the identities of the person marked as you. */
const SELF = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL UNION SELECT i.id FROM identity i JOIN person p ON p.id = i.person_id WHERE p.is_self = 1)`;

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v && v.length <= max ? v : null);
const int = (v: unknown, lo: number, hi: number): number => Math.min(Math.max(Math.floor(Number(v) || 0), lo), hi);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Hub-side sanity for one visit from a device, or null to drop it. */
export function cleanVisit(v: Partial<P.VisitRecord>, now: number): P.VisitRecord | null {
  const id = str(v?.id, 64);
  const device = str(v?.device, 64);
  if (!id || !device || !VISIT_VIEWS.includes(v.view as P.VisitView)) return null;
  const clamp = (t: unknown) => Math.min(Math.max(Number(t) || now, now - 30 * DAY), now + MIN);
  const start = clamp(v.start);
  const end = Math.max(start, clamp(v.end));
  // Never more in use than the stay was long (plus a tick of slack), nor more than a day.
  const active = Math.min(Math.max(Number(v.active) || 0, 0), (end - start) / 1000 + 60, 86_400);
  return {
    id,
    device,
    deviceLabel: str(v.deviceLabel, 80),
    view: v.view as P.VisitView,
    conversationId: str(v.conversationId, 200),
    spaceId: str(v.spaceId, 200),
    personId: str(v.personId, 200),
    start,
    end,
    active: Math.round(active * 10) / 10,
    source: VISIT_SOURCES.includes(v.source as P.VisitSource) ? (v.source as P.VisitSource) : 'other',
    pushId: str(v.pushId, 64),
    rank: v.rank == null ? null : int(v.rank, 0, 100_000),
    score: num(v.score),
    needs: typeof v.needs === 'boolean' ? v.needs : null,
    depth: v.depth == null ? null : int(v.depth, 0, 100_000),
    readToId: str(v.readToId, 200),
    readToTs: num(v.readToTs),
    sent: int(v.sent, 0, 10_000),
    reactions: int(v.reactions, 0, 10_000),
    history: int(v.history, 0, 10_000),
    threads: int(v.threads, 0, 10_000),
    attachments: int(v.attachments, 0, 10_000),
    next: VISIT_VIEWS.includes(v.next as P.VisitView) ? (v.next as P.VisitView) : null,
    closed: !!v.closed,
  };
}

// ------------------------------------------------------------------ derivation, pure

export interface FeatureInput {
  pushes: { id: string; sentAt: number; tappedAt: number | null; visitId: string | null }[];
  /** Live messages from others, and whether triage pushed them. */
  incoming: { ts: number; pushed: boolean }[];
  visits: { id: string; start: number; end: number; active: number }[];
  /** When you wrote here. */
  own: number[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rate = (k: number, n: number) => (n ? k / n : null);

/** Visits spanning `t`: you were already there. */
const present = (visits: FeatureInput['visits'], t: number) => visits.some((v) => v.start <= t && t <= v.end);

/** What one push led to: opened (tap or any visit within OPEN_WINDOW), after how long, the dwell, a reply. Null while you were already there. */
export function pushOutcome(p: FeatureInput['pushes'][number], x: Pick<FeatureInput, 'visits' | 'own'>) {
  if (present(x.visits, p.sentAt) && !p.tappedAt) return null;
  const linked = p.visitId ? x.visits.find((v) => v.id === p.visitId) : undefined;
  const after = x.visits.find((v) => v.start >= p.sentAt && v.start <= p.sentAt + OPEN_WINDOW);
  const visit = linked ?? after ?? null;
  const openAt = Math.min(p.tappedAt ?? Infinity, visit?.start ?? Infinity);
  if (!Number.isFinite(openAt)) return { opened: false, tapped: false, timeToOpen: null, dwell: null, replied: false };
  return {
    opened: true,
    tapped: !!p.tappedAt,
    timeToOpen: Math.max(0, openAt - p.sentAt),
    dwell: visit?.active ?? null,
    replied: x.own.some((t) => t >= openAt && t <= openAt + REPLY_AFTER),
  };
}

/** Runs of unpushed messages, split where they pause for BURST_GAP or a push comes between. */
export function bursts(incoming: FeatureInput['incoming']): { first: number; last: number }[] {
  const out: { first: number; last: number }[] = [];
  let cur: { first: number; last: number } | null = null;
  for (const m of [...incoming].sort((a, b) => a.ts - b.ts)) {
    if (m.pushed) {
      cur = null;
      continue;
    }
    if (cur && m.ts - cur.last <= BURST_GAP) cur.last = m.ts;
    else out.push((cur = { first: m.ts, last: m.ts }));
  }
  return out;
}

/** The features of one place from its log (docs/activity.md). */
export function placeFeatures(kind: P.PlaceActivity['kind'], id: string, x: FeatureInput): P.PlaceActivity {
  const visits = [...x.visits].sort((a, b) => a.start - b.start);
  const own = [...x.own].sort((a, b) => a - b);
  let pushes = 0;
  let tapped = 0;
  let opened = 0;
  let replied = 0;
  const times: number[] = [];
  const dwells: number[] = [];
  for (const p of x.pushes) {
    const o = pushOutcome(p, { visits, own });
    if (!o) continue;
    pushes++;
    if (o.tapped) tapped++;
    if (!o.opened) continue;
    opened++;
    times.push(o.timeToOpen!);
    if (o.dwell != null) dwells.push(o.dwell);
    if (o.replied) replied++;
  }
  const pushTimes = x.pushes.map((p) => p.sentAt);
  let unpushed = 0;
  let openedAnyway = 0;
  for (const b of bursts(x.incoming)) {
    if (present(visits, b.first)) continue;
    const open = visits.find((v) => v.start >= b.first && v.start <= b.last + OPEN_WINDOW);
    // A push that came before the open had a hand in it: not a clean example either way.
    if (open && pushTimes.some((t) => t >= b.first && t <= open.start)) continue;
    unpushed++;
    if (open) openedAnyway++;
  }
  return {
    kind,
    id,
    pushes,
    tapped,
    opened,
    tapRate: rate(tapped, pushes),
    openRate: rate(opened, pushes),
    medianTimeToOpen: median(times),
    medianDwell: median(dwells),
    repliedAfterOpen: replied,
    replyAfterOpenRate: rate(replied, opened),
    unpushedBursts: unpushed,
    openedWithoutPush: openedAnyway,
    openedWithoutPushRate: rate(openedAnyway, unpushed),
    visits: visits.length,
    activeSeconds: Math.round(visits.reduce((n, v) => n + v.active, 0)),
  };
}

const ago = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 90 * MIN ? `${Math.round(ms / MIN)} min` : `${Math.round(ms / HOUR)} h`);

/** One sentence for triage's reasons, or null with too little to say. */
export function describeActivity(f: P.PlaceActivity): string | null {
  const parts: string[] = [];
  if (f.pushes >= 3) parts.push(`you opened ${f.opened} of ${f.pushes} pushes${f.medianTimeToOpen != null ? `, usually within ${ago(f.medianTimeToOpen)}` : ''}`);
  if (f.opened >= 3 && f.replyAfterOpenRate != null) parts.push(`replied after ${Math.round(f.replyAfterOpenRate * 100)}% of them`);
  if (f.unpushedBursts >= 3) parts.push(`opened it unprompted ${f.openedWithoutPush} of ${f.unpushedBursts} times`);
  return parts.length ? `Activity: ${parts.join('; ')}` : null;
}

// ------------------------------------------------------------------ the store

export type NotificationKind = 'message' | 'held' | 'digest' | 'request';

export interface Features {
  conversation: P.PlaceActivity;
  /** A DM: everything with that person, over all their networks. */
  person: P.PlaceActivity | null;
  /** Interaction features as of the message (interact.ts), for the candidate model's training. */
  x?: NumericFeatures;
}

export class ActivityStore {
  private lastPrune = 0;
  private cache = new Map<string, { at: number; v: Features | null }>();
  /** DITHER_ACTIVITY_FEATURES: triage adds the features to its reasons and keeps them with each decision. */
  featuresInTriage: boolean;

  constructor(
    private store: Store,
    opts: { featuresInTriage?: boolean } = {},
  ) {
    this.featuresInTriage = !!opts.featuresInTriage;
  }

  private get db() {
    return this.store.db;
  }

  // ---------------------------------------------------------------- settings

  settings(): P.ActivitySettings {
    const r = this.db.query(`SELECT value FROM meta WHERE key = 'activity_settings'`).get() as Row | null;
    try {
      return { ...DEFAULT_ACTIVITY, ...(r ? JSON.parse(r.value) : {}) };
    } catch {
      return { ...DEFAULT_ACTIVITY };
    }
  }

  setSettings(p: Partial<P.ActivitySettings>, now = Date.now()): P.ActivitySettings {
    const cur = this.settings();
    const next: P.ActivitySettings = {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : cur.enabled,
      retentionDays: RETENTION_CHOICES.includes(Number(p.retentionDays) as any) ? Number(p.retentionDays) : cur.retentionDays,
    };
    this.db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('activity_settings', ?)`).run(JSON.stringify(next));
    if (next.retentionDays < cur.retentionDays) this.prune(now, true);
    return next;
  }

  get enabled() {
    return this.settings().enabled;
  }

  info(): P.ActivityInfo {
    const count = (t: string) => (this.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as Row).n as number;
    const oldest = this.db.query('SELECT MIN(t) AS t FROM (SELECT MIN(start_at) AS t FROM visit UNION ALL SELECT MIN(sent_at) FROM notification)').get() as Row;
    return { settings: this.settings(), visits: count('visit'), notifications: count('notification'), oldest: oldest?.t ?? null, featuresInTriage: this.featuresInTriage };
  }

  // ---------------------------------------------------------------- notifications

  /** A new notification's id, for the payload; null when the log is off (then nothing is recorded). */
  notification(n: { kind: NotificationKind; messageId?: string | null; conversationId?: string | null }, now = Date.now()): string | null {
    if (!this.enabled) return null;
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString('base64url');
    this.db.query('INSERT INTO notification (id, kind, message_id, conversation_id, sent_at) VALUES (?, ?, ?, ?, ?)').run(id, n.kind, n.messageId ?? null, n.conversationId ?? null, now);
    this.changed(n.conversationId);
    this.maybePrune(now);
    return id;
  }

  /** How many push registrations it went to, and how many push servers took it. */
  sent(id: string, r: { devices: number; accepted: number }) {
    this.db.query('UPDATE notification SET devices = ?, accepted = ? WHERE id = ?').run(r.devices, r.accepted, id);
  }

  /** What devices say happened. Each device's first word on each event counts; repeats change nothing. */
  events(events: Partial<P.NotificationEvent>[], now = Date.now()): number {
    if (!this.enabled) return 0;
    let n = 0;
    this.db.transaction(() => {
      for (const e of events.slice(0, 200)) {
        const id = str(e?.id, 64);
        if (!id || !NOTIFICATION_EVENTS.includes(e.event as P.NotificationEventKind)) continue;
        const row = this.db.query('SELECT sent_at, conversation_id FROM notification WHERE id = ?').get(id) as Row | null;
        if (!row) continue;
        const at = Math.min(Math.max(Number(e.at) || now, row.sent_at), now);
        const r = this.db.query('INSERT OR IGNORE INTO notification_event (notification_id, device, event, at) VALUES (?, ?, ?, ?)').run(id, str(e.device, 64) ?? '', e.event!, at);
        if (!r.changes) continue;
        n++;
        const col = EVENT_COLUMN[e.event as P.NotificationEventKind];
        if (col) this.db.query(`UPDATE notification SET ${col} = MIN(COALESCE(${col}, ?), ?) WHERE id = ?`).run(at, at, id);
        this.changed(row.conversation_id);
      }
    })();
    return n;
  }

  // ---------------------------------------------------------------- visits

  /** A device's batch of visits. The same visit again keeps the latest of everything, so a resent batch changes nothing. */
  visits(raw: Partial<P.VisitRecord>[], now = Date.now()): number {
    if (!this.enabled) return 0;
    let n = 0;
    this.db.transaction(() => {
      for (const r of raw.slice(0, 500)) {
        const v = cleanVisit(r, now);
        if (!v) continue;
        this.db
          .query(
            `INSERT INTO visit (id, device, device_label, view, conversation_id, space_id, person_id, start_at, end_at, active, source, push_id, rank, score, needs,
               depth, read_to_id, read_to_ts, sent, reactions, history, threads, attachments, next_view, closed, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               device_label = COALESCE(excluded.device_label, device_label),
               start_at = MIN(start_at, excluded.start_at), end_at = MAX(end_at, excluded.end_at), active = MAX(active, excluded.active),
               depth = CASE WHEN excluded.depth IS NULL THEN depth ELSE MAX(COALESCE(depth, 0), excluded.depth) END,
               read_to_id = CASE WHEN COALESCE(excluded.read_to_ts, 0) > COALESCE(read_to_ts, 0) THEN excluded.read_to_id ELSE read_to_id END,
               read_to_ts = MAX(COALESCE(read_to_ts, 0), COALESCE(excluded.read_to_ts, 0)),
               sent = MAX(sent, excluded.sent), reactions = MAX(reactions, excluded.reactions), history = MAX(history, excluded.history),
               threads = MAX(threads, excluded.threads), attachments = MAX(attachments, excluded.attachments),
               next_view = COALESCE(next_view, excluded.next_view), closed = MAX(closed, excluded.closed), updated_at = excluded.updated_at`,
          )
          .run(
            v.id, v.device, v.deviceLabel ?? null, v.view, v.conversationId ?? null, v.spaceId ?? null, v.personId ?? null, v.start, v.end, v.active, v.source,
            v.pushId ?? null, v.rank ?? null, v.score ?? null, v.needs == null ? null : +v.needs, v.depth ?? null, v.readToId ?? null, v.readToTs || null,
            v.sent, v.reactions, v.history, v.threads, v.attachments, v.next ?? null, +v.closed, now,
          );
        // read_to_ts of 0 means none: MAX above turns a missing one into 0.
        this.db.query('UPDATE visit SET read_to_ts = NULL WHERE id = ? AND read_to_ts = 0').run(v.id);
        if (v.pushId && (v.source === 'notification' || v.source === 'toast')) this.link(v);
        // A person's stay counts for each of their DMs.
        if (v.conversationId) this.changed(v.conversationId);
        else if (v.personId) this.cache.clear();
        n++;
      }
    })();
    this.maybePrune(now);
    return n;
  }

  /** A visit that started from a tap: the notification's first visit, and its tap if no device said so. */
  private link(v: P.VisitRecord) {
    const n = this.db.query('SELECT id, sent_at FROM notification WHERE id = ?').get(v.pushId!) as Row | null;
    if (!n) return;
    this.db.query('UPDATE notification SET visit_id = COALESCE(visit_id, ?) WHERE id = ?').run(v.id, n.id);
    const at = Math.max(v.start, n.sent_at);
    this.db.query('INSERT OR IGNORE INTO notification_event (notification_id, device, event, at) VALUES (?, ?, ?, ?)').run(n.id, v.device, 'tapped', at);
    this.db.query('UPDATE notification SET tapped_at = MIN(COALESCE(tapped_at, ?), ?) WHERE id = ?').run(at, at, n.id);
  }

  /** The conversations these notifications were about. */
  conversationsOf(ids: (string | undefined)[]): string[] {
    const out = new Set<string>();
    const q = this.db.query('SELECT conversation_id FROM notification WHERE id = ?');
    for (const id of ids.slice(0, 200)) {
      const cid = typeof id === 'string' ? (q.get(id) as Row | null)?.conversation_id : null;
      if (cid) out.add(cid);
    }
    return [...out];
  }

  /** Features worked out before this change are stale. */
  private changed(cid: string | null | undefined) {
    if (cid) this.cache.delete(cid);
  }

  // ---------------------------------------------------------------- keeping it bounded

  private maybePrune(now: number) {
    if (now - this.lastPrune >= PRUNE_EVERY) this.prune(now);
  }

  /** Drops what is past retention, then the oldest past the row caps. Returns how many rows went. */
  prune(now = Date.now(), force = false, caps = { visits: MAX_VISITS, notifications: MAX_NOTIFICATIONS }): number {
    if (!force && now - this.lastPrune < PRUNE_EVERY) return 0;
    this.lastPrune = now;
    const cutoff = now - this.settings().retentionDays * DAY;
    let n = 0;
    this.db.transaction(() => {
      n += this.db.query('DELETE FROM visit WHERE end_at < ?').run(cutoff).changes;
      n += this.db.query('DELETE FROM notification WHERE sent_at < ?').run(cutoff).changes;
      const over = (t: string, cap: number) => Math.max(0, ((this.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as Row).n as number) - cap);
      const v = over('visit', caps.visits);
      if (v) n += this.db.query('DELETE FROM visit WHERE id IN (SELECT id FROM visit ORDER BY start_at LIMIT ?)').run(v).changes;
      const k = over('notification', caps.notifications);
      if (k) n += this.db.query('DELETE FROM notification WHERE id IN (SELECT id FROM notification ORDER BY sent_at LIMIT ?)').run(k).changes;
      this.db.query('DELETE FROM notification_event WHERE notification_id NOT IN (SELECT id FROM notification)').run();
      this.db.query('DELETE FROM triage_input WHERE at < ?').run(cutoff);
    })();
    if (n) this.cache.clear();
    return n;
  }

  /** Everything in the log. Usage totals (place_usage) are separate and stay. */
  clear() {
    this.db.exec('DELETE FROM visit; DELETE FROM notification; DELETE FROM notification_event; DELETE FROM triage_input;');
    this.cache.clear();
  }

  // ---------------------------------------------------------------- features

  /** The peer of a DM, as a person. */
  private peerOf(cid: string): string | null {
    const r = this.db
      .query(
        `SELECT i.person_id FROM participant pa JOIN identity i ON i.id = pa.identity_id LEFT JOIN person p ON p.id = i.person_id
         WHERE pa.conversation_id = ? AND i.person_id IS NOT NULL AND COALESCE(p.is_self, 0) = 0 AND i.id NOT IN ${SELF} LIMIT 1`,
      )
      .get(cid) as Row | null;
    return r?.person_id ?? null;
  }

  private gather(convs: string[], personId: string | null, since: number): FeatureInput {
    const ph = convs.map(() => '?').join(',');
    const pushes = (this.db.query(`SELECT id, sent_at, tapped_at, visit_id FROM notification WHERE kind = 'message' AND conversation_id IN (${ph}) AND sent_at >= ?`).all(...convs, since) as Row[]).map((r) => ({
      id: r.id,
      sentAt: r.sent_at,
      tappedAt: r.tapped_at,
      visitId: r.visit_id,
    }));
    const incoming = (
      this.db
        .query(`SELECT m.ts, t.decision FROM message m JOIN triage t ON t.message_id = m.id WHERE m.conversation_id IN (${ph}) AND m.ts >= ? AND (m.author_id IS NULL OR m.author_id NOT IN ${SELF})`)
        .all(...convs, since) as Row[]
    ).map((r) => ({ ts: r.ts, pushed: r.decision === 'push' || r.decision === 'quiet' || r.decision === 'digest' }));
    const visits = (
      this.db
        .query(`SELECT id, start_at, end_at, active FROM visit WHERE (conversation_id IN (${ph}) OR (? IS NOT NULL AND person_id = ?)) AND view IN ('conversation', 'person') AND start_at >= ? ORDER BY start_at`)
        .all(...convs, personId, personId, since) as Row[]
    ).map((r) => ({ id: r.id, start: r.start_at, end: r.end_at, active: r.active }));
    const own = (this.db.query(`SELECT ts FROM message WHERE conversation_id IN (${ph}) AND ts >= ? AND author_id IN ${SELF}`).all(...convs, since) as Row[]).map((r) => r.ts as number);
    return { pushes, incoming, visits, own };
  }

  /** What the log says about a conversation (and, for a DM, the person), cached for a few minutes. */
  features(cid: string, now = Date.now()): Features | null {
    const hit = this.cache.get(cid);
    if (hit && now - hit.at < FEATURE_TTL) return hit.v;
    const c = this.db.query('SELECT id, shape FROM conversation WHERE id = ?').get(cid) as Row | null;
    let v: Features | null = null;
    if (c) {
      const since = now - FEATURE_WINDOW;
      const peer = c.shape === 'direct' ? this.peerOf(cid) : null;
      const conversation = placeFeatures('conversation', cid, this.gather([cid], null, since));
      let person: P.PlaceActivity | null = null;
      if (peer) {
        const convs = (
          this.db
            .query(`SELECT DISTINCT c.id FROM conversation c JOIN participant pa ON pa.conversation_id = c.id JOIN identity i ON i.id = pa.identity_id WHERE c.shape = 'direct' AND i.person_id = ?`)
            .all(peer) as Row[]
        ).map((r) => r.id as string);
        person = placeFeatures('person', peer, this.gather(convs.length ? convs : [cid], peer, since));
      }
      v = { conversation, person };
    }
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(cid, { at: now, v });
    return v;
  }

  /** The features triage saw, kept with its decision. */
  keepInputs(messageId: string, f: Features, now = Date.now()) {
    if (!this.enabled) return;
    this.db.query('INSERT OR REPLACE INTO triage_input (message_id, features, at) VALUES (?, ?, ?)').run(messageId, JSON.stringify(f), now);
  }

  /** The places with the most going on lately, for Settings' small summary. */
  top(limit = 10, now = Date.now()): (P.PlaceActivity & { conversationId: string })[] {
    const since = now - FEATURE_WINDOW;
    const ids = this.db
      .query(
        `SELECT cid, SUM(n) AS n FROM (
           SELECT conversation_id AS cid, COUNT(*) AS n FROM notification WHERE kind = 'message' AND sent_at >= ? AND conversation_id IS NOT NULL GROUP BY conversation_id
           UNION ALL SELECT conversation_id, COUNT(*) FROM visit WHERE start_at >= ? AND conversation_id IS NOT NULL GROUP BY conversation_id)
         GROUP BY cid ORDER BY n DESC LIMIT ?`,
      )
      .all(since, since, limit) as Row[];
    return ids.map((r) => ({ ...this.features(r.cid, now)!.conversation, conversationId: r.cid })).filter((f) => f.id);
  }

  // ---------------------------------------------------------------- export

  /** The log as JSON lines: the settings, every visit, every notification with each device's events. */
  *exportLog(): Generator<string> {
    yield JSON.stringify({ type: 'activity-log', version: 1, exportedAt: Date.now(), settings: this.settings() });
    for (const r of this.db.query('SELECT * FROM visit ORDER BY start_at').iterate() as Iterable<Row>) yield JSON.stringify({ type: 'visit', ...visitOut(r) });
    const events = this.db.query('SELECT device, event, at FROM notification_event WHERE notification_id = ? ORDER BY at');
    for (const r of this.db.query('SELECT * FROM notification ORDER BY sent_at').iterate() as Iterable<Row>) {
      yield JSON.stringify({ type: 'notification', ...notificationOut(r), events: events.all(r.id) });
    }
  }

  /**
   * Labelled examples for the local model, one per triaged message: its metadata (never its text), triage's
   * decision, what triage knew from the log then (when kept), and what happened after (docs/activity.md).
   */
  *examples(now = Date.now(), since = now - this.settings().retentionDays * DAY): Generator<string> {
    const db = this.db;
    const notif = db.query('SELECT * FROM notification WHERE message_id = ? ORDER BY sent_at LIMIT 1');
    const input = db.query('SELECT features FROM triage_input WHERE message_id = ?');
    const visitAfter = db.query(
      `SELECT * FROM visit WHERE (conversation_id = ? OR (? IS NOT NULL AND person_id = ?)) AND view IN ('conversation', 'person') AND end_at >= ? AND start_at <= ? ORDER BY start_at`,
    );
    const ownAfter = db.query(`SELECT MIN(ts) AS ts FROM message WHERE conversation_id = ? AND ts > ? AND ts <= ? AND author_id IN ${SELF}`);
    const members = db.query('SELECT COUNT(*) AS n FROM participant WHERE conversation_id = ?');
    const peers = new Map<string, string | null>();
    const rows = db
      .query(
        `SELECT t.message_id, t.decision, t.score, t.reasons, t.decided_by, t.feedback, t.alert_mark, t.less_mark, t.created_at,
                m.conversation_id, m.ts, m.kind, m.mentions_self, m.reply_to_id, m.thread_id, m.deleted, m.network,
                c.shape, c.variant, i.is_bot, i.person_id, p.starred,
                r.author_id IN ${SELF} AS reply_to_self
         FROM triage t JOIN message m ON m.id = t.message_id JOIN conversation c ON c.id = m.conversation_id
         LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN person p ON p.id = i.person_id
         LEFT JOIN message r ON r.id = m.reply_to_id
         WHERE t.created_at >= ? ORDER BY m.ts`,
      )
      .iterate(since) as Iterable<Row>;
    for (const r of rows) {
      const cid = r.conversation_id as string;
      if (!peers.has(cid)) peers.set(cid, r.shape === 'direct' ? this.peerOf(cid) : null);
      const peer = peers.get(cid)!;
      const n = notif.get(r.message_id) as Row | null;
      const horizon = Math.min(now, r.ts + DAY);
      const vs = visitAfter.all(cid, peer, peer, r.ts, horizon) as Row[];
      const seenLive = vs.some((v) => v.start_at <= r.ts && v.end_at >= r.ts);
      const next = vs.find((v) => v.start_at >= r.ts) ?? null;
      const tapVisit = n?.visit_id ? (db.query('SELECT * FROM visit WHERE id = ?').get(n.visit_id) as Row | null) : null;
      const openAt = Math.min(n?.tapped_at ?? Infinity, next?.start_at ?? Infinity);
      const opened = Number.isFinite(openAt) ? openAt : null;
      const reply = (ownAfter.get(cid, r.ts, horizon) as Row | null)?.ts ?? null;
      const outcome = {
        notified: !!n,
        notificationId: n?.id ?? null,
        devices: n?.devices ?? null,
        accepted: n?.accepted ?? null,
        delivered: n?.delivered_at != null,
        shown: n?.shown_at != null,
        suppressed: n?.suppressed_at != null,
        inApp: !!n && !!db.query(`SELECT 1 FROM notification_event WHERE notification_id = ? AND event = 'inapp'`).get(n.id),
        dismissed: n?.dismissed_at != null,
        tapped: n?.tapped_at != null,
        timeToTap: n?.tapped_at != null ? n.tapped_at - n.sent_at : null,
        repliedFromNotification: n?.replied_at != null,
        seenLive,
        openedAfter: opened != null ? opened - r.ts : null,
        dwell: (tapVisit ?? next)?.active ?? null,
        repliedAfter: reply != null ? reply - r.ts : null,
        observedFor: horizon - r.ts,
      };
      yield JSON.stringify({
        messageId: r.message_id,
        conversationId: cid,
        ts: r.ts,
        network: r.network,
        shape: r.shape,
        variant: r.variant,
        members: (members.get(cid) as Row).n,
        kind: r.kind,
        deleted: !!r.deleted,
        mentionsSelf: !!r.mentions_self,
        replyToSelf: !!r.reply_to_self,
        inThread: !!r.thread_id,
        authorIsBot: !!r.is_bot,
        authorStarred: !!r.starred,
        authorPersonId: r.person_id ?? null,
        triage: {
          decision: r.decision,
          score: r.score,
          decidedBy: r.decided_by,
          // A model's reason may paraphrase the message: its words stay out.
          reasons: (JSON.parse(r.reasons) as string[]).map((s) => (s.startsWith('Model:') ? 'Model' : s)),
          // Your marks (docs/notifications.md); `feedback` is a vote from before the tiers.
          marks: { ...(r.alert_mark != null ? { alert: !!r.alert_mark } : {}), ...(r.less_mark ? { less: true } : {}) },
          feedback: r.feedback ?? null,
          at: r.created_at,
        },
        inputs: (() => {
          const i = input.get(r.message_id) as Row | null;
          return i ? JSON.parse(i.features) : null;
        })(),
        outcome,
        label: weakLabel(r.feedback, outcome),
      });
    }
  }
}

/**
 * A label for training when you gave none: your own vote first; then opened within 15 minutes and replied or
 * stayed 20 s → should_push; seen nothing for a day, or tapped and left within 5 s → should_not_push. Else null.
 */
export function weakLabel(
  feedback: string | null,
  o: { seenLive: boolean; openedAfter: number | null; dwell: number | null; repliedAfter: number | null; observedFor: number; tapped: boolean },
): 'should_push' | 'should_not_push' | null {
  // A vote: Important or Active say it was worth a notification, Digest that it was not.
  if (feedback === 'push' || feedback === 'quiet') return 'should_push';
  if (feedback === 'digest' || feedback === 'drop') return 'should_not_push';
  if (feedback === 'should_push' || feedback === 'should_not_push') return feedback;
  if (o.seenLive) return null;
  if (o.openedAfter != null && o.openedAfter <= 15 * MIN && ((o.repliedAfter != null && o.repliedAfter <= o.openedAfter + REPLY_AFTER) || (o.dwell ?? 0) >= 20)) return 'should_push';
  if (o.tapped && o.dwell != null && o.dwell < 5) return 'should_not_push';
  if (o.openedAfter == null && o.observedFor >= DAY) return 'should_not_push';
  return null;
}

function visitOut(r: Row) {
  return {
    id: r.id,
    device: r.device,
    deviceLabel: r.device_label,
    view: r.view,
    conversationId: r.conversation_id,
    spaceId: r.space_id,
    personId: r.person_id,
    start: r.start_at,
    end: r.end_at,
    active: r.active,
    source: r.source,
    pushId: r.push_id,
    rank: r.rank,
    score: r.score,
    needs: r.needs == null ? null : !!r.needs,
    depth: r.depth,
    readToId: r.read_to_id,
    readToTs: r.read_to_ts,
    sent: r.sent,
    reactions: r.reactions,
    history: r.history,
    threads: r.threads,
    attachments: r.attachments,
    next: r.next_view,
    closed: !!r.closed,
  };
}

function notificationOut(r: Row) {
  return {
    id: r.id,
    kind: r.kind,
    messageId: r.message_id,
    conversationId: r.conversation_id,
    sentAt: r.sent_at,
    devices: r.devices,
    accepted: r.accepted,
    deliveredAt: r.delivered_at,
    shownAt: r.shown_at,
    suppressedAt: r.suppressed_at,
    tappedAt: r.tapped_at,
    dismissedAt: r.dismissed_at,
    repliedAt: r.replied_at,
    visitId: r.visit_id,
  };
}

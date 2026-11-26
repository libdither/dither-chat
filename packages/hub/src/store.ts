import { whole } from './slices.ts';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hubId, randomId } from '@dither-chat/protocol/ids';
import type * as P from '@dither-chat/protocol';
import { calendarAccountUrl, canonicalReactionKey, DEFAULT_RETENTION, isPictureLayout, MENTION_SCOPES, parseSearch, PROTOCOL_VERSION, REACTION_RULES } from '@dither-chat/protocol';
import { activityChart, type Zone } from './activitychart.ts';
import { binsFor, estimateMessages, snowflakeTime, type ChannelInput } from './msgcount.ts';
import { Journal } from './journal.ts';
import { infoFor } from './mediainfo.ts';
import { extraView, withNote } from './msgextra.ts';
import { TypingRelay, typingTtl } from './typing.ts';
import { PresenceNow } from './presence.ts';
import { stepTimer } from './startup.ts';
import { addTables, ingestRelationships, ingestRequests, pendingLinks } from './add.ts';
import { accountSelfView, ingestSelf } from './accountself.ts';
import { lateNews } from './latenews.ts';
import { eraseVoice, ingestCallEvent, voiceKept } from './callstate.ts';
import { ingestStories } from './media.ts';
import { applyPollUpdate, pollSeen, pollViews } from './polls.ts';
import { ingestServers } from './servers.ts';
import { ingestApps } from './apps.ts';
import { ingestThreadFacts, threadParts, type ThreadParts } from './threads.ts';
import { type DueReminder, ingestSaved, savedTables } from './saved.ts';
import { feedItemOf, feedView, postView, scrubEventGuests } from './feed.ts';
import { keepAbout } from './people.ts';
import { alertBar, type Facts } from './learn.ts';
import { attachmentExtra, attachmentRich, embedViews, richView, type StoredExtra } from './rich.ts';

/** A pre-deploy copy this young was made for this start (the deployer copies, then restarts the hub). */
const PRE_DEPLOY_FRESH_MS = 15 * 60_000;

type Row = Record<string, any>;

/** The colours accounts take in turn: a new account gets the first no other account has. */
export const ACCOUNT_COLORS = ['#F2A541', '#E86A92', '#B794F6', '#FF8C61', '#9BE15D', '#5CC8FF', '#F7D154', '#FF6B6B'];

export interface AccountRow {
  id: string;
  network: P.Network;
  label: string;
  color: string;
  adapter: string;
  config: string;
  token: string;
  self_identity: string | null;
  status: P.AccountStatus;
  attention: string | null;
  capabilities: string;
  live_view: string | null;
  enabled: number;
  demo: number;
  position: number;
  created_at: number;
}

type MediaSigner = (raw: string | null | undefined, accountId: string | null | undefined) => string | null;

/** How a search is asked (Store.search): `typing`, as you type, skips the slow fallbacks; `people: false`, no people. */
export interface SearchOptions {
  typing?: boolean;
  people?: boolean;
}

/** Objects touched since the last flush; the server turns these into ClientEvents. */
class Dirty {
  accounts = new Set<string>();
  identities = new Set<string>();
  persons = new Set<string>();
  spaces = new Set<string>();
  conversations = new Set<string>();
  /** live message id -> true; backfill only dirties the conversation */
  messages = new Map<string, boolean>();
  removed: P.ClientEvent[] = [];
  extra: P.ClientEvent[] = [];
  get empty() {
    return (
      !this.accounts.size &&
      !this.identities.size &&
      !this.persons.size &&
      !this.spaces.size &&
      !this.conversations.size &&
      !this.messages.size &&
      !this.removed.length &&
      !this.extra.length
    );
  }
}

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const PREVIEW_LEN = 140;

/** A stored decision as the app sees it. Chances from before the tiers (three of them) are not the two it reads. */
function triageView(t: Row): P.TriageView {
  const probs = json<Partial<P.TriageProbs> | null>(t.probs, null);
  const marks: P.TriageMarks = { ...(t.alert_mark != null ? { alert: !!t.alert_mark } : {}), ...(t.less_mark ? { less: true } : {}) };
  // The local model's answer is kept with the facts, which also say which bar it was held to.
  const facts = typeof t.facts === 'string' && t.facts.includes('"judge"') ? json<Partial<Facts>>(t.facts, {}) : null;
  const judge = facts?.judge;
  return {
    decision: t.decision,
    score: t.score,
    reasons: json(t.reasons, []),
    decidedBy: t.decided_by,
    feedback: t.feedback,
    probs: probs && typeof probs.important === 'number' && typeof probs.alert === 'number' ? { alert: probs.alert, important: probs.important } : null,
    ...(Object.keys(marks).length ? { marks } : {}),
    ...(judge !== undefined ? { judge, bar: alertBar({ shape: facts!.shape ?? '', mention: !!facts!.mention, reply: !!facts!.reply }) } : {}),
    // Only the number rides with every message; the Why sheet asks for the rest.
    ...(typeof t.loud === 'number' ? { loudness: t.loud } : {}),
  };
}

/** What triage keeps of a message's loudness (loudness.ts), deciding or in shadow. */
export interface StoredLoud extends P.LoudView {
  /** The Conversation reasons that held, and the moment's kinds: what the answers about it teach. */
  why?: string[];
  moment?: string[];
}

/** A stored loudness as the Why sheet shows it. */
export function loudViewOf(raw: string): P.LoudView | null {
  const v = json<StoredLoud | null>(raw, null);
  if (!v || typeof v.loudness !== 'number') return null;
  return { loudness: v.loudness, band: v.band, live: !!v.live, ...(v.rule ? { rule: v.rule } : {}), ...(v.parts ? { parts: v.parts } : {}), reasons: v.reasons ?? [] };
}

export function previewText(body: string, kind: string): string {
  if (kind === 'encrypted') return 'Encrypted message';
  // A sticker with no words of its own (Discord's are pictures alone) still says what it is.
  if (kind === 'sticker' && !body.trim()) return 'Sticker';
  // Keep <@id> / <#id> tokens intact: the client resolves them to names.
  const t = body
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\|\|([\s\S]*?)\|\|/g, '[spoiler]')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > PREVIEW_LEN ? t.slice(0, PREVIEW_LEN - 1) + '…' : t;
}

/**
 * An account's name as you see it: your nickname for it, else its display name, else its handle, else its id. A
 * person's name is made of these (docs/chats.md, Names); `SHOWN` is the same in SQL, on a table aliased `i`.
 */
const shownName = (r: Row): string =>
  r.nickname || r.display_name || r.handle || r.native_id;
export const SHOWN = `COALESCE(NULLIF(i.nickname, ''), i.display_name, i.handle, i.native_id)`;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** A snippet for a match SQLite's tokens could not see. */
/** A message's key in search_time: when it was sent, with room for 1024 in one millisecond (schema.sql). */
export const searchKey = (ts: number, rowid: number) => Math.floor(ts) * 1024 + (rowid % 1024);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Two renderings of one message compared for an import: an export's body was rebuilt from HTML, so mentions,
 * emoji, links and Markdown marks may be written differently while the words are the same.
 */
function normalizeForCompare(s: string): string {
  return s
    .replace(/<a?:(\w+):\d+>/g, '$1')
    .replace(/<@[!&]?\d+>|<#\d+>|@\S+|#\S+/g, '')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1$2')
    .replace(/[*_~|`>#\s\\]/g, '')
    .toLowerCase();
}

export function markSnippet(body: string, terms: string[], before = 60, len = 200): string {
  const lower = body.toLowerCase();
  const first = Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0));
  const start = Math.max(0, (Number.isFinite(first) ? first : 0) - before);
  let out = (start ? '…' : '') + body.slice(start, start + len) + (body.length > start + len ? '…' : '');
  for (const t of terms) out = out.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `\u0001${m}\u0002`);
  return out;
}

/** Lowercase without accents, for comparing names. */
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** How well a folded word matches a name: all of it, its start, the start of a word in it, or the middle of one. */
function nameScore(name: string | null | undefined, word: string): number {
  if (!name) return 0;
  const n = fold(name);
  if (n === word) return 1;
  if (n.startsWith(word)) return 0.8;
  const at = n.indexOf(word);
  if (at < 0) return 0;
  return /[\p{L}\p{N}]/u.test(n[at - 1]) ? 0.4 : 0.6;
}

/** The text of an identity's status column (JSON { text, emoji, at }). */
const statusText = (raw: string | null): string | null => {
  try {
    return (raw && (JSON.parse(raw) as { text?: string }).text) || null;
  } catch {
    return null;
  }
};

/** Edits from a to b, a swap of neighbours counting as one; anything past `max` is max + 1. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let pp: number[] = [], p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) c[j] = Math.min(c[j], pp[j - 2] + 1);
      low = Math.min(low, c[j]);
    }
    if (low > max) return max + 1;
    [pp, p] = [p, c];
  }
  return Math.min(p[b.length], max + 1);
}

/** Of the accounts that saw a person's accounts, the one that saw the account `url` is the picture of, else any. */
function pickVia(rows: { via: string; url: string | null }[] | undefined, url: string): string | null {
  return rows?.find((r) => r.url === url)?.via ?? rows?.[0]?.via ?? null;
}

/** Fields that may go from nothing to something and back (Store.logChanges). */
const SETTABLE = new Set(['topic', 'bio', 'status', 'pronouns']);
const PRESENCE_STATES = new Set<string>(['online', 'idle', 'dnd', 'offline']);
const PRESENCE_DEVICES = new Set<string>(['desktop', 'mobile', 'web']);

/**
 * Bump when a migration step changes without schema.sql changing, so the database is copied before it runs. Mail's
 * migration steps (mail/store.ts) count here too, when no mail schema file changes with them.
 */
const MIGRATIONS = 7;

/** How long a write waits for another connection's lock before it fails (PRAGMA busy_timeout). */
export const BUSY_MS = 2000;

/** mail/schema*.sql as MailStore runs them (mail/store.ts mailSchemas), read here without importing mail's store. */
function mailSchemaText(): string {
  const dir = new URL('./mail/', import.meta.url);
  return readdirSync(dir)
    .filter((f) => /^schema(?:-[\w-]+)?\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(new URL(f, dir), 'utf8'))
    .join('\n');
}

/** Some picture came without its size (Store.sizelessPictures). */
const sizeless = (atts: P.AttachmentFact[]) => atts.some((a) => a.kind === 'image' && (!a.width || !a.height));

/**
 * A reaction's time as a network gave it, if it is one: milliseconds since 2000 and not ahead of now by more than a
 * day (a clock a little fast is still the network's word). Seconds, or nonsense, are no time at all.
 */
function reactionTs(ts: unknown, now = Date.now()): number | null {
  return typeof ts === 'number' && Number.isFinite(ts) && ts >= 946_684_800_000 && ts <= now + 86_400_000 ? Math.round(ts) : null;
}

/**
 * A kept unreact as views give it. Its time is `seen` (when the hub heard) unless the network gave it: every one
 * kept before times were (docs/history.md).
 */
function unreactView(raw: string | null): { data: P.UnreactData; seen?: true } {
  const d = json<{ key?: string; style?: P.ReactionStyle; cleared?: boolean; exact?: boolean; added?: number; addedExact?: boolean }>(raw, {});
  const data: P.UnreactData = {
    key: d.key ?? '',
    style: d.style ?? 'normal',
    ...(d.cleared ? { cleared: true as const } : {}),
    ...(typeof d.added === 'number' ? { added: d.added, ...(d.addedExact ? {} : { addedSeen: true as const }) } : {}),
  };
  return { data, ...(d.exact ? {} : { seen: true as const }) };
}

export class Store {
  readonly db: Database;
  readonly dirty = new Dirty();
  /** Conversation -> the oldest new message stored since attention.ts last looked, so it can tell appends from backfill. */
  readonly ingested = new Map<string, number>();
  /**
   * Conversations where your own reactions or reply marks changed since attention.ts last looked: a reaction answers
   * what you owed, a mark settles or holds it (replymarks.ts). They fold again.
   */
  readonly selfReacted = new Set<string>();
  /** What changed at which position, for clients that come back (journal.ts, docs/sync.md). */
  readonly journal: Journal;
  private selfIdentities = new Set<string>();
  /** search_time holds every message (fillSearchIndexSteps has run, or the database began with it). */
  private searchTimeReady = false;
  /** Accounts whose adapter speaks another protocol version, and what to tell you about it. */
  private protocolWarnings = new Map<string, string>();
  /** A channel's bin counts for msgcount.ts, by channel, count and newest message: a new message makes a new key. */
  private binCache = new Map<string, number[]>();
  /** Who is typing where: in memory only (typing.ts). */
  readonly typers = new TypingRelay();
  /** How each person is on their network now, for status dots (presence.ts). */
  readonly presenceNow: PresenceNow;
  /** People a merge, a split or a new person changed: mail/people.ts sends their mail threads again. */
  personsChanged: ((personIds: string[]) => void) | null = null;
  /** A person's chat routes by email (mail/places.ts, docs/mail.md "Mail as chats"): set once mail is connected. */
  mailRoutes: ((personId: string) => P.ChatRoute[]) | null = null;
  /** A reminder set on a network came due (saved.ts): the server notifies. Called inside ingest's transaction. */
  reminderDue: ((r: DueReminder) => void) | null = null;
  /** How long each step of opening the database took (startup.ts). */
  readonly opening: [string, number][];

  /**
   * A reader (`reader: true`): a read-only connection for search's own thread (search-worker.ts), opened on a database
   * the hub has opened and migrated already. It writes nothing, so it takes none of the steps below; only what search
   * reads works on it, and it asks for what it holds in memory again before each search (beforeRead).
   */
  readonly reader: boolean;

  constructor(path: string, readonly media: MediaSigner, opts: { reader?: boolean } = {}) {
    const timer = stepTimer();
    this.opening = timer.out;
    this.reader = !!opts.reader;
    if (this.reader) {
      this.db = new Database(path, { readonly: true, strict: true });
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
      // Never used on a reader: both write as they start.
      this.journal = null!;
      this.presenceNow = null!;
      this.beforeRead();
      return;
    }
    this.db = new Database(path, { create: true, strict: true });
    // Another process opening this database (a backup's VACUUM INTO, the sqlite3 shell) can hold a lock for a moment,
    // most often while it opens or closes. Without a wait every write in that moment fails (SQLITE_BUSY): 26 on the
    // live hub in one backup. With it a write waits up to BUSY_MS, on the hub's one thread, so not much longer than a
    // lock held for an open on a busy machine; past it the write fails as before (adapter events wait and are applied
    // again: supervisor.ts).
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
    // Outside any transaction: inside one, SQLite ignores foreign_keys.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    // A commit is written to the log without waiting for the disk; the log reaches the disk at each checkpoint (about
    // every second, checkpoint.ts). The owner's choice (2026-11-13): on a busy disk every fsync of a commit held the
    // hub's one thread, four or so for each message. A power cut or a crash of the machine (not of the hub) can lose
    // the commits since the last checkpoint; it cannot corrupt the database (docs/deploy.md, "Durability").
    this.db.exec('PRAGMA synchronous = NORMAL');
    timer.step('db open');
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    // A schema (or migration code) this database has not met yet: copy it first (backups/pre-migrate-*), then take
    // every step in one transaction, so a crash part way leaves the database as it was, not half moved. Mail's schema
    // files count too: MailStore migrates its tables in the same database when MailHub starts, after this.
    const sig = createHash('sha256').update(`${MIGRATIONS}\n${schema}\n${mailSchemaText()}`).digest('hex').slice(0, 16);
    const known = this.schemaSig();
    if (known !== null && known !== sig) {
      this.snapshotBeforeMigrating(path);
      timer.step('pre-migrate copy');
    }
    this.db.transaction(() => {
      const reactionsBefore = this.oldReactions();
      const broadcastsUnknown = this.addMentionsAll();
      this.addColumns('message', { gone_how: 'TEXT', gone_at: 'INTEGER', imported: 'INTEGER NOT NULL DEFAULT 0', mentions_group: 'INTEGER NOT NULL DEFAULT 0' });
      const wildcardsUnknown = this.lacksColumn('vantage', 'wildcards');
      this.addColumns('vantage', { wildcards: 'INTEGER NOT NULL DEFAULT 0' });
      this.addColumns('identity', { status: 'TEXT', nickname: 'TEXT', net_nickname: 'TEXT', net_note: 'TEXT' });
      this.addColumns('category', { threshold: 'REAL' });
      this.addColumns('triage', { shadow: 'TEXT', explore: 'TEXT', propensity: 'REAL', was: 'TEXT', alert_mark: 'INTEGER', less_mark: 'INTEGER', marked_at: 'INTEGER', loud: 'REAL', loud_view: 'TEXT', message_ts: 'INTEGER' });
      this.addColumns('owed_turn', { dismissed: 'INTEGER NOT NULL DEFAULT 0' });
      this.addColumns('notification', { alert: 'INTEGER', title: 'TEXT', body: 'TEXT', look: 'TEXT', computer_in_use: 'INTEGER' });
      this.addColumns('notification_event', { seen: 'TEXT' });
      this.addColumns('checkin', { expired_at: 'INTEGER' });
      this.addColumns('visit', { depth: 'INTEGER', seen_to_ts: 'INTEGER', owed_since: 'INTEGER', owed_shown: 'INTEGER', typed: 'INTEGER NOT NULL DEFAULT 0', draft_left: 'INTEGER', exit: 'TEXT', shadow_rank: 'INTEGER' });
      this.addColumns('person', { name_source: "TEXT NOT NULL DEFAULT 'network'", face_id: 'TEXT', face_pinned: 'INTEGER NOT NULL DEFAULT 0', picture_identity_id: 'TEXT' });
      this.addColumns('attachment', { alt: 'TEXT', extra: 'TEXT' });
      this.addColumns('notice', { caught: 'INTEGER NOT NULL DEFAULT 0', shown_ts: 'INTEGER', held_at: 'INTEGER' });
      this.addColumns('place_pref', { mention_scope: 'TEXT', mention_same: 'INTEGER', pictures: 'TEXT' });
      this.addColumns('folder', { parent_id: 'TEXT', parent_pos: 'REAL' });
      this.addColumns('reaction', { at: 'INTEGER', at_exact: 'INTEGER NOT NULL DEFAULT 0' });
      const oldTriage = this.setAsideTriage();
      const oldLog = this.setAside('change_log', 'actor_id', ['change_log_target']);
      this.db.exec(schema);
      // Counted once from the messages the hub holds: the @everyone-style mentions among the unread ones.
      if (wildcardsUnknown) this.countWildcards();
      if (oldTriage) this.adoptOldTriage(oldTriage);
      if (oldLog) this.adoptOldChangeLog();
      if (broadcastsUnknown) this.markBroadcasts();
      this.adoptOldReactions(reactionsBefore);
      this.clearStars();
      this.toTiers();
      this.notifiedTimes();
      this.sourceNames();
      this.nicknamesToAccounts();
      this.facesOnce();
      this.forgetGoneSeenVia();
      this.db.query(`INSERT INTO meta (key, value) VALUES ('schema_sig', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(sig);
    })();
    timer.step('migrations');
    this.journal = new Journal(this.db);
    timer.step('journal');
    this.presenceNow = new PresenceNow(this.db, (this.db.query(`SELECT id FROM account WHERE status != 'online' OR enabled = 0`).all() as Row[]).map((r) => r.id));
    this.showResolvedTopics();
    // Messages from before full-text search existed.
    if (!this.db.query(`SELECT 1 FROM meta WHERE key = 'fts_backfilled'`).get()) {
      this.db.exec(`INSERT INTO message_fts (message_fts) VALUES ('rebuild'); INSERT INTO meta (key, value) VALUES ('fts_backfilled', '1');`);
      timer.step('search backfill');
    }
    this.refreshSelf();
    // A database with no messages yet gets every one through the triggers: nothing to fill in.
    if (!this.db.query(`SELECT 1 FROM meta WHERE key = 'search_time_ready'`).get() && !this.db.query('SELECT 1 FROM message LIMIT 1').get())
      this.db.exec(`INSERT INTO meta (key, value) VALUES ('search_time_ready', '1')`);
    this.searchTimeReady = !!this.db.query(`SELECT 1 FROM meta WHERE key = 'search_time_ready'`).get();
  }

  /**
   * The message's time on alerts and Conversations decided before their decision kept it (setTriage), for the inbox's
   * notified pick (triage_notified). Along that index, so with none left to fill it reads nothing.
   */
  private notifiedTimes() {
    this.db.exec(`UPDATE triage SET message_ts = (SELECT ts FROM message WHERE id = triage.message_id) WHERE decision IN ('push', 'quiet') AND message_ts IS NULL`);
  }

  /** The schema this database was last opened with: '' for one from before it was recorded, null for a new one. */
  private schemaSig(): string | null {
    if (!this.db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message'`).get()) return null;
    try {
      return ((this.db.query(`SELECT value FROM meta WHERE key = 'schema_sig'`).get() as Row | null)?.value as string) ?? '';
    } catch {
      return '';
    }
  }

  /**
   * The four levels became three tiers (docs/notifications.md), once. The codes stay, so nothing is rebuilt: what was
   * Important or Active becomes a Conversation in a DM or a group chat and a list row elsewhere (no old message turns
   * into an alert), Digest and below go below the list, each row keeping what it was (`was`) and taking the old Active
   * chance as its importance. Rules set to Smart become Automatic (no rule); the daily digest's settings go.
   */
  private toTiers() {
    if (this.db.query(`SELECT 1 FROM meta WHERE key = 'tiers_at'`).get()) return;
    const n = this.db
      .query(
        `UPDATE triage SET was = decision, score = COALESCE(json_extract(probs, '$.active'), score), decision = CASE
           WHEN decision IN ('push', 'quiet') THEN CASE
             WHEN (SELECT c.shape FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE m.id = triage.message_id) IN ('direct', 'group') THEN 'quiet'
             ELSE 'digest' END
           ELSE 'drop' END
         WHERE was IS NULL AND decision != 'silent'`,
      )
      .run().changes;
    const rules = this.db.query(`DELETE FROM notify_rule WHERE level = 'smart'`).run().changes;
    this.db.exec(`DELETE FROM meta WHERE key IN ('daily_digest', 'daily_digest_state'); DROP INDEX IF EXISTS triage_level_score;`);
    if (n || rules) console.log(`three tiers: ${n} decision${n === 1 ? '' : 's'} moved from the four levels, ${rules} Smart rule${rules === 1 ? '' : 's'} now Automatic`);
    this.db.query(`INSERT INTO meta (key, value) VALUES ('tiers_at', ?)`).run(String(Date.now()));
  }

  /** When this database took up the tiers: what stood before it says nothing about alerts. */
  tiersAt(): number {
    return Number((this.db.query(`SELECT value FROM meta WHERE key = 'tiers_at'`).get() as Row | null)?.value ?? 0);
  }

  /**
   * Resolved Zulip topics were hidden as an archived chat is, until 2026-11-22 (`conversation`): every one the hub met
   * resolved was hidden at once. Shown again, once; a topic hidden by hand since is not touched after.
   */
  private showResolvedTopics() {
    if (this.db.query(`SELECT 1 FROM meta WHERE key = 'zulip_resolved_shown'`).get()) return;
    const n = this.db
      .query(`UPDATE place_pref SET hidden = 0 WHERE kind = 'conversation' AND hidden = 1 AND id IN (SELECT id FROM conversation WHERE network = 'zulip' AND shape = 'thread' AND archived = 1)`)
      .run().changes;
    if (n) console.log(`zulip: ${n} resolved topic${n === 1 ? '' : 's'} shown again`);
    this.db.query(`INSERT INTO meta (key, value) VALUES ('zulip_resolved_shown', ?)`).run(String(Date.now()));
  }

  /**
   * Stars left the app on 2026-11-10 (#86), and the stars set before then are cleared, once, rather than kept as Always
   * notify: a person rule `all` is the only way to always notify now. The column stays, so nothing is dropped.
   */
  private clearStars() {
    if (this.db.query(`SELECT 1 FROM meta WHERE key = 'stars_cleared'`).get()) return;
    const n = this.db.query('UPDATE person SET starred = 0 WHERE starred != 0').run().changes;
    if (n) console.log(`stars left the app: cleared ${n} star${n === 1 ? '' : 's'}`);
    this.db.query(`INSERT INTO meta (key, value) VALUES ('stars_cleared', ?)`).run(String(Date.now()));
  }

  /**
   * Where each name came from, once, for people from before it was kept (2026-11-10): `manual` said only "merged or
   * renamed by you". A merged or renamed person whose name one of their accounts goes by (display name or handle) is
   * taken as `merge`, any other as a nickname of yours (`user`); everyone else keeps `network`.
   */
  private sourceNames() {
    if (this.db.query(`SELECT 1 FROM meta WHERE key = 'name_source_set'`).get()) return;
    const r = this.db
      .query(
        `UPDATE person SET name_source = CASE WHEN EXISTS (
           SELECT 1 FROM identity i WHERE i.person_id = person.id
             AND (lower(trim(person.name)) = lower(trim(i.display_name)) OR ltrim(lower(trim(person.name)), '@') = ltrim(lower(trim(i.handle)), '@'))
         ) THEN 'merge' ELSE 'user' END
         WHERE manual = 1 AND is_self = 0 AND name_source = 'network'`,
      )
      .run();
    if (r.changes) console.log(`names: where ${r.changes} merged or renamed ${r.changes === 1 ? 'name' : 'names'} came from`);
    this.db.query(`INSERT INTO meta (key, value) VALUES ('name_source_set', ?)`).run(String(Date.now()));
  }

  /**
   * Each person is shown by one of their accounts since 2026-11-23 (`person.face_id`, docs/chats.md "Names"), once:
   * the account whose name they have (as you see it, else its display name or handle), else one chosen as a merge
   * would. Their name and picture are then that account's: a merged person's picture had stayed as it was at the merge.
   */
  private facesOnce() {
    if (this.db.query(`SELECT 1 FROM meta WHERE key = 'person_faces'`).get()) return;
    const people = this.db.query(`SELECT id, name, avatar_url FROM person WHERE is_self = 0 AND face_id IS NULL`).all() as Row[];
    let renamed = 0;
    let repictured = 0;
    const norm = (x: unknown) => (typeof x === 'string' ? x.trim().toLowerCase().replace(/^@/, '') : null);
    for (const p of people) {
      const ids = this.db.query('SELECT * FROM identity WHERE person_id = ?').all(p.id) as Row[];
      if (!ids.length) continue;
      const named = ids.find((i) => shownName(i) === p.name) ?? ids.find((i) => [i.display_name, i.handle].some((n) => norm(n) === norm(p.name)));
      if (named) this.db.query('UPDATE person SET face_id = ? WHERE id = ?').run(named.id, p.id);
      this.refreshFace(p.id);
      const now = this.db.query('SELECT name, avatar_url FROM person WHERE id = ?').get(p.id) as Row;
      if (now.name !== p.name) renamed++;
      if (now.avatar_url !== p.avatar_url) repictured++;
    }
    if (people.length) console.log(`faces: ${people.length} people shown by one of their accounts; ${renamed} renamed, ${repictured} with a new picture`);
    this.db.query(`INSERT INTO meta (key, value) VALUES ('person_faces', ?)`).run(String(Date.now()));
  }

  /**
   * Nicknames belong to accounts since 2026-11-11, once: a person you had named (`user`) gives that name to each of
   * their accounts that has none of its own, and their name is then made from their accounts' names again.
   */
  private nicknamesToAccounts() {
    if (this.db.query(`SELECT 1 FROM meta WHERE key = 'nicknames_by_account'`).get()) return;
    const named = this.db.query(`SELECT id, name FROM person WHERE name_source = 'user'`).all() as Row[];
    for (const p of named) {
      this.db.query(`UPDATE identity SET nickname = ? WHERE person_id = ? AND (nickname IS NULL OR nickname = '')`).run(p.name, p.id);
      const n = (this.db.query('SELECT COUNT(*) AS n FROM identity WHERE person_id = ?').get(p.id) as Row).n as number;
      // One account: its name now, which is the nickname. Several keep the name, an account's now (`merge`).
      if (n === 1) this.refreshFace(p.id);
      else this.db.query(`UPDATE person SET manual = 1, name_source = 'merge' WHERE id = ?`).run(p.id);
    }
    if (named.length) console.log(`names: ${named.length} nickname${named.length === 1 ? '' : 's'} moved onto the accounts of the person named`);
    this.db.query(`INSERT INTO meta (key, value) VALUES ('nicknames_by_account', ?)`).run(String(Date.now()));
  }

  /**
   * People seen only through an account since removed kept it as theirs (deleteAccount did not clear it before), so
   * their pictures were asked of an account that is not there, and the account added again never took its place.
   */
  private forgetGoneSeenVia() {
    if (this.db.query(`SELECT 1 FROM meta WHERE key = 'seen_via_gone'`).get()) return;
    this.db.exec('UPDATE identity SET seen_via = NULL WHERE seen_via IS NOT NULL AND seen_via NOT IN (SELECT id FROM account)');
    this.db.exec(`INSERT INTO meta (key, value) VALUES ('seen_via_gone', '1')`);
  }

  /**
   * backups/pre-migrate-<time>.sqlite next to the database, the newest two kept (DITHER_PRE_MIGRATE_KEEP). Not for an
   * in-memory database, and not when the deployer copied it to backups/pre-deploy.sqlite moments ago, before this
   * restart (PRE_DEPLOY_FRESH_MS): that copy is the same database, and each copy is gigabytes.
   */
  private snapshotBeforeMigrating(path: string) {
    if (path === ':memory:' || path === '') return;
    const dir = join(dirname(path), 'backups');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const preDeploy = join(dir, 'pre-deploy.sqlite');
    if (existsSync(preDeploy) && Date.now() - statSync(preDeploy).mtimeMs < PRE_DEPLOY_FRESH_MS) {
      console.log(`schema changed: ${preDeploy} was copied just before this start, so no second copy before migrating`);
      return;
    }
    const file = join(dir, `pre-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    chmodSync(file, 0o600);
    console.log(`schema changed: copied the database to ${file} before migrating`);
    const old = readdirSync(dir).filter((f) => /^pre-migrate-.*\.sqlite$/.test(f)).sort();
    const keep = Number(process.env.DITHER_PRE_MIGRATE_KEEP) || 2;
    for (const f of old.slice(0, Math.max(0, old.length - keep))) rmSync(join(dir, f), { force: true });
  }

  // ------------------------------------------------------------ triage queue and retention

  /** Live messages handed to triage (main.ts), until it has decided them. */
  pendTriage(ids: readonly string[], at = Date.now()) {
    const q = this.db.query('INSERT OR IGNORE INTO triage_pending (message_id, at) VALUES (?, ?)');
    this.db.transaction(() => {
      for (const id of ids) q.run(id, at);
    })();
  }

  triageDone(id: string) {
    this.db.query('DELETE FROM triage_pending WHERE message_id = ?').run(id);
  }

  /**
   * What a crash or restart left undecided: those handed over since `since` to decide now, in order; older ones are
   * too late to notify about and are let go.
   */
  takePendingTriage(since: number): string[] {
    const ids = (this.db.query('SELECT message_id FROM triage_pending WHERE at >= ? ORDER BY at, rowid').all(since) as Row[]).map((r) => r.message_id as string);
    this.db.query('DELETE FROM triage_pending WHERE at < ?').run(since);
    return ids;
  }

  /**
   * Triage rows nobody will learn from: older than `keepDays`, in conversations you have never written in, never
   * marked, and below the list. Learning reads two weeks (votes.ts) and the replay a few (docs/
   * triage-replay.md), so the default 90 days keeps every label. At most `limit` rows a call. Returns how many went.
   */
  pruneTriage(now = Date.now(), keepDays = Number(process.env.DITHER_TRIAGE_KEEP_DAYS) || 90, limit = 5000): number {
    const self = [...this.selfIdentities];
    const marks = self.map(() => '?').join(',');
    const yours = self.length ? `SELECT DISTINCT conversation_id FROM message WHERE author_id IN (${marks})` : 'SELECT NULL WHERE 0';
    const r = this.db.query(Store.pruneTriageSql(yours)).run(now - keepDays * 86_400_000, ...self, limit);
    return r.changes;
  }

  /**
   * By age first (`triage_created`), not by tier: the tier index walked every row below the list to find the old
   * ones, about a second on the live hub every six hours when none were old enough (`+t.decision` keeps it off it).
   */
  static pruneTriageSql(yours: string): string {
    return `DELETE FROM triage WHERE rowid IN (
           SELECT t.rowid FROM triage t JOIN message m ON m.id = t.message_id
           WHERE t.created_at < ? AND t.feedback IS NULL AND t.marked_at IS NULL AND t.explore IS NULL AND +t.decision IN ('drop', 'silent')
             AND m.conversation_id NOT IN (${yours})
           LIMIT ?)`;
  }

  /**
   * A triage table from before Active (decision 'quiet') and votes by level: its CHECK cannot be changed in place, so
   * it is set aside, the schema makes the new one, and the rows come across with "should push" as a vote for Important
   * and "should not push" as one for Digest.
   */
  private setAsideTriage(): 'v1' | 'v2' | null {
    const t = this.db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'triage'`).get() as Row | null;
    if (!t || t.sql.includes("'drop'")) return null;
    this.db.exec('DROP INDEX IF EXISTS triage_created; DROP INDEX IF EXISTS triage_feedback; ALTER TABLE triage RENAME TO triage_v1');
    return t.sql.includes("'quiet'") ? 'v2' : 'v1';
  }

  /** v2 (before 'drop', below the digest): the rows as they are. v1 (before Active): "should push" as a vote for Important. */
  private adoptOldTriage(from: 'v1' | 'v2') {
    if (from === 'v2')
      this.db.exec(`INSERT OR IGNORE INTO triage (message_id, decision, score, reasons, decided_by, feedback, feedback_at, facts, created_at)
        SELECT message_id, decision, score, reasons, decided_by, feedback, feedback_at, facts, created_at FROM triage_v1;
        DROP TABLE triage_v1;`);
    else
      this.db.exec(`INSERT OR IGNORE INTO triage (message_id, decision, score, reasons, decided_by, feedback, feedback_at, created_at)
        SELECT message_id, decision, score, reasons, decided_by,
               CASE feedback WHEN 'should_push' THEN 'push' WHEN 'should_not_push' THEN 'digest' END,
               CASE WHEN feedback IS NOT NULL THEN created_at END, created_at
        FROM triage_v1;
        DROP TABLE triage_v1;`);
  }

  /**
   * A table whose CHECK or shape changed: renamed to <name>_v1 (with its indexes dropped, so the schema can make them
   * again) when it lacks `marker`, for an adopt step to copy over after the schema runs.
   */
  private setAside(table: string, marker: string, indexes: string[]): boolean {
    const t = this.db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as Row | null;
    if (!t || t.sql.includes(marker)) return false;
    for (const i of indexes) this.db.exec(`DROP INDEX IF EXISTS ${i}`);
    this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_v1`);
    return true;
  }

  /** The first change log kept text and mixed edits in: values become JSON, edits move to message_event. */
  private adoptOldChangeLog() {
    this.db.exec(`INSERT INTO change_log (target_kind, target_id, field, old, new, at, account_id)
      SELECT target_kind, target_id, field, json_quote(old), json_quote(new), at, account_id FROM change_log_v1 WHERE target_kind != 'message';
      INSERT INTO message_event (message_id, kind, data, at, account_id)
      SELECT target_id, 'edit', json_object('body', old), at, account_id FROM change_log_v1
      WHERE target_kind = 'message' AND field = 'body' AND target_id IN (SELECT id FROM message);
      DROP TABLE change_log_v1;`);
  }

  /** Columns added since a table was first made. Nothing to do for a new database: the schema has them. */
  private addColumns(table: string, cols: Record<string, string>) {
    const have = (this.db.query(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name);
    if (!have.length) return;
    for (const [name, type] of Object.entries(cols)) if (!have.includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }

  /** A table that exists and has no such column. */
  private lacksColumn(table: string, col: string): boolean {
    const have = (this.db.query(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name);
    return have.length > 0 && !have.includes(col);
  }

  /** Each conversation's unread @everyone-style mentions, from its messages since the read point, at most its mentions. */
  private countWildcards() {
    this.db.exec(`UPDATE vantage SET wildcards = MIN(mentions, (
        SELECT COUNT(*) FROM message m JOIN message_seen s ON s.message_id = m.id AND s.account_id = vantage.account_id
        WHERE m.conversation_id = vantage.target_id AND m.ts > COALESCE(vantage.last_read_ts, 0) AND m.deleted = 0 AND m.mentions_self = 1 AND m.mentions_all = 1))
      WHERE target_kind = 'conversation' AND mentions > 0`);
  }

  /** Message tables from before @everyone was told apart from a mention by name get the column. */
  private addMentionsAll(): boolean {
    const cols = (this.db.query('PRAGMA table_info(message)').all() as Row[]).map((c) => c.name);
    if (!cols.length || cols.includes('mentions_all')) return false;
    this.db.exec('ALTER TABLE message ADD COLUMN mentions_all INTEGER NOT NULL DEFAULT 0');
    return true;
  }

  /**
   * Discord messages stored before then counted @everyone and @here as mentions of you. Told apart once, by the
   * text: a mention that says @everyone or @here and does not name any of your accounts.
   */
  private markBroadcasts() {
    const selves = (this.db.query(`SELECT i.native_id FROM account a JOIN identity i ON i.id = a.self_identity WHERE a.network = 'discord'`).all() as Row[]).map((r) => `%<@${r.native_id}>%`);
    this.db
      .query(
        `UPDATE message SET mentions_all = 1 WHERE network = 'discord' AND mentions_self = 1 AND (body LIKE '%@everyone%' OR body LIKE '%@here%')${selves.map(() => ' AND body NOT LIKE ?').join('')}`,
      )
      .run(...selves);
  }

  /** Reaction rows from before styles and tallies existed; drops the old table so the schema can rebuild it. */
  private oldReactions(): Row[] {
    const cols = this.db.query('PRAGMA table_info(reaction)').all() as Row[];
    if (!cols.length || cols.some((c) => c.name === 'style')) return [];
    const rows = this.db.query('SELECT message_id, identity_id, key FROM reaction ORDER BY rowid').all() as Row[];
    this.db.exec('DROP TABLE reaction');
    return rows;
  }

  private adoptOldReactions(rows: Row[]) {
    for (const r of rows) {
      const key = canonicalReactionKey(r.key);
      this.db.query('INSERT OR IGNORE INTO reaction (message_id, identity_id, key) VALUES (?, ?, ?)').run(r.message_id, r.identity_id, key);
      this.db.query('INSERT OR IGNORE INTO reaction_tally (message_id, key) VALUES (?, ?)').run(r.message_id, key);
    }
  }

  // ------------------------------------------------------------ accounts

  accounts(): AccountRow[] {
    return this.db.query('SELECT * FROM account ORDER BY position, created_at').all() as AccountRow[];
  }

  account(id: string): AccountRow | null {
    return (this.db.query('SELECT * FROM account WHERE id = ?').get(id) as AccountRow) ?? null;
  }

  createAccount(a: { network: P.Network; label: string; color: string; adapter: string; config?: unknown; demo?: boolean; id?: string }): AccountRow {
    const id = a.id ?? randomId('acc');
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
    const pos = (this.db.query('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM account').get() as Row).p;
    this.db
      .query(
        `INSERT INTO account (id, network, label, color, adapter, config, token, demo, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, a.network, a.label, a.color, a.adapter, JSON.stringify(a.config ?? {}), token, a.demo ? 1 : 0, pos, Date.now());
    this.dirty.accounts.add(id);
    return this.account(id)!;
  }

  updateAccount(id: string, patch: Partial<Pick<AccountRow, 'label' | 'color' | 'config' | 'enabled' | 'status' | 'attention' | 'live_view' | 'capabilities' | 'self_identity'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.query(`UPDATE account SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] as any), id);
    this.dirty.accounts.add(id);
    // An account not online hears no one: what it heard is unknown while it is down (hidden, not forgotten: adapters
    // tell only changes, so what it told is still the truth when it is back, and anything else comes as a change).
    if (patch.status !== undefined || patch.enabled !== undefined) {
      const a = this.account(id);
      if (a) this.presenceNow.accountUp(id, a.status === 'online' && !!a.enabled);
    }
  }

  /** Remove an account and everything that only it could see. */
  deleteAccount(id: string) {
    // Places another account still sees lose this one's vantage: they change rather than go.
    const seen = this.db.query('SELECT target_kind, target_id FROM vantage WHERE account_id = ?').all(id) as Row[];
    const tx = this.db.transaction(() => {
      this.db.query('DELETE FROM account WHERE id = ?').run(id);
      this.db.query('DELETE FROM about WHERE account_id = ?').run(id);
      // Pictures are fetched through the account that saw someone: one that is gone cannot, so the next account to
      // see them takes its place (seen_via is only set where it is empty).
      this.db.query('UPDATE identity SET seen_via = NULL WHERE seen_via = ?').run(id);
      const orphanConvs = this.db
        .query(`SELECT id FROM conversation c WHERE NOT EXISTS (SELECT 1 FROM vantage v WHERE v.target_kind = 'conversation' AND v.target_id = c.id)`)
        .all() as Row[];
      for (const c of orphanConvs) {
        this.db.query('DELETE FROM conversation WHERE id = ?').run(c.id);
        this.db.query(`DELETE FROM space_edge WHERE child_kind = 'conversation' AND child_id = ?`).run(c.id);
        this.db.query('DELETE FROM folder_item WHERE item_kind = ? AND item_id = ?').run('conversation', c.id);
        this.dirty.removed.push({ t: 'conversation.removed', id: c.id });
      }
      const orphanSpaces = this.db
        .query(`SELECT id FROM space s WHERE NOT EXISTS (SELECT 1 FROM vantage v WHERE v.target_kind = 'space' AND v.target_id = s.id)`)
        .all() as Row[];
      for (const s of orphanSpaces) {
        this.db.query('DELETE FROM space WHERE id = ?').run(s.id);
        this.forgetMembers(s.id);
        this.db.query('DELETE FROM space_edge WHERE parent_id = ? OR (child_kind = ? AND child_id = ?)').run(s.id, 'space', s.id);
        this.db.query('DELETE FROM folder_item WHERE item_kind = ? AND item_id = ?').run('space', s.id);
        this.dirty.removed.push({ t: 'space.removed', id: s.id });
      }
      // People known by their mail have no chat to keep them: mail/people.ts lets them go with their mail.
      const orphanPersons = this.db
        .query(`SELECT id FROM person p WHERE is_self = 0 AND NOT EXISTS (SELECT 1 FROM identity i WHERE i.person_id = p.id
                  AND (i.network = 'email' OR EXISTS (SELECT 1 FROM participant pa WHERE pa.identity_id = i.id) OR EXISTS (SELECT 1 FROM message m WHERE m.author_id = i.id)))`)
        .all() as Row[];
      for (const p of orphanPersons) {
        for (const i of this.db.query('SELECT id FROM identity WHERE person_id = ?').all(p.id) as Row[]) this.dirty.identities.add(i.id);
        this.db.query('UPDATE identity SET person_id = NULL WHERE person_id = ?').run(p.id);
        this.db.query('DELETE FROM person WHERE id = ?').run(p.id);
        this.db.query('DELETE FROM folder_item WHERE item_kind = ? AND item_id = ?').run('person', p.id);
        this.dirty.removed.push({ t: 'person.removed', id: p.id });
      }
    });
    tx();
    this.presenceNow.forgetAccount(id);
    this.refreshSelf();
    for (const v of seen) {
      const exists = this.db.query(`SELECT 1 FROM ${v.target_kind === 'space' ? 'space' : 'conversation'} WHERE id = ?`).get(v.target_id);
      if (exists) (v.target_kind === 'space' ? this.dirty.spaces : this.dirty.conversations).add(v.target_id);
    }
    for (const i of this.dirty.identities) if (!this.db.query('SELECT 1 FROM identity WHERE id = ?').get(i)) this.dirty.identities.delete(i);
    this.dirty.removed.push({ t: 'account.removed', id });
  }

  /**
   * A reader's memory of the database, read again: the hub's thread may have changed it since (your accounts, what is
   * kept, the time index filled in). The people list follows from what peopleChanged hands it.
   */
  beforeRead() {
    this.refreshSelf();
    this.retentionCache = null;
    if (!this.searchTimeReady) this.searchTimeReady = !!this.db.query(`SELECT 1 FROM meta WHERE key = 'search_time_ready'`).get();
  }

  private refreshSelf() {
    this.selfIdentities.clear();
    for (const r of this.db.query('SELECT self_identity FROM account WHERE self_identity IS NOT NULL').all() as Row[]) {
      this.selfIdentities.add(r.self_identity);
    }
    // Another id of yours on the same network (IdentityFact.sameAs: your Partiful chat id) is you too.
    for (const r of this.db.query('SELECT s.identity_id FROM identity_same s JOIN account a ON a.self_identity = s.same_as').all() as Row[]) {
      this.selfIdentities.add(r.identity_id);
    }
  }

  isSelf(identityId: string | null) {
    return !!identityId && this.selfIdentities.has(identityId);
  }

  // ------------------------------------------------------------ ingest

  /** Apply one adapter event. Returns ids of new live messages that need triage. */
  ingest(acc: AccountRow, ev: P.AdapterEvent): string[] {
    const fresh: string[] = [];
    const tx = this.db.transaction(() => {
      switch (ev.t) {
        case 'hello': {
          this.updateAccount(acc.id, { capabilities: JSON.stringify(ev.capabilities) });
          // An adapter from before versions (no number) is taken as it is; one that names another version is flagged,
          // and stays flagged through its status updates until an adapter that matches says hello.
          const other = typeof ev.protocol === 'number' && ev.protocol !== PROTOCOL_VERSION;
          if (other) {
            const message = `This adapter speaks protocol ${ev.protocol} and the hub ${PROTOCOL_VERSION}: update ${(ev.protocol ?? 0) > PROTOCOL_VERSION ? 'this hub' : 'the adapter (dither-accounts)'} so they match`;
            this.protocolWarnings.set(acc.id, message);
            this.updateAccount(acc.id, { attention: JSON.stringify({ kind: 'unknown', message, since: Date.now() }) });
          } else if (this.protocolWarnings.delete(acc.id)) this.updateAccount(acc.id, { attention: null });
          break;
        }
        case 'status': {
          const patch: Parameters<Store['updateAccount']>[1] = { status: ev.status };
          if (ev.attention !== undefined) {
            const prev = json<P.Attention | null>(acc.attention, null);
            patch.attention = ev.attention
              ? JSON.stringify({ ...ev.attention, since: prev && prev.kind === ev.attention.kind ? prev.since : Date.now() })
              : null;
          } else if (ev.status === 'online') {
            const warning = this.protocolWarnings.get(acc.id);
            patch.attention = warning ? JSON.stringify({ kind: 'unknown', message: warning, since: Date.now() }) : null;
          }
          if (ev.liveView !== undefined) patch.live_view = ev.liveView ? JSON.stringify(ev.liveView) : null;
          if (ev.self) {
            const sid = this.identity(acc, { ...ev.self, isSelf: true });
            patch.self_identity = sid;
          }
          this.updateAccount(acc.id, patch);
          break;
        }
        case 'identity':
          this.identity(acc, ev.identity);
          break;
        case 'space':
          this.space(acc, ev.space);
          break;
        case 'conversation':
          this.conversation(acc, ev.conversation);
          // A thread's following and tags, a forum's tags (threads.ts).
          ingestThreadFacts(this, acc, ev.conversation);
          break;
        case 'leave':
          this.leave(acc, ev.kind, ev.nativeId);
          break;
        case 'message': {
          const id = this.message(acc, ev.message, !!ev.live, lateNews(ev));
          if (id) fresh.push(id);
          // Their message ends their typing, as in Discord's client, whether or not the network says so.
          if (ev.live) this.typingStopped(hubId('cnv', acc.network, ev.message.conversation), hubId('idn', acc.network, ev.message.author));
          break;
        }
        case 'delete':
          this.gone(acc, hubId('msg', acc.network, ev.nativeId), ev.reason === 'expired' ? 'disappeared' : 'deleted');
          break;
        case 'reaction': {
          const mid = hubId('msg', acc.network, ev.message);
          if (!this.db.query('SELECT 1 FROM message WHERE id = ?').get(mid)) break;
          this.applyReaction(acc, mid, ev);
          this.markReacted(mid);
          break;
        }
        case 'pin': {
          const mid = hubId('msg', acc.network, ev.message);
          if (!this.db.query('SELECT 1 FROM message WHERE id = ?').get(mid) || !this.retention().changes) break;
          this.messageEvent(mid, ev.pinned ? 'pin' : 'unpin', null, ev.by ? this.ensureIdentity(acc, ev.by) : null, acc.id, ev.ts ?? Date.now());
          break;
        }
        case 'pollUpdate': {
          // Votes are not news in themselves, as reactions are not (polls.ts).
          const { t: _t, ...u } = ev;
          if (applyPollUpdate(this.db, acc.network, (n) => this.ensureIdentity(acc, n), u)) this.markReacted(hubId('msg', acc.network, ev.message));
          break;
        }
        case 'role': {
          const kind = ev.target.kind;
          const tid = hubId(kind === 'space' ? 'spc' : 'cnv', acc.network, ev.target.nativeId);
          const who = this.ensureIdentity(acc, ev.member);
          const role = { identityId: who, role: ev.role, ...(ev.color ? { color: ev.color } : {}) };
          this.logChange(kind, tid, 'role', ev.given ? null : role, ev.given ? role : null, acc.id, ev.ts ?? Date.now(), ev.by ? this.ensureIdentity(acc, ev.by) : null);
          break;
        }
        case 'customStatus':
          this.setStatus(this.ensureIdentity(acc, ev.who), ev.text || ev.emoji ? { text: ev.text, emoji: ev.emoji } : null, acc.id, ev.ts);
          break;
        case 'presence': {
          // The latest state always (status dots, presence.ts), of someone the hub knows: it makes no identity for it.
          // Presence over time only while it is logged, as before.
          const logs = this.logsPresence();
          const known = hubId('idn', acc.network, ev.who);
          const iid = logs ? this.ensureIdentity(acc, ev.who) : this.db.query('SELECT 1 FROM identity WHERE id = ?').get(known) ? known : null;
          if (!iid || this.isSelf(iid)) break;
          this.presenceNow.set(iid, ev.state, ev.devices, acc.id, ev.ts);
          if (logs) this.setPresence(iid, ev.state, ev.devices, acc.id, ev.ts);
          break;
        }
        case 'receipt':
          this.receipt(acc, ev);
          break;
        case 'members':
          this.members(acc, ev);
          break;
        case 'reactionsCleared': {
          const mid = hubId('msg', acc.network, ev.message);
          const key = ev.key === undefined ? null : canonicalReactionKey(ev.key);
          // A moderator clearing reactions: what was there, kept like any reaction taken back.
          const now = { at: Date.now(), exact: false };
          for (const r of this.db.query('SELECT identity_id, key, style, at, at_exact FROM reaction WHERE message_id = ? AND (? IS NULL OR key = ?)').all(mid, key, key) as Row[])
            this.takenBack(acc, mid, r.identity_id, r.key, r.style, r, now, true);
          this.db.query('DELETE FROM reaction WHERE message_id = ? AND (? IS NULL OR key = ?)').run(mid, key, key);
          this.db.query('DELETE FROM reaction_tally WHERE message_id = ? AND (? IS NULL OR key = ?)').run(mid, key, key);
          this.markReacted(mid);
          break;
        }
        case 'read': {
          const cid = hubId('cnv', acc.network, ev.conversation);
          // Ignore read state for a conversation we haven't been told about yet,
          // so we don't leave an orphan vantage pointing at nothing.
          if (!this.db.query('SELECT 1 FROM conversation WHERE id = ?').get(cid)) break;
          this.ensureVantage(acc.id, 'conversation', cid);
          const v = this.db.query(`SELECT last_read_ts FROM vantage WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`).get(acc.id, cid) as Row;
          // Marked unread on the network by hand: the read point moves back (attention.ts). Otherwise only forward.
          const upTo = ev.manual === true ? ev.upToTs : Math.max(v?.last_read_ts ?? 0, ev.upToTs);
          const counts = ev.unread !== undefined ? this.networkCounts(acc, cid, upTo, ev) : this.countUnread(acc, cid, upTo);
          this.db
            .query(`UPDATE vantage SET last_read_ts = ?, unread = ?, mentions = ?, wildcards = ? WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`)
            .run(upTo, counts.unread, counts.mentions, counts.wildcards, acc.id, cid);
          this.dirty.conversations.add(cid);
          break;
        }
        case 'typing': {
          const cid = hubId('cnv', acc.network, ev.conversation);
          const iid = hubId('idn', acc.network, ev.author);
          // You, typing on another of your accounts or devices, are not news.
          if (this.isYou(iid)) break;
          if (ev.stop) {
            this.typingStopped(cid, iid);
            break;
          }
          const ttl = typingTtl(ev.ttl);
          this.typers.start(cid, iid, ttl);
          const name = ev.name && !(this.db.query('SELECT display_name FROM identity WHERE id = ?').get(iid) as Row | null)?.display_name ? ev.name : undefined;
          this.dirty.extra.push({ t: 'typing', conversationId: cid, identityId: iid, ttl, ...(name ? { name } : {}) });
          break;
        }
        case 'requests':
        case 'request':
        case 'requestGone':
          ingestRequests(this, acc, ev);
          break;
        case 'relationships':
        case 'relationship':
          ingestRelationships(this, acc, ev);
          break;
        case 'notices':
        case 'selfState':
        case 'ignored':
          ingestSelf(this, acc, ev);
          break;
        // Calls ringing you, voice channels' people and status lines (callstate.ts).
        case 'callState':
        case 'voice':
        case 'voiceStatus':
          ingestCallEvent(this, acc, ev);
          break;
        case 'scheduledEvents':
        case 'scheduledEvent':
        case 'scheduledEventGone':
        case 'gate':
          ingestServers(this, acc, ev);
          break;
        // An interaction's outcome and a form a bot opened (apps.ts): to the page as they come.
        case 'interaction':
        case 'appModal':
          ingestApps(this, acc, ev);
          break;
        // Stories: on their author's page only, never a message (media.ts).
        case 'story':
        case 'storyGone':
          ingestStories(this, acc, ev);
          break;
        // Saved on the network, and its reminders (saved.ts).
        case 'saved':
        case 'unsaved':
        case 'reminderDue':
          ingestSaved(this, acc, ev, (r) => this.reminderDue?.(r));
          break;
        case 'personAbout':
          // What the network showed unasked (X: the people in your notifications), kept as an asked profile is.
          keepAbout(this, this.ensureIdentity(acc, ev.who), acc.id, acc.network, ev.about, ev.ts, true);
          break;
        case 'reply':
        case 'log':
          break;
      }
    });
    tx();
    return fresh;
  }

  /**
   * The network's own counts. Of its mentions, the @everyone-style ones are as it says, else as many as the hub holds
   * unread (an adapter from before `wildcards`, or a network that does not tell them apart).
   */
  private networkCounts(acc: AccountRow, cid: string, afterTs: number, ev: { unread?: number; mentions?: number; wildcards?: number }) {
    const mentions = Math.max(0, ev.mentions ?? 0);
    const wildcards = ev.wildcards ?? (mentions ? this.countUnread(acc, cid, afterTs).wildcards : 0);
    return { unread: ev.unread ?? 0, mentions, wildcards: Math.max(0, Math.min(mentions, wildcards)) };
  }

  private countUnread(acc: AccountRow, cid: string, afterTs: number) {
    const r = this.db
      .query(
        `SELECT COUNT(*) AS unread, COALESCE(SUM(m.mentions_self), 0) AS mentions, COALESCE(SUM(m.mentions_self * m.mentions_all), 0) AS wildcards FROM message m
         JOIN message_seen s ON s.message_id = m.id AND s.account_id = ?
         WHERE m.conversation_id = ? AND m.ts > ? AND m.deleted = 0 AND (m.author_id IS NULL OR m.author_id != ?)`,
      )
      .get(acc.id, cid, afterTs, acc.self_identity ?? '') as Row;
    return { unread: r.unread as number, mentions: r.mentions as number, wildcards: r.wildcards as number };
  }

  private ensureVantage(accountId: string, kind: 'space' | 'conversation', id: string, nativeMute?: P.NativeMute) {
    this.db
      .query(
        `INSERT INTO vantage (account_id, target_kind, target_id, native_mute) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, target_kind, target_id) DO UPDATE SET native_mute = COALESCE(excluded.native_mute, native_mute)`,
      )
      .run(accountId, kind, id, nativeMute ? JSON.stringify(nativeMute) : null);
  }

  private typingStopped(conversationId: string, identityId: string) {
    if (this.typers.stop(conversationId, identityId)) this.dirty.extra.push({ t: 'typing', conversationId, identityId, stop: true });
  }

  /** One of your own accounts, or an identity merged into you. */
  private isYou(identityId: string): boolean {
    if (this.selfIdentities.has(identityId)) return true;
    return !!this.db.query('SELECT 1 FROM identity i JOIN person p ON p.id = i.person_id WHERE i.id = ? AND p.is_self = 1').get(identityId);
  }

  ensureIdentity(acc: AccountRow, nativeId: string): string {
    const id = hubId('idn', acc.network, nativeId);
    const added = this.db
      .query('INSERT OR IGNORE INTO identity (id, network, native_id, seen_via, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, acc.network, nativeId, acc.id, Date.now()).changes;
    // Someone new, by id only so far: clients learn of them like any other identity.
    if (added) this.dirty.identities.add(id);
    return id;
  }

  /**
   * An email address as an identity (mail/people.ts): no account owns it, the address is its id and handle, and its
   * name is the one mail gives it. A null name keeps the one it has.
   */
  emailIdentity(address: string, name: string | null): string {
    const e = address.trim().toLowerCase();
    const id = hubId('idn', 'email', e);
    const before = this.db.query('SELECT display_name, person_id FROM identity WHERE id = ?').get(id) as Row | null;
    if (!before) {
      this.db.query('INSERT INTO identity (id, network, native_id, handle, display_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'email', e, e, name, Date.now());
      this.dirty.identities.add(id);
    } else if (name && name !== before.display_name) {
      this.db.query('UPDATE identity SET display_name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
      this.dirty.identities.add(id);
      if (before.person_id) this.refreshFace(before.person_id);
    }
    return id;
  }

  /**
   * One of your own mail addresses as an email identity of yours (docs/mail.md "Mail as chats"): it belongs to the self
   * person, made as a chat account's own identity makes it when there is none yet, so mail you sent reads as yours
   * wherever an identity's person is checked. An address already given to someone else by a merge is left as it is.
   */
  ownEmailIdentity(address: string, name: string | null): string {
    const id = this.emailIdentity(address, name);
    const r = this.db.query('SELECT person_id FROM identity WHERE id = ?').get(id) as Row | null;
    if (r && !r.person_id) this.linkSelf(id, { nativeId: address, handle: address, ...(name ? { displayName: name } : {}) });
    return id;
  }

  /**
   * Email identities whose mail is all gone from the hub (its account was deleted): each leaves its person, a person
   * left with nothing goes, and the identity goes. A person you named or merged keeps it, as it keeps chat ones.
   */
  dropEmailIdentities(ids: string[]) {
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        const r = this.db.query(`SELECT i.person_id, p.manual, p.is_self, (SELECT COUNT(*) FROM identity o WHERE o.person_id = i.person_id AND o.id != i.id) AS others
                                 FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.id = ? AND i.network = 'email'`).get(id) as Row | null;
        // Your own addresses (ownEmailIdentity) stay with you.
        if (!r || (r.person_id && (r.manual || r.others || r.is_self))) continue;
        this.db.query('DELETE FROM identity WHERE id = ?').run(id);
        this.db.query('DELETE FROM about WHERE target_id = ?').run(id);
        this.dirty.identities.delete(id);
        if (r.person_id) {
          this.db.query('DELETE FROM person WHERE id = ?').run(r.person_id);
          this.db.query(`DELETE FROM folder_item WHERE item_kind = 'person' AND item_id = ?`).run(r.person_id);
          this.dirty.persons.delete(r.person_id);
          this.dirty.removed.push({ t: 'person.removed', id: r.person_id });
        }
      }
    });
    tx();
  }

  private identity(acc: AccountRow, f: P.IdentityFact): string {
    const id = hubId('idn', acc.network, f.nativeId);
    const before = this.db.query('SELECT handle, display_name, avatar_url, is_bot FROM identity WHERE id = ?').get(id) as Row | null;
    // A stub (an id with nothing known yet) filling in is not a change.
    if (before && (before.display_name || before.handle))
      this.logChanges('identity', id, acc.id, [
        ['displayName', before.display_name, f.displayName],
        ['handle', before.handle, f.handle],
        ['avatar', before.avatar_url, f.avatarUrl],
      ]);
    this.db
      .query(
        `INSERT INTO identity (id, network, native_id, handle, display_name, avatar_url, is_bot, seen_via, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network, native_id) DO UPDATE SET
           handle = COALESCE(excluded.handle, handle),
           display_name = COALESCE(excluded.display_name, display_name),
           avatar_url = COALESCE(excluded.avatar_url, avatar_url),
           is_bot = MAX(is_bot, excluded.is_bot),
           seen_via = COALESCE(seen_via, excluded.seen_via),
           updated_at = excluded.updated_at`,
      )
      .run(id, acc.network, f.nativeId, f.handle ?? null, f.displayName ?? null, f.avatarUrl ?? null, f.isBot ? 1 : 0, acc.id, Date.now());
    const after = this.db.query('SELECT handle, display_name, avatar_url, is_bot, person_id FROM identity WHERE id = ?').get(id) as Row;
    const changed =
      !before || before.handle !== after.handle || before.display_name !== after.display_name || before.avatar_url !== after.avatar_url || before.is_bot !== after.is_bot;
    if (changed) this.dirty.identities.add(id);

    if (!f.isSelf && (f.nickname !== undefined || f.note !== undefined)) this.networkNotes(id, f);
    if (f.isSelf) {
      this.linkSelf(id, f);
      if (acc.self_identity !== id) {
        this.updateAccount(acc.id, { self_identity: id });
        acc.self_identity = id;
      }
      this.selfIdentities.add(id);
      // Your own identity is never a dot, though it was heard before it was known as yours.
      this.presenceNow.forget(id);
    } else if (f.contact) {
      // A contact always has a person; one first heard without a name (Signal before its profile arrives) is named by
      // its id, so a later name or picture reaches the person too (the person keeps a name you gave it: manual).
      const pid = this.ensurePerson(id);
      if (changed && after.person_id) this.refreshFace(pid);
    } else if (changed && after.person_id) {
      this.refreshFace(after.person_id);
    }
    if (typeof f.sameAs === 'string' && f.sameAs && f.sameAs !== f.nativeId && !f.isSelf) this.sameAccount(acc, id, f.sameAs);
    return id;
  }

  /**
   * The network said this identity is the same account as another id of its own (IdentityFact.sameAs): the first time,
   * the two go with one person (the other's, kept). Said again, nothing moves, so a split you made since stays.
   */
  private sameAccount(acc: AccountRow, id: string, nativeId: string) {
    const other = hubId('idn', acc.network, nativeId);
    if (this.db.query('SELECT 1 FROM identity_same WHERE identity_id = ? AND same_as = ?').get(id, other)) return;
    this.db
      .query('INSERT INTO identity (id, network, native_id, seen_via, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (network, native_id) DO NOTHING')
      .run(other, acc.network, nativeId, acc.id, Date.now());
    this.db.query('INSERT INTO identity_same (identity_id, same_as, at) VALUES (?, ?, ?) ON CONFLICT (identity_id) DO UPDATE SET same_as = excluded.same_as, at = excluded.at').run(id, other, Date.now());
    const of = (i: string) => (this.db.query('SELECT person_id FROM identity WHERE id = ?').get(i) as Row | null)?.person_id as string | null;
    if (this.isSelf(id)) return;
    if (this.isSelf(other)) {
      // Your own other id: you, with your own person, and your messages from it are yours.
      this.selfIdentities.add(id);
      this.presenceNow.forget(id);
      this.dirty.identities.add(id);
      const pid = of(other);
      const was = of(id);
      // A person it was given as a stranger (a direct chat's other side) goes into yours.
      if (pid && was && was !== pid) this.mergePersons(pid, was);
      else if (pid && !was) {
        this.db.query('UPDATE identity SET person_id = ? WHERE id = ?').run(pid, id);
        this.dirty.persons.add(pid);
      }
      return;
    }
    const into = of(other) ?? this.ensurePerson(other);
    const from = of(id);
    if (from === into) return;
    if (from) return this.mergePersons(into, from);
    this.db.query('UPDATE identity SET person_id = ? WHERE id = ?').run(into, id);
    this.refreshFace(into);
    this.dirty.persons.add(into);
    this.dirty.identities.add(id);
    this.touchDirectsOf(into);
    this.personsChanged?.([into]);
  }

  /** Your nickname or note went back to the network (server.ts pushes it through an account with 'contactNotes'). */
  contactNotesOut?: (identityId: string, change: { nickname?: string; note?: string }) => void;

  /**
   * Your private nickname and note for someone as their network keeps them (IdentityFact nickname and note: Signal's).
   * A change there is taken here when what is here is still what the network said before, or nothing. When both sides
   * changed: the nickname here stays (the network keeps its own), and the two notes are joined and the joined note
   * goes back, so neither side's text is lost.
   */
  private networkNotes(id: string, f: P.IdentityFact) {
    const r = this.db.query('SELECT nickname, net_nickname, net_note, person_id FROM identity WHERE id = ?').get(id) as Row;
    if (typeof f.nickname === 'string' && f.nickname !== r.net_nickname) {
      const mine = r.nickname ?? '';
      this.db.query('UPDATE identity SET net_nickname = ? WHERE id = ?').run(f.nickname, id);
      if (mine !== f.nickname && (!mine || mine === (r.net_nickname ?? ''))) this.setIdentityNickname(id, f.nickname || null);
    }
    if (typeof f.note === 'string' && f.note !== r.net_note) {
      this.db.query('UPDATE identity SET net_note = ? WHERE id = ?').run(f.note, id);
      const pid = r.person_id ?? (f.note ? this.ensurePerson(id) : null);
      if (!pid) return;
      const mine = ((this.db.query('SELECT note FROM person WHERE id = ?').get(pid) as Row | null)?.note as string | null) ?? '';
      const theirs = f.note;
      if (mine === theirs) return;
      // Only the network's changed (or there is none here): take it. Theirs holds all of ours: take it too.
      if (!mine || mine === (r.net_note ?? '') || (theirs && theirs.includes(mine))) this.updatePerson(pid, { note: theirs });
      // Ours holds all of theirs (or they cleared it while ours changed): ours goes back.
      else if (!theirs || mine.includes(theirs)) this.contactNotesOut?.(id, { note: mine });
      else {
        const joined = `${mine}\n\n${theirs}`;
        this.updatePerson(pid, { note: joined });
        this.contactNotesOut?.(id, { note: joined });
      }
    }
  }

  private linkSelf(identityId: string, f: P.IdentityFact) {
    const self = this.db.query('SELECT id FROM person WHERE is_self = 1').get() as Row | null;
    let pid = self?.id as string | undefined;
    if (!pid) {
      pid = 'per_self';
      this.db.query('INSERT OR IGNORE INTO person (id, name, is_self, created_at) VALUES (?, ?, 1, ?)').run(pid, f.displayName ?? f.handle ?? 'You', Date.now());
    }
    this.db.query('UPDATE identity SET person_id = ? WHERE id = ?').run(pid, identityId);
    this.dirty.persons.add(pid);
    this.dirty.identities.add(identityId);
  }

  /** Give an identity a Person if it has none. Deterministic id so replays don't duplicate. */
  ensurePerson(identityId: string): string {
    const r = this.db.query('SELECT person_id, nickname, display_name, handle, native_id, avatar_url FROM identity WHERE id = ?').get(identityId) as Row;
    if (r.person_id) return r.person_id;
    const pid = 'per_' + identityId.slice(4);
    this.db.query('INSERT OR IGNORE INTO person (id, name, avatar_url, created_at) VALUES (?, ?, ?, ?)').run(pid, shownName(r), r.avatar_url, Date.now());
    this.db.query('UPDATE identity SET person_id = ? WHERE id = ?').run(pid, identityId);
    this.refreshFace(pid);
    this.dirty.persons.add(pid);
    this.dirty.identities.add(identityId);
    // A direct conversation shows who it is with by person.
    this.touchDirectsOf(pid);
    this.personsChanged?.([pid]);
    return pid;
  }

  /**
   * When you last heard from or wrote to each account (docs/chats.md, Names): its latest message, or the latest in a
   * direct conversation with it.
   */
  private lastTalked(ids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of ids) {
      const said = (this.db.query('SELECT MAX(ts) AS t FROM message WHERE author_id = ?').get(id) as Row | null)?.t ?? 0;
      const dm =
        (
          this.db
            .query(`SELECT MAX(c.last_message_at) AS t FROM participant p JOIN conversation c ON c.id = p.conversation_id WHERE p.identity_id = ? AND c.shape = 'direct'`)
            .get(id) as Row | null
        )?.t ?? 0;
      out.set(id, Math.max(said, dm));
    }
    return out;
  }

  /**
   * The account a person is shown by when nobody pinned one: the one you talked with last, else one with a picture. A
   * nickname does not count: one that tells an alt apart ("Kit, raid nights") must not name them.
   */
  private chooseFace(ids: Row[]): Row {
    const talked = this.lastTalked(ids.map((i) => i.id));
    return [...ids].sort(
      (a, b) =>
        (talked.get(b.id) ?? 0) - (talked.get(a.id) ?? 0) ||
        Number(!a.avatar_url) - Number(!b.avatar_url) ||
        (b.updated_at ?? 0) - (a.updated_at ?? 0),
    )[0];
  }

  /**
   * A person's name and picture, made again from their face (docs/chats.md, Names): the one account they are shown
   * by, its name as you see it and its picture (the picture account's when you chose one), else the picture of
   * another of theirs you talked with last. The face
   * stays until you pin another, it leaves them, or (`rechoose`) you ask the hub to choose again; a new one is chosen by
   * chooseFace. Your own person is named by your accounts' networks, not here.
   */
  private refreshFace(pid: string, rechoose = false) {
    const p = this.db.query('SELECT name, avatar_url, face_id, face_pinned, picture_identity_id, manual, name_source, is_self FROM person WHERE id = ?').get(pid) as Row | null;
    if (!p || p.is_self) return;
    const ids = this.db.query('SELECT id, nickname, display_name, handle, native_id, avatar_url, updated_at FROM identity WHERE person_id = ?').all(pid) as Row[];
    if (!ids.length) return;
    const kept = ids.find((i) => i.id === p.face_id);
    const pinned = !!kept && !!p.face_pinned;
    const face = kept && (pinned || !rechoose) ? kept : this.chooseFace(ids);
    // A picture account you chose shows its picture instead, while it is theirs and has one.
    let avatar = (ids.find((i) => i.id === p.picture_identity_id)?.avatar_url ?? face.avatar_url) as string | null;
    if (!avatar) {
      const others = ids.filter((i) => i.avatar_url && i.id !== face.id);
      const talked = this.lastTalked(others.map((i) => i.id));
      avatar = others.sort((a, b) => (talked.get(b.id) ?? 0) - (talked.get(a.id) ?? 0))[0]?.avatar_url ?? null;
    }
    const several = ids.length > 1;
    const next = { name: shownName(face), avatar_url: avatar, face_id: face.id, face_pinned: pinned ? 1 : 0, manual: several ? 1 : 0, name_source: several ? 'merge' : 'network' };
    if ((Object.keys(next) as (keyof typeof next)[]).every((k) => p[k] === next[k])) return;
    this.db
      .query('UPDATE person SET name = ?, avatar_url = ?, face_id = ?, face_pinned = ?, manual = ?, name_source = ? WHERE id = ?')
      .run(next.name, next.avatar_url, next.face_id, next.face_pinned, next.manual, next.name_source, pid);
    this.dirty.persons.add(pid);
    if (p.name !== next.name) this.touchDirectsOf(pid);
  }

  /**
   * Shows a person by one of their accounts (its name and picture), or (null) lets the hub choose again. False for an
   * account that is not theirs.
   */
  setPersonFace(pid: string, identityId: string | null): boolean {
    if (identityId !== null && !this.db.query('SELECT 1 FROM identity WHERE id = ? AND person_id = ?').get(identityId, pid)) return false;
    this.db.query('UPDATE person SET face_id = COALESCE(?, face_id), face_pinned = ? WHERE id = ?').run(identityId, identityId ? 1 : 0, pid);
    // A picture account made main is no longer a picture of its own: their picture is the main account's again.
    if (identityId) this.db.query('UPDATE person SET picture_identity_id = NULL WHERE id = ? AND picture_identity_id = ?').run(pid, identityId);
    this.refreshFace(pid, identityId === null);
    this.dirty.persons.add(pid);
    this.personsChanged?.([pid]);
    return true;
  }

  /**
   * Shows a person with the picture of one of their accounts, whatever their face (docs/profile.md, "Which account
   * speaks for them"), or (null) their face's picture again. False for an account that is not theirs.
   */
  setPersonPicture(pid: string, identityId: string | null): boolean {
    if (identityId !== null && !this.db.query('SELECT 1 FROM identity WHERE id = ? AND person_id = ?').get(identityId, pid)) return false;
    this.db.query('UPDATE person SET picture_identity_id = ? WHERE id = ?').run(identityId, pid);
    this.refreshFace(pid);
    this.dirty.persons.add(pid);
    this.personsChanged?.([pid]);
    return true;
  }

  /**
   * Your nickname for one account of someone's (docs/chats.md, Names), or none (null or empty): only you see it, it
   * stands for the account's name wherever that shows, and their person's name follows. False for an unknown identity.
   */
  setIdentityNickname(identityId: string, nickname: string | null): boolean {
    const r = this.db.query('SELECT * FROM identity WHERE id = ?').get(identityId) as Row | null;
    if (!r) return false;
    const nick = nickname?.trim() || null;
    this.db.query('UPDATE identity SET nickname = ? WHERE id = ?').run(nick, identityId);
    this.dirty.identities.add(identityId);
    // The name follows their face's, and only that one: a nickname that tells one alt apart does not rename them.
    if (r.person_id) this.refreshFace(r.person_id);
    return true;
  }

  /**
   * How a space or conversation looks to clients, with its edges: adapters announce every place again on each
   * (re)connect, and only a real change is news (the live socket and the journal, docs/sync.md).
   */
  private placeSig(kind: 'space' | 'conversation', id: string): string {
    const edges = this.db.query('SELECT parent_id, position FROM space_edge WHERE child_kind = ? AND child_id = ? ORDER BY parent_id').all(kind, id);
    if (kind === 'conversation') return JSON.stringify([this.conversationView(id), edges]);
    const r = this.db.query('SELECT * FROM space WHERE id = ?').get(id) as Row | null;
    return JSON.stringify([r && this.spaceView(r), edges]);
  }

  private parentsOf(kind: 'space' | 'conversation', id: string): string[] {
    return (this.db.query('SELECT parent_id FROM space_edge WHERE child_kind = ? AND child_id = ?').all(kind, id) as Row[]).map((r) => r.parent_id);
  }

  private space(acc: AccountRow, f: P.SpaceFact) {
    const id = hubId('spc', acc.network, f.nativeId);
    const before = this.placeSig('space', id);
    const parentsBefore = this.parentsOf('space', id);
    const was = this.db.query('SELECT name, topic, icon_url FROM space WHERE id = ?').get(id) as Row | null;
    // A fact without a name (Discord's client sends some servers with theirs only under `properties`) keeps the
    // name the hub has; a new place without one is named '' until a fact names it, rather than failing the event.
    const name: string = typeof f.name === 'string' ? f.name : (was?.name ?? '');
    if (was)
      this.logChanges('space', id, acc.id, [
        ['name', was.name, name],
        ['topic', was.topic, f.topic],
        ['avatar', was.icon_url, f.iconUrl],
      ]);
    this.db
      .query(
        `INSERT INTO space (id, network, native_id, kind, name, topic, icon_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network, native_id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
           topic = COALESCE(excluded.topic, topic), icon_url = COALESCE(excluded.icon_url, icon_url), updated_at = excluded.updated_at`,
      )
      .run(id, acc.network, f.nativeId, f.kind, name, f.topic ?? null, f.iconUrl ?? null, Date.now());
    this.ensureVantage(acc.id, 'space', id, f.mute);
    if (f.parents) {
      this.db.query(`DELETE FROM space_edge WHERE child_kind = 'space' AND child_id = ?`).run(id);
      for (const p of f.parents) {
        const pid = hubId('spc', acc.network, p.nativeId);
        this.db.query(`INSERT OR REPLACE INTO space_edge (parent_id, child_kind, child_id, position) VALUES (?, 'space', ?, ?)`).run(pid, id, p.position ?? null);
      }
    }
    if (this.placeSig('space', id) === before) return;
    this.dirty.spaces.add(id);
    // Its parents list it among their children.
    for (const pid of new Set([...parentsBefore, ...this.parentsOf('space', id)])) this.dirty.spaces.add(pid);
  }

  private ensureConversation(acc: AccountRow, nativeId: string): string {
    const id = hubId('cnv', acc.network, nativeId);
    this.db
      .query(`INSERT OR IGNORE INTO conversation (id, network, native_id, shape, updated_at) VALUES (?, ?, ?, 'group', ?)`)
      .run(id, acc.network, nativeId, Date.now());
    this.ensureVantage(acc.id, 'conversation', id);
    return id;
  }

  private conversation(acc: AccountRow, f: P.ConversationFact) {
    const id = hubId('cnv', acc.network, f.nativeId);
    const parent = f.parentConversation ? hubId('cnv', acc.network, f.parentConversation) : null;
    const before = this.placeSig('conversation', id);
    const spacesBefore = this.parentsOf('conversation', id);
    const was = this.db.query('SELECT name, topic, avatar_url, shape, archived FROM conversation WHERE id = ?').get(id) as Row | null;
    // A conversation first known only from a message (no name yet) filling in is not a change.
    if (was && (was.name || was.shape === 'direct'))
      this.logChanges('conversation', id, acc.id, [
        ['name', was.name, f.name],
        ['topic', was.topic, f.topic],
        ['avatar', was.avatar_url, f.avatarUrl],
      ]);
    this.db
      .query(
        `INSERT INTO conversation (id, network, native_id, shape, variant, parent_id, name, topic, avatar_url, encrypted, archived, last_message_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?)
         ON CONFLICT (network, native_id) DO UPDATE SET
           shape = excluded.shape, variant = excluded.variant,
           parent_id = CASE WHEN excluded.shape = 'thread' THEN COALESCE(excluded.parent_id, parent_id) ELSE excluded.parent_id END,
           name = COALESCE(excluded.name, name), topic = COALESCE(excluded.topic, topic),
           avatar_url = COALESCE(excluded.avatar_url, avatar_url), encrypted = excluded.encrypted,
           archived = CASE WHEN ? IS NULL THEN archived ELSE excluded.archived END,
           last_message_at = CASE WHEN excluded.last_message_at IS NULL THEN last_message_at ELSE MAX(COALESCE(last_message_at, 0), excluded.last_message_at) END,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        acc.network,
        f.nativeId,
        f.shape,
        f.variant ?? 'text',
        parent,
        f.name ?? null,
        f.topic ?? null,
        f.avatarUrl ?? null,
        f.encrypted ? 1 : 0,
        // A fact that does not say keeps what was said (Signal says it only from a read of contacts).
        f.archived === undefined ? null : f.archived ? 1 : 0,
        f.lastMessageAt ?? null,
        Date.now(),
        f.archived === undefined ? null : 1,
      );
    this.ensureVantage(acc.id, 'conversation', id, f.mute);
    // Archived or unarchived on the network: hidden or shown here too, when that changes, unless you turned it off. Not a
    // resolved Zulip topic (archived here): it is done, not put away, and Zulip's apps keep it with the rest.
    const resolving = acc.network === 'zulip' && f.shape === 'thread';
    if (f.archived !== undefined && !!was?.archived !== f.archived && !resolving && this.followArchive()) this.patchPlacePrefs([{ kind: 'conversation', id, hidden: f.archived }]);
    if (f.spaces) {
      this.db.query(`DELETE FROM space_edge WHERE child_kind = 'conversation' AND child_id = ?`).run(id);
      for (const s of f.spaces) {
        const sid = hubId('spc', acc.network, s.nativeId);
        this.db.query(`INSERT OR REPLACE INTO space_edge (parent_id, child_kind, child_id, position) VALUES (?, 'conversation', ?, ?)`).run(sid, id, s.position ?? null);
      }
    }
    if (f.participants) {
      const members = new Set((this.db.query('SELECT identity_id FROM participant WHERE conversation_id = ?').all(id) as Row[]).map((r) => r.identity_id as string));
      this.db.query('DELETE FROM participant WHERE conversation_id = ?').run(id);
      const now = new Set<string>();
      for (const n of f.participants) {
        const iid = this.ensureIdentity(acc, n);
        now.add(iid);
        this.db.query('INSERT OR IGNORE INTO participant (conversation_id, identity_id) VALUES (?, ?)').run(id, iid);
        // Clients know a conversation's members by identity.
        if (!members.has(iid)) this.dirty.identities.add(iid);
        // People you DM are people, not strangers.
        if (f.shape === 'direct' && !this.isSelf(iid) && n !== this.selfNative(acc)) this.ensurePerson(iid);
      }
      // Who joined and who left a group, once its members were known.
      if (members.size && f.shape === 'group' && this.retention().changes) {
        for (const iid of now) if (!members.has(iid)) this.logChange('conversation', id, 'member', null, iid, acc.id);
        for (const iid of members) if (!now.has(iid)) this.logChange('conversation', id, 'member', iid, null, acc.id);
      }
    }
    if (this.placeSig('conversation', id) === before) return;
    this.dirty.conversations.add(id);
    // The spaces it is in carry its edge, with its position.
    for (const sid of new Set([...spacesBefore, ...this.parentsOf('conversation', id)])) this.dirty.spaces.add(sid);
  }

  /** A conversation you just opened sorts as recent, though it has no message yet. */
  touchConversation(id: string, now = Date.now()) {
    this.db.query('UPDATE conversation SET last_message_at = COALESCE(last_message_at, ?) WHERE id = ?').run(now, id);
    this.dirty.conversations.add(id);
  }

  private selfNative(acc: AccountRow): string | null {
    if (!acc.self_identity) return null;
    return ((this.db.query('SELECT native_id FROM identity WHERE id = ?').get(acc.self_identity) as Row) ?? {}).native_id ?? null;
  }

  private leave(acc: AccountRow, kind: 'space' | 'conversation', nativeId: string) {
    const id = hubId(kind === 'space' ? 'spc' : 'cnv', acc.network, nativeId);
    this.db.query('DELETE FROM vantage WHERE account_id = ? AND target_kind = ? AND target_id = ?').run(acc.id, kind, id);
    const still = this.db.query('SELECT 1 FROM vantage WHERE target_kind = ? AND target_id = ?').get(kind, id);
    if (still) {
      (kind === 'space' ? this.dirty.spaces : this.dirty.conversations).add(id);
      return;
    }
    if (kind === 'space') {
      this.db.query('DELETE FROM space WHERE id = ?').run(id);
      this.forgetMembers(id);
      this.db.query(`DELETE FROM space_edge WHERE parent_id = ? OR (child_kind = 'space' AND child_id = ?)`).run(id, id);
      this.dirty.removed.push({ t: 'space.removed', id });
    } else {
      this.db.query('DELETE FROM conversation WHERE id = ?').run(id);
      this.db.query(`DELETE FROM space_edge WHERE child_kind = 'conversation' AND child_id = ?`).run(id);
      this.dirty.removed.push({ t: 'conversation.removed', id });
    }
  }

  /** Returns the message id if it is new and live (needs triage). */
  /** `late`: heard late and still news (lateNews): new to the hub, it is triaged as a live one is. */
  private message(acc: AccountRow, f: P.MessageFact, live: boolean, late = false): string | null {
    const cid = this.ensureConversation(acc, f.conversation);
    const id = hubId('msg', acc.network, f.nativeId);
    const author = this.ensureIdentity(acc, f.author);
    const old = this.db.query('SELECT * FROM message WHERE id = ?').get(id) as Row | null;
    const existed = !!old;
    // Backfill sends what is stored again and again: only a real change is news.
    const before = old ? JSON.stringify(this.messageViews([old])) : null;
    const convBefore = old ? this.placeSig('conversation', cid) : null;
    const replyTo = f.replyTo ? hubId('msg', acc.network, f.replyTo) : null;
    const thread = f.threadRoot ? hubId('cnv', acc.network, f.threadRoot) : null;
    // An edit: the words it had before, if this source's edits are kept (docs/history.md). A system line or a sticker
    // that comes back worded otherwise (an extractor that learned a new message type, or to show a sticker as itself)
    // was never edited by anyone, nor was a call line saying how the call went.
    const reworded = old && [old.kind, f.kind].some((k) => k === 'system' || k === 'sticker' || k === 'call');
    if (old && !old.deleted && old.body && f.body !== old.body && !reworded && this.keeps('edits', acc)) this.messageEvent(id, 'edit', { body: old.body }, author, acc.id, f.editedTs ?? Date.now());
    this.db
      .query(
        `INSERT INTO message (id, conversation_id, network, native_id, author_id, ts, edited_ts, kind, body, reply_to_id, thread_id, mentions_self, mentions_all, mentions_group, extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network, native_id) DO UPDATE SET
           edited_ts = COALESCE(excluded.edited_ts, edited_ts), kind = excluded.kind, imported = 0,
           -- A kept deleted message the network sends again empty (a Matrix redaction) keeps what was kept.
           body = CASE WHEN deleted = 1 AND excluded.body = '' THEN body ELSE excluded.body END,
           reply_to_id = COALESCE(excluded.reply_to_id, reply_to_id), thread_id = COALESCE(excluded.thread_id, thread_id),
           mentions_self = MAX(mentions_self, excluded.mentions_self),
           mentions_all = CASE WHEN excluded.mentions_self = 1 THEN excluded.mentions_all ELSE mentions_all END,
           mentions_group = CASE WHEN excluded.mentions_self = 1 THEN excluded.mentions_group ELSE mentions_group END, extra = COALESCE(excluded.extra, extra)`,
      )
      .run(
        id,
        cid,
        acc.network,
        f.nativeId,
        author,
        f.ts,
        f.editedTs ?? null,
        f.kind ?? 'text',
        f.body,
        replyTo,
        thread,
        f.mentionsSelf ? 1 : 0,
        f.mentionsSelf && f.mentionsAll ? 1 : 0,
        f.mentionsSelf && !f.mentionsAll && f.mentionsGroup ? 1 : 0,
        f.extra || f.forward || f.silent ? JSON.stringify({ ...scrubEventGuests(f.extra), ...(f.forward ? { forward: f.forward } : {}), ...(f.silent ? { silent: true } : {}) }) : null,
      );
    // A message that moved (a Zulip topic renamed or moved): it leaves the conversation it was in, which falls back to
    // its own newest message.
    if (f.moved && old && old.conversation_id !== cid) {
      this.db.query('UPDATE message SET conversation_id = ? WHERE id = ?').run(cid, id);
      // What points at the message by its conversation follows it.
      this.db.query('UPDATE reply_mark SET conversation_id = ? WHERE message_id = ?').run(cid, id);
      savedTables(this.db);
      this.db.query('UPDATE saved_message SET conversation_id = ? WHERE message_id = ?').run(cid, id);
      const last = this.db.query('SELECT id, ts FROM message WHERE conversation_id = ? AND deleted = 0 ORDER BY ts DESC LIMIT 1').get(old.conversation_id) as Row | null;
      this.db.query('UPDATE conversation SET last_message_id = ?, last_message_at = ? WHERE id = ?').run(last?.id ?? null, last?.ts ?? null, old.conversation_id);
      this.dirty.conversations.add(old.conversation_id as string);
      this.journal.movedOut(old.conversation_id as string);
    }
    if (f.attachments && !(old?.deleted && !f.attachments.length)) {
      this.db.query('DELETE FROM attachment WHERE message_id = ?').run(id);
      if (sizeless(f.attachments)) this.sizelessPictures = true;
      f.attachments.forEach((a, i) => {
        this.db
          .query(`INSERT INTO attachment (id, message_id, kind, mime, name, size, width, height, url, position, alt, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(hubId('att', acc.network, `${f.nativeId}#${a.nativeId ?? i}`), id, a.kind, a.mime ?? null, a.name ?? null, a.size ?? null, a.width ?? null, a.height ?? null, a.url, i, a.alt?.slice(0, 2000) || null, attachmentExtra(a));
      });
    }
    if (f.reactions) this.reactionSnapshot(acc, id, f.reactions, existed);
    if (existed && f.extra?.poll) pollSeen(this.db, id, f.extra);
    if (!existed) this.ingested.set(cid, Math.min(this.ingested.get(cid) ?? Infinity, f.ts));
    const newForAccount = this.db.query('INSERT OR IGNORE INTO message_seen (message_id, account_id) VALUES (?, ?)').run(id, acc.id).changes > 0;

    const conv = this.db.query('SELECT last_message_at, last_message_id, variant FROM conversation WHERE id = ?').get(cid) as Row;
    if (conv.last_message_at == null || f.ts >= conv.last_message_at) {
      this.db.query('UPDATE conversation SET last_message_id = ?, last_message_at = ? WHERE id = ?').run(id, f.ts, cid);
      // The list shows who wrote the last message; a live one brings its author along anyway.
      if (!live && conv.last_message_id !== id) this.dirty.identities.add(author);
    }
    const fromSelf = author === acc.self_identity || this.isSelf(author);
    // Someone in your notifications (docs/feed.md) is someone: a person, so their profile and what they did are kept
    // and found like anyone you talk with.
    if (!fromSelf && !existed && conv.variant === 'feed') this.ensurePerson(author);
    // Logged posts (posts.ts) are read as they are logged: someone opened them. A followed post's reply (follows.ts) is
    // news when the hub's check finds it (live), however long ago it was posted: the hub finds replies minutes or hours
    // late. One your own reading brought in (a branch of the thread opened) is on your screen already: read.
    if (newForAccount && !fromSelf && conv.variant !== 'posts' && (live || conv.variant !== 'follow')) {
      this.db
        .query(
          `UPDATE vantage SET unread = unread + 1, mentions = mentions + ?, wildcards = wildcards + ? WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?
             AND (last_read_ts IS NULL OR last_read_ts < ? OR ?)`,
        )
        .run(f.mentionsSelf ? 1 : 0, f.mentionsSelf && f.mentionsAll ? 1 : 0, acc.id, cid, f.ts, conv.variant === 'follow' ? 1 : 0);
    }
    if (fromSelf && newForAccount) {
      // Sending from any client counts as reading up to there.
      this.db
        .query(`UPDATE vantage SET last_read_ts = MAX(COALESCE(last_read_ts, 0), ?), unread = 0, mentions = 0, wildcards = 0 WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`)
        .run(f.ts, acc.id, cid);
    }
    const changed = before === null || JSON.stringify(this.messageViews([this.db.query('SELECT * FROM message WHERE id = ?').get(id) as Row])) !== before;
    if (changed || this.placeSig('conversation', cid) !== convBefore) this.dirty.conversations.add(cid);
    if (live || late || (existed && changed)) this.dirty.messages.set(id, live || (late && !existed));
    return !existed && (live || late) && !fromSelf ? id : null;
  }

  // ------------------------------------------------------------ history imports (imports/engine.ts, docs/import.md)

  /**
   * One conversation's facts from a history import, or a slice of them. Fill-only: what the hub has stays and live
   * data always wins; a message the hub lacks goes in through the same path as backfill (`message`, not live), so it
   * looks exactly like one the network sent. Nothing notifies, and unread counts are left as they were. Where the
   * source says something else than the hub, the hub's version stays and the difference is kept (import_conflict).
   *
   * Deleted and disappeared (docs/history.md): a fact with `gone` is a message the network took back whose words or
   * files the source kept (Molly's keepmsg). It goes in, or the hub's copy is marked, as a kept deleted or disappeared
   * message, as live sync keeps one, so it stays out of sight until adversarial features are shown. A message the hub
   * has as deleted and emptied takes the source's words the same way. Never one you wrote and it was deleted: you
   * meant that.
   */
  importBatch(
    acc: AccountRow,
    b: { conversation: P.ConversationFact; identities: P.IdentityFact[]; messages: (P.MessageFact & { gone?: { how: 'deleted' | 'disappeared'; at?: number } })[] },
    o: { sourceSha: string; runId: string; dryRun: boolean; archiveNew: boolean; first: boolean },
  ): P.ImportCounts {
    const counts: P.ImportCounts = { conversations: o.first ? 1 : 0, conversationsNew: 0, messages: b.messages.length, new: 0, same: 0, filled: 0, conflicts: 0, duplicates: 0, kept: 0 };
    const cid = hubId('cnv', acc.network, b.conversation.nativeId);
    const convExisted = !!this.db.query('SELECT 1 FROM conversation WHERE id = ?').get(cid);
    if (o.first && !convExisted) counts.conversationsNew = 1;
    const run = () => {
      if (!convExisted && !o.dryRun) this.conversation(acc, { ...b.conversation, ...(o.archiveNew ? { archived: true } : {}) });
      const v0 = this.db.query(`SELECT unread, mentions, wildcards FROM vantage WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`).get(acc.id, cid) as Row | null;
      if (!o.dryRun)
        for (const f of b.identities) {
          const iid = hubId('idn', acc.network, f.nativeId);
          const added = this.db
            .query(
              `INSERT INTO identity (id, network, native_id, handle, display_name, avatar_url, seen_via, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (network, native_id) DO UPDATE SET handle = COALESCE(handle, excluded.handle), display_name = COALESCE(display_name, excluded.display_name),
                 avatar_url = COALESCE(avatar_url, excluded.avatar_url), seen_via = COALESCE(seen_via, excluded.seen_via)
               WHERE handle IS NULL OR display_name IS NULL OR avatar_url IS NULL`,
            )
            .run(iid, acc.network, f.nativeId, f.handle ?? null, f.displayName ?? null, f.avatarUrl ?? null, acc.id, Date.now()).changes;
          if (added) this.dirty.identities.add(iid);
        }
      let newest = 0;
      for (const f of b.messages) {
        const mid = hubId('msg', acc.network, f.nativeId);
        const row = this.db.query('SELECT body, kind, deleted, gone_how, author_id, edited_ts, reply_to_id, (SELECT COUNT(*) FROM attachment WHERE message_id = m.id) AS atts FROM message m WHERE id = ?').get(mid) as Row | null;
        const g = f.gone;
        const mine = this.isSelf(hubId('idn', acc.network, f.author));
        const hasContent = !!f.body || !!f.attachments?.length;
        if (!row) {
          // Something you deleted yourself is not brought back; the reader leaves those out too.
          if (g && (!hasContent || (g.how === 'deleted' && mine))) {
            counts.same++;
            continue;
          }
          counts.new++;
          if (g) counts.kept!++;
          else newest = Math.max(newest, f.ts);
          if (o.dryRun) continue;
          this.message(acc, f, false);
          this.db.query('UPDATE message SET imported = 1 WHERE id = ?').run(mid);
          if (g) this.db.query('UPDATE message SET deleted = 1, gone_how = ?, gone_at = ? WHERE id = ?').run(g.how, g.at ?? null, mid);
          this.db.query('INSERT OR IGNORE INTO import_origin (message_id, source_sha, run_id) VALUES (?, ?, ?)').run(mid, o.sourceSha, o.runId);
          continue;
        }
        if (!o.dryRun) this.db.query('INSERT OR IGNORE INTO import_origin (message_id, source_sha, run_id) VALUES (?, ?, ?)').run(mid, o.sourceSha, o.runId);
        const conflict = (kind: 'body' | 'deleted') => {
          counts.conflicts++;
          if (o.dryRun) return;
          const value = { body: f.body, ...(f.editedTs ? { editedTs: f.editedTs } : {}), ...(f.attachments?.length ? { attachments: f.attachments.map((a) => a.name ?? a.kind) } : {}) };
          this.db
            .query('INSERT OR IGNORE INTO import_conflict (message_id, kind, source_sha, run_id, source_value, detected_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(mid, kind, o.sourceSha, o.runId, JSON.stringify(value), Date.now());
        };
        // Taken back, and the hub kept nothing of it (or never heard): what the source kept fills it in, kept as gone.
        // Your own messages too when they disappeared (a timer, not you, took them); never what you deleted.
        const ownDisappeared = this.isSelf(row.author_id) && g?.how === 'disappeared';
        if ((row.deleted || g) && hasContent && (!this.isSelf(row.author_id) || ownDisappeared)) {
          const empty = !row.body && !row.atts;
          if (row.deleted && !empty) {
            counts.same++;
            continue;
          }
          counts.filled++;
          counts.kept!++;
          if (o.dryRun) continue;
          const how = ownDisappeared ? 'disappeared' : (row.gone_how ?? g?.how ?? 'deleted');
          this.db.query('UPDATE message SET deleted = 1, gone_how = ?, gone_at = COALESCE(gone_at, ?) WHERE id = ?').run(how, g?.at ?? null, mid);
          if (!row.body && f.body) this.db.query('UPDATE message SET body = ? WHERE id = ?').run(f.body, mid);
          if (!row.atts && f.attachments?.length) this.insertAttachments(acc, mid, f.nativeId, f.attachments);
          this.dirty.messages.set(mid, false);
          continue;
        }
        if (row.deleted) {
          counts.same++;
          continue;
        }
        // A system or call line ("… started a call") is worded by whoever rendered it: the same event either way.
        if (row.kind === 'system' || f.kind === 'system' || row.kind === 'call' || f.kind === 'call') {
          counts.same++;
          continue;
        }
        // The hub has the file and no words; the source lacks the file and says so in words: the same message.
        if (!row.body && row.atts && !f.attachments?.length) {
          counts.same++;
          continue;
        }
        let filled = false;
        // Words the hub never had (a sticker's emoji, say) are filled in, not a difference.
        if (!row.body && f.body) {
          if (!o.dryRun) this.db.query('UPDATE message SET body = ? WHERE id = ?').run(f.body, mid);
          filled = true;
        } else if (f.body && normalizeForCompare(row.body) !== normalizeForCompare(f.body)) {
          // A later edit than the hub has: the hub missed it. Taken, with the hub's words kept as an earlier version.
          if (!f.editedTs || (row.edited_ts && f.editedTs <= row.edited_ts)) {
            conflict('body');
            continue;
          }
          if (!o.dryRun) {
            if (row.body && this.keeps('edits', acc)) this.messageEvent(mid, 'edit', { body: row.body }, row.author_id, acc.id, f.editedTs);
            this.db.query('UPDATE message SET body = ?, edited_ts = ? WHERE id = ?').run(f.body, f.editedTs, mid);
          }
          filled = true;
        }
        if (!row.reply_to_id && f.replyTo) {
          if (!o.dryRun) this.db.query('UPDATE message SET reply_to_id = ? WHERE id = ?').run(hubId('msg', acc.network, f.replyTo), mid);
          filled = true;
        }
        if (!row.atts && f.attachments?.length) {
          if (!o.dryRun) {
            this.insertAttachments(acc, mid, f.nativeId, f.attachments);
            if (row.kind === 'text') this.db.query(`UPDATE message SET kind = 'media' WHERE id = ?`).run(mid);
          }
          filled = true;
        }
        if (f.reactions && this.fillReactionTimes(acc, mid, f.reactions, o.dryRun)) filled = true;
        if (filled) {
          counts.filled++;
          if (!o.dryRun) this.dirty.messages.set(mid, false);
        } else counts.same++;
      }
      if (o.dryRun) return;
      // Old messages are read; a conversation's counts stay what the network said.
      if (v0) this.db.query(`UPDATE vantage SET unread = ?, mentions = ?, wildcards = ? WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`).run(v0.unread, v0.mentions, v0.wildcards, acc.id, cid);
      else if (newest)
        this.db
          .query(`UPDATE vantage SET last_read_ts = MAX(COALESCE(last_read_ts, 0), ?), unread = 0, mentions = 0, wildcards = 0 WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`)
          .run(newest, acc.id, cid);
      this.dirty.conversations.add(cid);
    };
    this.db.transaction(run)();
    return counts;
  }

  /**
   * When people reacted, from an import, for reactions the hub has with no time or only when it heard (docs/reactions.md
   * "When"). How many it filled, or would.
   */
  private fillReactionTimes(acc: AccountRow, mid: string, facts: P.ReactionFact[], dryRun: boolean): number {
    let n = 0;
    for (const r of facts)
      for (const a of r.authors) {
        const ts = reactionTs(r.at?.[a]);
        if (ts === null) continue;
        const where = 'message_id = ? AND identity_id = ? AND key = ? AND style = ? AND (at IS NULL OR at_exact = 0)';
        const args = [mid, hubId('idn', acc.network, a), canonicalReactionKey(r.key), r.style ?? 'normal'];
        if (dryRun) n += this.db.query(`SELECT 1 FROM reaction WHERE ${where}`).get(...args) ? 1 : 0;
        else n += this.db.query(`UPDATE reaction SET at = ?, at_exact = 1 WHERE ${where}`).run(ts, ...args).changes;
      }
    return n;
  }

  /**
   * A picture came without its size (Signal leaves it out at times): set until the server asks the media archive to
   * keep the new files now rather than at its next turn, so the hub reads the size from the file within seconds and
   * the app draws the picture in its own shape (docs/pictures.md).
   */
  sizelessPictures = false;

  private insertAttachments(acc: AccountRow, mid: string, nativeId: string, atts: P.AttachmentFact[]) {
    if (sizeless(atts)) this.sizelessPictures = true;
    atts.forEach((a, i) => {
      this.db
        .query(`INSERT OR REPLACE INTO attachment (id, message_id, kind, mime, name, size, width, height, url, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(hubId('att', acc.network, `${nativeId}#${a.nativeId ?? i}`), mid, a.kind, a.mime ?? null, a.name ?? null, a.size ?? null, a.width ?? null, a.height ?? null, a.url, i);
    });
  }

  /** What an import found that differs from the hub, newest first. */
  importConflicts(sourceSha: string, limit = 100, offset = 0): P.ImportConflictView[] {
    const rows = this.db
      .query(
        `SELECT c.*, m.conversation_id, m.body, m.deleted, m.edited_ts, m.ts FROM import_conflict c JOIN message m ON m.id = c.message_id
         WHERE c.source_sha = ? ORDER BY m.ts DESC LIMIT ? OFFSET ?`,
      )
      .all(sourceSha, limit, offset) as Row[];
    return rows.map((r) => ({
      messageId: r.message_id,
      conversationId: r.conversation_id,
      kind: r.kind,
      hub: { body: r.body, deleted: !!r.deleted, editedTs: r.edited_ts ?? null },
      source: JSON.parse(r.source_value),
      ts: r.ts,
      decision: r.decision ?? null,
    }));
  }

  importConflictCounts(sourceSha: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.query('SELECT kind, COUNT(*) AS n FROM import_conflict WHERE source_sha = ? GROUP BY kind').all(sourceSha) as Row[]) out[r.kind] = r.n;
    return out;
  }

  /**
   * Take a source's version of a message, or stop showing the difference. Taking it keeps the hub's words as an
   * earlier version (message_event), like an edit.
   */
  decideImportConflict(messageId: string, kind: string, sourceSha: string, decision: 'take-source' | 'ignore' | null) {
    const c = this.db.query('SELECT * FROM import_conflict WHERE message_id = ? AND kind = ? AND source_sha = ?').get(messageId, kind, sourceSha) as Row | null;
    if (!c) throw new Error('no such conflict');
    this.db.transaction(() => {
      if (decision === 'take-source' && c.decision !== 'take-source') {
        const m = this.db.query('SELECT body, author_id FROM message WHERE id = ?').get(messageId) as Row;
        const v = JSON.parse(c.source_value) as { body: string };
        if (m.body) this.messageEvent(messageId, 'edit', { body: m.body }, m.author_id, null, Date.now());
        this.db.query('UPDATE message SET body = ? WHERE id = ?').run(v.body, messageId);
        this.dirty.messages.set(messageId, false);
      }
      this.db.query('UPDATE import_conflict SET decision = ?, decided_at = ? WHERE message_id = ? AND kind = ? AND source_sha = ?').run(decision, Date.now(), messageId, kind, sourceSha);
    })();
  }

  /** Undo a source: messages only it brought (never sent by the network since) go; the rest only lose the origin. */
  undoImport(sourceSha: string): { removed: number } {
    let removed = 0;
    this.db.transaction(() => {
      const only = this.db
        .query(
          `SELECT o.message_id, m.conversation_id FROM import_origin o JOIN message m ON m.id = o.message_id
           WHERE o.source_sha = ? AND m.imported = 1 AND NOT EXISTS (SELECT 1 FROM import_origin x WHERE x.message_id = o.message_id AND x.source_sha != o.source_sha)`,
        )
        .all(sourceSha) as Row[];
      for (const r of only) {
        this.db.query('DELETE FROM message WHERE id = ?').run(r.message_id);
        this.dirty.conversations.add(r.conversation_id);
        removed++;
      }
      this.db.query('DELETE FROM import_origin WHERE source_sha = ?').run(sourceSha);
      this.db.query('DELETE FROM import_conflict WHERE source_sha = ?').run(sourceSha);
    })();
    return { removed };
  }

  // ------------------------------------------------------------ hub-side mutations

  markRead(conversationId: string, upToTs: number): { accountId: string; upTo: string | null }[] {
    const vs = this.db.query(`SELECT account_id FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`).all(conversationId) as Row[];
    const last = this.db
      .query('SELECT native_id FROM message WHERE conversation_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1')
      .get(conversationId, upToTs) as Row | null;
    this.db
      .query(`UPDATE vantage SET last_read_ts = MAX(COALESCE(last_read_ts, 0), ?), unread = 0, mentions = 0, wildcards = 0 WHERE target_kind = 'conversation' AND target_id = ?`)
      .run(upToTs, conversationId);
    this.dirty.conversations.add(conversationId);
    return vs.map((v) => ({ accountId: v.account_id, upTo: last?.native_id ?? null }));
  }

  mergePersons(intoId: string, fromId: string) {
    if (intoId === fromId) return;
    const tx = this.db.transaction(() => {
      this.db.query('UPDATE identity SET person_id = ? WHERE person_id = ?').run(intoId, fromId);
      // The one kept keeps its name, an account's as you see it. Nicknames are the accounts' and go along with them.
      this.db.query(`UPDATE person SET manual = 1, name_source = 'merge' WHERE id = ?`).run(intoId);
      // The route chosen for them goes along, unless the one kept had its own.
      this.db.query(`UPDATE OR IGNORE chat_route SET chat_id = ? WHERE chat_id = ?`).run(`person:${intoId}`, `person:${fromId}`);
      this.db.query(`DELETE FROM chat_route WHERE chat_id = ?`).run(`person:${fromId}`);
      this.db.query(`UPDATE OR IGNORE folder_item SET item_id = ? WHERE item_kind = 'person' AND item_id = ?`).run(intoId, fromId);
      this.db.query(`DELETE FROM folder_item WHERE item_kind = 'person' AND item_id = ?`).run(fromId);
      this.db.query(`UPDATE OR IGNORE notify_rule SET target = ? WHERE scope = 'person' AND target = ?`).run(intoId, fromId);
      this.db.query('DELETE FROM person WHERE id = ?').run(fromId);
    });
    tx();
    // Shown as before by the one kept's face, unless it had none; the face's picture, or another's where it has none.
    this.refreshFace(intoId);
    this.dirty.persons.add(intoId);
    this.dirty.removed.push({ t: 'person.removed', id: fromId });
    for (const r of this.db.query('SELECT id FROM identity WHERE person_id = ?').all(intoId) as Row[]) this.dirty.identities.add(r.id);
    this.touchDirectsOf(intoId);
    this.personsChanged?.([intoId]);
  }

  /** Detach an identity into its own person again. */
  splitIdentity(identityId: string) {
    const r = this.db.query('SELECT person_id FROM identity WHERE id = ?').get(identityId) as Row | null;
    if (!r?.person_id) return;
    const old = r.person_id as string;
    this.db.query('UPDATE identity SET person_id = NULL WHERE id = ?').run(identityId);
    // The account that went no longer gives the person it left their picture (their face is chosen again below).
    this.db.query('UPDATE person SET picture_identity_id = NULL WHERE id = ? AND picture_identity_id = ?').run(old, identityId);
    const left = (this.db.query('SELECT COUNT(*) AS n FROM identity WHERE person_id = ?').get(old) as Row).n as number;
    // Its deterministic person may be the merged one, kept going by the others: that would rejoin them.
    const natural = 'per_' + identityId.slice(4);
    let pid: string;
    if (natural === old && left) {
      const i = this.db.query('SELECT nickname, display_name, handle, native_id, avatar_url FROM identity WHERE id = ?').get(identityId) as Row;
      pid = randomId('per');
      this.db.query('INSERT INTO person (id, name, avatar_url, created_at) VALUES (?, ?, ?, ?)').run(pid, shownName(i), i.avatar_url, Date.now());
      this.db.query('UPDATE identity SET person_id = ? WHERE id = ?').run(pid, identityId);
      this.refreshFace(pid);
    } else {
      if (natural === old) this.db.query('DELETE FROM person WHERE id = ?').run(old);
      pid = this.ensurePerson(identityId);
    }
    this.dirty.identities.add(identityId);
    if (!left && natural !== old) {
      this.db.query('DELETE FROM person WHERE id = ?').run(old);
      this.dirty.removed.push({ t: 'person.removed', id: old });
    } else if (left) {
      // Their face stays unless it was the one that went; then another of theirs is chosen.
      this.refreshFace(old);
      this.dirty.persons.add(old);
    }
    this.dirty.persons.add(pid);
    this.touchDirectsOf(pid);
    this.touchDirectsOf(old);
    this.personsChanged?.([pid, old]);
    return pid;
  }

  /**
   * `starred`, which clients from before stars left the app may still send, is ignored: Always notify is a person rule.
   * A name is not yours to give a person (a nickname is an account's, setIdentityNickname): only the demo names the
   * people it merges, as a merge would.
   */
  updatePerson(id: string, patch: { name?: string; note?: string }) {
    if (patch.name !== undefined) {
      // Shown by the account that goes by that name, as a merge would choose. A name none goes by is kept only until
      // their face's account changes (refreshFace names them after it again).
      const face = (this.db.query('SELECT * FROM identity WHERE person_id = ?').all(id) as Row[]).find((i) => shownName(i) === patch.name);
      if (face) this.db.query('UPDATE person SET face_id = ? WHERE id = ?').run(face.id, id), this.refreshFace(id);
      else this.db.query(`UPDATE person SET name = ?, manual = 1, name_source = 'merge' WHERE id = ?`).run(patch.name, id);
    }
    if (patch.note !== undefined) this.db.query('UPDATE person SET note = ? WHERE id = ?').run(patch.note, id);
    this.dirty.persons.add(id);
  }

  private touchDirectsOf(personId: string) {
    const rows = this.db
      .query(`SELECT DISTINCT p.conversation_id AS id FROM participant p JOIN identity i ON i.id = p.identity_id WHERE i.person_id = ?`)
      .all(personId) as Row[];
    for (const r of rows) this.dirty.conversations.add(r.id);
  }

  /**
   * Replaces every folder. A `folder` item puts that folder inside this one (folder.parent_id), one level deep: a
   * folder that holds folders cannot itself be inside one, so a deeper or circular nesting keeps only the first link
   * read, and a folder listed in two keeps the first.
   */
  setFolders(folders: P.FolderView[]) {
    const tx = this.db.transaction(() => {
      const kept = new Set(folders.map((f) => f.id));
      for (const r of this.db.query('SELECT id FROM folder').all() as Row[]) if (!kept.has(r.id)) this.db.query(`DELETE FROM place_pref WHERE kind = 'folder' AND id = ?`).run(r.id);
      this.db.query('DELETE FROM folder').run();
      const ids = folders.map((f) => f.id || randomId('fld'));
      const known = new Set(ids);
      const parent = new Map<string, { id: string; pos: number }>();
      folders.forEach((f, i) =>
        f.items.forEach((it, j) => {
          if (it.kind !== 'folder' || !known.has(it.id) || it.id === ids[i] || parent.has(it.id) || parent.has(ids[i])) return;
          // A folder that already holds folders stays at the top.
          if ([...parent.values()].some((p) => p.id === it.id)) return;
          parent.set(it.id, { id: ids[i], pos: j });
        }),
      );
      folders.forEach((f, i) => {
        const id = ids[i];
        const p = parent.get(id);
        this.db.query('INSERT INTO folder (id, name, icon, color, position, parent_id, parent_pos) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, f.name, f.icon, f.color, i, p?.id ?? null, p?.pos ?? null);
        f.items.forEach((it, j) => {
          if (it.kind === 'folder') return;
          this.db.query('INSERT OR IGNORE INTO folder_item (folder_id, item_kind, item_id, position) VALUES (?, ?, ?, ?)').run(id, it.kind, it.id, j);
        });
      });
    });
    tx();
    this.dirty.extra.push({ t: 'folders', folders: this.folders() });
  }

  /** Whether a network's archive hides and shows chats here (ArrangeSettings.followArchive; on unless turned off). */
  followArchive(): boolean {
    const r = this.db.query(`SELECT value FROM arrange_setting WHERE key = 'followArchive'`).get() as Row | null;
    return r?.value !== 'false';
  }

  placePrefs(): P.PlacePrefView[] {
    return (this.db.query('SELECT * FROM place_pref').all() as Row[]).map((r) => ({
      kind: r.kind,
      id: r.id,
      position: r.position,
      pinned: !!r.pinned,
      hidden: !!r.hidden,
      open: !!r.open,
      railed: !!r.railed,
      ...(MENTION_SCOPES.includes(r.mention_scope) ? { mentionScope: r.mention_scope } : {}),
      ...(r.mention_same !== null && r.mention_same !== undefined ? { mentionSameNetwork: !!r.mention_same } : {}),
      ...(isPictureLayout(r.pictures) ? { pictures: r.pictures } : {}),
    }));
  }

  /** Only the fields present change, so two devices arranging different things do not overwrite each other. */
  patchPlacePrefs(items: P.PlacePrefPatch[]) {
    const bit = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
    this.db.transaction(() => {
      for (const i of items) {
        if (!['folder', 'space', 'conversation'].includes(i.kind) || !i.id) continue;
        this.db.query('INSERT OR IGNORE INTO place_pref (kind, id) VALUES (?, ?)').run(i.kind, i.id);
        this.db
          .query(
            `UPDATE place_pref SET position = CASE WHEN ? THEN ? ELSE position END, pinned = COALESCE(?, pinned), hidden = COALESCE(?, hidden),
               open = COALESCE(?, open), railed = COALESCE(?, railed) WHERE kind = ? AND id = ?`,
          )
          .run(i.position !== undefined ? 1 : 0, i.position ?? null, bit(i.pinned), bit(i.hidden), bit(i.open), bit(i.railed), i.kind, i.id);
        // The @ picker's setting: null takes it away (inherited again); anything else unknown is left as it is.
        if (i.mentionScope === null || MENTION_SCOPES.includes(i.mentionScope!)) this.db.query('UPDATE place_pref SET mention_scope = ? WHERE kind = ? AND id = ?').run(i.mentionScope ?? null, i.kind, i.id);
        if (i.mentionSameNetwork === null || typeof i.mentionSameNetwork === 'boolean')
          this.db.query('UPDATE place_pref SET mention_same = ? WHERE kind = ? AND id = ?').run(i.mentionSameNetwork === null ? null : i.mentionSameNetwork ? 1 : 0, i.kind, i.id);
        // How pictures are shown here: null inherits again; anything else unknown is left as it is.
        if (i.pictures === null || isPictureLayout(i.pictures)) this.db.query('UPDATE place_pref SET pictures = ? WHERE kind = ? AND id = ?').run(i.pictures ?? null, i.kind, i.id);
      }
    })();
    this.dirty.extra.push({ t: 'placePrefs', prefs: this.placePrefs() });
  }

  // ------------------------------------------------------------ categories (categorize.ts asks the questions)

  /** Which provider fills category_score; shown in Settings. */
  categoryProvider = 'keyword';
  /** Set by main.ts when accounts run in dither-accounts: the manager's page, if known. */
  accountsManager: P.AccountsManagerView | null = null;
  /** Which accounts dither-accounts runs (remote.ts sets it); views carry it as managedBy. */
  accountManaged: (id: string) => P.AccountManaged | undefined = () => undefined;

  categories(): P.CategoryView[] {
    return (this.db.query('SELECT * FROM category ORDER BY position, name').all() as Row[]).map((c) => ({ id: c.id, name: c.name, question: c.question, keywords: json(c.keywords, []), color: c.color, threshold: c.threshold ?? null }));
  }

  placeCategories(): P.PlaceCategoryView[] {
    const rows = this.db
      .query(
        `SELECT category_id, kind, place_id, p, provider, NULL AS assigned FROM category_score WHERE NOT EXISTS (
           SELECT 1 FROM category_override o WHERE o.category_id = category_score.category_id AND o.kind = category_score.kind AND o.place_id = category_score.place_id)
         UNION ALL
         SELECT o.category_id, o.kind, o.place_id, s.p, s.provider, o.assigned FROM category_override o
           LEFT JOIN category_score s ON s.category_id = o.category_id AND s.kind = o.kind AND s.place_id = o.place_id`,
      )
      .all() as Row[];
    return rows.map((r) => ({ categoryId: r.category_id, kind: r.kind, id: r.place_id, p: r.p, provider: r.provider, override: r.assigned === null ? null : !!r.assigned }));
  }

  putCategory(c: Omit<P.CategoryView, 'id'> & { id?: string }, position?: number): string {
    const id = c.id ?? randomId('cat');
    const pos = position ?? (this.db.query('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM category').get() as Row).p;
    this.db
      .query(
        `INSERT INTO category (id, name, question, keywords, color, position, threshold) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, question = excluded.question, keywords = excluded.keywords, color = excluded.color, threshold = excluded.threshold`,
      )
      .run(id, c.name, c.question, JSON.stringify(c.keywords ?? []), c.color ?? null, pos, c.threshold ?? null);
    this.categoriesChanged();
    return id;
  }

  deleteCategory(id: string) {
    this.db.query('DELETE FROM category WHERE id = ?').run(id);
    this.categoriesChanged();
  }

  setCategoryOverride(categoryId: string, kind: 'space' | 'conversation', placeId: string, assigned: boolean | null) {
    if (assigned === null) this.db.query('DELETE FROM category_override WHERE category_id = ? AND kind = ? AND place_id = ?').run(categoryId, kind, placeId);
    else this.db.query('INSERT OR REPLACE INTO category_override (category_id, kind, place_id, assigned) VALUES (?, ?, ?, ?)').run(categoryId, kind, placeId, assigned ? 1 : 0);
    this.categoriesChanged();
  }

  putScores(kind: 'space' | 'conversation', placeId: string, scores: Record<string, number>, provider: string, hash: string) {
    this.db.transaction(() => {
      this.db.query('DELETE FROM category_score WHERE kind = ? AND place_id = ?').run(kind, placeId);
      for (const [cat, p] of Object.entries(scores)) {
        this.db.query('INSERT OR IGNORE INTO category_score (category_id, kind, place_id, p, provider, input_hash) SELECT id, ?, ?, ?, ?, ? FROM category WHERE id = ?').run(kind, placeId, p, provider, hash, cat);
      }
    })();
  }

  categoriesChanged() {
    this.dirty.extra = this.dirty.extra.filter((e) => e.t !== 'categories');
    this.dirty.extra.push({ t: 'categories', categories: this.categories(), placeCategories: this.placeCategories() });
  }

  placeStats(sinceTs: number): P.PlaceStats {
    const week: Record<string, number> = {};
    const mine: Record<string, number> = {};
    for (const r of this.db.query('SELECT conversation_id AS id, COUNT(*) AS n FROM message WHERE ts >= ? AND deleted = 0 GROUP BY conversation_id').all(sinceTs) as Row[]) week[r.id] = r.n;
    for (const r of this.db.query(`SELECT conversation_id AS id, MAX(ts) AS ts FROM message WHERE author_id IN (SELECT self_identity FROM account WHERE self_identity IS NOT NULL) GROUP BY conversation_id`).all() as Row[]) mine[r.id] = r.ts;
    return { week, mine };
  }

  setRule(scope: P.NotifyScope, target: string | null, level: P.NotifyLevel | null) {
    if (level === null) {
      this.db.query('DELETE FROM notify_rule WHERE scope = ? AND target IS ?').run(scope, target);
    } else {
      this.db.query('DELETE FROM notify_rule WHERE scope = ? AND target IS ?').run(scope, target);
      this.db.query('INSERT INTO notify_rule (id, scope, target, level, created_at) VALUES (?, ?, ?, ?, ?)').run(randomId('rul'), scope, target, level, Date.now());
    }
    this.dirty.extra.push({ t: 'rules', rules: this.rules() });
  }

  // ------------------------------------------------------------ history (docs/history.md)

  private retentionCache: P.RetentionSettings | null = null;
  retention(): P.RetentionSettings {
    if (this.retentionCache) return this.retentionCache;
    const r = { ...DEFAULT_RETENTION, ...(this.metaJson<Partial<P.RetentionSettings>>('retention') ?? {}) };
    // Before 2026-11-11 kept messages showed as a collapsed line: shown now, in full.
    if (r.show !== 'hidden') r.show = 'shown';
    r.showIn ??= {};
    return (this.retentionCache = r);
  }
  /** `by`: who changed it (a device's label), for the log of changes (retentionLog). */
  setRetention(r: P.RetentionSettings, by?: string) {
    const before = this.retention();
    this.setMetaJson('retention', r);
    this.retentionCache = null;
    const after = this.retention();
    const changed: Record<string, [unknown, unknown]> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof P.RetentionSettings>)
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed[k] = [before[k], after[k]];
    if (!Object.keys(changed).length) return;
    const log = [...(this.metaJson<P.RetentionChange[]>('retention_log') ?? []), { at: Date.now(), by: by ?? null, changed }].slice(-200);
    this.setMetaJson('retention_log', log);
    if (by) console.log(`retention: ${by} changed ${Object.keys(changed).join(', ')}`);
  }

  /** Every change to the retention settings, oldest first (the newest 200). */
  retentionLog = (): P.RetentionChange[] => this.metaJson<P.RetentionChange[]>('retention_log') ?? [];

  /**
   * Whether this account's deleted, disappeared or edited messages are kept: the account's say, its network's, then the
   * default. Deleted and disappeared go on being kept while adversarial features are hidden (out of sight): hiding
   * them never loses a message; only their switches, turned off on purpose, stop it.
   */
  keeps(what: keyof P.KeepSettings, acc: { id: string; network: string }): boolean {
    const r = this.retention();
    return r.sources[acc.id]?.[what] ?? r.sources[acc.network]?.[what] ?? r[what];
  }

  /**
   * One change to a place or a person, when changes are kept. Values are stored as JSON. The same change seen by a
   * second account within ten minutes is one change; a change straight back within a day (a name flipping between a
   * server nickname and the global one) cancels the first. Statuses and strangers' names keep only the newest.
   */
  logChange(kind: P.ChangeView['target']['kind'], id: string, field: string, old: unknown, now: unknown, accountId: string | null, at = Date.now(), actorId?: string | null) {
    if (!this.retention().changes) return;
    const o = old === undefined || old === null ? null : JSON.stringify(old);
    const n = now === undefined || now === null ? null : JSON.stringify(now);
    if (o === n) return;
    const recent = (oo: string | null, nn: string | null, within: number) =>
      this.db.query('SELECT id FROM change_log WHERE target_kind = ? AND target_id = ? AND field = ? AND old IS ? AND new IS ? AND at > ? ORDER BY at DESC LIMIT 1').get(kind, id, field, oo, nn, at - within) as Row | null;
    if (recent(o, n, 10 * 60_000)) return;
    const back = field === 'status' || field === 'member' || field === 'role' ? null : recent(n, o, 86_400_000);
    if (back) return void this.db.query('DELETE FROM change_log WHERE id = ?').run(back.id);
    this.db.query('INSERT INTO change_log (target_kind, target_id, field, old, new, actor_id, at, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(kind, id, field, o, n, actorId ?? null, at, accountId);
    // Statuses change often; strangers in big servers rename often. Keep their newest, all of everyone else's.
    let cap: number | null = null;
    if (kind === 'identity') cap = field === 'status' ? 100 : (this.db.query('SELECT person_id FROM identity WHERE id = ?').get(id) as Row | null)?.person_id ? null : 20;
    if (cap) this.db.query(`DELETE FROM change_log WHERE id IN (SELECT id FROM change_log WHERE target_kind = ? AND target_id = ? AND field = ? ORDER BY at DESC LIMIT -1 OFFSET ?)`).run(kind, id, field, cap);
  }

  /**
   * Fields that now say something else. Nothing said (undefined or null) is no change: networks often leave fields
   * out. A description, bio, status or pronouns may go from nothing to something and back; a name or picture is only
   * replaced.
   */
  logChanges(kind: P.ChangeView['target']['kind'], id: string, accountId: string, fields: [string, string | null | undefined, string | null | undefined][]) {
    for (const [field, was, now] of fields) {
      if (now == null || (was ?? '') === now) continue;
      if (!SETTABLE.has(field) && (was == null || now === '')) continue;
      this.logChange(kind, id, field, was || null, now || null, accountId);
    }
  }

  /**
   * Someone got, read or played your messages. Only your own are kept. Matrix says "read up to": your earlier messages
   * in that conversation they had not read yet count as read then too.
   */
  private receipt(acc: AccountRow, ev: Extract<P.AdapterEvent, { t: 'receipt' }>) {
    if (!this.keeps('receipts', acc)) return;
    const who = this.ensureIdentity(acc, ev.who);
    if (this.isSelf(who)) return;
    const put = this.db.query('INSERT OR IGNORE INTO receipt (message_id, identity_id, state, at) VALUES (?, ?, ?, ?)');
    for (const native of ev.messages) {
      const id = hubId('msg', acc.network, native);
      const m = this.db.query('SELECT conversation_id, author_id, ts FROM message WHERE id = ?').get(id) as Row | null;
      if (!m) continue;
      const mine = this.isSelf(m.author_id);
      if (mine && put.run(id, who, ev.state, ev.ts).changes) this.dirty.messages.set(id, true);
      if (acc.network === 'matrix' && ev.state === 'read') {
        const earlier = this.db
          .query(
            `SELECT id FROM message WHERE conversation_id = ? AND ts <= ? AND id != ? AND author_id IN (SELECT self_identity FROM account WHERE self_identity IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM receipt r WHERE r.message_id = message.id AND r.identity_id = ? AND r.state = 'read') ORDER BY ts DESC LIMIT 50`,
          )
          .all(m.conversation_id, m.ts, id, who) as Row[];
        for (const e of earlier) if (put.run(e.id, who, 'read', ev.ts).changes) this.dirty.messages.set(e.id, true);
      }
    }
  }

  /**
   * Someone's custom status or About as heard now, from an adapter's event or a profile answer. The first heard is
   * where history starts; each change after is logged. Cleared is stored as { at } alone (heard, empty); NULL is
   * nothing heard yet.
   */
  setStatus(iid: string, status: { text?: string; emoji?: string } | null, accountId: string | null, ts?: number) {
    const clean = (x: { text?: string; emoji?: string } | null | undefined) =>
      x && (x.text || x.emoji) ? { ...(x.text ? { text: x.text } : {}), ...(x.emoji ? { emoji: x.emoji } : {}) } : null;
    const now = clean(status);
    const row = this.db.query('SELECT status FROM identity WHERE id = ?').get(iid) as Row | null;
    if (!row) return;
    const heard = row.status != null;
    const was = clean(json<{ text?: string; emoji?: string } | null>(row.status, null));
    if (heard && JSON.stringify(was) === JSON.stringify(now)) return;
    const at = ts ?? Date.now();
    this.db.query('UPDATE identity SET status = ? WHERE id = ?').run(JSON.stringify({ ...now, at }), iid);
    this.dirty.identities.add(iid);
    // Statuses over time are an adversarial feature: the current one is kept, its history only when asked for.
    const r = this.retention();
    if (heard && r.adversarial && r.statuses) this.logChange('identity', iid, 'status', was, now, accountId, at);
  }

  /** Whether presence is logged: an adversarial feature, like statuses over time, and part of the change log. */
  logsPresence(): boolean {
    const r = this.retention();
    return r.adversarial && r.presence && r.changes;
  }

  /**
   * Someone's presence as heard now, logged only while logsPresence(); otherwise the hub keeps nothing of it. The
   * newest logged row is how they are now, so a change is anything else, and the same heard from a second account
   * (or again after a restart) is nothing new. The first heard is logged too, as from nothing.
   */
  setPresence(iid: string, state: P.PresenceView['state'], devices: P.PresenceView['devices'], accountId: string | null, ts?: number) {
    if (!this.logsPresence() || !PRESENCE_STATES.has(state)) return;
    const on = [...new Set((devices ?? []).filter((d) => PRESENCE_DEVICES.has(d)))].sort();
    const now = JSON.stringify({ state, ...(on.length && state !== 'offline' ? { devices: on } : {}) });
    const last = this.db.query(`SELECT new FROM change_log WHERE target_kind = 'identity' AND target_id = ? AND field = 'presence' ORDER BY at DESC, id DESC LIMIT 1`).get(iid) as Row | null;
    if (last?.new === now) return;
    this.db
      .query(`INSERT INTO change_log (target_kind, target_id, field, old, new, at, account_id) VALUES ('identity', ?, 'presence', ?, ?, ?, ?)`)
      .run(iid, last?.new ?? null, now, ts ?? Date.now(), accountId);
    // Presence changes many times a day: each person's newest 1000.
    this.db.query(`DELETE FROM change_log WHERE id IN (SELECT id FROM change_log WHERE target_kind = 'identity' AND target_id = ? AND field = 'presence' ORDER BY at DESC, id DESC LIMIT -1 OFFSET 1000)`).run(iid);
  }

  /** Server members are recorded: an adversarial feature, so only with adversarial features shown and members on. */
  recordsMembers(): boolean {
    const r = this.retention();
    return r.adversarial && r.members;
  }

  /**
   * People an account's client saw as members of a space, and the network's counts when it gave them. Seen again,
   * a member is updated: last seen moves on, and what the network no longer says (a nick) stays as it was.
   */
  private members(acc: AccountRow, ev: Extract<P.AdapterEvent, { t: 'members' }>) {
    // A walk is an index job you asked for (jobs.ts): kept whatever the setting for what clients merely saw.
    if (!this.recordsMembers() && ev.source !== 'walk') return;
    const sid = hubId('spc', acc.network, ev.space);
    if (!this.db.query('SELECT 1 FROM space WHERE id = ?').get(sid)) return;
    const at = ev.ts ?? Date.now();
    const put = this.db.query(
      `INSERT INTO membership (space_id, identity_id, joined_at, roles, nick, source, first_seen, last_seen, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (space_id, identity_id) DO UPDATE SET
         joined_at = COALESCE(excluded.joined_at, joined_at), roles = COALESCE(excluded.roles, roles), nick = COALESCE(excluded.nick, nick),
         source = excluded.source, first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen),
         account_id = excluded.account_id`,
    );
    for (const m of (ev.members ?? []).slice(0, 500)) {
      if (!m || typeof m.who !== 'string' || !m.who) continue;
      const roles = Array.isArray(m.roles) ? JSON.stringify(m.roles.filter((r) => typeof r === 'string')) : null;
      const joined = typeof m.joinedAt === 'number' && Number.isFinite(m.joinedAt) ? m.joinedAt : null;
      put.run(sid, this.ensureIdentity(acc, m.who), joined, roles, typeof m.nick === 'string' && m.nick ? m.nick : null, ev.source === 'walk' ? 'walk' : 'seen', at, at, acc.id);
    }
    const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null);
    const total = count(ev.total);
    const online = count(ev.online);
    if (total !== null || online !== null)
      this.db
        .query(
          `INSERT INTO member_coverage (space_id, total, online, reported_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (space_id) DO UPDATE SET total = COALESCE(excluded.total, total), online = COALESCE(excluded.online, online), reported_at = MAX(reported_at, excluded.reported_at)`,
        )
        .run(sid, total, online, at);
  }

  /** How many of a space's members the hub has seen, beside the network's counts. Nothing while members are not recorded. */
  memberCoverage(spaceId: string): P.MemberCoverageView | undefined {
    if (!this.recordsMembers()) return undefined;
    const seen = this.db.query('SELECT COUNT(*) AS n, MAX(last_seen) AS last FROM membership WHERE space_id = ?').get(spaceId) as Row;
    const cov = this.db.query('SELECT total, online, reported_at FROM member_coverage WHERE space_id = ?').get(spaceId) as Row | null;
    const total = cov?.total ?? undefined;
    return {
      seen: seen.n,
      ...(total !== undefined ? { total } : {}),
      ...(cov?.online != null ? { online: cov.online } : {}),
      ...(total ? { fraction: Math.min(1, seen.n / total) } : {}),
      ...(seen.last != null ? { lastSeenAt: seen.last } : {}),
      ...(cov ? { reportedAt: cov.reported_at } : {}),
    };
  }

  /** Spaces these identities were seen as members of, last seen first. Nothing while members are not recorded. */
  memberOf(identityIds: string[]): NonNullable<P.ProfileView['memberOf']> {
    if (!this.recordsMembers() || !identityIds.length) return [];
    const rows = this.db
      .query(`SELECT space_id, nick, roles, joined_at, last_seen FROM membership WHERE identity_id IN (${identityIds.map(() => '?').join(',')}) ORDER BY last_seen DESC LIMIT 200`)
      .all(...identityIds) as Row[];
    const out = new Map<string, NonNullable<P.ProfileView['memberOf']>[number]>();
    for (const r of rows) {
      if (out.has(r.space_id)) continue;
      const roles = json<string[] | null>(r.roles, null);
      out.set(r.space_id, {
        spaceId: r.space_id,
        ...(r.nick ? { nick: r.nick } : {}),
        ...(roles?.length ? { roles } : {}),
        ...(r.joined_at != null ? { joinedAt: r.joined_at } : {}),
        lastSeenAt: r.last_seen,
      });
    }
    return [...out.values()];
  }

  /**
   * Their message count in each server they posted in, from the messages held (msgcount.ts, docs/profile.md): the
   * observed count, their share, and a total only where one can be estimated. `onlySpace`: that server alone.
   */
  messageActivity(ref: { personId?: string; identityId?: string }, onlySpace?: string, now = Date.now()): P.ActivityView | null {
    const ids = ref.personId
      ? (this.db.query('SELECT id FROM identity WHERE person_id = ?').all(ref.personId) as Row[]).map((r) => r.id as string)
      : ref.identityId && this.db.query('SELECT 1 FROM identity WHERE id = ?').get(ref.identityId)
        ? [ref.identityId]
        : [];
    if (!ids.length) return ref.personId && this.db.query('SELECT 1 FROM person WHERE id = ?').get(ref.personId) ? { spaces: [] } : null;
    const ph = ids.map(() => '?').join(',');
    const roots = new Map<string, string | null>();
    const bySpace = new Map<string, Map<string, number>>();
    for (const r of this.db.query(`SELECT conversation_id AS c, COUNT(*) AS n, MIN(ts) AS first FROM message WHERE author_id IN (${ph}) GROUP BY conversation_id`).all(...ids) as Row[]) {
      const sid = this.communityOf(r.c, roots);
      if (!sid || (onlySpace && sid !== onlySpace)) continue;
      const m = bySpace.get(sid) ?? new Map<string, number>();
      m.set(r.c, r.n);
      bySpace.set(sid, m);
    }
    if (onlySpace && !bySpace.has(onlySpace) && this.db.query(`SELECT 1 FROM space WHERE id = ? AND kind = 'community'`).get(onlySpace)) bySpace.set(onlySpace, new Map());
    // The earliest they could have posted: when their Discord account was made.
    const made = (this.db.query(`SELECT native_id FROM identity WHERE id IN (${ph}) AND network = 'discord'`).all(...ids) as Row[])
      .map((r) => snowflakeTime(r.native_id, now))
      .filter((t): t is number => t !== null);
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const spaces: P.MessageCountEstimate[] = [];
    for (const [sid, authored] of [...bySpace].sort((a, b) => sum(b[1]) - sum(a[1])).slice(0, 20)) {
      const network = (this.db.query('SELECT network FROM space WHERE id = ?').get(sid) as Row).network as P.Network;
      const channels = this.conversationsUnder([sid])
        .slice(0, 2000)
        .map((cid) => this.channelInput(cid, authored.get(cid) ?? 0))
        .filter((c): c is ChannelInput => !!c);
      let from = made.length ? Math.min(...made) : null;
      // And when they joined, where the members setting kept it: unless they posted before it (they left and came back).
      if (this.recordsMembers()) {
        const j = this.db.query(`SELECT MIN(joined_at) AS at FROM membership WHERE space_id = ? AND identity_id IN (${ph})`).get(sid, ...ids) as Row;
        const first = Math.min(...channels.filter((c) => c.authored && c.oldest !== null).map((c) => c.oldest!));
        if (j.at != null && j.at <= first) from = Math.max(from ?? j.at, j.at);
      }
      const newest = channels.reduce((t, c) => Math.max(t, c.newest ?? 0), 0);
      spaces.push({ spaceId: sid, ...estimateMessages(channels, { from, now }), asOf: newest || null, networks: [network] });
    }
    return { spaces };
  }

  /**
   * When someone is around, for a profile's Activity section (activitychart.ts, docs/profile.md): a person (all their
   * identities) or one identity. Presence and status changes only while they are logged.
   */
  activityChart(ref: { personId?: string; identityId?: string }, days: number, zone: Zone, now = Date.now()): P.ActivityChartView | null {
    const person = ref.personId ? (this.db.query('SELECT id, is_self FROM person WHERE id = ?').get(ref.personId) as Row | null) : null;
    if (ref.personId && !person) return null;
    const ids = person
      ? (this.db.query('SELECT id FROM identity WHERE person_id = ?').all(person.id) as Row[]).map((r) => r.id as string)
      : ref.identityId && this.db.query('SELECT 1 FROM identity WHERE id = ?').get(ref.identityId)
        ? [ref.identityId]
        : [];
    if (!person && !ids.length) return null;
    // Your own page has no back-and-forth to show.
    const own = (this.db.query('SELECT i.id FROM person p CROSS JOIN identity i ON i.person_id = p.id WHERE p.is_self = 1 ORDER BY i.id').all() as Row[]).map((r) => r.id as string);
    const selves = [...new Set([...this.selfIdentities, ...own])];
    const self = !!person?.is_self || ids.some((id) => selves.includes(id));
    const r = this.retention();
    return activityChart(this.db, { ids, selfIds: self ? [] : selves, days, zone, now, presence: this.logsPresence(), statuses: r.adversarial && r.statuses && r.changes });
  }

  /** The top-level community a conversation is in (through sections, and a thread's channel), or null. */
  private communityOf(convId: string, memo: Map<string, string | null>): string | null {
    if (memo.has(convId)) return memo.get(convId)!;
    memo.set(convId, null);
    const c = this.db.query('SELECT parent_id FROM conversation WHERE id = ?').get(convId) as Row | null;
    let out: string | null = null;
    if (c?.parent_id) out = this.communityOf(c.parent_id, memo);
    else {
      let frontier = (this.db.query(`SELECT parent_id FROM space_edge WHERE child_kind = 'conversation' AND child_id = ?`).all(convId) as Row[]).map((r) => r.parent_id as string);
      for (let depth = 0; frontier.length && !out && depth < 6; depth++) {
        const next: string[] = [];
        for (const sid of frontier) {
          const sp = this.db.query('SELECT kind FROM space WHERE id = ?').get(sid) as Row | null;
          if (sp?.kind === 'community') {
            out = sid;
            break;
          }
          next.push(...(this.db.query(`SELECT parent_id FROM space_edge WHERE child_kind = 'space' AND child_id = ?`).all(sid) as Row[]).map((r) => r.parent_id as string));
        }
        frontier = next;
      }
    }
    memo.set(convId, out);
    return out;
  }

  /** A conversation as msgcount.ts takes it: what is held, and, where it could be estimated, held per bin. */
  private channelInput(convId: string, authored: number): ChannelInput | null {
    const c = this.db.query('SELECT network, native_id FROM conversation WHERE id = ?').get(convId) as Row | null;
    if (!c) return null;
    const s = this.db.query('SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM message WHERE conversation_id = ?').get(convId) as Row;
    let bins: number[] = [];
    if (c.network === 'discord' && s.n > 0) {
      const key = `${convId}:${s.n}:${s.hi}`;
      bins = this.binCache.get(key) ?? [];
      if (!bins.length) {
        const { count, width } = binsFor(s.lo, s.hi);
        bins = new Array(count).fill(0);
        for (const r of this.db.query('SELECT MIN(?, CAST((ts - ?) / ? AS INTEGER)) AS b, COUNT(*) AS n FROM message WHERE conversation_id = ? GROUP BY b').all(count - 1, s.lo, width, convId) as Row[]) bins[r.b] = r.n;
        if (this.binCache.size > 5000) this.binCache.clear();
        this.binCache.set(key, bins);
      }
    }
    return { network: c.network, nativeId: c.native_id, captured: s.n, oldest: s.lo ?? null, newest: s.hi ?? null, bins, authored };
  }

  private forgetMembers(spaceId: string) {
    this.db.query('DELETE FROM membership WHERE space_id = ?').run(spaceId);
    this.db.query('DELETE FROM member_coverage WHERE space_id = ?').run(spaceId);
  }

  /** Something that happened to a message. The same from a second account within ten minutes is one. */
  messageEvent(messageId: string, kind: P.MessageEventView['kind'], data: unknown, actorId: string | null, accountId: string | null, at = Date.now()) {
    const d = data === undefined ? null : JSON.stringify(data);
    const dup = this.db
      .query('SELECT 1 FROM message_event WHERE message_id = ? AND kind = ? AND data IS ? AND actor_id IS ? AND at > ?')
      .get(messageId, kind, d, actorId, at - 10 * 60_000);
    if (dup) return;
    this.db.query('INSERT INTO message_event (message_id, kind, data, actor_id, at, account_id) VALUES (?, ?, ?, ?, ?, ?)').run(messageId, kind, d, actorId, at, accountId);
    this.dirty.messages.set(messageId, true);
  }

  /**
   * A message the network took back. Kept, words and files, when this source's deleted (or disappeared) messages are,
   * unless you deleted it yourself; else emptied as before.
   */
  private gone(acc: AccountRow, id: string, how: 'deleted' | 'disappeared') {
    const m = this.db.query('SELECT conversation_id, author_id, deleted FROM message WHERE id = ?').get(id) as Row | null;
    if (!m || m.deleted) return;
    const keep = this.keeps(how === 'disappeared' ? 'disappearing' : 'deleted', acc) && !(how === 'deleted' && this.isSelf(m.author_id));
    if (keep) this.db.query('UPDATE message SET deleted = 1, gone_how = ?, gone_at = ? WHERE id = ?').run(how, Date.now(), id);
    else {
      this.db.query(`UPDATE message SET deleted = 1, body = '', gone_how = ?, gone_at = ? WHERE id = ?`).run(how, Date.now(), id);
      this.db.query('DELETE FROM attachment WHERE message_id = ?').run(id);
    }
    this.dirty.messages.set(id, true);
    this.dirty.conversations.add(m.conversation_id);
  }

  /** What changed about these, newest first. `fields`: only these; `except`: not these. */
  changes(targets: { kind: P.ChangeView['target']['kind']; id: string }[], limit = 100, pick: { fields?: string[]; except?: string[]; rolesOf?: string[] } = {}): P.ChangeView[] {
    if (!targets.length) return [];
    // A person's roles and groups given and lost in places (kept against the place), on their own page too, while
    // changes are kept.
    const rolesOf = this.retention().changes ? (pick.rolesOf ?? []) : [];
    const where = [
      ...targets.map(() => '(target_kind = ? AND target_id = ?)'),
      ...(rolesOf.length ? [`(target_kind IN ('space', 'conversation') AND field = 'role' AND json_extract(coalesce(new, old), '$.identityId') IN (${rolesOf.map(() => '?').join(', ')}))`] : []),
    ].join(' OR ');
    // Statuses, presence and voice over time only with adversarial features shown.
    const watched = this.retention().adversarial ? '' : ` AND NOT (target_kind = 'identity' AND field IN ('status', 'presence', 'voice'))`;
    const only = pick.fields?.length ? ` AND field IN (${pick.fields.map(() => '?').join(', ')})` : '';
    const not = pick.except?.length ? ` AND field NOT IN (${pick.except.map(() => '?').join(', ')})` : '';
    const rows = this.db
      .query(`SELECT * FROM change_log WHERE (${where})${watched}${only}${not} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...targets.flatMap((t) => [t.kind, t.id]), ...rolesOf, ...(pick.fields ?? []), ...(pick.except ?? []), limit) as Row[];
    const val = (r: Row, v: string | null): unknown => {
      const x = json<unknown>(v, null);
      return (r.field === 'avatar' || r.field === 'banner') && typeof x === 'string' ? this.media(x, r.account_id) : x;
    };
    return rows.map((r) => {
      const o = val(r, r.old);
      const n = val(r, r.new);
      const whose = r.field === 'member' ? (n ?? o) : r.field === 'role' ? ((n ?? o) as { identityId?: string } | null)?.identityId : undefined;
      return {
        id: r.id,
        target: { kind: r.target_kind, id: r.target_id },
        field: r.field,
        old: o,
        new: n,
        at: r.at,
        ...(r.actor_id ? { actorId: r.actor_id } : {}),
        ...(typeof whose === 'string' ? { identityId: whose } : {}),
      };
    });
  }

  /** A message's versions, oldest first, the last as it reads now; what else happened to it; who got and read it. */
  messageHistory(id: string): P.MessageHistoryView | null {
    const m = this.db.query('SELECT body, ts, edited_ts FROM message WHERE id = ?').get(id) as Row | null;
    if (!m) return null;
    const evs = this.db.query('SELECT * FROM message_event WHERE message_id = ? ORDER BY at, id').all(id) as Row[];
    const edits = evs.filter((e) => e.kind === 'edit');
    const versions = edits.map((e, i) => ({ body: json<{ body?: string }>(e.data, {}).body ?? '', at: i === 0 ? (m.ts as number) : (edits[i - 1].at as number) }));
    versions.push({ body: m.body, at: edits.at(-1)?.at ?? m.edited_ts ?? m.ts });
    const events = evs.filter((e) => e.kind !== 'edit').map((e): P.MessageEventView => {
      const base = { kind: e.kind, at: e.at, ...(e.actor_id ? { actorId: e.actor_id } : {}) };
      return e.kind === 'unreact' ? { ...base, ...unreactView(e.data) } : { ...base, data: json(e.data, null) };
    });
    const reactions = (this.db.query('SELECT identity_id, key, style, at, at_exact FROM reaction WHERE message_id = ? AND at IS NOT NULL ORDER BY at').all(id) as Row[]).map((r) => ({
      identityId: r.identity_id,
      key: r.key,
      style: r.style,
      at: r.at,
      ...(r.at_exact ? {} : { seen: true as const }),
    }));
    const receipts = (this.db.query('SELECT identity_id, state, at FROM receipt WHERE message_id = ? ORDER BY at').all(id) as Row[]).map((r) => ({ identityId: r.identity_id, state: r.state, at: r.at }));
    const ids = [...new Set([...events.flatMap((e) => (e.actorId ? [e.actorId] : [])), ...reactions.map((r) => r.identityId), ...receipts.map((r) => r.identityId)])];
    return { versions, events, reactions, receipts, identities: this.identitiesByIds(ids) };
  }

  /**
   * Who reacted with one emoji, when where known, and who took theirs back (docs/reactions.md "When").
   */
  reactorsView(messageId: string, key: string, style: P.ReactionStyle): P.MessageReactorsView {
    const r = this.messageView(messageId)?.reactions.find((x) => x.key === key && x.style === style);
    const takenBack = (this.db.query(`SELECT actor_id, data, at FROM message_event WHERE message_id = ? AND kind = 'unreact' AND actor_id IS NOT NULL ORDER BY at, id`).all(messageId) as Row[])
      .map((e) => ({ actorId: e.actor_id as string, at: e.at as number, ...unreactView(e.data) }))
      .filter((e) => e.data.key === key && e.data.style === style)
      .map(({ actorId, at, seen, data: d }): P.ReactionTakenBack => ({
        identityId: actorId,
        at,
        ...(seen ? { seen } : {}),
        ...(d.added != null ? { added: d.added, ...(d.addedSeen ? { addedSeen: true as const } : {}) } : {}),
        ...(d.cleared ? { cleared: true as const } : {}),
      }));
    const ids = [...new Set([...(r?.identityIds ?? []), ...takenBack.map((t) => t.identityId)])];
    return {
      count: r?.count ?? 0,
      identityIds: r?.identityIds ?? [],
      ...(r?.at ? { at: r.at } : {}),
      ...(r?.seenAt ? { seenAt: r.seenAt } : {}),
      takenBack,
      identities: this.identitiesByIds(ids),
    };
  }

  /** Which kinds have anything kept that Forget would erase. Each looks for one row (message_gone indexes the deleted). */
  keptKinds(): Record<P.KeptKind, boolean> {
    const any = (sql: string, ...args: string[]) => (this.db.query(`SELECT EXISTS (${sql}) AS hit`).get(...args) as Row).hit === 1;
    const gone = `SELECT 1 FROM message WHERE gone_how = ? AND deleted = 1 AND (body != '' OR EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = message.id))`;
    const logged = `SELECT 1 FROM change_log WHERE target_kind = 'identity' AND field = ?`;
    return {
      deleted: any(gone, 'deleted'),
      disappeared: any(gone, 'disappeared'),
      edits: any(`SELECT 1 FROM message_event WHERE kind = 'edit'`),
      reactions: any(`SELECT 1 FROM message_event WHERE kind = 'unreact'`),
      receipts: any('SELECT 1 FROM receipt'),
      changes: any('SELECT 1 FROM change_log') || any(`SELECT 1 FROM message_event WHERE kind IN ('pin', 'unpin')`),
      statuses: any(logged, 'status'),
      presence: any(logged, 'presence'),
      members: any('SELECT 1 FROM membership'),
      voice: voiceKept(this),
      profiles: any('SELECT 1 FROM profile_version'),
    };
  }

  /** Forget what was kept: deleted or disappeared messages' words and files, edits, reactions taken back, receipts, the change log, logged statuses or presence, or server members seen. */
  eraseKept(what: P.KeptKind): number {
    if (what === 'members') {
      this.db.query('DELETE FROM member_coverage').run();
      return this.db.query('DELETE FROM membership').run().changes;
    }
    if (what === 'voice') return eraseVoice(this);
    // Earlier versions of profiles; the last answer each network gave stays, as it does with the switch off.
    if (what === 'profiles') return this.db.query('DELETE FROM profile_version').run().changes;
    if (what === 'statuses' || what === 'presence')
      return this.db.query(`DELETE FROM change_log WHERE target_kind = 'identity' AND field = ?`).run(what === 'statuses' ? 'status' : 'presence').changes;
    const touched = (sql: string) => (this.db.query(sql).all() as Row[]).forEach((r) => this.dirty.messages.set(r.message_id, true));
    if (what === 'edits' || what === 'reactions') {
      const kind = what === 'edits' ? 'edit' : 'unreact';
      touched(`SELECT DISTINCT message_id FROM message_event WHERE kind = '${kind}'`);
      return this.db.query('DELETE FROM message_event WHERE kind = ?').run(kind).changes;
    }
    if (what === 'receipts') {
      touched('SELECT DISTINCT message_id FROM receipt');
      return this.db.query('DELETE FROM receipt').run().changes;
    }
    if (what === 'changes') {
      touched(`SELECT DISTINCT message_id FROM message_event WHERE kind IN ('pin', 'unpin')`);
      const pins = this.db.query(`DELETE FROM message_event WHERE kind IN ('pin', 'unpin')`).run().changes;
      this.db.query('UPDATE identity SET status = NULL WHERE status IS NOT NULL').run();
      return pins + this.db.query('DELETE FROM change_log').run().changes;
    }
    const ids = this.db.query(`SELECT id FROM message WHERE deleted = 1 AND gone_how = ? AND (body != '' OR EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = message.id))`).all(what) as Row[];
    for (const r of ids) {
      this.db.query(`UPDATE message SET body = '' WHERE id = ?`).run(r.id);
      this.db.query('DELETE FROM attachment WHERE message_id = ?').run(r.id);
      this.dirty.messages.set(r.id, true);
    }
    return ids.length;
  }


  /** A decision, and what it was made from; with the shadow model's chances. Marks already given stay. */
  setTriage(messageId: string, t: Pick<P.TriageView, 'decision' | 'score' | 'reasons' | 'decidedBy' | 'probs'> & { shadow?: P.TriageProbs; loud?: StoredLoud }, facts?: unknown) {
    this.db
      .query(
        `INSERT INTO triage (message_id, decision, score, reasons, decided_by, facts, probs, shadow, loud, loud_view, created_at, message_ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, (SELECT ts FROM message WHERE id = ?1))
         ON CONFLICT (message_id) DO UPDATE SET decision = excluded.decision, score = excluded.score, reasons = excluded.reasons,
           decided_by = excluded.decided_by, facts = COALESCE(excluded.facts, facts), probs = excluded.probs, shadow = excluded.shadow,
           loud = excluded.loud, loud_view = excluded.loud_view, created_at = excluded.created_at, message_ts = excluded.message_ts`,
      )
      .run(
        messageId,
        t.decision,
        t.score,
        JSON.stringify(t.reasons),
        t.decidedBy,
        facts ? JSON.stringify(facts) : null,
        t.probs ? JSON.stringify(t.probs) : null,
        t.shadow ? JSON.stringify(t.shadow) : null,
        t.loud ? t.loud.loudness : null,
        t.loud ? JSON.stringify(t.loud) : null,
        Date.now(),
      );
  }

  /** Your marks on a decision: each given key is set (null takes that mark back); the others stay. */
  triageMark(messageId: string, marks: P.TriageMarks, now = Date.now()) {
    const t = this.db.query('SELECT alert_mark, less_mark FROM triage WHERE message_id = ?').get(messageId) as Row | null;
    if (!t) return;
    const flag = (v: boolean | null | undefined, was: number | null) => (v === undefined ? was : v === null ? null : v ? 1 : 0);
    const alert = flag(marks.alert, t.alert_mark);
    // Only "less" is a mark: false takes it back.
    const less = marks.less === undefined ? t.less_mark : marks.less ? 1 : null;
    this.db.query('UPDATE triage SET alert_mark = ?, less_mark = ?, marked_at = ? WHERE message_id = ?').run(alert, less, alert === null && less === null ? null : now, messageId);
    this.dirty.messages.set(messageId, true);
  }

  setTriageFacts(messageId: string, facts: unknown) {
    this.db.query('UPDATE triage SET facts = ? WHERE message_id = ?').run(JSON.stringify(facts), messageId);
  }

  // ------------------------------------------------------------ views

  accountView(r: AccountRow): P.AccountView {
    return {
      id: r.id,
      network: r.network,
      label: r.label,
      color: r.color,
      status: r.status,
      attention: json(r.attention, null),
      selfIdentityId: r.self_identity,
      capabilities: json(r.capabilities, []),
      liveView: !!r.live_view,
      demo: !!r.demo,
      createdAt: r.created_at,
      ...((m) => (m ? { managedBy: m } : {}))(this.accountManaged(r.id)),
      ...accountSelfView(this, r.id),
      ...(r.network === 'calendar' ? { url: calendarAccountUrl(json(r.config, {})) } : {}),
    };
  }

  /** Something outside the row changed how an account looks (who runs it): send its view again. */
  accountChanged(id: string) {
    if (this.account(id)) this.dirty.accounts.add(id);
  }

  identityView(r: Row): P.IdentityView {
    return {
      id: r.id,
      network: r.network,
      nativeId: r.native_id,
      handle: r.handle,
      displayName: r.display_name,
      avatar: this.media(r.avatar_url, r.seen_via),
      isBot: !!r.is_bot,
      personId: r.person_id,
      ...(r.nickname ? { nickname: r.nickname } : {}),
      ...(r.status ? { status: json<NonNullable<P.IdentityView['status']>>(r.status, { at: 0 }) } : {}),
    };
  }

  identitiesByIds(ids: Iterable<string>): P.IdentityView[] {
    const list = [...new Set(ids)].filter(Boolean);
    const out: P.IdentityView[] = [];
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      const rows = this.db.query(`SELECT * FROM identity WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Row[];
      for (const r of rows) out.push(this.identityView(r));
    }
    return out;
  }

  /** `vias`: the accounts that saw each person's accounts, when a caller reads many (bootstrap); else looked up. */
  personView(r: Row, identityIds?: string[], vias?: Map<string, { via: string; url: string | null }[]>): P.PersonView {
    const ids = identityIds ?? (this.db.query('SELECT id FROM identity WHERE person_id = ?').all(r.id) as Row[]).map((x) => x.id);
    const avatar = !r.avatar_url ? null : vias ? this.media(r.avatar_url, pickVia(vias.get(r.id), r.avatar_url)) : this.personPicture(r.id, r.avatar_url);
    return { id: r.id, name: r.name, avatar, starred: false, isSelf: !!r.is_self, identityIds: ids, nameSource: (r.name_source ?? 'network') as P.NameSource, ...(ids.length > 1 && r.face_id ? { faceId: r.face_id } : {}), ...(ids.length > 1 && r.face_pinned ? { facePinned: true } : {}), ...(ids.length > 1 && r.picture_identity_id ? { pictureIdentityId: r.picture_identity_id } : {}) };
  }

  /**
   * A person's picture, signed through an account that saw one of their accounts: a picture only an account can fetch
   * (Zulip's `zulip:` paths, Matrix's `mxc://`) cannot be fetched with none. The account of the one the picture came
   * from first, else any of theirs still here.
   */
  personPicture(personId: string, url: string | null | undefined): string | null {
    if (!url) return null;
    const rows = this.db.query(`SELECT i.seen_via AS via, i.avatar_url AS url FROM identity i JOIN account a ON a.id = i.seen_via WHERE i.person_id = ?`).all(personId) as { via: string; url: string | null }[];
    return this.media(url, pickVia(rows, url));
  }

  spaceView(r: Row, accountIds?: string[], mute?: string | null): P.SpaceView {
    let acc = accountIds;
    let nm = mute;
    if (!acc) {
      const vs = this.db.query(`SELECT account_id, native_mute FROM vantage WHERE target_kind = 'space' AND target_id = ?`).all(r.id) as Row[];
      acc = vs.map((v) => v.account_id);
      nm = vs.find((v) => v.native_mute)?.native_mute ?? null;
    }
    const via = acc[0] ?? null;
    return { id: r.id, network: r.network, nativeId: r.native_id, kind: r.kind, name: r.name, topic: r.topic, icon: this.media(r.icon_url, via), accountIds: acc, nativeMute: json(nm, null) };
  }

  edgesOfSpace(id: string): P.SpaceEdgeView[] {
    return (this.db.query('SELECT * FROM space_edge WHERE parent_id = ? OR (child_kind = ? AND child_id = ?)').all(id, 'space', id) as Row[]).map(edgeView);
  }

  private preview(m: Row | null | undefined): P.MessagePreview | null {
    if (!m) return null;
    return { id: m.id, authorId: m.author_id, ts: m.ts, kind: m.kind, text: m.deleted ? 'Message deleted' : previewText(m.body, m.kind) };
  }

  conversationView(id: string): P.ConversationView | null {
    const r = this.db.query('SELECT * FROM conversation WHERE id = ?').get(id) as Row | null;
    if (!r) return null;
    const spaceIds = (this.db.query(`SELECT parent_id FROM space_edge WHERE child_kind = 'conversation' AND child_id = ?`).all(id) as Row[]).map((x) => x.parent_id);
    const parts = (this.db.query('SELECT identity_id FROM participant WHERE conversation_id = ? ORDER BY identity_id').all(id) as Row[]).map((x) => x.identity_id);
    const vs = this.db.query(`SELECT * FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`).all(id) as Row[];
    const last = r.last_message_id ? (this.db.query('SELECT * FROM message WHERE id = ?').get(r.last_message_id) as Row) : null;
    const other = r.shape === 'direct' ? parts.find((p) => !this.isSelf(p)) : undefined;
    return this.assembleConversation(r, spaceIds, parts, vs, last, this.peerOf(r, parts), other ? pendingLinks(this.db, [other]) : undefined, this.threadPartsOf([r]).get(id));
  }

  /** Threads' and forums' parts of these conversations, with each post's first message (threads.ts). */
  private threadPartsOf(rows: Row[]): Map<string, ThreadParts & { firstRow?: Row | null }> {
    const parts = threadParts(this, rows as never) as Map<string, ThreadParts & { firstRow?: Row | null }>;
    const firsts = [...parts.values()].map((p) => p.firstId).filter((x): x is string => !!x);
    if (!firsts.length) return parts;
    const found = new Map((this.db.query('SELECT * FROM message WHERE id IN (SELECT value FROM json_each(?)) AND deleted = 0').all(JSON.stringify(firsts)) as Row[]).map((m) => [m.id as string, m]));
    for (const [cid, p] of parts) {
      const m = p.firstId ? found.get(p.firstId) : undefined;
      // A post's first message is in the post; a thread started from a message has its starter in the channel.
      if (m && m.conversation_id === cid) p.firstRow = m;
    }
    return parts;
  }

  /** Many conversations at once, as bootstrap() reads them: a handful of queries rather than five per conversation. */
  conversationViews(ids: string[]): P.ConversationView[] {
    if (!ids.length) return [];
    const list = JSON.stringify(ids);
    const q = <T = Row>(sql: string) => this.db.query(sql).all(list) as T[];
    const rows = q(`SELECT * FROM conversation WHERE id IN (SELECT value FROM json_each(?))`);
    const group = (xs: Row[], key: string) => {
      const m = new Map<string, Row[]>();
      for (const x of xs) (m.get(x[key]) ?? m.set(x[key], []).get(x[key])!).push(x);
      return m;
    };
    const edges = group(q(`SELECT parent_id, child_id FROM space_edge WHERE child_kind = 'conversation' AND child_id IN (SELECT value FROM json_each(?))`), 'child_id');
    // In one order, as conversationView's: the app takes members in another order for a change of names (syncmodel.ts).
    const parts = group(q(`SELECT conversation_id, identity_id FROM participant WHERE conversation_id IN (SELECT value FROM json_each(?)) ORDER BY conversation_id, identity_id`), 'conversation_id');
    const vants = group(q(`SELECT * FROM vantage WHERE target_kind = 'conversation' AND target_id IN (SELECT value FROM json_each(?))`), 'target_id');
    const lasts = new Map(
      q(`SELECT m.* FROM message m WHERE m.id IN (SELECT last_message_id FROM conversation WHERE id IN (SELECT value FROM json_each(?)))`).map((m) => [m.id as string, m]),
    );
    const pending = rows.some((r) => r.shape === 'direct') ? pendingLinks(this.db) : undefined;
    const threads = this.threadPartsOf(rows);
    return rows.map((r) => {
      const ps = (parts.get(r.id) ?? []).map((p) => p.identity_id as string);
      return this.assembleConversation(r, (edges.get(r.id) ?? []).map((e) => e.parent_id), ps, vants.get(r.id) ?? [], lasts.get(r.last_message_id) ?? null, this.peerOf(r, ps), pending, threads.get(r.id));
    });
  }

  private peerOf(r: Row, parts: string[]): string | null {
    if (r.shape !== 'direct') return null;
    const peer = parts.find((p) => !this.isSelf(p));
    if (!peer) return null;
    return ((this.db.query('SELECT person_id FROM identity WHERE id = ?').get(peer) as Row) ?? {}).person_id ?? null;
  }

  private assembleConversation(r: Row, spaceIds: string[], parts: string[], vs: Row[], last: Row | null, peer: string | null, links?: Map<string, P.PendingLinkView>, th?: ThreadParts & { firstRow?: Row | null }): P.ConversationView {
    const via = vs[0]?.account_id ?? null;
    // A DM: a friend request between one of its accounts and the other person, either way (add.ts pendingLinks).
    const other = r.shape === 'direct' && links?.size ? parts.find((p) => !this.isSelf(p)) : undefined;
    const pending = other ? vs.map((v) => links!.get(`${v.account_id}\0${other}`)).find((x) => !!x) : undefined;
    return {
      id: r.id,
      network: r.network,
      nativeId: r.native_id,
      shape: r.shape,
      variant: r.variant,
      name: r.name,
      topic: r.topic,
      avatar: this.media(r.avatar_url, via),
      encrypted: !!r.encrypted,
      archived: !!r.archived,
      parentId: r.parent_id,
      spaceIds,
      participantIds: parts,
      peerPersonId: peer,
      vantages: vs.map((v) => ({ accountId: v.account_id, unread: v.unread, mentions: v.mentions, lastReadTs: v.last_read_ts })),
      lastMessage: this.preview(last),
      lastMessageAt: r.last_message_at,
      nativeMute: json(vs.find((v) => v.native_mute)?.native_mute ?? null, null),
      ...(pending ? { pending } : {}),
      ...(th?.thread || th?.firstRow ? { thread: this.threadView(th, via) } : {}),
      ...(th?.forum ? { forum: th.forum } : {}),
      ...(r.variant === 'follow' ? this.postFollowPart(r.id) : {}),
    };
  }

  /** A followed post's state (follows.ts), for its conversation's view. */
  postFollow(conversationId: string): P.PostFollow | null {
    const f = this.db.query('SELECT * FROM post_follow WHERE conversation_id = ?').get(conversationId) as Row | null;
    if (!f) return null;
    return {
      conversationId: f.conversation_id,
      accountId: f.account_id,
      since: f.since,
      stopped: f.stopped ?? null,
      ...(f.why ? { why: f.why } : {}),
      next: f.next_at ?? null,
      checked: f.checked_at ?? null,
      lastNew: f.last_new,
    };
  }

  private postFollowPart(conversationId: string): { follow?: P.PostFollow } {
    const f = this.postFollow(conversationId);
    return f ? { follow: f } : {};
  }

  /** A thread's view: its facts, its first message as a preview, and that message's first picture for a gallery. */
  private threadView(th: ThreadParts & { firstRow?: Row | null }, via: string | null): P.ThreadView {
    const base = th.thread ?? { following: [], notFollowing: [], notify: null, muted: false, mutedUntil: null, locked: false, tags: [], pinned: false, private: false, ownerId: null, createdAt: null, messageCount: null };
    let cover: string | null = null;
    if (th.firstRow) {
      const a = this.db.query(`SELECT url FROM attachment WHERE message_id = ? AND kind = 'image' ORDER BY position LIMIT 1`).get(th.firstRow.id) as Row | null;
      cover = a ? this.media(a.url, via) : null;
    }
    return { ...base, first: this.preview(th.firstRow ?? null), cover };
  }

  // ------------------------------------------------------------ reactions

  private markReacted(mid: string) {
    // Not news in itself, so it never turns a quiet update into a live one.
    this.dirty.messages.set(mid, this.dirty.messages.get(mid) ?? false);
  }

  private putEmoji(network: P.Network, e: P.CustomEmojiFact) {
    this.db
      .query(
        `INSERT INTO custom_emoji (network, key, name, url, animated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (network, key) DO UPDATE SET name = excluded.name, url = excluded.url, animated = excluded.animated`,
      )
      .run(network, e.key, e.name, e.url, e.animated ? 1 : 0);
  }

  /** Your reactions on a message, as a string: when it changes, what you owe there changes. */
  private selfReactions(mid: string): string {
    return (this.db.query('SELECT identity_id, key, style FROM reaction WHERE message_id = ? ORDER BY identity_id, key, style').all(mid) as Row[])
      .filter((r) => this.isSelf(r.identity_id))
      .map((r) => `${r.key}|${r.style}`)
      .join('\n');
  }

  private noteSelfReactions(mid: string, before: string) {
    if (this.selfReactions(mid) === before) return;
    const m = this.db.query('SELECT conversation_id FROM message WHERE id = ?').get(mid) as Row | null;
    if (m) this.selfReacted.add(m.conversation_id);
  }

  /** One person added or took back one reaction. */
  private applyReaction(acc: AccountRow, mid: string, ev: Extract<P.AdapterEvent, { t: 'reaction' }>) {
    const iid = this.ensureIdentity(acc, ev.author);
    if (this.isSelf(iid)) {
      const before = this.selfReactions(mid);
      this.applyReactionAs(acc, mid, ev, iid);
      this.noteSelfReactions(mid, before);
    } else this.applyReactionAs(acc, mid, ev, iid);
  }

  private applyReactionAs(acc: AccountRow, mid: string, ev: Extract<P.AdapterEvent, { t: 'reaction' }>, iid: string) {
    const key = canonicalReactionKey(ev.key);
    const style = ev.style ?? 'normal';
    // When (docs/reactions.md "When"): the network's own time where it gives one, else when the hub heard.
    const ts = reactionTs(ev.ts);
    const when = { at: ts ?? Date.now(), exact: ts !== null };
    if (ev.emoji) this.putEmoji(acc.network, ev.emoji);
    if (ev.remove) {
      const was = this.db.query('SELECT at, at_exact FROM reaction WHERE message_id = ? AND identity_id = ? AND key = ? AND style = ?').get(mid, iid, key, style) as Row | null;
      if (was) {
        this.db.query('DELETE FROM reaction WHERE message_id = ? AND identity_id = ? AND key = ? AND style = ?').run(mid, iid, key, style);
        this.takenBack(acc, mid, iid, key, style, was, when);
      }
      // Totals include people we never knew by name, so they go down anyway. Your own reactions are
      // always known, so a second removal of yours is only an echo of the first.
      if (was || !this.isSelf(iid)) this.db.query('UPDATE reaction_tally SET count = count - 1 WHERE message_id = ? AND key = ? AND style = ? AND count IS NOT NULL').run(mid, key, style);
      this.dropEmptyTallies(mid);
      return;
    }
    if (REACTION_RULES[acc.network].exclusive) {
      const others = this.db.query('SELECT key, style, at, at_exact FROM reaction WHERE message_id = ? AND identity_id = ? AND NOT (key = ? AND style = ?)').all(mid, iid, key, style) as Row[];
      for (const o of others) {
        this.db.query('DELETE FROM reaction WHERE message_id = ? AND identity_id = ? AND key = ? AND style = ?').run(mid, iid, o.key, o.style);
        this.db.query('UPDATE reaction_tally SET count = count - 1 WHERE message_id = ? AND key = ? AND style = ? AND count IS NOT NULL').run(mid, o.key, o.style);
        // Replaced: the old one was taken back as the new one was made.
        this.takenBack(acc, mid, iid, o.key, o.style, o, when);
      }
      this.dropEmptyTallies(mid);
    }
    const added = this.putReactor(mid, iid, key, style, ts, when.at);
    this.db.query('INSERT OR IGNORE INTO reaction_tally (message_id, key, style) VALUES (?, ?, ?)').run(mid, key, style);
    if (added) this.db.query('UPDATE reaction_tally SET count = count + 1 WHERE message_id = ? AND key = ? AND style = ? AND count IS NOT NULL').run(mid, key, style);
    if (ev.colors?.length) this.db.query('UPDATE reaction_tally SET colors = ? WHERE message_id = ? AND key = ? AND style = ?').run(JSON.stringify(ev.colors), mid, key, style);
  }

  /**
   * A reaction taken back, kept for Message history (docs/history.md): only one the hub saw them give, and not your
   * own. It says when it had been added, so a list of who reacted can show both (docs/reactions.md "When").
   */
  private takenBack(acc: AccountRow, mid: string, iid: string, key: string, style: string, was: Row, when: { at: number; exact: boolean }, cleared = false) {
    if ((!cleared && this.isSelf(iid)) || !this.keeps('reactions', acc)) return;
    const data = {
      key,
      style,
      ...(cleared ? { cleared: true } : {}),
      ...(when.exact ? { exact: true } : {}),
      ...(was.at != null ? { added: was.at, ...(was.at_exact ? { addedExact: true } : {}) } : {}),
    };
    this.messageEvent(mid, 'unreact', data, iid, acc.id, when.at);
  }

  private dropEmptyTallies(mid: string) {
    this.db
      .query(
        `DELETE FROM reaction_tally WHERE message_id = ? AND COALESCE(count, 0) <= 0 AND NOT EXISTS (
           SELECT 1 FROM reaction r WHERE r.message_id = reaction_tally.message_id AND r.key = reaction_tally.key AND r.style = reaction_tally.style)`,
      )
      .run(mid);
  }

  /** The whole reaction state of a message, as one account's network reports it. */
  private reactionSnapshot(acc: AccountRow, mid: string, facts: P.ReactionFact[], existed = true) {
    // A message new to the hub is folded with its reactions anyway.
    if (!existed) return this.applySnapshot(acc, mid, facts, false);
    const before = this.selfReactions(mid);
    this.applySnapshot(acc, mid, facts, true);
    this.noteSelfReactions(mid, before);
  }

  /**
   * Reactions as a whole. One new to the hub is timed as the network says; else, on a message the hub already had, by
   * when the hub heard of it; else (the message is new here too) not at all: it may be years old.
   */
  private applySnapshot(acc: AccountRow, mid: string, facts: P.ReactionFact[], existed: boolean) {
    const now = Date.now();
    const present = new Set(facts.map((r) => `${r.style ?? 'normal'}|${canonicalReactionKey(r.key)}`));
    for (const t of this.db.query('SELECT key, style FROM reaction_tally WHERE message_id = ?').all(mid) as Row[]) {
      if (present.has(`${t.style}|${t.key}`)) continue;
      this.db.query('DELETE FROM reaction WHERE message_id = ? AND key = ? AND style = ?').run(mid, t.key, t.style);
      this.db.query('DELETE FROM reaction_tally WHERE message_id = ? AND key = ? AND style = ?').run(mid, t.key, t.style);
    }
    for (const r of facts) {
      const key = canonicalReactionKey(r.key);
      const style = r.style ?? 'normal';
      if (r.emoji) this.putEmoji(acc.network, r.emoji);
      const authors = r.authors.map((a) => this.ensureIdentity(acc, a));
      // The whole list: whoever it leaves out is gone, and whoever it names keeps the time the hub had.
      if (r.count === undefined) {
        for (const x of this.db.query('SELECT identity_id FROM reaction WHERE message_id = ? AND key = ? AND style = ?').all(mid, key, style) as Row[])
          if (!authors.includes(x.identity_id)) this.db.query('DELETE FROM reaction WHERE message_id = ? AND identity_id = ? AND key = ? AND style = ?').run(mid, x.identity_id, key, style);
      }
      // A partial list keeps whoever we learned about, but this account does know whether it reacted itself.
      else if (acc.self_identity && !authors.includes(acc.self_identity)) {
        this.db.query('DELETE FROM reaction WHERE message_id = ? AND identity_id = ? AND key = ? AND style = ?').run(mid, acc.self_identity, key, style);
      }
      r.authors.forEach((native, i) => this.putReactor(mid, authors[i], key, style, reactionTs(r.at?.[native]), existed ? now : null));
      this.db
        .query(
          `INSERT INTO reaction_tally (message_id, key, style, count, colors) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (message_id, key, style) DO UPDATE SET count = excluded.count, colors = COALESCE(excluded.colors, colors)`,
        )
        .run(mid, key, style, r.count ?? null, r.colors?.length ? JSON.stringify(r.colors) : null);
    }
    this.dropEmptyTallies(mid);
  }

  private emojiView(row: Row | undefined, accountId: string | null | undefined): P.CustomEmojiView | undefined {
    return row && { key: row.key, name: row.name, url: this.media(row.url, accountId) ?? '', animated: !!row.animated };
  }

  /** The catalog entry for a key, as an adapter needs it. */
  customEmoji(network: P.Network, key: string): P.CustomEmojiFact | undefined {
    const r = this.db.query('SELECT * FROM custom_emoji WHERE network = ? AND key = ?').get(network, key) as Row | null;
    return r ? { key: r.key, name: r.name, url: r.url, animated: !!r.animated } : undefined;
  }

  /** A media URL as clients fetch it (signed, or inline). */
  mediaUrl(raw: string | null | undefined, accountId: string | null | undefined): string | null {
    return this.media(raw, accountId);
  }

  /** Remember what an adapter offered, so reactions made from the picker can be described later. */
  reactionContextView(accountId: string, network: P.Network, ctx: P.ReactionContext): P.ReactionContextView {
    this.db.transaction(() => {
      for (const g of ctx.custom) for (const e of g.emoji) this.putEmoji(network, e);
    })();
    return {
      ...ctx,
      accountId,
      custom: ctx.custom.map((g) => ({
        id: g.id,
        name: g.name,
        icon: this.media(g.icon, accountId),
        emoji: g.emoji.map((e) => ({ key: e.key, name: e.name, url: this.media(e.url, accountId) ?? '', animated: !!e.animated })),
      })),
    };
  }

  /** Which of your accounts holds a reaction, so taking it back goes through the right one. */
  reactionAccount(messageId: string, key: string, style: P.ReactionStyle): string | null {
    const r = this.db
      .query(
        `SELECT a.id FROM reaction r JOIN account a ON a.self_identity = r.identity_id
         WHERE r.message_id = ? AND r.key = ? AND r.style = ? LIMIT 1`,
      )
      .get(messageId, canonicalReactionKey(key), style) as Row | null;
    return r?.id ?? null;
  }

  /** Names behind a total. They are already in the count, and were made at no known time unless the network says. */
  addKnownReactors(acc: AccountRow, messageId: string, key: string, style: P.ReactionStyle, authors: string[], at?: Record<string, number>) {
    const k = canonicalReactionKey(key);
    for (const a of authors) this.putReactor(messageId, this.ensureIdentity(acc, a), k, style, reactionTs(at?.[a]), null);
    this.markReacted(messageId);
  }

  /**
   * One person's reaction, known to be there. New: at the network's time `ts`, else at `heard` (when the hub heard,
   * shown as "~" then), else at no known time. Already there: the network's time fills in one less sure.
   */
  private putReactor(mid: string, iid: string, key: string, style: string, ts: number | null, heard: number | null) {
    const added = this.db.query('INSERT OR IGNORE INTO reaction (message_id, identity_id, key, style, at, at_exact) VALUES (?, ?, ?, ?, ?, ?)').run(mid, iid, key, style, ts ?? heard, ts !== null ? 1 : 0).changes > 0;
    if (!added && ts !== null) this.db.query('UPDATE reaction SET at = ?, at_exact = 1 WHERE message_id = ? AND identity_id = ? AND key = ? AND style = ? AND (at IS NULL OR at_exact = 0)').run(ts, mid, iid, key, style);
    return added;
  }

  /** Enough across every network that the picker's 36 frequent emoji fill up once it keeps only one network's. */
  reactionUsage(): P.ReactionUsage[] {
    const rows = this.db
      .query(
        `SELECT r.key, i.network, COUNT(*) AS n, e.key AS emoji_key, e.name, e.url, e.animated
         FROM reaction r
         JOIN account a ON a.self_identity = r.identity_id
         JOIN identity i ON i.id = r.identity_id
         LEFT JOIN custom_emoji e ON e.network = i.network AND e.key = r.key
         WHERE a.demo = 0 OR NOT EXISTS (SELECT 1 FROM account WHERE demo = 0)
         GROUP BY r.key, i.network ORDER BY n DESC LIMIT 120`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      key: r.key,
      network: r.network,
      count: r.n,
      emoji: r.emoji_key ? this.emojiView({ key: r.emoji_key, name: r.name, url: r.url, animated: r.animated }, this.accountOfNetwork(r.network)) : undefined,
    }));
  }

  private accountOfNetwork(network: P.Network): string | null {
    return (this.db.query('SELECT id FROM account WHERE network = ? AND demo = 0 LIMIT 1').get(network) as Row | null)?.id ?? null;
  }

  messageViews(rows: Row[]): P.MessageView[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    const atts = this.db.query(`SELECT * FROM attachment WHERE message_id IN (${ph}) ORDER BY position`).all(...ids) as Row[];
    const infos = atts.length ? infoFor(this.db, atts.map((a) => a.url)) : null;
    const reacts = this.db.query(`SELECT * FROM reaction WHERE message_id IN (${ph})`).all(...ids) as Row[];
    const tallies = this.db.query(`SELECT * FROM reaction_tally WHERE message_id IN (${ph}) ORDER BY seq`).all(...ids) as Row[];
    const emoji = new Map(
      (this.db.query(`SELECT * FROM custom_emoji WHERE (network, key) IN (SELECT m.network, t.key FROM reaction_tally t JOIN message m ON m.id = t.message_id WHERE t.message_id IN (${ph}))`).all(...ids) as Row[]).map((e) => [`${e.network}|${e.key}`, e]),
    );
    const seen = this.db.query(`SELECT * FROM message_seen WHERE message_id IN (${ph})`).all(...ids) as Row[];
    const tri = this.db.query(`SELECT * FROM triage WHERE message_id IN (${ph})`).all(...ids) as Row[];
    const marks = new Map((this.db.query(`SELECT message_id, mark FROM reply_mark WHERE message_id IN (${ph}) AND undone_at IS NULL`).all(...ids) as Row[]).map((r) => [r.message_id as string, r.mark as P.ReplyMark]));
    const sentForwards = new Map((this.db.query(`SELECT * FROM forward_sent WHERE message_id IN (${ph})`).all(...ids) as Row[]).map((f) => [f.message_id, json<P.ForwardView | null>(f.data, null)]));
    const by = <T extends Row>(xs: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) (m.get(x.message_id) ?? m.set(x.message_id, []).get(x.message_id)!).push(x);
      return m;
    };
    const A = by(atts), R = by(reacts), S = by(seen), RT = by(tallies);
    // History kept per message (docs/history.md): edits, other events, the last pin or unpin, receipts of your own.
    const evRows = this.db.query(`SELECT message_id, kind, COUNT(*) AS n, MAX(at) AS last FROM message_event WHERE message_id IN (${ph}) GROUP BY message_id, kind`).all(...ids) as Row[];
    const E = new Map<string, number>();
    const EV = new Map<string, number>();
    const PIN = new Map<string, { at: number; pinned: boolean }>();
    for (const e of evRows) {
      if (e.kind === 'edit') E.set(e.message_id, e.n);
      else EV.set(e.message_id, (EV.get(e.message_id) ?? 0) + e.n);
      if (e.kind === 'pin' || e.kind === 'unpin') {
        const cur = PIN.get(e.message_id);
        if (!cur || e.last > cur.at) PIN.set(e.message_id, { at: e.last, pinned: e.kind === 'pin' });
      }
    }
    // The version before the last edit, for marking what that edit put in: each edit event keeps the body it replaced.
    const PREV = new Map<string, string>();
    const edited = [...E.keys()];
    if (edited.length)
      for (const e of this.db.query(`SELECT message_id, data FROM message_event WHERE kind = 'edit' AND message_id IN (${edited.map(() => '?').join(',')}) ORDER BY at, id`).all(...edited) as Row[]) {
        const body = json<{ body?: string }>(e.data, {}).body;
        if (typeof body === 'string') PREV.set(e.message_id, body);
      }
    const RC = new Map<string, NonNullable<P.MessageView['receipts']>>();
    for (const r of this.db.query(`SELECT message_id, identity_id, state, at FROM receipt WHERE message_id IN (${ph}) ORDER BY at`).all(...ids) as Row[]) {
      const cur = RC.get(r.message_id) ?? { delivered: 0, read: 0, played: 0, latest: { identityId: r.identity_id, state: r.state, at: r.at } };
      cur[r.state as P.ReceiptState]++;
      cur.latest = { identityId: r.identity_id, state: r.state, at: r.at };
      RC.set(r.message_id, cur);
    }
    const T = new Map(tri.map((t) => [t.message_id, t]));
    const POLL = pollViews(this.db, rows, (id) => this.isSelf(id));
    // What was kept of deleted and disappeared messages stays out of sight with adversarial features hidden.
    const unseal = this.retention().adversarial;
    return rows.map((r) => {
      const sealed = !!r.deleted && !unseal;
      const seenVia = (S.get(r.id) ?? []).map((s) => s.account_id);
      // Who, and when where known: the network's time, or when the hub heard (docs/reactions.md "When").
      const rx = new Map<string, { ids: string[]; at?: Record<string, number>; seenAt?: Record<string, number> }>();
      for (const x of R.get(r.id) ?? []) {
        const k = `${x.style}|${x.key}`;
        const e = rx.get(k) ?? rx.set(k, { ids: [] }).get(k)!;
        e.ids.push(x.identity_id);
        if (x.at != null) (x.at_exact ? (e.at ??= {}) : (e.seenAt ??= {}))[x.identity_id] = x.at;
      }
      const t = T.get(r.id);
      const extra = json<StoredExtra & { encryptionWarning?: string; forward?: P.ForwardFact; feed?: unknown; post?: P.PostFact }>(r.extra, {});
      const encryptionWarning = extra.encryptionWarning;
      const forward = sentForwards.get(r.id) ?? (extra.forward ? this.forwardView(r.network, extra.forward) : null);
      const rich = sealed ? undefined : richView(extra, r.network, r.body, this.linkedMessage);
      const { notes, ...extras } = r.extra && !sealed ? this.extraView(r, extra as Record<string, unknown>, seenVia[0]) : {};
      // A feed conversation's message (docs/feed.md): what they did, with hub ids and signed pictures.
      const fi = extra.feed ? feedItemOf(extra) : null;
      const feed = fi ? feedView(fi, r.network, (u) => this.media(u, seenVia[0])) : null;
      // A logged post (posts.ts, docs/feed.md "Threads"): the post as the network last showed it.
      const post = extra.post && typeof extra.post === 'object' && typeof extra.post.id === 'string' ? postView({ ...extra.post, text: r.body }, r.network, (u) => this.media(u, seenVia[0])) : null;
      return {
        ...(encryptionWarning ? { encryptionWarning } : {}),
        ...(forward ? { forward } : {}),
        ...(feed ? { feed } : {}),
        ...(post ? { post } : {}),
        ...extras,
        id: r.id,
        conversationId: r.conversation_id,
        network: r.network,
        nativeId: r.native_id,
        authorId: r.author_id,
        ts: r.ts,
        editedTs: r.edited_ts,
        kind: r.kind,
        body: sealed ? '' : r.body,
        replyToId: r.reply_to_id,
        threadId: r.thread_id,
        mentionsSelf: !!r.mentions_self,
        deleted: !!r.deleted,
        ...(r.deleted && r.gone_how ? { gone: { how: r.gone_how, at: r.gone_at, kept: !sealed && (!!r.body || !!A.get(r.id)?.length) } } : {}),
        ...(E.get(r.id) ? { edits: E.get(r.id) } : {}),
        ...(!sealed && PREV.has(r.id) ? { prevBody: PREV.get(r.id) } : {}),
        ...(EV.get(r.id) ? { events: EV.get(r.id) } : {}),
        ...(PIN.get(r.id)?.pinned ? { pinned: true } : {}),
        ...(RC.get(r.id) ? { receipts: RC.get(r.id) } : {}),
        attachments: (sealed ? [] : (A.get(r.id) ?? [])).map((a) =>
          withNote(
            {
              id: a.id,
              kind: a.kind,
              mime: a.mime,
              name: a.name,
              size: a.size,
              width: a.width,
              height: a.height,
              url: this.media(a.url, seenVia[0]) ?? '',
              ...(infos?.get(a.url) ? { info: infos.get(a.url) } : {}),
              ...attachmentRich(a),
            },
            notes?.[a.position],
          ),
        ),
        embeds: embedViews(extra, (u) => this.media(u, seenVia[0])),
        ...(rich ? { rich } : {}),
        ...(POLL.has(r.id) && !sealed ? { poll: POLL.get(r.id) } : {}),
        reactions: (RT.get(r.id) ?? [])
          .map((t): P.ReactionView => {
            const who = rx.get(`${t.style}|${t.key}`);
            const identityIds = who?.ids ?? [];
            const e = this.emojiView(emoji.get(`${r.network}|${t.key}`), seenVia[0]);
            const colors = json<string[] | null>(t.colors, null);
            return {
              key: t.key,
              style: t.style,
              count: Math.max(t.count ?? 0, identityIds.length),
              identityIds,
              ...(who?.at ? { at: who.at } : {}),
              ...(who?.seenAt ? { seenAt: who.seenAt } : {}),
              ...(e ? { emoji: e } : {}),
              ...(colors ? { colors } : {}),
            };
          })
          .filter((x) => x.count > 0),
        seenVia,
        triage: t ? triageView(t) : null,
        ...(marks.has(r.id) ? { replyMark: marks.get(r.id) } : {}),
      };
    });
  }

  /** A message a link points at, as stored, with its file count: never fetched for a link (rich.ts). */
  private linkedMessage = (network: P.Network, nativeId: string): Row | null =>
    this.db.query('SELECT id, conversation_id, author_id, ts, body, deleted, (SELECT COUNT(*) FROM attachment a WHERE a.message_id = message.id) AS attachments FROM message WHERE id = ?').get(hubId('msg', network, nativeId)) as Row | null;

  /** What a message's extra says beyond its text, as the web shows it (msgextra.ts). */
  private extraView(r: Row, extra: Record<string, unknown>, via: string | undefined) {
    return extraView(extra, r.reply_to_id, {
      identity: (native) => {
        const row = (/^\+\d+$/.test(native)
          ? this.db.query('SELECT id FROM identity WHERE network = ? AND handle = ? LIMIT 1').get(r.network, native)
          : this.db.query('SELECT id FROM identity WHERE id = ?').get(hubId('idn', r.network, native))) as Row | null;
        return row?.id ?? null;
      },
      isSelf: (native) => this.isSelf(hubId('idn', r.network, native)),
      media: (url) => this.media(url, via),
      stored: (id) => !!this.db.query('SELECT 1 FROM message WHERE id = ?').get(id),
    });
  }

  // ------------------------------------------------------------ forwards

  /** A forward as the network marked it, with whatever this hub knows about where it came from. */
  private forwardView(network: P.Network, f: P.ForwardFact): P.ForwardView {
    const known = (table: string, id: string) => !!this.db.query(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
    const messageId = f.message && known('message', hubId('msg', network, f.message)) ? hubId('msg', network, f.message) : null;
    const original = messageId ? (this.db.query('SELECT conversation_id, author_id, ts FROM message WHERE id = ?').get(messageId) as Row) : null;
    const conversationId = original?.conversation_id ?? (f.conversation && known('conversation', hubId('cnv', network, f.conversation)) ? hubId('cnv', network, f.conversation) : null);
    const authorId = original?.author_id ?? (f.author && known('identity', hubId('idn', network, f.author)) ? hubId('idn', network, f.author) : null);
    const space = !conversationId && f.space ? (this.db.query('SELECT name FROM space WHERE id = ?').get(hubId('spc', network, f.space)) as Row | null)?.name : null;
    return {
      messageId,
      conversationId,
      authorId,
      authorName: f.authorName ?? null,
      network,
      source: conversationId ? this.placeLabel(conversationId) : (space ?? null),
      ts: f.ts ?? original?.ts ?? null,
    };
  }

  /** Where a conversation is, in words: "#general · Server", a group's name, or the person a DM is with. */
  placeLabel(conversationId: string): string | null {
    const c = this.conversationView(conversationId);
    if (!c) return null;
    if (c.shape === 'direct') {
      const peer = c.participantIds.find((p) => !this.isSelf(p));
      const r = peer ? (this.db.query('SELECT nickname, display_name, handle, native_id FROM identity WHERE id = ?').get(peer) as Row | null) : null;
      const person = c.peerPersonId ? (this.db.query('SELECT name FROM person WHERE id = ?').get(c.peerPersonId) as Row | null) : null;
      return person?.name ?? (r ? shownName(r) : 'a direct message');
    }
    if (c.shape === 'self') return 'Notes to self';
    const name = c.name ?? 'a conversation';
    const top = this.communityName(c.spaceIds[0] ?? (c.parentId ? this.conversationView(c.parentId)?.spaceIds[0] : undefined));
    // Discord's channels go by #name, as in its client (model.ts convTitle); a Matrix room or a Telegram topic by its name.
    const label = c.network === 'discord' && (c.shape === 'channel' || c.shape === 'thread') ? `#${name}` : name;
    return top ? `${label} · ${top}` : label;
  }

  private communityName(spaceId: string | undefined, depth = 0): string | null {
    if (!spaceId || depth > 6) return null;
    const s = this.db.query('SELECT name, kind FROM space WHERE id = ?').get(spaceId) as Row | null;
    if (!s) return null;
    if (s.kind !== 'section') return s.name;
    const up = this.db.query(`SELECT parent_id FROM space_edge WHERE child_kind = 'space' AND child_id = ? LIMIT 1`).get(spaceId) as Row | null;
    return this.communityName(up?.parent_id, depth + 1) ?? s.name;
  }

  /** Remember that this hub sent a message as a forward. Shown as one at once if the message is already here. */
  recordForward(messageId: string, view: P.ForwardView, now = Date.now()) {
    this.db.query('INSERT OR REPLACE INTO forward_sent (message_id, data, created_at) VALUES (?, ?, ?)').run(messageId, JSON.stringify(view), now);
    if (this.db.query('SELECT 1 FROM message WHERE id = ?').get(messageId)) this.dirty.messages.set(messageId, false);
  }

  /** What a forward of this message carries: the content, its files as the adapter gave them, and who could read it. */
  forwardSource(messageId: string): {
    view: P.MessageView;
    conversationNative: string;
    authorName: string | null;
    files: { url: string; name: string | null; mime: string | null; kind: P.AttachmentKind; size: number | null }[];
  } | null {
    const r = this.db.query('SELECT * FROM message WHERE id = ?').get(messageId) as Row | null;
    if (!r || r.deleted) return null;
    const view = this.messageViews([r])[0];
    const conv = this.nativeOf('conversation', r.conversation_id);
    if (!conv) return null;
    const files = (this.db.query('SELECT url, name, mime, kind, size FROM attachment WHERE message_id = ? ORDER BY position').all(messageId) as Row[]).map((a) => ({ url: a.url, name: a.name, mime: a.mime, kind: a.kind, size: a.size }));
    return { view, conversationNative: conv.nativeId, authorName: this.identityLabel(r.author_id), files };
  }

  /** A person's name for an identity: the merged person, else what the network calls them. */
  identityLabel(identityId: string | null): string | null {
    if (!identityId) return null;
    const r = this.db.query('SELECT i.nickname, i.display_name, i.handle, p.name AS person FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.id = ?').get(identityId) as Row | null;
    return r ? (r.person ?? (r.nickname || r.display_name || r.handle) ?? null) : null;
  }

  messageView(id: string): P.MessageView | null {
    const r = this.db.query('SELECT * FROM message WHERE id = ?').get(id) as Row | null;
    return r ? this.messageViews([r])[0] : null;
  }

  identitiesOf(msgs: P.MessageView[]): P.IdentityView[] {
    const ids = new Set<string>();
    for (const m of msgs) {
      if (m.authorId) ids.add(m.authorId);
      for (const r of m.reactions) for (const i of r.identityIds) ids.add(i);
    }
    // Mentions inside bodies: <@nativeId>
    const natives = new Map<string, Set<string>>();
    for (const m of msgs)
      for (const mm of m.body.matchAll(/<@!?([^>\s]+)>/g)) (natives.get(m.network) ?? natives.set(m.network, new Set()).get(m.network)!).add(mm[1]);
    for (const [net, set] of natives) for (const n of set) ids.add(hubId('idn', net as P.Network, n));
    return this.identitiesByIds(ids);
  }

  messages(conversationId: string, beforeTs: number | null, limit: number): P.MessagePage {
    const rows = this.db
      .query(`SELECT * FROM message WHERE conversation_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?`)
      .all(conversationId, beforeTs ?? Number.MAX_SAFE_INTEGER, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const msgs = this.messageViews(page);
    // Include the messages that replies point at, so quotes render.
    const replyIds = msgs.map((m) => m.replyToId).filter((x): x is string => !!x && !page.some((p) => p.id === x));
    const quoted = replyIds.length
      ? this.messageViews(this.db.query(`SELECT * FROM message WHERE id IN (${replyIds.map(() => '?').join(',')})`).all(...replyIds) as Row[])
      : [];
    return { messages: msgs, identities: this.identitiesOf([...msgs, ...quoted]), hasMore, ...(quoted.length ? { quoted } : {}) } as P.MessagePage;
  }

  /**
   * What the feeds said about one post (docs/feed.md "The feed's page"): every like, repost, reply and quote of it in
   * any account's feed of its network, newest first, as a page. The page's list of who liked or reposted it reads
   * this, whatever pages of the feed it holds.
   */
  postActivity(network: P.Network, postId: string, limit = 1000): P.MessagePage {
    const rows = this.db
      .query(
        `SELECT m.* FROM message m JOIN conversation c ON c.id = m.conversation_id
         WHERE c.variant = 'feed' AND c.network = ? AND m.deleted = 0 AND json_extract(m.extra, '$.feed.post.id') = ?
         ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(network, postId, limit + 1) as Row[];
    const msgs = this.messageViews(rows.slice(0, limit));
    return { messages: msgs, identities: this.identitiesOf(msgs), hasMore: rows.length > limit } as P.MessagePage;
  }

  /** Every direct conversation with a person, merged into one timeline. */
  personTimeline(personId: string, before: number | { ts: number; id: string | null } | null, limit: number): P.MessagePage & { conversationIds: string[] } {
    return this.mergedTimeline(this.personDirects(personId), typeof before === 'number' ? { ts: before, id: null } : before, limit);
  }

  /** Every direct conversation with a person: their chat (chats.ts). */
  personDirects(personId: string): string[] {
    return (
      this.db
        .query(
          `SELECT DISTINCT c.id FROM conversation c JOIN participant p ON p.conversation_id = c.id JOIN identity i ON i.id = p.identity_id
           WHERE c.shape = 'direct' AND i.person_id = ?`,
        )
        .all(personId) as Row[]
    ).map((r) => r.id as string);
  }

  /**
   * A channel's stream (docs/threads.md "The channel stream"): the channel itself and every thread under it, as one
   * timeline. A Zulip channel takes no messages of its own; a Matrix room does.
   */
  channelStream(channelId: string): string[] {
    return (this.db.query(`SELECT id FROM conversation WHERE id = ? OR (parent_id = ? AND shape = 'thread') ORDER BY id`).all(channelId, channelId) as Row[]).map((r) => r.id as string);
  }

  /**
   * Several conversations as one timeline, newest first in pages. `before` is the oldest message held: its time, and
   * its id when known, so a message sharing that time in another conversation is not skipped (chats.ts parseCursor).
   */
  mergedTimeline(convs: string[], before: { ts: number; id: string | null } | null, limit: number): P.MessagePage & { conversationIds: string[] } {
    if (!convs.length) return { messages: [], identities: [], hasMore: false, conversationIds: [] };
    const ph = convs.map(() => '?').join(',');
    const ts = before?.ts ?? Number.MAX_SAFE_INTEGER;
    const rows = (
      before?.id
        ? this.db.query(`SELECT * FROM message WHERE conversation_id IN (${ph}) AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT ?`).all(...convs, ts, ts, before.id, limit + 1)
        : this.db.query(`SELECT * FROM message WHERE conversation_id IN (${ph}) AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?`).all(...convs, ts, limit + 1)
    ) as Row[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const msgs = this.messageViews(page);
    // The messages replies point at, so quotes render.
    const replyIds = [...new Set(msgs.map((m) => m.replyToId).filter((x): x is string => !!x && !page.some((p) => p.id === x)))];
    const quoted = replyIds.length ? this.messageViews(this.db.query(`SELECT * FROM message WHERE id IN (${replyIds.map(() => '?').join(',')})`).all(...replyIds) as Row[]) : [];
    return { messages: msgs, identities: this.identitiesOf([...msgs, ...quoted]), hasMore, conversationIds: convs, ...(quoted.length ? { quoted } : {}) } as P.MessagePage & { conversationIds: string[] };
  }

  /** By person, or by identity for someone who is only a name in a channel so far. */
  profile(ref: { personId?: string; identityId?: string }): P.ProfileView | null {
    const person = ref.personId ? (this.db.query('SELECT * FROM person WHERE id = ?').get(ref.personId) as Row | null) : null;
    const ids = person
      ? (this.db.query('SELECT id FROM identity WHERE person_id = ?').all(person.id) as Row[]).map((r) => r.id as string)
      : ref.identityId && this.db.query('SELECT 1 FROM identity WHERE id = ?').get(ref.identityId)
        ? [ref.identityId]
        : [];
    if (!ids.length && !person) return null;
    const ph = ids.map(() => '?').join(',') || "''";
    const convs = this.db
      .query(
        `SELECT c.id, COALESCE(m.n, 0) AS n, m.last FROM conversation c
         LEFT JOIN (SELECT conversation_id, COUNT(*) AS n, MAX(ts) AS last FROM message WHERE author_id IN (${ph}) AND deleted = 0 GROUP BY conversation_id) m ON m.conversation_id = c.id
         WHERE m.n IS NOT NULL OR EXISTS (SELECT 1 FROM participant p WHERE p.conversation_id = c.id AND p.identity_id IN (${ph}))
         ORDER BY COALESCE(m.last, 0) DESC LIMIT 100`,
      )
      .all(...ids, ...ids) as Row[];
    const recent = this.messageViews(this.db.query(`SELECT * FROM message WHERE author_id IN (${ph}) AND deleted = 0 ORDER BY ts DESC LIMIT 15`).all(...ids) as Row[]);
    const span = this.db.query(`SELECT COUNT(*) AS n, MIN(ts) AS first FROM message WHERE author_id IN (${ph}) AND deleted = 0`).get(...ids) as Row;
    return {
      personId: person?.id ?? ((this.db.query('SELECT person_id FROM identity WHERE id = ?').get(ids[0] ?? '') as Row | null)?.person_id ?? null),
      note: person?.note ?? null,
      identityIds: ids,
      identities: this.identitiesByIds(ids),
      conversations: convs.map((c) => ({ id: c.id, messages: c.n, lastTs: c.last ?? null })),
      recent,
      mentioned: this.identitiesOf(recent),
      totalMessages: span.n,
      firstSeenTs: span.first ?? null,
      abouts: [],
      ...(this.recordsMembers() ? { memberOf: this.memberOf(ids) } : {}),
    };
  }

  inbox(sinceTs: number, now = Date.now()): P.InboxPage {
    const rows: Row[] = [];
    const got = new Map<string, number>();
    for (const q of Store.inboxQueries(sinceTs, now)) {
      const left = q.limit - (got.get(q.pick) ?? 0);
      if (left <= 0) continue;
      const r = this.db.query(q.sql).all(q.since, left) as Row[];
      got.set(q.pick, (got.get(q.pick) ?? 0) + r.length);
      rows.push(...r);
    }
    rows.sort((a, b) => b.ts - a.ts);
    const msgs = this.messageViews(rows);
    return { items: msgs.map((m) => ({ message: m, conversationId: m.conversationId })), identities: this.identitiesOf(msgs) };
  }

  /**
   * The inbox's picks. Alerts and Conversations have their own share, so a busy list cannot push them out; the list
   * is what matters most, not what came last; and the most important of what fell below it, to mark. A week of
   * triage is hundreds of thousands of rows, so each walks an index and stops at its limit
   * (test/inbox-plan.test.ts): alerts and Conversations newest first along triage_notified, by the message's time
   * kept on its decision (they are kept for good, so sorting them all grew without end); the list and below by
   * importance, best first, then (with what is left of the limit) the many without a score, newest first along
   * message_ts. That is ORDER BY score DESC, ts DESC with no score last, as one query had it, without sorting the week.
   */
  static inboxQueries(sinceTs: number, now = Date.now()) {
    const at = `t.decision`;
    const ok = `m.ts >= ? AND m.deleted = 0 AND t.decision != 'silent'`;
    const byLevel = (level: string, scored: boolean) =>
      scored
        ? `SELECT m.* FROM triage t CROSS JOIN message m ON m.id = t.message_id WHERE ${at} = '${level}' AND t.score IS NOT NULL AND ${ok} ORDER BY t.score DESC, m.ts DESC LIMIT ?`
        : `SELECT m.* FROM message m CROSS JOIN triage t ON t.message_id = m.id WHERE ${at} = '${level}' AND t.score IS NULL AND ${ok} ORDER BY m.ts DESC LIMIT ?`;
    const drop = Math.max(sinceTs, now - 2 * 86_400_000);
    return [
      {
        pick: 'notified',
        limit: 150,
        since: sinceTs,
        sql: `SELECT m.* FROM triage t INDEXED BY triage_notified CROSS JOIN message m ON m.id = t.message_id WHERE ${at} IN ('push', 'quiet') AND t.message_ts >= ? AND m.deleted = 0 ORDER BY t.message_ts DESC LIMIT ?`,
      },
      { pick: 'digest', limit: 300, since: sinceTs, sql: byLevel('digest', true) },
      { pick: 'digest', limit: 300, since: sinceTs, sql: byLevel('digest', false) },
      { pick: 'drop', limit: 40, since: drop, sql: byLevel('drop', true) },
      { pick: 'drop', limit: 40, since: drop, sql: byLevel('drop', false) },
    ];
  }

  /** Quoted for FTS5, so what people type can never be a syntax error or an operator. */
  private ftsQuery(q: P.SearchQuery): string | null {
    const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
    const parts = [...q.phrases.map(quote), ...q.terms.map((t, i) => quote(t) + (i === q.terms.length - 1 ? '*' : ''))];
    if (!parts.length) return null;
    return parts.join(' ') + q.not.map((t) => ` NOT ${quote(t)}`).join('');
  }

  /** Conversations in, or under, places whose name matches: channels, rooms, groups, whole communities. */
  conversationsNamed(name: string): string[] {
    if (/^cnv_/.test(name)) return [name];
    // A person's id: every chat with them (the header's search on their page, all chats together).
    if (/^per_/.test(name)) {
      const directs = this.personDirects(name);
      if (directs.length) return directs;
    }
    const like = `%${likeEscape(name)}%`;
    const out = new Set((this.db.query(`SELECT id FROM conversation WHERE name LIKE ? ESCAPE '\\' OR id = ?`).all(like, name) as Row[]).map((r) => r.id as string));
    const spaces = (this.db.query(`SELECT id FROM space WHERE name LIKE ? ESCAPE '\\' OR id = ?`).all(like, name) as Row[]).map((r) => r.id as string);
    for (const id of this.conversationsUnder(spaces)) out.add(id);
    for (const id of [...out]) for (const t of this.db.query('SELECT id FROM conversation WHERE parent_id = ?').all(id) as Row[]) out.add(t.id);
    return [...out];
  }

  /** Conversations in these spaces or their sections, and those conversations' threads. */
  private conversationsUnder(spaceIds: string[]): string[] {
    const out = new Set<string>();
    let frontier = spaceIds;
    const seen = new Set(frontier);
    while (frontier.length) {
      const next: string[] = [];
      for (const sid of frontier) {
        for (const e of this.db.query('SELECT child_kind, child_id FROM space_edge WHERE parent_id = ?').all(sid) as Row[]) {
          if (e.child_kind === 'conversation') out.add(e.child_id);
          else if (!seen.has(e.child_id)) (seen.add(e.child_id), next.push(e.child_id));
        }
      }
      frontier = next;
    }
    for (const id of [...out]) for (const t of this.db.query('SELECT id FROM conversation WHERE parent_id = ?').all(id) as Row[]) out.add(t.id);
    return [...out];
  }

  identitiesNamed(name: string): string[] {
    if (/^idn_/.test(name)) return [name];
    const like = `%${likeEscape(name)}%`;
    return (
      this.db
        .query(
          `SELECT i.id FROM identity i LEFT JOIN person p ON p.id = i.person_id
           WHERE i.nickname LIKE ?1 ESCAPE '\\' OR i.display_name LIKE ?1 ESCAPE '\\' OR i.handle LIKE ?1 ESCAPE '\\' OR i.native_id = ?2 OR p.name LIKE ?1 ESCAPE '\\'`,
        )
        .all(like, name) as Row[]
    ).map((r) => r.id);
  }

  /**
   * Who could be merged into a person (the profile's merge box): people by their name or any of their identities'
   * names and handles (so an email address finds its person), and email identities no person holds yet. Never you.
   */
  mergeCandidates(q: string, exceptPersonId: string | null, limit = 12): { persons: P.PersonView[]; identities: P.IdentityView[] } {
    const needle = q.trim();
    if (!needle) return { persons: [], identities: [] };
    const like = `%${likeEscape(needle)}%`;
    const persons = this.db
      .query(
        `SELECT p.* FROM person p WHERE p.is_self = 0 AND p.id != ?2 AND (p.name LIKE ?1 ESCAPE '\\' OR EXISTS (SELECT 1 FROM identity i WHERE i.person_id = p.id
           AND (i.nickname LIKE ?1 ESCAPE '\\' OR i.display_name LIKE ?1 ESCAPE '\\' OR i.handle LIKE ?1 ESCAPE '\\' OR i.native_id LIKE ?1 ESCAPE '\\')))
         ORDER BY p.name LIMIT ?3`,
      )
      .all(like, exceptPersonId ?? '', limit) as Row[];
    const loose = this.db
      .query(`SELECT * FROM identity WHERE network = 'email' AND person_id IS NULL AND (display_name LIKE ?1 ESCAPE '\\' OR native_id LIKE ?1 ESCAPE '\\') ORDER BY display_name, native_id LIMIT ?2`)
      .all(like, limit) as Row[];
    const views = persons.map((p) => this.personView(p));
    return { persons: views, identities: [...this.identitiesByIds(views.flatMap((p) => p.identityIds)), ...loose.map((r) => this.identityView(r))] };
  }

  /**
   * People for a search (docs/search.md, "People"): everyone with every word somewhere in a name, a handle, a name
   * they had before (the change log), your nickname or note, their status or their bio. Ranked by where the words
   * landed, the name first and a bio last, then by whether they are a person of yours, starred, and how much they
   * post. One identity per person; `match` says what matched when the name shown does not.
   */
  /** Every identity with what people search reads, by id, folded into one string to look in (findPeople). */
  private people: Map<string, { r: Row; hay: string }> | null = null;
  /** How much each identity has posted, up to 1000: a tie-breaker in people search, an hour old at most. */
  private postedCache = new Map<string, { n: number; at: number }>();
  private static PEOPLE_SQL = `SELECT i.*, p.name AS person_name, p.note, p.starred, p.is_self,
           (SELECT group_concat(json_extract(c.old, '$'), char(31)) FROM change_log c WHERE c.target_kind = 'identity' AND c.target_id = i.id AND c.field IN ('displayName', 'handle')) AS past,
           (SELECT group_concat(json_extract(a.data, '$.bio'), char(31)) FROM about a WHERE a.target_id = i.id) AS bio
         FROM identity i LEFT JOIN person p ON p.id = i.person_id`;

  private peopleEntry(r: Row) {
    const hay = [r.display_name, r.handle, r.nickname, r.net_nickname, r.net_note, statusText(r.status), r.person_name, r.note, r.past, r.bio].filter(Boolean).map((x) => fold(String(x))).join('\u001f');
    return { r, hay };
  }

  /**
   * The list people search looks in, loaded once (loadPeopleSteps, or at the first search) and then kept current
   * from people_dirty: only the identities written since are read again.
   */
  private peopleList(): Map<string, { r: Row; hay: string }> {
    if (!this.people) whole(this.loadPeopleSteps());
    const dirty = this.takePeopleDirty();
    if (dirty.length) {
      const one = this.db.query(`${Store.PEOPLE_SQL} WHERE i.id = ?`);
      for (const id of dirty) {
        const r = one.get(id) as Row | null;
        if (r) this.people!.set(id, this.peopleEntry(r));
        else this.people!.delete(id);
      }
    }
    return this.people!;
  }

  /**
   * Identities written since people search last looked. On the hub, people_dirty's rows, taken out; on a reader, which
   * cannot write, what the hub handed it (peopleChanged).
   */
  private takePeopleDirty(): string[] {
    if (this.reader) {
      const ids = [...this.peopleHanded];
      this.peopleHanded.clear();
      return ids;
    }
    const dirty = (this.db.query('SELECT id FROM people_dirty').all() as Row[]).map((r) => r.id as string);
    if (!dirty.length) return dirty;
    this.db.query('DELETE FROM people_dirty WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(dirty));
    if (this.peopleForReader) for (const id of dirty) this.peopleForReader.add(id);
    return dirty;
  }
  /** Identities people search's thread has yet to hear of (peopleChanges); null until it first asks. */
  private peopleForReader: Set<string> | null = null;
  /** On a reader: identities the hub said were written, for the next search to read again. */
  private peopleHanded = new Set<string>();

  /**
   * For search's thread (search-thread.ts): every identity written since it last asked, so its own people list reads
   * them again. Taken out of people_dirty here, where the hub writes, so no write falls between a read and a delete.
   */
  peopleChanges(): string[] {
    this.peopleForReader ??= new Set();
    if (this.people) this.peopleList();
    else this.takePeopleDirty();
    const out = [...this.peopleForReader];
    this.peopleForReader.clear();
    return out;
  }

  /** On a reader: identities the hub wrote since (peopleChanges there). */
  peopleChanged(ids: string[]) {
    for (const id of ids) this.peopleHanded.add(id);
  }

  /** People search's list, 2000 identities to a slice. Run as search's thread starts (search-thread.ts), so no search waits for it. */
  *loadPeopleSteps(): Generator<number, void> {
    if (this.people) return;
    // Everything is read fresh: what was noted before is in the list already.
    this.takePeopleDirty();
    const list = new Map<string, { r: Row; hay: string }>();
    const page = this.db.query(`${Store.PEOPLE_SQL} WHERE i.rowid > ? ORDER BY i.rowid LIMIT 2000`.replace('SELECT i.*', 'SELECT i.rowid AS rid, i.*'));
    for (let after = 0; ; ) {
      const rows = page.all(after) as Row[];
      for (const r of rows) list.set(r.id, this.peopleEntry(r));
      if (rows.length < 2000) break;
      after = rows[rows.length - 1].rid;
      yield rows.length;
    }
    this.people ??= list;
  }

  findPeople(needle: string, limit = 12): P.PersonHit[] {
    // Accents and case fold on both sides: "zoe" finds Zoë.
    const words = [...new Set(fold(needle).split(/\s+/).filter(Boolean))];
    if (!words.length) return [];
    const list = this.peopleList();
    const rows: Row[] = [];
    for (const e of list.values()) if (!e.r.is_self && words.every((w) => e.hay.includes(w))) rows.push(e.r);
    if (!rows.length) return [];
    // A person before an identity nobody linked, as the old query had it.
    rows.sort((a, b) => Number(!a.person_id) - Number(!b.person_id));
    rows.length = Math.min(rows.length, 2000);

    const scored: { r: Row; score: number; match: string | null }[] = [];
    for (const r of rows) {
      if (this.isSelf(r.id)) continue;
      const shown: string = r.person_name ?? shownName(r);
      const list = (s: string | null) => (s ? s.split('\u001f').filter(Boolean) : []);
      // [text, weight, how it reads under the name when it is what matched]
      const fields: [string | null, number, string | null][] = [
        [shown, 100, null],
        [r.display_name, 90, r.display_name],
        [r.handle, 85, r.handle],
        [r.nickname, 80, r.nickname],
        [r.net_nickname, 80, r.net_nickname],
        ...list(r.past).map((n): [string, number, string] => [n, 60, `was ${n}`]),
        [r.note, 45, r.note && `Note: ${r.note}`],
        [r.net_note, 45, r.net_note && `Note: ${r.net_note}`],
        [statusText(r.status), 30, statusText(r.status)],
        ...list(r.bio).map((b): [string, number, string] => [b, 30, b]),
      ];
      let score = 0;
      let match: [number, string] | null = null;
      let every = true;
      for (const w of words) {
        let best = 0;
        for (const [text, weight, label] of fields) {
          const s = weight * nameScore(text, w);
          if (s > best) best = s;
          // What explains a word the shown name does not.
          if (s > 0 && label && label !== shown && !nameScore(shown, w) && (!match || s > match[0])) match = [s, label];
        }
        if (!best) {
          every = false;
          break;
        }
        score += best;
      }
      // Several words: all of them as the name, or its start, over the same words scattered.
      const whole = words.length > 1 ? 50 * nameScore(shown, words.join(' ')) : 0;
      if (every) scored.push({ r, score: score + whole, match: match && markSnippet(match[1].replace(/\s+/g, ' '), words, 20, 80) });
    }
    scored.sort((a, b) => b.score - a.score);

    // Then knowing them, more than how much they post: a person of yours whose handle matches beats a busy stranger
    // whose name starts with the word, not one whose name is the word.
    const top = scored.slice(0, limit * 4);
    const posted = this.db.query('SELECT COUNT(*) AS n FROM (SELECT 1 FROM message WHERE author_id = ? LIMIT 1000)');
    const now = Date.now();
    for (const s of top) {
      let c = this.postedCache.get(s.r.id);
      if (!c || now - c.at > 3_600_000) this.postedCache.set(s.r.id, (c = { n: (posted.get(s.r.id) as Row).n as number, at: now }));
      const n = c.n;
      s.score += (s.r.person_id ? 40 : 0) + (s.r.starred ? 30 : 0) + 6 * Math.log10(1 + n);
    }
    top.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const out: P.PersonHit[] = [];
    for (const s of top) {
      const key = s.r.person_id ?? s.r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: s.r.id, match: s.match });
      if (out.length === limit) break;
    }
    return out;
  }

  accountsNamed(name: string): string[] {
    return (this.db.query(`SELECT id FROM account WHERE id = ?1 OR label = ?1 COLLATE NOCASE`).all(name) as Row[]).map((r) => r.id);
  }

  /**
   * Messages matching what was typed (docs/search.md). Nothing found as typed: inside words, then with misspelt words
   * corrected. `context`: that many messages before and after each hit. `typing`: asked as you type, so neither
   * fallback (on a big hub they read every message, seconds for a word nothing has); Enter asks without it.
   * `people: false` leaves out the people the words find.
   */
  search(input: string, limit = 50, cursor: string | null = null, context = 0, opts: SearchOptions = {}): P.SearchPage {
    let page = this.searchOnce(input, limit, cursor, opts);
    const fixed = !page.hits.length && !cursor && !opts.typing ? this.spellFix(input) : null;
    const alt = fixed ? this.searchOnce(fixed, limit, null, opts) : null;
    if (alt?.hits.length) page = { ...alt, corrected: fixed!, people: page.people, identities: [...alt.identities, ...page.identities] };
    if (context > 0) this.surround(page, Math.min(context, 3));
    return page;
  }

  private searchOnce(input: string, limit: number, cursor: string | null, opts: SearchOptions): P.SearchPage {
    const q = parseSearch(input);
    const is = new Set(q.is);
    // Kept deleted and disappeared messages only when asked for, with adversarial features shown, and not when they are set to stay out of sight.
    const gone = is.has('deleted') ? (!this.retention().adversarial || this.retention().show === 'hidden' ? '0' : `m.deleted = 1 AND m.gone_how IS NOT NULL AND (m.body != '' OR EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = m.id))`) : 'm.deleted = 0';
    const where: string[] = [gone];
    const args: any[] = [];
    const within = (col: string, ids: string[]) => {
      // More ids than SQLite takes as parameters: inline through json_each.
      where.push(`${col} IN (SELECT value FROM json_each(?))`);
      args.push(JSON.stringify(ids));
    };
    for (const f of q.from) within('m.author_id', this.identitiesNamed(f));
    for (const f of q.in) within('m.conversation_id', this.conversationsNamed(f));
    if (q.network.length) within('m.network', q.network);
    for (const a of q.account) (where.push('EXISTS (SELECT 1 FROM message_seen s WHERE s.message_id = m.id AND s.account_id IN (SELECT value FROM json_each(?)))'), args.push(JSON.stringify(this.accountsNamed(a))));
    if (q.mentionsMe) where.push('m.mentions_self = 1');
    // Every network writes a mention as <@native id> (Discord also <@!id>).
    for (const f of q.mentions) {
      where.push(`EXISTS (SELECT 1 FROM identity i WHERE i.id IN (SELECT value FROM json_each(?)) AND i.network = m.network AND (instr(m.body, '<@' || i.native_id || '>') OR instr(m.body, '<@!' || i.native_id || '>')))`);
      args.push(JSON.stringify(this.identitiesNamed(f)));
    }
    if (q.after !== null) (where.push('m.ts >= ?'), args.push(q.after));
    if (q.before !== null) (where.push('m.ts < ?'), args.push(q.before));
    for (const h of q.has) {
      if (h === 'attachment') where.push('EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = m.id)');
      else if (h === 'link') where.push(`m.body LIKE '%http%://%'`);
      else if (h === 'reaction') where.push('EXISTS (SELECT 1 FROM reaction_tally t WHERE t.message_id = m.id)');
      else if (h === 'embed') where.push(`json_array_length(m.extra, '$.embeds') > 0`);
      else if (h === 'sticker') where.push(`m.kind = 'sticker'`);
      else (where.push('EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = m.id AND a.kind = ?)'), args.push(h));
    }
    if (is.has('pinned')) where.push(`(SELECT e.kind FROM message_event e WHERE e.message_id = m.id AND e.kind IN ('pin', 'unpin') ORDER BY e.at DESC LIMIT 1) = 'pin'`);
    if (is.has('edited')) where.push('m.edited_ts IS NOT NULL');
    const filtered = where.length > 1 || gone !== 'm.deleted = 0';
    const offset = q.relevance && cursor ? parseInt(cursor) || 0 : 0;
    const dir = q.oldest ? 'ASC' : 'DESC';
    const fts = this.ftsQuery(q);
    const texts = [...q.phrases, ...q.terms];
    // By time through search_time: a walk along its keys that stops at the page's end (docs/search.md).
    const timed = !!fts && this.searchTimeReady && !q.relevance && !texts.some((t) => CJK.test(t)) && (!cursor || cursor.startsWith('t'));
    if (cursor && !q.relevance && !timed) {
      const [ts, rowid] = cursor.split(':').map(Number);
      where.push(`(m.ts, m.rowid) ${q.oldest ? '>' : '<'} (?, ?)`);
      args.push(ts, rowid);
    }
    const take = limit + 1;
    const order = `m.ts ${dir}, m.rowid ${dir}`;

    // Tokens miss the middle of a word, and unspaced CJK text is one long token, so a hit in FTS is no proof there are no others.
    let substring = !!fts && (!!cursor?.endsWith(':s') || texts.some((t) => CJK.test(t)));
    // Nothing in the index: inside words instead, but not as you type.
    const fallBack = (n: number) => !n && !cursor && !opts.typing;
    const without = q.not.map(() => `m.body NOT LIKE ? ESCAPE '\\'`);
    const withoutArgs = q.not.map((t) => `%${likeEscape(t)}%`);

    let rows: Row[] = [];
    let mode: P.SearchPage['mode'] = fts ? 'fulltext' : 'filters';
    if (timed && !substring) {
      const at = cursor ? Number(cursor.slice(1)) : null;
      rows = (this.db
        .query(
          `SELECT m.*, m.rowid AS rid, s.rowid AS skey FROM search_time s CROSS JOIN search_key k ON k.key = s.rowid CROSS JOIN message m ON m.id = k.msg
           WHERE search_time MATCH ? ${at !== null ? `AND s.rowid ${q.oldest ? '>' : '<'} ?` : ''} AND ${where.join(' AND ')} ORDER BY s.rowid ${dir} LIMIT ?`,
        )
        .all(fts, ...(at !== null ? [at] : []), ...args, take) as Row[]).map((r) => ({ ...r, snip: markSnippet(r.body, texts) }));
      substring = fallBack(rows.length);
    } else if (fts && q.relevance && !substring) {
      // Best match: the newest matches ranked by how well, how lately and how close (rankMatches).
      rows = this.rankMatches(this.matchPool(fts, where, args, 2000), q)
        .slice(offset, offset + take)
        .map(({ r, why }) => ({ ...r, why, snip: markSnippet(r.body, texts) }));
      substring = fallBack(rows.length);
    } else if (fts && !substring) {
      rows = this.db
        .query(
          `SELECT m.*, m.rowid AS rid, snippet(message_fts, 0, char(1), char(2), '…', 28) AS snip FROM message_fts JOIN message m ON m.rowid = message_fts.rowid
           WHERE message_fts MATCH ? AND ${where.join(' AND ')} ORDER BY ${q.relevance ? 'bm25(message_fts), m.ts DESC' : order} LIMIT ? OFFSET ?`,
        )
        .all(fts, ...args, take, offset) as Row[];
      // Better slow than empty.
      substring = fallBack(rows.length);
    } else if (!fts && (q.not.length || filtered)) {
      rows = (this.db.query(`SELECT m.*, m.rowid AS rid FROM message m WHERE ${[...where, ...without].join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, ...withoutArgs, take, offset) as Row[]).map((r) => ({ ...r, snip: markSnippet(r.body, []) }));
    }
    if (substring) {
      mode = 'substring';
      // A picture's alt text counts as its message's words here (rich.ts).
      const like = texts.map(() => `(m.body LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM attachment a WHERE a.message_id = m.id AND a.alt LIKE ? ESCAPE '\\'))`);
      rows = (this.db
        .query(`SELECT m.*, m.rowid AS rid FROM message m WHERE ${[...like, ...without, ...where].join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...texts.flatMap((t) => [`%${likeEscape(t)}%`, `%${likeEscape(t)}%`]), ...withoutArgs, ...args, take, offset) as Row[]).map((r) => ({ ...r, snip: markSnippet(r.body, texts) }));
    }

    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const views = this.messageViews(page);
    const snips = new Map(page.map((r) => [r.id, r.snip as string]));
    const last = page[page.length - 1];
    const needle = [...q.phrases, ...q.terms].join(' ').trim();
    const people = needle.length >= 2 && opts.people !== false ? this.findPeople(needle) : [];
    const whys = new Map(page.filter((r) => r.why).map((r) => [r.id, r.why as string]));
    // With no sort and more than a screen's worth: the best few above the newest.
    let top: P.SearchHit[] = [];
    // Not for a word or two of one or two letters: ranking every word they start is slow, and says little.
    const worded = texts.some((t) => t.length >= 3);
    if (fts && worded && !cursor && !q.relevance && !q.oldest && !q.newest && mode === 'fulltext' && rows.length > 3) {
      const best = this.rankMatches(this.matchPool(fts, where.filter((w) => !w.startsWith('(m.ts, m.rowid)')), args, 600), q).slice(0, 3);
      const tv = new Map(this.messageViews(best.map((b) => b.r)).map((m) => [m.id, m]));
      top = best.map(({ r, why }) => ({ message: tv.get(r.id)!, snippet: markSnippet(r.body, texts), ...(why ? { why } : {}) })).filter((h) => h.message);
    }
    const shownIds = this.identitiesOf([...views, ...top.map((h) => h.message)]).map((i) => i.id);
    return {
      hits: views.map((m) => ({ message: m, snippet: snips.get(m.id) ?? '', ...(whys.has(m.id) ? { why: whys.get(m.id) } : {}) })),
      identities: this.identitiesByIds([...shownIds, ...people.map((p) => p.id)]),
      people,
      next: !more ? null : q.relevance ? String(offset + limit) + (substring ? ':s' : '') : timed && !substring ? `t${last.skey}` : `${last.ts}:${last.rid}` + (substring ? ':s' : ''),
      mode,
      ...(top.length ? { top } : {}),
    };
  }

  /** What was said just before and after each hit, for reading it in place. */
  private surround(page: P.SearchPage, n: number) {
    const near = (id: string, op: '<' | '>') =>
      this.db
        .query(
          `SELECT o.* FROM message t JOIN message o ON o.conversation_id = t.conversation_id
           WHERE t.id = ? AND o.deleted = 0 AND (o.ts, o.rowid) ${op} (t.ts, t.rowid) ORDER BY o.ts ${op === '<' ? 'DESC' : 'ASC'}, o.rowid ${op === '<' ? 'DESC' : 'ASC'} LIMIT ?`,
        )
        .all(id, n) as Row[];
    const all = [...page.hits, ...(page.top ?? [])];
    const sides = all.map((h) => [near(h.message.id, '<').reverse(), near(h.message.id, '>')]);
    const views = new Map(this.messageViews(sides.flat(2)).map((m) => [m.id, m]));
    all.forEach((h, i) => {
      h.before = sides[i][0].map((r) => views.get(r.id)!);
      h.after = sides[i][1].map((r) => views.get(r.id)!);
    });
    const shown = new Set(page.identities.map((i) => i.id));
    page.identities.push(...this.identitiesOf([...views.values()]).filter((i) => !shown.has(i.id)));
  }

  /**
   * The newest `n` matches, filters applied: what Best match and the top matches rank. Through search_time a walk of
   * n keys; before it is filled in, the older index sorted by time. No bm25: for a short last word it scores every
   * word that word starts, 100 to 800 ms on a big hub, where rankMatches' own count of the words takes none.
   */
  private matchPool(fts: string, where: string[], args: unknown[], n: number): Row[] {
    const sql = this.searchTimeReady
      ? `SELECT m.*, m.rowid AS rid FROM search_time s CROSS JOIN search_key k ON k.key = s.rowid CROSS JOIN message m ON m.id = k.msg
         WHERE search_time MATCH ? AND ${where.join(' AND ')} ORDER BY s.rowid DESC LIMIT ?`
      : `SELECT m.*, m.rowid AS rid FROM message_fts JOIN message m ON m.rowid = message_fts.rowid
         WHERE message_fts MATCH ? AND ${where.join(' AND ')} ORDER BY m.ts DESC LIMIT ?`;
    return this.db.query(sql).all(fts, ...(args as any[]), n) as Row[];
  }

  /**
   * Matches best first (docs/search.md, "Ranking"): how well the words match, times how lately it was said, times
   * how close the chat is to you. Each with its reason in a few words.
   */
  rankMatches(rows: Row[], q: P.SearchQuery, now = Date.now()): { r: Row; score: number; why: string }[] {
    if (!rows.length) return [];
    const words = [...q.phrases, ...q.terms].map(fold).filter(Boolean);
    const convs = [...new Set(rows.map((r) => r.conversation_id as string))];
    const close = new Map<string, { shape: string; sent: number; lastSent: number | null }>();
    for (const c of this.db
      .query(
        `SELECT c.id, c.shape, COALESCE(json_extract(f.state, '$.totalSent'), 0) AS sent, json_extract(f.state, '$.lastSent') AS last_sent
         FROM conversation c LEFT JOIN conv_feature f ON f.conversation_id = c.id WHERE c.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(convs)) as Row[])
      close.set(c.id, { shape: c.shape, sent: c.sent ?? 0, lastSent: c.last_sent ?? null });
    const authors = [...new Set(rows.map((r) => r.author_id as string).filter(Boolean))];
    const known = new Set(
      (this.db.query(`SELECT id FROM identity WHERE person_id IS NOT NULL AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(authors)) as Row[]).map((r) => r.id as string),
    );
    const DAY = 86_400_000;
    // How much of a message is the words (as bm25 would have it: a short message about them over a long one that
    // mentions them), against the most of any in the pool.
    const parsed = rows.map((r) => {
      const body = fold(r.body ?? '');
      const list = body.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const hits = list.filter((t) => words.some((w) => t.startsWith(w))).length;
      return { body, tokens: new Set(list), density: hits / (list.length + 4) };
    });
    const densest = Math.max(1e-9, ...parsed.map((p) => p.density));
    const out = rows.map((r, k) => {
      const { body, tokens, density } = parsed[k];
      // Whole words count fully; the last word, still being typed, half when only a longer word starts with it.
      const whole = words.length ? words.reduce((n, w, i) => n + (tokens.has(w) || w.includes(' ') ? 1 : i === words.length - 1 ? 0.5 : 0), 0) / words.length : 0;
      const together = words.length > 1 && body.includes(words.join(' ')) ? 1 : 0;
      const text = 0.45 * (density / densest) + 0.4 * whole + 0.15 * (words.length > 1 ? together : whole);
      const age = Math.max(0, now - r.ts) / DAY;
      const lately = 0.3 + 0.7 * 2 ** (-age / 60);
      const c = close.get(r.conversation_id) ?? { shape: 'channel', sent: 0, lastSent: null };
      const direct = c.shape === 'direct' || c.shape === 'self';
      const talk = 1 - Math.exp(-c.sent / 20);
      const there = c.lastSent ? 2 ** (-Math.max(0, now - c.lastSent) / (30 * DAY)) : 0;
      const closeness = (direct ? 0.4 : c.shape === 'group' ? 0.25 : 0.1) + 0.35 * talk + 0.25 * there;
      const mine = this.selfIdentities.has(r.author_id);
      const who = mine || known.has(r.author_id) ? 0.1 : 0;
      const score = text * lately * (0.5 + closeness + who);
      const why = [
        age < 7 ? 'recent' : null,
        direct ? 'DM' : null,
        talk > 0.5 ? (direct ? 'you talk often' : 'a chat you write in') : null,
        mine ? 'you said it' : null,
        together ? 'these words together' : null,
      ].filter(Boolean);
      return { r, score, why: why.slice(0, 3).join(' · ') };
    });
    return out.sort((a, b) => b.score - a.score || b.r.ts - a.r.ts);
  }

  /** Whether every message is in search_time yet (fillSearchIndexSteps). */
  get searchIndexReady(): boolean {
    return this.searchTimeReady;
  }

  /**
   * Messages from before search_time existed, into it, newest first, 128 to a slice (sliced() in main.ts).
   * Where it got to is kept in meta, so a restart goes on from there. Until it is done search uses message_fts.
   */
  *fillSearchIndexSteps(): Generator<number, void> {
    if (this.searchTimeReady) return;
    const meta = (k: string) => (this.db.query('SELECT value FROM meta WHERE key = ?').get(k) as Row | null)?.value as string | undefined;
    const save = this.db.query(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
    let below = Number(meta('search_time_rowid') ?? ((this.db.query('SELECT MAX(rowid) AS n FROM message').get() as Row).n ?? 0) + 1);
    const pick = this.db.query(`SELECT m.rowid AS rid, m.id, m.ts, m.body FROM message m WHERE m.rowid < ? AND m.rowid >= ? AND NOT EXISTS (SELECT 1 FROM search_key k WHERE k.msg = m.id)`);
    const taken = this.db.query('SELECT 1 FROM search_key WHERE key = ?');
    const addKey = this.db.query('INSERT INTO search_key (key, msg) VALUES (?, ?)');
    const addText = this.db.query('INSERT INTO search_time (rowid, body) VALUES (?, ?)');
    while (below > 0) {
      const lo = Math.max(0, below - 128);
      const rows = pick.all(below, lo) as Row[];
      this.db.transaction(() => {
        for (const r of rows) {
          let key = searchKey(r.ts, r.rid);
          while (taken.get(key)) key++;
          addKey.run(key, r.id);
          addText.run(key, r.body ?? '');
        }
        save.run('search_time_rowid', String(lo));
      })();
      below = lo;
      yield Math.max(1, rows.length);
    }
    save.run('search_time_ready', '1');
    this.searchTimeReady = true;
  }

  /**
   * The query with each word the index lacks swapped for the nearest one it has (one edit for short words, two for
   * longer), the commonest of equals; null when there is nothing to correct.
   */
  private spellFix(input: string): string | null {
    const q = parseSearch(input);
    let out = input;
    q.terms.forEach((t, i) => {
      const w = t.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
      if (w.length < 4 || w.length > 30 || !/^\p{L}+$/u.test(w) || CJK.test(w)) return;
      // The last word searches as a prefix, so any word it starts is no typo.
      const known = i === q.terms.length - 1 ? 'term >= ?1 AND term < ?1 || char(1114111)' : 'term = ?1';
      if (this.db.query(`SELECT 1 FROM message_fts_vocab WHERE ${known} LIMIT 1`).get(w)) return;
      const max = w.length < 7 ? 1 : 2;
      let best: { term: string; d: number; doc: number } | null = null;
      // Same first letter: a word's start is seldom where the typo is, and it keeps this to one slice of the index.
      for (const r of this.db.query(`SELECT term, doc FROM message_fts_vocab WHERE term >= ?1 AND term < ?1 || char(1114111)`).iterate(w[0]) as Iterable<Row>) {
        if (Math.abs(r.term.length - w.length) > max) continue;
        const d = editDistance(w, r.term, max);
        if (d <= max && (!best || d < best.d || (d === best.d && r.doc > best.doc))) best = { term: r.term, d, doc: r.doc };
      }
      if (best) out = out.replace(new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), `$1${best.term}`);
    });
    return out === input ? null : out;
  }

  /** A message and what surrounds it, for jumping there. */
  messageContext(messageId: string, around: number): P.MessageContext | null {
    const t = this.db.query('SELECT rowid AS rid, * FROM message WHERE id = ?').get(messageId) as Row | null;
    if (!t) return null;
    const older = this.db.query('SELECT * FROM message WHERE conversation_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?').all(t.conversation_id, t.ts, around + 1) as Row[];
    const newer = this.db.query('SELECT * FROM message WHERE conversation_id = ? AND ts >= ? AND id != ? ORDER BY ts ASC LIMIT ?').all(t.conversation_id, t.ts, t.id, around + 1) as Row[];
    const rows = [...older.slice(0, around).reverse(), t, ...newer.slice(0, around)];
    const msgs = this.messageViews(rows);
    return { messages: msgs, identities: this.identitiesOf(msgs), hasMore: older.length > around, hasNewer: newer.length > around };
  }

  messagesAfter(conversationId: string, afterTs: number, limit: number): P.MessagePage {
    const rows = this.db.query('SELECT * FROM message WHERE conversation_id = ? AND ts > ? ORDER BY ts ASC LIMIT ?').all(conversationId, afterTs, limit + 1) as Row[];
    const msgs = this.messageViews(rows.slice(0, limit));
    return { messages: msgs, identities: this.identitiesOf(msgs), hasMore: rows.length > limit };
  }

  folders(): P.FolderView[] {
    const fs = this.db.query('SELECT * FROM folder ORDER BY position').all() as Row[];
    const items = this.db.query('SELECT * FROM folder_item ORDER BY position').all() as Row[];
    return fs.map((f) => ({
      id: f.id,
      name: f.name,
      icon: f.icon,
      color: f.color,
      // Folders inside it and what it holds share one order.
      items: [
        ...items.filter((i) => i.folder_id === f.id).map((i) => ({ kind: i.item_kind as P.FolderItemKind, id: i.item_id as string, pos: i.position as number })),
        ...fs.filter((c) => c.parent_id === f.id).map((c) => ({ kind: 'folder' as const, id: c.id as string, pos: (c.parent_pos ?? -1) as number })),
      ]
        .sort((a, b) => a.pos - b.pos)
        .map(({ kind, id }) => ({ kind, id })),
    }));
  }

  private metaJson<T>(key: string): T | null {
    const r = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as Row | null;
    return r ? (JSON.parse(r.value) as T) : null;
  }

  private setMetaJson(key: string, value: unknown) {
    if (value === null) this.db.query('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  /** A setting kept as JSON in meta (translate.ts's), or null. */
  metaValue = <T>(key: string) => this.metaJson<T>(key);
  setMetaValue = (key: string, value: unknown) => this.setMetaJson(key, value);
  quietHours = () => this.metaJson<P.QuietHours>('quiet_hours');
  privacy = (): P.PrivacySettings => ({ shareTyping: this.metaJson<P.PrivacySettings>('privacy')?.shareTyping ?? true });
  setPrivacy = (p: P.PrivacySettings) => this.setMetaJson('privacy', p);
  setQuietHours = (q: P.QuietHours) => this.setMetaJson('quiet_hours', q);
  quietHeld = () => this.metaJson<{ count: number; conversationId: string; messageId: string }>('quiet_held');
  setQuietHeld = (held: { count: number; conversationId: string; messageId: string } | null) => this.setMetaJson('quiet_held', held);
  /** What triage learned from your marks (learn.ts). */
  triagePolicy = <T>() => this.metaJson<T>('triage_policy');
  setTriagePolicy = (p: unknown) => this.setMetaJson('triage_policy', p);
  /** The importance at which a message reaches the phone's list; null until you set it (learn.ts THRESHOLDS). */
  listLevel = (): number | null => this.metaJson<number>('list_level');
  setListLevel = (level: number) => this.setMetaJson('list_level', level);

  rules(): P.RuleView[] {
    return (this.db.query('SELECT * FROM notify_rule ORDER BY created_at').all() as Row[]).map((r) => ({
      id: r.id,
      scope: r.scope,
      target: r.target,
      level: r.level,
      createdAt: r.created_at,
    }));
  }

  /**
   * `edgesInConversations` (what the web app asks for, `?edges=spaces`): `edges` holds only edges between spaces, and
   * `conversationEdges` the positions of each conversation's edges to its spaceIds, so no conversation's id is sent
   * again for each place it is in (a tenth of the bootstrap's bytes at full size).
   */
  bootstrap(opts: { edgesInConversations?: boolean } = {}): P.Bootstrap {
    const db = this.db;
    const convRows = db.query('SELECT * FROM conversation').all() as Row[];
    const edges = (db.query('SELECT * FROM space_edge').all() as Row[]).map(edgeView);
    // Members in conversationView's order (by id): an event's copy in another order reads to the app as new names.
    const parts = db.query('SELECT * FROM participant ORDER BY conversation_id, identity_id').all() as Row[];
    const vants = db.query('SELECT * FROM vantage').all() as Row[];
    const lastIds = convRows.map((c) => c.last_message_id).filter(Boolean);
    const lasts = new Map<string, Row>();
    for (let i = 0; i < lastIds.length; i += 400) {
      const chunk = lastIds.slice(i, i + 400);
      for (const m of db.query(`SELECT * FROM message WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Row[]) lasts.set(m.id, m);
    }
    const group = <T>(xs: T[], key: (x: T) => string) => {
      const m = new Map<string, T[]>();
      for (const x of xs) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))!).push(x);
      return m;
    };
    const P_ = group(parts, (p) => p.conversation_id);
    const V = group(vants.filter((v) => v.target_kind === 'conversation'), (v) => v.target_id);
    const VS = group(vants.filter((v) => v.target_kind === 'space'), (v) => v.target_id);
    const E = group(edges.filter((e) => e.childKind === 'conversation'), (e) => e.childId);

    // Identities: participants, account selves, last-message authors, everyone with a person, and who asked you
    // something (docs/add.md).
    const identityIds = new Set<string>();
    for (const p of parts) identityIds.add(p.identity_id);
    for (const m of lasts.values()) if (m.author_id) identityIds.add(m.author_id);
    for (const r of db.query('SELECT id FROM identity WHERE person_id IS NOT NULL').all() as Row[]) identityIds.add(r.id);
    addTables(db);
    for (const r of db.query('SELECT from_id FROM add_request WHERE from_id IS NOT NULL').all() as Row[]) identityIds.add(r.from_id);
    for (const s of this.selfIdentities) identityIds.add(s);
    const identities = this.identitiesByIds(identityIds);
    const personOf = new Map(identities.map((i) => [i.id, i.personId]));

    const links = pendingLinks(db);
    const threads = this.threadPartsOf(convRows);
    const conversationEdges: (string | null)[][] = [];
    const conversations = convRows.map((r) => {
      const ps = (P_.get(r.id) ?? []).map((p) => p.identity_id);
      const peer = r.shape === 'direct' ? (personOf.get(ps.find((p) => !this.isSelf(p)) ?? '') ?? null) : null;
      const es = E.get(r.id) ?? [];
      conversationEdges.push(es.map((e) => e.position));
      return this.assembleConversation(
        r,
        es.map((e) => e.parentId),
        ps,
        V.get(r.id) ?? [],
        r.last_message_id ? (lasts.get(r.last_message_id) ?? null) : null,
        peer,
        links,
        threads.get(r.id),
      );
    });

    const idsByPerson = group(identities.filter((i) => i.personId), (i) => i.personId!);
    const vias = new Map<string, { via: string; url: string | null }[]>();
    for (const v of db.query(`SELECT i.person_id AS pid, i.seen_via AS via, i.avatar_url AS url FROM identity i JOIN account a ON a.id = i.seen_via WHERE i.person_id IS NOT NULL`).all() as Row[])
      (vias.get(v.pid) ?? vias.set(v.pid, []).get(v.pid)!).push({ via: v.via, url: v.url });
    const persons = (db.query('SELECT * FROM person').all() as Row[]).map((p) => this.personView(p, (idsByPerson.get(p.id) ?? []).map((i) => i.id), vias));
    const spaces = (db.query('SELECT * FROM space').all() as Row[]).map((s) => {
      const vs = VS.get(s.id) ?? [];
      return this.spaceView(s, vs.map((v) => v.account_id), vs.find((v) => v.native_mute)?.native_mute ?? null);
    });
    const self = db.query('SELECT id FROM person WHERE is_self = 1').get() as Row | null;
    return {
      selfPersonId: self?.id ?? null,
      accounts: this.accounts().map((a) => this.accountView(a)),
      persons,
      identities,
      spaces,
      ...(opts.edgesInConversations ? { edges: edges.filter((e) => e.childKind === 'space'), conversationEdges } : { edges }),
      conversations,
      folders: this.folders(),
      placePrefs: this.placePrefs(),
      categories: this.categories(),
      placeCategories: this.placeCategories(),
      categoryProvider: this.categoryProvider,
      ...(this.accountsManager ? { accountsManager: this.accountsManager } : {}),
      rules: this.rules(),
      reactionUsage: this.reactionUsage(),
      presence: this.presenceNow.list(),
      now: Date.now(),
    };
  }

  /** Drain dirty markers into client events. `all`: presence held for coalescing too (a clean stop). */
  flush(all = false): P.ClientEvent[] {
    const d = this.dirty;
    // Status dots go out at most once every two seconds, whatever else a frame carries (presence.ts); written after
    // the frame's commit (HubServer.flush), or here when there is no frame's transaction around this.
    const presence = this.presenceNow.take(all);
    if (!this.db.inTransaction) this.presenceNow.save();
    if (d.empty) return presence ? [presence] : [];
    const out: P.ClientEvent[] = [];
    for (const id of d.accounts) {
      const a = this.account(id);
      if (a) out.push({ t: 'account', account: this.accountView(a) });
    }
    for (const id of d.identities) {
      const r = this.db.query('SELECT * FROM identity WHERE id = ?').get(id) as Row | null;
      if (r) out.push({ t: 'identity', identity: this.identityView(r) });
    }
    for (const id of d.persons) {
      const r = this.db.query('SELECT * FROM person WHERE id = ?').get(id) as Row | null;
      if (r) out.push({ t: 'person', person: this.personView(r) });
    }
    for (const id of d.spaces) {
      const r = this.db.query('SELECT * FROM space WHERE id = ?').get(id) as Row | null;
      if (r) out.push({ t: 'space', space: this.spaceView(r), edges: this.edgesOfSpace(id) });
    }
    for (const id of d.conversations) {
      const c = this.conversationView(id);
      if (c) out.push({ t: 'conversation', conversation: c });
    }
    if (d.messages.size) {
      const ids = [...d.messages.keys()];
      const rows = this.db.query(`SELECT * FROM message WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[];
      const views = this.messageViews(rows);
      for (const m of views) out.push({ t: 'message', message: m, identities: this.identitiesOf([m]), live: d.messages.get(m.id) ?? false });
    }
    out.push(...d.removed, ...d.extra);
    if (presence) out.push(presence);
    this.dirty.accounts.clear();
    this.dirty.identities.clear();
    this.dirty.persons.clear();
    this.dirty.spaces.clear();
    this.dirty.conversations.clear();
    this.dirty.messages.clear();
    this.dirty.removed = [];
    this.dirty.extra = [];
    return out;
  }

  // ------------------------------------------------------------ lookups for routing

  nativeOf(table: 'conversation' | 'message' | 'identity' | 'space', id: string): { network: P.Network; nativeId: string } | null {
    const r = this.db.query(`SELECT network, native_id FROM ${table} WHERE id = ?`).get(id) as Row | null;
    return r ? { network: r.network, nativeId: r.native_id } : null;
  }

  /**
   * The picture a notification shows: the sender's (their person's, else the identity's), else the place's, as a
   * signed media path; and the network, for its badge.
   */
  notifyLook(conversationId: string | undefined, messageId: string | undefined): { icon?: string; network?: P.Network } {
    const c = conversationId ? this.one<Row>('SELECT id, network, shape, avatar_url FROM conversation WHERE id = ?', conversationId) : null;
    if (!c) return {};
    const via = this.vantageAccounts('conversation', c.id)[0] ?? null;
    const sender = messageId
      ? this.one<Row>('SELECT i.avatar_url, i.seen_via, p.id AS person_id, p.avatar_url AS person_avatar FROM message m JOIN identity i ON i.id = m.author_id LEFT JOIN person p ON p.id = i.person_id WHERE m.id = ?', messageId)
      : null;
    const icon = sender?.avatar_url ? this.media(sender.avatar_url, sender.seen_via ?? via) : sender?.person_avatar ? this.personPicture(sender.person_id, sender.person_avatar) : this.media(c.avatar_url, via);
    // A push carries at most about 4 KB, so an inline picture only goes when it is small.
    return { network: c.network, ...(icon && (!icon.startsWith('data:') || icon.length < 1500) ? { icon } : {}) };
  }

  vantageAccounts(kind: 'space' | 'conversation', id: string): string[] {
    return (this.db.query('SELECT account_id FROM vantage WHERE target_kind = ? AND target_id = ?').all(kind, id) as Row[]).map((r) => r.account_id);
  }

  raw<T = Row>(sql: string, ...args: any[]): T[] {
    return this.db.query(sql).all(...args) as T[];
  }

  one<T = Row>(sql: string, ...args: any[]): T | null {
    return (this.db.query(sql).get(...args) as T) ?? null;
  }
}

function edgeView(e: Row): P.SpaceEdgeView {
  return { parentId: e.parent_id, childKind: e.child_kind, childId: e.child_id, position: e.position };
}

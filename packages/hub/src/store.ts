import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hubId, randomId } from '@dither-chat/protocol/ids';
import type * as P from '@dither-chat/protocol';
import { ADVERSARIAL_KEEPS, canonicalReactionKey, DEFAULT_RETENTION, parseSearch, PROTOCOL_VERSION, REACTION_RULES } from '@dither-chat/protocol';
import { Journal } from './journal.ts';
import { TypingRelay, typingTtl } from './typing.ts';

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

export type MediaSigner = (raw: string | null | undefined, accountId: string | null | undefined) => string | null;

/** Objects touched since the last flush; the server turns these into ClientEvents. */
export class Dirty {
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

export function previewText(body: string, kind: string): string {
  if (kind === 'encrypted') return 'Encrypted message';
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

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** A snippet for a match SQLite's tokens could not see. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Two renderings of one message compared for an import: an export's body was rebuilt from HTML, so mentions,
 * emoji, links and Markdown marks may be written differently while the words are the same.
 */
export function normalizeForCompare(s: string): string {
  return s
    .replace(/<a?:(\w+):\d+>/g, '$1')
    .replace(/<@[!&]?\d+>|<#\d+>|@\S+|#\S+/g, '')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1$2')
    .replace(/[*_~|`>#\s\\]/g, '')
    .toLowerCase();
}

function markSnippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  const first = Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0));
  const start = Math.max(0, (Number.isFinite(first) ? first : 0) - 60);
  let out = (start ? '…' : '') + body.slice(start, start + 200) + (body.length > start + 200 ? '…' : '');
  for (const t of terms) out = out.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `\u0001${m}\u0002`);
  return out;
}

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

/** Fields that may go from nothing to something and back (Store.logChanges). */
const SETTABLE = new Set(['topic', 'bio', 'status', 'pronouns']);

/** Bump when a migration step changes without schema.sql changing, so the database is copied before it runs. */
const MIGRATIONS = 1;

export class Store {
  readonly db: Database;
  readonly dirty = new Dirty();
  /** Conversation -> the oldest new message stored since attention.ts last looked, so it can tell appends from backfill. */
  readonly ingested = new Map<string, number>();
  /** Conversations where your own reactions changed since attention.ts last looked: a reaction answers what you owed. */
  readonly selfReacted = new Set<string>();
  /** What changed at which position, for clients that come back (journal.ts, docs/sync.md). */
  readonly journal: Journal;
  private selfIdentities = new Set<string>();
  /** Accounts whose adapter speaks another protocol version, and what to tell you about it. */
  private protocolWarnings = new Map<string, string>();
  /** Who is typing where: in memory only (typing.ts). */
  readonly typers = new TypingRelay();

  constructor(path: string, readonly media: MediaSigner) {
    this.db = new Database(path, { create: true, strict: true });
    // Outside any transaction: inside one, SQLite ignores foreign_keys.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    // A schema (or migration code) this database has not met yet: copy it first (backups/pre-migrate-*), then take
    // every step in one transaction, so a crash part way leaves the database as it was, not half moved.
    const sig = createHash('sha256').update(`${MIGRATIONS}\n${schema}`).digest('hex').slice(0, 16);
    const known = this.schemaSig();
    if (known !== null && known !== sig) this.snapshotBeforeMigrating(path);
    this.db.transaction(() => {
      const reactionsBefore = this.oldReactions();
      const broadcastsUnknown = this.addMentionsAll();
      this.addColumns('message', { gone_how: 'TEXT', gone_at: 'INTEGER', imported: 'INTEGER NOT NULL DEFAULT 0' });
      this.addColumns('identity', { status: 'TEXT' });
      this.addColumns('category', { threshold: 'REAL' });
      this.addColumns('triage', { shadow: 'TEXT', explore: 'TEXT', propensity: 'REAL' });
      const oldTriage = this.setAsideTriage();
      const oldLog = this.setAside('change_log', 'actor_id', ['change_log_target']);
      this.db.exec(schema);
      if (oldTriage) this.adoptOldTriage(oldTriage);
      if (oldLog) this.adoptOldChangeLog();
      if (broadcastsUnknown) this.markBroadcasts();
      this.adoptOldReactions(reactionsBefore);
      this.db.query(`INSERT INTO meta (key, value) VALUES ('schema_sig', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(sig);
    })();
    this.journal = new Journal(this.db);
    // Messages from before full-text search existed.
    if (!this.db.query(`SELECT 1 FROM meta WHERE key = 'fts_backfilled'`).get()) {
      this.db.exec(`INSERT INTO message_fts (message_fts) VALUES ('rebuild'); INSERT INTO meta (key, value) VALUES ('fts_backfilled', '1');`);
    }
    for (const r of this.db.query('SELECT self_identity FROM account WHERE self_identity IS NOT NULL').all() as Row[]) {
      this.selfIdentities.add(r.self_identity);
    }
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

  /** backups/pre-migrate-<time>.sqlite next to the database, the newest five kept. Not for an in-memory database. */
  private snapshotBeforeMigrating(path: string) {
    if (path === ':memory:' || path === '') return;
    const dir = join(dirname(path), 'backups');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `pre-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    chmodSync(file, 0o600);
    console.log(`schema changed: copied the database to ${file} before migrating`);
    const old = readdirSync(dir).filter((f) => /^pre-migrate-.*\.sqlite$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 5))) rmSync(join(dir, f), { force: true });
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
   * Triage rows nobody will learn from: older than `keepDays`, in conversations you have never written in, never voted
   * on, never notified and never explored. Learning reads two weeks (votes.ts) and the replay a few (docs/
   * triage-replay.md), so the default 90 days keeps every label. At most `limit` rows a call. Returns how many went.
   */
  pruneTriage(now = Date.now(), keepDays = Number(process.env.DITHER_TRIAGE_KEEP_DAYS) || 90, limit = 5000): number {
    const self = [...this.selfIdentities];
    const marks = self.map(() => '?').join(',');
    const yours = self.length ? `SELECT DISTINCT conversation_id FROM message WHERE author_id IN (${marks})` : 'SELECT NULL WHERE 0';
    const r = this.db
      .query(
        `DELETE FROM triage WHERE rowid IN (
           SELECT t.rowid FROM triage t JOIN message m ON m.id = t.message_id
           WHERE t.created_at < ? AND t.feedback IS NULL AND t.explore IS NULL AND t.decision IN ('digest', 'drop', 'silent')
             AND m.conversation_id NOT IN (${yours})
           LIMIT ?)`,
      )
      .run(now - keepDays * 86_400_000, ...self, limit);
    return r.changes;
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
  }

  /** Remove an account and everything that only it could see. */
  deleteAccount(id: string) {
    // Places another account still sees lose this one's vantage: they change rather than go.
    const seen = this.db.query('SELECT target_kind, target_id FROM vantage WHERE account_id = ?').all(id) as Row[];
    const tx = this.db.transaction(() => {
      this.db.query('DELETE FROM account WHERE id = ?').run(id);
      this.db.query('DELETE FROM about WHERE account_id = ?').run(id);
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
        this.db.query('DELETE FROM space_edge WHERE parent_id = ? OR (child_kind = ? AND child_id = ?)').run(s.id, 'space', s.id);
        this.db.query('DELETE FROM folder_item WHERE item_kind = ? AND item_id = ?').run('space', s.id);
        this.dirty.removed.push({ t: 'space.removed', id: s.id });
      }
      const orphanPersons = this.db
        .query(`SELECT id FROM person p WHERE is_self = 0 AND NOT EXISTS (SELECT 1 FROM identity i WHERE i.person_id = p.id
                  AND (EXISTS (SELECT 1 FROM participant pa WHERE pa.identity_id = i.id) OR EXISTS (SELECT 1 FROM message m WHERE m.author_id = i.id)))`)
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
    this.refreshSelf();
    for (const v of seen) {
      const exists = this.db.query(`SELECT 1 FROM ${v.target_kind === 'space' ? 'space' : 'conversation'} WHERE id = ?`).get(v.target_id);
      if (exists) (v.target_kind === 'space' ? this.dirty.spaces : this.dirty.conversations).add(v.target_id);
    }
    for (const i of this.dirty.identities) if (!this.db.query('SELECT 1 FROM identity WHERE id = ?').get(i)) this.dirty.identities.delete(i);
    this.dirty.removed.push({ t: 'account.removed', id });
  }

  private refreshSelf() {
    this.selfIdentities.clear();
    for (const r of this.db.query('SELECT self_identity FROM account WHERE self_identity IS NOT NULL').all() as Row[]) {
      this.selfIdentities.add(r.self_identity);
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
          break;
        case 'leave':
          this.leave(acc, ev.kind, ev.nativeId);
          break;
        case 'message': {
          const id = this.message(acc, ev.message, !!ev.live);
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
        case 'receipt':
          this.receipt(acc, ev);
          break;
        case 'reactionsCleared': {
          const mid = hubId('msg', acc.network, ev.message);
          const key = ev.key === undefined ? null : canonicalReactionKey(ev.key);
          // A moderator clearing reactions: what was there, kept like any reaction taken back.
          if (this.keeps('reactions', acc))
            for (const r of this.db.query('SELECT identity_id, key, style FROM reaction WHERE message_id = ? AND (? IS NULL OR key = ?)').all(mid, key, key) as Row[])
              this.messageEvent(mid, 'unreact', { key: r.key, style: r.style, cleared: true }, r.identity_id, acc.id);
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
          const upTo = Math.max(v?.last_read_ts ?? 0, ev.upToTs);
          const counts = ev.unread !== undefined ? { unread: ev.unread, mentions: ev.mentions ?? 0 } : this.countUnread(acc, cid, upTo);
          this.db
            .query(`UPDATE vantage SET last_read_ts = ?, unread = ?, mentions = ? WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`)
            .run(upTo, counts.unread, counts.mentions, acc.id, cid);
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
        case 'reply':
        case 'log':
          break;
      }
    });
    tx();
    return fresh;
  }

  private countUnread(acc: AccountRow, cid: string, afterTs: number) {
    const r = this.db
      .query(
        `SELECT COUNT(*) AS unread, COALESCE(SUM(m.mentions_self), 0) AS mentions FROM message m
         JOIN message_seen s ON s.message_id = m.id AND s.account_id = ?
         WHERE m.conversation_id = ? AND m.ts > ? AND m.deleted = 0 AND (m.author_id IS NULL OR m.author_id != ?)`,
      )
      .get(acc.id, cid, afterTs, acc.self_identity ?? '') as Row;
    return { unread: r.unread as number, mentions: r.mentions as number };
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

    if (f.isSelf) {
      this.linkSelf(id, f);
      if (acc.self_identity !== id) {
        this.updateAccount(acc.id, { self_identity: id });
        acc.self_identity = id;
      }
      this.selfIdentities.add(id);
    } else if (f.contact) {
      this.ensurePerson(id);
    } else if (changed && after.person_id) {
      this.syncAutoPerson(after.person_id);
    }
    return id;
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
    const r = this.db.query('SELECT person_id, display_name, handle, native_id, avatar_url FROM identity WHERE id = ?').get(identityId) as Row;
    if (r.person_id) return r.person_id;
    const pid = 'per_' + identityId.slice(4);
    this.db
      .query('INSERT OR IGNORE INTO person (id, name, avatar_url, created_at) VALUES (?, ?, ?, ?)')
      .run(pid, r.display_name ?? r.handle ?? r.native_id, r.avatar_url, Date.now());
    this.db.query('UPDATE identity SET person_id = ? WHERE id = ?').run(pid, identityId);
    this.dirty.persons.add(pid);
    this.dirty.identities.add(identityId);
    // A direct conversation shows who it is with by person.
    this.touchDirectsOf(pid);
    return pid;
  }

  /** Auto persons with a single identity follow that identity's name and avatar. */
  private syncAutoPerson(pid: string) {
    const p = this.db.query('SELECT manual, is_self FROM person WHERE id = ?').get(pid) as Row | null;
    if (!p || p.manual || p.is_self) return;
    const ids = this.db.query('SELECT display_name, handle, native_id, avatar_url FROM identity WHERE person_id = ?').all(pid) as Row[];
    if (ids.length !== 1) return;
    const i = ids[0];
    this.db.query('UPDATE person SET name = ?, avatar_url = ? WHERE id = ?').run(i.display_name ?? i.handle ?? i.native_id, i.avatar_url, pid);
    this.dirty.persons.add(pid);
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
    if (was)
      this.logChanges('space', id, acc.id, [
        ['name', was.name, f.name],
        ['topic', was.topic, f.topic],
        ['avatar', was.icon_url, f.iconUrl],
      ]);
    this.db
      .query(
        `INSERT INTO space (id, network, native_id, kind, name, topic, icon_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network, native_id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
           topic = COALESCE(excluded.topic, topic), icon_url = COALESCE(excluded.icon_url, icon_url), updated_at = excluded.updated_at`,
      )
      .run(id, acc.network, f.nativeId, f.kind, f.name, f.topic ?? null, f.iconUrl ?? null, Date.now());
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
    const was = this.db.query('SELECT name, topic, avatar_url, shape FROM conversation WHERE id = ?').get(id) as Row | null;
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network, native_id) DO UPDATE SET
           shape = excluded.shape, variant = excluded.variant, parent_id = COALESCE(excluded.parent_id, parent_id),
           name = COALESCE(excluded.name, name), topic = COALESCE(excluded.topic, topic),
           avatar_url = COALESCE(excluded.avatar_url, avatar_url), encrypted = excluded.encrypted, archived = excluded.archived,
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
        f.archived ? 1 : 0,
        f.lastMessageAt ?? null,
        Date.now(),
      );
    this.ensureVantage(acc.id, 'conversation', id, f.mute);
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
      this.db.query(`DELETE FROM space_edge WHERE parent_id = ? OR (child_kind = 'space' AND child_id = ?)`).run(id, id);
      this.dirty.removed.push({ t: 'space.removed', id });
    } else {
      this.db.query('DELETE FROM conversation WHERE id = ?').run(id);
      this.db.query(`DELETE FROM space_edge WHERE child_kind = 'conversation' AND child_id = ?`).run(id);
      this.dirty.removed.push({ t: 'conversation.removed', id });
    }
  }

  /** Returns the message id if it is new and live (needs triage). */
  private message(acc: AccountRow, f: P.MessageFact, live: boolean): string | null {
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
    // An edit: the words it had before, if this source's edits are kept (docs/history.md).
    if (old && !old.deleted && old.body && f.body !== old.body && this.keeps('edits', acc)) this.messageEvent(id, 'edit', { body: old.body }, author, acc.id, f.editedTs ?? Date.now());
    this.db
      .query(
        `INSERT INTO message (id, conversation_id, network, native_id, author_id, ts, edited_ts, kind, body, reply_to_id, thread_id, mentions_self, mentions_all, extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network, native_id) DO UPDATE SET
           edited_ts = COALESCE(excluded.edited_ts, edited_ts), kind = excluded.kind, imported = 0,
           -- A kept deleted message the network sends again empty (a Matrix redaction) keeps what was kept.
           body = CASE WHEN deleted = 1 AND excluded.body = '' THEN body ELSE excluded.body END,
           reply_to_id = COALESCE(excluded.reply_to_id, reply_to_id), thread_id = COALESCE(excluded.thread_id, thread_id),
           mentions_self = MAX(mentions_self, excluded.mentions_self),
           mentions_all = CASE WHEN excluded.mentions_self = 1 THEN excluded.mentions_all ELSE mentions_all END, extra = COALESCE(excluded.extra, extra)`,
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
        f.extra || f.forward ? JSON.stringify({ ...f.extra, ...(f.forward ? { forward: f.forward } : {}) }) : null,
      );
    if (f.attachments && !(old?.deleted && !f.attachments.length)) {
      this.db.query('DELETE FROM attachment WHERE message_id = ?').run(id);
      f.attachments.forEach((a, i) => {
        this.db
          .query(`INSERT INTO attachment (id, message_id, kind, mime, name, size, width, height, url, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(hubId('att', acc.network, `${f.nativeId}#${a.nativeId ?? i}`), id, a.kind, a.mime ?? null, a.name ?? null, a.size ?? null, a.width ?? null, a.height ?? null, a.url, i);
      });
    }
    if (f.reactions) this.reactionSnapshot(acc, id, f.reactions, existed);
    if (!existed) this.ingested.set(cid, Math.min(this.ingested.get(cid) ?? Infinity, f.ts));
    const newForAccount = this.db.query('INSERT OR IGNORE INTO message_seen (message_id, account_id) VALUES (?, ?)').run(id, acc.id).changes > 0;

    const conv = this.db.query('SELECT last_message_at, last_message_id FROM conversation WHERE id = ?').get(cid) as Row;
    if (conv.last_message_at == null || f.ts >= conv.last_message_at) {
      this.db.query('UPDATE conversation SET last_message_id = ?, last_message_at = ? WHERE id = ?').run(id, f.ts, cid);
      // The list shows who wrote the last message; a live one brings its author along anyway.
      if (!live && conv.last_message_id !== id) this.dirty.identities.add(author);
    }
    const fromSelf = author === acc.self_identity || this.isSelf(author);
    if (newForAccount && !fromSelf) {
      this.db
        .query(
          `UPDATE vantage SET unread = unread + 1, mentions = mentions + ? WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?
             AND (last_read_ts IS NULL OR last_read_ts < ?)`,
        )
        .run(f.mentionsSelf ? 1 : 0, acc.id, cid, f.ts);
    }
    if (fromSelf && newForAccount) {
      // Sending from any client counts as reading up to there.
      this.db
        .query(`UPDATE vantage SET last_read_ts = MAX(COALESCE(last_read_ts, 0), ?), unread = 0, mentions = 0 WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`)
        .run(f.ts, acc.id, cid);
    }
    const changed = before === null || JSON.stringify(this.messageViews([this.db.query('SELECT * FROM message WHERE id = ?').get(id) as Row])) !== before;
    if (changed || this.placeSig('conversation', cid) !== convBefore) this.dirty.conversations.add(cid);
    if (live || (existed && changed)) this.dirty.messages.set(id, live);
    return !existed && live && !fromSelf ? id : null;
  }

  // ------------------------------------------------------------ history imports (imports/engine.ts, docs/import.md)

  /**
   * One conversation's facts from a history import, or a slice of them. Fill-only: what the hub has stays and live
   * data always wins; a message the hub lacks goes in through the same path as backfill (`message`, not live), so it
   * looks exactly like one the network sent. Nothing notifies, and unread counts are left as they were. Where the
   * source says something else than the hub, the hub's version stays and the difference is kept (import_conflict).
   */
  importBatch(
    acc: AccountRow,
    b: { conversation: P.ConversationFact; identities: P.IdentityFact[]; messages: P.MessageFact[] },
    o: { sourceSha: string; runId: string; dryRun: boolean; archiveNew: boolean; first: boolean },
  ): P.ImportCounts {
    const counts: P.ImportCounts = { conversations: o.first ? 1 : 0, conversationsNew: 0, messages: b.messages.length, new: 0, same: 0, filled: 0, conflicts: 0, duplicates: 0 };
    const cid = hubId('cnv', acc.network, b.conversation.nativeId);
    const convExisted = !!this.db.query('SELECT 1 FROM conversation WHERE id = ?').get(cid);
    if (o.first && !convExisted) counts.conversationsNew = 1;
    const run = () => {
      if (!convExisted && !o.dryRun) this.conversation(acc, { ...b.conversation, ...(o.archiveNew ? { archived: true } : {}) });
      const v0 = this.db.query(`SELECT unread, mentions FROM vantage WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`).get(acc.id, cid) as Row | null;
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
        const row = this.db.query('SELECT body, kind, deleted, reply_to_id, (SELECT COUNT(*) FROM attachment WHERE message_id = m.id) AS atts FROM message m WHERE id = ?').get(mid) as Row | null;
        if (!row) {
          counts.new++;
          newest = Math.max(newest, f.ts);
          if (o.dryRun) continue;
          this.message(acc, f, false);
          this.db.query('UPDATE message SET imported = 1 WHERE id = ?').run(mid);
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
        if (row.deleted) {
          if (f.body && !row.body) conflict('deleted');
          else counts.same++;
          continue;
        }
        // A system line ("… started a call") is worded by whoever rendered it: the same event either way.
        if (row.kind === 'system' || f.kind === 'system') {
          counts.same++;
          continue;
        }
        if (f.body && normalizeForCompare(row.body) !== normalizeForCompare(f.body)) {
          conflict('body');
          continue;
        }
        let filled = false;
        if (!row.reply_to_id && f.replyTo) {
          if (!o.dryRun) this.db.query('UPDATE message SET reply_to_id = ? WHERE id = ?').run(hubId('msg', acc.network, f.replyTo), mid);
          filled = true;
        }
        if (!row.atts && f.attachments?.length) {
          if (!o.dryRun) this.insertAttachments(acc, mid, f.nativeId, f.attachments);
          filled = true;
        }
        if (filled) {
          counts.filled++;
          if (!o.dryRun) this.dirty.messages.set(mid, false);
        } else counts.same++;
      }
      if (o.dryRun) return;
      // Old messages are read; a conversation's counts stay what the network said.
      if (v0) this.db.query(`UPDATE vantage SET unread = ?, mentions = ? WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`).run(v0.unread, v0.mentions, acc.id, cid);
      else if (newest)
        this.db
          .query(`UPDATE vantage SET last_read_ts = MAX(COALESCE(last_read_ts, 0), ?), unread = 0, mentions = 0 WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`)
          .run(newest, acc.id, cid);
      this.dirty.conversations.add(cid);
    };
    this.db.transaction(run)();
    return counts;
  }

  private insertAttachments(acc: AccountRow, mid: string, nativeId: string, atts: P.AttachmentFact[]) {
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
      .query(`UPDATE vantage SET last_read_ts = MAX(COALESCE(last_read_ts, 0), ?), unread = 0, mentions = 0 WHERE target_kind = 'conversation' AND target_id = ?`)
      .run(upToTs, conversationId);
    this.dirty.conversations.add(conversationId);
    return vs.map((v) => ({ accountId: v.account_id, upTo: last?.native_id ?? null }));
  }

  mergePersons(intoId: string, fromId: string) {
    if (intoId === fromId) return;
    const tx = this.db.transaction(() => {
      this.db.query('UPDATE identity SET person_id = ? WHERE person_id = ?').run(intoId, fromId);
      const from = this.db.query('SELECT starred FROM person WHERE id = ?').get(fromId) as Row | null;
      this.db.query('UPDATE person SET manual = 1, starred = MAX(starred, ?) WHERE id = ?').run(from?.starred ?? 0, intoId);
      this.db.query(`UPDATE OR IGNORE folder_item SET item_id = ? WHERE item_kind = 'person' AND item_id = ?`).run(intoId, fromId);
      this.db.query(`DELETE FROM folder_item WHERE item_kind = 'person' AND item_id = ?`).run(fromId);
      this.db.query(`UPDATE OR IGNORE notify_rule SET target = ? WHERE scope = 'person' AND target = ?`).run(intoId, fromId);
      this.db.query('DELETE FROM person WHERE id = ?').run(fromId);
    });
    tx();
    this.dirty.persons.add(intoId);
    this.dirty.removed.push({ t: 'person.removed', id: fromId });
    for (const r of this.db.query('SELECT id FROM identity WHERE person_id = ?').all(intoId) as Row[]) this.dirty.identities.add(r.id);
    this.touchDirectsOf(intoId);
  }

  /** Detach an identity into its own person again. */
  splitIdentity(identityId: string) {
    const r = this.db.query('SELECT person_id FROM identity WHERE id = ?').get(identityId) as Row | null;
    if (!r?.person_id) return;
    const old = r.person_id as string;
    this.db.query('UPDATE identity SET person_id = NULL WHERE id = ?').run(identityId);
    const left = (this.db.query('SELECT COUNT(*) AS n FROM identity WHERE person_id = ?').get(old) as Row).n as number;
    // Its deterministic person may be the merged one, kept going by the others: that would rejoin them.
    const natural = 'per_' + identityId.slice(4);
    let pid: string;
    if (natural === old && left) {
      const i = this.db.query('SELECT display_name, handle, native_id, avatar_url FROM identity WHERE id = ?').get(identityId) as Row;
      pid = randomId('per');
      this.db.query('INSERT INTO person (id, name, avatar_url, created_at) VALUES (?, ?, ?, ?)').run(pid, i.display_name ?? i.handle ?? i.native_id, i.avatar_url, Date.now());
      this.db.query('UPDATE identity SET person_id = ? WHERE id = ?').run(pid, identityId);
    } else {
      if (natural === old) this.db.query('DELETE FROM person WHERE id = ?').run(old);
      pid = this.ensurePerson(identityId);
    }
    this.dirty.identities.add(identityId);
    if (!left && natural !== old) {
      this.db.query('DELETE FROM person WHERE id = ?').run(old);
      this.dirty.removed.push({ t: 'person.removed', id: old });
    } else if (left) this.dirty.persons.add(old);
    this.dirty.persons.add(pid);
    this.touchDirectsOf(pid);
    this.touchDirectsOf(old);
    return pid;
  }

  updatePerson(id: string, patch: { name?: string; starred?: boolean; note?: string }) {
    if (patch.name !== undefined) this.db.query('UPDATE person SET name = ?, manual = 1 WHERE id = ?').run(patch.name, id);
    if (patch.starred !== undefined) this.db.query('UPDATE person SET starred = ? WHERE id = ?').run(patch.starred ? 1 : 0, id);
    if (patch.note !== undefined) this.db.query('UPDATE person SET note = ? WHERE id = ?').run(patch.note, id);
    this.dirty.persons.add(id);
  }

  private touchDirectsOf(personId: string) {
    const rows = this.db
      .query(`SELECT DISTINCT p.conversation_id AS id FROM participant p JOIN identity i ON i.id = p.identity_id WHERE i.person_id = ?`)
      .all(personId) as Row[];
    for (const r of rows) this.dirty.conversations.add(r.id);
  }

  setFolders(folders: P.FolderView[]) {
    const tx = this.db.transaction(() => {
      const kept = new Set(folders.map((f) => f.id));
      for (const r of this.db.query('SELECT id FROM folder').all() as Row[]) if (!kept.has(r.id)) this.db.query(`DELETE FROM place_pref WHERE kind = 'folder' AND id = ?`).run(r.id);
      this.db.query('DELETE FROM folder').run();
      folders.forEach((f, i) => {
        const id = f.id || randomId('fld');
        this.db.query('INSERT INTO folder (id, name, icon, color, position) VALUES (?, ?, ?, ?, ?)').run(id, f.name, f.icon, f.color, i);
        f.items.forEach((it, j) => {
          this.db.query('INSERT OR IGNORE INTO folder_item (folder_id, item_kind, item_id, position) VALUES (?, ?, ?, ?)').run(id, it.kind, it.id, j);
        });
      });
    });
    tx();
    this.dirty.extra.push({ t: 'folders', folders: this.folders() });
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
      }
    })();
    this.dirty.extra.push({ t: 'placePrefs', prefs: this.placePrefs() });
  }

  // ------------------------------------------------------------ categories (categorize.ts asks the questions)

  /** Which provider fills category_score; shown in Settings. */
  categoryProvider = 'keyword';
  /** Set by main.ts when accounts run in dither-accounts: the manager's page, if known. */
  accountsManager: { url: string | null } | null = null;
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
    return (this.retentionCache ??= { ...DEFAULT_RETENTION, ...(this.metaJson<Partial<P.RetentionSettings>>('retention') ?? {}) });
  }
  setRetention(r: P.RetentionSettings) {
    this.setMetaJson('retention', r);
    this.retentionCache = null;
  }

  /**
   * Whether this account's deleted, disappeared or edited messages are kept: the account's say, its network's, then the
   * default. Deleted and disappeared only with adversarial features shown.
   */
  keeps(what: keyof P.KeepSettings, acc: { id: string; network: string }): boolean {
    const r = this.retention();
    if ((ADVERSARIAL_KEEPS as readonly string[]).includes(what) && !r.adversarial) return false;
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

  /** What changed about these, newest first. */
  changes(targets: { kind: P.ChangeView['target']['kind']; id: string }[], limit = 100): P.ChangeView[] {
    if (!targets.length) return [];
    const where = targets.map(() => '(target_kind = ? AND target_id = ?)').join(' OR ');
    // Statuses over time only with adversarial features shown.
    const statuses = this.retention().adversarial ? '' : ` AND NOT (target_kind = 'identity' AND field = 'status')`;
    const rows = this.db.query(`SELECT * FROM change_log WHERE (${where})${statuses} ORDER BY at DESC, id DESC LIMIT ?`).all(...targets.flatMap((t) => [t.kind, t.id]), limit) as Row[];
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
    const events = evs.filter((e) => e.kind !== 'edit').map((e): P.MessageEventView => ({ kind: e.kind, data: json(e.data, null), at: e.at, ...(e.actor_id ? { actorId: e.actor_id } : {}) }));
    const receipts = (this.db.query('SELECT identity_id, state, at FROM receipt WHERE message_id = ? ORDER BY at').all(id) as Row[]).map((r) => ({ identityId: r.identity_id, state: r.state, at: r.at }));
    const ids = [...new Set([...events.flatMap((e) => (e.actorId ? [e.actorId] : [])), ...receipts.map((r) => r.identityId)])];
    return { versions, events, receipts, identities: this.identitiesByIds(ids) };
  }

  /** Forget what was kept: deleted or disappeared messages' words and files, edits, reactions taken back, receipts, or the change log. */
  eraseKept(what: 'deleted' | 'disappeared' | 'edits' | 'reactions' | 'receipts' | 'changes' | 'statuses'): number {
    if (what === 'statuses') return this.db.query(`DELETE FROM change_log WHERE target_kind = 'identity' AND field = 'status'`).run().changes;
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


  /** A decision, and what it was made from; with the shadow model's chances and what exploration did, if anything. A vote already given stays. */
  setTriage(messageId: string, t: Omit<P.TriageView, 'feedback'> & { shadow?: P.TriageProbs; explore?: 'up' | 'down' | null; propensity?: number | null }, facts?: unknown) {
    this.db
      .query(
        `INSERT INTO triage (message_id, decision, score, reasons, decided_by, facts, probs, shadow, explore, propensity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (message_id) DO UPDATE SET decision = excluded.decision, score = excluded.score, reasons = excluded.reasons,
           decided_by = excluded.decided_by, facts = COALESCE(excluded.facts, facts), probs = excluded.probs, shadow = excluded.shadow,
           explore = excluded.explore, propensity = excluded.propensity, created_at = excluded.created_at`,
      )
      .run(
        messageId, t.decision, t.score, JSON.stringify(t.reasons), t.decidedBy, facts ? JSON.stringify(facts) : null, t.probs ? JSON.stringify(t.probs) : null,
        t.shadow ? JSON.stringify(t.shadow) : null, t.explore ?? null, t.propensity ?? null, Date.now(),
      );
  }

  triageFeedback(messageId: string, feedback: P.TriageView['feedback'], now = Date.now()) {
    this.db.query('UPDATE triage SET feedback = ?, feedback_at = ? WHERE message_id = ?').run(feedback, feedback ? now : null, messageId);
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

  personView(r: Row, identityIds?: string[]): P.PersonView {
    const ids = identityIds ?? (this.db.query('SELECT id FROM identity WHERE person_id = ?').all(r.id) as Row[]).map((x) => x.id);
    return { id: r.id, name: r.name, avatar: r.avatar_url ? this.media(r.avatar_url, null) : null, starred: !!r.starred, isSelf: !!r.is_self, identityIds: ids };
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
    const parts = (this.db.query('SELECT identity_id FROM participant WHERE conversation_id = ?').all(id) as Row[]).map((x) => x.identity_id);
    const vs = this.db.query(`SELECT * FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`).all(id) as Row[];
    const last = r.last_message_id ? (this.db.query('SELECT * FROM message WHERE id = ?').get(r.last_message_id) as Row) : null;
    return this.assembleConversation(r, spaceIds, parts, vs, last, this.peerOf(r, parts));
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
    const parts = group(q(`SELECT conversation_id, identity_id FROM participant WHERE conversation_id IN (SELECT value FROM json_each(?))`), 'conversation_id');
    const vants = group(q(`SELECT * FROM vantage WHERE target_kind = 'conversation' AND target_id IN (SELECT value FROM json_each(?))`), 'target_id');
    const lasts = new Map(
      q(`SELECT m.* FROM message m WHERE m.id IN (SELECT last_message_id FROM conversation WHERE id IN (SELECT value FROM json_each(?)))`).map((m) => [m.id as string, m]),
    );
    return rows.map((r) => {
      const ps = (parts.get(r.id) ?? []).map((p) => p.identity_id as string);
      return this.assembleConversation(r, (edges.get(r.id) ?? []).map((e) => e.parent_id), ps, vants.get(r.id) ?? [], lasts.get(r.last_message_id) ?? null, this.peerOf(r, ps));
    });
  }

  private peerOf(r: Row, parts: string[]): string | null {
    if (r.shape !== 'direct') return null;
    const peer = parts.find((p) => !this.isSelf(p));
    if (!peer) return null;
    return ((this.db.query('SELECT person_id FROM identity WHERE id = ?').get(peer) as Row) ?? {}).person_id ?? null;
  }

  private assembleConversation(r: Row, spaceIds: string[], parts: string[], vs: Row[], last: Row | null, peer: string | null): P.ConversationView {
    const via = vs[0]?.account_id ?? null;
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
    };
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
    if (ev.emoji) this.putEmoji(acc.network, ev.emoji);
    if (ev.remove) {
      const known = this.db.query('DELETE FROM reaction WHERE message_id = ? AND identity_id = ? AND key = ? AND style = ?').run(mid, iid, key, style).changes > 0;
      // Taken back (docs/history.md): only a reaction the hub saw them give, and not your own.
      if (known && !this.isSelf(iid) && this.keeps('reactions', acc)) this.messageEvent(mid, 'unreact', { key, style }, iid, acc.id);
      // Totals include people we never knew by name, so they go down anyway. Your own reactions are
      // always known, so a second removal of yours is only an echo of the first.
      if (known || !this.isSelf(iid)) this.db.query('UPDATE reaction_tally SET count = count - 1 WHERE message_id = ? AND key = ? AND style = ? AND count IS NOT NULL').run(mid, key, style);
      this.dropEmptyTallies(mid);
      return;
    }
    if (REACTION_RULES[acc.network].exclusive) {
      const others = this.db.query('SELECT key, style FROM reaction WHERE message_id = ? AND identity_id = ? AND NOT (key = ? AND style = ?)').all(mid, iid, key, style) as Row[];
      for (const o of others) {
        this.db.query('DELETE FROM reaction WHERE message_id = ? AND identity_id = ? AND key = ? AND style = ?').run(mid, iid, o.key, o.style);
        this.db.query('UPDATE reaction_tally SET count = count - 1 WHERE message_id = ? AND key = ? AND style = ? AND count IS NOT NULL').run(mid, o.key, o.style);
      }
      this.dropEmptyTallies(mid);
    }
    const added = this.db.query('INSERT OR IGNORE INTO reaction (message_id, identity_id, key, style) VALUES (?, ?, ?, ?)').run(mid, iid, key, style).changes > 0;
    this.db.query('INSERT OR IGNORE INTO reaction_tally (message_id, key, style) VALUES (?, ?, ?)').run(mid, key, style);
    if (added) this.db.query('UPDATE reaction_tally SET count = count + 1 WHERE message_id = ? AND key = ? AND style = ? AND count IS NOT NULL').run(mid, key, style);
    if (ev.colors?.length) this.db.query('UPDATE reaction_tally SET colors = ? WHERE message_id = ? AND key = ? AND style = ?').run(JSON.stringify(ev.colors), mid, key, style);
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
    if (!existed) return this.applySnapshot(acc, mid, facts);
    const before = this.selfReactions(mid);
    this.applySnapshot(acc, mid, facts);
    this.noteSelfReactions(mid, before);
  }

  private applySnapshot(acc: AccountRow, mid: string, facts: P.ReactionFact[]) {
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
      if (r.count === undefined) this.db.query('DELETE FROM reaction WHERE message_id = ? AND key = ? AND style = ?').run(mid, key, style);
      // A partial list keeps whoever we learned about, but this account does know whether it reacted itself.
      else if (acc.self_identity && !authors.includes(acc.self_identity)) {
        this.db.query('DELETE FROM reaction WHERE message_id = ? AND identity_id = ? AND key = ? AND style = ?').run(mid, acc.self_identity, key, style);
      }
      for (const a of authors) this.db.query('INSERT OR IGNORE INTO reaction (message_id, identity_id, key, style) VALUES (?, ?, ?, ?)').run(mid, a, key, style);
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

  /** Names behind a total. They are already in the count. */
  addKnownReactors(acc: AccountRow, messageId: string, key: string, style: P.ReactionStyle, authors: string[]) {
    const k = canonicalReactionKey(key);
    for (const a of authors) this.db.query('INSERT OR IGNORE INTO reaction (message_id, identity_id, key, style) VALUES (?, ?, ?, ?)').run(messageId, this.ensureIdentity(acc, a), k, style);
    this.markReacted(messageId);
  }

  reactionUsage(): P.ReactionUsage[] {
    const rows = this.db
      .query(
        `SELECT r.key, i.network, COUNT(*) AS n, e.key AS emoji_key, e.name, e.url, e.animated
         FROM reaction r
         JOIN account a ON a.self_identity = r.identity_id
         JOIN identity i ON i.id = r.identity_id
         LEFT JOIN custom_emoji e ON e.network = i.network AND e.key = r.key
         WHERE a.demo = 0 OR NOT EXISTS (SELECT 1 FROM account WHERE demo = 0)
         GROUP BY r.key, i.network ORDER BY n DESC LIMIT 60`,
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
    const reacts = this.db.query(`SELECT * FROM reaction WHERE message_id IN (${ph})`).all(...ids) as Row[];
    const tallies = this.db.query(`SELECT * FROM reaction_tally WHERE message_id IN (${ph}) ORDER BY seq`).all(...ids) as Row[];
    const emoji = new Map(
      (this.db.query(`SELECT * FROM custom_emoji WHERE (network, key) IN (SELECT m.network, t.key FROM reaction_tally t JOIN message m ON m.id = t.message_id WHERE t.message_id IN (${ph}))`).all(...ids) as Row[]).map((e) => [`${e.network}|${e.key}`, e]),
    );
    const seen = this.db.query(`SELECT * FROM message_seen WHERE message_id IN (${ph})`).all(...ids) as Row[];
    const tri = this.db.query(`SELECT * FROM triage WHERE message_id IN (${ph})`).all(...ids) as Row[];
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
    const RC = new Map<string, NonNullable<P.MessageView['receipts']>>();
    for (const r of this.db.query(`SELECT message_id, identity_id, state, at FROM receipt WHERE message_id IN (${ph}) ORDER BY at`).all(...ids) as Row[]) {
      const cur = RC.get(r.message_id) ?? { delivered: 0, read: 0, played: 0, latest: { identityId: r.identity_id, state: r.state, at: r.at } };
      cur[r.state as P.ReceiptState]++;
      cur.latest = { identityId: r.identity_id, state: r.state, at: r.at };
      RC.set(r.message_id, cur);
    }
    const T = new Map(tri.map((t) => [t.message_id, t]));
    // What was kept of deleted and disappeared messages stays out of sight with adversarial features hidden.
    const unseal = this.retention().adversarial;
    return rows.map((r) => {
      const sealed = !!r.deleted && !unseal;
      const seenVia = (S.get(r.id) ?? []).map((s) => s.account_id);
      const rx = new Map<string, string[]>();
      for (const x of R.get(r.id) ?? []) (rx.get(`${x.style}|${x.key}`) ?? rx.set(`${x.style}|${x.key}`, []).get(`${x.style}|${x.key}`)!).push(x.identity_id);
      const t = T.get(r.id);
      const extra = json<{ encryptionWarning?: string; forward?: P.ForwardFact }>(r.extra, {});
      const encryptionWarning = extra.encryptionWarning;
      const forward = sentForwards.get(r.id) ?? (extra.forward ? this.forwardView(r.network, extra.forward) : null);
      return {
        ...(encryptionWarning ? { encryptionWarning } : {}),
        ...(forward ? { forward } : {}),
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
        ...(EV.get(r.id) ? { events: EV.get(r.id) } : {}),
        ...(PIN.get(r.id)?.pinned ? { pinned: true } : {}),
        ...(RC.get(r.id) ? { receipts: RC.get(r.id) } : {}),
        attachments: (sealed ? [] : (A.get(r.id) ?? [])).map((a) => ({
          id: a.id,
          kind: a.kind,
          mime: a.mime,
          name: a.name,
          size: a.size,
          width: a.width,
          height: a.height,
          url: this.media(a.url, seenVia[0]) ?? '',
        })),
        embeds: json<{ embeds?: P.EmbedView[] }>(r.extra, {}).embeds?.map((e) => ({ ...e, image: this.media(e.image, seenVia[0]) ?? undefined })) ?? [],
        reactions: (RT.get(r.id) ?? [])
          .map((t): P.ReactionView => {
            const identityIds = rx.get(`${t.style}|${t.key}`) ?? [];
            const e = this.emojiView(emoji.get(`${r.network}|${t.key}`), seenVia[0]);
            const colors = json<string[] | null>(t.colors, null);
            return { key: t.key, style: t.style, count: Math.max(t.count ?? 0, identityIds.length), identityIds, ...(e ? { emoji: e } : {}), ...(colors ? { colors } : {}) };
          })
          .filter((x) => x.count > 0),
        seenVia,
        triage: t ? { decision: t.decision, score: t.score, reasons: json(t.reasons, []), decidedBy: t.decided_by, feedback: t.feedback, probs: json(t.probs, null) } : null,
      };
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
      const r = peer ? (this.db.query('SELECT display_name, handle FROM identity WHERE id = ?').get(peer) as Row | null) : null;
      const person = c.peerPersonId ? (this.db.query('SELECT name FROM person WHERE id = ?').get(c.peerPersonId) as Row | null) : null;
      return person?.name ?? r?.display_name ?? r?.handle ?? 'a direct message';
    }
    if (c.shape === 'self') return 'Notes to self';
    const name = c.name ?? 'a conversation';
    const top = this.communityName(c.spaceIds[0] ?? (c.parentId ? this.conversationView(c.parentId)?.spaceIds[0] : undefined));
    const label = c.shape === 'channel' || c.shape === 'thread' ? `#${name}` : name;
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
    const r = this.db.query('SELECT i.display_name, i.handle, p.name AS person FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.id = ?').get(identityId) as Row | null;
    return r ? (r.person ?? r.display_name ?? r.handle ?? null) : null;
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

  /** Every direct conversation with a person, merged into one timeline. */
  personTimeline(personId: string, beforeTs: number | null, limit: number): P.MessagePage & { conversationIds: string[] } {
    const convs = (
      this.db
        .query(
          `SELECT DISTINCT c.id FROM conversation c JOIN participant p ON p.conversation_id = c.id JOIN identity i ON i.id = p.identity_id
           WHERE c.shape = 'direct' AND i.person_id = ?`,
        )
        .all(personId) as Row[]
    ).map((r) => r.id);
    if (!convs.length) return { messages: [], identities: [], hasMore: false, conversationIds: [] };
    const ph = convs.map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT * FROM message WHERE conversation_id IN (${ph}) AND ts < ? ORDER BY ts DESC LIMIT ?`)
      .all(...convs, beforeTs ?? Number.MAX_SAFE_INTEGER, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const msgs = this.messageViews(rows.slice(0, limit).reverse());
    return { messages: msgs, identities: this.identitiesOf(msgs), hasMore, conversationIds: convs };
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
    };
  }

  inbox(sinceTs: number, now = Date.now()): P.InboxPage {
    // What notified (or you voted up) has its own share, so a busy digest cannot push it out of the list; the digest
    // is what matters most, not what came last; and the most interesting of what fell below it, to vote up.
    const pick = (where: string, limit: number, order = 'm.ts DESC', since = sinceTs) =>
      this.db
        .query(`SELECT m.* FROM triage t JOIN message m ON m.id = t.message_id WHERE m.ts >= ? AND m.deleted = 0 AND ${where} ORDER BY ${order} LIMIT ${limit}`)
        .all(since) as Row[];
    const at = `COALESCE(t.feedback, t.decision)`;
    const rows = [
      ...pick(`t.decision != 'silent' AND ${at} IN ('push', 'quiet')`, 150),
      ...pick(`t.decision != 'silent' AND ${at} = 'digest'`, 300, 't.score DESC, m.ts DESC'),
      ...pick(`t.decision != 'silent' AND ${at} = 'drop'`, 40, 't.score DESC, m.ts DESC', Math.max(sinceTs, now - 2 * 86_400_000)),
    ].sort((a, b) => b.ts - a.ts);
    const msgs = this.messageViews(rows);
    return { items: msgs.map((m) => ({ message: m, conversationId: m.conversationId })), identities: this.identitiesOf(msgs) };
  }

  /** Quoted for FTS5, so what people type can never be a syntax error or an operator. */
  private ftsQuery(q: P.SearchQuery): string | null {
    const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
    const parts = [...q.phrases.map(quote), ...q.terms.map((t, i) => quote(t) + (i === q.terms.length - 1 ? '*' : ''))];
    if (!parts.length) return null;
    return parts.join(' ') + q.not.map((t) => ` NOT ${quote(t)}`).join('');
  }

  /** Conversations in, or under, places whose name matches: channels, rooms, groups, whole communities. */
  private conversationsNamed(name: string): string[] {
    if (/^cnv_/.test(name)) return [name];
    const like = `%${likeEscape(name)}%`;
    const out = new Set((this.db.query(`SELECT id FROM conversation WHERE name LIKE ? ESCAPE '\\' OR id = ?`).all(like, name) as Row[]).map((r) => r.id as string));
    let frontier = (this.db.query(`SELECT id FROM space WHERE name LIKE ? ESCAPE '\\' OR id = ?`).all(like, name) as Row[]).map((r) => r.id as string);
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

  private identitiesNamed(name: string): string[] {
    if (/^idn_/.test(name)) return [name];
    const like = `%${likeEscape(name)}%`;
    return (
      this.db
        .query(
          `SELECT i.id FROM identity i LEFT JOIN person p ON p.id = i.person_id
           WHERE i.display_name LIKE ?1 ESCAPE '\\' OR i.handle LIKE ?1 ESCAPE '\\' OR i.native_id = ?2 OR p.name LIKE ?1 ESCAPE '\\'`,
        )
        .all(like, name) as Row[]
    ).map((r) => r.id);
  }

  private accountsNamed(name: string): string[] {
    return (this.db.query(`SELECT id FROM account WHERE id = ?1 OR label = ?1 COLLATE NOCASE`).all(name) as Row[]).map((r) => r.id);
  }

  /**
   * Messages matching what was typed (docs/search.md). Nothing found as typed: inside words, then with misspelt words
   * corrected. `context`: that many messages before and after each hit.
   */
  search(input: string, limit = 50, cursor: string | null = null, context = 0): P.SearchPage {
    let page = this.searchOnce(input, limit, cursor);
    const fixed = !page.hits.length && !cursor ? this.spellFix(input) : null;
    const alt = fixed ? this.searchOnce(fixed, limit, null) : null;
    if (alt?.hits.length) page = { ...alt, corrected: fixed!, people: page.people, identities: [...alt.identities, ...page.identities] };
    if (context > 0) this.surround(page, Math.min(context, 3));
    return page;
  }

  private searchOnce(input: string, limit: number, cursor: string | null): P.SearchPage {
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
    if (cursor && !q.relevance) {
      const [ts, rowid] = cursor.split(':').map(Number);
      where.push(`(m.ts, m.rowid) ${q.oldest ? '>' : '<'} (?, ?)`);
      args.push(ts, rowid);
    }
    const fts = this.ftsQuery(q);
    const take = limit + 1;
    const order = `m.ts ${dir}, m.rowid ${dir}`;
    const texts = [...q.phrases, ...q.terms];

    // Tokens miss the middle of a word, and unspaced CJK text is one long token, so a hit in FTS is no proof there are no others.
    let substring = !!fts && (!!cursor?.endsWith(':s') || texts.some((t) => CJK.test(t)));
    const without = q.not.map(() => `m.body NOT LIKE ? ESCAPE '\\'`);
    const withoutArgs = q.not.map((t) => `%${likeEscape(t)}%`);

    let rows: Row[] = [];
    let mode: P.SearchPage['mode'] = fts ? 'fulltext' : 'filters';
    if (fts && !substring) {
      rows = this.db
        .query(
          `SELECT m.*, m.rowid AS rid, snippet(message_fts, 0, char(1), char(2), '…', 28) AS snip FROM message_fts JOIN message m ON m.rowid = message_fts.rowid
           WHERE message_fts MATCH ? AND ${where.join(' AND ')} ORDER BY ${q.relevance ? 'bm25(message_fts), m.ts DESC' : order} LIMIT ? OFFSET ?`,
        )
        .all(fts, ...args, take, offset) as Row[];
      // Better slow than empty.
      substring = !rows.length && !cursor;
    } else if (!fts && (q.not.length || filtered)) {
      rows = (this.db.query(`SELECT m.*, m.rowid AS rid FROM message m WHERE ${[...where, ...without].join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, ...withoutArgs, take, offset) as Row[]).map((r) => ({ ...r, snip: markSnippet(r.body, []) }));
    }
    if (substring) {
      mode = 'substring';
      const like = texts.map(() => `m.body LIKE ? ESCAPE '\\'`);
      rows = (this.db
        .query(`SELECT m.*, m.rowid AS rid FROM message m WHERE ${[...like, ...without, ...where].join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...texts.map((t) => `%${likeEscape(t)}%`), ...withoutArgs, ...args, take, offset) as Row[]).map((r) => ({ ...r, snip: markSnippet(r.body, texts) }));
    }

    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const views = this.messageViews(page);
    const snips = new Map(page.map((r) => [r.id, r.snip as string]));
    const last = page[page.length - 1];
    const needle = [...q.phrases, ...q.terms].join(' ').trim();
    const people = needle.length >= 2 ? this.identitiesNamed(needle).slice(0, 12) : [];
    const shownIds = this.identitiesOf(views).map((i) => i.id);
    return {
      hits: views.map((m) => ({ message: m, snippet: snips.get(m.id) ?? '' })),
      identities: this.identitiesByIds([...shownIds, ...people]),
      people,
      next: !more ? null : (q.relevance ? String(offset + limit) : `${last.ts}:${last.rid}`) + (substring ? ':s' : ''),
      mode,
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
    const sides = page.hits.map((h) => [near(h.message.id, '<').reverse(), near(h.message.id, '>')]);
    const views = new Map(this.messageViews(sides.flat(2)).map((m) => [m.id, m]));
    page.hits.forEach((h, i) => {
      h.before = sides[i][0].map((r) => views.get(r.id)!);
      h.after = sides[i][1].map((r) => views.get(r.id)!);
    });
    const shown = new Set(page.identities.map((i) => i.id));
    page.identities.push(...this.identitiesOf([...views.values()]).filter((i) => !shown.has(i.id)));
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
      items: items.filter((i) => i.folder_id === f.id).map((i) => ({ kind: i.item_kind, id: i.item_id })),
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

  quietHours = () => this.metaJson<P.QuietHours>('quiet_hours');
  privacy = (): P.PrivacySettings => ({ shareTyping: this.metaJson<P.PrivacySettings>('privacy')?.shareTyping ?? true });
  setPrivacy = (p: P.PrivacySettings) => this.setMetaJson('privacy', p);
  setQuietHours = (q: P.QuietHours) => this.setMetaJson('quiet_hours', q);
  quietHeld = () => this.metaJson<{ count: number; conversationId: string; messageId: string }>('quiet_held');
  setQuietHeld = (held: { count: number; conversationId: string; messageId: string } | null) => this.setMetaJson('quiet_held', held);
  dailyDigest = () => this.metaJson<P.DailyDigest>('daily_digest');
  /** What triage learned from your votes (learn.ts). */
  triagePolicy = <T>() => this.metaJson<T>('triage_policy');
  setTriagePolicy = (p: unknown) => this.setMetaJson('triage_policy', p);
  setDailyDigest = (d: P.DailyDigest) => this.setMetaJson('daily_digest', d);
  /** The last daily slot dealt with, and when the digest last started gathering. Kept here so restarts neither repeat nor lose it. */
  digestState = () => this.metaJson<{ slot: string; since: number }>('daily_digest_state');
  setDigestState = (st: { slot: string; since: number }) => this.setMetaJson('daily_digest_state', st);

  /** What the inbox's digest section gathered in this window, busiest conversation first. */
  digestSummary(since: number, until: number): { id: string; count: number }[] {
    return (
      this.db
        .query(
          `SELECT m.conversation_id AS id, COUNT(*) AS count FROM triage t JOIN message m ON m.id = t.message_id
           WHERE t.decision = 'digest' AND t.created_at > ? AND t.created_at <= ? AND m.deleted = 0
           GROUP BY m.conversation_id ORDER BY count DESC, MAX(m.ts) DESC`,
        )
        .all(since, until) as { id: string; count: number }[]
    );
  }

  rules(): P.RuleView[] {
    return (this.db.query('SELECT * FROM notify_rule ORDER BY created_at').all() as Row[]).map((r) => ({
      id: r.id,
      scope: r.scope,
      target: r.target,
      level: r.level,
      createdAt: r.created_at,
    }));
  }

  bootstrap(): P.Bootstrap {
    const db = this.db;
    const convRows = db.query('SELECT * FROM conversation').all() as Row[];
    const edges = (db.query('SELECT * FROM space_edge').all() as Row[]).map(edgeView);
    const parts = db.query('SELECT * FROM participant').all() as Row[];
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

    // Identities: participants, account selves, last-message authors, and everyone with a person.
    const identityIds = new Set<string>();
    for (const p of parts) identityIds.add(p.identity_id);
    for (const m of lasts.values()) if (m.author_id) identityIds.add(m.author_id);
    for (const r of db.query('SELECT id FROM identity WHERE person_id IS NOT NULL').all() as Row[]) identityIds.add(r.id);
    for (const s of this.selfIdentities) identityIds.add(s);
    const identities = this.identitiesByIds(identityIds);
    const personOf = new Map(identities.map((i) => [i.id, i.personId]));

    const conversations = convRows.map((r) => {
      const ps = (P_.get(r.id) ?? []).map((p) => p.identity_id);
      const peer = r.shape === 'direct' ? (personOf.get(ps.find((p) => !this.isSelf(p)) ?? '') ?? null) : null;
      return this.assembleConversation(
        r,
        (E.get(r.id) ?? []).map((e) => e.parentId),
        ps,
        V.get(r.id) ?? [],
        r.last_message_id ? (lasts.get(r.last_message_id) ?? null) : null,
        peer,
      );
    });

    const idsByPerson = group(identities.filter((i) => i.personId), (i) => i.personId!);
    const persons = (db.query('SELECT * FROM person').all() as Row[]).map((p) => this.personView(p, (idsByPerson.get(p.id) ?? []).map((i) => i.id)));
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
      edges,
      conversations,
      folders: this.folders(),
      placePrefs: this.placePrefs(),
      categories: this.categories(),
      placeCategories: this.placeCategories(),
      categoryProvider: this.categoryProvider,
      ...(this.accountsManager ? { accountsManager: this.accountsManager } : {}),
      rules: this.rules(),
      reactionUsage: this.reactionUsage(),
      now: Date.now(),
    };
  }

  /** Drain dirty markers into client events. */
  flush(): P.ClientEvent[] {
    const d = this.dirty;
    if (d.empty) return [];
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
      ? this.one<Row>('SELECT i.avatar_url, i.seen_via, p.avatar_url AS person_avatar FROM message m JOIN identity i ON i.id = m.author_id LEFT JOIN person p ON p.id = i.person_id WHERE m.id = ?', messageId)
      : null;
    const icon = sender?.avatar_url ? this.media(sender.avatar_url, sender.seen_via ?? via) : sender?.person_avatar ? this.media(sender.person_avatar, null) : this.media(c.avatar_url, via);
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

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { hubId, randomId } from '@dither-chat/protocol/ids';
import type * as P from '@dither-chat/protocol';
import { canonicalReactionKey, REACTION_RULES } from '@dither-chat/protocol';

type Row = Record<string, any>;

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

export class Store {
  readonly db: Database;
  readonly dirty = new Dirty();
  private selfIdentities = new Set<string>();

  constructor(path: string, private media: MediaSigner) {
    this.db = new Database(path, { create: true, strict: true });
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    const reactionsBefore = this.oldReactions();
    this.db.exec(schema);
    this.adoptOldReactions(reactionsBefore);
    for (const r of this.db.query('SELECT self_identity FROM account WHERE self_identity IS NOT NULL').all() as Row[]) {
      this.selfIdentities.add(r.self_identity);
    }
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
    const tx = this.db.transaction(() => {
      this.db.query('DELETE FROM account WHERE id = ?').run(id);
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
        this.db.query('UPDATE identity SET person_id = NULL WHERE person_id = ?').run(p.id);
        this.db.query('DELETE FROM person WHERE id = ?').run(p.id);
        this.db.query('DELETE FROM folder_item WHERE item_kind = ? AND item_id = ?').run('person', p.id);
        this.dirty.removed.push({ t: 'person.removed', id: p.id });
      }
    });
    tx();
    this.refreshSelf();
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
        case 'hello':
          this.updateAccount(acc.id, { capabilities: JSON.stringify(ev.capabilities) });
          break;
        case 'status': {
          const patch: Parameters<Store['updateAccount']>[1] = { status: ev.status };
          if (ev.attention !== undefined) {
            const prev = json<P.Attention | null>(acc.attention, null);
            patch.attention = ev.attention
              ? JSON.stringify({ ...ev.attention, since: prev && prev.kind === ev.attention.kind ? prev.since : Date.now() })
              : null;
          } else if (ev.status === 'online') {
            patch.attention = null;
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
          break;
        }
        case 'delete': {
          const id = hubId('msg', acc.network, ev.nativeId);
          const r = this.db.query('UPDATE message SET deleted = 1, body = ? WHERE id = ? RETURNING conversation_id').get('', id) as Row | null;
          if (r) {
            this.db.query('DELETE FROM attachment WHERE message_id = ?').run(id);
            this.dirty.messages.set(id, true);
            this.dirty.conversations.add(r.conversation_id);
          }
          break;
        }
        case 'reaction': {
          const mid = hubId('msg', acc.network, ev.message);
          if (!this.db.query('SELECT 1 FROM message WHERE id = ?').get(mid)) break;
          this.applyReaction(acc, mid, ev);
          this.markReacted(mid);
          break;
        }
        case 'reactionsCleared': {
          const mid = hubId('msg', acc.network, ev.message);
          const key = ev.key === undefined ? null : canonicalReactionKey(ev.key);
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
          this.dirty.extra.push({ t: 'typing', conversationId: cid, identityId: hubId('idn', acc.network, ev.author) });
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

  ensureIdentity(acc: AccountRow, nativeId: string): string {
    const id = hubId('idn', acc.network, nativeId);
    this.db
      .query('INSERT OR IGNORE INTO identity (id, network, native_id, seen_via, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, acc.network, nativeId, acc.id, Date.now());
    return id;
  }

  private identity(acc: AccountRow, f: P.IdentityFact): string {
    const id = hubId('idn', acc.network, f.nativeId);
    const before = this.db.query('SELECT handle, display_name, avatar_url, is_bot FROM identity WHERE id = ?').get(id) as Row | null;
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

  private space(acc: AccountRow, f: P.SpaceFact) {
    const id = hubId('spc', acc.network, f.nativeId);
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
        this.dirty.spaces.add(pid);
      }
    }
    this.dirty.spaces.add(id);
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
    this.db
      .query(
        `INSERT INTO conversation (id, network, native_id, shape, variant, parent_id, name, topic, avatar_url, encrypted, archived, last_message_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network, native_id) DO UPDATE SET
           shape = excluded.shape, variant = excluded.variant, parent_id = COALESCE(excluded.parent_id, parent_id),
           name = COALESCE(excluded.name, name), topic = COALESCE(excluded.topic, topic),
           avatar_url = COALESCE(excluded.avatar_url, avatar_url), encrypted = excluded.encrypted, archived = excluded.archived,
           last_message_at = MAX(COALESCE(last_message_at, 0), COALESCE(excluded.last_message_at, 0)),
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
        this.dirty.spaces.add(sid);
      }
    }
    if (f.participants) {
      this.db.query('DELETE FROM participant WHERE conversation_id = ?').run(id);
      for (const n of f.participants) {
        const iid = this.ensureIdentity(acc, n);
        this.db.query('INSERT OR IGNORE INTO participant (conversation_id, identity_id) VALUES (?, ?)').run(id, iid);
        // People you DM are people, not strangers.
        if (f.shape === 'direct' && !this.isSelf(iid) && n !== this.selfNative(acc)) this.ensurePerson(iid);
      }
    }
    if (parent) this.dirty.conversations.add(parent);
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
    const existed = !!this.db.query('SELECT 1 FROM message WHERE id = ?').get(id);
    const replyTo = f.replyTo ? hubId('msg', acc.network, f.replyTo) : null;
    const thread = f.threadRoot ? hubId('cnv', acc.network, f.threadRoot) : null;
    this.db
      .query(
        `INSERT INTO message (id, conversation_id, network, native_id, author_id, ts, edited_ts, kind, body, reply_to_id, thread_id, mentions_self, extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network, native_id) DO UPDATE SET
           edited_ts = COALESCE(excluded.edited_ts, edited_ts), kind = excluded.kind, body = excluded.body,
           reply_to_id = COALESCE(excluded.reply_to_id, reply_to_id), thread_id = COALESCE(excluded.thread_id, thread_id),
           mentions_self = MAX(mentions_self, excluded.mentions_self), extra = COALESCE(excluded.extra, extra)`,
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
        f.extra ? JSON.stringify(f.extra) : null,
      );
    if (f.attachments) {
      this.db.query('DELETE FROM attachment WHERE message_id = ?').run(id);
      f.attachments.forEach((a, i) => {
        this.db
          .query(`INSERT INTO attachment (id, message_id, kind, mime, name, size, width, height, url, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(hubId('att', acc.network, `${f.nativeId}#${a.nativeId ?? i}`), id, a.kind, a.mime ?? null, a.name ?? null, a.size ?? null, a.width ?? null, a.height ?? null, a.url, i);
      });
    }
    if (f.reactions) this.reactionSnapshot(acc, id, f.reactions);
    const newForAccount = this.db.query('INSERT OR IGNORE INTO message_seen (message_id, account_id) VALUES (?, ?)').run(id, acc.id).changes > 0;

    const conv = this.db.query('SELECT last_message_at FROM conversation WHERE id = ?').get(cid) as Row;
    if (conv.last_message_at == null || f.ts >= conv.last_message_at) {
      this.db.query('UPDATE conversation SET last_message_id = ?, last_message_at = ? WHERE id = ?').run(id, f.ts, cid);
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
    this.dirty.conversations.add(cid);
    if (live || existed) this.dirty.messages.set(id, live);
    return !existed && live && !fromSelf ? id : null;
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
    const pid = this.ensurePerson(identityId);
    const left = this.db.query('SELECT COUNT(*) AS n FROM identity WHERE person_id = ?').get(old) as Row;
    if (!left.n) {
      this.db.query('DELETE FROM person WHERE id = ?').run(old);
      this.dirty.removed.push({ t: 'person.removed', id: old });
    } else this.dirty.persons.add(old);
    this.dirty.persons.add(pid);
    this.touchDirectsOf(pid);
    this.touchDirectsOf(old);
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

  categories(): P.CategoryView[] {
    return (this.db.query('SELECT * FROM category ORDER BY position, name').all() as Row[]).map((c) => ({ id: c.id, name: c.name, question: c.question, keywords: json(c.keywords, []), color: c.color }));
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
        `INSERT INTO category (id, name, question, keywords, color, position) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, question = excluded.question, keywords = excluded.keywords, color = excluded.color`,
      )
      .run(id, c.name, c.question, JSON.stringify(c.keywords ?? []), c.color ?? null, pos);
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

  setTriage(messageId: string, t: Omit<P.TriageView, 'feedback'>) {
    this.db
      .query(`INSERT OR REPLACE INTO triage (message_id, decision, score, reasons, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(messageId, t.decision, t.score, JSON.stringify(t.reasons), t.decidedBy, Date.now());
  }

  triageFeedback(messageId: string, feedback: P.TriageView['feedback']) {
    this.db.query('UPDATE triage SET feedback = ? WHERE message_id = ?').run(feedback, messageId);
    this.dirty.messages.set(messageId, true);
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
    };
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

  /** One person added or took back one reaction. */
  private applyReaction(acc: AccountRow, mid: string, ev: Extract<P.AdapterEvent, { t: 'reaction' }>) {
    const iid = this.ensureIdentity(acc, ev.author);
    const key = canonicalReactionKey(ev.key);
    const style = ev.style ?? 'normal';
    if (ev.emoji) this.putEmoji(acc.network, ev.emoji);
    if (ev.remove) {
      const known = this.db.query('DELETE FROM reaction WHERE message_id = ? AND identity_id = ? AND key = ? AND style = ?').run(mid, iid, key, style).changes > 0;
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
  private reactionSnapshot(acc: AccountRow, mid: string, facts: P.ReactionFact[]) {
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

  private reactionUsage(): P.ReactionUsage[] {
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

  private messageViews(rows: Row[]): P.MessageView[] {
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
    const by = <T extends Row>(xs: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) (m.get(x.message_id) ?? m.set(x.message_id, []).get(x.message_id)!).push(x);
      return m;
    };
    const A = by(atts), R = by(reacts), S = by(seen), RT = by(tallies);
    const T = new Map(tri.map((t) => [t.message_id, t]));
    return rows.map((r) => {
      const seenVia = (S.get(r.id) ?? []).map((s) => s.account_id);
      const rx = new Map<string, string[]>();
      for (const x of R.get(r.id) ?? []) (rx.get(`${x.style}|${x.key}`) ?? rx.set(`${x.style}|${x.key}`, []).get(`${x.style}|${x.key}`)!).push(x.identity_id);
      const t = T.get(r.id);
      return {
        id: r.id,
        conversationId: r.conversation_id,
        network: r.network,
        nativeId: r.native_id,
        authorId: r.author_id,
        ts: r.ts,
        editedTs: r.edited_ts,
        kind: r.kind,
        body: r.deleted ? '' : r.body,
        replyToId: r.reply_to_id,
        threadId: r.thread_id,
        mentionsSelf: !!r.mentions_self,
        deleted: !!r.deleted,
        attachments: (A.get(r.id) ?? []).map((a) => ({
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
        triage: t ? { decision: t.decision, score: t.score, reasons: json(t.reasons, []), decidedBy: t.decided_by, feedback: t.feedback } : null,
      };
    });
  }

  messageView(id: string): P.MessageView | null {
    const r = this.db.query('SELECT * FROM message WHERE id = ?').get(id) as Row | null;
    return r ? this.messageViews([r])[0] : null;
  }

  private identitiesOf(msgs: P.MessageView[]): P.IdentityView[] {
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

  inbox(sinceTs: number): P.InboxPage {
    const rows = this.db
      .query(
        `SELECT m.* FROM triage t JOIN message m ON m.id = t.message_id
         WHERE m.ts >= ? AND m.deleted = 0 AND t.decision != 'silent' ORDER BY m.ts DESC LIMIT 300`,
      )
      .all(sinceTs) as Row[];
    const msgs = this.messageViews(rows);
    return { items: msgs.map((m) => ({ message: m, conversationId: m.conversationId })), identities: this.identitiesOf(msgs) };
  }

  search(q: string, limit = 50): P.MessagePage {
    const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
    const rows = this.db
      .query(`SELECT * FROM message WHERE deleted = 0 AND body LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?`)
      .all(like, limit) as Row[];
    const msgs = this.messageViews(rows);
    return { messages: msgs, identities: this.identitiesOf(msgs), hasMore: false };
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

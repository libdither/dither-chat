/**
 * Kinds of message beyond text and files (docs/media-kinds.md): the sticker picker's pages and installing a pack, and
 * stories. Stories are kept apart from messages on purpose: they never reach the inbox, a count or a notification,
 * show only on their author's or group's page, and are gone once Signal would drop them (a day). Opening one tells its
 * author only where the adapter's rules say so; replying and reacting go through the adapter like a send.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { STICKER_PAGE_PACKS, STORY_LIFETIME_MS, VOICE_MAX_SECONDS } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { requestHeld } from './add.ts';
import type { AccountRow, Store } from './store.ts';

type Cmd =
  | { t: 'stickers'; conversation: string; cursor?: string }
  | { t: 'addStickerPack'; uri: string }
  | { t: 'storyViewed'; story: string }
  | { t: 'storyReply'; story: string; conversation?: string; body?: string; emoji?: string };

export interface MediaDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: Cmd, timeoutMs?: number) => Promise<T>;
  pickAccount: (conversationId: string, requested?: string) => string | null;
  flush?: () => void;
  now?: () => number;
}

export class MediaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const made = new WeakSet<Database>();

/** Stories as each account heard them: a story two accounts both see is kept once per account. */
export function mediaTables(db: Database) {
  if (made.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS story (
    id               TEXT NOT NULL,
    account_id       TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    native_id        TEXT NOT NULL,
    author_id        TEXT NOT NULL,
    conversation_id  TEXT,
    ts               INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    data             TEXT NOT NULL,
    viewed           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (id, account_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS story_author ON story(author_id, expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS story_conversation ON story(conversation_id, expires_at)');
  made.add(db);
}

/**
 * What a send's sticker, recording and view-once come to for an account with these capabilities: an error sentence,
 * or what goes to the adapter. A recording without the network's voice messages goes as an ordinary audio file.
 */
export function sendMediaProblem(
  b: { sticker?: string; files: number; voice?: unknown; viewOnce?: boolean },
  can: P.Capability[],
  who: string,
): { error?: string; voice?: P.VoiceOut; viewOnce?: boolean } {
  if (b.sticker) {
    if (!can.includes('sendStickers')) return { error: `${who} cannot send stickers` };
    if (b.files) return { error: 'A sticker goes on its own, without files' };
  }
  if (b.viewOnce) {
    if (!can.includes('sendViewOnce')) return { error: `${who} cannot send view-once files` };
    if (!b.files) return { error: 'View-once needs a picture or video' };
  }
  const v = b.voice as P.VoiceOut | undefined;
  if (!v || typeof v !== 'object' || b.files !== 1 || !can.includes('sendVoice')) return { ...(b.viewOnce ? { viewOnce: true } : {}) };
  const seconds = Number(v.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > VOICE_MAX_SECONDS + 1) return { error: 'That recording has no length the network takes' };
  const waveform = typeof v.waveform === 'string' && /^[A-Za-z0-9+/]{0,400}={0,2}$/.test(v.waveform) ? v.waveform : undefined;
  return { voice: { seconds: Math.round(seconds * 100) / 100, ...(waveform ? { waveform } : {}) }, ...(b.viewOnce ? { viewOnce: true } : {}) };
}

const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

function isStory(s: unknown): s is P.StoryFact {
  const x = s as P.StoryFact;
  return !!x && typeof x === 'object' && typeof x.nativeId === 'string' && !!x.nativeId && typeof x.author === 'string' && !!x.author && typeof x.ts === 'number' && Number.isFinite(x.ts) && (!!x.attachment || typeof x.text?.text === 'string');
}

/** An adapter's story and storyGone events (store.ts ingest). Only from an account that says it has stories. */
export function ingestStories(store: Store, acc: AccountRow, ev: P.AdapterEvent, now = Date.now()) {
  mediaTables(store.db);
  const db = store.db;
  if (ev.t === 'storyGone') {
    db.query('DELETE FROM story WHERE id = ? AND account_id = ?').run(hubId('sty', acc.network, ev.nativeId), acc.id);
    return;
  }
  if (ev.t !== 'story' || !isStory(ev.story)) return;
  if (!(JSON.parse(acc.capabilities || '[]') as P.Capability[]).includes('stories')) return;
  const s = ev.story;
  // Never longer than the network keeps one, whatever the adapter says.
  const expires = Math.min(typeof s.expiresAt === 'number' ? s.expiresAt : s.ts + STORY_LIFETIME_MS, s.ts + STORY_LIFETIME_MS);
  if (expires <= now) return;
  const author = store.ensureIdentity(acc, s.author);
  const conversation = s.conversation ? hubId('cnv', acc.network, s.conversation) : null;
  db.query(
    `INSERT INTO story (id, account_id, native_id, author_id, conversation_id, ts, expires_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id, account_id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
  ).run(hubId('sty', acc.network, s.nativeId), acc.id, s.nativeId, author, conversation, s.ts, expires, JSON.stringify({ attachment: s.attachment ?? null, text: s.text ?? null, allowsReplies: !!s.allowsReplies }));
}

/** Drop stories past their day (housekeeping, and before each read). */
export function pruneStories(db: Database, now = Date.now()): number {
  mediaTables(db);
  return db.query('DELETE FROM story WHERE expires_at <= ?').run(now).changes;
}

interface StoryRow {
  id: string;
  account_id: string;
  native_id: string;
  author_id: string;
  conversation_id: string | null;
  ts: number;
  expires_at: number;
  data: string;
  viewed: number;
}

export class Media {
  constructor(private d: MediaDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** One page of stickers this account may send in a conversation (capability 'sendStickers'), with the hub's picture addresses. */
  async stickers(conversationId: string, requested: string | undefined, cursor: string | undefined): Promise<P.StickerPageView> {
    const s = this.d.store;
    const conv = s.nativeOf('conversation', conversationId);
    if (!conv) throw new MediaError('no such conversation', 404);
    const accountId = this.d.pickAccount(conversationId, requested);
    const empty = (note: string): P.StickerPageView => ({ accountId, packs: [], next: null, note, canInstall: false });
    if (!accountId || !this.d.online(accountId)) return empty('No connected account can send stickers here.');
    const can = caps(s, accountId);
    if (!can.includes('sendStickers')) return empty('This account cannot send stickers.');
    const page = await this.d.command<P.StickerPage>(accountId, { t: 'stickers', conversation: conv.nativeId, ...(cursor ? { cursor: String(cursor).slice(0, 64) } : {}) }, 20_000);
    const packs = (Array.isArray(page?.packs) ? page.packs : []).slice(0, STICKER_PAGE_PACKS);
    return {
      accountId,
      packs: packs.map((p) => this.packView(p, accountId)),
      next: typeof page?.next === 'string' ? page.next : null,
      ...(page?.note ? { note: String(page.note) } : {}),
      canInstall: can.includes('installStickers'),
    };
  }

  private packView(p: P.StickerPackFact, accountId: string): P.StickerPackView {
    const media = (u: string | undefined) => this.d.store.mediaUrl(u ?? null, accountId);
    const stickers = (p.stickers ?? []).filter((x) => typeof x?.id === 'string' && x.url).map((x) => ({ id: x.id, name: String(x.name ?? ''), ...(x.emoji ? { emoji: x.emoji } : {}), ...(x.mime ? { mime: x.mime } : {}), url: media(x.url) ?? '' }));
    return { id: String(p.id), name: String(p.name ?? ''), source: p.source, cover: media(p.cover) ?? stickers[0]?.url ?? null, stickers };
  }

  /** Install a pack from its link, on the owner's click (capability 'installStickers'). */
  async install(accountId: string, uri: string): Promise<P.StickerPackView> {
    const s = this.d.store;
    if (!s.account(accountId)) throw new MediaError('no such account', 404);
    if (!caps(s, accountId).includes('installStickers')) throw new MediaError('This account cannot install sticker packs.', 409);
    if (!this.d.online(accountId)) throw new MediaError('The account is not connected.', 409);
    const r = await this.d.command<{ pack: P.StickerPackFact }>(accountId, { t: 'addStickerPack', uri }, 60_000);
    return this.packView(r.pack, accountId);
  }

  /** A person's or a group's stories still running, newest last; for a person, the ones they sent to their contacts. */
  stories(q: { identityId?: string; conversationId?: string }): P.StoryView[] {
    const db = this.d.store.db;
    mediaTables(db);
    const now = this.now();
    pruneStories(db, now);
    let rows: StoryRow[] = [];
    if (q.conversationId) rows = db.query('SELECT * FROM story WHERE conversation_id = ? AND expires_at > ? ORDER BY ts').all(q.conversationId, now) as StoryRow[];
    else if (q.identityId) {
      // Every identity of the person, so a page that merged two accounts shows both.
      const ids = this.d.store.db.query('SELECT i2.id FROM identity i1 JOIN identity i2 ON i2.person_id = i1.person_id WHERE i1.id = ? AND i1.person_id IS NOT NULL').all(q.identityId) as { id: string }[];
      const all = [...new Set([q.identityId, ...ids.map((r) => r.id)])];
      rows = db.query(`SELECT * FROM story WHERE author_id IN (${all.map(() => '?').join(',')}) AND conversation_id IS NULL AND expires_at > ? ORDER BY ts`).all(...all, now) as StoryRow[];
    }
    // One per story, whichever account heard it.
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => this.view(r));
  }

  private view(r: StoryRow): P.StoryView {
    const d = JSON.parse(r.data) as { attachment: P.AttachmentFact | null; text: P.StoryTextFact | null; allowsReplies: boolean };
    const a = d.attachment;
    return {
      id: r.id,
      accountId: r.account_id,
      authorId: r.author_id,
      conversationId: r.conversation_id,
      ts: r.ts,
      expiresAt: r.expires_at,
      attachment: a ? { id: `${r.id}:0`, kind: a.kind, mime: a.mime ?? null, name: a.name ?? null, size: a.size ?? null, width: a.width ?? null, height: a.height ?? null, url: this.d.store.mediaUrl(a.url, r.account_id) ?? '' } : null,
      text: d.text,
      allowsReplies: d.allowsReplies,
      viewed: !!r.viewed,
    };
  }

  private row(storyId: string): StoryRow {
    mediaTables(this.d.store.db);
    const r = this.d.store.db.query('SELECT * FROM story WHERE id = ? AND expires_at > ? ORDER BY viewed DESC LIMIT 1').get(storyId, this.now()) as StoryRow | null;
    if (!r) throw new MediaError('That story is gone.', 404);
    return r;
  }

  /** The owner opened a story: marked here, and the adapter tells its author where the network's rules allow. */
  viewed(storyId: string): { sent: boolean } {
    const r = this.row(storyId);
    const first = !r.viewed;
    this.d.store.db.query('UPDATE story SET viewed = 1 WHERE id = ?').run(storyId);
    if (!first || !this.d.online(r.account_id)) return { sent: false };
    // A story from someone whose message request waits tells them nothing (docs/add.md).
    const dm = this.directOf(r);
    if (dm && requestHeld(this.d.store.db, dm)) return { sent: false };
    this.d.command(r.account_id, { t: 'storyViewed', story: r.native_id }, 15_000).catch(() => {});
    return { sent: true };
  }

  /** The 1:1 conversation with a story's author, if the hub has one. */
  private directOf(r: StoryRow): string | null {
    const row = this.d.store.db
      .query(`SELECT c.id FROM conversation c JOIN participant p ON p.conversation_id = c.id WHERE c.shape = 'direct' AND p.identity_id = ? LIMIT 1`)
      .get(r.author_id) as { id: string } | null;
    return row?.id ?? null;
  }

  /** Reply to a story or react to it, through the account that heard it. */
  async reply(storyId: string, b: { body?: string; emoji?: string }): Promise<{ nativeId: string | null }> {
    const r = this.row(storyId);
    const d = JSON.parse(r.data) as { allowsReplies: boolean };
    if (!d.allowsReplies) throw new MediaError('Its author turned replies off.', 409);
    const body = typeof b.body === 'string' ? b.body.trim() : '';
    const emoji = typeof b.emoji === 'string' ? b.emoji.trim() : '';
    if (!body && !emoji) throw new MediaError('Write something, or pick a reaction.', 400);
    if (!this.d.online(r.account_id)) throw new MediaError('The account is not connected.', 409);
    const dm = r.conversation_id ? null : this.directOf(r);
    if (dm && requestHeld(this.d.store.db, dm)) throw new MediaError('Accept the message request first, under Requests', 409);
    const conv = r.conversation_id ? this.d.store.nativeOf('conversation', r.conversation_id)?.nativeId : undefined;
    const res = await this.d.command<{ nativeId?: string }>(r.account_id, { t: 'storyReply', story: r.native_id, ...(conv ? { conversation: conv } : {}), ...(emoji ? { emoji } : { body }) }, 30_000);
    this.d.flush?.();
    return { nativeId: res?.nativeId ?? null };
  }
}

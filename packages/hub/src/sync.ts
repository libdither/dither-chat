/**
 * POST /api/sync: what a client that comes back needs, from its position in the journal (journal.ts, docs/sync.md).
 *
 * Everything but messages comes back as the live socket's own events, read as things are now: one per object that
 * changed since, removals included. Messages only for what the client holds: for each timeline it names, the messages
 * after the newest it has, and the ones it has that changed (edits, deletions, reactions, triage). A timeline too far
 * behind (more new messages than a page, or older than the journal) gets the newest page to replace what it holds.
 */
import type * as P from '@dither-chat/protocol';
import type { Attention } from './attention.ts';
import type { ChangeRow } from './journal.ts';
import type { Store } from './store.ts';
import type { UsageStore } from './usage.ts';
import type { Devices } from './devices.ts';
import type { MailHub } from './mail/index.ts';

type Row = Record<string, any>;

export const PAGE = 60;
/** Timelines a client may ask about at once. */
export const MAX_TIMELINES = 100;
/** The inbox's own limits (Store.inbox). */
const INBOX_DAYS = 7;
const INBOX_MAX = 300;

export interface SyncContext {
  store: Store;
  attention?: Attention;
  usage: UsageStore;
  devices?: Devices;
  mail?: MailHub;
  boot: string;
}

export function syncResponse(ctx: SyncContext, req: P.SyncRequest, now = Date.now()): P.SyncResponse {
  const { store } = ctx;
  const j = store.journal;
  const refused = j.refuse(req.v, req.epoch, req.since ?? j.seq);
  if (refused) return { full: true, reason: refused };
  const msgs: P.MessageView[] = [];
  const out: Extract<P.SyncResponse, { sync: unknown }> = { sync: j.position(), boot: ctx.boot, events: [], timelines: [], identities: [], quoted: [] };

  if (req.since !== undefined) {
    out.events = changedSince(ctx, j.since(req.since));
    out.selfPersonId = (store.one<Row>('SELECT id FROM person WHERE is_self = 1')?.id as string | undefined) ?? null;
    out.categoryProvider = store.categoryProvider;
    out.accountsManager = store.accountsManager;
    // Your most used reactions change only with reactions, which change messages.
    if (store.one('SELECT 1 FROM sync_change WHERE kind = ? AND seq > ? LIMIT 1', 'message', req.since)) out.reactionUsage = store.reactionUsage();
    const inboxRows = store.raw(
      `SELECT m.* FROM sync_change c JOIN message m ON m.id = c.id JOIN triage t ON t.message_id = m.id
       WHERE c.kind = 'message' AND c.seq > ? AND t.decision != 'silent' AND COALESCE(t.feedback, t.decision) != 'drop' AND m.ts >= ? ORDER BY m.ts DESC LIMIT ?`,
      req.since,
      now - INBOX_DAYS * 86_400_000,
      INBOX_MAX,
    );
    out.inbox = store.messageViews(inboxRows);
    msgs.push(...out.inbox);
  }

  for (const t of (Array.isArray(req.timelines) ? req.timelines : []).slice(0, MAX_TIMELINES)) {
    if (typeof t?.key !== 'string' || !/^[cp]:[\w-]+$/.test(t.key)) continue;
    const tl = timeline(store, t);
    out.timelines.push(tl);
    msgs.push(...tl.messages);
  }

  // What replies quote, when it is not in the same answer.
  const have = new Set(msgs.map((m) => m.id));
  const want = [...new Set(msgs.map((m) => m.replyToId).filter((x): x is string => !!x && !have.has(x)))];
  out.quoted = want.length ? store.messageViews(store.raw(`SELECT * FROM message WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(want))) : [];
  out.identities = store.identitiesOf([...msgs, ...out.quoted]);
  return out;
}

/** The events that bring a client from a position to now, in the order the live socket would send them. */
function changedSince(ctx: SyncContext, rows: ChangeRow[]): P.ClientEvent[] {
  const { store, attention, usage } = ctx;
  const ids = new Map<string, string[]>();
  for (const r of rows) (ids.get(r.kind) ?? ids.set(r.kind, []).get(r.kind)!).push(r.id);
  const of = (kind: string) => ids.get(kind) ?? [];
  const list = (kind: string) => ids.has(kind);
  const inList = (table: string, xs: string[]) => (xs.length ? store.raw(`SELECT * FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(xs)) : []);
  const out: P.ClientEvent[] = [];
  const removed: P.ClientEvent[] = [];

  const accounts = new Map(inList('account', of('account')).map((r) => [r.id, r]));
  for (const id of of('account')) {
    const a = accounts.get(id);
    if (a) out.push({ t: 'account', account: store.accountView(a as any) });
    else removed.push({ t: 'account.removed', id });
  }
  // Identities are never taken back from a client: it keeps the ones its messages name.
  for (const i of store.identitiesByIds(of('identity'))) out.push({ t: 'identity', identity: i });
  const persons = new Map(inList('person', of('person')).map((r) => [r.id, r]));
  for (const id of of('person')) {
    const p = persons.get(id);
    if (p) out.push({ t: 'person', person: store.personView(p) });
    else removed.push({ t: 'person.removed', id });
  }
  const spaces = new Map(inList('space', of('space')).map((r) => [r.id, r]));
  for (const id of of('space')) {
    const s = spaces.get(id);
    if (s) out.push({ t: 'space', space: store.spaceView(s), edges: store.edgesOfSpace(id) });
    else removed.push({ t: 'space.removed', id });
  }
  const convs = new Map(store.conversationViews(of('conversation')).map((c) => [c.id, c]));
  for (const id of of('conversation')) {
    const c = convs.get(id);
    if (c) out.push({ t: 'conversation', conversation: c });
    else removed.push({ t: 'conversation.removed', id });
  }
  out.push(...removed);

  if (list('folders')) out.push({ t: 'folders', folders: store.folders() });
  if (list('placePrefs')) out.push({ t: 'placePrefs', prefs: store.placePrefs() });
  if (list('categories')) out.push({ t: 'categories', categories: store.categories(), placeCategories: store.placeCategories() });
  if (list('rules')) out.push({ t: 'rules', rules: store.rules() });
  if (list('devices') && ctx.devices) out.push({ t: 'devices', devices: ctx.devices.list() });

  if (attention && list('attention')) {
    const xs = of('attention');
    if (xs.includes('*')) out.push({ t: 'attention', items: attention.list(), removed: [], replace: true });
    else {
      const items: P.AttentionView[] = [];
      const gone: string[] = [];
      for (const id of xs) {
        const v = attention.view(id);
        if (v) items.push(v);
        else gone.push(id);
      }
      out.push({ t: 'attention', items, removed: gone });
    }
  }
  if (list('usage')) {
    const xs = of('usage');
    if (xs.includes('*')) out.push({ t: 'usage', places: usage.list(), removed: [], replace: true });
    else {
      const places = xs.map((k) => ({ kind: k.slice(0, k.indexOf(':')) as P.UsageKind, id: k.slice(k.indexOf(':') + 1) }));
      const kept = usage.get(places);
      const have = new Set(kept.map((u) => `${u.kind}:${u.id}`));
      out.push({ t: 'usage', places: kept, removed: places.filter((p) => !have.has(`${p.kind}:${p.id}`)) });
    }
  }
  if (list('arrange')) out.push({ t: 'arrange', arrange: usage.arrange() });
  if (ctx.mail) out.push(...mailSince(ctx.mail, of, list));
  return out;
}

/** Mail's part (docs/mail.md): access, accounts, mailboxes and threads, read as they are now. */
function mailSince(mail: MailHub, of: (kind: string) => string[], list: (kind: string) => boolean): P.ClientEvent[] {
  const out: P.ClientEvent[] = [];
  const st = mail.store;
  if (list('mailAccess')) out.push({ t: 'mail.access', access: mail.access() });
  const gone: P.ClientEvent[] = [];
  for (const id of of('mailAccount')) {
    const a = st.account(id);
    if (a && !a.hidden) out.push({ t: 'mail.account', account: st.accountView(a) });
    else gone.push({ t: 'mail.account.removed', id });
  }
  for (const id of of('mailboxes')) if (st.account(id)) out.push({ t: 'mail.mailboxes', accountId: id, mailboxes: st.mailboxes(id).map((b) => st.mailboxView(b)) });
  // The outbox is not journaled: its whole list, as it is now (slice 5).
  if (mail.backend) out.push({ t: 'mail.outbox', items: mail.outbox.views() });
  const ids = of('mailThread');
  if (ids.length) {
    const threads = st.threadViews(ids);
    const have = new Set(threads.map((t) => t.id));
    out.push({ t: 'mail.threads', threads, removed: ids.filter((id) => !have.has(id)) });
  }
  out.push(...gone);
  return out;
}

/** The direct conversations a person timeline merges (Store.personTimeline). */
function personConversations(store: Store, personId: string): string[] {
  return store
    .raw<Row>(
      `SELECT DISTINCT c.id FROM conversation c JOIN participant p ON p.conversation_id = c.id JOIN identity i ON i.id = p.identity_id
       WHERE c.shape = 'direct' AND i.person_id = ?`,
      personId,
    )
    .map((r) => r.id as string);
}

function timeline(store: Store, t: P.SyncTimelineRequest): P.SyncTimeline {
  const j = store.journal;
  const person = t.key.startsWith('p:');
  const id = t.key.slice(2);
  const convs = person ? personConversations(store, id) : [id];
  const list = JSON.stringify(convs);
  const extra = person ? { conversationIds: convs } : {};
  const newest = Number(t.newest) || 0;
  const oldest = Number(t.oldest) || 0;
  const latest = (n: number) => store.raw(`SELECT * FROM message WHERE conversation_id IN (SELECT value FROM json_each(?)) AND ts > ? ORDER BY ts DESC LIMIT ?`, list, newest, n);

  let newer: Row[] = [];
  const regrouped = person && (!Array.isArray(t.conversationIds) || [...t.conversationIds].sort().join() !== [...convs].sort().join());
  let behind = typeof t.seq !== 'number' || t.seq < j.floor || t.seq > j.seq || regrouped;
  if (!behind && t.newer !== false) {
    newer = latest(PAGE + 1);
    behind = newer.length > PAGE;
  }
  if (behind) {
    const rows = convs.length ? store.raw(`SELECT * FROM message WHERE conversation_id IN (SELECT value FROM json_each(?)) ORDER BY ts DESC LIMIT ?`, list, PAGE + 1) : [];
    return { key: t.key, messages: store.messageViews(rows.slice(0, PAGE).reverse()), replace: true, hasMore: rows.length > PAGE, ...extra };
  }
  const changed = store.raw(
    `SELECT m.* FROM sync_change c JOIN message m ON m.id = c.id
     WHERE c.kind = 'message' AND c.conv IN (SELECT value FROM json_each(?)) AND c.seq > ? AND m.ts >= ? AND m.ts <= ?`,
    list,
    t.seq,
    oldest,
    newest,
  );
  const rows = [...changed, ...newer].sort((a, b) => a.ts - b.ts);
  return { key: t.key, messages: store.messageViews(rows), replace: false, ...extra };
}

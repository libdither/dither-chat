/**
 * A fake `notifications` source (docs/notices.md "The demo world"): in tests and on a demo hub, standing where
 * dither-accounts' manager stands. Accounts hold notices in memory; `notify.list`, `notify.markRead`,
 * `notify.markAllRead` and `notify.mute` answer as the interface says (a read sends `notify.read` back, as GitHub's
 * extractor's next poll does), and `emit`/`readThere` send the events an extractor would.
 */
import type { NoticeAccountInfo, NoticeLink, NoticeSink } from './index.ts';

/** The interface's Notification (dither-accounts packages/interfaces notifications.ts), with Part A's urgency. */
export interface FakeNotification {
  id: string;
  source: string;
  title: string;
  body: string | null;
  url: string | null;
  reason: string | null;
  context: string | null;
  subject: { kind: string; title: string; url: string | null; state: string | null } | null;
  actors: { name: string; url: string | null; avatar: string | null }[];
  at: number;
  unread: boolean;
  urgency?: 'high' | 'normal' | 'low';
}

export class FakeNoticeSource implements NoticeLink {
  private sink: NoticeSink | null = null;
  readonly accounts = new Map<string, { info: NoticeAccountInfo; notes: Map<string, FakeNotification> }>();
  /** Every call, for tests. */
  readonly calls: { account: string; op: string; input: Record<string, unknown> }[] = [];

  /** Where its events go; it says its accounts and that it is connected. */
  attach(sink: NoticeSink) {
    this.sink = sink;
    sink.setAccess('granted');
    sink.connection(true);
    this.list();
  }

  addAccount(id: string, kind: string, label: string, level: 'read' | 'write' = 'write') {
    this.accounts.set(id, { info: { id, kind, label, interfaces: ['notifications'], grants: { notifications: level } }, notes: new Map() });
    this.list();
  }

  removeAccount(id: string) {
    this.accounts.delete(id);
    this.list();
  }

  private list() {
    this.sink?.accounts([...this.accounts.values()].map((a) => a.info));
  }

  /** Kept, not sent: what a catch-up finds. */
  put(account: string, n: FakeNotification) {
    this.accounts.get(account)?.notes.set(n.id, n);
  }

  /** Kept and sent, as an extractor sends a new one (`notify.new`). */
  emit(account: string, n: FakeNotification) {
    this.put(account, n);
    this.sink?.events(account, [{ t: 'notify.new', notification: n }]);
  }

  /** Read on the service itself (`notify.read`). */
  readThere(account: string, ids: string[]) {
    const a = this.accounts.get(account);
    for (const id of ids) {
      const n = a?.notes.get(id);
      if (n) n.unread = false;
    }
    this.sink?.events(account, [{ t: 'notify.read', ids }]);
  }

  async call(account: string, op: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ account, op, input });
    const a = this.accounts.get(account);
    if (!a) throw Object.assign(new Error('unknown account'), { code: 'unknown-account' });
    switch (op) {
      case 'notify.list': {
        const since = typeof input.since === 'number' ? input.since : null;
        const limit = typeof input.limit === 'number' ? input.limit : 50;
        const start = typeof input.pageToken === 'string' ? Number(input.pageToken) : 0;
        const all = [...a.notes.values()].filter((n) => (!input.unreadOnly || n.unread) && (since === null || n.at >= since)).sort((x, y) => y.at - x.at);
        const page = all.slice(start, start + limit);
        return { notifications: page, next: start + limit < all.length ? String(start + limit) : null };
      }
      case 'notify.markRead': {
        const ids = ((input.ids as string[]) ?? []).filter((id) => a.notes.has(id));
        for (const id of ids) a.notes.get(id)!.unread = false;
        // The echo: the service says they were read.
        if (ids.length) this.sink?.events(account, [{ t: 'notify.read', ids }]);
        return {};
      }
      case 'notify.markAllRead': {
        const before = typeof input.before === 'number' ? input.before : Infinity;
        for (const n of a.notes.values()) if (n.at <= before) n.unread = false;
        return {};
      }
      case 'notify.mute':
        return {};
      default:
        throw Object.assign(new Error(`unknown op ${op}`), { code: 'unknown-op' });
    }
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
export const DEMO_NOTICE_GITHUB = 'acc_demo-github';
export const DEMO_NOTICE_MANAGER = 'acc_demo-notices';

const gh = (n: Partial<FakeNotification> & Pick<FakeNotification, 'id' | 'title' | 'at'>): FakeNotification => ({
  source: 'github',
  body: null,
  url: null,
  reason: null,
  context: 'libdither/dither-chat',
  subject: null,
  actors: [],
  unread: true,
  ...n,
});
const person = (name: string) => ({ name, url: `https://github.com/${name}`, avatar: null });

/**
 * The demo world's notices: a GitHub account and dither-accounts' own, a few of each urgency, there before the hub
 * starts (a catch-up finds them, quietly); two more arrive live a few seconds after it does, so the demo shows an
 * alert and a row on the list.
 */
export function seedDemoNotices(f: FakeNoticeSource, now = Date.now()) {
  f.addAccount(DEMO_NOTICE_GITHUB, 'github', 'GitHub');
  f.addAccount(DEMO_NOTICE_MANAGER, 'notices', 'dither-accounts');
  const G = DEMO_NOTICE_GITHUB;
  f.put(G, gh({ id: 'th-1001', title: 'Potential secret leaked in a commit', reason: 'security_alert', urgency: 'high', at: now - 3 * HOUR, url: 'https://github.com/libdither/dither-chat/security', subject: { kind: 'RepositoryVulnerabilityAlert', title: 'Secret scanning alert', url: null, state: null } }));
  f.put(G, gh({ id: 'th-1002', title: 'Notices: machine notifications through triage', body: 'Requested your review', reason: 'review_requested', urgency: 'normal', at: now - 2 * HOUR, url: 'https://github.com/libdither/dither-chat/pull/160', actors: [person('octo-sam')], subject: { kind: 'PullRequest', title: 'Notices', url: null, state: 'open' } }));
  f.put(G, gh({ id: 'th-1003', title: 'Phone list drops rows after a restart', body: '@you can you look at this one?', reason: 'mention', urgency: 'normal', at: now - 90 * MIN, url: 'https://github.com/libdither/dither-chat/issues/158', actors: [person('octo-ana')] }));
  f.put(G, gh({ id: 'th-1004', title: 'CI: check failed on main', reason: 'ci_activity', urgency: 'low', at: now - 50 * MIN, url: 'https://github.com/libdither/dither-chat/actions' }));
  f.put(G, gh({ id: 'th-1005', title: 'Release v0.9 published', reason: 'subscribed', urgency: 'low', at: now - 5 * HOUR, context: 'libdither/dither-accounts' }));
  f.put(DEMO_NOTICE_MANAGER, { id: 'acc-attention-signal', source: 'dither-accounts', title: 'Signal needs you', body: 'Sign in again: the session ended', url: null, reason: 'attention', context: 'signal', subject: null, actors: [], at: now - 40 * MIN, unread: true, urgency: 'high' });
  const live = setTimeout(() => {
    f.emit(DEMO_NOTICE_MANAGER, { id: 'acc-stopped-proton', source: 'dither-accounts', title: 'Proton Mail stopped', body: 'It has not run for 5 minutes: the bridge exited', url: null, reason: 'stopped', context: 'proton', subject: null, actors: [], at: Date.now(), unread: true, urgency: 'high' });
    f.emit(G, gh({ id: 'th-1006', title: 'Delivery: one notification per group', body: 'Assigned to you', reason: 'assign', urgency: 'normal', at: Date.now(), url: 'https://github.com/libdither/dither-chat/issues/161', actors: [person('octo-sam')] }));
  }, 4_000);
  live.unref?.();
}

/**
 * dither-accounts as the page sees it (protocol accounts.ts, docs/accounts.md "One list"): every account it lists for
 * this hub with what each offers and what this hub may do, this hub's requests waiting on its page, and its kinds for
 * Add account. remote.ts is the link to the real manager; DemoManager stands in for it in a demo world, so the one list,
 * asking and adding work there too.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORKS } from '@dither-chat/protocol';
import type { FakeMailBackend } from './mail/fake.ts';
import type { FakeNoticeSource } from './notices/fake.ts';
import type { Store } from './store.ts';

/** What the server asks of the manager for the accounts page. */
export interface ManagerLink {
  view(): P.AccountsManagerView;
  /** Its kinds, as this hub may add them; null when it is not reachable or too old to list them. */
  kinds(): Promise<P.ManagedKindView[] | null>;
  /** Ask to use one interface of one account (a dim icon): a request on the manager's page. */
  ask(accountId: string, iface: string): Promise<void>;
  /** Ask to add accounts of a kind here. */
  askKind(kind: string): Promise<void>;
  /** Add an account of a kind this hub manages that is not a chat network (Proton Mail): its id. */
  create(kind: string, label: string, form: Record<string, string>): Promise<string>;
  /** An account it lists that has no chat account here (mail, notices): what the manager says of it. */
  managedOnly(id: string): P.ManagedAccountView | null;
  remove(id: string, purge: boolean): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  restart(id: string): Promise<void>;
  log(id: string): Promise<string>;
}

/** The interfaces a row's icons can ask for, and the level each is asked at (as the hub's own requests are). */
export const ASK_LEVEL: Record<string, 'manage' | 'write'> = { chat: 'manage', mail: 'write', notifications: 'write' };

/** Why the hub asks, per interface, as the manager's page shows it. */
export const ASK_REASON: Record<string, string> = {
  chat: "Show this account's chats in dither-chat",
  mail: "Show this account's mail in dither-chat",
  notifications: "Show this account's notices in dither-chat",
};

/** A kind is added through Add account's own forms (POST /api/accounts) when it is a chat network, else here. */
export const isChatKind = (kind: string) => (NETWORKS as readonly string[]).includes(kind);

/** The view in the store (bootstrap, sync) and, when it changed, the `accountsManager` event. */
export function publishManager(store: Store, view: P.AccountsManagerView) {
  const was = JSON.stringify(store.accountsManager);
  store.accountsManager = view;
  if (JSON.stringify(view) === was) return;
  store.dirty.extra = store.dirty.extra.filter((e) => e.t !== 'accountsManager');
  store.dirty.extra.push({ t: 'accountsManager', manager: view });
}

/** The kinds a demo world offers, shaped as dither-accounts' manifests say them. */
export const DEMO_KINDS: P.ManagedKindView[] = [
  {
    kind: 'proton',
    name: 'Proton Mail',
    interfaces: ['mail'],
    add: {
      blurb: 'Proton Mail in a sandboxed browser on this machine, signed in to the real Proton web app. It works on a free plan: no Proton Bridge.',
      next: 'Sign in to Proton in its live view, and tick Keep me signed in.',
    },
    manages: true,
  },
  {
    kind: 'imap',
    name: 'Email (IMAP)',
    interfaces: ['mail'],
    add: {
      blurb: 'Any mailbox over IMAP, sending over SMTP: Fastmail, Gmail and iCloud with an app password, or your own server.',
      fields: [
        { key: 'email', label: 'Email address', placeholder: 'you@example.com', pattern: '^[^@\\s]+@[^@\\s]+$', hint: 'an address like you@example.com' },
        { key: 'provider', label: 'Provider', placeholder: 'fastmail, gmail, icloud or custom', pattern: '^(proton|fastmail|gmail|icloud|custom)$', hint: 'proton, fastmail, gmail, icloud or custom' },
        { key: 'password', label: 'Password', secret: true, hint: 'an app password, not your account password' },
      ],
      next: 'It signs in now; its page shows where it stops if it cannot.',
    },
    manages: false,
  },
  { kind: 'google', name: 'Google', interfaces: ['google.calendar', 'mail'], add: { blurb: 'Google Calendar and Gmail in a sandboxed browser, signed in as on your desktop.' }, manages: false },
  { kind: 'github', name: 'GitHub', interfaces: ['notifications'], add: { blurb: "GitHub's notifications, with a token of yours.", fields: [{ key: 'token', label: 'Token', secret: true }] }, manages: false },
];

/** A Google account in the demo whose mail this hub may not read yet: its row shows mail dim, to ask for. */
export const DEMO_UNGRANTED = 'acc_demo-work-google';

/**
 * The manager of a demo world: its mail and notices accounts (the fakes'), one Google account whose mail this hub may
 * not read yet, the kinds above, and requests that wait (there is no page to approve them on).
 */
export class DemoManager implements ManagerLink {
  private asks: P.AccessAsk[] = [];
  private kindsHere = DEMO_KINDS.map((k) => ({ ...k }));
  private disabled = new Set<string>();
  /** Accounts added from the page (origin `self`). */
  private made = new Set<string>();
  private n = 0;

  constructor(private o: { store: Store; mail: FakeMailBackend | null; notices: FakeNoticeSource | null }) {
    this.o.mail?.onAccounts(() => this.publish());
  }

  private all(): P.ManagedAccountView[] {
    const out: P.ManagedAccountView[] = [];
    for (const a of this.o.mail?.accountsList() ?? [])
      out.push({
        id: a.id,
        kind: a.kind,
        label: a.label,
        interfaces: a.kind === 'google' ? ['google.calendar', 'mail'] : ['mail'],
        grants: { mail: a.level },
        manages: this.kindsHere.some((k) => k.kind === a.kind && k.manages),
        liveView: false,
        online: a.online && !this.disabled.has(a.id),
        running: !this.disabled.has(a.id),
        enabled: !this.disabled.has(a.id),
        error: null,
        origin: this.made.has(a.id) ? 'self' : 'page',
      });
    for (const [id, a] of this.o.notices?.accounts ?? [])
      out.push({ id, kind: a.info.kind, label: a.info.label, interfaces: a.info.interfaces, grants: a.info.grants as P.ManagedAccountView['grants'], manages: false, liveView: false, online: true, running: true, enabled: true, error: null, origin: 'page' });
    out.push({ id: DEMO_UNGRANTED, kind: 'google', label: 'Work', interfaces: ['google.calendar', 'mail'], grants: {}, manages: false, liveView: false, online: true, running: true, enabled: true, error: null, origin: 'page' });
    return out;
  }

  view(): P.AccountsManagerView {
    return { url: null, reachable: true, accounts: this.all(), asks: this.asks };
  }

  /** Put the view in the store again (after a change here, or in the fakes). */
  publish() {
    publishManager(this.o.store, this.view());
  }

  async kinds() {
    return this.kindsHere.map((k) => {
      const ask = this.asks.find((a) => a.interface === 'accounts' && a.kinds?.includes(k.kind));
      return ask && !k.manages ? { ...k, asked: ask.state } : { ...k };
    });
  }

  async ask(accountId: string, iface: string) {
    this.asks = [...this.asks, { interface: iface, accounts: [accountId], kinds: null, state: 'pending' }];
    this.publish();
  }

  async askKind(kind: string) {
    this.asks = [...this.asks, { interface: 'accounts', accounts: '*', kinds: [kind], state: 'pending' }];
    this.publish();
  }

  async create(kind: string, label: string, form: Record<string, string>) {
    const k = this.kindsHere.find((x) => x.kind === kind);
    if (!k?.manages) throw Object.assign(new Error(`This hub may not add ${k?.name ?? kind} accounts yet`), { status: 403 });
    if (!this.o.mail || !k.interfaces.includes('mail')) throw Object.assign(new Error('A demo world adds only mail accounts'), { status: 409 });
    const id = `acc_demo-${kind}-${++this.n}`;
    this.made.add(id);
    // As the real one does: it starts, and asks you to sign in in its live view before it can read anything.
    this.o.mail.addAccount(id, { kind, label: label || k.name, email: form.email || `you${this.n}@${kind}.example`, online: false, opts: { ids: kind === 'proton' ? 'proton' : 'imap' } });
    this.o.mail.setStatus(id, {
      status: 'attention',
      attention: { kind: 'login', message: k.add?.next ?? 'Sign in in its live view', since: Date.now(), liveView: false },
      layers: [
        { name: 'browser', state: 'ok' },
        { name: 'signed in', state: 'waiting', note: `sign in to ${k.name.split(' ')[0]} in the live view` },
      ],
    });
    this.publish();
    return id;
  }

  managedOnly(id: string) {
    if (this.o.store.account(id)) return null;
    return this.all().find((a) => a.id === id) ?? null;
  }

  async remove(id: string) {
    if (this.o.mail?.accountsList().some((a) => a.id === id)) this.o.mail.removeAccount(id);
    this.publish();
  }

  async setEnabled(id: string, enabled: boolean) {
    if (enabled) this.disabled.delete(id);
    else this.disabled.add(id);
    if (this.o.mail?.accountsList().some((a) => a.id === id)) this.o.mail.setOnline(id, enabled);
    this.publish();
  }

  async restart(_id: string) {}

  async log(id: string) {
    return `--- demo: ${id} runs in a pretend dither-accounts, which keeps no log`;
  }
}

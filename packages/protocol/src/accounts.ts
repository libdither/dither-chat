/**
 * One list of accounts (docs/accounts.md, "One list"): every account this hub uses is one row, whatever it brings here
 * (chats, mail, notices, a calendar), and what it does here shows as a few feature icons on the row. Under one id the
 * hub may have a chat account (AccountView), a mail account (MailAccountView) and, through dither-accounts, the
 * manager's own entry for it (ManagedAccountView: the interfaces its kind offers and this hub's grants). A row is all
 * of them together; this file says what its icons and its status pill are.
 */
import type { AccountView } from './api.ts';
import type { MailAccountView } from './mail.ts';
import type { AccountStatus, Network } from './ontology.ts';

/** What an account does here, as its row's icons say it: a small fixed set. */
export type AccountFeature = 'chat' | 'calls' | 'spaces' | 'feed' | 'mail' | 'calendar' | 'notices';

/** The order the icons come in: what the account is for, then what its chats can do. */
export const FEATURES: readonly AccountFeature[] = ['chat', 'mail', 'calendar', 'notices', 'calls', 'spaces', 'feed'];

/**
 * What an account of each network can do here at most (Add account's tiles): what dither-chat's adapters for it do
 * today, not all the network can. A real account's icons come from its capabilities and what it sees.
 */
export const NETWORK_FEATURES: Record<Network, AccountFeature[]> = {
  discord: ['chat', 'calls', 'spaces'],
  signal: ['chat'],
  matrix: ['chat', 'spaces'],
  whatsapp: ['chat', 'spaces'],
  telegram: ['chat', 'notices', 'spaces'],
  gmessages: ['chat'],
  messenger: ['chat'],
  instagram: ['chat'],
  x: ['chat', 'feed'],
  t3: ['chat'],
  email: ['mail'],
  calendar: ['chat', 'calendar'],
};

/** The features a kind of dither-accounts' offers here, from its interfaces. */
export function kindFeatures(interfaces: readonly string[]): AccountFeature[] {
  return FEATURES.filter((f) => FEATURE_INTERFACE[f] && interfaces.includes(FEATURE_INTERFACE[f]!));
}

/** dither-accounts' interface behind each feature this hub can be granted on an account; the others come with chat. */
export const FEATURE_INTERFACE: Partial<Record<AccountFeature, string>> = { chat: 'chat', mail: 'mail', notices: 'notifications' };

/** What each feature is called, for its icon's label. `spaces` takes the network's own word (servers, spaces). */
export const FEATURE_LABEL: Record<AccountFeature, string> = {
  chat: 'Chats',
  calls: 'Calls',
  spaces: 'Servers',
  feed: 'Feed',
  mail: 'Mail',
  calendar: 'Calendar',
  notices: 'Notices',
};

/**
 * on: it works here. trouble: it is on but stopped (a dot on its icon, and `why`). off: the account offers it but this
 * hub may not use it (a dim icon; asking puts a request on dither-accounts' page). asked: that request waits for you
 * there. denied: you said no there.
 */
export type FeatureState = 'on' | 'trouble' | 'off' | 'asked' | 'denied';

export interface FeatureView {
  feature: AccountFeature;
  state: FeatureState;
  /** One line: why it is stopped, or what turning it on would ask for. */
  why?: string;
}

/** An account as dither-accounts lists it for this hub (its AccountView there): what it offers, what the hub may do. */
export interface ManagedAccountView {
  id: string;
  /** dither-accounts' kind: a chat network's name, or `proton`, `imap`, `google`, `github`… */
  kind: string;
  label: string;
  /** The interfaces its kind offers. */
  interfaces: string[];
  /** This hub's grants on it, per interface. */
  grants: Record<string, 'read' | 'write' | 'manage'>;
  /** This hub may run it: restart it, read its log, open its live view, remove it. */
  manages: boolean;
  liveView: boolean;
  online: boolean;
  running: boolean;
  enabled: boolean;
  /** Why the manager is not running it. */
  error: string | null;
  /** Who made it: this hub, another app, the manager's page, or an import in place. */
  origin: 'self' | 'app' | 'page' | 'import' | null;
}

/** One field of a kind's add form (dither-accounts' AddField). */
export interface KindField {
  key: string;
  label: string;
  placeholder?: string;
  /** Goes to the account's secret file there, never to its config. */
  secret?: boolean;
  optional?: boolean;
  default?: string;
  /** A regular expression the value must match, and what to say when it does not. */
  pattern?: string;
  hint?: string;
}

/** A kind of account dither-accounts runs (its `kinds` admin action), as Add account offers it. */
export interface ManagedKindView {
  kind: string;
  name: string;
  interfaces: string[];
  /** How it is added: what it is, its form, what happens next. Null: it is not added with a form. */
  add: { blurb: string; fields?: KindField[]; next?: string } | null;
  /** This hub may add accounts of it. */
  manages: boolean;
  /** This hub asked to add accounts of it: the request waits on the manager's page, or you declined it. */
  asked?: 'pending' | 'denied';
}

/** A request of this hub's on the manager's page that is not granted: waiting for you, or declined. */
export interface AccessAsk {
  interface: string;
  /** The accounts it is for: every one, or these. */
  accounts: '*' | string[];
  /** For an `accounts` request: the kinds. */
  kinds: string[] | null;
  state: 'pending' | 'denied';
}

/** dither-accounts as this hub sees it: in the bootstrap, each sync, and the live `accountsManager` event. */
export interface AccountsManagerView {
  /** Its page as the browser reaches it (DITHER_ACCOUNTS_PUBLIC_URL). */
  url: string | null;
  /** The hub is connected to it. Absent from hubs before this. */
  reachable?: boolean;
  /** Every account it lists for this hub. Absent until its first list. */
  accounts?: ManagedAccountView[];
  /** This hub's requests there that wait for you, or that you declined. */
  asks?: AccessAsk[];
}

/** GET /api/accounts/kinds: null when the manager is not reachable or too old to list its kinds. */
export interface KindsPage {
  kinds: ManagedKindView[] | null;
  url: string | null;
}

/** The request of this hub's on `iface` that covers this account, if one waits or was declined (a waiting one first). */
export function askFor(asks: readonly AccessAsk[] | undefined, iface: string, accountId: string): AccessAsk | undefined {
  const mine = (asks ?? []).filter((a) => a.interface === iface && (a.accounts === '*' || a.accounts.includes(accountId)));
  return mine.find((a) => a.state === 'pending') ?? mine[0];
}

/** The request of this hub's to add accounts of `kind`, if one waits or was declined. */
export function kindAsk(asks: readonly AccessAsk[] | undefined, kind: string): AccessAsk | undefined {
  const mine = (asks ?? []).filter((a) => a.interface === 'accounts' && (a.kinds === null || a.kinds.includes(kind)));
  return mine.find((a) => a.state === 'pending') ?? mine[0];
}

/** What a row is made of. */
export interface AccountParts {
  chat?: AccountView | null;
  mail?: MailAccountView | null;
  managed?: ManagedAccountView | null;
  asks?: readonly AccessAsk[];
  /** It sees at least one community (a Discord server, a Matrix space, a WhatsApp community). */
  spaces?: boolean;
  /** It has a feed conversation (X's notifications about you). */
  feed?: boolean;
}

function chatState(c: AccountView): Pick<FeatureView, 'state' | 'why'> {
  if (c.status === 'attention' || c.status === 'error') return { state: 'trouble', why: c.attention?.message ?? (c.status === 'error' ? 'It stopped with an error' : 'It needs you') };
  if (c.status === 'offline') return { state: 'trouble', why: 'Offline' };
  return { state: 'on' };
}

function mailState(m: MailAccountView): Pick<FeatureView, 'state' | 'why'> {
  if (m.level === null) return { state: 'trouble', why: 'dither-chat no longer has access to it' };
  if (m.problem) return { state: 'trouble', why: m.problem.message };
  if (!m.online) return { state: 'trouble', why: 'Offline' };
  return { state: 'on' };
}

const OFF_WHY: Partial<Record<AccountFeature, string>> = {
  chat: 'Its chats are not shown here: ask dither-accounts to let dither-chat read them',
  mail: 'Its mail is not shown here: ask dither-accounts to let dither-chat read it',
  notices: 'Its notices are not shown here: ask dither-accounts to let dither-chat read them',
};

/** A row's icons, in FEATURES order: what it does here, and what it offers that this hub does not use yet. */
export function accountFeatures(x: AccountParts): FeatureView[] {
  const out = new Map<AccountFeature, FeatureView>();
  const c = x.chat;
  if (c) {
    if (c.network === 'calendar') {
      // The calendar is what it is for; its chats (the Calendar chat) come with it.
      out.set('calendar', { feature: 'calendar', ...chatState(c) });
      out.set('chat', { feature: 'chat', state: 'on' });
    } else out.set('chat', { feature: 'chat', ...chatState(c) });
    if (c.capabilities.includes('calls')) out.set('calls', { feature: 'calls', state: 'on' });
    if (x.spaces) out.set('spaces', { feature: 'spaces', state: 'on' });
    if (x.feed) out.set('feed', { feature: 'feed', state: 'on' });
  }
  if (x.mail) out.set('mail', { feature: 'mail', ...mailState(x.mail) });
  const g = x.managed;
  if (g) {
    for (const f of FEATURES) {
      const iface = FEATURE_INTERFACE[f];
      if (!iface || out.has(f) || !g.interfaces.includes(iface)) continue;
      if (g.grants[iface]) {
        // Granted, with nothing of its own here to say more (notices): the account's own state.
        out.set(f, g.online ? { feature: f, state: 'on' } : { feature: f, state: 'trouble', why: g.error ?? (g.enabled ? 'Offline' : 'Disabled in dither-accounts') });
        continue;
      }
      const ask = askFor(x.asks, iface, g.id);
      if (ask?.state === 'pending') out.set(f, { feature: f, state: 'asked', why: "Asked: approve it on dither-accounts' page" });
      else if (ask?.state === 'denied') out.set(f, { feature: f, state: 'denied', why: 'You declined this on dither-accounts’ page' });
      else out.set(f, { feature: f, state: 'off', why: OFF_WHY[f] });
    }
  }
  return FEATURES.filter((f) => out.has(f)).map((f) => out.get(f)!);
}

/** A row's status pill: the worst of its parts. */
export interface RowStatus {
  status: AccountStatus;
  /** The pill's word: Online, Needs you, No access… */
  label: string;
}

const STATUS_LABEL: Record<AccountStatus, string> = { online: 'Online', connecting: 'Connecting', attention: 'Needs you', offline: 'Offline', error: 'Error', disabled: 'Disabled' };
/** Worse first: a row shows the worst status any of its parts has. A disabled part counts only when all are. */
const RANK: AccountStatus[] = ['error', 'attention', 'offline', 'connecting', 'online'];

export function rowStatus(x: AccountParts): RowStatus {
  const parts: RowStatus[] = [];
  if (x.chat) parts.push({ status: x.chat.status, label: STATUS_LABEL[x.chat.status] });
  const m = x.mail;
  if (m) {
    if (m.level === null) parts.push({ status: 'disabled', label: 'No access' });
    else if (m.problem) parts.push({ status: 'attention', label: STATUS_LABEL.attention });
    else parts.push(m.online ? { status: 'online', label: STATUS_LABEL.online } : { status: 'offline', label: STATUS_LABEL.offline });
  }
  const g = x.managed;
  if (g && !x.chat && !m) {
    // Nothing of it is used here (its icons all dim): not its state there, but that.
    const used = Object.values(FEATURE_INTERFACE).some((i) => i && g.interfaces.includes(i) && g.grants[i]);
    const asked = Object.values(FEATURE_INTERFACE).some((i) => i && g.interfaces.includes(i) && askFor(x.asks, i, g.id)?.state === 'pending');
    const st: AccountStatus = !g.enabled ? 'disabled' : g.error && !g.running ? 'error' : g.online ? 'online' : 'offline';
    parts.push(used ? { status: st, label: STATUS_LABEL[st] } : { status: 'disabled', label: asked ? 'Asked' : 'Not used' });
  }
  if (!parts.length) return { status: 'offline', label: STATUS_LABEL.offline };
  const live = parts.filter((p) => p.status !== 'disabled');
  if (!live.length) return parts[0];
  return live.reduce((a, b) => (RANK.indexOf(b.status) < RANK.indexOf(a.status) ? b : a));
}

/**
 * Whether an account's layers say `iface` is in trouble: the first layer not ok (waiting or failed) among those every
 * interface rests on and those only `iface` rests on (StatusLayer.interface). Null when none is.
 */
export function interfaceTrouble<L extends { name: string; state: string; note?: string; interface?: string }>(layers: readonly L[], iface: string): L | null {
  return layers.find((l) => (l.state === 'waiting' || l.state === 'failed') && (!l.interface || l.interface === iface)) ?? null;
}

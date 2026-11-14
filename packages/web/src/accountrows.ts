/**
 * The accounts page's one list (docs/accounts.md "One list", protocol accounts.ts): every account this hub uses, its
 * chats, its mail or its notices, as one row with a few feature icons. A row joins what the hub has under one id: the
 * chat account, the mail account, and what dither-accounts says of it.
 */
import type * as P from '@dither-chat/protocol';
import { accountFeatures, NETWORK_META, NETWORKS, rowStatus } from '@dither-chat/protocol';
import { db } from './state.ts';

/** Kinds that are not chat networks: what they are called and how their badge is drawn (an icon on their colour). */
export const KIND_META: Record<string, { name: string; color: string; icon: string }> = {
  proton: { name: 'Proton Mail', color: '#6D4AFF', icon: 'mail' },
  imap: { name: 'Email (IMAP)', color: '#5B7083', icon: 'mail' },
  google: { name: 'Google', color: '#DB4437', icon: 'mail' },
  github: { name: 'GitHub', color: '#24292F', icon: 'bell' },
  notices: { name: 'Its own notices', color: '#7E57C2', icon: 'bell' },
  bugwatch: { name: 'Bug watch', color: '#B45309', icon: 'alert' },
};

export const isNetwork = (kind: string): kind is P.Network => (NETWORKS as readonly string[]).includes(kind);

/** A kind's name: its network's, its own (KIND_META), else the manager's for it, else the kind itself. */
export function kindName(kind: string, kinds?: readonly P.ManagedKindView[] | null): string {
  if (isNetwork(kind)) return NETWORK_META[kind].name;
  return KIND_META[kind]?.name ?? kinds?.find((k) => k.kind === kind)?.name ?? kind;
}

export interface AccountRow {
  id: string;
  /** A chat network's name, or the manager's kind (proton, imap, github…). */
  kind: string;
  /** Its network, for a chat account; null for the rest. */
  network: P.Network | null;
  /** Its label, or for mail the address it receives at. */
  name: string;
  color: string;
  /** What it is: Discord, Proton Mail… */
  platform: string;
  chat: P.AccountView | null;
  mail: P.MailAccountView | null;
  managed: P.ManagedAccountView | null;
  features: P.FeatureView[];
  status: P.RowStatus;
  /** One line after the platform: what it needs, else something worth knowing. */
  note: string | null;
}

/** Which accounts see a community, and which have a feed: what their icons are made of. */
function seen() {
  const spaces = new Set<string>();
  for (const s of db.spaces.values()) if (s.kind === 'community') for (const a of s.accountIds) spaces.add(a);
  const feeds = new Set<string>();
  for (const c of db.conversations.values()) if (c.variant === 'feed') for (const v of c.vantages) feeds.add(v.accountId);
  return { spaces, feeds };
}

function rowOf(id: string, s: ReturnType<typeof seen>): AccountRow | null {
  const chat = db.accounts.get(id) ?? null;
  const mail = db.mail.accounts.get(id) ?? null;
  const managed = db.accountsManager?.accounts?.find((a) => a.id === id) ?? null;
  const parts: P.AccountParts = { chat, mail, managed, asks: db.accountsManager?.asks, spaces: s.spaces.has(id), feed: s.feeds.has(id) };
  const features = accountFeatures(parts);
  // An account the manager lists that this hub can do nothing with (none of its interfaces is one it uses): not a row.
  if (!chat && !mail && !features.length) return null;
  const kind = chat?.network ?? mail?.kind ?? managed?.kind ?? 'email';
  const note = chat
    ? (chat.attention?.message ?? chat.self?.notices[0]?.title ?? (chat.demo ? 'demo data' : null))
    : mail
      ? (mail.problem?.message ?? (mail.level === 'read' ? 'read only' : mail.dryRun ? 'dry run' : null))
      : (managed?.error ?? null);
  return {
    id,
    kind,
    network: chat?.network ?? null,
    name: chat?.label ?? mail?.address ?? mail?.label ?? managed?.label ?? id,
    color: chat?.color ?? mail?.color ?? KIND_META[kind]?.color ?? '#888',
    platform: kindName(kind),
    chat,
    mail,
    managed,
    features,
    status: rowStatus(parts),
    note,
  };
}

/**
 * Every row, accounts of one kind together (kinds in the order their first account came), chat accounts in the order
 * they were added, then mail, then the rest.
 */
export function accountRows(): AccountRow[] {
  const s = seen();
  const ids = [...new Set([...db.accounts.keys(), ...db.mail.accounts.keys(), ...(db.accountsManager?.accounts ?? []).map((a) => a.id)])];
  const rows = ids.map((id) => rowOf(id, s)).filter((r): r is AccountRow => !!r);
  const order = [...new Set(rows.map((r) => r.kind))];
  return rows.map((r, i) => ({ r, i })).sort((a, b) => order.indexOf(a.r.kind) - order.indexOf(b.r.kind) || a.i - b.i).map((x) => x.r);
}

export function accountRow(id: string): AccountRow | null {
  return rowOf(id, seen());
}

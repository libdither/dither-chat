/**
 * Where mail comes from (docs/mail-design.md §3.1): dither-accounts' `mail` interface on the manager connection the
 * hub already has (ManagerMailBackend, on remote.ts's RoutedSupervisor), or FakeMailBackend (fake.ts) in tests and
 * demo worlds. The rest of mail/ knows only this.
 */
import type * as P from '@dither-chat/protocol';

/** A mail account the manager lists for this hub, with its mail grant. */
export interface MailBackendAccount {
  id: string;
  kind: string;
  label: string;
  level: 'read' | 'write';
  dryRun: boolean;
  online: boolean;
}

/** An extractor's event: hello, status, mail.arrived, mail.changed. */
export type MailBackendEvent = { t: string; [k: string]: unknown };

/** A call that failed: `status` as the extractor or manager gave it (410: list again; 501: not supported). */
export class MailCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The manager's error codes as HTTP-ish statuses, for errors that came without one. */
const CODE_STATUS: Record<string, number> = { denied: 403, limited: 429, offline: 503, timeout: 504, invalid: 400, 'unknown-op': 501, 'unknown-account': 404 };

export function asMailError(e: unknown): MailCallError {
  if (e instanceof MailCallError) return e;
  const x = e as { message?: string; status?: number; code?: string };
  return new MailCallError(String(x?.message ?? e), x?.status ?? (x?.code ? CODE_STATUS[x.code] : undefined), x?.code);
}

export interface MailBackend {
  /** The manager answers. */
  readonly connected: boolean;
  /** Whether the hub may read mail at all. */
  access(): P.MailAccess['state'];
  call<T = unknown>(account: string, op: string, input?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onAccounts(fn: (accounts: MailBackendAccount[]) => void): void;
  onEvents(fn: (account: string, events: MailBackendEvent[]) => void): void;
  /** The manager dropped events for the account while the hub was away: catch up with mail.changes. */
  onGap(fn: (account: string) => void): void;
  onConnection(fn: (up: boolean) => void): void;
  onAccess(fn: (state: P.MailAccess['state']) => void): void;
  /** After a denial: ask the manager again (§6.6 "Ask again"). */
  askAgain?(): Promise<void>;
  /** The manager reads this machine's files: attachments go as a `path`, not their bytes (slice 5). */
  readonly localFiles?: boolean;
}

/** What remote.ts tells mail about the manager (RoutedSupervisor.mail). */
export interface MailSink {
  /** Every account the manager lists, as remote.ts's AccountView. */
  accounts(list: { id: string; kind: string; label: string; interfaces: string[]; online: boolean; grants: Record<string, string>; dryRun: boolean }[]): void;
  events(account: string, events: MailBackendEvent[]): boolean;
  gap(account: string): boolean;
  connection(up: boolean): void;
  setAccess(state: P.MailAccess['state']): void;
}

/** remote.ts's side: the call path, and asking for the grant again. */
export interface ManagerLink {
  callRaw(account: string, op: string, input: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  askMailAgain(): Promise<void>;
}

/** The mail interface through dither-accounts' manager, on remote.ts's connection. */
export class ManagerMailBackend implements MailBackend, MailSink {
  connected = false;
  /** Set when DITHER_ACCOUNTS_URL is on loopback (main.ts). */
  localFiles = false;
  private state: P.MailAccess['state'] = 'unreachable';
  private mailAccounts = new Set<string>();
  private fns = { accounts: [] as ((a: MailBackendAccount[]) => void)[], events: [] as ((a: string, e: MailBackendEvent[]) => void)[], gap: [] as ((a: string) => void)[], connection: [] as ((u: boolean) => void)[], access: [] as ((s: P.MailAccess['state']) => void)[] };

  constructor(private link: ManagerLink) {}

  access() {
    return this.state;
  }

  call<T>(account: string, op: string, input: Record<string, unknown> = {}, timeoutMs = 65_000): Promise<T> {
    // The manager puts its own call id in a command's `id` (dither-accounts' imap harness standIn): the message id
    // goes as `message` too, which the extractors read when `id` is not one of theirs.
    const wire = (op === 'mail.get' || op === 'mail.attachment') && typeof input.id === 'string' && input.message === undefined ? { ...input, message: input.id } : input;
    return this.link.callRaw(account, op, wire, timeoutMs).catch((e) => {
      throw asMailError(e);
    }) as Promise<T>;
  }

  onAccounts(fn: (a: MailBackendAccount[]) => void) {
    this.fns.accounts.push(fn);
  }
  onEvents(fn: (a: string, e: MailBackendEvent[]) => void) {
    this.fns.events.push(fn);
  }
  onGap(fn: (a: string) => void) {
    this.fns.gap.push(fn);
  }
  onConnection(fn: (u: boolean) => void) {
    this.fns.connection.push(fn);
  }
  onAccess(fn: (s: P.MailAccess['state']) => void) {
    this.fns.access.push(fn);
  }
  askAgain() {
    return this.link.askMailAgain();
  }

  // ---------------------------------------------------------- MailSink (remote.ts)

  accounts(list: Parameters<MailSink['accounts']>[0]) {
    const mine = list.filter((a) => a.interfaces.includes('mail') && (a.grants.mail === 'read' || a.grants.mail === 'write'));
    this.mailAccounts = new Set(mine.map((a) => a.id));
    const out = mine.map((a) => ({ id: a.id, kind: a.kind, label: a.label, level: a.grants.mail as 'read' | 'write', dryRun: !!a.dryRun, online: !!a.online }));
    for (const f of this.fns.accounts) f(out);
  }
  /** Returns whether the events were mail's. */
  events(account: string, events: MailBackendEvent[]): boolean {
    if (!this.mailAccounts.has(account)) return false;
    for (const f of this.fns.events) f(account, events);
    return true;
  }
  gap(account: string): boolean {
    if (!this.mailAccounts.has(account)) return false;
    for (const f of this.fns.gap) f(account);
    return true;
  }
  connection(up: boolean) {
    this.connected = up;
    for (const f of this.fns.connection) f(up);
  }
  setAccess(state: P.MailAccess['state']) {
    if (state === this.state) return;
    this.state = state;
    for (const f of this.fns.access) f(state);
  }
}

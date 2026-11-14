/**
 * A stand-in for dither-accounts' client (packages/client), loaded by RoutedSupervisor.connect through
 * DITHER_ACCOUNTS_CLIENT: what the manager says of the app (`self`) is set by the test, and what the hub asked for is
 * recorded. No network.
 */
export interface StubState {
  /** What `self` answers; null: the manager does not know this app (401). */
  self: { grants?: { interface: string; kinds: string[] | null }[]; requests?: { interface: string; kinds?: string[] | null; state?: string }[] } | null;
  registered: { requests: { interface: string }[] }[];
  asked: { interface: string }[][];
  client: AccountsClient | null;
  calls: { account: string; op: string; input: Record<string, unknown> }[];
  /** The manager's administration the hub asked for (a restart after a gap). */
  admin: Record<string, unknown>[];
  /** What `admin({ do: 'kinds' })` answers; absent: as a manager before it, which refuses it. */
  kinds?: unknown[];
}

export const stub = ((globalThis as any).__accountsStub ??= { self: null, registered: [], asked: [], client: null, calls: [], admin: [] }) as StubState;

export class AccountsClient {
  accounts: unknown[] = [];
  connected = true;
  constructor(readonly opts: { onAccounts?: (a: any[]) => void; onEvents?: (account: string, events: any[]) => void; onGap?: (account: string, dropped: number) => void; onConnection?: (up: boolean) => void }) {
    stub.client = this;
  }
  async callRaw(account: string, op: string, input: Record<string, unknown> = {}) {
    stub.calls.push({ account, op, input });
    return op === 'notify.list' ? { notifications: [], next: null } : {};
  }
  async admin(action: Record<string, unknown>) {
    stub.admin.push(action);
    if (action.do === 'kinds') {
      if (!stub.kinds) throw new Error('no such account');
      return { kinds: stub.kinds };
    }
    if (action.do === 'create') return { id: (action.id as string | undefined) ?? `acc_made${stub.admin.length}` };
    if (action.do === 'log') return { lines: [`log of ${action.account}`], size: 1 };
    return {};
  }
  liveViewUrl() {
    return '';
  }
  close() {}
}

export async function register(_url: string, req: { requests: { interface: string }[] }) {
  stub.registered.push(req);
  return { app: 'app_stub', token: 'token_stub' };
}

export async function self() {
  if (!stub.self) throw new Error('401 unknown app');
  return stub.self;
}

export async function requestAccess(_url: string, _app: string, _token: string, requests: { interface: string }[]) {
  stub.asked.push(requests);
  return {};
}

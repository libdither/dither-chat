/**
 * A stand-in for signal-cli that never touches the network, for driving the
 * adapter in tests. Implements just enough of the real CLI:
 *
 *   --config DIR [--trust-new-identities X] link -n NAME
 *       prints a sgnl://linkdevice URI; "scans" when DIR/fake-scan appears
 *       (logs "linking in progress", writes data/accounts.json, prints
 *       "Associated with: <number>", exits 0); otherwise times out like the
 *       real one ("Link request timed out, please try again.", exit 1). If
 *       fake-scan contains "fail", registration fails after the scan (exit 3).
 *
 *   --config DIR -a ACI daemon --socket PATH --receive-mode on-connection ...
 *       JSON-RPC over the UNIX socket. Every request is appended to
 *       DIR/fake-rpc.jsonl. Files dropped into DIR/fake-push/ are sent to
 *       connected clients as `receive` notifications. DIR/fake-exit makes it
 *       exit with the code inside; DIR/fake-hang holding this daemon's pid makes it
 *       stop answering (socket stays open). If data/accounts.json marks the account
 *       unregistered it fails like the real one ("User X is not registered.").
 *
 * Knobs (env): FAKE_NUMBER, FAKE_ACI, FAKE_LINK_TIMEOUT_MS, FAKE_PROFILE_NAME.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const config = opt('--config') ?? opt('--data-dir');
if (!config) {
  console.error('fake: --config is required');
  process.exit(2);
}
const sub = args.find((a) => a === 'link' || a === 'daemon');
const NUMBER = process.env.FAKE_NUMBER ?? '+15550100';
const ACI = process.env.FAKE_ACI ?? '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const accountsFile = join(config, 'data', 'accounts.json');
mkdirSync(join(config, 'data'), { recursive: true });
const record = (o: unknown) => appendFileSync(join(config, 'fake-rpc.jsonl'), JSON.stringify(o) + '\n');
record({ t: 'argv', argv: args, pid: process.pid });
process.on('SIGTERM', () => process.exit(143));

if (sub === 'link') {
  if (args.includes('-a')) {
    console.error('You cannot specify a account (phone number) when linking');
    process.exit(1);
  }
  const n = Math.floor(Math.random() * 1e9);
  await Bun.sleep(30);
  console.log(`sgnl://linkdevice?uuid=FAKE${n}&pub_key=KEY${n}`);
  const deadline = Date.now() + Number(process.env.FAKE_LINK_TIMEOUT_MS ?? 120_000);
  while (Date.now() < deadline) {
    if (existsSync(join(config, 'fake-scan'))) {
      const how = readFileSync(join(config, 'fake-scan'), 'utf8').trim();
      rmSync(join(config, 'fake-scan'), { force: true });
      console.error(`INFO  ProvisioningManagerImpl - Received link information from ${NUMBER}, linking in progress ...`);
      await Bun.sleep(50);
      if (how === 'fail') {
        console.error('Link request error: Failed to register as secondary device (NonSuccessfulResponseCodeException)');
        process.exit(3);
      }
      writeFileSync(accountsFile, JSON.stringify({ accounts: [{ path: '123456', environment: 'LIVE', number: NUMBER, uuid: ACI }], version: 2 }));
      console.log(`Associated with: ${NUMBER}`);
      process.exit(0);
    }
    await Bun.sleep(20);
  }
  console.error('Link request timed out, please try again.');
  process.exit(1);
}

if (sub === 'daemon') {
  const account = opt('-a');
  const accounts = existsSync(accountsFile) ? JSON.parse(readFileSync(accountsFile, 'utf8')).accounts : [];
  const acc = accounts.find((a: any) => a.uuid === account || a.number === account);
  if (!acc || acc.registered === false) {
    console.error(`User ${account} is not registered.`);
    process.exit(1);
  }
  const socketPath = opt('--socket');
  if (!socketPath) {
    console.error('At least one channel parameter is required, e.g. --socket or --dbus.');
    process.exit(1);
  }
  await Bun.sleep(100); // account loading
  const conns = new Set<any>();
  const send = (s: any, o: unknown) => s.write(JSON.stringify(o) + '\n');
  const SELF = acc.uuid;
  const contacts = () => {
    const f = join(config, 'fake-contacts.json');
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
    return [
      { number: NUMBER, uuid: SELF, username: null, name: '', givenName: null, familyName: null, nickName: null, nickGivenName: null, nickFamilyName: null, note: null, color: null, isArchived: false, isBlocked: false, isHidden: false, messageExpirationTime: 0, profileSharing: true, unregistered: false, profile: { lastUpdateTimestamp: 1, givenName: process.env.FAKE_PROFILE_NAME ?? 'Zyan', familyName: null, about: null, aboutEmoji: null, hasAvatar: false, mobileCoinAddress: null } },
      { number: '+15550137', uuid: 'a11ce000-2222-4ccc-9ddd-000000000002', username: null, name: 'Alice Chen', givenName: 'Alice', familyName: 'Chen', nickName: null, nickGivenName: null, nickFamilyName: null, note: null, color: null, isArchived: false, isBlocked: false, isHidden: false, messageExpirationTime: 0, profileSharing: true, unregistered: false, profile: { lastUpdateTimestamp: 1, givenName: 'Alice', familyName: null, about: null, aboutEmoji: null, hasAvatar: false, mobileCoinAddress: null } },
      { number: '+15550161', uuid: '5a3e0000-3333-4eee-afff-000000000003', username: null, name: '', givenName: null, familyName: null, nickName: null, nickGivenName: null, nickFamilyName: null, note: null, color: null, isArchived: false, isBlocked: false, isHidden: false, messageExpirationTime: 3600, profileSharing: true, unregistered: false, profile: { lastUpdateTimestamp: 1, givenName: 'Sam', familyName: 'Rivera', about: null, aboutEmoji: null, hasAvatar: false, mobileCoinAddress: null } },
    ];
  };
  const groups = () => {
    const f = join(config, 'fake-groups.json');
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
    return [
      {
        id: 'Pmpi+EfPWmsxiomLe9Nx2XF9HOE483p6iKiFj65iMwI=',
        name: 'Climbing crew 🧗',
        description: 'thursday nights',
        isMember: true,
        isBlocked: false,
        messageExpirationTime: 0,
        members: [
          { number: NUMBER, uuid: SELF, isAdmin: true },
          { number: '+15550137', uuid: 'a11ce000-2222-4ccc-9ddd-000000000002', isAdmin: false },
          { number: '+15550161', uuid: '5a3e0000-3333-4eee-afff-000000000003', isAdmin: false },
        ],
        pendingMembers: [],
        requestingMembers: [],
        admins: [{ number: NUMBER, uuid: SELF }],
        banned: [],
        permissionAddMember: 'EVERY_MEMBER',
        permissionEditDetails: 'EVERY_MEMBER',
        permissionSendMessage: 'EVERY_MEMBER',
        groupInviteLink: null,
        isTerminated: false,
      },
    ];
  };
  let ts = Date.now();
  const nextTs = () => (ts = Math.max(ts + 1, Date.now()));
  const handle = (method: string, params: any): unknown => {
    switch (method) {
      case 'listContacts': {
        const all = contacts();
        const want: string[] | undefined = params?.recipient ? [].concat(params.recipient) : undefined;
        if (want) return all.filter((c: any) => want.includes(c.uuid) || want.includes(c.number));
        return params?.allRecipients ? all : all.filter((c: any) => c.uuid !== SELF);
      }
      case 'listGroups': {
        const ids: string[] | undefined = params?.groupId ? [].concat(params.groupId) : undefined;
        return groups().filter((g: any) => !ids || ids.includes(g.id));
      }
      case 'send':
      case 'sendReaction':
      case 'remoteDelete':
      case 'sendReceipt':
      case 'sendTyping': {
        if (params?.message === 'FAIL') throw Object.assign(new Error('Failed to send message'), { code: -1 });
        return { timestamp: nextTs(), results: [{ recipientAddress: { uuid: 'a11ce000-2222-4ccc-9ddd-000000000002', number: '+15550137' }, type: 'SUCCESS' }] };
      }
      case 'sendSyncRequest':
        return {};
      case 'version':
        return { version: '0.14.8-fake' };
      default:
        throw Object.assign(new Error('Method not implemented'), { code: -32601 });
    }
  };
  Bun.listen({
    unix: socketPath,
    socket: {
      open: (s) => {
        conns.add(s);
        (s as any).buf = '';
      },
      close: (s) => {
        conns.delete(s);
      },
      data: (s, chunk) => {
        (s as any).buf += chunk.toString();
        let nl: number;
        while ((nl = (s as any).buf.indexOf('\n')) >= 0) {
          const line = (s as any).buf.slice(0, nl);
          (s as any).buf = (s as any).buf.slice(nl + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          record({ t: 'rpc', method: req.method, params: req.params ?? null });
          const hang = join(config, 'fake-hang');
          if (existsSync(hang) && readFileSync(hang, 'utf8').trim() === String(process.pid)) continue;
          try {
            send(s, { jsonrpc: '2.0', id: req.id, result: handle(req.method, req.params) });
          } catch (e: any) {
            send(s, { jsonrpc: '2.0', id: req.id, error: { code: e.code ?? -1, message: e.message, data: null } });
          }
        }
      },
    },
  });
  const pushDir = join(config, 'fake-push');
  mkdirSync(pushDir, { recursive: true });
  setInterval(() => {
    for (const f of readdirSync(pushDir).sort()) {
      if (!conns.size) return; // on-connection: only deliver while someone listens
      const p = join(pushDir, f);
      const params = JSON.parse(readFileSync(p, 'utf8'));
      rmSync(p);
      for (const s of conns) send(s, { jsonrpc: '2.0', method: 'receive', params });
    }
    const exitFile = join(config, 'fake-exit');
    if (existsSync(exitFile)) {
      const code = Number(readFileSync(exitFile, 'utf8').trim() || 3);
      rmSync(exitFile);
      console.error('ERROR fake: simulated crash');
      process.exit(code);
    }
  }, 20);
} else if (!sub) {
  console.error('fake: unsupported command ' + args.join(' '));
  process.exit(1);
}

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Categorizer, KeywordProvider, OllamaProvider, type CategoryProvider } from './categorize.ts';
import { ActivityStore } from './activity.ts';
import { Attention } from './attention.ts';
import { applyDemoOverlay, createDemoAccounts, demoFactory } from './demo.ts';
import { PushService } from './push.ts';
import { ReadQueue } from './readqueue.ts';
import { HubServer, mediaSigner } from './server.ts';
import { Store } from './store.ts';
import { Supervisor } from './supervisor.ts';
import { Triage } from './triage.ts';
import { loadVapidKeys } from './webpush.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`) || process.env[`DITHER_${n.toUpperCase()}`] === '1';
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : (process.env[`DITHER_${n.toUpperCase().replace(/-/g, '_')}`] ?? d);
};

const repoRoot = resolve(import.meta.dir, '../../..');
// A demo world is its own hub with its own data dir (.data-demo unless told otherwise), never mixed into a real one.
const demo = flag('demo');
const dataDir = resolve(opt('data', join(repoRoot, demo ? '.data-demo' : '.data')));
const port = Number(opt('port', '8460'));
const hostname = opt('host', '0.0.0.0');
const webDist = resolve(opt('web', join(repoRoot, 'packages/web/dist')));
const tlsCert = opt('tls-cert', '');
const tlsKey = opt('tls-key', '');
const tls = tlsCert && tlsKey ? { cert: resolve(tlsCert), key: resolve(tlsKey), ca: resolve(opt('tls-ca', join(dataDir, 'tls/ca.crt'))) } : undefined;
const plainPort = Number(opt('plain-port', String(port + 1)));

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const secretPath = join(dataDir, 'hub-secret');
if (!existsSync(secretPath)) writeFileSync(secretPath, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), { mode: 0o600 });
chmodSync(secretPath, 0o600);
const secret = readFileSync(secretPath, 'utf8').trim();

const store = new Store(join(dataDir, 'hub.sqlite'), mediaSigner(secret));
const model = process.env.DITHER_TRIAGE_MODEL
  ? { url: process.env.DITHER_OLLAMA_URL ?? 'http://127.0.0.1:11434', name: process.env.DITHER_TRIAGE_MODEL }
  : undefined;
// The activity log (docs/activity.md). DITHER_ACTIVITY_FEATURES=1 lets triage see what it says, as reasons only.
const activity = new ActivityStore(store, { featuresInTriage: args.includes('--activity-features') || process.env.DITHER_ACTIVITY_FEATURES === '1' });
activity.prune(Date.now(), true);
const triage = new Triage(store, model, activity);
const attention = new Attention(store, triage);
attention.activity = activity;

// Triage runs serially so notifications keep message order.
let queue = Promise.resolve();
function triageLater(ids: string[]) {
  queue = queue.then(async () => {
    for (const id of ids) {
      const d = await triage.decide(id).catch((e) => (console.error('triage failed', e), null));
      if (!d) continue;
      store.setTriage(id, d);
      if (d.features) activity.keepInputs(id, d.features);
      store.dirty.messages.set(id, true);
      attention.triaged(id, d);
      if (d.decision === 'push') {
        const conversationId = store.one<{ conversation_id: string }>('SELECT conversation_id FROM message WHERE id = ?', id)!.conversation_id;
        deliver(d.title, d.body, conversationId, id, d.reasons, server.replyFields(conversationId, id), 'message');
      }
    }
  });
}

/** Each one gets an id the devices see (`nid`), so what they say happened to it lands in the activity log. */
function deliver(title: string, body: string, conversationId: string, messageId: string, reasons: string[], pushExtra: Record<string, unknown> = {}, kind: 'message' | 'held' = 'held') {
  const nid = activity.notification({ kind, messageId, conversationId });
  server.notify({ t: 'notify', messageId, conversationId, title, body, reasons, ...(nid ? { nid } : {}) });
  push
    .notify(title, body, conversationId, nid ? { ...pushExtra, nid } : pushExtra)
    .then((r) => nid && activity.sent(nid, r))
    .catch((e) => console.error('push failed', e));
}

/** About the inbox, not a conversation: a click opens the inbox. */
function deliverDigest(title: string, body: string) {
  const nid = activity.notification({ kind: 'digest' });
  server.notify({ t: 'notify', title, body, reasons: ['Your daily digest'], ...(nid ? { nid } : {}) });
  push
    .notify(title, body, undefined, nid ? { inbox: true, nid } : { inbox: true })
    .then((r) => nid && activity.sent(nid, r))
    .catch((e) => console.error('push failed', e));
}

setInterval(() => {
  // First: when both are due, the digest counts what was held and clears it.
  const digest = triage.takeDailyDigest();
  if (digest) deliverDigest(digest.title, digest.body);
  const held = triage.takeHeldSummary();
  if (held) deliver(held.title, held.body, held.conversationId, held.messageId, ['Quiet hours ended']);
}, 60_000);

const push = new PushService(store, loadVapidKeys(dataDir), process.env.DITHER_PUSH_SUBJECT ?? process.env.DITHER_PUBLIC_URL ?? 'https://github.com/libdither/dither-chat');

function categoryProvider(): CategoryProvider {
  const name = process.env.DITHER_CATEGORY_MODEL;
  if (!name) return new KeywordProvider();
  try {
    return new OllamaProvider(process.env.DITHER_OLLAMA_URL ?? 'http://127.0.0.1:11434', name);
  } catch (e) {
    console.error(`categories: ${(e as Error).message}; using keywords`);
    return new KeywordProvider();
  }
}
const categorizer = new Categorizer(store, categoryProvider());
store.categoryProvider = categorizer.provider.id;

const sup = new Supervisor(store, {
  hubAdapterUrl: `ws://127.0.0.1:${tls ? plainPort : port}/adapter`,
  dataDir,
  repoRoot,
  inproc: demoFactory,
  onFresh: triageLater,
});

const readQueue = new ReadQueue(store, sup);
readQueue.start();

const server = new HubServer(store, sup, triage, {
  port,
  hostname,
  dataDir,
  webDist,
  secret,
  tls,
  plainPort,
  push,
  readQueue,
  onCategoriesChanged: (force) => void categorizer.refresh(force),
  attention,
  activity,
  turn: process.env.DITHER_TURN_URLS && process.env.DITHER_TURN_SECRET ? { urls: process.env.DITHER_TURN_URLS.split(',').map((u) => u.trim()), secret: process.env.DITHER_TURN_SECRET } : undefined,
  onDemoReset: !demo ? undefined : async () => {
    for (const a of store.accounts().filter((a) => a.demo)) {
      await sup.stop(a.id);
      store.deleteAccount(a.id);
    }
    store.db.query(`DELETE FROM meta WHERE key = 'demo_overlay'`).run();
    for (const a of createDemoAccounts(store)) sup.start(a.id);
    applyDemoOverlay(store);
  },
});

const realAccounts = store.accounts().filter((a) => !a.demo);
if (demo && realAccounts.length) {
  console.error(`--demo: ${dataDir} holds real accounts. A demo world needs its own data dir: pass --data <dir> (default .data-demo).`);
  process.exit(1);
}
if (!demo && realAccounts.length) {
  // A real hub carries no demo world. Older hubs mixed them; removing the accounts also drops what only they saw.
  for (const a of store.accounts().filter((a) => a.demo)) {
    store.deleteAccount(a.id);
    console.log(`removed demo account ${a.id}: demo worlds now run as their own hub (--demo)`);
  }
  store.db.query(`DELETE FROM meta WHERE key = 'demo_overlay'`).run();
}
if (demo && !store.accounts().some((a) => a.demo)) createDemoAccounts(store);
sup.startAll();
if (store.accounts().some((a) => a.demo)) applyDemoOverlay(store);
server.start();
attention.start((events) => server.broadcast(events));
// Scores live in memory and were worked out afresh: a client resuming from before this start takes the whole list.
server.broadcast([{ t: 'attention', items: attention.list(), removed: [], replace: true }]);
if (store.journal.started === 'unclean') console.log('sync: the hub did not stop cleanly last time; clients start over with a full bootstrap');
// New servers and renamed channels turn up whenever an adapter says so; unchanged places cost a hash.
void categorizer.refresh();
setInterval(() => void categorizer.refresh(), 5 * 60_000);
console.log(`dither-chat hub on ${tls ? 'https' : 'http'}://${hostname}:${port}${tls ? ` (plain http on ${plainPort}: adapters, CA download)` : ''}  data=${dataDir}`);

const shutdown = async () => {
  attention.stop();
  server.stop();
  await sup.stopAll();
  // What stopping changed is in the journal too; then the next start can trust it (journal.ts).
  server.flush();
  store.journal.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

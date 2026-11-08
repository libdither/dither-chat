import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Categorizer, JevProvider, KeywordProvider, OllamaProvider, type CategoryProvider } from './categorize.ts';
import { ActivityStore } from './activity.ts';
import { Attention } from './attention.ts';
import { InboxRanker, rankMode } from './ranker.ts';
import { applyDemoOverlay, createDemoAccounts, DEMO_MAIL_ACCOUNT, demoFactory, seedDemoMail } from './demo.ts';
import { FakeMailBackend, MailHub, ManagerMailBackend } from './mail/index.ts';
import { mailPeople } from './mail/people.ts';
import { Delivery } from './delivery.ts';
import { Devices } from './devices.ts';
import { Embeddings, Jev } from './embeddings.ts';
import { PushService } from './push.ts';
import { ReadQueue } from './readqueue.ts';
import { HubServer, mediaSigner } from './server.ts';
import { Store } from './store.ts';
import { RoutedSupervisor } from './remote.ts';
import { Supervisor } from './supervisor.ts';
import { Triage } from './triage.ts';
import { TriageVotes } from './votes.ts';
import { loadVapidKeys } from './webpush.ts';
import { NightlyBackup, pruneMediaCache, rotateAdapterLogs, tightenPermissions } from './housekeeping.ts';

// Everything the hub writes is its user's alone: the database holds every message.
process.umask(0o077);
// One stray throw must not take the hub down. systemd would restart it, but every client would then start over with a
// full download, and what was queued would wait for the next start. Log it and carry on.
process.on('uncaughtException', (e) => console.error('uncaught exception (the hub keeps running)', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection (the hub keeps running)', e));

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
for (const p of tightenPermissions(dataDir)) console.log(`made ${p} private to this user`);
const secretPath = join(dataDir, 'hub-secret');
if (!existsSync(secretPath)) writeFileSync(secretPath, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), { mode: 0o600 });
chmodSync(secretPath, 0o600);
const secret = readFileSync(secretPath, 'utf8').trim();

const store = new Store(join(dataDir, 'hub.sqlite'), mediaSigner(secret));
// What the last run left undecided, before this run's adapters add their own (decided once the server is up).
const leftover = store.takePendingTriage(Date.now() - 30 * 60_000);
const model = process.env.DITHER_TRIAGE_MODEL
  ? { url: process.env.DITHER_OLLAMA_URL ?? 'http://127.0.0.1:11434', name: process.env.DITHER_TRIAGE_MODEL }
  : undefined;
// The activity log (docs/activity.md). DITHER_ACTIVITY_FEATURES=1 lets triage see what it says, as reasons only.
const activity = new ActivityStore(store, { featuresInTriage: args.includes('--activity-features') || process.env.DITHER_ACTIVITY_FEATURES === '1' });
activity.prune(Date.now(), true);
const triage = new Triage(store, model, activity);
const votes = new TriageVotes(store, triage);
const attention = new Attention(store, triage);
// The inbox's learned order (ranker.ts, docs/inbox.md). DITHER_INBOX_RANK=shadow works it out without sorting by it; off.
const ranker = new InboxRanker(store, triage, rankMode(process.env.DITHER_INBOX_RANK), join(dataDir, 'hub.sqlite'));
attention.judge = ranker;
// Per-device notification rules (docs/devices.md).
const devices = new Devices(store, triage);
// One notification per conversation, buzzing once a burst (docs/notifications.md).
const delivery = new Delivery(store, triage);
attention.activity = activity;
// Message embeddings and jev's answers as content features (docs/embeddings.md): made in the background, never blocking.
const embeddings = flag('embeddings') ? new Embeddings(store.db, join(dataDir, 'embeddings.sqlite'), { jev: new Jev(process.env.DITHER_JEV_URL ?? 'http://127.0.0.1:7862') }) : null;
embeddings?.start();
// The shadow model weighs them (votes.ts); the live decision does not.
if (embeddings) triage.content = (id) => embeddings.features(id, 'ping');

// Triage runs serially so notifications keep message order. Each message waits in triage_pending until it is decided,
// so one a crash or restart caught in the queue is decided at the next start (below, after the server starts).
let queue = Promise.resolve();
function triageLater(ids: string[]) {
  store.pendTriage(ids);
  queue = queue.then(() => triageNow(ids)).catch((e) => console.error('triage queue', e));
}
async function triageNow(ids: string[]) {
  // The new messages' content features, if jev answers quickly; else triage goes on without them (embeddings.ts
  // stops waiting for a minute after jev was slow, so a hung jev cannot hold notifications up).
  await embeddings?.prepare(ids, 800).catch(() => {});
  for (const id of ids) {
    try {
      const d = await triage.decide(id);
      if (!d) continue;
      // The message may have gone while it was decided (a leave, a deleted account).
      const conversationId = store.one<{ conversation_id: string }>('SELECT conversation_id FROM message WHERE id = ?', id)?.conversation_id;
      if (!conversationId) continue;
      store.setTriage(id, d, d.facts);
      if (d.features) activity.keepInputs(id, d.features);
      store.dirty.messages.set(id, true);
      attention.triaged(id, d);
      if (d.decision === 'push' || d.decision === 'quiet') deliver(d.title, d.body, conversationId, id, d.reasons, server.replyFields(conversationId, id), 'message', d.decision);
    } catch (e) {
      console.error('triage failed', id, e);
    } finally {
      store.triageDone(id);
    }
  }
}

/** Each one gets an id the devices see (`nid`), so what they say happened to it lands in the activity log. */
/**
 * Important ('push') goes everywhere; Active ('quiet') only to phones, silently, and to open pages as an entry in the
 * list rather than a notification (docs/notifications.md). A message's push carries its level and id, so the
 * notification can be voted up or down from where it shows.
 */
function deliver(title: string, body: string, conversationId: string, messageId: string, reasons: string[], pushExtra: Record<string, unknown> = {}, kind: 'message' | 'held' = 'held', level: 'push' | 'quiet' = 'push') {
  const nid = activity.notification({ kind, messageId, conversationId });
  // Devices whose own rules keep this off them: their push is not sent, and their open pages show no toast.
  const addressed = kind === 'message' && devices.addressed(messageId);
  const quiet = devices.quietOn(conversationId, addressed);
  const skip = level === 'quiet' ? [...quiet, ...push.desktops()] : quiet;
  const look = store.notifyLook(conversationId, kind === 'message' ? messageId : undefined);
  const vote = kind === 'message' ? { messageId, level } : {};
  const grouped = kind === 'message' ? delivery.plan(conversationId, messageId, level, addressed) : null;
  server.notify({ t: 'notify', messageId, conversationId, title, body, reasons, ...look, ...(nid ? { nid } : {}), ...(quiet.length ? { quiet } : {}), ...(level === 'quiet' ? { level } : {}) });
  push
    .notify(title, body, conversationId, { ...pushExtra, ...look, ...vote, ...grouped, ...(nid ? { nid } : {}) }, skip, level)
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

// Read anywhere since its notification went out: off the phones.
setInterval(() => {
  for (const cid of delivery.read()) push.clear(cid).catch((e) => console.error('push clear failed', e));
}, 5_000);

// Upkeep (housekeeping.ts): a nightly copy of the database, the media cache under its size, logs rotated, and triage
// rows nobody learns from let go after 90 days.
const backup = new NightlyBackup({ dataDir, db: join(dataDir, 'hub.sqlite') });
if (!demo) backup.start();
const upkeep = async () => {
  try {
    const m = pruneMediaCache(join(dataDir, 'media-cache'));
    if (m.removed) console.log(`media cache: removed ${m.removed} files, ${Math.round(m.bytes / 1048576)} MB kept`);
    rotateAdapterLogs(join(dataDir, 'accounts'));
    // In batches, with room for everything else between them.
    let gone = 0;
    for (let n = store.pruneTriage(); n > 0; n = store.pruneTriage()) {
      gone += n;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (gone) console.log(`triage: let go of ${gone} rows nobody learns from`);
  } catch (e) {
    console.error('upkeep failed', e);
  }
};
setTimeout(() => void upkeep(), 60_000);
setInterval(() => void upkeep(), 6 * 3_600_000);

setInterval(() => {
  // First: when both are due, the digest counts what was held and clears it.
  const digest = triage.takeDailyDigest();
  if (digest) deliverDigest(digest.title, digest.body);
  votes.daily();
  const held = triage.takeHeldSummary();
  if (held) deliver(held.title, held.body, held.conversationId, held.messageId, ['Quiet hours ended']);
}, 60_000);

const push = new PushService(store, loadVapidKeys(dataDir), process.env.DITHER_PUSH_SUBJECT ?? process.env.DITHER_PUBLIC_URL ?? 'https://github.com/libdither/dither-chat');

/**
 * jev, the machine's reranker, unless DITHER_CATEGORY_MODEL says otherwise ("keyword", or an Ollama model name). A demo
 * hub keeps to keywords so its world is the same every time.
 */
function categoryProvider(): CategoryProvider {
  const name = process.env.DITHER_CATEGORY_MODEL ?? (demo ? 'keyword' : 'jev');
  if (name === 'keyword') return new KeywordProvider();
  try {
    if (name === 'jev') return new JevProvider(process.env.DITHER_JEV_URL ?? 'http://127.0.0.1:7862');
    return new OllamaProvider(process.env.DITHER_OLLAMA_URL ?? 'http://127.0.0.1:11434', name);
  } catch (e) {
    console.error(`categories: ${(e as Error).message}; using keywords`);
    return new KeywordProvider();
  }
}
const categorizer = new Categorizer(store, categoryProvider());
store.categoryProvider = categorizer.provider.id;

const supOpts = {
  hubAdapterUrl: `ws://127.0.0.1:${tls ? plainPort : port}/adapter`,
  dataDir,
  repoRoot,
  inproc: demoFactory,
  onFresh: triageLater,
};
// dither-accounts (docs/accounts.md): the accounts its manager runs come through it; the rest run here as always.
const accountsUrl = process.env.DITHER_ACCOUNTS_URL;
const accountsPage = process.env.DITHER_ACCOUNTS_PUBLIC_URL || null;
const sup = accountsUrl && !demo ? new RoutedSupervisor(store, supOpts, { url: accountsUrl, dataDir, repoRoot, publicUrl: accountsPage }) : new Supervisor(store, supOpts);
if (sup instanceof RoutedSupervisor) {
  store.accountsManager = { url: accountsPage };
  store.accountManaged = (id) => sup.managed(id);
}

// Mail (docs/mail.md): through dither-accounts' mail interface, or a fake account in a demo world; off otherwise.
const demoMail = demo ? new FakeMailBackend() : null;
const mailBackend = demoMail ?? (sup instanceof RoutedSupervisor ? new ManagerMailBackend({ callRaw: (a, op, input, t) => sup.callMail(a, op, input, t), askMailAgain: () => sup.askMailAgain() }) : null);
if (sup instanceof RoutedSupervisor && mailBackend instanceof ManagerMailBackend) sup.mail = mailBackend;
// A manager on this machine reads attachments from the outbox's folder; one elsewhere gets their bytes.
if (mailBackend instanceof ManagerMailBackend) mailBackend.localFiles = /^(?:https?|wss?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(accountsUrl ?? '');
const mail = new MailHub({ db: store.db, backend: mailBackend, managerUrl: accountsPage, dataDir });
// Correspondents become identities and persons (mail/people.ts).
mailPeople(mail)?.connect(store);

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
  probeCategory: (question) => categorizer.probe(question),
  attention,
  activity,
  devices,
  votes,
  archiveMedia: !demo,
  mail,
  turn: process.env.DITHER_TURN_URLS && process.env.DITHER_TURN_SECRET ? { urls: process.env.DITHER_TURN_URLS.split(',').map((u) => u.trim()), secret: process.env.DITHER_TURN_SECRET } : undefined,
  onDemoReset: !demo ? undefined : async () => {
    for (const a of store.accounts().filter((a) => a.demo)) {
      await sup.stop(a.id);
      store.deleteAccount(a.id);
    }
    store.db.query(`DELETE FROM meta WHERE key = 'demo_overlay'`).run();
    for (const a of createDemoAccounts(store)) sup.start(a.id);
    applyDemoOverlay(store);
    if (demoMail) {
      demoMail.removeAccount(DEMO_MAIL_ACCOUNT);
      mail.deleteNow(DEMO_MAIL_ACCOUNT);
      seedDemoMail(demoMail);
    }
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
// A demo world showing adversarial features from the start (scripts/verify-history.ts): before its history is seeded.
if (demo && flag('adversarial') && !store.retention().adversarial) store.setRetention({ ...store.retention(), adversarial: true, deleted: true, disappearing: true, statuses: true, presence: true, members: true });
if (demo && !store.accounts().some((a) => a.demo)) createDemoAccounts(store);
if (demoMail && !mail.store.account(DEMO_MAIL_ACCOUNT)) seedDemoMail(demoMail);
else if (demoMail) seedDemoMail(demoMail, mail.store.account(DEMO_MAIL_ACCOUNT)!.created_at);
// Before the manager's first account list, so mail hears it.
mail.start();
if (sup instanceof RoutedSupervisor) await sup.connectOrRetry();
sup.startAll();
if (store.accounts().some((a) => a.demo)) applyDemoOverlay(store);
server.start();
attention.start((events) => server.broadcast(events));
ranker.onFit = () => server.broadcast(attention.rescoreAll());
ranker.start();
// Scores live in memory and were worked out afresh: a client resuming from before this start takes the whole list.
server.broadcast([{ t: 'attention', items: attention.list(), removed: [], replace: true }]);
if (store.journal.started === 'unclean') console.log('sync: the hub did not stop cleanly last time; clients start over with a full bootstrap');
// Messages a crash or restart left undecided (taken before any adapter started): those from the last half hour still
// get their notification.
if (leftover.length) {
  console.log(`triage: deciding ${leftover.length} messages left over from before this start`);
  triageLater(leftover);
}
// New servers and renamed channels turn up whenever an adapter says so; unchanged places cost a hash.
void categorizer.refresh();
setInterval(() => void categorizer.refresh(), 5 * 60_000);
console.log(`dither-chat hub on ${tls ? 'https' : 'http'}://${hostname}:${port}${tls ? ` (plain http on ${plainPort}: adapters, CA download)` : ''}  data=${dataDir}`);

const shutdown = async () => {
  // What is being triaged finishes first (a few seconds at most); the rest waits in triage_pending for the next start.
  await Promise.race([queue, new Promise((r) => setTimeout(r, 5_000))]);
  backup.stop();
  ranker.stop();
  attention.stop();
  mail.stop();
  embeddings?.close();
  server.stop();
  await sup.stopAll();
  // What stopping changed is in the journal too; then the next start can trust it (journal.ts).
  server.flush();
  store.journal.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

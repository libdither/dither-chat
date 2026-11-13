import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Categorizer, JevProvider, KeywordProvider, OllamaProvider, type CategoryProvider } from './categorize.ts';
import { ActivityStore } from './activity.ts';
import { Attention } from './attention.ts';
import { exploreOn, InboxRanker, rankMode } from './ranker.ts';
import { applyDemoOverlay, createDemoAccounts, DEMO_MAIL_ACCOUNT, demoFactory, seedDemoMail } from './demo.ts';
import { demoMailImages } from './mail/demo-html.ts';
import { FakeMailBackend, MailHub, ManagerMailBackend } from './mail/index.ts';
import { mailPeople } from './mail/people.ts';
import { mailAttention } from './mail/attention.ts';
import { mailTriage, type MailNotice } from './mail/triage.ts';
import { Delivery } from './delivery.ts';
import { Notifier } from './notify.ts';
import { listByPrior, PhoneList, phoneListMode } from './phonelist.ts';
import { RequestNotifier, requestChain, type RequestNotice } from './requestnotify.ts';
import { Devices } from './devices.ts';
import { Embeddings, Jev } from './embeddings.ts';
import { PushService } from './push.ts';
import { ReadQueue } from './readqueue.ts';
import { HubServer, mediaSigner } from './server.ts';
import { Store } from './store.ts';
import { RoutedSupervisor } from './remote.ts';
import { Supervisor } from './supervisor.ts';
import { STOP_QUESTION, Triage, URGENT, type Judge } from './triage.ts';
import { TriageVotes } from './votes.ts';
import { loadVapidKeys } from './webpush.ts';
import { NightlyBackup, pruneMediaCache, rotateAdapterLogs, tightenPermissions } from './housekeeping.ts';
import { StartupTrace } from './startup.ts';
import { noteWork, StallWatch } from './stalls.ts';
import { CalendarLink, calendarChain, calendarUrl, ReminderDelivery, REMINDER_RULE_ID } from './calendar.ts';
import { inQuietHours } from './triage.ts';
import { onRing, ringMuted, ringWords, sweepCalls } from './callstate.ts';

// Each part of the start, logged in one line once requests are answered (startup.ts).
const startup = new StartupTrace();
startup.mark('code');

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
startup.mark('data dir');

const store = new Store(join(dataDir, 'hub.sqlite'), mediaSigner(secret));
startup.add(store.opening);
// What the last run left undecided, before this run's adapters add their own (decided once the server is up).
const leftover = store.takePendingTriage(Date.now() - 30 * 60_000);
// The activity log (docs/activity.md). DITHER_ACTIVITY_FEATURES=1 lets triage see what it says, as reasons only.
const activity = new ActivityStore(store, { featuresInTriage: args.includes('--activity-features') || process.env.DITHER_ACTIVITY_FEATURES === '1' });
activity.prune(Date.now(), true);
startup.mark('activity log');
const triage = new Triage(store, activity);
const votes = new TriageVotes(store, triage);
const attention = new Attention(store, triage);
// The inbox's learned order (ranker.ts, docs/inbox.md). DITHER_INBOX_RANK=shadow works it out without sorting by it; off.
// DITHER_INBOX_EXPLORE=0 sorts by its mean instead of a Thompson sample.
const ranker = new InboxRanker(store, triage, rankMode(process.env.DITHER_INBOX_RANK), join(dataDir, 'hub.sqlite'), Date.now, exploreOn(process.env.DITHER_INBOX_EXPLORE));
attention.judge = ranker;
// The learned order learns from rows weighed as the inbox weighs them now.
ranker.owedTable = () => attention.owedTable;
// Per-device notification rules (docs/devices.md).
const devices = new Devices(store, triage);
// One notification per conversation, buzzing once a burst (docs/notifications.md).
const delivery = new Delivery(store, triage);
// New requests from someone you know notify once (docs/add.md "Requests").
const requestNotices = new RequestNotifier(store);
devices.otherChain = (id) => otherChain(id);
/**
 * Rule keys for what is not a chat conversation: a request (its account, its network), a calendar reminder (the
 * calendar as a network of its own, `network:calendar`), a mail thread once mail is on (below).
 */
let mailChain: ((id: string) => string[] | null) | null = null;
function otherChain(id: string): string[] | null {
  if (id.startsWith('req_')) return requestChain(store.db, id);
  return calendarChain(id) ?? mailChain?.(id) ?? null;
}
attention.activity = activity;
// Message embeddings and jev's answers as content features (docs/embeddings.md): made in the background, never blocking.
const embeddings = flag('embeddings') ? new Embeddings(store.db, join(dataDir, 'embeddings.sqlite'), { jev: new Jev(process.env.DITHER_JEV_URL ?? 'http://127.0.0.1:7862') }) : null;
embeddings?.start();
// The shadow model weighs them (votes.ts); the live decision does not.
if (embeddings) triage.content = (id) => embeddings.features(id, 'important');
// What reads a message that may alert (docs/notifications.md): jev, the machine's local model, unless
// DITHER_ALERT_MODEL says otherwise: `keyword` (a demo hub's: urgent words) or `off` (only your rules alert).
triage.judge = alertJudge();
// Who wrote when, for the Conversation rule: folded now, not when the first message arrives.
triage.warm();
function alertJudge(): Judge | null {
  const name = process.env.DITHER_ALERT_MODEL ?? (demo ? 'keyword' : 'jev');
  if (name === 'off') return null;
  if (name === 'keyword') return async (text) => (URGENT.test(text) ? 0.6 : 0.01);
  try {
    const jev = new Jev(process.env.DITHER_JEV_URL ?? 'http://127.0.0.1:7862', 10_000);
    return async (text) => (await jev.judge(STOP_QUESTION, [text]))[0] ?? null;
  } catch (e) {
    console.error(`alerts: ${(e as Error).message}; only your rules alert`);
    return null;
  }
}
startup.mark('models');

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
    let done = false;
    try {
      noteWork('triage');
      const d = await triage.decide(id);
      if (!d) continue;
      // The message may have gone while it was decided (a leave, a deleted account).
      const conversationId = store.one<{ conversation_id: string }>('SELECT conversation_id FROM message WHERE id = ?', id)?.conversation_id;
      if (!conversationId) continue;
      // What the decision writes, in one commit rather than four: each commit waits for the disk, and on a busy
      // machine that wait holds the hub.
      store.db.transaction(() => {
        store.setTriage(id, d, d.facts);
        if (d.features) activity.keepInputs(id, d.features);
        attention.triaged(id, d);
        store.triageDone(id);
      })();
      done = true;
      store.dirty.messages.set(id, true);
      if (d.decision === 'push' || d.decision === 'quiet' || d.decision === 'digest') deliver(d.title, d.body, conversationId, id, d.reasons, server.replyFields(conversationId, id), 'message', d.decision, d.score, listByPrior(d.facts));
      // The local model was too slow: the message went out silent, and is read again once it has had time.
      if (d.unjudged) setTimeout(() => void judgeLate(id), LATE_JUDGE_MS);
    } catch (e) {
      console.error('triage failed', id, e);
    } finally {
      if (!done) store.triageDone(id);
    }
  }
}

/** How long after a decision the local model could not read in time it is asked again. */
const LATE_JUDGE_MS = 20_000;
/** A message the local model was too slow for, read again: if it is an alert after all, it goes out as one. */
async function judgeLate(id: string) {
  try {
    const was = store.one<{ decision: string }>('SELECT decision FROM triage WHERE message_id = ?', id)?.decision;
    const conversationId = store.one<{ conversation_id: string }>('SELECT conversation_id FROM message WHERE id = ?', id)?.conversation_id;
    if (!conversationId || was === 'push' || was === 'silent') return;
    const d = await triage.decide(id);
    if (!d || d.unjudged || d.decision !== 'push') return;
    store.setTriage(id, d, d.facts);
    store.dirty.messages.set(id, true);
    attention.triaged(id, d);
    deliver(d.title, d.body, conversationId, id, d.reasons, server.replyFields(conversationId, id), 'message', 'push', d.score);
  } catch (e) {
    console.error('late alert check failed', id, e);
  }
}

/** Chat's and mail's notifications (notify.ts), through the phone's list (phonelist.ts). Made once push and server are. */
let notifier: Notifier | null = null;
const deliver: Notifier['message'] = (...a) => notifier?.message(...a);
const deliverMail = (n: MailNotice) => notifier?.mail(n);

/** A request's row on the list sorts as something the network would have notified you about. */
const REQUEST_IMPORTANCE = 0.8;
/**
 * A new request from someone you know (requestnotify.ts, docs/add.md): a silent row on the phone's list and nothing
 * on a computer, opening the request under Requests. Device rules for its account or network keep it off.
 */
function deliverRequest(n: RequestNotice) {
  const nid = activity.notification({ kind: 'request' });
  const quiet = devices.quietOn(n.requestId, false);
  const look = { network: n.network, ...(n.icon ? { icon: n.icon } : {}) };
  server.notify({ t: 'notify', requestId: n.requestId, title: n.title, body: n.body, reasons: [n.reason], level: 'digest', ...look, ...(nid ? { nid } : {}), ...(quiet.length ? { quiet } : {}) });
  push
    .notify(n.title, n.body, undefined, { ...look, requestId: n.requestId, level: 'quiet', tier: 'digest', importance: REQUEST_IMPORTANCE, ...(nid ? { nid } : {}) }, [...quiet, ...push.desktops()], 'quiet')
    .then((r) => nid && activity.sent(nid, r))
    .catch((e) => console.error('push failed', e));
}

/**
 * A calendar reminder (calendar.ts, docs/calendar.md): an alert that sounds on every device, or held quiet (phones only,
 * silent) in quiet hours. Device rules on `network:calendar` keep it off a device. Not part of quiet hours' summary.
 */
const reminders = new ReminderDelivery({
  inQuietHours: (now) => inQuietHours(store.quietHours(), now),
  quietDevices: () => devices.quietOn(REMINDER_RULE_ID, false),
  desktops: () => push.desktops(),
  notification: () => activity.notification({ kind: 'reminder' }),
  sent: (nid, r) => activity.sent(nid, r),
  notify: (ev) => server.notify(ev),
  push: (title, body, extra, skip, level) => push.notify(title, body, undefined, extra, skip, level),
});

/**
 * A call ringing you (callstate.ts, docs/calls.md "Ringing"): once, as an alert that sounds on every device, with
 * Answer and Decline; taken back from the devices that can take it back (the Android app) when it stops ringing.
 * Quiet hours, a mute that covers it and device rules keep it off; the ring card in open pages shows either way.
 */
onRing(store, (n) => {
  const c = n.call;
  const tag = `call:${c.id}`;
  if (n.kind === 'stop') {
    push.clear(tag).catch((e) => console.error('push clear failed', e));
    return;
  }
  if (ringMuted(store, c) || inQuietHours(store.quietHours(), Date.now())) return;
  const { title, body } = ringWords(store, c);
  const look = store.notifyLook(c.conversationId, undefined);
  const call = { id: c.id, tag, canAnswer: c.canAnswer, canDecline: c.canDecline };
  push.notify(title, body, c.conversationId, { ...look, call, level: 'push', tier: 'push' }, devices.quietOn(c.conversationId, false), 'push').catch((e) => console.error('push failed', e));
});

// Read anywhere since its notification went out: off the phones. New requests that settled: judged, once each.
setInterval(() => {
  noteWork('notifications: read and requests');
  for (const cid of delivery.read()) {
    phone.read(cid);
    push.clear(cid).catch((e) => console.error('push clear failed', e));
  }
  // List rows 12 hours old leave the phones; held ones whose chat was read are over (phonelist.ts).
  for (const cid of phone.sweep()) push.clear(cid).catch((e) => console.error('push clear failed', e));
  for (const n of requestNotices.due()) deliverRequest(n);
  // Rings the network left hanging stop, as missed (callstate.ts).
  sweepCalls(store);
}, 5_000);

// Upkeep (housekeeping.ts): a nightly copy of the database, the media cache under its size, logs rotated, and triage
// rows nobody learns from let go after 90 days.
const backup = new NightlyBackup({ dataDir, db: join(dataDir, 'hub.sqlite') });
if (!demo) backup.start();
const upkeep = async () => {
  noteWork('upkeep');
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
  noteWork('votes and held alerts');
  votes.daily();
  const held = triage.takeHeldSummary();
  if (held) deliver(held.title, held.body, held.conversationId, held.messageId, ['Quiet hours ended']);
}, 60_000);

const push = new PushService(store, loadVapidKeys(dataDir), process.env.DITHER_PUSH_SUBJECT ?? process.env.DITHER_PUBLIC_URL ?? 'https://github.com/libdither/dither-chat');
// Which list rows reach the phones (docs/notifications.md, "The phone's list"). DITHER_PHONE_LIST=shadow sends them all
// and logs what it would have held; off, as before it.
const phone = new PhoneList(store.db, { mode: phoneListMode(process.env.DITHER_PHONE_LIST), kept: (now) => triage.marked(now).convs, readTs: (cid) => delivery.readTs(cid) });
activity.noted = (w) => phone.noted(w);
if (phone.mode !== 'on') console.log(`phone list: ${phone.mode} (DITHER_PHONE_LIST)`);

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
startup.mark('categories');

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
// Every mail account keeps all of its mail unless it is turned off for it (mail/keep.ts, docs/mail.md "Keeping all mail").
// A demo world keeps a year, as the verify scripts expect (its receipt only the server finds), unless DITHER_DEMO_MAIL_KEEP.
const keepAll = !demo || !!process.env.DITHER_DEMO_MAIL_KEEP;
const mail = new MailHub({ db: store.db, backend: mailBackend, managerUrl: accountsPage, dataDir, keepAll, media: { dir: join(dataDir, 'media-cache'), key: secret, ...(demoMail ? demoMailImages : {}) } });
// Correspondents become identities and persons (mail/people.ts).
mailPeople(mail)?.connect(store);
// Mail from people in the one-list inbox, scored with the chats (mail/attention.ts).
mailAttention(mail)?.connect(store, attention);
// New mail from people triaged by chat's model, with chat's votes, and notified the same way (mail/triage.ts).
const mailTriaged = mailTriage(mail);
if (mailTriaged) {
  mailTriaged.connect({ store, triage, votes, deliver: (n) => deliverMail(n) });
  mailChain = (id) => mailTriaged.chain(id);
  delivery.other = mailTriaged;
}
// Notifications sent before a restart still leave the phones when their chat is read (delivery.ts).
delivery.restore();

// dither-calendar beside the hub (docs/calendar.md): DITHER_CALENDAR_URL, http://127.0.0.1:8470 by default; `off` or
// empty for none. Never on a demo hub, so check:boot and the verify scripts never reach a live calendar.
const calendarAt = calendarUrl(process.env, demo);
const calendar = calendarAt ? new CalendarLink({ url: calendarAt, broadcast: (evs) => server.broadcast(evs) }) : undefined;

const readQueue = new ReadQueue(store, sup);
readQueue.start();
startup.mark('mail');

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
  calendar,
  onReminder: (n) => reminders.deliver(n),
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

notifier = new Notifier({ store, activity, devices, push, delivery, server, phone });

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
startup.mark('server');
// Before the manager's first account list, so mail hears it.
mail.start();
startup.mark('mail start');
if (sup instanceof RoutedSupervisor) {
  await sup.connectOrRetry();
  startup.mark('accounts manager');
}
sup.startAll();
if (store.accounts().some((a) => a.demo)) applyDemoOverlay(store);
startup.mark('adapters');
server.start();
startup.mark('http listen');
// Every hold-up of the event loop from here on, with what began in it, for the first ten minutes (stalls.ts).
const stalls = new StallWatch().begin();
calendar?.start();
noteWork('attention: first scoring');
attention.start((events) => server.broadcast(events));
ranker.onFit = () => {
  noteWork('attention: rescore all');
  server.broadcast(attention.rescoreAll());
};
ranker.start();
// Scores live in memory and were worked out afresh: a client resuming from before this start takes the whole list.
server.broadcast([{ t: 'attention', items: attention.list(), removed: [], replace: true }]);
startup.mark('attention');
if (store.journal.started === 'unclean') console.log('sync: the hub did not stop cleanly last time; clients start over with a full bootstrap');
// Messages a crash or restart left undecided (taken before any adapter started): those from the last half hour still
// get their notification.
if (leftover.length) {
  console.log(`triage: deciding ${leftover.length} messages left over from before this start`);
  triageLater(leftover);
}
// New servers and renamed channels turn up whenever an adapter says so; unchanged places cost a hash.
void categorizer.refresh();
setInterval(() => {
  noteWork('categories');
  void categorizer.refresh();
}, 5 * 60_000);
console.log(`dither-chat hub on ${tls ? 'https' : 'http'}://${hostname}:${port}${tls ? ` (plain http on ${plainPort}: adapters, CA download)` : ''}  data=${dataDir}${calendarAt ? `  calendar=${calendarAt}` : ''}`);
startup.mark('the rest');
// Ready once the event loop is free to answer: what the start queued (adapters starting, the first refresh) runs first.
setTimeout(() => {
  startup.mark('queued work');
  console.log(startup.line());
});

const shutdown = async () => {
  // What is being triaged finishes first (a few seconds at most); the rest waits in triage_pending for the next start.
  await Promise.race([queue, new Promise((r) => setTimeout(r, 5_000))]);
  backup.stop();
  stalls.stop();
  ranker.stop();
  attention.stop();
  mail.stop();
  calendar?.stop();
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

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Categorizer, KeywordProvider, OllamaProvider, type CategoryProvider } from './categorize.ts';
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
const dataDir = resolve(opt('data', join(repoRoot, '.data')));
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
const triage = new Triage(store, model);

// Triage runs serially so notifications keep message order.
let queue = Promise.resolve();
function triageLater(ids: string[]) {
  queue = queue.then(async () => {
    for (const id of ids) {
      const d = await triage.decide(id).catch((e) => (console.error('triage failed', e), null));
      if (!d) continue;
      store.setTriage(id, d);
      store.dirty.messages.set(id, true);
      if (d.decision === 'push') {
        const conversationId = store.one<{ conversation_id: string }>('SELECT conversation_id FROM message WHERE id = ?', id)!.conversation_id;
        deliver(d.title, d.body, conversationId, id, d.reasons);
      }
    }
  });
}

function deliver(title: string, body: string, conversationId: string, messageId: string, reasons: string[]) {
  server.notify({ t: 'notify', messageId, conversationId, title, body, reasons });
  ntfy(title, body, conversationId).catch(() => {});
  push.notify(title, body, conversationId, { messageId }).catch((e) => console.error('push failed', e));
}

/** About the inbox, not a conversation: a click opens the inbox. */
function deliverDigest(title: string, body: string) {
  server.notify({ t: 'notify', title, body, reasons: ['Your daily digest'] });
  ntfy(title, body).catch(() => {});
  push.notify(title, body, undefined, { inbox: true }).catch((e) => console.error('push failed', e));
}

setInterval(() => {
  // First: when both are due, the digest counts what was held and clears it.
  const digest = triage.takeDailyDigest();
  if (digest) deliverDigest(digest.title, digest.body);
  const held = triage.takeHeldSummary();
  if (held) deliver(held.title, held.body, held.conversationId, held.messageId, ['Quiet hours ended']);
}, 60_000);

/** Optional phone push through a self-hosted ntfy topic (off unless DITHER_NTFY_URL is set). */
async function ntfy(title: string, body: string, conversationId?: string) {
  const url = process.env.DITHER_NTFY_URL;
  if (!url) return;
  const headers: Record<string, string> = { Title: title, Tags: 'speech_balloon' };
  if (process.env.DITHER_NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.DITHER_NTFY_TOKEN}`;
  if (process.env.DITHER_PUBLIC_URL) headers.Click = `${process.env.DITHER_PUBLIC_URL}/#/inbox${conversationId ? `/c/${conversationId}` : ''}`;
  await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(5000) });
}

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
  onDemoReset: async () => {
    for (const a of store.accounts().filter((a) => a.demo)) {
      await sup.stop(a.id);
      store.deleteAccount(a.id);
    }
    store.db.query(`DELETE FROM meta WHERE key = 'demo_overlay'`).run();
    for (const a of createDemoAccounts(store)) sup.start(a.id);
    applyDemoOverlay(store);
  },
});

if (flag('demo') && !store.accounts().some((a) => a.demo)) createDemoAccounts(store);
sup.startAll();
if (store.accounts().some((a) => a.demo)) applyDemoOverlay(store);
server.start();
// New servers and renamed channels turn up whenever an adapter says so; unchanged places cost a hash.
void categorizer.refresh();
setInterval(() => void categorizer.refresh(), 5 * 60_000);
console.log(`dither-chat hub on ${tls ? 'https' : 'http'}://${hostname}:${port}${tls ? ` (plain http on ${plainPort}: adapters, CA download)` : ''}  data=${dataDir}`);

const shutdown = async () => {
  server.stop();
  await sup.stopAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

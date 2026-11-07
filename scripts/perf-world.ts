/**
 * A demo world grown to the live hub's proportions, for scripts/verify-perf.ts (docs/perf.md).
 *
 * As of 2026-11 the live hub holds about 5,600 conversations (4,500 channels, most with nothing stored), 11,500
 * identities, 1,200 spaces and 675k messages, a fifth of them from the last week and triaged; per conversation with
 * messages p50 12, p90 290, and a few with tens of thousands. 900 conversations have something unread.
 *
 * Synthetic text only, and the same world every run: a fixed random seed, and times counted back from the last
 * midnight, so day lines and "Today" fall the same way whatever the hour. Places, people and read state go through
 * Store.ingest; messages and their triage are written in bulk, which takes seconds rather than minutes.
 *
 *   import { seedWorld } from './perf-world.ts'; seedWorld(dir)   (a fresh dir; the hub then runs on it with --demo)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hubId } from '@dither-chat/protocol/ids';
import type * as P from '@dither-chat/protocol';
import { createDemoAccounts } from '../packages/hub/src/demo.ts';
import { Store } from '../packages/hub/src/store.ts';

export interface WorldConv {
  id: string;
  nativeId: string;
  accountId: string;
  messages: number;
  /** A native identity id that writes there, for a live message from someone else. */
  member: string;
}
export interface World {
  /** The conversations the benchmark opens: the two biggest channels, the biggest direct and group, a channel of a few thousand, a direct of a few dozen. */
  open: WorldConv[];
  counts: Record<string, number>;
  ms: number;
}

const DAY = 86_400_000;
const WORDS =
  'the a sync hub message build deploy cache timeline render sidebar snapshot index query page phone socket worker emoji thread reply ping latency bundle chunk paint layout frame scroll list channel server people group direct tonight later maybe yes no ok'.split(
    ' ',
  );

export function seedWorld(dir: string, opts: { scale?: number } = {}): World {
  const scale = opts.scale ?? 1;
  const t0 = performance.now();
  if (existsSync(join(dir, 'hub.sqlite'))) throw new Error(`${dir} already has a hub: seed a fresh dir`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Nothing seeded here has media to sign; the hub signs with its own secret when it runs.
  const store = new Store(join(dir, 'hub.sqlite'), () => null);
  // The whole world fits in memory: without this, the bulk insert spends most of its time paging.
  store.db.exec('PRAGMA cache_size = -262144; PRAGMA synchronous = OFF;');
  const accounts = createDemoAccounts(store);
  const disc = accounts.find((a) => a.id === 'acc_demo-discord-main')!;
  const sig = accounts.find((a) => a.id === 'acc_demo-signal')!;

  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: T[]) => xs[int(xs.length)];
  const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const n = (x: number) => Math.max(1, Math.round(x * scale));

  // The last midnight, less a minute: the newest seeded message is "yesterday, 23:59" whenever this runs.
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const anchor = midnight.getTime() - 60_000;

  const ingest = (acc: typeof disc, ev: P.AdapterEvent) => store.ingest(acc, ev);
  const self = { disc: 'self-d', sig: 'self-s' };
  type Place = { acc: typeof disc; conv: string; members: string[]; rooms: string[] };

  const places = store.db.transaction(() => {
    ingest(disc, { t: 'identity', identity: { nativeId: self.disc, displayName: 'You', handle: 'you', isSelf: true } });
    ingest(sig, { t: 'identity', identity: { nativeId: self.sig, displayName: 'You', handle: '+15550000000', isSelf: true } });
    // People: 500 contacts across Discord and Signal, 11,000 strangers in Discord servers.
    const contacts: { acc: typeof disc; id: string }[] = [];
    for (let i = 0; i < n(500); i++) {
      const acc = i % 3 === 0 ? sig : disc;
      contacts.push({ acc, id: `pc${i}` });
      ingest(acc, { t: 'identity', identity: { nativeId: `pc${i}`, displayName: `Contact ${i}`, handle: `contact${i}`, contact: true } });
    }
    const strangers: string[] = [];
    for (let i = 0; i < n(11_000); i++) {
      strangers.push(`ps${i}`);
      ingest(disc, { t: 'identity', identity: { nativeId: `ps${i}`, displayName: `Member ${i}`, handle: `member${i}` } });
    }
    // 166 servers, six categories each, 27 channels each: 4,480 channels. 700 threads.
    const channels: { id: string; members: string[]; rooms: string[] }[] = [];
    for (let g = 0; g < n(166); g++) {
      ingest(disc, { t: 'space', space: { nativeId: `pg${g}`, kind: 'community', name: `Server ${g}`, topic: `A server about ${sentence(4)}` } });
      for (let s = 0; s < 6; s++) ingest(disc, { t: 'space', space: { nativeId: `pg${g}s${s}`, kind: 'section', name: `Category ${s}`, parents: [{ nativeId: `pg${g}`, position: String(s).padStart(3, '0') }] } });
      const members = Array.from({ length: 80 }, () => pick(strangers));
      const rooms = Array.from({ length: 27 }, (_, c) => `pg${g}c${c}`);
      for (let c = 0; c < 27; c++) {
        ingest(disc, { t: 'conversation', conversation: { nativeId: rooms[c], shape: 'channel', name: `${pick(WORDS)}-${c}`, topic: `Talk about ${sentence(5)}`, spaces: [{ nativeId: `pg${g}s${c % 6}`, position: String(c).padStart(3, '0') }] } });
        channels.push({ id: rooms[c], members, rooms });
      }
    }
    for (let t = 0; t < n(700); t++) {
      const parent = channels[(t * 7) % channels.length].id;
      ingest(disc, { t: 'conversation', conversation: { nativeId: `${parent}t${t}`, shape: 'thread', name: `thread ${t}`, parentConversation: parent } });
    }
    // 300 directs and 150 groups.
    const dms: Place[] = [];
    for (let i = 0; i < n(300); i++) {
      const c = contacts[i % contacts.length];
      const me = c.acc === sig ? self.sig : self.disc;
      ingest(c.acc, { t: 'conversation', conversation: { nativeId: `pd${i}`, shape: 'direct', participants: [me, c.id] } });
      dms.push({ acc: c.acc, conv: `pd${i}`, members: [me, c.id], rooms: [] });
    }
    for (let i = 0; i < n(150); i++) {
      const acc = i % 3 === 0 ? sig : disc;
      const me = acc === sig ? self.sig : self.disc;
      const members = [me, ...Array.from({ length: 3 + (i % 8) }, () => pick(contacts.filter((c) => c.acc === acc)).id)];
      ingest(acc, { t: 'conversation', conversation: { nativeId: `pp${i}`, shape: 'group', name: `Group ${i}`, participants: members } });
      dms.push({ acc, conv: `pp${i}`, members, rooms: [] });
    }
    return { channels, dms };
  })();

  // Who gets messages: the long tail first, then a few hundred mid-sized and a thousand small ones.
  const sizes: { at: Place; n: number; span: number }[] = [];
  const ch = places.channels;
  const BIG = [80_000, 40_000, 20_000, 14_000, 12_000, 10_000];
  BIG.forEach((s, i) => sizes.push({ at: { acc: disc, conv: ch[i * 31].id, members: ch[i * 31].members, rooms: ch[i * 31].rooms }, n: n(s), span: 8 * DAY }));
  const group = places.dms.find((d) => d.conv.startsWith('pp'))!;
  sizes.push({ at: places.dms[1], n: n(6_000), span: 60 * DAY });
  sizes.push({ at: group, n: n(4_000), span: 60 * DAY });
  for (let i = 0; i < 50; i++) sizes.push({ at: { acc: disc, conv: ch[400 + i].id, members: ch[400 + i].members, rooms: ch[400 + i].rooms }, n: n(1_000 + int(4_000)), span: 40 * DAY });
  for (let i = 0; i < 150; i++) sizes.push({ at: { acc: disc, conv: ch[600 + i].id, members: ch[600 + i].members, rooms: ch[600 + i].rooms }, n: n(250 + int(700)), span: 90 * DAY });
  for (const d of places.dms.slice(2)) if (d !== group) sizes.push({ at: d, n: n(5 + int(80)), span: 120 * DAY });
  for (let i = 0; i < 800; i++) {
    const c = ch[(1000 + i * 3) % ch.length];
    sizes.push({ at: { acc: disc, conv: c.id, members: c.members, rooms: c.rooms }, n: n(2 + int(30)), span: 200 * DAY });
  }

  const conv = (acc: typeof disc, native: string) => hubId('cnv', acc.network, native);
  const idn = (acc: typeof disc, native: string) => hubId('idn', acc.network, native);
  const IMG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#7c5cff"/></svg>').toString('base64');
  // A week of triage, counted from the same midnight, so the same rows have it whatever the hour.
  const since = anchor - 7 * DAY;
  let messages = 0;
  let triaged = 0;
  // Full-text search is indexed once at the end: row by row it takes most of the time.
  const fts = (store.db.query(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'message_fts_insert'`).get() as { sql: string }).sql;
  store.db.exec('DROP TRIGGER message_fts_insert');
  const bulk = store.db.transaction(() => {
    const msg = store.db.query(`INSERT INTO message (id, conversation_id, network, native_id, author_id, ts, body, reply_to_id, mentions_self) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const seen = store.db.query(`INSERT INTO message_seen (message_id, account_id) VALUES (?, ?)`);
    const att = store.db.query(`INSERT INTO attachment (id, message_id, kind, mime, name, width, height, url, position) VALUES (?, ?, 'image', 'image/svg+xml', 'pic.svg', 400, 300, ?, 0)`);
    const tally = store.db.query(`INSERT INTO reaction_tally (message_id, key, count) VALUES (?, ?, ?)`);
    const tri = store.db.query(`INSERT INTO triage (message_id, decision, score, reasons, decided_by, created_at) VALUES (?, ?, ?, '[]', 'rules', ?)`);
    const last = store.db.query(`UPDATE conversation SET last_message_id = ?, last_message_at = ? WHERE id = ?`);
    for (const [k, s] of sizes.entries()) {
      const { acc, conv: native, members, rooms } = s.at;
      const cid = conv(acc, native);
      // The busiest are the most recent; the rest end somewhere in their span.
      const newest = anchor - (k < 8 ? k * 60_000 : int(s.span / 2));
      const me = acc === sig ? self.sig : self.disc;
      const ids: string[] = [];
      let id = '';
      let ts = 0;
      for (let i = 0; i < s.n; i++) {
        ts = newest - Math.round((s.span * (s.n - 1 - i)) / s.n);
        const r = rnd();
        let body = sentence(3 + int(14));
        if (r < 0.08) body = `**${pick(WORDS)}** ${body} \`${pick(WORDS)}()\``;
        else if (r < 0.16) body = `${body} https://example.com/${pick(WORDS)}/${i}`;
        else if (r < 0.22) body = `<@${pick(members)}> ${body}`;
        else if (r < 0.24 && rooms.length) body = `see <#${pick(rooms)}> ${body}`;
        else if (r < 0.26) body = '```\n' + sentence(8) + '\n' + sentence(6) + '\n```';
        else if (r < 0.29) body = `> ${sentence(6)}\n${body} 🎉`;
        const nativeId = `${native}m${i}`;
        id = hubId('msg', acc.network, nativeId);
        const author = rooms.length ? pick(members) : rnd() < 0.3 ? me : pick(members.slice(1));
        const reply = ids.length && rnd() < 0.12 ? ids[ids.length - 1 - int(Math.min(20, ids.length))] : null;
        msg.run(id, cid, acc.network, nativeId, idn(acc, author), ts, body, reply, 0);
        seen.run(id, acc.id);
        if (rnd() < 0.03) att.run(hubId('att', acc.network, `${nativeId}#0`), id, IMG);
        if (rnd() < 0.045) tally.run(id, pick(['👍', '❤️', '😂', '🎉']), 1 + int(5));
        if (ts >= since) {
          const d = rnd();
          const decision = d < 0.004 ? 'push' : d < 0.008 ? 'quiet' : d < 0.009 ? 'silent' : d < 0.33 ? 'drop' : 'digest';
          tri.run(id, decision, rnd() < 0.012 ? Math.round(rnd() * 500) / 1000 : null, ts + 2_000);
          triaged++;
        }
        ids.push(id);
        messages++;
      }
      last.run(id, ts, cid);
    }
  });
  bulk();
  store.db.exec(`INSERT INTO message_fts (message_fts) VALUES ('rebuild')`);
  store.db.exec(fts);
  // Read state: about 900 conversations with something unread, a couple with a mention.
  store.db.transaction(() => {
    for (const [k, s] of sizes.entries()) {
      if (k % 3 === 2 && k > 3) continue;
      const lastTs = (store.db.query('SELECT last_message_at AS ts FROM conversation WHERE id = ?').get(conv(s.at.acc, s.at.conv)) as { ts: number }).ts;
      ingest(s.at.acc, { t: 'read', conversation: s.at.conv, upToTs: lastTs - 3_600_000, unread: 1 + int(40), mentions: k % 400 === 5 ? 1 : 0 });
    }
  })();
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const count = (q: string) => (store.db.query(q).get() as { n: number }).n;
  const counts = {
    conversations: count('SELECT COUNT(*) n FROM conversation'),
    withMessages: count('SELECT COUNT(DISTINCT conversation_id) n FROM message'),
    identities: count('SELECT COUNT(*) n FROM identity'),
    spaces: count('SELECT COUNT(*) n FROM space'),
    messages,
    triaged,
    unread: count('SELECT COUNT(DISTINCT target_id) n FROM vantage WHERE unread > 0'),
  };
  const opened = (s: (typeof sizes)[number]): WorldConv => ({ id: conv(s.at.acc, s.at.conv), nativeId: s.at.conv, accountId: s.at.acc.id, messages: s.n, member: s.at.members[s.at.members.length - 1] });
  const world: World = {
    open: [sizes[0], sizes[1], sizes[6], sizes[7], sizes[8], sizes.find((s) => s.at.conv.startsWith('pd') && s.n >= 30 && s.n <= 60)!].map(opened),
    counts,
    ms: Math.round(performance.now() - t0),
  };
  store.db.close();
  return world;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: bun scripts/perf-world.ts <fresh data dir> [scale]');
  console.log(JSON.stringify(seedWorld(dir, { scale: Number(process.argv[3] ?? 1) }), null, 1));
}

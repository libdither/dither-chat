/**
 * How fast mail search is on a big mailbox, for docs/mail.md: a made-up account of N messages (50,000 by default) in
 * threads, each with a fetched body (the worst case for the index), stored through MailStore as the sync stores them,
 * then the hub's own search (mail/search.ts) timed for each kind of query, median of several runs.
 *
 *   bun scripts/measure-mail-search.ts [--messages 50000] [--runs 7] [--db <file>]
 *
 * Everything is invented here; nothing reads a real database. Without --db the database is a temp file, removed after.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailId } from '../packages/protocol/src/ids.ts';
import type * as M from '../packages/protocol/src/mail-iface.ts';
import { MailHub } from '../packages/hub/src/mail/index.ts';
import { mailSearchOf } from '../packages/hub/src/mail/search.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const N = Number(opt('messages', '50000'));
const RUNS = Number(opt('runs', '7'));
const dir = mkdtempSync(join(tmpdir(), 'mail-search-'));
const file = opt('db', join(dir, 'hub.sqlite'));

// A seeded generator, so runs compare.
let seed = 42;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
// Words in a Zipf-like spread: a few common, many rare.
const syll = ['ka', 'lo', 'mi', 're', 'su', 'ta', 'ne', 'vo', 'pi', 'da', 'ro', 'zu', 'el', 'an', 'is', 'or'];
const vocab = Array.from({ length: 6000 }, (_, i) => syll[i % 16] + syll[Math.floor(i / 16) % 16] + (i >= 256 ? syll[Math.floor(i / 256) % 16] : '') + (i >= 4096 ? 'x' : ''));
const word = () => vocab[Math.floor(vocab.length * rnd() ** 3)];
const words = (n: number) => Array.from({ length: n }, word).join(' ');
const people = Array.from({ length: 800 }, (_, i) => ({ name: `${pick(['Sam', 'Alex', 'Jo', 'Pat', 'Kim', 'Lee', 'Max', 'Ana'])} ${vocab[i * 7]}`, email: `${vocab[i * 7]}${i}@${pick(['mail', 'work', 'lists', 'shop'])}.example` }));
const ME = { name: 'Me', email: 'me@example.com' };

const db = new Database(file, { create: true, strict: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
const hub = new MailHub({ db, backend: null, log: () => {} });
const st = hub.store;
const ACC = 'acc_measure';
st.upsertAccount({ id: ACC, kind: 'imap', label: 'measure', level: 'write', dryRun: false, online: true });
st.setStatus(ACC, { status: 'online', self: { email: ME.email } });
st.putMailboxes(
  ACC,
  ['INBOX:inbox', 'Sent:sent', 'Archive:archive', 'Junk:junk', 'Trash:trash'].map((x) => {
    const [id, role] = x.split(':');
    return { id, name: id, path: id, parentId: null, role: role as M.MailboxRole, unread: null, total: null };
  }),
);
const boxes = Object.fromEntries(['INBOX', 'Sent', 'Archive', 'Junk', 'Trash'].map((b) => [b, st.mailboxByNative(ACC, b)!]));

console.log(`storing ${N.toLocaleString()} messages with bodies…`);
const t0 = performance.now();
const year = 365 * 86_400_000;
const start = Date.now() - year;
let threads: { subject: string; root: string; at: number }[] = [];
const batch = new Map<string, M.MailSummary[]>();
const bodies: [string, string][] = [];
const flush = () => {
  for (const [box, list] of batch) st.ingest(ACC, boxes[box], list);
  batch.clear();
  // The body and its search text, as slice 2's storeBody keeps them (schema-search.sql's triggers index mail_text),
  // without putBody's preview and threading work.
  const body = db.query('INSERT INTO mail_body (message_id, text, bytes, fetched_at, used_at) VALUES (?, ?, ?, ?, ?)');
  const text = db.query('INSERT INTO mail_text (message_id, text, bytes, received_at) SELECT id, ?, ?, received_at FROM mail_message WHERE id = ?');
  db.transaction(() => {
    for (const [hdr, t] of bodies) {
      const id = mailId('mml', ACC, `m:${hdr}`);
      body.run(id, t, t.length, Date.now(), Date.now());
      text.run(t, t.length, id);
    }
  })();
  bodies.length = 0;
};
for (let i = 0; i < N; i++) {
  const at = start + Math.floor((i / N) * year);
  // About three messages a thread.
  const reply = threads.length && rnd() < 0.67 ? pick(threads.slice(-200)) : null;
  const subject = reply ? `Re: ${reply.subject}` : words(3 + Math.floor(rnd() * 5));
  const hdr = `<m${i}@measure.example>`;
  const mine = rnd() < 0.15;
  const from = mine ? ME : pick(people);
  const box = mine ? 'Sent' : rnd() < 0.03 ? 'Junk' : rnd() < 0.02 ? 'Trash' : rnd() < 0.5 ? 'Archive' : 'INBOX';
  const s: M.MailSummary = {
    id: `${box}.1.${i}`,
    mailboxId: box,
    messageId: hdr,
    threadId: null,
    from: [from],
    to: mine ? [pick(people)] : [ME],
    cc: rnd() < 0.2 ? [pick(people), pick(people)] : [],
    subject,
    date: at,
    receivedAt: at,
    flags: { seen: rnd() < 0.9, flagged: rnd() < 0.03, answered: false, draft: false },
    labels: rnd() < 0.1 ? [pick(['Work', 'Family', 'Receipts'])] : [],
    size: 2000,
    preview: null,
    hasAttachments: rnd() < 0.08,
    inReplyTo: reply?.root ?? null,
    references: reply ? [reply.root] : [],
  };
  batch.set(box, [...(batch.get(box) ?? []), s]);
  bodies.push([hdr, Array.from({ length: 2 + Math.floor(rnd() * 8) }, () => words(8 + Math.floor(rnd() * 14)) + '.').join('\n')]);
  if (!reply) threads.push({ subject, root: hdr, at });
  if (threads.length > 400) threads = threads.slice(-200);
  if (batch.size && [...batch.values()].reduce((n, l) => n + l.length, 0) >= 200) flush();
}
flush();
const storeMs = performance.now() - t0;
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
const nThreads = count('SELECT COUNT(*) AS n FROM mail_thread');
const textMb = count('SELECT SUM(bytes) AS n FROM mail_text') / 1e6;
const dbMb = statSync(file).size / 1e6;
const idx = (db.query("SELECT SUM(pgsize) AS n FROM dbstat WHERE name LIKE 'mail_fts%' OR name LIKE 'mail_search%' OR name LIKE 'mail_text%'").get() as { n: number } | null)?.n;
console.log(`${N.toLocaleString()} messages in ${nThreads.toLocaleString()} threads, stored in ${(storeMs / 1000).toFixed(1)} s; search text ${textMb.toFixed(1)} MB; database ${dbMb.toFixed(0)} MB${idx ? `, of which the search tables ${(idx / 1e6).toFixed(0)} MB` : ''}`);

const s = mailSearchOf(hub)!;
// Words by how many messages have them: rare, a quarter, nearly all (like "the").
const docs = (db.query('SELECT term, doc FROM mail_fts_vocab ORDER BY doc').all() as { term: string; doc: number }[]).filter((d) => /^[a-z]{6,}$/.test(d.term));
const near = (share: number) => docs.reduce((a, b) => (Math.abs(b.doc - share * N) < Math.abs(a.doc - share * N) ? b : a)).term;
const rare = near(0.002);
const quarter = near(0.25);
const most = near(0.95);
const someone = people[3];
const queries: [string, string][] = [
  ['a rare word (0.2% of messages)', rare],
  ['a word in a quarter of them', quarter],
  ['a word in nearly all ("the")', most],
  ['two words', `${quarter} ${near(0.3)}`],
  ['a phrase', `"${most} ${near(0.9)}"`],
  ['from: a person', `from:${someone.email.split('@')[0]}`],
  ['a word from: a person', `${quarter} from:${someone.name.split(' ')[1]}`],
  ['subject:', `subject:${near(0.05)}`],
  ['is:unread (filters only)', 'is:unread'],
  ['has:attachment in:archive (filters only)', 'has:attachment in:archive'],
  ['a word, after: a month', `${quarter} after:${new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 7)}`],
  ['inside words (no whole word matches)', rare.slice(1)],
  ['misspelt (corrected)', rare.slice(0, 2) + 'q' + rare.slice(3)],
  ['nothing at all', 'zzqqxx'],
];
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`\nmedian of ${RUNS} runs, first page of 50 threads:`);
for (const [label, q] of queries) {
  const times: number[] = [];
  let page = s.local(q);
  for (let r = 0; r < RUNS; r++) {
    const t = performance.now();
    page = s.local(q);
    times.push(performance.now() - t);
  }
  console.log(`  ${label.padEnd(42)} ${median(times).toFixed(1).padStart(7)} ms  ${String(page.hits.length).padStart(3)} hits${page.next ? '+' : ''}  ${page.mode}${page.corrected ? ', corrected' : ''}`);
}
// The second page of a word in a quarter of them.
const first = s.local(quarter);
const times: number[] = [];
for (let r = 0; r < RUNS; r++) {
  const t = performance.now();
  s.local(quarter, 50, first.next);
  times.push(performance.now() - t);
}
console.log(`  ${'a word in a quarter of them, page 2'.padEnd(42)} ${median(times).toFixed(1).padStart(7)} ms`);

hub.stop();
db.close();
if (!args.includes('--db')) rmSync(dir, { recursive: true, force: true });

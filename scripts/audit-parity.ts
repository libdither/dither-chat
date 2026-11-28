/**
 * The parity audit (docs/testing.md, "Parity audit"): read-only checks of a hub database, and the hub against a linked
 * Signal Desktop profile, in counts only (packages/hub/src/parity.ts).
 *
 *   bun scripts/audit-parity.ts                                   # the live database (a copy of it), every network
 *   bun scripts/audit-parity.ts --network signal --json
 *   bun scripts/audit-parity.ts --signal-desktop <profile dir> --days 30
 *   bun scripts/audit-parity.ts --db <copy.sqlite> --direct       # a copy already made, or a test's database
 *
 * The database is --db, else $DITHER_DATA/hub.sqlite, else ~/.local/share/dither-chat/hub.sqlite. It is never opened
 * as it is: it is copied with `sqlite3 -readonly <db> "VACUUM INTO '<tmp>'"` (AGENTS.md: another connection can lock
 * the hub out of its writes) into a private temporary folder, which is removed when the audit ends. `--direct` opens
 * --db itself, read-only, for a copy or a test database.
 *
 * Other options: --show-ids (hub ids instead of their hashes, to look one up locally), --self <ACI> (the account the
 * Desktop is linked as, when its database does not say), --desktop-key <hex> (its key, when a keyring wraps it).
 * It prints no message text, names or emoji.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditHubInvariants, diffSignalDesktop, type DesktopDiff, type HubInvariants } from '../packages/hub/src/parity.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag('help') || flag('h')) {
  console.log('bun scripts/audit-parity.ts [--db <hub.sqlite>] [--direct] [--network <net>] [--signal-desktop <dir>] [--days N] [--self <aci>] [--desktop-key <hex>] [--show-ids] [--json]');
  process.exit(0);
}

const dbPath = resolve(opt('db') ?? (process.env.DITHER_DATA ? join(process.env.DITHER_DATA, 'hub.sqlite') : join(homedir(), '.local/share/dither-chat/hub.sqlite')));
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}: pass --db <hub.sqlite>`);
  process.exit(2);
}
const days = opt('days') ? Number(opt('days')) : undefined;
if (days !== undefined && !(days > 0)) {
  console.error('--days takes a number of days above 0');
  process.exit(2);
}

/** A copy of the database made the one way AGENTS.md allows, in a folder of its own. */
function copyOf(live: string, dir: string): string {
  const copy = join(dir, 'hub.sqlite');
  const q = copy.replace(/'/g, "''");
  const r = Bun.spawnSync(['sqlite3', '-readonly', live, `VACUUM INTO '${q}'`], { stderr: 'pipe' });
  if (r.exitCode !== 0 || !existsSync(copy)) throw new Error(`sqlite3 could not copy the database: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
  return copy;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function printInvariants(r: HubInvariants) {
  console.log('Hub invariants');
  for (const n of r.networks) {
    console.log(`  ${n.network}: ${n.messages} messages`);
    console.log(`    edits stored as messages (a.edited_ts = b.ts): ${n.chainedEditDuplicates}`);
    console.log(`    replies to rows not there: ${n.danglingReplies.count} (with a quote ${n.danglingReplies.withQuote}, naming an edited time ${n.danglingReplies.targetsEditedTs})`);
    console.log(`    reacted: edited ${n.edited.reacted}/${n.edited.messages} (${pct(n.edited.rate)}), unedited ${n.unedited.reacted}/${n.unedited.messages} (${pct(n.unedited.rate)})${n.editedReactionDrop ? '  << edited reacted to far less' : ''}`);
    console.log(`    edited without an edit history row: ${n.editedWithoutEditEvent}`);
  }
  const o = r.orphans;
  console.log(`  rows whose message is gone: reactions ${o.reactions}, tallies ${o.tallies}, attachments ${o.attachments}, history ${o.events}`);
  if (r.samples.chainedEditDuplicates.length) {
    console.log('  edit duplicates, a few (chat, edited, duplicate):');
    for (const s of r.samples.chainedEditDuplicates) console.log(`    ${s.conversation}  ${s.edited}  ${s.duplicate}`);
  }
  console.log(r.anomalies.length ? `  anomalies: ${r.anomalies.map((a) => `${a.check}${a.network ? `(${a.network})` : ''} ${a.count}`).join(', ')}` : '  anomalies: none');
}

function printDesktop(d: DesktopDiff) {
  console.log('\nSignal Desktop against the hub');
  if (!d.window) {
    console.log('  their times do not overlap: nothing to compare');
    return;
  }
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  console.log(`  ${day(d.window.from)} to ${day(d.window.to)}: ${d.conversations} chats, ${d.matching} matching, ${d.hubOnlyConversations} only in the hub`);
  console.log('                 messages  edited  reactions  files');
  const row = (name: string, c: DesktopDiff['hub']) => console.log(`  ${name.padEnd(13)}${String(c.messages).padStart(9)}${String(c.edited).padStart(8)}${String(c.reactions).padStart(11)}${String(c.attachments).padStart(7)}`);
  row('desktop', d.desktop);
  row('hub', d.hub);
  console.log(`  missing in the hub ${d.missingInHub}, only in the hub ${d.extraInHub} (edits stored as messages ${d.editDuplicates}), reactions missing ${d.reactionsMissing} / extra ${d.reactionsExtra}, edited on one side ${d.editedMismatch}`);
  for (const c of d.mismatches.slice(0, 20))
    console.log(
      `  ${c.conversation} ${c.shape.padEnd(6)} severity ${c.severity}: messages ${c.desktop.messages}/${c.hub.messages}, missing ${c.missingInHub}, extra ${c.extraInHub} (edit dups ${c.editDuplicates}), reactions ${c.desktop.reactions}/${c.hub.reactions} (missing ${c.reactionsMissing}), files ${c.desktop.attachments}/${c.hub.attachments}`,
    );
  if (d.mismatches.length > 20) console.log(`  … and ${d.mismatches.length - 20} more (--json for all)`);
}

const tmp = flag('direct') ? null : mkdtempSync(join(tmpdir(), 'dither-audit-'));
let db: Database | null = null;
try {
  db = new Database(tmp ? copyOf(dbPath, tmp) : dbPath, { readonly: true });
  const showIds = flag('show-ids');
  const invariants = auditHubInvariants(db, { network: opt('network'), showIds });
  const profile = opt('signal-desktop');
  const keyHex = opt('desktop-key') ?? process.env.DITHER_SIGNAL_DESKTOP_KEY;
  const desktop = profile
    ? diffSignalDesktop(db, { profile: resolve(profile), ...(keyHex ? { key: Buffer.from(keyHex, 'hex') } : {}) }, { days, showIds, selfId: opt('self') })
    : null;
  if (flag('json')) console.log(JSON.stringify({ invariants, ...(desktop ? { signalDesktop: desktop } : {}) }, null, 2));
  else {
    printInvariants(invariants);
    if (desktop) printDesktop(desktop);
  }
  const bad = invariants.anomalies.length > 0 || (desktop ? desktop.mismatches.length > 0 : false);
  process.exitCode = bad ? 1 : 0;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
} finally {
  db?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

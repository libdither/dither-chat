/**
 * Backtests the suggested folder layout (protocol folderplan.ts, docs/organize.md) against a layout someone made by
 * hand: the folders in a hub database. Read-only; run it on a copy, never the live file:
 *
 *   sqlite3 ~/.local/share/dither-chat/hub.sqlite "VACUUM INTO '/tmp/hub-copy.sqlite'"
 *   bun scripts/backtest-folders.ts /tmp/hub-copy.sqlite [--folders <account id>=<guildFolders answer.json> ...]
 *
 * The network's own folders come from the hub (account_self.folders), or from a saved answer of the Discord
 * extractor's `guildFolders` action ({folders: [{name, guildIds}]}, or {result: {folders}}) where the hub has none.
 * Prints how many servers each set of rules puts where the person put them, and how often a server taken out is put
 * back by the word rule or the first two suggestions. Names never leave the machine; with --names it lists the misses.
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { FolderView, Network } from '@dither-chat/protocol';
import { applyPlan, leaveOneOut, placement, planFolders, scoreLayout, type PlanInput, type PlanNetworkFolder } from '@dither-chat/protocol/folderplan';
import { hubId } from '@dither-chat/protocol/ids';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--folders'));
if (!path) {
  console.error('usage: bun scripts/backtest-folders.ts <hub copy.sqlite> [--folders <account id>=<file>] [--names]');
  process.exit(2);
}
const db = new Database(path, { readonly: true });
type Row = Record<string, any>;
const all = (sql: string, ...p: any[]) => db.query(sql).all(...p) as Row[];

// The person's folders, as the hub keeps them (a folder inside a folder is a parent_id).
const hasParent = all(`SELECT name FROM pragma_table_info('folder') WHERE name = 'parent_id'`).length > 0;
const fs = all(`SELECT * FROM folder ORDER BY position`);
const items = all(`SELECT * FROM folder_item ORDER BY position`);
const truthFolders: FolderView[] = fs.map((f) => ({
  id: f.id,
  name: f.name,
  icon: null,
  color: null,
  items: [
    ...items.filter((i) => i.folder_id === f.id).map((i) => ({ kind: i.item_kind, id: i.item_id })),
    ...(hasParent ? fs.filter((c) => c.parent_id === f.id).map((c) => ({ kind: 'folder' as const, id: c.id })) : []),
  ],
}));

// Top-level communities with the accounts that see them, and their channel names.
const spacesRows = all(`SELECT s.* FROM space s WHERE s.kind = 'community' AND NOT EXISTS (SELECT 1 FROM space_edge e JOIN space p ON p.id = e.parent_id AND p.kind = 'community' WHERE e.child_kind = 'space' AND e.child_id = s.id)`);
const vantage = new Map<string, string[]>();
for (const v of all(`SELECT target_id, account_id FROM vantage WHERE target_kind = 'space'`)) vantage.set(v.target_id, [...(vantage.get(v.target_id) ?? []), v.account_id]);
const children = new Map<string, Row[]>();
for (const e of all(`SELECT parent_id, child_kind, child_id FROM space_edge`)) children.set(e.parent_id, [...(children.get(e.parent_id) ?? []), e]);
const convName = new Map(all(`SELECT id, name FROM conversation`).map((c) => [c.id, c.name as string | null]));
const channelsOf = (id: string, depth = 0): string[] =>
  (children.get(id) ?? []).flatMap((e) => (e.child_kind === 'conversation' ? [convName.get(e.child_id) ?? ''] : depth < 2 ? channelsOf(e.child_id, depth + 1) : []));
const spaces = spacesRows.map((s) => ({ id: s.id as string, network: s.network as Network, name: s.name as string, text: [s.topic ?? '', ...channelsOf(s.id).slice(0, 25)].join(' '), accountIds: vantage.get(s.id) ?? [] }));
const accounts = all(`SELECT id, network, label FROM account`).map((a) => ({ id: a.id as string, network: a.network as Network, label: a.label as string }));
const vectors: Record<string, Record<string, number>> = {};
for (const r of all(`SELECT category_id, place_id, p FROM category_score WHERE kind = 'space'`)) (vectors[r.place_id] ??= {})[r.category_id] = r.p;

// The network's own folders.
const known = new Set(spaces.map((s) => s.id));
const networkFolders: PlanNetworkFolder[] = [];
const hasSelf = all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account_self'`).length > 0;
if (hasSelf)
  for (const r of all(`SELECT account_id, folders FROM account_self WHERE folders IS NOT NULL`)) {
    const net = accounts.find((a) => a.id === r.account_id)?.network;
    if (!net) continue;
    for (const f of JSON.parse(r.folders) as { name?: string; color?: string; spaces: string[] }[]) networkFolders.push({ accountId: r.account_id, name: f.name ?? null, color: f.color ?? null, spaces: f.spaces.map((n) => hubId('spc', net, n)).filter((id) => known.has(id)) });
  }
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--folders') continue;
  const [acc, file] = args[++i].split('=');
  if (networkFolders.some((f) => f.accountId === acc)) continue;
  const net = accounts.find((a) => a.id === acc)?.network ?? 'discord';
  const j = JSON.parse(readFileSync(file, 'utf8'));
  for (const f of (j.result ?? j).folders as { name: string | null; guildIds: string[] }[]) networkFolders.push({ accountId: acc, name: f.name ?? null, spaces: f.guildIds.map((g) => hubId('spc', net, g)).filter((id) => known.has(id)) });
}

const truth = placement(truthFolders);
const ids = spaces.filter((s) => truth.get(s.id)).map((s) => s.id);
const input: PlanInput = { accounts, spaces, folders: [], networkFolders, vectors };
const names = new Map(spaces.map((s) => [s.id, s.name]));
let n = 0;
const newId = () => `p${n++}`;

console.log(`${ids.length} servers in ${truthFolders.length} folders; ${networkFolders.filter((f) => f.spaces.length > 1).length} network folders; ${accounts.length} accounts`);
const runs: [string, { network: boolean; words: boolean; personas: boolean; nearest?: boolean }][] = [
  ['network folders', { network: true, words: false, personas: false }],
  ['+ one folder per account', { network: true, words: false, personas: true }],
  ['+ shared words', { network: true, words: true, personas: true }],
  ['+ every loose server to its first suggestion', { network: true, words: true, personas: true, nearest: true }],
  ['no network folders: words + accounts', { network: false, words: true, personas: true }],
];
for (const [label, r] of runs) {
  const plan = planFolders({ ...input, networkFolders: r.network ? networkFolders : [] });
  const steps = plan.steps.filter((s) => (s.rule === 'word' ? r.words : r.network));
  const moves = r.nearest ? Object.fromEntries(Object.entries(plan.suggest).map(([id, s]) => [id, s[0].folder])) : undefined;
  const after = applyPlan([], plan, { steps: new Set(steps.map((s) => s.id)), personas: r.personas, moves }, newId, spaces.map((s) => `space:${s.id}`));
  const s = scoreLayout(placement(after), truth, ids);
  console.log(`${label.padEnd(46)} placed right ${pct(s.placedRight)}  pairs together wrongly ${pct(1 - s.pairPrecision)}  loose ${pct(s.loose)}  (${after.length} folders)`);
}
const loo = leaveOneOut(input, truthFolders);
console.log(`a server taken out and put back: first guess ${pct(loo.top1)}, in the first two ${pct(loo.top2)} (n ${loo.n})`);
if (args.includes('--names')) {
  const plan = planFolders(input);
  for (const st of plan.steps) console.log(`  ${st.rule.padEnd(7)} ${st.name}: ${st.spaces.map((id) => names.get(id)).join(', ')}`);
}

function pct(x: number) {
  return `${Math.round(x * 100)}%`.padStart(4);
}

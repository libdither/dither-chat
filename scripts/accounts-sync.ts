/**
 * Keeps this repo and dither-accounts (docs/accounts.md) speaking the same protocol.
 *
 *   bun scripts/accounts-sync.ts [--check] [path to dither-accounts, default ../dither-accounts]
 *
 * The protocol is written here: packages/protocol is copied over dither-accounts' packages/chat-protocol (or, with
 * --check, compared, exiting 1 on a difference). The adapters are written there: extractors/<kind> is what runs, so
 * this only reports how far packages/adapter-<kind> here has fallen behind; the hub runs dither-accounts' copy when
 * it sits next to this checkout (supervisor.ts adapterEntry). The mail interface's types are written there too:
 * packages/protocol/src/mail-iface.ts is brought up to date from them (or, with --check, compared).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const here = resolve(import.meta.dir, '..');
const there = resolve(args.find((a) => !a.startsWith('--')) ?? join(here, '..', 'dither-accounts'));
if (!existsSync(join(there, 'packages', 'chat-protocol'))) {
  console.error(`no dither-accounts at ${there}`);
  process.exit(2);
}

const files = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
};
const same = (a: string, b: string) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));

// The protocol: this repo's copy wins.
const from = join(here, 'packages', 'protocol');
const to = join(there, 'packages', 'chat-protocol');
const differ = [...new Set([...files(join(from, 'src')).map((f) => join('src', f)), 'package.json'])].filter((f) => !same(join(from, f), join(to, f)));
const extra = files(join(to, 'src')).filter((f) => !existsSync(join(from, 'src', f)));
if (check) {
  for (const f of differ) console.log(`protocol differs: ${f}`);
  for (const f of extra) console.log(`protocol only in dither-accounts: src/${f}`);
} else {
  for (const f of differ) {
    mkdirSync(dirname(join(to, f)), { recursive: true });
    copyFileSync(join(from, f), join(to, f));
    console.log(`protocol: copied ${f}`);
  }
  for (const f of extra) console.log(`protocol: src/${f} is only in dither-accounts (left alone)`);
}

// The mail interface's types are written there: packages/protocol/src/mail-iface.ts copies them (docs/mail.md).
// Compared from its first type to the op table, which stays theirs; without --check the copy here is brought up to date.
const decls = (s: string) => {
  const a = s.indexOf('export interface MailAddress');
  const b = s.indexOf('const ids =');
  return a < 0 ? '' : s.slice(a, b < 0 ? undefined : b).trimEnd();
};
const ifaceThere = join(there, 'packages', 'interfaces', 'src', 'mail.ts');
const ifaceHere = join(from, 'src', 'mail-iface.ts');
let ifaceDiffers = false;
if (existsSync(ifaceThere)) {
  const theirs = decls(readFileSync(ifaceThere, 'utf8'));
  const mine = readFileSync(ifaceHere, 'utf8');
  if (theirs && theirs !== decls(mine)) {
    if (check) {
      ifaceDiffers = true;
      console.log('mail interface differs: packages/protocol/src/mail-iface.ts is not a copy of packages/interfaces/src/mail.ts there');
    } else {
      writeFileSync(ifaceHere, mine.slice(0, mine.indexOf('export interface MailAddress')) + theirs + '\n');
      console.log('mail interface: copied the types from dither-accounts into src/mail-iface.ts');
    }
  }
}

// The adapters: report only.
for (const kind of ['discord', 'matrix', 'signal', 'whatsapp']) {
  const live = join(there, 'extractors', kind, 'src');
  const copy = join(here, 'packages', `adapter-${kind}`, 'src');
  const all = [...new Set([...files(live), ...files(copy)])];
  const behind = all.filter((f) => !same(join(live, f), join(copy, f)));
  if (behind.length) console.log(`adapter-${kind}: ${behind.length} of ${all.length} files differ from dither-accounts (${behind.slice(0, 5).join(', ')}${behind.length > 5 ? ', …' : ''})`);
}

if (check && (differ.length || extra.length || ifaceDiffers)) process.exit(1);

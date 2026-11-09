/**
 * The most pressed buttons on a hub (docs/button-counts.md), for development. Reads GET /api/usage/clicks; changes
 * nothing.
 *
 *   bun scripts/clicks.ts [hub URL, default http://127.0.0.1:8460] [--days 30] [--top 40] [--by device|page]
 *
 * Counts come only from devices where Settings → Usage → "Count which buttons I press" is on.
 */
import type { ClicksView } from '@dither-chat/protocol';

const argv = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const flags = new Set(['--days', '--top', '--by']);
const hub = (argv.find((a, i) => !a.startsWith('--') && !flags.has(argv[i - 1])) ?? 'http://127.0.0.1:8460').replace(/\/$/, '');
const days = Number(opt('days', '7'));
const top = Number(opt('top', '30'));
const by = opt('by', 'device');
if (!['device', 'page'].includes(by)) {
  console.error('--by device or --by page');
  process.exit(2);
}

const res = await fetch(`${hub}/api/usage/clicks?days=${days}&by=${by}&limit=${top}`);
if (!res.ok) {
  console.error(`${hub}: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const v = (await res.json()) as ClicksView;
console.log(`${v.total} presses in the last ${v.days} days (since ${v.since}), the top ${Math.min(top, v.keys.length)}:\n`);
if (!v.keys.length) {
  console.log('Nothing counted. Switch it on in Settings → Usage on the devices to count.');
  process.exit(0);
}
const rows =
  by === 'page'
    ? [['button', 'page', 'presses'], ...v.keys.map((k) => [k.key, k.page ?? '', String(k.n)])]
    : [['button', 'phone', 'desktop', 'all'], ...v.keys.map((k) => [k.key, String(k.phone ?? 0), String(k.desktop ?? 0), String(k.n)])];
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const [i, r] of rows.entries()) {
  console.log(r.map((x, j) => (j === 0 || (by === 'page' && j === 1) ? x.padEnd(widths[j]) : x.padStart(widths[j]))).join('  '));
  if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('  '));
}

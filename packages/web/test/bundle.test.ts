/**
 * Budgets for the web build (docs/perf.md "Budgets"): every chunk's bytes and gzip bytes, and the startup set, what
 * index.html loads before the app runs (its script, modulepreloads and stylesheet). It builds the app with vite.config.ts
 * into a temp dir (packages/web/dist is never touched), about two seconds. Over a budget fails;
 * `bun scripts/budgets.ts --update` writes new ones (scripts/budgets.ts).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, type Rollup } from 'vite';
import { checkBudgets, type Measure } from '../../../scripts/budgets.ts';

const web = join(import.meta.dir, '..');
const out = mkdtempSync(join(tmpdir(), 'dither-bundle-'));
let output: (Rollup.OutputChunk | Rollup.OutputAsset)[] = [];

beforeAll(async () => {
  // bun test sets NODE_ENV=test, and vite builds under it as for development: the entry half again as big.
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = (await build({ root: web, configFile: join(web, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    output = (Array.isArray(res) ? res : [res]).flatMap((r) => r.output);
  } finally {
    process.env.NODE_ENV = env;
  }
}, 120_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

/** A file as it was written: bytes, and gzip at the default level (what vite prints). */
const sizes = (file: string) => {
  const buf = readFileSync(join(out, file));
  return { bytes: buf.byteLength, gzip: gzipSync(buf, { level: 6 }).byteLength };
};

/**
 * A name for a chunk that survives its content changing (the file name has a hash in it): the module it stands for
 * (a lazy screen's path, a package's file), "entry", or, for a shared chunk, "shared/" and the name rolldown gave it.
 */
function keyOf(o: Rollup.OutputChunk | Rollup.OutputAsset): string | null {
  if (o.fileName.endsWith('.map') || o.fileName === 'index.html') return null;
  if (o.type === 'asset') {
    if (o.fileName.endsWith('.css')) return `css/${o.names[0] ?? o.fileName}`;
    if (/\.m?js$/.test(o.fileName)) return `worker/${o.names[0] ?? basename(o.fileName).replace(/-[\w-]{8}(\.m?js)$/, '$1')}`;
    return null;
  }
  if (o.isEntry) return 'js/entry';
  const facade = o.facadeModuleId;
  if (!facade) return `js/shared/${o.name}`;
  const nm = facade.lastIndexOf('/node_modules/');
  return `js/${nm >= 0 ? facade.slice(nm + '/node_modules/'.length) : relative(web, facade)}`;
}

test('the build', () => {
  expect(output.some((o) => o.type === 'chunk' && o.isEntry)).toBe(true);
});

test('the service worker keeps the whole build: every chunk, lazy ones and workers too, and what index.html links to', () => {
  const sw = readFileSync(join(out, 'sw.js'), 'utf8');
  const stamped = sw.match(/const PRECACHE = '(.*)';/)?.[1];
  expect(stamped).toBeDefined();
  const precache: string[] = JSON.parse(stamped!.replace(/\\'/g, "'"));
  const written = readdirSync(join(out, 'assets'))
    .filter((f) => !f.endsWith('.map'))
    .map((f) => `/assets/${f}`);
  // Every chunk, not only the entry and what it imports itself: lazy screens, and rolldown's runtime (under startup).
  const chunks = output.filter((o) => o.type === 'chunk').map((o) => `/${o.fileName}`);
  expect(chunks.length).toBeGreaterThan(20);
  expect(precache).toEqual(expect.arrayContaining(chunks));
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const linked = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);
  expect(linked).toContain('/icon.svg');
  expect([...precache].sort()).toEqual([...new Set([...written, ...linked, '/index.html'])].sort());
  expect(sw).toMatch(/const BUILD = '[0-9a-f]{12}';/);
});

test('within budget', () => {
  const measures: Measure[] = [];
  const add = (key: string, s: { bytes: number; gzip: number }) => {
    measures.push({ key: `${key}.bytes`, value: s.bytes, kind: 'bytes' });
    measures.push({ key: `${key}.gzip`, value: s.gzip, kind: 'bytes' });
  };

  // The startup set: what index.html has the browser fetch before the app's script runs.
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const startup = [
    ...html.matchAll(/<script type="module"[^>]* src="\/([^"]+)"/g),
    ...html.matchAll(/<link rel="modulepreload"[^>]* href="\/([^"]+)"/g),
    ...html.matchAll(/<link rel="stylesheet"[^>]* href="\/([^"]+)"/g),
  ].map((m) => m[1]);
  const byFile = new Map(output.map((o) => [o.fileName, o]));
  const set = startup.map((f) => ({ file: f, key: keyOf(byFile.get(f)!) ?? f, ...sizes(f) }));
  console.log(['startup set:', ...set.map((s) => `  ${s.key.padEnd(30)} ${s.bytes.toLocaleString('en-US').padStart(10)} ${s.gzip.toLocaleString('en-US').padStart(9)} gzip`)].join('\n'));
  add('startup', { bytes: set.reduce((n, s) => n + s.bytes, 0), gzip: set.reduce((n, s) => n + s.gzip, 0) });
  measures.push({ key: 'startup.files', value: set.length, kind: 'count' });
  add('html/index.html', sizes('index.html'));

  const keyed = output.map((o) => ({ o, key: keyOf(o) })).filter((x): x is { o: Rollup.OutputChunk | Rollup.OutputAsset; key: string } => !!x.key);
  keyed.sort((a, b) => a.key.localeCompare(b.key));
  for (const { o, key } of keyed) add(key, sizes(o.fileName));

  const r = checkBudgets('web', measures, { title: 'Budgets: the web build' });
  expect([...r.over, ...r.raisedWithoutReason, ...r.missing]).toEqual([]);
});

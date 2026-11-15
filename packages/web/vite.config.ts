import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';

/** Stamps sw.js with this build's id and shell, so every deploy is a new worker and a new cache. */
function serviceWorkerBuild(): Plugin {
  return {
    name: 'dither-sw-build',
    apply: 'build',
    writeBundle(opts, bundle) {
      const dir = opts.dir!;
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const hash = createHash('sha256').update(files.sort().join('\n'));
      for (const f of ['manifest.webmanifest', 'index.html']) hash.update(readFileSync(join(dir, f)));
      const entry = Object.values(bundle).find((b) => b.type === 'chunk' && b.isEntry) as { fileName: string; imports: string[] };
      const shell = Object.values(bundle)
        .filter((b) => (b.type === 'chunk' ? b.fileName === entry.fileName || entry.imports.includes(b.fileName) : b.fileName.endsWith('.css')))
        .map((b) => '/' + b.fileName);
      const sw = join(dir, 'sw.js');
      writeFileSync(sw, readFileSync(sw, 'utf8').replace('__BUILD__', hash.digest('hex').slice(0, 12)).replace('__PRECACHE__', JSON.stringify(shell).replace(/'/g, "\\'")));
    },
  };
}

/**
 * Fails the build on a static import cycle between output chunks: such a cycle can run a chunk before the values it
 * imports exist, which blanks the app at load, and only in a production build (docs/testing.md "Import cycles").
 * After T3 Code's chunkCycleGuardPlugin (apps/web/vite.config.ts).
 */
function chunkCycleGuard(): Plugin {
  return {
    name: 'dither-chunk-cycle-guard',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const done = new Set<string>();
      const visit = (fileName: string, path: string[]) => {
        if (done.has(fileName)) return;
        const start = path.indexOf(fileName);
        if (start !== -1) this.error(`chunk import cycle: ${[...path.slice(start), fileName].join(' -> ')}`);
        const chunk = bundle[fileName];
        if (chunk?.type !== 'chunk') return;
        for (const imported of chunk.imports) visit(imported, [...path, fileName]);
        done.add(fileName);
      };
      for (const fileName of Object.keys(bundle)) visit(fileName, []);
    },
  };
}

/** Changes whenever the wire types do, so a snapshot (src/snapshot.ts) is only read back by code that expects its shape. */
function protocolHash() {
  const dir = join(import.meta.dirname, '../protocol/src');
  const hash = createHash('sha256');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) hash.update(f).update(readFileSync(join(dir, f)));
  return hash.digest('hex').slice(0, 12);
}

/** This build's git short sha, for the page's error reports (src/errors.ts); 'dev' when git cannot say. */
function buildSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev';
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  plugins: [preact(), serviceWorkerBuild(), chunkCycleGuard()],
  define: { __SNAPSHOT_SCHEMA__: JSON.stringify(protocolHash()), __BUILD_SHA__: JSON.stringify(buildSha()) },
  server: {
    port: 5319,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8460', ws: true, changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:8460', changeOrigin: true },
      // dither-calendar through the hub (docs/calendar.md); without it the dev server would answer /calendar/ with this app.
      '/calendar': { target: 'http://127.0.0.1:8460' },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'startup', tags: ['$initial'], test: (id) => !/(\.html|[\\/]src[\\/]main\.tsx)$/.test(id) }] } } },
  },
});

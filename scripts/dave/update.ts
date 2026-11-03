/**
 * Keeps a tested copy of libdave (Discord's DAVE end-to-end encryption library) under a root dir.
 * This is the one command the hub or a systemd timer runs:
 *
 *   bun scripts/dave/update.ts --root DIR [--keep N] [--no-prune]
 *
 * 1. Fetches the current Discord web build anonymously into DIR/cache (assets already there by
 *    name are reused) and extracts libdave into a staging dir (see extract.ts).
 * 2. Computes the protocol fingerprint (see fingerprint.ts) and diffs it against DIR/fingerprint.json.
 *    Breaking changes are printed loudly and recorded as warnings; they never block step 4.
 * 3. If the wasm and module are the same as DIR/current.json's, only checkedAt is refreshed.
 * 4. Otherwise runs smoke.ts in a subprocess (env scrubbed to PATH and HOME, cwd = staging dir).
 *    Only if every step passes, the staging dir becomes DIR/<first 16 hex of the wasm sha256>/ and
 *    DIR/current.json is replaced atomically.
 *
 * On failure current.json is left alone, DIR/last-failure.json says why, and the failed staging dir
 * is kept as DIR/last-failed/ for inspection. Exit codes: 0 ok (promoted or unchanged), 1 failure
 * (network, smoke test, I/O), 2 an extraction anchor was not found (Discord changed the bundle),
 * 3 another update is running.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AnchorError, extract, fetchBuild, type Build } from './extract.ts';
import { diffFingerprints, fingerprint, type Diff, type Fingerprint } from './fingerprint.ts';

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!opt('--root')) {
  console.error('usage: bun scripts/dave/update.ts --root DIR [--keep N] [--no-prune]');
  process.exit(1);
}
const ROOT = resolve(opt('--root')!);
const KEEP = Number(opt('--keep') ?? 3); // promoted dirs kept, current included
const CACHE = join(ROOT, 'cache');
const CACHE_MAX_AGE_DAYS = 30;
const SMOKE = join(import.meta.dir, 'smoke.ts');
const log = (...a: unknown[]) => console.error('[dave/update]', ...a);

mkdirSync(CACHE, { recursive: true });

function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n');
  renameSync(tmp, path);
}
const readJson = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// One run at a time. A lock older than an hour is from a crashed run.
const LOCK = join(ROOT, '.lock');
try {
  if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > 3600_000) rmSync(LOCK, { force: true });
  writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
} catch {
  log(`another update holds ${LOCK}`);
  process.exit(3);
}
const unlock = () => rmSync(LOCK, { force: true });

const staging = join(ROOT, `.staging-${Date.now()}-${process.pid}`);
let stage = 'fetch';
let build: Build | undefined;
let fpDiff: Diff | undefined;
const warnings: string[] = [];

function fail(reason: string, code: number, extra: Record<string, unknown> = {}): never {
  log(`FAILED at ${stage}: ${reason}`);
  writeJsonAtomic(join(ROOT, 'last-failure.json'), {
    at: new Date().toISOString(),
    stage,
    reason,
    build: build?.number ?? null,
    versionHash: build?.versionHash ?? null,
    fingerprint: fpDiff ?? null,
    warnings,
    ...extra,
  });
  if (existsSync(staging)) {
    rmSync(join(ROOT, 'last-failed'), { recursive: true, force: true });
    renameSync(staging, join(ROOT, 'last-failed'));
  }
  unlock();
  process.exit(code);
}

try {
  // 1. fetch + extract
  const fetched = await fetchBuild(CACHE);
  build = fetched.build;
  stage = 'extract';
  const ex = await extract({ files: fetched.files, cache: CACHE, out: staging, build, allowFetch: true });

  // 2. fingerprint
  stage = 'fingerprint';
  let fp: Fingerprint;
  try {
    fp = fingerprint(fetched.files, build.number);
  } catch (e) {
    fp = { version: 1, build: build.number, values: {}, missing: [`fingerprint crashed: ${(e as Error).message}`] };
  }
  fp.values['dave.calledByWebClient'] = ex.manifest.names.calledByWebClient;
  fp.values['dave.wasmEmbindCandidates'] = ex.manifest.names.wasmEmbindCandidates;
  fp.values['dave.calledButNotInWasm'] = ex.manifest.names.calledButNotInWasm;
  const prevFp: Fingerprint | null = readJson(join(ROOT, 'fingerprint.json'));
  fpDiff = diffFingerprints(prevFp, fp);
  for (const m of fp.missing) warnings.push(`anchor missing: ${m}`);
  for (const b of fpDiff.breaking) warnings.push(`breaking: ${b}`);
  for (const n of ex.manifest.names.calledButNotInWasm) warnings.push(`libdave: client calls ${n}, not found in the wasm`);
  if (warnings.length) {
    console.error('\n[dave/update] !!! protocol warnings (libdave promotion is not blocked by these) !!!');
    for (const w of warnings) console.error('  ' + w);
    console.error('');
  }
  if (fpDiff.additive.length) log(`additive changes: ${fpDiff.additive.join('; ')}`);
  const fpReport = { from: fpDiff.from ?? null, to: fpDiff.to ?? null, additive: fpDiff.additive, breaking: fpDiff.breaking, missing: fp.missing };

  // 3. unchanged?
  const currentPath = join(ROOT, 'current.json');
  const current = readJson(currentPath);
  const id = ex.wasmSha256.slice(0, 16);
  const now = new Date().toISOString();
  if (current && current.wasmSha256 === ex.wasmSha256 && current.moduleSha256 === ex.moduleSha256 && existsSync(current.dir)) {
    rmSync(staging, { recursive: true, force: true });
    writeJsonAtomic(currentPath, { ...current, checkedAt: now, lastCheckedBuild: build.number ?? null, fingerprint: fpReport, warnings });
    writeJsonAtomic(join(ROOT, 'fingerprint.json'), fp);
    log(`unchanged libdave ${id} (build ${build.number}); checkedAt refreshed`);
  } else {
    // 4. smoke test in a clean subprocess
    stage = 'smoke';
    const proc = Bun.spawn([process.execPath, SMOKE, staging], {
      cwd: staging,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? staging },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 180_000,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    process.stderr.write(stdout.split('\n').filter((l) => /^(PASS|FAIL)|passed under/.test(l)).map((l) => `  ${l}\n`).join(''));
    const smoke = readJson(join(staging, 'smoke.json'));
    if (code !== 0 || !smoke?.ok) {
      const failed = smoke?.results?.filter((r: any) => !r.ok).map((r: any) => `${r.step}: ${r.detail}`) ?? [];
      fail(`smoke test failed (exit ${code})${failed.length ? ': ' + failed.join('; ') : ''}`, 1, {
        smoke: smoke ?? null,
        smokeOutputTail: (stdout + stderr).split('\n').slice(-30).join('\n'),
      });
    }

    // 5. promote
    stage = 'promote';
    const finalDir = join(ROOT, id);
    if (existsSync(finalDir)) {
      // Same wasm, different module text (the extractor's template changed): replace in place.
      const old = join(ROOT, `.old-${id}-${Date.now()}`);
      renameSync(finalDir, old);
      renameSync(staging, finalDir);
      rmSync(old, { recursive: true, force: true });
    } else renameSync(staging, finalDir);
    const next = {
      dir: finalDir,
      build: build.number ?? null,
      versionHash: build.versionHash ?? null,
      wasmSha256: ex.wasmSha256,
      moduleSha256: ex.moduleSha256,
      promotedAt: now,
      checkedAt: now,
      lastCheckedBuild: build.number ?? null,
      maxProtocolVersion: smoke.maxProtocolVersion,
      previousDir: current?.dir && current.dir !== finalDir ? current.dir : (current?.previousDir ?? null),
      fingerprint: fpReport,
      warnings,
    };
    writeJsonAtomic(currentPath, next);
    writeJsonAtomic(join(ROOT, 'fingerprint.json'), fp);
    log(`promoted libdave ${id} from build ${build.number} (max DAVE protocol ${smoke.maxProtocolVersion})`);
  }

  // 6. housekeeping: old promoted dirs (keep current, previous and the newest others up to --keep), old cache files
  stage = 'prune';
  if (!argv.includes('--no-prune')) {
    const cur = readJson(currentPath);
    const keepDirs = new Set([cur?.dir, cur?.previousDir].filter(Boolean));
    const promoted = readdirSync(ROOT)
      .filter((n) => /^[0-9a-f]{16}$/.test(n))
      .map((n) => join(ROOT, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const d of promoted) if (keepDirs.size < KEEP) keepDirs.add(d);
    for (const d of promoted) if (!keepDirs.has(d)) rmSync(d, { recursive: true, force: true });
    const cutoff = Date.now() - CACHE_MAX_AGE_DAYS * 86400_000;
    for (const n of readdirSync(CACHE)) {
      const p = join(CACHE, n);
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
  }
  console.log(readFileSync(currentPath, 'utf8'));
  unlock();
} catch (e) {
  fail((e as Error).message, e instanceof AnchorError ? 2 : 1);
}

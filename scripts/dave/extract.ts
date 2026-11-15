/**
 * Turns the Discord web client's lazily loaded libdave (DAVE end-to-end encryption) emscripten glue
 * and wasm into a standalone ES module that runs in a browser worker, Bun or Node.
 *
 *   bun scripts/dave/extract.ts --fetch --cache DIR --out DIR   download the current build anonymously
 *   bun scripts/dave/extract.ts --assets DIR --out DIR          use already downloaded /assets files
 *
 * --fetch GETs https://discord.com/app (no cookies, no login) for the build number and the initial
 * script list, then downloads from https://discord.com/assets/ only what is not already in the cache:
 * the initial scripts, the DAVE lazy chunks and the .wasm. Nothing downloaded is executed here (the
 * wasm is compiled, never instantiated, to list its imports and exports).
 *
 * Everything is located by stable anchors (export name, emscripten strings, the wasm URL module
 * chain), never by module ids or file names, which change every build.
 *
 * Output: OUT/libdave.mjs, OUT/libdave.wasm, OUT/manifest.json. The output contains Discord's code:
 * never commit it. Exit codes: 0 ok, 1 other error (network, I/O), 2 an anchor was not found.
 */
import * as acorn from 'acorn';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ORIGIN = 'https://discord.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export class AnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorError';
  }
}
const log = (...a: unknown[]) => console.error('[dave/extract]', ...a);
export const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export interface Build {
  number?: string;
  versionHash?: string;
  source: string;
}

// ---------- fetching (only discord.com/app and discord.com/assets/*) ----------

async function get(url: string): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return r;
    } catch (e) {
      if (i >= 2) throw e;
      log(`retry ${url}: ${e}`);
      await Bun.sleep(1000 * (i + 1));
    }
  }
}

/** Download /assets/<name> into the cache unless it is already there (asset names carry a content hash). */
export async function fetchAsset(cache: string, name: string): Promise<string> {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`refusing odd asset name ${name}`);
  const p = join(cache, name);
  if (existsSync(p)) {
    const now = new Date();
    utimesSync(p, now, now); // marks it as in use, for cache pruning
    return p;
  }
  const buf = new Uint8Array(await (await get(`${ORIGIN}/assets/${name}`)).arrayBuffer());
  writeFileSync(p + '.part', buf);
  renameSync(p + '.part', p);
  return p;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<unknown>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** rspack runtime: chunk id -> file name (the `.u=e=>` function). */
function chunkMap(runtime: string): Map<string, string> {
  const out = new Map<string, string>();
  const m = /\.u=e=>/.exec(runtime);
  if (!m) return out;
  const end = runtime.indexOf('[e]+".js"', m.index);
  const body = runtime.slice(m.index, end > 0 ? end + 10 : m.index + 2_000_000);
  for (const x of body.matchAll(/"([\w-]+)"===e\?""\+e\+"\.([0-9a-f]{16})\.js"/g)) out.set(x[1], `${x[1]}.${x[2]}.js`);
  const obj = /""\+(e\+"\."\+)?\(\{/.exec(body);
  if (obj) {
    const rest = body.slice(obj.index + obj[0].length - 1);
    for (const x of rest.matchAll(/(?<=[{,])"?(\d+)"?:"([0-9a-f]{16})"/g))
      if (!out.has(x[1])) out.set(x[1], obj[1] ? `${x[1]}.${x[2]}.js` : `${x[2]}.js`);
  }
  return out;
}

// Chunk ids are quoted strings in older builds (`n.e("123")`) and bare numbers since 2026-11 (`n.e(123)`).
const DAVE_LOADER = /Promise\.all\(\[((?:[\w$]+\.e\((?:"[\w-]+"|\d+)\),?)+)\]\)\.then\([\w$]+\.bind\([\w$]+,\d+\)\)/g;

/**
 * Fetch the current build into `cache`: the /app page, every initial script and the DAVE lazy
 * chunks. Returns the build identity and the absolute paths of this build's .js files.
 */
export async function fetchBuild(cache: string): Promise<{ build: Build; files: string[] }> {
  mkdirSync(cache, { recursive: true });
  const html = await (await get(`${ORIGIN}/app`)).text();
  const build: Build = { source: 'discord.com/app GLOBAL_ENV' };
  const env = /GLOBAL_ENV\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/.exec(html);
  if (env) {
    build.number = /"BUILD_NUMBER"\s*:\s*"?(\d+)/.exec(env[1])?.[1];
    build.versionHash = /"VERSION_HASH"\s*:\s*"([0-9a-f]+)"/.exec(env[1])?.[1];
  }
  const scripts = [...new Set([...html.matchAll(/<script[^>]+src="\/assets\/([\w.-]+\.js)"/g)].map((x) => x[1]))];
  if (scripts.length === 0) throw new AnchorError('no /assets/*.js <script> tags on discord.com/app');
  log(`build ${build.number ?? '?'}: ${scripts.length} initial scripts`);
  await pool(scripts, 8, (s) => fetchAsset(cache, s));
  const files = scripts.map((s) => join(cache, s));

  let chunks: string[] | null = null;
  let cmap = new Map<string, string>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (src.includes('.u=e=>')) {
      const m = chunkMap(src);
      if (m.size > cmap.size) cmap = m; // the runtime is the script with the largest chunk map
    }
    if (!src.includes('DaveModuleFactory')) continue;
    for (const m of src.matchAll(DAVE_LOADER))
      if (src.slice(m.index!, m.index! + m[0].length + 400).includes('DaveModuleFactory'))
        chunks = [...m[1].matchAll(/\.e\("?([\w-]+)"?\)/g)].map((x) => x[1]!);
  }
  if (!chunks) throw new AnchorError('DAVE lazy loader (Promise.all([..e(..)]).then(bind) followed by DaveModuleFactory) not found');
  if (cmap.size === 0) throw new AnchorError('rspack runtime chunk map (.u=e=>) not found');
  for (const c of chunks) {
    const fn = cmap.get(c);
    if (!fn) throw new AnchorError(`DAVE chunk ${c} is not in the runtime chunk map`);
    files.push(await fetchAsset(cache, fn));
  }
  return { build, files };
}

/** The "[BUILD INFO] ... Build Number: N, Version Hash: H" log string, for --assets mode. */
export function buildFromFiles(files: string[]): Build {
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    const m = /Build Number: "?\+?(\d+)"?, Version Hash: ([0-9a-f]{40})/.exec(s);
    if (m) return { number: m[1], versionHash: m[2], source: `"[BUILD INFO]" string in ${f.split('/').pop()}` };
  }
  return { source: 'unknown' };
}

// ---------- chunk parsing ----------

/** Every `<digits>(e,t,n){...}` module record of a chunk, by walking its AST. */
export function chunkModules(src: string): Map<string, any> {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  const mods = new Map<string, any>();
  const stack: any[] = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (node.type === 'ObjectExpression' && node.properties.length) {
      const ok = node.properties.every(
        (p: any) => p.type === 'Property' && /^\d+$/.test(String(p.key.value ?? p.key.name)) && /Function/.test(p.value.type),
      );
      if (ok) for (const p of node.properties) mods.set(String(p.key.value ?? p.key.name), p);
    }
    for (const k in node) {
      const v = (node as any)[k];
      if (Array.isArray(v)) for (const c of v) stack.push(c);
      else if (v && typeof v === 'object' && typeof v.type === 'string') stack.push(v);
    }
  }
  return mods;
}

const fnSourceOf = (src: string, p: any) => (p.method ? 'function' : '') + src.slice(p.value.start, p.value.end);
const esc = (s: string) => s.replace(/\$/g, '\\$');

// Each anchor is a fact about emscripten or about the export, not about the minifier.
export const ANCHORS = {
  exportName: 'DaveModuleFactory',
  emscripten: ['instantiateWasm', 'wasm streaming compile failed', 'both async and sync fetching of the wasm failed'],
  wasmUrlExpr: 'new URL(<require>(<id>), <require>.b)',
};

interface Glue {
  file: string;
  chunkSrc: string;
  moduleKey: string;
  fnSource: string;
  requireName: string;
  modules: Map<string, any>;
}

function locateGlue(files: string[]): Glue {
  const hits: Glue[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!src.includes(ANCHORS.exportName) || !ANCHORS.emscripten.every((a) => src.includes(a))) continue;
    const mods = chunkModules(src);
    for (const [key, p] of mods) {
      const body = src.slice(p.value.start, p.value.end);
      if (!body.includes(ANCHORS.exportName) || !ANCHORS.emscripten.every((a) => body.includes(a))) continue;
      const params = p.value.params.map((x: any) => x.name);
      if (params.length < 3) continue;
      const exp = new RegExp(`\\b${esc(params[2])}\\.d\\(\\s*${esc(params[1])}\\s*,\\s*\\{[^}]*\\bDaveModuleFactory\\s*:`);
      if (!exp.test(body)) continue;
      hits.push({ file: f, chunkSrc: src, moduleKey: key, fnSource: fnSourceOf(src, p), requireName: params[2], modules: mods });
    }
  }
  if (hits.length === 0) throw new AnchorError('no chunk module exports DaveModuleFactory with the emscripten markers');
  if (hits.length > 1) log(`warning: ${hits.length} glue candidates, using ${hits[0].file}`);
  return hits[0];
}

/** Follow require ids from `new URL(req(id), req.b)` inside the glue until a "*.wasm" literal. */
function locateWasm(g: Glue) {
  const r = esc(g.requireName);
  const urlCall = new RegExp(`new URL\\(\\s*${r}\\((\\d+)\\)\\s*,\\s*${r}\\.b\\s*\\)`).exec(g.fnSource);
  const chain: string[] = [];
  let wasmName: string | undefined;
  if (urlCall) {
    const seen = new Set<string>();
    const queue = [urlCall[1]];
    while (queue.length && !wasmName) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      chain.push(id);
      const p = g.modules.get(id);
      if (!p) continue;
      const body = g.chunkSrc.slice(p.value.start, p.value.end);
      wasmName = /"([\w.-]+\.wasm)"/.exec(body)?.[1];
      const rq = p.value.params[2]?.name;
      if (rq) for (const x of body.matchAll(new RegExp(`\\b${esc(rq)}\\((\\d+)\\)`, 'g'))) queue.push(x[1]);
    }
  }
  if (!wasmName) {
    const lits = [...new Set([...g.chunkSrc.matchAll(/"([\w.-]+\.wasm)"/g)].map((x) => x[1]))];
    if (lits.length === 1) {
      wasmName = lits[0];
      log('wasm URL chain not resolved; using the only .wasm literal in the glue chunk');
    }
  }
  if (!wasmName) throw new AnchorError('could not resolve the wasm file referenced by the glue');
  return { wasmName, urlModuleId: urlCall?.[1] ?? null, chain };
}

// ---------- wasm inspection (static) ----------

/** NUL-separated printable strings of the data section: embind registers names as C strings. */
function wasmDataStrings(buf: Uint8Array): string[] {
  const out: string[] = [];
  let i = 8;
  const leb = () => {
    let r = 0,
      s = 0,
      b: number;
    do {
      b = buf[i++];
      r |= (b & 0x7f) << s;
      s += 7;
    } while (b & 0x80);
    return r >>> 0;
  };
  while (i < buf.length) {
    const id = buf[i++];
    const size = leb();
    const end = i + size;
    if (id === 11) {
      let cur = '';
      for (let j = i; j < end; j++) {
        const c = buf[j];
        if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c);
        else {
          if (cur.length >= 2) out.push(cur);
          cur = '';
        }
      }
    }
    i = end;
  }
  return out;
}

/** libdave names the web client calls, from the files that use the module (main thread and worker). */
function clientCalls(files: string[]): string[] {
  const calls = new Set<string>();
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    if (!s.includes('mlsSession') && !s.includes('SetKeyRatchet')) continue;
    for (const m of s.matchAll(/\.(?:mlsSession|dave|transientKeys)\.(\w+)/g)) calls.add(m[1]);
    for (const m of s.matchAll(/\bnew [\w$]+\.(Session|Encryptor|Decryptor|TransientKeys)\(/g)) calls.add(m[1]);
    for (const m of s.matchAll(/\.(Encrypt|Decrypt|SetKeyRatchet|SetPassthroughMode|TransitionToKeyRatchet|TransitionToPassthroughMode|AssignSsrcToCodec|GetMaxCiphertextByteSize|GetMaxPlaintextByteSize|SetProtocolVersionChangedCallback|GetProtocolVersion|GetTransientPrivateKey|MaxSupportedProtocolVersion)\(/g))
      calls.add(m[1]);
    for (const m of s.matchAll(/\b[\w$]+\.(MediaType|Codec)\.(\w+)\b/g)) calls.add(`${m[1]}.${m[2]}`);
  }
  return [...calls].sort();
}

// ---------- the standalone module ----------

function moduleSource(g: Glue, urlModuleId: string | null, stubbed: string[], wasmSha: string, glueSha: string) {
  // Deterministic: depends only on the glue and the wasm, so an unchanged libdave gives an unchanged file.
  return `// Generated by dither-chat scripts/dave/extract.ts from the Discord web client's libdave build.
// Contains Discord's emscripten glue. Local use only: never commit this file or libdave.wasm.
// glue sha256 ${glueSha}
// wasm sha256 ${wasmSha}

export const wasmSha256 = ${JSON.stringify(wasmSha)};
export const wasmUrl = new URL('./libdave.wasm', import.meta.url);

// Minimal stand-in for the webpack require the glue was written against. The polyfill side
// imports (${stubbed.join(', ') || 'none'}) are no-ops; the URL module returns the wasm URL.
const __require = (id) => (String(id) === ${JSON.stringify(urlModuleId ?? '')} ? wasmUrl.href : {});
__require.r = (x) => {
  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) Object.defineProperty(x, Symbol.toStringTag, { value: 'Module' });
  Object.defineProperty(x, '__esModule', { value: true });
};
__require.d = (x, defs) => {
  for (const k in defs) if (!Object.prototype.hasOwnProperty.call(x, k)) Object.defineProperty(x, k, { enumerable: true, get: defs[k] });
};
__require.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
__require.n = (m) => () => m;
__require.p = '';
Object.defineProperty(__require, 'b', { get: () => new URL('./', import.meta.url).href });

const __glue = ${g.fnSource};

const __exports = {};
__glue({ exports: __exports }, __exports, __require);
const __factory = __exports.DaveModuleFactory;

async function __wasmBytes(url) {
  const u = new URL(url);
  if (u.protocol === 'file:') {
    // Bun / Node only; never reached in a browser. Kept out of static imports on purpose.
    const fsName = 'node:fs/promises';
    const fs = await import(/* @vite-ignore */ fsName);
    return new Uint8Array(await fs.readFile(u));
  }
  const r = await fetch(u, { credentials: 'omit' });
  if (!r.ok) throw new Error('libdave.wasm: HTTP ' + r.status + ' ' + r.url);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * The emscripten factory, as the Discord client calls it (it passes only onRuntimeInitialized).
 * Extra options: wasmBinary (bytes) or wasmUrl (string or URL) to override where the wasm comes
 * from. instantiateWasm / locateFile / print / printErr / onAbort pass through to emscripten.
 */
export async function DaveModuleFactory(opts = {}) {
  const o = { ...opts };
  let failLoad;
  const loadFailed = new Promise((_, reject) => (failLoad = reject));
  if (!o.instantiateWasm && !o.locateFile) {
    o.instantiateWasm = (imports, done) => {
      (async () => {
        const bytes = o.wasmBinary ?? (await __wasmBytes(o.wasmUrl ?? wasmUrl));
        const { instance } = await WebAssembly.instantiate(bytes, imports);
        done(instance);
      })().catch((e) => failLoad(e));
      return {};
    };
  }
  return Promise.race([__factory(o), loadFailed]);
}

/** DaveModuleFactory(opts), then libdave logging lowered to warnings and errors. */
export async function loadDave(opts = {}) {
  const m = await DaveModuleFactory(opts);
  m.SetLogSeverity(m.LoggingSeverity.LS_WARNING);
  return m;
}
export default loadDave;
`;
}

export interface ExtractResult {
  build: Build;
  out: string;
  wasmSha256: string;
  moduleSha256: string;
  manifest: any;
}

/** Locate the glue and wasm among `files` (a build's .js files) and write the standalone module to `out`. */
export async function extract(opts: { files: string[]; cache: string; out: string; build?: Build; allowFetch?: boolean }): Promise<ExtractResult> {
  const { files, cache, out } = opts;
  const build = opts.build ?? buildFromFiles(files);
  const glue = locateGlue(files);
  log(`glue: ${glue.file.split('/').pop()} module ${glue.moduleKey}`);
  const wasm = locateWasm(glue);
  let wasmPath = join(cache, wasm.wasmName);
  if (!existsSync(wasmPath)) {
    if (!opts.allowFetch) throw new Error(`${wasm.wasmName} is not in ${cache} (use --fetch)`);
    wasmPath = await fetchAsset(cache, wasm.wasmName);
  } else await fetchAsset(cache, wasm.wasmName);
  const wasmBytes = new Uint8Array(readFileSync(wasmPath));
  if (!WebAssembly.validate(wasmBytes)) throw new Error(`${wasm.wasmName} is not valid WebAssembly`);
  log(`wasm: ${wasm.wasmName} (${wasmBytes.length} bytes) via module chain ${wasm.chain.join(' -> ')}`);

  const r = esc(glue.requireName);
  const reqIds = [...new Set([...glue.fnSource.matchAll(new RegExp(`\\b${r}\\((\\d+)\\)`, 'g'))].map((x) => x[1]))];
  const stubbed = reqIds.filter((x) => x !== wasm.urlModuleId);
  const helpers = [...new Set([...glue.fnSource.matchAll(new RegExp(`\\b${r}\\.([a-z])\\b(?!\\s*=)`, 'g'))].map((x) => x[1]))];
  const unknownHelpers = helpers.filter((h) => !'rdbonp'.includes(h));
  if (unknownHelpers.length) throw new AnchorError(`glue uses webpack helpers this extractor does not stub: ${unknownHelpers.join(', ')}`);

  const wasmSha = sha256(wasmBytes);
  const glueSha = sha256(glue.fnSource);
  const mjs = moduleSource(glue, wasm.urlModuleId, stubbed, wasmSha, glueSha);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'libdave.wasm'), wasmBytes);
  writeFileSync(join(out, 'libdave.mjs'), mjs);

  const mod = new WebAssembly.Module(wasmBytes); // compile only, to list the interface
  const strings = wasmDataStrings(wasmBytes);
  const idents = [...new Set(strings.filter((s) => /^[A-Za-z_][A-Za-z0-9_]{1,63}$/.test(s)))];
  const calls = clientCalls(files);
  const manifest = {
    generatedAt: new Date().toISOString(),
    build,
    source: {
      glueChunkFile: glue.file.split('/').pop(),
      glueChunkSha256: sha256(glue.chunkSrc),
      glueModuleIdThisBuild: glue.moduleKey,
      glueSha256: glueSha,
      wasmFile: wasm.wasmName,
      wasmUrlModuleChainThisBuild: wasm.chain,
    },
    output: { module: 'libdave.mjs', moduleSha256: sha256(mjs), wasm: 'libdave.wasm', wasmSha256: wasmSha, wasmBytes: wasmBytes.length },
    anchors: {
      glue: `chunk module whose require.d export object has key "${ANCHORS.exportName}" and whose body contains ${ANCHORS.emscripten.map((x) => JSON.stringify(x)).join(', ')}`,
      wasm: `${ANCHORS.wasmUrlExpr} inside the glue, then require ids until a "*.wasm" literal (fallback: the only .wasm literal in the chunk)`,
      build: build.source,
    },
    glue: { webpackHelpersUsed: helpers, stubbedRequires: stubbed },
    wasm: {
      imports: WebAssembly.Module.imports(mod).map((x) => `${x.module}.${x.name}:${x.kind}`),
      exports: WebAssembly.Module.exports(mod).map((x) => `${x.name}:${x.kind}`),
    },
    names: {
      calledByWebClient: calls,
      calledButNotInWasm: calls.filter((n) => !n.includes('.') && n !== 'delete' && !idents.includes(n)),
      wasmEmbindCandidates: idents.filter((s) => /^[A-Z]/.test(s) || /^k[A-Z]/.test(s)).sort(),
    },
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
  if (manifest.names.calledButNotInWasm.length) log('warning: client calls not found in the wasm strings:', manifest.names.calledButNotInWasm.join(', '));
  log(`wrote ${out}/libdave.mjs, libdave.wasm, manifest.json (build ${build.number ?? '?'})`);
  return { build, out, wasmSha256: wasmSha, moduleSha256: manifest.output.moduleSha256, manifest };
}

// ---------- CLI ----------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const fetchMode = argv.includes('--fetch');
  const out = opt('--out');
  const dir = opt(fetchMode ? '--cache' : '--assets') ?? opt('--assets') ?? opt('--cache');
  if (!out || !dir) {
    console.error('usage: bun scripts/dave/extract.ts (--fetch --cache DIR | --assets DIR) --out DIR');
    process.exit(1);
  }
  try {
    const cache = resolve(dir);
    let files: string[];
    let build: Build | undefined;
    if (fetchMode) ({ build, files } = await fetchBuild(cache));
    else files = readdirSync(cache).filter((f) => f.endsWith('.js')).map((f) => join(cache, f));
    const r = await extract({ files, cache, out: resolve(out), build, allowFetch: fetchMode });
    console.log(JSON.stringify({ build: r.build, out: r.out, wasmSha256: r.wasmSha256, moduleSha256: r.moduleSha256 }, null, 1));
  } catch (e) {
    console.error('[dave/extract]', e instanceof AnchorError ? 'BREAK:' : 'ERROR:', (e as Error).message);
    process.exit(e instanceof AnchorError ? 2 : 1);
  }
}

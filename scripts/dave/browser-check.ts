/**
 * Checks that an extracted libdave module loads the way the PWA loads it: dynamic import() from a
 * module Worker created from a data: URL (opaque origin), cross-origin from the server that hosts
 * libdave.mjs and libdave.wasm with Access-Control-Allow-Origin: *.
 *
 *   bun scripts/dave/browser-check.ts OUT_DIR
 *
 * Serves OUT_DIR on http://localhost:<port> (ACAO *) and a blank page on http://127.0.0.1:<port2>
 * (a different origin), starts headless Chromium (scripts/browser.ts), and inside the worker: loads
 * the module with loadDave(), creates a Session, TransientKeys, Encryptor and Decryptor, makes a key
 * package and does a passthrough round trip of an Opus frame. Exit 0 when it all worked.
 */
import { join, resolve, normalize } from 'node:path';
import { launch } from '../browser.ts';

if (!process.argv[2]) {
  console.error('usage: bun scripts/dave/browser-check.ts OUT_DIR');
  process.exit(1);
}
const OUT = resolve(process.argv[2]);
const requests: string[] = [];
const assets = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = normalize(new URL(req.url).pathname).replace(/^\/+/, '');
    requests.push(`${req.method} /${path} origin=${req.headers.get('origin')} cookie=${req.headers.get('cookie') ?? '-'}`);
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (!['libdave.mjs', 'libdave.wasm'].includes(path)) return new Response('not found', { status: 404, headers });
    const type = path.endsWith('.mjs') ? 'text/javascript' : 'application/wasm';
    return new Response(Bun.file(join(OUT, path)), { headers: { ...headers, 'Content-Type': type } });
  },
});
const page = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<!doctype html><title>dave</title>', { headers: { 'Content-Type': 'text/html' } }) });
const moduleUrl = `http://localhost:${assets.port}/libdave.mjs`;

const workerSource = `
self.onmessage = async () => {
  const out = { steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name, ok, detail });
  try {
    const mod = await import(${JSON.stringify(moduleUrl)});
    const dave = await mod.loadDave();
    step('import + loadDave', true, 'max protocol ' + dave.MaxSupportedProtocolVersion() + ', origin ' + self.origin);
    const failures = [];
    const tk = new dave.TransientKeys();
    const session = new dave.Session('', '', (s, r) => failures.push(s + ': ' + r));
    session.Init(1, 1234567890123456789n, '111111111111111111', tk.GetTransientPrivateKey(1));
    const kp = session.GetMarshalledKeyPackage();
    step('Session.Init + key package', kp.length > 100, kp.length + ' bytes, failures: ' + failures.length);
    const enc = new dave.Encryptor(), dec = new dave.Decryptor();
    enc.SetPassthroughMode(true); enc.SetKeyRatchet(null); enc.AssignSsrcToCodec(4242, dave.Codec.Opus);
    dec.TransitionToPassthroughMode(true); dec.TransitionToKeyRatchet(null);
    const frame = Uint8Array.from({ length: 80 }, (_, i) => (i * 37 + 11) & 255);
    const run = (fn, max, data) => {
      const p = dave._malloc(max);
      try { dave.HEAPU8.set(data, p); const n = fn(p, max); return n ? dave.HEAPU8.slice(p, p + n) : null; } finally { dave._free(p); }
    };
    const c = run((p, max) => enc.Encrypt(dave.MediaType.Audio, 4242, p, frame.length, max), enc.GetMaxCiphertextByteSize(dave.MediaType.Audio, frame.length), frame);
    const d = c && run((p, max) => dec.Decrypt(dave.MediaType.Audio, p, c.length, max), Math.max(c.length, dec.GetMaxPlaintextByteSize(dave.MediaType.Audio, c.length)), c);
    step('passthrough Encryptor/Decryptor round trip', !!d && d.length === frame.length && d.every((x, i) => x === frame[i]), 'protocol ' + enc.GetProtocolVersion());
    enc.delete(); dec.delete(); session.delete(); tk.delete();
  } catch (e) {
    step('exception', false, String(e && e.stack || e));
  }
  postMessage(out);
};`;

const { page: tab, close } = await launch();
let failed = 0;
try {
  await tab.goto(`http://127.0.0.1:${page.port}/`);
  const result = await tab.eval(`new Promise((resolve) => {
    const w = new Worker('data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}', { type: 'module' });
    w.onmessage = (e) => resolve(e.data);
    w.onerror = (e) => resolve({ steps: [{ name: 'worker error', ok: false, detail: e.message }] });
    setTimeout(() => resolve({ steps: [{ name: 'timeout', ok: false, detail: '30 s' }] }), 30000);
    w.postMessage('go');
  })`);
  for (const s of result.steps) {
    if (!s.ok) failed++;
    console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}${s.detail ? `  (${s.detail})` : ''}`);
  }
  if (!result.steps.length) failed++;
  console.log('requests:\n  ' + requests.join('\n  '));
  if (tab.errors.length) console.log('page errors:', tab.errors);
} finally {
  await close();
  assets.stop(true);
  page.stop(true);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

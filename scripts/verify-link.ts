/**
 * The app over a bad link (docs/sync.md, "A bad link"), in headless Chromium against a demo hub of its own, with a TCP
 * proxy between them that this steers (scripts/link-proxy.ts). verify-sync.ts and verify-offline.ts take the network
 * away and give it back; this covers what a phone meets instead:
 *
 *   1. a stalled socket: the live socket stays open and nothing crosses it (a phone that slept, a NAT that forgot it).
 *      The next probe finds it, a new one opens, one delta catches up, and a message from elsewhere shows, with no
 *      notice;
 *   1b. a socket that opens and then says nothing, not even the catch-up it asked for (docs/sync.md "On the socket"): the
 *      catch-up comes by POST once the wait for it is over, and the message sent meanwhile shows;
 *   2. a hanging catch-up: the socket works but POST /api/sync never answers. It is given up after SYNC_QUIET with
 *      nothing coming, and tried again on a new socket; frames held meanwhile are applied, and a send made meanwhile
 *      goes out once. Then every open connection dies without a word while new ones work (a phone waking): the probe
 *      replaces the socket, and the catch-up, put on one of the browser's dead idle connections, is asked again on
 *      another;
 *   3. a flapping link: every connection cut as soon as the page has opened its socket again, several times over, a
 *      send made in the middle of it. Reconnects stay one per cut, the send goes out once, nothing shows twice;
 *   4. a saturated slow link: 1.5 Mbit/s with a router's queue of 1 s and of 4 s, filled by a big download, and a
 *      probe: the pong waits behind the queue, past PONG_WAIT at 4 s. The new socket that races it waits in the same
 *      queue, so the pong wins and the socket stays, with no notice.
 *
 * The app's clocks are held (PING_EVERY, SYNC_QUIET): the test fires a probe with a `focus` event and a quiet timeout
 * by running the held timer, so nothing depends on how long a step took. Times printed are real milliseconds.
 *
 *   bun scripts/verify-link.ts
 * Starts its own demo hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';
import { linkProxy } from './link-proxy.ts';

const REPO = resolve(import.meta.dir, '..');
const WEB = process.env.DITHER_WEB_DIST ?? join(REPO, 'packages/web/dist');
/** The app's clocks (packages/web/src/state.ts), held here so a case never waits on them. */
const PING_EVERY = 25_000;
const SYNC_QUIET = 20_000;

const data = mkdtempSync(join(tmpdir(), 'dither-link-hub-'));
const hubPort = await new Promise<number>((done) => {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  done(p);
});
const hubUrl = `http://127.0.0.1:${hubPort}`;

let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const note = (what: string) => console.log(`     ${what}`);

const hubProc = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(hubPort), '--host', '127.0.0.1', '--web', WEB], {
  cwd: REPO,
  env: { ...process.env, DITHER_CALENDAR_URL: 'off' },
  stdout: 'ignore',
  stderr: 'inherit',
});
for (let i = 0; ; i++) {
  if (await fetch(`${hubUrl}/api/health`).then((r) => r.ok, () => false)) break;
  if (i > 400) throw new Error('the demo hub did not start');
  await Bun.sleep(50);
}
/** The hub itself, not through the link: another device. */
const hub = async <T = any>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(hubUrl + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
};

const link = await linkProxy(hubPort);
const url = `http://127.0.0.1:${link.port}`;
const { page: p, close } = await launch();

// What the page does on the link, and its clocks held.
await p.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const L = (window.__link = { sockets: [], fetches: [], held: new Map() });
    const W = window.WebSocket;
    window.WebSocket = class extends W {
      constructor(...a) {
        super(...a);
        const s = (this.__rec = { at: Date.now(), open: 0, close: 0, pings: [], pongs: [] });
        L.sockets.push(s);
        this.addEventListener('open', () => (s.open = Date.now()));
        this.addEventListener('close', () => (s.close = Date.now()));
        this.addEventListener('message', (e) => e.data === 'pong' && s.pongs.push(Date.now()));
      }
      send(d) {
        if (d === 'ping') this.__rec.pings.push(Date.now());
        return super.send(d);
      }
      close(...a) {
        this.__rec.dropped ??= Date.now();
        return super.close(...a);
      }
    };
    const f = window.fetch;
    window.fetch = function (input, init) {
      const u = new URL(input instanceof Request ? input.url : String(input), location.href);
      const r = { path: u.pathname, method: init?.method ?? 'GET', at: Date.now(), end: 0, status: 0, error: '' };
      L.fetches.push(r);
      return f.apply(this, arguments).then(
        (res) => ((r.status = res.status), res),
        (e) => ((r.end = Date.now()), (r.error = e?.name || 'error'), Promise.reject(e)),
      ).finally(() => (r.end ||= Date.now()));
    };
    // The heartbeat's interval and the catch-up's quiet timeout: run by the test, never by the clock.
    let id = 2e9;
    const si = window.setInterval, ci = window.clearInterval, st = window.setTimeout, ct = window.clearTimeout;
    window.setInterval = function (fn, ms, ...a) {
      if (ms !== ${PING_EVERY}) return si.call(window, fn, ms, ...a);
      return ++id;
    };
    window.setTimeout = function (fn, ms, ...a) {
      if (ms !== ${SYNC_QUIET} || typeof fn !== 'function') return st.call(window, fn, ms, ...a);
      L.held.set(++id, () => fn(...a));
      return id;
    };
    window.clearTimeout = function (x) { if (!L.held.delete(x)) ct.call(window, x); };
    window.clearInterval = function (x) { if (x <= 2e9) ci.call(window, x); };
  })()`,
});

type Sock = { at: number; open: number; close: number; dropped?: number; pings: number[]; pongs: number[] };
type Fetch = { path: string; method: string; at: number; end: number; status: number; error: string };
const sockets = () => p.eval<Sock[]>('__link.sockets');
const fetches = (since: number, re: RegExp) => p.eval<Fetch[]>('__link.fetches').then((fs) => fs.filter((f) => f.at >= since && re.test(`${f.method} ${f.path}`)));
const SYNC = /^POST \/api\/sync$/;
const BOOT = /^GET \/api\/bootstrap$/;
/** The socket in use is open and caught up: no catch-up in flight, the last one answered. */
const settled = async () => {
  // The socket in use: the newest that opened and is still open (a spare that lost its race was closed).
  await p.until(`__link.sockets.some((s) => s.open > 0 && !s.close && !s.dropped) && __link.fetches.filter((f) => f.path === '/api/sync' || f.path === '/api/bootstrap').every((f) => f.end)`, 20_000);
};
const probe = () => p.eval(`window.dispatchEvent(new Event('focus')), 0`);
const runHeld = () => p.eval<number>(`(() => { const fs = [...__link.held.values()]; __link.held.clear(); fs.forEach((f) => f()); return fs.length; })()`);
const orb = () => p.eval<boolean>(`!!document.querySelector('.offline-orb')`);
const shownCount = (text: string) => p.eval<number>(`[...document.querySelectorAll('.timeline-scroll .msg-body')].filter((e) => e.textContent.includes(${JSON.stringify(text)})).length`);
const untilShown = (text: string, ms = 15_000) => p.until(`[...document.querySelectorAll('.timeline-scroll .msg-body')].some((e) => e.textContent.includes(${JSON.stringify(text)}))`, ms).then(() => true, () => false);
/** Watches for the notice while a case runs: whether it ever showed. */
const watchOrb = () => {
  let seen = false;
  let on = true;
  const loop = (async () => {
    while (on) {
      seen ||= await orb().catch(() => false);
      await Bun.sleep(100);
    }
  })();
  return async () => ((on = false), await loop, seen);
};
const type = async (text: string) => {
  await p.eval(`document.querySelector('.composer textarea').focus()`);
  await p.send('Input.insertText', { text });
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const stamp = () => Date.now().toString(36);

try {
  const boot = await hub('/api/bootstrap');
  const sender = new Set(boot.accounts.filter((a: any) => a.status === 'online' && a.capabilities.includes('send')).map((a: any) => a.id));
  const conv = boot.conversations.find((c: any) => c.shape === 'direct' && c.lastMessage && c.vantages.some((v: any) => sender.has(v.accountId)));
  if (!conv) throw new Error('no direct conversation to send in');
  const stored = async (body: string) => (await hub(`/api/conversations/${conv.id}/messages?limit=60`)).messages.filter((m: any) => m.body === body).length;

  await p.size(1200, 800);
  await p.goto(`${url}/#/inbox/c/${conv.id}`);
  await p.until(`performance.getEntriesByName('dither:fresh').length > 0 && document.querySelectorAll('.timeline-scroll .msg').length > 0`, 30_000);
  await settled();

  // ------------------------------------------------------------------ 1. a stalled socket

  console.log('1. the live socket stalls');
  {
    const before = (await sockets()).length;
    const t0 = Date.now();
    const orbSeen = watchOrb();
    link.stall((c) => c.kind === 'ws');
    const away = `while the socket stalled ${stamp()}`;
    await hub(`/api/conversations/${conv.id}/send`, { body: away });
    const tProbe = Date.now();
    await probe();
    const reopened = await p.until(`__link.sockets.length > ${before} && __link.sockets.at(-1).open > 0`, 10_000).then(() => true, () => false);
    const s = await sockets();
    check(reopened, 'the probe finds the dead socket and a new one opens', `${s.at(-1)!.open - tProbe} ms after the probe (PONG_WAIT is 3000)`);
    check(await untilShown(away), 'the message sent meanwhile shows', `${Date.now() - tProbe} ms after the probe`);
    await settled();
    const syncs = await fetches(t0, SYNC);
    check(syncs.length === 1 && !(await fetches(t0, BOOT)).length, '…from one delta, no bootstrap', { syncs: syncs.length });
    check(!(await orbSeen()), 'no notice for it');
    check((await shownCount(away)) === 1, '…shown once');
  }

  console.log('1b. a new socket opens and then says nothing, not even its catch-up');
  {
    const before = (await sockets()).length;
    const t0 = Date.now();
    link.muteAfterHead((c) => c.kind === 'ws');
    link.cut();
    const away = `while the new socket said nothing ${stamp()}`;
    await hub(`/api/conversations/${conv.id}/send`, { body: away });
    await p.until(`__link.sockets.length > ${before} && __link.sockets.at(-1).open > 0`, 10_000);
    const opened = (await sockets()).at(-1)!.open;
    check(await untilShown(away), 'the catch-up comes by POST instead, and the message sent meanwhile shows', `${Date.now() - opened} ms after the socket opened`);
    check(!(await fetches(t0, BOOT)).length, '…without a bootstrap');
    check((await shownCount(away)) === 1, '…shown once');
    // The silent socket goes, and the next one works.
    link.clear();
    link.cut();
    await settled();
  }

  // ------------------------------------------------------------------ 2. a hanging catch-up

  console.log('2. the catch-up hangs while the socket works');
  {
    link.clear();
    link.hangOn(/^POST \/api\/sync$/);
    const before = (await sockets()).length;
    const t0 = Date.now();
    link.cut();
    await p.until(`__link.sockets.length > ${before} && __link.sockets.at(-1).open > 0 && __link.fetches.some((f) => f.path === '/api/sync' && f.at >= ${t0} && !f.end)`, 10_000);
    // A frame on the working socket while the catch-up hangs: held until it answers.
    const meanwhile = `while the catch-up hung ${stamp()}`;
    await hub(`/api/conversations/${conv.id}/send`, { body: meanwhile });
    const queued = `sent while the catch-up hung ${stamp()}`;
    await type(queued);
    // Probes still answered: the socket is fine, only the catch-up is stuck.
    await probe();
    const pinged = (await sockets()).at(-1)!.pings.length;
    await p.until(`__link.sockets.at(-1).pongs.length >= ${pinged}`, 5000);
    check(!(await shownCount(meanwhile)), 'with the catch-up hanging, frames on the socket are held');
    link.clear();
    const fired = await runHeld();
    const tQuiet = Date.now();
    check(fired > 0, `the catch-up has a quiet timeout (SYNC_QUIET, ${SYNC_QUIET} ms with nothing coming)`, { held: fired });
    const caught = await untilShown(meanwhile);
    check(caught, '…given up, and tried again: the held message shows', `${Date.now() - tQuiet} ms after the timeout`);
    const out = await p.until(`!document.querySelector('.msg.pending')`, 15_000).then(() => true, () => false);
    check(out && (await stored(queued)) === 1 && (await shownCount(queued)) === 1, 'a send made meanwhile went out once, and shows once', { out, onHub: await stored(queued), shown: await shownCount(queued) });
    const syncs = await fetches(t0, SYNC);
    note(`catch-ups: ${syncs.length} (${syncs.map((f) => (f.end ? `${f.error || f.status} after ${f.end - f.at} ms` : 'open')).join(', ')}), sockets: ${(await sockets()).length - before}`);
    check(!(await fetches(t0, BOOT)).length, '…without a bootstrap');
    await settled();
  }

  console.log('2b. every open connection dies without a word, new ones work (a phone waking, a NAT that forgot them all)');
  {
    // The browser keeps idle connections to the hub, and puts the next request on one of them.
    const idle = link.conns.filter((c) => !c.closed && c.kind === 'http').length;
    const before = (await sockets()).length;
    const t0 = Date.now();
    link.stall(() => true);
    const away = `after everything stalled ${stamp()}`;
    await hub(`/api/conversations/${conv.id}/send`, { body: away });
    const tProbe = Date.now();
    await probe();
    // No quiet timeout run here: the probe and the catch-up's tries alone must do.
    const caught = await untilShown(away);
    check(caught, 'the probe replaces the socket and the catch-up gets through, past the dead idle connections', `${Date.now() - tProbe} ms after the probe`);
    await settled();
    const syncs = await fetches(t0, SYNC);
    note(`${idle} idle connections died; catch-up tries: ${syncs.length} (${syncs.map((f) => (f.status ? `${f.status} in ${f.end - f.at} ms` : f.error || 'open')).join(', ')}), new sockets: ${(await sockets()).length - before}`);
    check(!(await fetches(t0, BOOT)).length, '…without a bootstrap');
    const live = `live on the new socket ${stamp()}`;
    const t1 = Date.now();
    await hub(`/api/conversations/${conv.id}/send`, { body: live });
    check((await untilShown(live, 5000)) && !(await fetches(t1, SYNC)).length, 'the new socket brings what comes next by itself', `${Date.now() - t1} ms`);
  }

  // ------------------------------------------------------------------ 3. a flapping link

  console.log('3. the link flaps: every connection cut as soon as the socket is back, 6 times');
  {
    const before = (await sockets()).length;
    const t0 = Date.now();
    const from = `from elsewhere while flapping ${stamp()}`;
    const mine = `sent while flapping ${stamp()}`;
    const CUTS = 6;
    for (let i = 0; i < CUTS; i++) {
      const n = (await sockets()).length;
      await p.until(`__link.sockets.length > ${n - 1} && __link.sockets.at(-1).open > 0`, 20_000);
      if (i === 2) await hub(`/api/conversations/${conv.id}/send`, { body: from });
      if (i === 3) await type(mine);
      link.cut();
      await p.until(`__link.sockets.length > ${n}`, 20_000);
    }
    const tStop = Date.now();
    await settled();
    const ok = (await untilShown(from)) && (await p.until(`!document.querySelector('.msg.pending')`, 15_000).then(() => true, () => false));
    const s = (await sockets()).slice(before);
    const gaps = s.slice(1).map((x, i) => x.at - (s[i].close || s[i].dropped || s[i].at));
    check(ok, 'after it, the message from elsewhere and the send are both there', `${Date.now() - tStop} ms after the last cut`);
    check(s.length <= CUTS + 2, 'one new socket per cut', { sockets: s.length, cuts: CUTS, msBetween: gaps });
    check((await stored(mine)) === 1, 'the send went out once', { onHub: await stored(mine) });
    check((await shownCount(mine)) === 1 && (await shownCount(from)) === 1, 'nothing shows twice', { mine: await shownCount(mine), from: await shownCount(from) });
    const syncs = await fetches(t0, SYNC);
    note(`catch-ups: ${syncs.length} (${syncs.filter((f) => f.error).length} cut), bootstraps: ${(await fetches(t0, BOOT)).length}`);
  }

  // ------------------------------------------------------------------ 4. a saturated slow link

  console.log('4. a slow link (1.5 Mbit/s) filled by a download, and a probe');
  {
    // The biggest file the hub serves that the service worker does not keep: a source map.
    const big = readdirSync(join(WEB, 'assets'))
      .filter((f) => f.endsWith('.map'))
      .map((f) => ({ f, n: statSync(join(WEB, 'assets', f)).size }))
      .sort((a, b) => b.n - a.n)[0];
    const bytesPerSec = 187_500;
    // A router's queue of 1 s, and of 4 s as on many mobile networks: the pong waits behind what is in it.
    for (const queueSec of [1, 4]) {
      await settled();
      const before = (await sockets()).length;
      link.shape({ bytesPerSec, queueBytes: bytesPerSec * queueSec });
      const orbSeen = watchOrb();
      await p.eval(`window.__big = fetch('/assets/${big.f}?n=${stamp()}', { cache: 'no-store' }).then((r) => r.arrayBuffer()).then((b) => b.byteLength, () => -1); 0`);
      // Filled by the download to what this case is about.
      for (let i = 0; i < 400 && link.queued() < bytesPerSec * queueSec * 0.8; i++) await Bun.sleep(25);
      const queuedAt = link.queued();
      const i = before - 1;
      const pinged = (await sockets())[i].pings.length;
      await probe();
      await p.until(`__link.sockets[${i}].pongs.length > ${pinged} || !!__link.sockets[${i}].dropped`, 30_000);
      const s = await sockets();
      const old = s[i];
      const pong = old.pongs.length > pinged ? old.pongs[pinged] - old.pings[pinged] : -1;
      const kept = !old.dropped;
      // Replaced by a spare that won the race is no gap; dropped with nothing in its place is.
      const switched = !kept && s.slice(before).some((x) => x.open && x.open <= (old.dropped ?? 0) + 50);
      const got = await p.eval<number>('window.__big');
      link.shape(null);
      await settled();
      note(`${(queuedAt / bytesPerSec).toFixed(1)} s queued at the probe (${Math.round(queuedAt / 1024)} KB): pong after ${pong >= 0 ? `${pong} ms` : 'never'}, ${kept ? 'socket kept' : switched ? 'socket replaced by the spare' : 'socket dropped'}, ${s.length - before} spare socket(s); download ${got} B`);
      check(kept || switched, `behind a queue of ${queueSec} s, a healthy socket stays (or a spare takes its place with no gap)`, { pongMs: pong });
      check(!(await orbSeen()), '…and no notice for it');
    }
  }

  const errors = p.errors.filter((e) => !/ERR_CONNECTION|ERR_EMPTY_RESPONSE|WebSocket connection|net::ERR_|Failed to fetch|aborted/i.test(e));
  check(!errors.length, 'no script errors', errors);
} catch (e) {
  failed++;
  console.log(`FAIL ${(e as Error).message}`);
  if (process.env.DEBUG_LINK) console.log(JSON.stringify(await p.eval('({ s: __link.sockets, f: __link.fetches.slice(-15) })'), null, 1), link.conns.map((c) => `${c.id} ${c.kind} ${c.silent ? 'silent' : ''} ${c.closed ? 'closed' : ''} ${c.requests.join('; ')}`));
} finally {
  await close();
  await link.close();
  hubProc.kill();
  await hubProc.exited;
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

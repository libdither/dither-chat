/**
 * A private headless Chromium driven over the DevTools protocol, for verifying the PWA and taking
 * screenshots. It has its own throwaway profile and HOME; pass caCert to trust the hub's private CA.
 * Uses no dependency beyond chromium itself (and nix for certutil). Which browser: findBrowser().
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Page {
  send<T = any>(method: string, params?: unknown): Promise<T>;
  eval<T = any>(expr: string): Promise<T>;
  goto(url: string): Promise<void>;
  shot(path: string): Promise<void>;
  size(width: number, height: number, mobile?: boolean): Promise<void>;
  until(expr: string, ms?: number): Promise<void>;
  errors: string[];
  on(method: string, fn: (params: any) => void): void;
  /** Evaluate in a service worker whose script URL contains this. */
  evalWorker<T = any>(url: string, expr: string): Promise<T>;
}

const readFileOr = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

/**
 * The browser to run: $DITHER_CHROMIUM if set, else the first of chromium, chromium-browser, google-chrome and
 * google-chrome-stable on PATH (CI's runners have Google Chrome, not chromium).
 */
export function findBrowser(): string {
  const set = process.env.DITHER_CHROMIUM;
  if (set) return set;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    const path = Bun.which(name);
    if (path) return path;
  }
  throw new Error('no browser found: install chromium or Google Chrome, or set DITHER_CHROMIUM to one');
}

/** args: extra Chromium flags, e.g. a fake microphone for call tests. */
export async function launch(opts: { caCert?: string; host?: string; args?: string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dither-browser-'));
  if (opts.caCert) {
    const nss = join(home, '.pki/nssdb');
    mkdirSync(nss, { recursive: true });
    const run = (...cmd: string[]) => Bun.spawnSync(['nix', 'shell', 'nixpkgs#nss.tools', '-c', 'certutil', ...cmd], { stderr: 'pipe' });
    run('-N', '-d', `sql:${nss}`, '--empty-password');
    const r = run('-A', '-d', `sql:${nss}`, '-t', 'C,,', '-n', 'dither-chat', '-i', opts.caCert);
    if (r.exitCode !== 0) throw new Error('certutil failed: ' + r.stderr.toString());
  }
  // Port 0: Chromium takes a free port itself and writes it to DevToolsActivePort in its own profile, so this never
  // attaches to another browser that happens to hold a port it guessed (other agents run headless Chromium too).
  const profile = join(home, 'profile');
  // Its stderr in a file of its own: when it does not start, that is the only account of why.
  const log = join(home, 'chromium.log');
  const err = openSync(log, 'w');
  const t0 = performance.now();
  const proc = Bun.spawn([findBrowser(), '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox', '--disable-gpu', ...(opts.args ?? []), 'about:blank'], {
    env: { ...process.env, HOME: home },
    stdout: 'ignore',
    stderr: err,
  });
  closeSync(err);
  let port = 0;
  let targets: any[] = [];
  // A fresh CI runner reads the browser's 670 MB from a cold disk on its first start: 11 to 35 s there, then half a
  // second. So it gets 90 s ($DITHER_CHROMIUM_START_MS) before it counts as not starting.
  const deadline = Date.now() + (Number(process.env.DITHER_CHROMIUM_START_MS) || 90_000);
  while (Date.now() < deadline && !targets.length && proc.exitCode === null) {
    await Bun.sleep(200);
    if (!port) port = Number(readFileOr(join(profile, 'DevToolsActivePort')).split('\n')[0]) || 0;
    if (port) targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json() as Promise<any[]>).catch(() => []);
  }
  const target = targets.find((t) => t.type === 'page');
  if (!target) {
    const after = ((performance.now() - t0) / 1000).toFixed(1);
    const state = proc.exitCode !== null ? `it exited with ${proc.exitCode}` : port ? `DevTools on ${port} but no page` : existsSync(profile) ? 'no DevToolsActivePort' : 'no profile dir';
    proc.kill('SIGKILL');
    await proc.exited;
    const tail = readFileOr(log).trim().split('\n').slice(-25).join('\n');
    rmSync(home, { recursive: true, force: true });
    throw new Error(`chromium did not start in ${after} s (${state}); its stderr ends:\n${tail || '(nothing)'}`);
  }
  const first = await attach(target.webSocketDebuggerUrl, port);
  const pages = [first];
  return {
    page: first.page,
    /** How long it took to start, to the first page's DevTools target. */
    startMs: Math.round(performance.now() - t0),
    /** The browser's own directory: every one of its processes has it on the command line. */
    profileDir: home,
    /** The DevTools port, for targets of its own (service workers, other pages). */
    port,
    /** Another page of the same browser (same profile, so the same service worker), in a window of its own if asked. */
    async newPage(url: string, o: { newWindow?: boolean } = {}): Promise<Page> {
      const { targetId } = await first.page.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: !!o.newWindow });
      let t: any;
      for (let i = 0; i < 50 && !t; i++) {
        t = ((await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())) as any[]).find((x) => x.id === targetId);
        if (!t) await Bun.sleep(100);
      }
      if (!t) throw new Error('no new page');
      const next = await attach(t.webSocketDebuggerUrl, port);
      pages.push(next);
      await next.page.goto(url);
      return next.page;
    },
    async close() {
      for (const p of pages) p.ws.close();
      proc.kill();
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A DevTools session with one page. */
async function attach(wsUrl: string, port: number): Promise<{ page: Page; ws: WebSocket }> {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let seq = 0;
  const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const listeners = new Map<string, ((p: any) => void)[]>();
  const errors: string[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id)!;
      waiting.delete(m.id);
      if (m.error) w.rej(new Error(`${m.error.message}`));
      else w.res(m.result);
    } else for (const fn of listeners.get(m.method) ?? []) fn(m.params);
  };
  const page: Page = {
    errors,
    on: (method, fn) => void listeners.set(method, [...(listeners.get(method) ?? []), fn]),
    send: (method, params) =>
      new Promise((res, rej) => {
        const id = ++seq;
        waiting.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    async eval(expr) {
      const r = await page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async evalWorker(url, expr) {
      const all = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())) as any[];
      const t = all.find((x) => x.type === 'service_worker' && x.url.includes(url));
      if (!t) throw new Error(`no service worker at ${url}`);
      const sw = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => ((sw.onopen = res), (sw.onerror = rej)));
      try {
        const answer = new Promise<any>((res) => (sw.onmessage = (e) => JSON.parse(String(e.data)).id === 1 && res(JSON.parse(String(e.data)))));
        sw.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
        const r = await answer;
        if (r.error || r.result?.exceptionDetails) throw new Error(r.error?.message ?? r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
        return r.result.result.value;
      } finally {
        sw.close();
      }
    },
    async goto(url) {
      await page.send('Page.navigate', { url });
      await Bun.sleep(300);
    },
    async shot(path) {
      await Bun.sleep(250);
      const r = await page.send('Page.captureScreenshot', { format: 'png' });
      await Bun.write(path, Buffer.from(r.data, 'base64'));
    },
    async size(width, height, mobile = false) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    },
    async until(expr, ms = 8000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await page.eval(expr).catch(() => false)) return;
        await Bun.sleep(100);
      }
      throw new Error(`timed out waiting for: ${expr}`);
    },
  };
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  page.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
  page.on('Log.entryAdded', (p) => p.entry?.level === 'error' && errors.push(p.entry.text));
  await page.send('Log.enable');
  return { page, ws };
}

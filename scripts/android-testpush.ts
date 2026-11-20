/**
 * Push for the emulator tests on a device with no UnifiedPush distributor (CI's emulator): apps/android/testpush, a
 * distributor with no server of its own, and its server here, on the computer. The hub sends its Web Push requests to
 * `http://127.0.0.1:<port>/up/<token>` as it would to ntfy's server, and each body goes to the device over adb, to the
 * distributor, which hands it to the app's connector as ntfy's app would. Everything on the app's side is real: the
 * connector's registration, its keys, its decryption, and the app's own handling. What it stands in for is ntfy: its
 * server, its connection to the phone, and its app.
 *
 * The hub must be told to send there: `approve` does that from the app's page, as Settings → Notifications → Push
 * servers would for a server on the owner's own network.
 */

const PKG = 'org.libdither.chat.testpush';
const RECEIVER = `${PKG}/.Distributor`;
const REGISTER = 'org.unifiedpush.android.distributor.REGISTER';

/** The distributors on the device, by package, as the app's connector finds them. */
export function distributors(sh: (cmd: string) => string): string[] {
  const out = sh(`cmd package query-receivers --brief -a ${REGISTER}`);
  return [...out.matchAll(/^\s*([a-zA-Z0-9_.]+)\/\S+$/gm)].map((m) => m[1]);
}

/**
 * Installs the test distributor and starts its server. `adb` is the device's adb with its serial, as a command line.
 * A copy left by an earlier run that died is replaced; `stop` takes it off again.
 */
export async function testPush(o: { adb: string[]; apk: string }) {
  const run = async (...cmd: string[]) => {
    const p = Bun.spawn([...o.adb, ...cmd], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`adb ${cmd.join(' ').slice(0, 120)}: ${err.trim() || out.trim()}`);
    return out;
  };
  await run('install', '-r', o.apk);

  /** Each request the hub made, and what became of it: for a failing check to show. */
  const seen: { at: number; token: string; bytes: number; status: number }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const token = new URL(req.url).pathname.match(/^\/up\/([A-Za-z0-9_-]+)$/)?.[1];
      if (req.method !== 'POST' || !token) return new Response('not found', { status: 404 });
      const body = Buffer.from(await req.arrayBuffer());
      // The distributor answers 200 when an app has the token, and 404 when none does: the endpoint is gone, as ntfy's
      // server says of a topic that was unsubscribed.
      const out = await run('shell', `am broadcast -n ${RECEIVER} -a ${PKG}.DELIVER --es token ${token} --es b64 ${body.toString('base64')}`).catch((e) => String(e));
      const status = /result=200\b/.test(out) ? 201 : /result=404\b/.test(out) ? 404 : 502;
      seen.push({ at: Date.now(), token, bytes: body.length, status });
      return new Response(status === 201 ? null : out.trim(), { status });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  // Where the server is; this broadcast also takes a fresh install out of the stopped state, so the connector's
  // REGISTER reaches it.
  const said = await run('shell', `am broadcast --include-stopped-packages -n ${RECEIVER} -a ${PKG}.SERVER --es url ${url}`);
  if (!/Broadcast completed/.test(said)) throw new Error(`the test distributor did not take its server: ${said.trim()}`);

  return {
    url,
    seen,
    /** Lets the hub send to this server, from the app's page (`page` evaluates in it), as the owner would. */
    async approve(page: <T>(expr: string) => Promise<T | null>): Promise<boolean> {
      const r = await page<number>(
        `fetch('/api/push/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: ${JSON.stringify(url)}, typed: true, allowPrivate: true }) }).then((r) => r.status)`,
      );
      return r === 200;
    },
    async stop() {
      server.stop(true);
      await run('uninstall', PKG).catch(() => {});
    },
  };
}

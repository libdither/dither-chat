/**
 * Sending a photo (docs/uploads.md, "Pictures that sharpen" and "A send the hub holds"), end to end against a demo hub
 * of its own in headless Chromium, the page reaching it through a link the test can cut (link-proxy.ts):
 *
 *   - a pasted JPEG is made progressive in the browser (jpegtran, wasm, in a worker): the hub's copy is a progressive
 *     JPEG with the same picture;
 *   - its pieces go only as the test lets them (DevTools holds each PUT): the tile shows the hub's copy, blurry at
 *     first, and its badge says the quality the hub has, preview then fair then good, from the hub's own count;
 *   - sent while it uploads, the send is the hub's (its queue row waits for the file): the pending copy shows the tile
 *     and "Sending · …"; once the last piece lands the hub sends it whole;
 *   - a second photo sent the same way, and the link cut partway: the pending copy says what the hub has and when it
 *     sends; the hub sends it as far as it came after Settings → Sending's wait (one minute here), cut after a whole
 *     layer; back online, the page shows the message and says it went as it was;
 *   - Settings → Sending shows the hub's choice.
 *
 *   bun scripts/verify-pictures.ts [--shots <dir>]
 * Starts its own hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CUT_FAIR, cutQuality, jpegLayers, seesEnd } from '@dither-chat/protocol';
import { launch } from './browser.ts';
import { linkProxy } from './link-proxy.ts';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : '';
if (shots) mkdirSync(shots, { recursive: true });
const REPO = resolve(import.meta.dir, '..');
const data = mkdtempSync(join(tmpdir(), 'dither-pictures-hub-'));
const port = await new Promise<number>((done) => {
  const s = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  });
  const p = s.port;
  s.stop(true);
  done(p);
});
const hubUrl = `http://127.0.0.1:${port}`;
const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];

let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
async function until<T>(what: string, f: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve()
      .then(f)
      .catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
const json = async (path: string, init?: RequestInit) => {
  const r = await fetch(hubUrl + path, init);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<any>;
};

const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
  cwd: REPO,
  env: {
    ...process.env,
    DITHER_CALENDAR_URL: 'off',
    DITHER_DEMO_CHATTER: '0',
  },
  stdout: 'ignore',
  stderr: 'inherit',
});
const link = await linkProxy(port);
const url = `http://127.0.0.1:${link.port}`;
const { page: p, close } = await launch();

// ------------------------------------------------------------------ the upload's pieces, held until let go

type Paused = {
  requestId: string;
  url: string;
  method: string;
  offset: number;
};
const held: Paused[] = [];
/** Pieces let go, by upload id: the offsets the page sent, in order. */
const went = new Map<string, number[]>();
/** While the link is cut, every piece fails at once, as it would with no network. */
let cut = false;
/** The page's sends as the hub answered them, with the words each carried: the first ask, and any asking again. */
const sends: { body: string; status: number; held: boolean }[] = [];
p.on('Fetch.requestPaused', (e) => {
  const r = e.request as { url: string; method: string };
  if (r.method !== 'PUT') return void p.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
  if (cut)
    return void p
      .send('Fetch.failRequest', {
        requestId: e.requestId,
        errorReason: 'InternetDisconnected',
      })
      .catch(() => {});
  held.push({
    requestId: e.requestId,
    url: r.url,
    method: r.method,
    offset: Number(new URL(r.url).searchParams.get('offset')),
  });
});
const sendBodies = new Map<string, string>();
p.on('Network.requestWillBeSent', (e) => {
  if (!/\/api\/conversations\/[^/]+\/send$/.test(e.request.url)) return;
  sendBodies.set(e.requestId, JSON.parse(e.request.postData ?? '{}').body ?? '');
});
const sendStatus = new Map<string, number>();
p.on('Network.responseReceived', (e) => {
  if (sendBodies.has(e.requestId)) sendStatus.set(e.requestId, e.response.status);
});
// Its queue row, once the answer is all in: whether the hub took it waiting for its files.
p.on('Network.loadingFinished', (e) => {
  const body = sendBodies.get(e.requestId);
  const status = sendStatus.get(e.requestId);
  if (body === undefined || status === undefined) return;
  void p.send('Network.getResponseBody', { requestId: e.requestId }).then(
    (r: any) => {
      let row: { filesComing?: boolean } | undefined;
      try {
        row = JSON.parse(r.body).row;
      } catch {}
      sends.push({ body, status, held: row?.filesComing === true });
    },
    () => sends.push({ body, status, held: false }),
  );
});
/** The first answer to the send with these words. */
const firstSend = (body: string) => until(`the send of "${body}" to reach the hub`, () => sends.find((x) => x.body === body));
const uploadId = (u: string) => new URL(u).pathname.split('/').pop()!;
/**
 * How much of this upload the hub has. Once its last piece lands, a held send waiting on it goes at once, and the hub
 * answers 410 `sent` from then on (uploads.ts `sentAlready`): all of it, as far as the page is concerned.
 */
async function received(id: string, size: number): Promise<number> {
  const r = await fetch(`${hubUrl}/api/uploads/${id}`);
  const j = (await r.json()) as any;
  if (r.status === 410 && j.sent) return size;
  if (!r.ok) throw new Error(`/api/uploads/${id}: ${r.status}`);
  return j.received as number;
}
/** Let the next piece of this upload go, and wait for the hub to have it. */
async function letGo(id: string, size: number): Promise<number> {
  const h = await until(`a piece of ${id}`, () => held.find((x) => uploadId(x.url) === id));
  held.splice(held.indexOf(h), 1);
  went.set(id, [...(went.get(id) ?? []), h.offset]);
  const before = await received(id, size);
  await p.send('Fetch.continueRequest', { requestId: h.requestId });
  return until(`the hub to take the piece at ${h.offset}`, async () => {
    const got = await received(id, size);
    return got > before ? got : null;
  });
}

// ------------------------------------------------------------------ the page

/** The photo's badge: in the composer, then on the pending copy once it is sent. */
const badge = () => p.eval<string>(`document.querySelector('.composer .up-badge, .pending .up-badge')?.textContent ?? ''`);
const pendLine = () => p.eval<string>(`document.querySelector('.pending .pend-line')?.textContent ?? ''`);
/** The upload the composer's newest photo has, from the hub's list of what the page started. */
const startedIds: string[] = [];
p.on('Network.responseReceived', (e) => e.response.url.endsWith('/api/uploads/start') && startedIds.push(e.requestId));
async function startedUpload(n: number): Promise<{ id: string; size: number }> {
  await until(`upload ${n} to start`, () => startedIds.length >= n);
  const body = await until(`upload ${n}'s answer`, () => p.send('Network.getResponseBody', { requestId: startedIds[n - 1] }).catch(() => null));
  const { id } = JSON.parse(body.body) as { id: string };
  const st = await json(`/api/uploads/${id}`);
  return { id, size: st.size };
}

/** A photo made in the page: a gradient, shapes and fine grain, so it is a few hundred KB of JPEG with several layers. */
async function paste(seed: number, name: string) {
  await p.eval(`(async () => {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1200;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1600, 1200);
    g.addColorStop(0, 'hsl(${(seed * 67) % 360} 70% 55%)'); g.addColorStop(1, 'hsl(${(seed * 67 + 150) % 360} 70% 35%)');
    x.fillStyle = g; x.fillRect(0, 0, 1600, 1200);
    x.fillStyle = '#fff8'; x.beginPath(); x.arc(${500 + seed * 90}, 520, 300, 0, 7); x.fill();
    x.fillStyle = '#0006'; x.fillRect(900, ${300 + seed * 40}, 500, 380);
    const img = x.getImageData(0, 0, 1600, 1200); let s = ${seed * 7919 + 1};
    for (let i = 0; i < img.data.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const n = (s % 48) - 24; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
    x.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const dt = new DataTransfer(); dt.items.add(new File([blob], ${JSON.stringify(name)}, { type: 'image/jpeg' }));
    const ta = document.querySelector('.composer textarea'); ta.focus();
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return blob.size;
  })()`);
}
const typeIn = async (text: string) => {
  await p.eval(`document.querySelector('.composer textarea').focus()`);
  await p.send('Input.insertText', { text });
};
const enter = async () => {
  await p.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
  });
  await p.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  });
};
/** A screenshot for the PR, with the demo's own toasts dismissed so they cover nothing. */
const shot = async (name: string) => {
  if (!shots) return;
  await p.eval(`document.querySelectorAll('.toast .toast-x').forEach((x) => x.click())`);
  await p.until(`!document.querySelector('.toast')`, 3000).catch(() => {});
  await p.shot(join(shots, `${name}.png`));
};
/** Our message with this caption on the hub, once it is there. */
const onHub = (conv: string, body: string) =>
  json(`/api/conversations/${conv}/messages?limit=30`).then((r) => (r.messages as any[]).find((m) => m.body === body && m.attachments?.length) ?? null);
async function hubBytes(m: any): Promise<Uint8Array> {
  const u = m.attachments[0].url as string;
  // The demo network keeps what it was sent as a data: URL; a real one gives the hub's /media/ address.
  if (u.startsWith('data:')) return new Uint8Array(Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'));
  const r = await fetch(u.startsWith('http') ? u : hubUrl + u);
  if (!r.ok) throw new Error(`the picture at ${u.slice(0, 60)}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

try {
  await until('the hub to answer', () => fetch(`${hubUrl}/api/health`).then((r) => r.ok));
  await until('the demo accounts', async () => (await json('/api/bootstrap')).accounts.every((a: any) => a.status === 'online'));
  const boot = await json('/api/bootstrap');
  if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
  const media = new Set(boot.accounts.filter((a: any) => a.network === 'discord' && a.capabilities.includes('sendMedia')).map((a: any) => a.id));
  const conv = boot.conversations.find((c: any) => c.shape === 'direct' && c.network === 'discord' && c.vantages.some((v: any) => media.has(v.accountId)));
  if (!conv) throw new Error('no Discord direct conversation to send in');

  // One minute, as long as a picture is at least fair: the shortest wait Settings offers.
  check((await json('/api/sending/cut')).afterMs === 300_000, 'the hub waits five minutes by default');
  await json('/api/sending/cut', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ afterMs: 60_000, atLeast: 'fair' }),
  });

  await p.size(1280, 900);
  await p.send('Network.enable');
  await p.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/uploads/*', requestStage: 'Request' }],
  });
  await p.goto(`${url}/#/inbox/c/${conv.id}`);
  await p.until(`!!document.querySelector('.composer textarea')`, 30_000);

  // ---------------------------------------------------------------- 1. a photo, sharpening, sent whole
  {
    await paste(1, 'garden.jpg');
    const up = await startedUpload(1);
    const packedAs = await p.eval<string>(`document.querySelector('.composer .up-badge')?.textContent ?? ''`);
    check(up.size > 0, 'the photo starts uploading', up);
    await until('the first piece', () => held.some((h) => uploadId(h.url) === up.id));
    check(held.find((h) => uploadId(h.url) === up.id)?.offset === 0, 'it goes from the start', packedAs);
    const labels: string[] = [];
    const counts: number[] = [];
    /** The badge once it shows the hub's count (its percent), or gone once the hub has it all. */
    const note = async (got: number) => {
      const pct = `${Math.floor((got / up.size) * 100)}%`;
      labels.push(
        await until(
          `the badge at ${pct}`,
          async () => {
            const t = await badge();
            return (got >= up.size ? !/%/.test(t) : t.endsWith(` ${pct}`) || t === pct) ? t || 'none' : null;
          },
          10_000,
        ),
      );
    };
    let got = 0;
    let shotPreview = false;
    let shotFair = false;
    let sentAt = -1;
    while (got < up.size) {
      got = await letGo(up.id, up.size);
      counts.push(got);
      await note(got);
      const label = labels.at(-1)!;
      if (!shotPreview && /preview/.test(label)) {
        shotPreview = true;
        check(await p.eval(`!!document.querySelector('.composer .up-tile img.up-hub')`), "at preview the tile shows the hub's copy, not the dither");
        await shot('composer-preview');
      }
      if (!shotFair && /fair/.test(label)) {
        shotFair = true;
        await shot('composer-fair');
        // Send now: the hub takes it from here.
        await typeIn('[pictures] the garden');
        await enter();
        const first = await firstSend('[pictures] the garden');
        sentAt = got;
        check(first.held, 'sent mid-upload, the hub takes the send at once, waiting for its file', first);
        await p.until(`!!document.querySelector('.pending .pend-tile')`, 10_000);
        const line = await until('the pending line', async () => ((await pendLine()).startsWith('Sending') ? pendLine() : null), 10_000);
        check(/^Sending · .+ of .+/.test(line), 'the pending copy says how much is up', line);
        await shot('pending-sending');
      }
    }
    const m = await until('the message on the hub', () => onHub(conv.id, '[pictures] the garden'), 20_000);
    const b = await hubBytes(m);
    const layers = jpegLayers(b);
    check(b.length === up.size && !!layers?.ends.length && layers.ends.at(-1) === b.length - 2, 'the hub sent it whole, as a progressive JPEG', {
      size: b.length,
      layers: layers?.ends.length,
    });
    // What the hub had at each step, from the picture's own layers: the last one whose next marker it had.
    const want = counts.map((n) => {
      if (n >= up.size || !layers) return 'none';
      const keep = Math.max(0, ...layers.ends.filter((e) => seesEnd(e, n)));
      return cutQuality(keep, up.size, layers) ?? '';
    });
    const said = labels.map((l) => (l === 'none' ? 'none' : (/^(preview|fair|good)/.exec(l)?.[1] ?? '')));
    check(said.join() === want.join(), 'at every piece the badge says what the hub could send', { said: labels, want });
    check(said.includes('preview') && said.includes('fair'), 'it sharpens: a preview first, then fair', labels);
    check(sentAt > 0 && sentAt < up.size, 'it was sent before the last piece', {
      sentAt,
      size: up.size,
    });
    const offs = went.get(up.id)!;
    check(
      offs.every((o, i) => i === 0 || o > offs[i - 1]),
      'no piece went twice',
      offs,
    );
    await p.until(`!document.querySelector('.pending .pend-tile') && !!document.querySelector('#m-${m.id}')`, 15_000);
    check(true, 'the page swaps the pending copy for the message');
    // The demo's person answers each message a few seconds later. The next send is pressed with that answer in view,
    // so the chat has not moved on when it goes (else it waits for you: docs/sync.md "The send queue").
    const answer = await until(
      'their answer to it',
      () => json(`/api/conversations/${conv.id}/messages?limit=30`).then((r) => (r.messages as any[]).find((x) => x.ts > m.ts && x.id !== m.id && !x.attachments?.length) ?? null),
      20_000,
    );
    await p.until(`!!document.querySelector('#m-${answer.id}')`, 15_000);
  }

  // ---------------------------------------------------------------- 2. the link cut partway: the hub sends what it has
  {
    await paste(2, 'harbour.jpg');
    const up = await startedUpload(2);
    let got = 0;
    // Up to fair, and a piece more.
    for (;;) {
      got = await letGo(up.id, up.size);
      if (got / up.size > CUT_FAIR + 0.05) break;
    }
    await typeIn('[pictures] the harbour');
    await enter();
    const second = await firstSend('[pictures] the harbour');
    check(second.held, 'the second send waits for its file on the hub too', second);
    const cutFrom = got;

    // The link goes: no more pieces, no socket.
    cut = true;
    for (const h of held.splice(0))
      await p
        .send('Fetch.failRequest', {
          requestId: h.requestId,
          errorReason: 'InternetDisconnected',
        })
        .catch(() => {});
    link.stall(() => true, true);
    link.cut();
    const lost = await until('the page to say the link is lost', async () => ((await pendLine()).startsWith('Link lost') ? pendLine() : null), 30_000);
    check(/the hub has at least (fair|good) · sends as is in \d:\d\d/.test(lost), 'the pending copy says what the hub has and when it sends', lost);
    await shot('pending-link-lost');

    const m = await until('the hub to send it as far as it came', () => onHub(conv.id, '[pictures] the harbour'), 100_000).catch(async (e) => {
      const { Database } = await import('bun:sqlite');
      const db = new Database(join(data, 'hub.sqlite'), { readonly: true });
      console.log('upload', JSON.stringify(await json(`/api/uploads/${up.id}`).catch((x) => String(x))));
      console.log('queue', JSON.stringify(db.query(`SELECT client_id, state, files_coming, cut, error, hold_reason, updated_at FROM send_queue`).all()));
      db.close();
      const { readdirSync, readFileSync } = await import('node:fs');
      const { jpegCut, jpegLayers: lay } = await import('@dither-chat/protocol');
      const dirs = (function find(d: string): string[] {
        return readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? find(join(d, x.name)) : x.name === up.id ? [d] : []));
      })(data);
      for (const d of dirs) {
        const meta = JSON.parse(readFileSync(join(d, `${up.id}.json`), 'utf8'));
        console.log(
          'meta',
          JSON.stringify(meta),
          'idle',
          Date.now() - meta.at,
          'cut',
          JSON.stringify(jpegCut(new Uint8Array(readFileSync(join(d, up.id))), meta.size)),
          'ends',
          JSON.stringify(lay(new Uint8Array(readFileSync(join(d, up.id))))),
        );
        console.log('offsets', JSON.stringify(went.get(up.id)));
      }
      throw e;
    });
    const b = await hubBytes(m);
    const layers = jpegLayers(b);
    const whole = !!layers?.ends.length && layers.ends.at(-1) === b.length - 2;
    const q = layers ? cutQuality(b.length - 2, up.size, layers) : null;
    check(
      b.length < up.size && b.length <= cutFrom + 2 && whole && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9,
      'it sent the photo cut after its last whole layer',
      { sent: b.length, had: cutFrom, size: up.size },
    );
    check(q === 'fair' || q === 'good', 'at least fair, as Settings asked', q);

    // Back online: the page asks again, and gets the message.
    // As a phone back on a network: the connections it had are gone, and new ones get through.
    cut = false;
    link.clear();
    link.cut();
    await p.until(`!document.querySelector('.pending .pend-tile') && !!document.querySelector('#m-${m.id}')`, 60_000).catch(async (e) => {
      console.log(
        'page',
        JSON.stringify(
          await p.eval(
            `({ pend: !!document.querySelector('.pending .pend-tile'), msg: !!document.querySelector('#m-${m.id}'), line: document.querySelector('.pend-line')?.textContent, note: document.querySelector('.pending')?.textContent?.slice(0, 200) })`,
          ),
        ),
      );
      throw e;
    });
    const said = await p.eval<string>(`document.querySelector('#m-${m.id}')?.textContent ?? ''`);
    check(true, 'back online, the page shows the message', said.slice(0, 80));
    await shot('sent-cut');
  }

  // ---------------------------------------------------------------- 3. Settings → Sending
  {
    await p.goto(`${url}/#/settings`);
    await p.until(`!!document.querySelector('#set-sending [data-wait]:not([disabled])')`, 20_000);
    const on = () =>
      p.eval<{ wait: string; quality: string }>(
        `({ wait: document.querySelector('#set-sending [data-wait].on')?.dataset.wait, quality: document.querySelector('#set-sending [data-quality].on')?.dataset.quality })`,
      );
    check(JSON.stringify(await on()) === JSON.stringify({ wait: '60000', quality: 'fair' }), 'Settings → Sending shows what the hub keeps', await on());
    // Picked here, kept on the hub.
    await p.eval(`document.querySelector('#set-sending [data-quality="good"]').click()`);
    await until('the hub to keep "good"', async () => (await json('/api/sending/cut')).atLeast === 'good');
    await p.eval(`document.querySelector('#set-sending [data-wait="null"]').click()`);
    const kept = await until('the hub to keep "never"', async () => ((await json('/api/sending/cut')).afterMs === null ? json('/api/sending/cut') : null));
    check(kept.atLeast === 'good', 'a choice here is kept on the hub', kept);
    await p.until(`document.querySelector('#set-sending [data-quality="good"]').disabled`, 5000);
    check(true, 'with Never, the quality has no say and is greyed out');
    await p.eval(`document.querySelector('#set-sending [data-wait="300000"]').click()`);
    await until('the hub back at five minutes', async () => (await json('/api/sending/cut')).afterMs === 300_000);
    await p.eval(`document.querySelector('#set-sending').scrollIntoView({ block: 'center' })`);
    await shot('settings-sending');
  }
  // The requests and the socket the cut link broke are logged as failed loads, and so is the hub's "sent already"
  // (410) to the phone back online; anything else is the page's own.
  const own = p.errors.filter(
    (e) => !/^Failed to load resource: net::ERR_|^WebSocket connection to .* failed|status of 410 \(Gone\) \S+\/api\/uploads\//.test(e),
  );
  check(own.length === 0, 'no page errors', own.slice(0, 3));
} catch (e) {
  failed++;
  console.log(`FAIL ${(e as Error).message}`);
} finally {
  await close();
  await link.close();
  hub.kill();
  await hub.exited;
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

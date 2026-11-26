/**
 * Editing a message you sent (docs/chats.md, "Where a message goes"), end to end against a demo hub of its own in headless
 * Chromium: Edit fills the box, Enter changes the message on the network and sends nothing new, and the draft you had
 * comes back. From the message's own chat, from a person's page (Edit opens the chat and its box takes the edit),
 * and from a person's chat on another of their routes (the box goes to the message's route). Esc ends an edit and
 * changes nothing.
 *
 *   bun scripts/verify-edit.ts
 * Starts its own hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const data = mkdtempSync(join(tmpdir(), 'dither-edit-hub-'));
const port = await new Promise<number>((done) => {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  done(p);
});
const url = `http://127.0.0.1:${port}`;
const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];

let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
  cwd: REPO,
  env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0' },
  stdout: 'ignore',
  stderr: 'inherit',
});
const { page: p, close } = await launch();

type Msg = { id: string; authorId: string; body: string; editedTs?: number | null };
let self = new Set<string>();
/** Your messages in a conversation that carry this tag, as the hub has them. */
const tagged = async (conv: string, tag: string) => {
  const r = (await (await fetch(`${url}/api/conversations/${conv}/messages?limit=50`)).json()) as { messages: Msg[] };
  return r.messages.filter((m) => self.has(m.authorId) && m.body.includes(tag));
};
/** The app's sends and edits, in the order it made them (an init script wraps fetch before the app loads). */
const posts = () => p.eval<string[]>(`window.__posts.slice()`);
const box = () => p.eval<string>(`document.querySelector('.composer textarea')?.value ?? ''`);
const typeIn = async (text: string, replace = false) => {
  await p.eval(`(() => { const t = document.querySelector('.composer textarea'); t.focus(); ${replace ? 't.select();' : 't.setSelectionRange(t.value.length, t.value.length);'} })()`);
  await p.send('Input.insertText', { text });
};
const key = async (k: 'Enter' | 'Escape') => {
  const code = k === 'Enter' ? 13 : 27;
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code, ...(k === 'Enter' ? { text: '\r' } : {}) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code });
};
/**
 * Send this through the box (in place of what it holds), and wait for the hub and the timeline to have it (the
 * timeline row with the hub's id).
 */
async function sendNow(conv: string, text: string, tag: string) {
  const before = (await tagged(conv, tag)).length;
  if ((await box()) !== text) await typeIn(text, true);
  await key('Enter');
  const [m] = await until(`"${text}" on the hub`, async () => {
    const l = (await tagged(conv, tag)).filter((x) => x.body === text);
    return l.length && (await tagged(conv, tag)).length > before ? l : null;
  });
  await p.until(`!!document.querySelector('#m-${m.id} [data-track="edit"]')`, 15_000);
  return m;
}
/** Wait for the box to show this. */
const boxIs = async (want: string, what: string) => {
  await until(what, async () => (await box()) === want);
  return box();
};

/**
 * One edit: open `open`, keep a draft in the box (except where the box's chat is not the message's), send a message
 * on `conv` from `sendFrom`, Edit it, and send the edit. Then a marker through the same box: any stray send from the
 * edit's Enter was made before it.
 */
async function edit(name: string, o: { sendFrom: string; open: string; conv: string; draft: boolean }) {
  const tag = `[${name}]`;
  await p.goto(`${url}/${o.sendFrom}`);
  await p.until(`!!document.querySelector('.composer textarea')`, 20_000);
  const m = await sendNow(o.conv, `${tag} see you tomorow`, tag);
  if (o.open !== o.sendFrom) {
    await p.goto(`${url}/${o.open}`);
    await p.until(`!!document.querySelector('#m-${m.id} [data-track="edit"]')`, 20_000);
  }
  const draft = o.draft ? `${tag} half written` : '';
  if (draft) await typeIn(draft);
  await boxIs(draft, `the draft in the box (${name})`);
  const start = (await posts()).length;
  await p.eval(`document.querySelector('#m-${m.id} [data-track="edit"]').click()`);
  const shown = await boxIs(m.body, `the message's words in the box (${name})`);
  check(shown === m.body, `${name}: Edit puts the message's words in the box`, shown);
  check((await p.eval<string>('location.hash')).includes(o.conv), `${name}: the message's chat is open`, await p.eval('location.hash'));
  const fixed = `${tag} see you tomorrow`;
  await typeIn(fixed, true);
  await key('Enter');
  await until(`the edit, or a new message, on the hub (${name})`, async () => {
    const l = await tagged(o.conv, tag);
    return l.length > 1 || l.some((x) => x.id === m.id && x.body === fixed);
  });
  const after = await tagged(o.conv, tag);
  check(after.length === 1 && after[0].body === fixed, `${name}: Enter changed the message and sent no new one`, after.map((x) => x.body));
  if (after.length !== 1) return;
  check((await boxIs(draft, `the draft back in the box (${name})`)) === draft, `${name}: the draft comes back after the edit`);
  const marker = `${tag} marker`;
  await sendNow(o.conv, marker, tag);
  const made = (await posts()).slice(start);
  check(made.length === 2 && made[0] === `edit ${m.id}` && made[1] === `send ${o.conv}`, `${name}: Enter sent the edit and nothing else`, made);
  const all = await tagged(o.conv, tag);
  check(all.length === 2 && all.some((x) => x.id === m.id && x.body === fixed && x.editedTs), `${name}: one message, edited, and the marker`, all.map((x) => x.body));
}

try {
  await until('the hub to answer', () => fetch(`${url}/api/health`).then((r) => r.ok));
  const boot = (await (await fetch(`${url}/api/bootstrap`)).json()) as any;
  if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
  self = new Set(boot.accounts.map((a: any) => a.selfIdentityId));
  const direct = (person: string, net: string) => {
    const per = boot.persons.find((x: any) => x.name === person);
    const c = boot.conversations.find((c: any) => c.shape === 'direct' && c.peerPersonId === per?.id && c.network === net);
    if (!c) throw new Error(`no ${net} direct with ${person} in the demo`);
    return { conv: c.id as string, person: per.id as string };
  };
  await p.size(1280, 900);
  await p.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__posts = []; const f = window.fetch; window.fetch = function (u, init) {
      const m = String(u).match(/\\/api\\/(?:conversations\\/([\\w-]+)\\/send|messages\\/([\\w-]+)\\/edit)$/);
      if (m && (init?.method ?? 'POST') === 'POST') window.__posts.push(m[1] ? 'send ' + m[1] : 'edit ' + m[2]);
      return f.apply(this, arguments);
    };`,
  });

  // One route: Mom on Signal.
  const mom = direct('Mom', 'signal');
  await edit('own chat', { sendFrom: `#/inbox/c/${mom.conv}`, open: `#/inbox/c/${mom.conv}`, conv: mom.conv, draft: true });
  await edit('person page', { sendFrom: `#/people/${mom.person}`, open: `#/people/${mom.person}`, conv: mom.conv, draft: true });
  // Several routes: Alice's chat opened at her Discord DM, editing a message sent on Signal. The box goes to Signal,
  // whose draft is empty, so no draft is kept for this one.
  const alice = direct('Alice Chen', 'signal');
  const aliceDiscord = direct('Alice Chen', 'discord');
  await edit('other route', { sendFrom: `#/inbox/c/${alice.conv}`, open: `#/inbox/c/${aliceDiscord.conv}`, conv: alice.conv, draft: false });

  // Esc ends an edit: the draft is back, and nothing went to the hub.
  {
    const tag = '[esc]';
    await p.goto(`${url}/#/people/${mom.person}`);
    await p.until(`!!document.querySelector('.composer textarea')`, 20_000);
    const m = await sendNow(mom.conv, `${tag} sent as is`, tag);
    await p.goto(`${url}/#/people/${mom.person}`);
    await p.until(`!!document.querySelector('#m-${m.id} [data-track="edit"]')`, 20_000);
    await typeIn(`${tag} kept`);
    const start = (await posts()).length;
    await p.eval(`document.querySelector('#m-${m.id} [data-track="edit"]').click()`);
    await boxIs(m.body, 'the message in the box (esc)');
    await typeIn(' changed');
    await key('Escape');
    check((await boxIs(`${tag} kept`, 'the draft back (esc)')) === `${tag} kept`, 'esc: the draft comes back');
    await sendNow(mom.conv, `${tag} kept`, tag);
    const made = (await posts()).slice(start);
    check(made.length === 1 && made[0] === `send ${mom.conv}`, 'esc: nothing sent but the draft, sent after', made);
    check((await tagged(mom.conv, tag)).find((x) => x.id === m.id)?.body === m.body, 'esc: the message is unchanged');
  }
  check(p.errors.length === 0, 'no page errors', p.errors.slice(0, 3));
} catch (e) {
  failed++;
  console.log(`FAIL ${(e as Error).message}`);
} finally {
  await close();
  hub.kill();
  await hub.exited;
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

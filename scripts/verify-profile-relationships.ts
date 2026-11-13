/**
 * Connections (docs/profile.md "Connections"): how your accounts stand with someone, in one vocabulary across networks,
 * in a real browser against a demo hub of its own on a fresh data dir. In the demo world you are friends with Alice on
 * both Discord accounts and have her in your Telegram, Signal and WhatsApp contacts; on X you follow each other with
 * Alice and Nora, you follow Quinn, Ravi follows you, a friend request to Mara waits and Owl is blocked.
 *
 *   bun scripts/verify-profile-relationships.ts [--port 8698] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 *
 * Checks, on a desktop and a phone: GET /api/people has X's mutual follows among Friends and every follow under
 * Following, from the profiles X showed; a profile's hero has one tag per kind with the networks it is on (Friend
 * with Discord and X, Contact with Telegram, Signal and WhatsApp), and no button that only says how you stand; its
 * Connections card groups each account's connection by kind in the network's own words ("You follow each other on
 * X"), as lists, with Remove friend where the account can, each button named for its account, and no Unfollow or
 * Follow on X, which cannot; the tags have their words for a screen reader; About keeps the follower counts and no
 * longer says Follows you; one-way follows, a request sent and a block read the same way; People's Friends has the X
 * mutuals beside the Discord friends and Following has the follows; nothing sideways on a phone; nothing sent to any
 * network (X's writeLog, every other account's addLog) until, clicked: Remove friend on Jordan and Unblock on Owl,
 * each then Add friend, which says Request sent, and the networks got exactly a remove and an add each; no script
 * errors.
 */
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8698'));
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-connections-${PORT}-`));
mkdirSync(work, { recursive: true });
const shots = opt('shots', '');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
async function until(fn: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}
const json = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init).then((r) => r.json()) as Promise<any>;
const post = (path: string, body: unknown) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const action = (account: string, name: string) => post(`/api/accounts/${account}/action`, { action: name });

let web = opt('web', '');
if (!web) {
  web = join(work, 'web');
  console.log('building the web app…');
  const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'pipe', stderr: 'pipe' });
  if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
}
if (Bun.spawnSync(['sh', '-c', `ss -ltn | grep -q ':${PORT} '`]).exitCode === 0) throw new Error(`something is already listening on ${PORT}`);
if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${PORT}`);
const log = openSync(join(work, 'hub.log'), 'a');
const hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', join(work, 'data'), '--port', String(PORT), '--host', '127.0.0.1', '--web', web], {
  env: { ...process.env, DITHER_DEMO_CHATTER: '0' },
  stdout: log,
  stderr: log,
});
await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
let boot = await json('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
await until(async () => (boot = await json('/api/bootstrap')).conversations.some((c: any) => c.variant === 'feed'), 15_000, 'no feed conversation');
const idn = (network: string, handle: string) => boot.identities.find((i: any) => i.network === network && i.handle === handle);
const nora = idn('x', 'nora_on_nets');
const quinn = idn('x', 'quinnwrites');
const raviX = idn('x', 'ravi_routes');
const aliceX = idn('x', 'alicechen_dev');
const mara = idn('discord', 'mara');
const owl = idn('discord', 'oxidized_owl');
const alice = boot.persons.find((p: any) => p.name === 'Alice Chen' && p.identityIds.length > 3);

const { page, close } = await launch();
const load = async (hash: string) => {
  await page.goto('about:blank');
  await page.goto(`${base}/${hash}`);
};
/** A profile, once the networks have answered. A tag's words leave out what only a screen reader hears (`said`). */
const profile = async (hash: string) => {
  await load(hash);
  await page.until(`!!document.querySelector('.pf-hero, .pf-tags') && !document.querySelector('.pf-asking')`, 20000);
  await Bun.sleep(300);
  return page.eval<any>(`({
    tags: [...document.querySelectorAll('.pf-tags .pf-tag[data-kind]')].map((t) => ({
      kind: t.dataset.kind,
      text: [...t.childNodes].filter((n) => !n.classList?.contains('sr-only')).map((n) => n.textContent).join(''),
      nets: t.dataset.networks,
      said: t.querySelector('.sr-only')?.textContent ?? null,
      glyphsHidden: [...t.querySelectorAll('svg.net-glyph')].every((s) => s.getAttribute('aria-hidden') === 'true'),
    })),
    title: document.querySelector('.pf-standing h3')?.textContent ?? null,
    groups: [...document.querySelectorAll('.pf-standing .pf-conn-group')].map((g) => g.dataset.kind),
    lists: [...document.querySelectorAll('.pf-standing .pf-conn-group')].map((g) => g.querySelector('ul')?.getAttribute('aria-label') ?? null),
    rows: [...document.querySelectorAll('.pf-standing .pf-link-row')].map((r) => ({ kind: r.dataset.kind, net: r.dataset.network, account: r.dataset.account, item: r.tagName === 'LI' && r.parentElement.tagName === 'UL', text: r.querySelector('b').textContent, remove: r.querySelector('[data-remove]')?.textContent ?? null, label: r.querySelector('[data-remove]')?.getAttribute('aria-label') ?? null })),
    stateButtons: document.querySelectorAll('.pf-action[data-action="relationship"]').length,
    follow: document.querySelector('.pf-action[data-action="follow"]')?.textContent ?? null,
    counts: document.querySelector('.pf-follow')?.textContent ?? '',
  })`);
};
const overflow = () => page.eval<number>(`Math.max(...[document.scrollingElement, ...document.querySelectorAll('.profile-scroll, .pf-page, .side-scroll')].filter(Boolean).map((s) => s.scrollWidth - s.clientWidth))`);

try {
  // ------------------------------------------------------------------ the hub's lists
  const friends = await json('/api/people?relationship=friend');
  const xFriends = friends.links.filter((l: any) => l.accountId === 'acc_demo-x');
  check('Friends has the X accounts you follow each other with, from their profiles', xFriends.length === 2 && xFriends.every((l: any) => l.relationship === 'following' && l.followsYou && l.from === 'profile') && [nora.id, aliceX.id].every((id) => xFriends.some((l: any) => l.identityId === id)), xFriends);
  check('…beside the Discord friends from the lists', friends.links.filter((l: any) => l.relationship === 'friend').length === 10);
  const following = await json('/api/people?relationship=following');
  check('Following has everyone followed, one way or both', following.links.length === 3 && following.links.find((l: any) => l.identityId === quinn.id && !l.followsYou), following.links.map((l: any) => [l.identityId, l.followsYou]));

  // The demo keeps X's Alice apart from the rest of her; one person, as the owner would merge her.
  await post('/api/persons/merge', { into: alice.id, from: aliceX.personId });

  // ------------------------------------------------------------------ a profile with every network
  await page.size(1280, 1000);
  let p = await profile(`#/p/${alice.id}`);
  const tag = (kind: string) => p.tags.find((t: any) => t.kind === kind);
  check('the hero: one Friend tag, on Discord and X', tag('friend')?.text === 'Friend' && tag('friend').nets === 'discord x', p.tags);
  check('…and one Contact tag, on Telegram, Signal and WhatsApp', tag('contact')?.text === 'Contact' && ['telegram', 'signal', 'whatsapp'].every((n) => tag('contact').nets.split(' ').includes(n)), p.tags);
  check('…each named in words for a screen reader, its marks hidden', tag('friend').said === ': Friends on Discord; You follow each other on X' && p.tags.every((t: any) => t.said && t.glyphsHidden), p.tags);
  check('no button that only says how you stand (Following, Request sent)', p.stateButtons === 0, p.stateButtons);
  check('Connections, grouped by kind: Friends then Contacts', p.title?.startsWith('Connections') && p.groups.join() === 'friend,contact', p.groups);
  check('…each group a list named for its kind, a row an item', p.lists.join() === 'Friends,Contacts' && p.rows.every((r: any) => r.item), p.lists);
  const fr = p.rows.filter((r: any) => r.kind === 'friend');
  check("Friends: Discord on both accounts with Remove friend, and X in X's words, with no Unfollow (X cannot)", fr.length === 3 && fr.filter((r: any) => r.net === 'discord' && r.text === 'Friends on Discord' && r.remove === 'Remove friend').length === 2 && fr.some((r: any) => r.net === 'x' && r.text === 'You follow each other on X' && r.remove === null), fr);
  check('…the two Remove friend buttons named apart, by account', fr.filter((r: any) => r.label).map((r: any) => r.label).sort().join(' | ') === 'Remove friend on Discord alt, alice.chen | Remove friend on Discord main, alice.chen', fr.map((r: any) => r.label));
  const ct = p.rows.filter((r: any) => r.kind === 'contact');
  check('Contacts: each address book in its own words', ct.length === 3 && ct.some((r: any) => r.text === 'In your Telegram contacts' && r.remove === 'Remove contact') && ct.some((r: any) => r.text === 'In your Signal contacts'), ct);
  check('About keeps the counts as facts, and no Follows you', /2,310 followers/.test(p.counts) && !/Follows you/.test(p.counts), p.counts);
  if (shots) await page.shot(join(shots, 'connections-alice-desktop.png'));

  // ------------------------------------------------------------------ one network: X
  p = await profile(`#/i/${nora.id}`);
  check('Nora on X: a Friend, as you follow each other', p.tags.length === 1 && tag('friend')?.nets === 'x' && p.rows.length === 1 && p.rows[0].text === 'You follow each other on X', p);
  check('…with no Following button', p.stateButtons === 0 && p.follow === null, p);
  if (shots) await page.shot(join(shots, 'connections-nora-desktop.png'));
  p = await profile(`#/i/${quinn.id}`);
  check('Quinn: You follow, one way', tag('following')?.text === 'You follow' && p.rows.length === 1 && p.rows[0].text === 'You follow them on X', p);
  p = await profile(`#/i/${raviX.id}`);
  // X cannot follow from here (no connect capability), so no Follow back, nor a button that would fail.
  check('Ravi on X: Follows you, and no Follow button X could not carry out', tag('follower')?.text === 'Follows you' && p.rows[0]?.text === 'Follows you on X' && p.rows[0]?.remove === null && p.follow === null, p);
  if (shots) await page.shot(join(shots, 'connections-follows-you-desktop.png'));
  p = await profile(`#/i/${mara.id}`);
  check('Mara: Request sent, with Cancel request', tag('requested')?.text === 'Request sent' && p.rows[0]?.text === 'Friend request sent on Discord' && p.rows[0]?.remove === 'Cancel request', p);
  p = await profile(`#/i/${owl.id}`);
  check('Owl: Blocked, with Unblock', tag('blocked')?.text === 'Blocked' && p.rows[0]?.text === 'Blocked on Discord' && p.rows[0]?.remove === 'Unblock', p);

  // ------------------------------------------------------------------ People's lists
  const people = async (filter: string) => {
    await load('#/people');
    await page.until(`!!document.querySelector('.people-chips [data-filter="${filter}"]')`, 20000);
    await page.eval(`document.querySelector('.people-chips [data-filter="${filter}"]').click()`);
    await page.until(`document.querySelectorAll('.plink-row').length > 0`, 15000);
    await Bun.sleep(200);
    return page.eval<any[]>(`[...document.querySelectorAll('.plink-row')].map((r) => { const n = r.querySelector('.plink-nets'); return { id: r.dataset.plink, name: r.querySelector('.row-title').textContent, kinds: r.dataset.kinds, line: r.querySelector('.row-preview').textContent, nets: n ? { role: n.getAttribute('role'), label: n.getAttribute('aria-label'), hidden: [...n.querySelectorAll('svg')].every((s) => s.getAttribute('aria-hidden') === 'true') } : null }; })`);
  };
  let rows = await people('friend');
  const noraRow = rows.find((r) => r.id === nora.id);
  const aliceRow = rows.find((r) => r.name === 'Alice Chen');
  check("People's Friends: Nora, as you follow each other on X", !!noraRow && noraRow.kinds === 'friend' && noraRow.line === 'You follow each other on X', noraRow);
  check('…and Alice once, a friend on Discord and X, the marks one image named in words', !!aliceRow && aliceRow.nets?.role === 'img' && aliceRow.nets.label === 'On Discord and X' && aliceRow.nets.hidden && rows.filter((r) => r.name === 'Alice Chen').length === 1, aliceRow);
  if (shots) await page.shot(join(shots, 'people-friends-desktop.png'));
  rows = await people('following');
  check("People's Following: Quinn, Nora and Alice", rows.length === 3 && rows.some((r) => r.id === quinn.id && r.kinds === 'following'), rows);

  // ------------------------------------------------------------------ a phone
  await page.size(390, 844, true);
  p = await profile(`#/p/${alice.id}`);
  check('on a phone: the same tags and Connections', tag('friend')?.nets === 'discord x' && p.rows.length === 6, p.tags);
  if (shots) await page.shot(join(shots, 'connections-alice-phone-hero.png'));
  await page.eval(`document.querySelector('.pf-standing').scrollIntoView({ block: 'start' })`);
  await Bun.sleep(300);
  check('nothing sideways on a phone', (await overflow()) <= 0, await overflow());
  if (shots) await page.shot(join(shots, 'connections-alice-phone.png'));
  rows = await people('friend');
  check('on a phone: People\'s Friends has the X mutuals', rows.some((r) => r.id === nora.id));
  check('…and nothing sideways', (await overflow()) <= 0, await overflow());
  if (shots) await page.shot(join(shots, 'people-friends-phone.png'));

  // ------------------------------------------------------------------ nothing went out
  // X: every command that is not a read (writeLog: markRead, send, add, remove…); the rest: what Add and Remove sent.
  const writes = async () => (await action('acc_demo-x', 'writeLog')).result?.writes ?? null;
  const others = boot.accounts.map((a: any) => a.id).filter((id: string) => id !== 'acc_demo-x');
  const addLogs = async () => Object.fromEntries(await Promise.all(others.map(async (id: string) => [id, (await action(id, 'addLog')).result] as const)));
  const counted = (r: any) => !!r && ['resolve', 'add', 'answer', 'remove'].every((k) => typeof r[k] === 'number');
  let xw = await writes();
  check('nothing sent to X: no command but reads', Array.isArray(xw) && xw.length === 0, xw);
  let logs = await addLogs();
  check('nothing added, answered or removed on any other account', others.length >= 5 && Object.values(logs).every((r: any) => counted(r) && !r.add && !r.answer && !r.remove), logs);

  // ------------------------------------------------------------------ ending one, then making another (clicked)
  await page.size(1280, 1000);
  const endThenAdd = async (who: any, rel: string, what: string) => {
    const asker = (await json(`/api/identities/${who.id}/about`)).accountId;
    await profile(`#/i/${who.id}`);
    const row = `.pf-standing .pf-link-row[data-account="${asker}"][data-rel="${rel}"]`;
    await page.eval(`document.querySelector(${JSON.stringify(`${row} [data-remove]`)}).click()`);
    await page.until(`!!document.querySelector('[data-confirm-remove="${rel}"]')`, 5000);
    await page.eval(`document.querySelector('[data-confirm-remove="${rel}"]').click()`);
    await page.until(`!document.querySelector(${JSON.stringify(row)}) && !!document.querySelector('.pf-action[data-action="friend"]')`, 10000);
    check(`${what}: ended, its row goes and Add friend comes`, true);
    await page.eval(`document.querySelector('.pf-action[data-action="friend"]').click()`);
    await page.until(`!!document.querySelector('.pf-tag[data-kind="requested"]')`, 10000).catch(() => {});
    const after = await page.eval<any>(`({ tag: !!document.querySelector('.pf-tag[data-kind="requested"]'), row: document.querySelector('.pf-standing .pf-link-row[data-kind="requested"][data-account="${asker}"] b')?.textContent ?? null })`);
    check(`${what}, then Add friend: Request sent in the hero and in Connections`, after.tag && after.row === 'Friend request sent on Discord', after);
    return asker;
  };
  const jordan = boot.identities.find((i: any) => i.network === 'discord' && i.displayName === 'Jordan');
  const a1 = await endThenAdd(jordan, 'friend', 'Jordan: Remove friend');
  if (shots) await page.shot(join(shots, 'connections-removed-then-added-desktop.png'));
  const a2 = await endThenAdd(owl, 'blocked', 'Owl: Unblock');
  logs = await addLogs();
  const sent = (id: string) => logs[id] ?? {};
  const want = (id: string) => [a1, a2].filter((a) => a === id).length;
  check('…and the networks were sent exactly those: a remove and an add each, nothing else', others.every((id: string) => sent(id).remove === want(id) && sent(id).add === want(id) && !sent(id).answer), logs);
  xw = await writes();
  check('…and still nothing to X', Array.isArray(xw) && xw.length === 0, xw);

  const errors = page.errors.filter((e) => !/WebSocket connection|Failed to load resource/.test(e));
  check('no script errors', !errors.length, errors);
} catch (e) {
  failed++;
  console.log('FAIL  ', e);
} finally {
  await close();
  hub.kill('SIGTERM');
  await hub.exited;
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

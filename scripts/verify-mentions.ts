/**
 * The composer's @ picker (docs/mentions.md), end to end against a demo hub of its own on a fresh data dir, in headless
 * Chromium: the hub's answer for a Discord server channel (who wrote there, the server's members from the network, its
 * roles, @everyone only for the admin account), the list opening on an @ and not in a mail address or code, its chunk
 * loaded only then, keys as in the emoji list (arrows, Enter, Tab, Escape), what goes into the box, a Signal group's
 * people from the hub alone, and a phone's width. Then Step 3: the About's "@ finds" set to Here and friends brings
 * the friends section (and Only on Discord narrows it), a friend with no Discord account goes out as a plain @Name, and
 * a person's accounts open with →: their Discord one goes out as its mention and their Signal one as a plain name.
 * Those are the only messages sent, to the demo world.
 *
 *   bun scripts/verify-mentions.ts [--port 8694] [--web <built dist>] [--work <empty dir>] [--shots <dir>]
 *
 * Builds the web app unless --web names a build.
 */
import { mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8694'));
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-mentions-${PORT}-`));
mkdirSync(work, { recursive: true });
const shots = opt('shots', '');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: unknown, detail: unknown = '') => {
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

let web = opt('web', '');
if (!web) {
  web = join(work, 'web');
  console.log('building the web app…');
  const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'pipe', stderr: 'pipe' });
  if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
}
if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${PORT}`);
const log = openSync(join(work, 'hub.log'), 'a');
const hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', join(work, 'data'), '--port', String(PORT), '--host', '127.0.0.1', '--web', web], {
  env: { ...process.env, DITHER_DEMO_CHATTER: '0' },
  stdout: log,
  stderr: log,
});

const { page, close } = await launch();
try {
  await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
  const boot = (await fetch(`${base}/api/bootstrap`).then((r) => r.json())) as P.Bootstrap;
  if (!boot.accounts.every((a) => a.demo)) throw new Error('not a demo hub');
  const dev = boot.conversations.find((c) => c.network === 'discord' && c.name === 'dev')!;
  const climb = boot.conversations.find((c) => c.network === 'signal' && c.name?.startsWith('Climbing crew'))!;
  const main = boot.accounts.find((a) => a.id === 'acc_demo-discord-main')!;
  const alt = boot.accounts.find((a) => a.id === 'acc_demo-discord-alt')!;
  const ask = (id: string, q: string, account?: string) =>
    fetch(`${base}/api/conversations/${id}/mentionables?${new URLSearchParams({ q, ...(account ? { account } : {}) })}`).then((r) => r.json()) as Promise<P.MentionablesView>;
  const identityCount = async () => ((await fetch(`${base}/api/bootstrap`).then((r) => r.json())) as P.Bootstrap).identities.length;

  // ------------------------------------------------------------------ the hub's answer

  const identities = await identityCount();
  let v = await ask(dev.id, '', main.id);
  const people = v.rows.filter((r) => r.kind === 'identity').map((r) => r.name);
  check('#dev, nothing typed: who wrote there, never you', ['Quinn', 'Lev', 'dither-ci'].every((n) => people.includes(n)) && !people.includes('zyan'), people);
  check('…then the roles, with their colours', v.rows.filter((r) => r.kind === 'role').map((r) => `${r.name} ${r.color}`).join(', ') === 'core #e67e22, reviewers #3498db', v.rows.filter((r) => r.kind === 'role'));
  check('…then @everyone and @here, for the account that may', v.rows.slice(-2).map((r) => r.insert).join('|') === '@everyone |@here ', v.rows.slice(-2));
  check('every row says what it inserts and that it pings', v.rows.every((r) => r.pings && r.section === 'here' && /^(<@&?\d+> |@everyone |@here )$/.test(r.insert)));
  v = await ask(dev.id, '', alt.id);
  check('asked through the alt, which is no admin there: no @everyone', !v.rows.some((r) => r.kind === 'everyone' || r.kind === 'here') && !v.rows.some((r) => r.name === 'zyn'));
  v = await ask(dev.id, 'qui', main.id);
  check('"qui": Quinn first, then members only the network knows', v.rows[0]?.name === 'Quinn' && v.rows.filter((r) => !r.identityId).length >= 3, v.rows.map((r) => r.name));
  const after = await identityCount();
  check("the network's people are not stored", after === identities, { before: identities, after });
  v = await ask(climb.id, '');
  // Theo is one person across networks here, so the person's name stands for the account.
  check('a Signal group: its people, from the hub alone', ['Alice Chen', 'Sam Rivera', 'Priya', 'Theo'].every((n) => v.rows.some((r) => r.name === n)) && !v.partial, v.rows.map((r) => r.name));

  // ------------------------------------------------------------------ the picker

  const box = `document.querySelector('.composer textarea')`;
  const type = (text: string) => page.send('Input.insertText', { text });
  const key = async (k: string, code: number) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code, ...(k === 'Enter' ? { text: '\r' } : {}) });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code });
  };
  const clear = async () => {
    await page.eval(`(() => { const t = ${box}; t.focus(); t.select(); document.execCommand('delete'); })()`);
    await Bun.sleep(150);
  };
  const value = () => page.eval<string>(`${box}.value`);
  const open = () => page.eval<boolean>(`!!document.querySelector('.mc-pop')`);
  const listed = () => page.eval<string[]>(`[...document.querySelectorAll('.mc-pop .mc-name')].map((e) => e.textContent)`);
  const picked = () => page.eval<string>(`document.querySelector('.mc-pop .ec-opt.on .mc-name')?.textContent ?? ''`);
  const chunkLoaded = () => page.eval<boolean>(`performance.getEntriesByType('resource').some((e) => /MentionPicker/.test(e.name))`);

  await page.size(1280, 860);
  await page.goto(`${base}/#/c/${dev.id}`);
  await page.until(`!!${box} && document.querySelectorAll('.msg').length > 1`, 20000);
  await Bun.sleep(500);
  await clear();
  await type('mail me at zyan@example.com or `@code`');
  await Bun.sleep(400);
  check("a mail address and code open nothing, and the list's chunk is not loaded", !(await open()) && !(await chunkLoaded()));
  await clear();
  await type('@');
  await page.until(`!!document.querySelector('.mc-pop .mc-name')`, 5000);
  check("an @ loads the list's chunk and opens it", await chunkLoaded());
  await Bun.sleep(400);
  const first = await listed();
  check('…with the people who wrote here', ['Quinn', 'Lev'].every((n) => first.includes(n)), first);
  if (shots) await page.shot(join(shots, 'mentions-desktop.png'));
  await type('qui');
  await page.until(`document.querySelector('.mc-pop .mc-name')?.textContent === 'Quinn'`, 5000);
  await Bun.sleep(400);
  const quin = await listed();
  check("typing narrows it, Quinn first, then the network's members", quin[0] === 'Quinn' && quin.some((n) => /^quin/.test(n)), quin);
  await key('ArrowDown', 40);
  await Bun.sleep(100);
  const second = await picked();
  check('ArrowDown moves to the next row', second === quin[1], second);
  await key('ArrowUp', 38);
  await key('Enter', 13);
  await Bun.sleep(250);
  const quinn = boot.identities.find((i) => i.network === 'discord' && i.displayName === 'Quinn')!;
  let text = await value();
  check('Enter puts Quinn in as a mention and a space, and sends nothing', text === `<@${quinn.nativeId}> ` && !(await open()), text);
  await type('and @ev');
  await page.until(`[...document.querySelectorAll('.mc-pop .mc-name')].some((e) => e.textContent === '@everyone')`, 5000).catch(() => {});
  const ev = await listed();
  check('"@ev" offers @everyone (the main account is admin here)', ev.includes('@everyone'), ev);
  await key('Escape', 27);
  await Bun.sleep(150);
  text = await value();
  check('Escape closes the list and keeps the draft', !(await open()) && text === `<@${quinn.nativeId}> and @ev`, text);
  // As the emoji list: closed for that @ until a new one is typed.
  await type('e');
  await Bun.sleep(400);
  check('typing on after Escape leaves it closed for that @', !(await open()));
  await page.eval(`(() => { const t = ${box}; t.focus(); t.setSelectionRange(t.value.length - 4, t.value.length); document.execCommand('delete'); })()`);
  await type('@eve');
  await page.until(`document.querySelector('.mc-pop .ec-opt.on .mc-name')?.textContent === '@everyone'`, 5000).catch(() => {});
  await key('Tab', 9);
  await Bun.sleep(200);
  text = await value();
  check('a new @ opens it again, and Tab puts @everyone in', text === `<@${quinn.nativeId}> and @everyone `, text);
  await clear();

  // ------------------------------------------------------------------ Step 3: "@ finds", friends, references

  v = await ask(dev.id, '', main.id);
  check('unset, #dev offers the people here alone', v.scope === 'here' && v.rows.every((r) => r.section === 'here'), v.scope);
  const prefOf = async () => ((await fetch(`${base}/api/bootstrap`).then((r) => r.json())) as P.Bootstrap).placePrefs.find((p) => p.kind === 'conversation' && p.id === dev.id);
  await page.goto(`${base}/#/about/c/${dev.id}`);
  await page.until(`!!document.querySelector('.pf-mentions select')`, 20000);
  const card = await page.eval<{ options: string[]; toggle: string }>(
    `(() => { const c = document.querySelector('.pf-mentions'); return { options: [...c.querySelectorAll('option')].map((o) => o.textContent), toggle: c.querySelector('.toggle-row')?.textContent ?? '' }; })()`,
  );
  check('the About has "@ finds": the default, the three choices, and Only on Discord', card.options.join('|') === 'Default (People here)|People here|Here and friends|Everyone you know' && card.toggle === 'Only on Discord', card);
  if (shots) await page.shot(join(shots, 'mentions-finds.png'));
  await page.eval(`(() => { const s = document.querySelector('.pf-mentions select'); s.value = 'friends'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(async () => (await prefOf())?.mentionScope === 'friends', 5000, 'the setting was not saved');
  v = await ask(dev.id, '', main.id);
  const friendRows = v.rows.filter((r) => r.section === 'friends');
  check('set to Here and friends, the hub answers friends after the people here', v.scope === 'friends' && friendRows.length > 3 && friendRows.every((r) => r.kind === 'person'), friendRows.map((r) => r.name));
  const mom = friendRows.find((r) => r.name === 'Mom');
  check('Mom (on Signal only) is a reference that pings nobody', !!mom && mom.insert.startsWith('<@person:per_') && !mom.pings, mom);

  const messages = async () => ((await fetch(`${base}/api/conversations/${dev.id}/messages?limit=20`).then((r) => r.json())) as P.MessagePage).messages;
  const sentBody = async (tag: string) => {
    let body = '';
    await until(async () => !!(body = (await messages()).find((m) => m.body.includes(tag))?.body ?? ''), 8000, `the message ${tag} did not arrive`);
    return body;
  };
  const sections = () => page.eval<string[]>(`[...document.querySelectorAll('.mc-pop .mc-sec')].map((e) => e.textContent)`);
  const pick = async (name: string) => {
    const i = (await listed()).indexOf(name);
    for (let n = 0; n < i; n++) await key('ArrowDown', 40);
    await Bun.sleep(100);
    return i;
  };

  await page.goto(`${base}/#/c/${dev.id}`);
  await page.until(`!!${box}`, 20000);
  await Bun.sleep(500);
  await clear();
  await type('@');
  await page.until(`[...document.querySelectorAll('.mc-pop .mc-sec')].length > 1`, 5000).catch(() => {});
  const heads = await sections();
  check('the list has its sections: Here, then Friends', heads.join('|') === 'Here|Friends', heads);
  if (shots) await page.shot(join(shots, 'mentions-friends.png'));
  await clear();
  await type('@mom');
  await page.until(`[...document.querySelectorAll('.mc-pop .mc-name')].some((e) => e.textContent === 'Mom')`, 5000).catch(() => {});
  const struck = await page.eval<boolean>(`[...document.querySelectorAll('.mc-pop .mc-opt')].some((b) => b.querySelector('.mc-name')?.textContent === 'Mom' && !!b.querySelector('.mc-ping.off'))`);
  check('"@mom": Mom, under Friends, her bell struck through', struck && (await sections()).includes('Friends'));
  await pick('Mom');
  await key('Tab', 9);
  await Bun.sleep(200);
  text = await value();
  check('Tab puts Mom in by reference', text === mom?.insert, text);
  const tag1 = `step3-plain-${Date.now()}`;
  await type(`hi ${tag1}`);
  await key('Enter', 13);
  const plainBody = await sentBody(tag1);
  check('sent, it arrives as plain @Mom: no reference, no ping', plainBody === `@Mom hi ${tag1}`, plainBody);

  // Theo is one person on Discord and Signal, and a member of the server: "@theo" finds him here, and → opens his accounts.
  const theo = (await ask(dev.id, 'theo', main.id)).rows.find((r) => r.name === 'Theo' && r.section === 'here');
  const theoDiscord = theo?.accounts?.find((a) => a.network === 'discord');
  const theoSignal = theo?.accounts?.find((a) => a.network === 'signal');
  check('"theo": Theo here, with his Discord and Signal accounts', !!theo && theo.insert === theoDiscord?.insert && !!theoSignal && !theoSignal.pings, theo);
  await clear();
  await type('@theo');
  await page.until(`document.querySelector('.mc-pop .ec-opt.on .mc-name')?.textContent === 'Theo'`, 5000).catch(() => {});
  await key('ArrowRight', 39);
  await page.until(`!!document.querySelector('.mc-pop .mc-back')`, 3000).catch(() => {});
  const accounts = await listed();
  check("→ opens Theo's accounts, each with its network", accounts.length === 2 && accounts.includes(`${theoDiscord?.name} · Discord`) && accounts.includes(`${theoSignal?.name} · Signal`), accounts);
  await key('Escape', 27);
  await Bun.sleep(150);
  check('Escape goes back to the list, still open', (await open()) && !(await page.eval<boolean>(`!!document.querySelector('.mc-pop .mc-back')`)) && (await picked()) === 'Theo');
  await key('ArrowRight', 39);
  await page.until(`!!document.querySelector('.mc-pop .mc-back')`, 3000).catch(() => {});
  await pick(`${theoDiscord?.name} · Discord`);
  await key('Enter', 13);
  await Bun.sleep(200);
  text = await value();
  check('his Discord account goes in as its mention', text === `<@${(boot.identities.find((i) => i.id === theoDiscord?.identityId) ?? { nativeId: '?' }).nativeId}> `, text);
  await type('and @theo');
  await page.until(`document.querySelector('.mc-pop .ec-opt.on .mc-name')?.textContent === 'Theo'`, 5000).catch(() => {});
  await key('ArrowRight', 39);
  await page.until(`!!document.querySelector('.mc-pop .mc-back')`, 3000).catch(() => {});
  await pick(`${theoSignal?.name} · Signal`);
  await key('Enter', 13);
  await Bun.sleep(200);
  text = await value();
  check('his Signal account goes in by reference', text.endsWith(`and <@identity:${theoSignal?.identityId}> `), text);
  const tag2 = `step3-accounts-${Date.now()}`;
  await type(tag2);
  await key('Enter', 13);
  const accBody = await sentBody(tag2);
  const theoNative = boot.identities.find((i) => i.id === theoDiscord?.identityId)?.nativeId;
  check('sent: his Discord account arrives as <@id>, his Signal one as a plain name', accBody === `<@${theoNative}> and @${theoSignal?.name} ${tag2}`, accBody);

  // A friend from elsewhere with several accounts: Enter opens them, the person first.
  await clear();
  await type('@sam');
  await page.until(`document.querySelector('.mc-pop .ec-opt.on .mc-name')?.textContent === 'Sam Rivera'`, 5000).catch(() => {});
  await key('Enter', 13);
  await page.until(`!!document.querySelector('.mc-pop .mc-back')`, 3000).catch(() => {});
  const sam = await listed();
  check('Enter on a friend from elsewhere opens their accounts: the person, then Matrix and Signal', sam.join('|') === 'Sam Rivera|Sam Rivera · Matrix|Sam Rivera · Signal' || sam.join('|') === 'Sam Rivera|Sam Rivera · Signal|Sam Rivera · Matrix', sam);
  await key('Escape', 27);
  await key('Escape', 27);
  await Bun.sleep(150);
  check('Escape twice: back, then closed', !(await open()));

  // Only on Discord.
  await page.goto(`${base}/#/about/c/${dev.id}`);
  await page.until(`!!document.querySelector('.pf-mentions .toggle-row input')`, 20000);
  await page.eval(`document.querySelector('.pf-mentions .toggle-row input').click()`);
  await until(async () => (await prefOf())?.mentionSameNetwork === true, 5000, 'the switch was not saved');
  v = await ask(dev.id, '', main.id);
  const onDiscord = v.rows.filter((r) => r.section === 'friends');
  check('Only on Discord: friends with a Discord account alone, each by its Discord account', v.sameNetwork === true && onDiscord.length > 0 && !onDiscord.some((r) => r.name === 'Mom') && onDiscord.every((r) => r.pings && r.accounts!.every((a) => a.network === 'discord')), onDiscord.map((r) => r.name));
  await page.goto(`${base}/#/c/${dev.id}`);
  await page.until(`!!${box}`, 20000);
  await Bun.sleep(500);
  await clear();
  await type('@');
  await page.until(`[...document.querySelectorAll('.mc-pop .mc-sec')].length > 1`, 5000).catch(() => {});
  await Bun.sleep(400);
  const narrowed = await listed();
  check('…and the list shows them alone', narrowed.includes('Theo') && !narrowed.includes('Mom') && !narrowed.includes('Sam Rivera'), narrowed);
  await clear();

  // A Signal group, on a phone.
  await page.size(390, 844, true);
  await page.goto(`${base}/#/inbox/c/${climb.id}`);
  await page.until(`!!document.querySelector('.app.phone') && !!${box}`, 20000);
  await Bun.sleep(600);
  await clear();
  await type('hey @pri');
  await page.until(`document.querySelector('.mc-pop .mc-name')?.textContent === 'Priya'`, 5000).catch(() => {});
  const pri = await listed();
  check('a Signal group: "@pri" finds Priya alone', pri.length === 1 && pri[0] === 'Priya', pri);
  const fit = await page.eval<{ left: number; right: number; width: number; scroll: number } | null>(
    `(() => { const p = document.querySelector('.mc-pop'); if (!p) return null; const r = p.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: innerWidth, scroll: document.documentElement.scrollWidth }; })()`,
  );
  check('on a phone the list fits the screen and nothing scrolls sideways', !!fit && fit.left >= 0 && fit.right <= fit.width && fit.scroll <= fit.width, fit);
  if (shots) await page.shot(join(shots, 'mentions-phone.png'));
  await key('Enter', 13);
  await Bun.sleep(250);
  const priya = boot.identities.find((i) => i.network === 'signal' && i.displayName === 'Priya')!;
  text = await value();
  check("Enter puts Priya's Signal mention in, and sends nothing", text === `hey <@${priya.nativeId}> `, text);
  await clear();

  // #dev on a phone: the sections, and a person's accounts. The switch back to what it inherits, from the page (a write must come from it).
  await page.eval(
    `fetch('/api/place-prefs', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ kind: 'conversation', id: ${JSON.stringify(dev.id)}, mentionSameNetwork: null }] }) }).then((r) => r.ok)`,
  );
  await until(async () => (await prefOf())?.mentionSameNetwork === undefined, 5000, 'the switch was not taken back');
  await page.goto(`${base}/#/inbox/c/${dev.id}`);
  await page.until(`!!document.querySelector('.app.phone') && !!${box}`, 20000);
  await Bun.sleep(600);
  await clear();
  await type('@');
  await page.until(`[...document.querySelectorAll('.mc-pop .mc-sec')].length > 1`, 5000).catch(() => {});
  const phoneHeads = await sections();
  if (shots) await page.shot(join(shots, 'mentions-phone-friends.png'));
  await clear();
  await type('@theo');
  await page.until(`document.querySelector('.mc-pop .ec-opt.on .mc-name')?.textContent === 'Theo'`, 5000).catch(() => {});
  await page.eval(`document.querySelector('.mc-pop .ec-opt.on .mc-more').click()`);
  await page.until(`!!document.querySelector('.mc-pop .mc-back')`, 3000).catch(() => {});
  const phoneFit = await page.eval<{ left: number; right: number; width: number; scroll: number } | null>(
    `(() => { const p = document.querySelector('.mc-pop'); if (!p) return null; const r = p.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: innerWidth, scroll: document.documentElement.scrollWidth }; })()`,
  );
  const phoneAccounts = await listed();
  check("on a phone: the sections, and a tap on the arrow opens Theo's accounts, which fit the screen", phoneHeads.join('|') === 'Here|Friends' && phoneAccounts.length === 2 && !!phoneFit && phoneFit.left >= 0 && phoneFit.right <= phoneFit.width && phoneFit.scroll <= phoneFit.width, { phoneHeads, phoneAccounts, phoneFit });
  if (shots) await page.shot(join(shots, 'mentions-phone-accounts.png'));
  await key('Escape', 27);
  await clear();

  const errors = page.errors.filter((e) => !/WebSocket connection|Failed to load resource/.test(e));
  check('no script errors', !errors.length, errors);
} catch (e) {
  failed++;
  console.log('FAIL  ', e);
} finally {
  await close();
  hub.kill('SIGTERM');
}
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);

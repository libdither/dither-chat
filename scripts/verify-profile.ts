/**
 * Profile pages (docs/profile.md), end to end against a demo hub in headless Chromium: the name at the top of a DM
 * opens the person's page; what the networks say about them (bio, status, pronouns, friend), servers in common with
 * their nickname and roles there, group chats, mutual friends and recent messages, each with a picture; the actions
 * from their menu in the hero; your own page listing your friends once each, with your own bio editable on each
 * network whose adapter can change it (never Matrix, never someone else's); and the page on a phone.
 *
 * Mail (hub mail/people.ts): someone you wrote to by email is a person of their own, never merged by name; their page
 * has a Mail card that opens the thread (whose sender opens their page) and all mail with them, says who else has
 * their name, and asks nothing of a network; the merge search finds people by address; a merge carries the mail to
 * the merged person, and a split takes it back. On a desktop in the dark theme and a phone in the light one.
 *
 *   bun scripts/verify-profile.ts http://127.0.0.1:8498 [/tmp/shots]
 * The hub must be a demo hub (--demo).
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8498';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
// The demo's Alice on chat networks (mail makes a second Alice Chen, by her address).
const alice = boot.persons.find((p: any) => p.name === 'Alice Chen' && boot.conversations.some((c: any) => c.peerPersonId === p.id));
const dm = boot.conversations.find((c: any) => c.shape === 'direct' && c.network === 'discord' && c.peerPersonId === alice?.id);
if (!alice || !dm) throw new Error('the demo world lacks Alice or her Discord DM');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const click = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const text = (sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const card = (title: string) => p.eval<string>(`[...document.querySelectorAll('.pf-card')].find((c) => c.querySelector('h3')?.textContent.startsWith(${JSON.stringify(title)}))?.innerText ?? ''`);
const menu = () => p.eval<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim())`);
// The networks have answered: nothing is still asking.
const settled = () => p.until(`!!document.querySelector('.profile-page .pf-hero') && !document.querySelector('.pf-asking')`, 10000);
/** The theme, then a fresh load of `hash` with it. */
const theme = async (name: string, hash: string) => {
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(name)} }))`);
  await p.eval(`(location.hash = ${JSON.stringify(hash)}, location.reload())`).catch(() => {});
  await Bun.sleep(800);
  await p.until(`!!document.querySelector('.app')`, 15000);
};
const typeInto = (sel: string, v: string) =>
  p.eval(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(t, ${JSON.stringify(v)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);

/** People by email: the Mail card, its links, the merge hint and search, and a merge that carries the mail. */
async function mailPeople() {
  // Mail syncs once the hub is up: its people come with it.
  let mail: any = null;
  for (let i = 0; i < 50 && !mail?.personId; i++) {
    const b = await fetch(`${hub}/api/bootstrap`).then((r) => r.json());
    mail = b.identities.find((x: any) => x.network === 'email' && x.nativeId === 'alice.chen@example.org');
    if (!mail?.personId) await Bun.sleep(200);
  }
  check(mail?.personId && mail.personId !== alice.id, 'whom you wrote to by email is a person of their own, not merged by name', mail?.personId);
  if (!mail?.personId) return;
  const page = `#/p/${mail.personId}`;

  for (const [w, h, name] of [[1360, 900, 'dither-dark'], [390, 844, 'dither-light']] as const) {
    const tag = `${w < 500 ? 'phone' : 'desktop'} ${name}`;
    await p.size(w, h, w < 500);
    await theme(name, page);
    await settled();
    const card = await p.eval<string>(`document.querySelector('.pf-mail')?.innerText ?? ''`);
    check(card.includes('Re: Lease renewal') && card.includes('All mail with Alice Chen'), `${tag}: their page has a Mail card with the thread and all mail with them`, card.split('\n'));
    const hint = await p.eval<string>(`[...document.querySelectorAll('.pf-hint')].map((e) => e.innerText).join(' | ')`);
    check(/Alice Chen on [^|]*Discord/.test(hint), `${tag}: the hint names the other Alice Chen and where she is`, hint);
    const quiet = await p.eval<{ banner: boolean; recent: boolean; stale: string }>(
      `({ banner: !!document.querySelector('.pf-banner-note'), recent: [...document.querySelectorAll('.pf-card h3')].some((h) => h.textContent.startsWith('Recent messages')), stale: [...document.querySelectorAll('.pf-stale')].map((e) => e.innerText).join(' ') })`,
    );
    check(!quiet.banner && !quiet.recent && !quiet.stale, `${tag}: no chat banner, no empty Recent messages, nothing asked of a network`, quiet);
    const fit = await p.eval<{ sw: number; w: number }>(`({ sw: document.querySelector('.pf-scroll').scrollWidth, w: document.querySelector('.pf-scroll').clientWidth })`);
    check(fit.sw <= fit.w + 1, `${tag}: it fits the width`, fit);
    if (shots) await p.shot(`${shots}/profile-mail-${w < 500 ? 'phone' : 'desktop'}.png`);
  }

  // The thread opens in Mail, and its sender's name opens theirs.
  await click('.pf-mail-row');
  await p.until(`location.hash.startsWith('#/mail') && !!document.querySelector('.mail-msg.open')`, 8000);
  check((await text('.mail-subject')) === 'Re: Lease renewal', 'a Mail card row opens the thread', await text('.mail-subject'));
  await click('.mail-msg.open .mail-msg-person');
  await settled();
  check((await text('.pf-title h1')).startsWith('Jo Park'), 'the sender’s name in the reader opens their page', await text('.pf-title h1'));
  // All mail with them: a list of its own.
  await p.size(1360, 900);
  await p.goto(`${hub}/${page}`);
  await settled();
  await click('.pf-mail-all');
  await p.until(`!!document.querySelector('.mail-list .mail-row')`, 8000);
  const list = await p.eval<{ label: string; rows: number }>(`({ label: document.querySelector('.mail-list')?.getAttribute('aria-label') ?? '', rows: document.querySelectorAll('.mail-list .mail-row').length })`);
  check(list.label === 'Mail with Alice Chen' && list.rows === 1 && decodeURIComponent(await p.eval<string>('location.hash')).includes(`w:${mail.personId}`), 'all mail with them lists their threads', list);

  // On the other Alice's page: the hint says who, and merging carries the mail.
  await p.goto(`${hub}/#/p/${alice.id}`);
  await settled();
  const hint = await p.eval<string>(`[...document.querySelectorAll('.pf-hint')].map((e) => e.innerText).join(' | ')`);
  check(hint.includes('Alice Chen <alice.chen@example.org>'), 'the hint shows the address that may be her', hint);
  check(!(await p.eval<boolean>(`!!document.querySelector('.pf-mail')`)), 'before a merge her page has no mail');
  // The merge search finds people by address.
  await click('.pf-action[title="More"]');
  await p.eval(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === 'Merge Another Identity In').click()`);
  await p.until(`!!document.querySelector('.merge-box input')`, 3000);
  await typeInto('.merge-box input', 'jo@park');
  await p.until(`[...document.querySelectorAll('.merge-box .link-row')].some((r) => r.textContent.includes('Jo Park'))`, 4000).catch(() => {});
  const byAddress = await p.eval<string[]>(`[...document.querySelectorAll('.merge-box .link-row')].map((r) => r.textContent.trim())`);
  check(byAddress.length === 1 && byAddress[0].includes('Jo Park'), 'the merge search finds someone by their address', byAddress);
  await typeInto('.merge-box input', '');
  await Bun.sleep(100);
  await p.eval(`[...document.querySelectorAll('.merge-box .link-row')].find((r) => r.textContent.includes('Alice Chen')).click()`);
  await p.until(`!!document.querySelector('.pf-mail')`, 8000).catch(() => {});
  const merged = await p.eval<{ mail: string; hash: string; accounts: string }>(
    `({ mail: document.querySelector('.pf-mail')?.innerText ?? '', hash: location.hash, accounts: [...document.querySelectorAll('.pf-identity')].map((e) => e.innerText).join(' | ') })`,
  );
  check(merged.hash === `#/p/${alice.id}` && merged.mail.includes('Re: Lease renewal') && merged.accounts.includes('alice.chen@example.org'), 'merged in, her mail comes with her address', merged);
  if (shots) await p.shot(`${shots}/profile-mail-merged.png`);
  // Split again: the mail goes back with the address.
  await p.eval(`[...document.querySelectorAll('.pf-identity')].find((e) => e.innerText.includes('alice.chen@example.org')).querySelector('button[title^="Unmerge"]').click()`);
  await p.until(`!document.querySelector('.pf-mail')`, 8000).catch(() => {});
  check(!(await p.eval<boolean>(`!!document.querySelector('.pf-mail')`)), 'split again, the mail goes back with the address');
}

try {
  await p.size(1360, 900);
  await p.goto(`${hub}/#/c/${dm.id}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await click('.conv-head .conv-head-name');
  await settled();
  check((await p.eval('location.hash')) === `#/p/${alice.id}`, 'the name at the top of a DM opens their profile', await p.eval('location.hash'));
  check((await text('.pf-title h1')).startsWith('Alice Chen'), 'the hero names them');
  const about = await card('About');
  check(about.includes('film photography'), 'their Discord bio', about.split('\n').slice(0, 3));
  check(!/\bAvailable\b/.test(about), 'not WhatsApp’s stock “Available”');
  check((await text('.pf-status')).includes('at the crag'), 'their status, with its text');
  const tags = await text('.pf-tags');
  check(tags.includes('she/her') && tags.includes('Friend') && tags.includes('In your contacts'), 'pronouns and how you stand with them, once each', tags);
  check(about.includes('GitHub') && about.match(/Phone/g)?.length === 1, 'their links, one number written two ways shown once', about.match(/Phone|GitHub/g));
  const common = await card('In common');
  check(common.includes('libdither') && common.includes('as alice (testing)') && common.includes('Testers'), 'a server in common, with their nickname and role there', common.split('\n').slice(0, 6));
  const groupIcons = await p.eval<number>(`[...document.querySelectorAll('.pf-card .pf-row')].filter((r) => r.querySelector('.avatar')).length`);
  check(groupIcons >= 3, 'group chats and recent messages each have a picture', groupIcons);
  const mutual = await card('Mutual friends');
  check(['Ravi', 'Jordan', 'Theo'].every((n) => mutual.includes(n)), 'mutual friends', mutual.split('\n'));
  const recent = await p.eval<number>(`document.querySelectorAll('.pf-msg').length`);
  check(recent > 3, 'recent messages', recent);
  if (shots) await p.shot(`${shots}/profile-person.png`);

  // Their menu's actions live in the hero.
  await click('.pf-action[title="Message"]');
  const msg = await menu();
  check(msg.includes('On Discord') && msg.includes('On Signal') && msg.includes('All Chats Together'), 'Message offers each network and the merged thread', msg);
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await Bun.sleep(150);
  await click('.pf-action[title="More"]');
  const more = await menu();
  check(more.some((m) => m.startsWith('Copy')) && more.includes('Merge Another Identity In') && more.includes('Open on Discord'), 'More holds the copies, merging and opening on a network', more);
  check(!more.some((m) => ['Profile', 'Message', 'Star', 'Unstar'].includes(m)), 'but not what the page already has a button for');
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await Bun.sleep(150);

  // A mutual friend's name opens theirs.
  await click('.pf-person');
  await settled();
  check((await p.eval<string>('location.hash')).startsWith('#/p/') && !(await text('.pf-title h1')).startsWith('Alice'), 'a mutual friend opens their profile', await text('.pf-title h1'));

  // Your own page: your friends, each person once.
  await p.goto(`${hub}/#/p/per_self`);
  await settled();
  const friends = await p.eval<string[]>(`[...document.querySelectorAll('.pf-card')].find((c) => c.querySelector('h3')?.textContent.startsWith('Friends'))?.querySelectorAll('.pf-person > span:last-child') ? [...[...document.querySelectorAll('.pf-card')].find((c) => c.querySelector('h3')?.textContent.startsWith('Friends')).querySelectorAll('.pf-person > span:last-child')].map((s) => s.textContent) : []`);
  check(friends.length > 5 && new Set(friends).size === friends.length && friends.includes('Alice Chen'), 'your page lists your friends, each person once', friends);
  check(!(await text('.pf-actions')).includes('Message'), 'and no Message button to yourself');
  if (shots) await p.shot(`${shots}/profile-self.png`);

  // Your own bio, editable where the adapter can (editProfile): Discord, Signal, WhatsApp, not Matrix.
  const editors = await p.eval<string[]>(`[...document.querySelectorAll('.pf-own-bio .about-pencil')].map((b) => b.getAttribute('aria-label'))`);
  check(editors.some((l) => l.includes('Discord')) && editors.includes('Change your bio on Signal') && editors.includes('Change your bio on WhatsApp') && !editors.some((l) => l.includes('Matrix')), 'your bio has an editor on each network that can change it, none on Matrix', editors);
  const typeBio = (v: string) =>
    p.eval(`(() => { const t = document.querySelector('.pf-own-bio textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(v)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('.pf-own-bio .about-pencil[aria-label="Change your bio on Discord"]');
  await p.until(`!!document.querySelector('.pf-own-bio textarea')`, 3000);
  await typeBio('x'.repeat(195));
  await Bun.sleep(100);
  const over = await p.eval<{ count: string; disabled: boolean }>(`({ count: document.querySelector('.pf-bio-count')?.textContent ?? '', disabled: !![...document.querySelectorAll('.pf-own-bio .btn.primary')].find((b) => b.textContent === 'Save')?.disabled })`);
  check(over.count === '5 over 190' && over.disabled, 'past Discord’s 190 characters it says how far over, and will not save', over);
  const bio = 'testing my own bio from dither 🧪';
  await typeBio(bio);
  await Bun.sleep(100);
  check((await text('.pf-bio-count')) === '158 of 190 left', 'under it, how many are left', await text('.pf-bio-count'));
  if (shots) await p.shot(`${shots}/profile-own-bio-edit.png`);
  await click('.pf-own-bio .btn.primary');
  await p.until(`!document.querySelector('.pf-own-bio textarea')`, 8000);
  check((await card('About')).includes(bio), 'saved, it shows at once', (await card('About')).split('\n').slice(0, 4));
  const kept = await Promise.all(boot.accounts.filter((a: any) => a.network === 'discord').map((a: any) => fetch(`${hub}/api/identities/${a.selfIdentityId}/profile`).then((r) => r.json())));
  check(kept.filter((k) => k.abouts.some((a: any) => a.bio === bio)).length === 1, 'and the hub keeps it for next time, on that account only');
  await p.goto(`${hub}/#/p/per_self`);
  await settled();
  check((await card('About')).includes(bio), 'still there after a reload');
  // WhatsApp's About is its status too: the hub says the new one.
  await click('.pf-own-bio .about-pencil[aria-label="Change your bio on WhatsApp"]');
  await p.until(`!!document.querySelector('.pf-own-bio textarea')`, 3000);
  check((await text('.pf-bio-count')).endsWith('of 139 left'), 'WhatsApp counts to 139', await text('.pf-bio-count'));
  await p.eval(`document.querySelector('.pf-own-bio textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await Bun.sleep(100);
  check(!(await p.eval<boolean>(`!!document.querySelector('.pf-own-bio textarea')`)), 'Escape puts it back without saving');

  // A phone.
  await p.size(390, 840, true);
  await p.goto(`${hub}/#/p/${alice.id}`);
  await settled();
  await Bun.sleep(400);
  check(!(await p.eval<boolean>(`!!document.querySelector('.pf-own-bio, .pf-card .about-pencil')`)), 'someone else’s bio has no editor');
  const fit = await p.eval<{ sw: number; w: number; back: boolean }>(`({ sw: document.querySelector('.pf-scroll').scrollWidth, w: document.querySelector('.pf-scroll').clientWidth, back: !!document.querySelector('.profile-page .profile-back')?.getBoundingClientRect().width })`);
  check(fit.sw <= fit.w + 1 && fit.back, 'on a phone it fits the width, with a way back', fit);
  if (shots) await p.shot(`${shots}/profile-phone.png`);

  await mailPeople();

  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);

/**
 * Catch up (packages/web/src/ui/CatchUp.tsx, docs/inbox.md#catch-up) in a real browser against a fresh demo hub:
 *
 *   - the queue is the conversations that need you, owed replies first and then the unread ones, in the inbox's
 *     order, mail included; opening it marks nothing read;
 *   - j and k move between cards, l puts one Later (to the end), e is Done (off the queue, and read on the hub);
 *   - no key does anything while you type in a reply box, and Esc leaves the box;
 *   - a reply from a card goes out once: one message in the conversation and in the card, no double echo; the card
 *     says Replied and focus moves on to the next card;
 *   - something that newly needs you joins the end, with an "N new" note;
 *   - Done on every card leaves "All caught up";
 *   - on a phone the Catch up tab shows it, with the badge the inbox button has.
 *
 *   DITHER_DEMO_CHATTER=0 bun packages/hub/src/main.ts --demo --data <fresh dir> --port <port> --web <built web>
 *   bun scripts/verify-catchup.ts http://127.0.0.1:<port> [screenshot dir]
 *
 * A fresh demo hub only, never a real one: it sends messages and marks conversations read. The demo's people answer by
 * themselves; DITHER_DEMO_CHATTER=0 keeps its background chatter from adding cards while this counts them.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const base = process.argv[2];
const shots = process.argv[3];
if (!base) throw new Error('usage: bun scripts/verify-catchup.ts <hub url> [screenshot dir]');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const get = <T = any>(path: string): Promise<T> => fetch(base + path).then((r) => r.json() as Promise<T>);
const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });

const boot0 = await get('/api/bootstrap');
if (!boot0.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub: refusing');

/** Each conversation's unread count, and each mail thread's, as the hub has them now. */
const unreadNow = async () => {
  const b = await get('/api/bootstrap');
  const out = new Map<string, number>();
  for (const c of b.conversations) out.set(c.id, c.vantages.reduce((s: number, v: any) => s + v.unread, 0));
  for (const t of b.mail?.threads ?? []) out.set(t.id, t.unread);
  return { unread: out, boot: b };
};

const { page, close } = await launch();
const shot = async (name: string) => {
  if (!shots) return;
  // A demo answer's toast would sit over the header.
  await page.eval(`document.querySelectorAll('.toast .toast-x').forEach((x) => x.click())`);
  await page.shot(`${shots}/${name}.png`);
};

/** What the pane shows. */
const pane = () =>
  page.eval<{ keys: string[]; owed: boolean[]; mail: boolean[]; focus: string | null; waiting: number; fresh: number; empty: boolean; active: string }>(`(() => {
    const cards = [...document.querySelectorAll('.catchup .cu-card')];
    return {
      keys: cards.map((c) => c.dataset.card),
      owed: cards.map((c) => c.dataset.owed === '1'),
      mail: cards.map((c) => c.dataset.mail === '1'),
      focus: document.querySelector('.catchup .cu-card.focused')?.dataset.card ?? null,
      waiting: Number(document.querySelector('.catchup-count')?.textContent.match(/(\\d+) waiting/)?.[1] ?? 0),
      fresh: Number(document.querySelector('.catchup-new')?.textContent.match(/\\d+/)?.[0] ?? 0),
      empty: !!document.querySelector('.catchup-empty'),
      active: document.activeElement?.tagName ?? '',
    };
  })()`);

const key = async (k: string) => {
  const code = k === 'Enter' ? 'Enter' : k === 'Escape' ? 'Escape' : `Key${k.toUpperCase()}`;
  const vk = k === 'Enter' ? 13 : k === 'Escape' ? 27 : k.toUpperCase().charCodeAt(0);
  const text = k === 'Enter' ? '\r' : k === 'Escape' ? undefined : k;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await Bun.sleep(150);
};
/** A busy queue is drawn ten cards at a time: draw them all, as scrolling to the end would. */
const drawAll = async () => {
  for (let i = 0; i < 50 && (await page.eval<boolean>(`!!document.querySelector('.catchup .cu-more')`)); i++) {
    await page.eval(`document.querySelector('.catchup .cu-more').click()`);
    await Bun.sleep(100);
  }
};
/** Focus a card by clicking its header, as a pointer would. */
const focusCard = (id: string) => page.eval(`document.querySelector('.catchup [data-card="${id}"] .cu-head').click()`);
const card = (id: string) => `.catchup [data-card="${id}"]`;

try {
  // ------------------------------------------------------------------ the queue

  const before = await unreadNow();
  await page.size(1400, 900);
  await page.goto(`${base}/#/inbox`);
  await page.until(`!!document.querySelector('.catchup .cu-card') && performance.getEntriesByName('dither:fresh').length > 0`, 20000);
  // Past the moment the queue is still being taken (mail views, scores), and some cards' messages loaded.
  await Bun.sleep(4000);
  const drawnFirst = await page.eval<number>(`document.querySelectorAll('.catchup .cu-card').length`);
  await drawAll();
  const q0 = await pane();
  check('a long queue is drawn ten cards at a time', q0.keys.length <= 10 || drawnFirst === 10, { first: drawnFirst, all: q0.keys.length });
  console.log(`      the queue: ${q0.keys.length} cards, ${q0.owed.filter(Boolean).length} owed, ${q0.mail.filter(Boolean).length} mail`);
  check('it shows cards', q0.keys.length >= 6, q0.keys.length);
  const lastOwed = q0.owed.lastIndexOf(true);
  const firstNot = q0.owed.indexOf(false);
  check('owed replies come first', lastOwed >= 0 && (firstNot < 0 || lastOwed < firstNot), q0.owed.map(Number).join(''));
  check('mail threads from people are in it', q0.mail.some(Boolean));
  check('"N waiting" counts the cards', q0.waiting === q0.keys.length, [q0.waiting, q0.keys.length]);

  // Exactly the rows that need you with a reply owed or something unread.
  const want = new Set<string>();
  for (const a of before.boot.attention) if (a.needs && (a.owedSince !== null || (before.unread.get(a.id) ?? 0) > 0)) want.add(a.id);
  const got = new Set(q0.keys);
  const missing = [...want].filter((k) => !got.has(k));
  const extra = q0.keys.filter((k) => !want.has(k));
  check('the cards are the rows that need you, owed or unread', !missing.length && !extra.length, { missing, extra });

  // In the inbox's own order: the list's rows, owed first.
  const list = await page.eval<string[]>(`[...document.querySelectorAll('.sidebar [data-row]')].map((r) => r.dataset.row)`);
  if (list.length) {
    const inList = list.filter((k) => got.has(k));
    const owed = new Set(q0.keys.filter((_, i) => q0.owed[i]));
    const expected = [...inList.filter((k) => owed.has(k)), ...inList.filter((k) => !owed.has(k))];
    check("each part in the inbox's own order", expected.join() === q0.keys.filter((k) => list.includes(k)).join(), { expected: expected.slice(0, 8), got: q0.keys.slice(0, 8) });
  } else console.log('      the inbox list has no [data-row]: its order is not compared');

  const after = await unreadNow();
  const changed = q0.keys.filter((k) => (before.unread.get(k) ?? 0) !== (after.unread.get(k) ?? 0));
  check('opening it and loading the cards marks nothing read', !changed.length, changed);
  const loaded = await page.eval<number>(`document.querySelectorAll('.catchup .cu-card .cu-msg[data-mid]').length`);
  check("the first cards' messages are loaded", loaded > 0, loaded);
  const railBadge = await page.eval<number>(`Number(document.querySelector('.rail-item:has(.rail-logo) .rail-count .count')?.textContent ?? 0)`);

  // ------------------------------------------------------------------ the phone's tab

  await page.size(390, 844, true);
  await page.goto(`${base}/#/inbox`);
  await Bun.sleep(1200);
  const tab = await page.eval<{ label: string; badge: number } | null>(`(() => { const t = [...document.querySelectorAll('.tabbar .tab')].find((b) => b.textContent.includes('Catch up')); return t ? { label: t.textContent.trim(), badge: Number(t.querySelector('.tab-badge')?.textContent ?? 0) } : null; })()`);
  check('the phone has a Catch up tab and no Triage tab', !!tab && !(await page.eval<boolean>(`[...document.querySelectorAll('.tabbar .tab')].some((b) => b.textContent.includes('Triage'))`)), tab);
  check('…its badge is the inbox button’s', tab?.badge === railBadge, { tab: tab?.badge, rail: railBadge });
  await page.eval(`[...document.querySelectorAll('.tabbar .tab')].find((b) => b.textContent.includes('Catch up')).click()`);
  await page.until(`location.hash === '#/triage' && !!document.querySelector('.catchup .cu-card')`, 8000).catch(() => {});
  // The card slides in.
  await Bun.sleep(800);
  const ph = await page.eval<{ hash: string; tabs: boolean; cards: number; overflow: boolean; active: boolean }>(
    `({ hash: location.hash, tabs: document.querySelector('.app').classList.contains('tabs'), cards: document.querySelectorAll('.catchup .cu-card').length, overflow: document.querySelector('.catchup-scroll').scrollWidth > document.querySelector('.catchup-scroll').clientWidth + 1, active: !!document.querySelector('.tabbar .tab.active')?.textContent.includes('Catch up') })`,
  );
  check('the tab opens Catch up, with the tab bar, on #/triage', ph.hash === '#/triage' && ph.tabs && ph.cards > 0 && ph.active, ph);
  check('…and nothing runs off the side', !ph.overflow);
  check('…with Mark all read and How it sorts in reach', await page.eval(`[...document.querySelectorAll('.catchup-head .btn')].filter((b) => /Mark all read|How it sorts/.test(b.textContent) && b.getBoundingClientRect().right <= innerWidth).length === 2`));
  check('…and no key hints on a phone', !(await page.eval<boolean>(`!!document.querySelector('.catchup-keys')`)));
  if (shots) {
    // A reply being typed, then left as it was.
    const dm = q0.keys.find((k, i) => !q0.mail[i])!;
    await page.eval(`document.querySelector('${card(dm)} textarea').focus()`);
    await page.send('Input.insertText', { text: 'On my way, ten minutes' });
    await Bun.sleep(300);
    await page.eval(`document.querySelector('${card(dm)}').scrollIntoView({ block: 'start' })`);
    await shot('phone-catchup-typing');
    await page.eval(`(() => { const t = document.querySelector('${card(dm)} textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); })()`);
  }

  // ------------------------------------------------------------------ keys

  await page.size(1400, 900);
  await page.goto(`${base}/#/inbox`);
  await page.until(`!!document.querySelector('.catchup .cu-card.focused')`, 10000);
  await Bun.sleep(600);
  await drawAll();
  let s = await pane();
  check('the first card has focus', s.focus === s.keys[0], [s.focus, s.keys[0]]);
  await key('j');
  s = await pane();
  check('j moves to the next card', s.focus === s.keys[1], [s.focus, s.keys[1]]);
  await key('j');
  await key('k');
  s = await pane();
  check('k moves back', s.focus === s.keys[1], [s.focus, s.keys[1]]);
  await key('k');
  await key('k');
  s = await pane();
  check('…and stops at the first', s.focus === s.keys[0]);

  const first = s.keys[0];
  await key('l');
  s = await pane();
  check('l puts it Later: to the end of the queue', s.keys[s.keys.length - 1] === first && s.keys[0] === q0.keys[1], s.keys.slice(0, 3));
  check('…and focus goes on to the next', s.focus === s.keys[0], s.focus);
  check('…with nothing new on the hub', (await unreadNow()).unread.get(first) === before.unread.get(first));

  // Done on an unread chat: off the queue, and read on the hub.
  const unreadChat = s.keys.find((k, i) => !s.mail[i] && (before.unread.get(k) ?? 0) > 0)!;
  await focusCard(unreadChat);
  await key('e');
  s = await pane();
  check('e is Done: the card leaves', !s.keys.includes(unreadChat));
  let read = false;
  for (let i = 0; i < 30 && !read; i++) {
    await Bun.sleep(250);
    read = (await unreadNow()).unread.get(unreadChat) === 0;
  }
  check('…and the hub has it read', read);
  await Bun.sleep(1500);
  check('…and it does not come back', !(await pane()).keys.includes(unreadChat));

  // Done on mail: off the queue, the thread read.
  const mailCard = s.keys.find((_, i) => s.mail[i]);
  if (mailCard) {
    await page.eval(`document.querySelector('${card(mailCard)} [data-track="done (mail)"]').click()`);
    let mread = false;
    for (let i = 0; i < 30 && !mread; i++) {
      await Bun.sleep(250);
      mread = (await unreadNow()).unread.get(mailCard) === 0;
    }
    check('Done on a mail card: gone, and the thread read', !(await pane()).keys.includes(mailCard) && mread);
  }

  // ------------------------------------------------------------------ a reply from a card

  s = await pane();
  const boot = (await unreadNow()).boot;
  const shapeOf = new Map(boot.conversations.map((c: any) => [c.id, c]));
  const target = s.keys.find((k, i) => !s.mail[i] && (shapeOf.get(k) as any)?.shape === 'direct' && ['discord', 'signal'].includes((shapeOf.get(k) as any)?.network))!;
  check('a DM to answer', !!target, target);
  const ti = s.keys.indexOf(target);
  const nextCard = s.keys[ti + 1];
  await focusCard(target);
  await key('r');
  s = await pane();
  check('r puts you in its reply box', s.active === 'TEXTAREA' && (await page.eval<boolean>(`document.activeElement.closest('[data-card]')?.dataset.card === '${target}'`)));
  const text = `just checking: j k e l ${Date.now()}`;
  await page.send('Input.insertText', { text });
  for (const k of ['j', 'e', 'l', 'k']) await key(k);
  s = await pane();
  const typed = await page.eval<string>(`document.activeElement.value ?? ''`);
  check('typing never fires a shortcut: j, e, l and k go into the box', s.focus === target && s.keys.includes(target) && s.keys.indexOf(target) === ti && typed === `${text}jelk`, { focus: s.focus, typed });
  await page.eval(`(() => { const t = document.activeElement; t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await Bun.sleep(200);
  await shot('desk-catchup-typing');
  await key('Escape');
  s = await pane();
  check('Esc leaves the box, and the card keeps focus', s.active !== 'TEXTAREA' && s.focus === target, s.active);
  await key('r');
  await key('Enter');
  await Bun.sleep(300);
  s = await pane();
  check('Enter sends: the card stays, marked Replied', s.keys.includes(target) && (await page.eval<boolean>(`!!document.querySelector('${card(target)} .cu-replied')`)));
  check('…focus moves to the next card, out of the box', s.focus === nextCard && s.active !== 'TEXTAREA', { focus: s.focus, next: nextCard, active: s.active });
  const hubCount = async () => ((await get(`/api/conversations/${target}/messages?limit=30`)).messages as any[]).filter((m) => m.body === text).length;
  let n = 0;
  for (let i = 0; i < 40 && n === 0; i++) {
    await Bun.sleep(250);
    n = await hubCount();
  }
  await Bun.sleep(2500);
  check('one message on the hub', (await hubCount()) === 1, await hubCount());
  const inCard = await page.eval<{ shown: number; pending: number }>(
    `(() => { const t = ${JSON.stringify(text)}; const ms = [...document.querySelectorAll('${card(target)} .cu-msg')].filter((m) => m.textContent.includes(t)); return { shown: ms.length, pending: ms.filter((m) => m.classList.contains('pending')).length }; })()`,
  );
  check('…and once in the card, as sent (no double echo)', inCard.shown === 1 && inCard.pending === 0, inCard);
  check('…and read on the hub', (await unreadNow()).unread.get(target) === 0 || (await get(`/api/conversations/${target}/messages?limit=5`)).messages.at(-1)?.body !== text);
  await page.goto(`${base}/#/inbox/c/${target}`);
  await page.until(`document.querySelectorAll('.msg').length > 0`, 15000);
  await Bun.sleep(1200);
  const inConv = await page.eval<{ shown: number; pending: number }>(
    `(() => { const t = ${JSON.stringify(text)}; const ms = [...document.querySelectorAll('.timeline-scroll .msg')].filter((m) => m.textContent.includes(t)); return { shown: ms.length, pending: ms.filter((m) => m.classList.contains('pending')).length }; })()`,
  );
  check('opening the conversation shows it once', inConv.shown === 1 && inConv.pending === 0, inConv);

  // ------------------------------------------------------------------ a new arrival joins the end

  await page.goto(`${base}/#/inbox`);
  await page.until(`!!document.querySelector('.catchup .cu-card')`, 10000);
  await Bun.sleep(3500);
  await drawAll();
  s = await pane();
  const fresh = (await unreadNow()).boot;
  // A DM the demo answers in (an encrypted Matrix room refuses a send from the API).
  const answers = (id: string) => {
    const c = fresh.conversations.find((c: any) => c.id === id);
    return c?.shape === 'direct' && !c.encrypted && ['discord', 'signal', 'whatsapp', 'telegram'].includes(c.network);
  };
  const quiet = fresh.attention.find((a: any) => !a.kind && !a.needs && answers(a.id) && !s.keys.includes(a.id));
  if (quiet) {
    check('wrote to a DM that needed nothing', (await post(`/api/conversations/${quiet.id}/send`, { body: 'are you around later?' })).ok);
    let joined = false;
    for (let i = 0; i < 120 && !joined; i++) {
      await Bun.sleep(250);
      await drawAll();
      const now = await pane();
      joined = now.keys.at(-1) === quiet.id;
    }
    const now = await pane();
    check('their answer joins the end of the queue', joined, now.keys.slice(-3));
    check('…with a "1 new" note, the rest where it was', now.fresh >= 1 && now.keys.slice(0, s.keys.length).join() === s.keys.join(), { fresh: now.fresh });
  } else console.log('      no quiet DM on this hub: a new arrival is not checked');

  // ------------------------------------------------------------------ Mark all read, then all caught up

  await drawAll();
  s = await pane();
  const unreadBefore = (await unreadNow()).unread;
  const plain = s.keys.filter((k, i) => !s.owed[i] && (unreadBefore.get(k) ?? 0) > 0);
  page.on('Page.javascriptDialogOpening', () => void page.send('Page.handleJavaScriptDialog', { accept: true }));
  await page.eval(`[...document.querySelectorAll('.catchup-head .btn')].find((b) => b.textContent.includes('Mark all read')).click()`);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await Bun.sleep(250);
    const now = await pane();
    gone = plain.every((k) => !now.keys.includes(k));
  }
  const kept = await pane();
  check('Mark all read: the cards with only something unread leave', gone, { left: plain.filter((k) => kept.keys.includes(k)) });
  check('…the replies you owe stay', kept.keys.length > 0 && kept.owed.every(Boolean), kept.owed.map(Number).join(''));

  for (let i = 0; i < 80; i++) {
    const p = await pane();
    if (p.empty) break;
    if (!p.focus) await key('j');
    await key('e');
  }
  await Bun.sleep(800);
  const end = await pane();
  const words = await page.eval<string>(`document.querySelector('.catchup-empty')?.innerText ?? ''`);
  check('Done on every card leaves "All caught up"', end.empty && /All caught up/.test(words) && end.waiting === 0, { words, waiting: end.waiting, left: end.keys.length });
  check('…with when the last message came, and How it sorts', /The last message came/.test(words) && /How it sorts/.test(words), words);
  await shot('desk-catchup-empty');
  await page.eval(`[...document.querySelectorAll('.catchup-empty .link-btn')].find((b) => b.textContent.includes('How it sorts')).click()`);
  await Bun.sleep(400);
  check('How it sorts opens the model page', (await page.eval<string>('location.hash')) === '#/model' && (await page.eval<boolean>(`!!document.querySelector('.model-page')`)));
  await page.size(390, 844, true);
  await page.goto(`${base}/#/triage`);
  await page.until(`!!document.querySelector('.catchup-empty')`, 8000).catch(() => {});
  await Bun.sleep(500);
  check('the phone shows it too', await page.eval<boolean>(`!!document.querySelector('.catchup-empty')`));
  await shot('phone-catchup-empty');

  const errors = page.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|WebSocket connection/.test(e));
  check('no script errors', !errors.length, errors);
} finally {
  await close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

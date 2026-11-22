/**
 * Status dots (docs/profile.md "Status dots"), end to end against a demo hub of its own in headless Chromium: the hub
 * sends the demo people's presence in the bootstrap, and a dot draws, with the network in its tooltip, on inbox and
 * sidebar rows, a DM's header, the profile's picture, a group's member list and the @ picker. In the dark theme and the
 * light one. No dot where nothing is known.
 *
 *   bun scripts/verify-presence.ts [--shots /tmp/shots]
 * Starts its own hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { launch } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'dither-presence-hub-'));
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
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
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
try {
  await until('the hub to answer', () => fetch(`${url}/api/health`).then((r) => r.ok));
  // The demo accounts tell presence as they start: wait for the bootstrap to carry it.
  const boot = await until('presence in the bootstrap', async () => {
    const b = (await (await fetch(`${url}/api/bootstrap`)).json()) as P.Bootstrap;
    return (b.presence?.length ?? 0) >= 8 ? b : null;
  });
  const known = new Map(boot.presence!.map((v) => [v.identityId, v]));
  const ids = new Map(boot.identities.map((i) => [i.id, i]));
  const persons = new Map(boot.persons.map((x) => [x.id, x]));
  // Server members the page learns of later (from a message page or the member list) are in it too, without their identity.
  const nets = new Set<string>([...known.keys()].flatMap((id) => ids.get(id)?.network ?? []));
  check(['discord', 'matrix', 'telegram'].every((n) => nets.has(n)) && !nets.has('whatsapp'), 'the bootstrap carries presence from the networks that give it', [...nets]);
  const present = (pid: string | null | undefined) => !!pid && (persons.get(pid)?.identityIds ?? []).some((i) => known.has(i));
  const dm = boot.conversations.find((c) => c.shape === 'direct' && c.network === 'discord' && present(c.peerPersonId) && c.lastMessageAt);
  const group = boot.conversations.find((c) => c.shape === 'group' && c.participantIds.some((i) => known.has(i) && known.get(i)!.state !== 'offline'));
  const channel = boot.conversations.find((c) => c.shape === 'channel' && c.network === 'discord' && c.name === 'general');
  if (!dm || !group || !channel) throw new Error(`the demo world lacks a place this checks: ${JSON.stringify({ dm: !!dm, group: !!group, channel: !!channel })}`);

  const dots = (scope: string) =>
    p.eval<{ state: string; title: string }[]>(
      `[...document.querySelectorAll(${JSON.stringify(`${scope} .avatar-presence`)})].filter((e) => e.getBoundingClientRect().width > 0).map((e) => ({ state: e.dataset.presence, title: e.title }))`,
    );
  const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));

  for (const theme of ['dither-dark', 'dither-light'] as const) {
    const tag = theme === 'dither-dark' ? 'dark' : 'light';
    await p.size(1280, 860);
    await p.goto(`${url}/#/inbox`);
    await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(theme)} }))`);
    // A new hash alone does not load the page again; the theme is read as it loads.
    await p.eval(`location.hash = ${JSON.stringify(`#/inbox/c/${dm.id}`)}; location.reload()`);
    await p.until(`document.documentElement.style.cssText.length > 0`, 15_000);
    const scheme = await p.eval<string>(`getComputedStyle(document.body).backgroundColor`);
    console.log(`     ${tag}: page background ${scheme}`);
    await p.until(`document.querySelectorAll('.conv-row').length > 3 && document.querySelectorAll('.msg').length > 0`, 20_000);

    // Rows: a dot on some, the network named; none says a network that gives no presence.
    const rows = await until('dots on the rows', async () => {
      const d = await dots('.conv-row');
      return d.length ? d : null;
    });
    check(rows.every((d) => / on (Discord|Matrix|Telegram|Signal)/.test(d.title) || d.title.startsWith('Around: ')), `${tag}: inbox rows show dots, each naming its network`, rows.slice(0, 4));
    // Merged across their accounts: the dot is the person's, so it may name another network than the DM's.
    const head = await dots('.conv-head');
    check(head.length === 1 && / on /.test(head[0].title), `${tag}: the DM's header shows their dot`, head);
    await shot(`inbox-${tag}`);

    // The profile's picture.
    await p.goto(`${url}/#/p/${encodeURIComponent(dm.peerPersonId!)}`);
    await p.until(`!!document.querySelector('.pf-hero')`, 15_000);
    const hero = await dots('.pf-hero');
    check(hero.length === 1, `${tag}: the profile's picture shows their dot`, hero);
    const words = await p.eval<string>(`document.querySelector('.pf-activity-card .pf-presence')?.textContent ?? ''`);
    check(/ on /.test(words), `${tag}: the Activity card says it in words`, words);
    await shot(`profile-${tag}`);

    // A group's members.
    await p.goto(`${url}/#/about/c/${encodeURIComponent(group.id)}`);
    await p.until(`document.querySelectorAll('.member').length > 1`, 15_000);
    const members = await dots('.member');
    check(members.length >= 1, `${tag}: the member list shows dots`, members);
    await shot(`members-${tag}`);
  }

  // The @ picker, in a Discord channel.
  await p.goto(`${url}/#/inbox/c/${encodeURIComponent(channel.id)}`);
  await p.until(`!!document.querySelector('.composer textarea, .composer [contenteditable]')`, 15_000);
  await p.eval(`document.querySelector('.composer textarea, .composer [contenteditable]').focus()`);
  await p.send('Input.insertText', { text: '@' });
  await p.until(`document.querySelectorAll('.mp-opt').length > 0`, 10_000);
  const picker = await until('dots in the picker', async () => {
    const d = await dots('.mp-opt');
    return d.length ? d : null;
  }, 10_000).catch(() => []);
  check(picker.length >= 1, 'the @ picker shows dots', picker.slice(0, 3));
  await shot('mentions-light');

  // Unknown is no dot: someone with no presence heard.
  const unknown = boot.persons.find((x) => !x.isSelf && !present(x.id) && x.identityIds.length);
  if (unknown) {
    await p.goto(`${url}/#/p/${encodeURIComponent(unknown.id)}`);
    await p.until(`!!document.querySelector('.pf-hero')`, 15_000);
    check((await dots('.pf-hero')).length === 0, 'no dot for someone whose presence is unknown', unknown.name);
  }
  check(p.errors.length === 0, 'no page errors', p.errors.slice(0, 3));
} finally {
  await close();
  hub.kill('SIGKILL');
  await hub.exited;
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);

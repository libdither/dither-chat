/**
 * The browser half of Web Push, with no phone: real permission and subscribe if this Chromium can reach a relay,
 * then a push handed to the service worker over DevTools, checked as a real notification.
 *   bun scripts/verify-push.ts https://host:port <ca.crt>
 */
import { launch } from './browser.ts';

const [url, ca] = process.argv.slice(2);
const origin = new URL(url).origin;
const { page: p, close } = await launch({ caCert: ca });
try {
  await p.size(1280, 800);
  await p.send('Browser.grantPermissions', { origin, permissions: ['notifications'] });
  const regs: any[] = [];
  p.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await p.send('ServiceWorker.enable');
  await p.goto(url + '#/settings');
  await p.until(`!!document.getElementById('push')`);
  await p.until(`navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.active)`, 15000);
  console.log('secure context', await p.eval('window.isSecureContext'), '| permission', await p.eval('Notification.permission'), '| PushManager', await p.eval(`'PushManager' in window`));

  const sub = await p.eval(`(async () => {
    const info = await (await fetch('/api/push')).json();
    const reg = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(info.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    try {
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      return { endpointHost: new URL(s.endpoint).host };
    } catch (e) { return { error: String(e) }; }
  })()`);
  console.log('real subscribe:', JSON.stringify(sub));

  const reg = regs.find((r) => r.scopeURL.startsWith(origin));
  const notifications = () => p.eval(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((ns) => ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data, actions: n.actions.map((a) => a.action) })))`);
  await p.send('ServiceWorker.deliverPushMessage', { origin, registrationId: reg.registrationId, data: JSON.stringify({ title: 'Alice Chen', body: 'push handler test', conversationId: 'cnv_test', messageId: 'm' }) });
  await Bun.sleep(800);
  // A visible, focused window closes it again by design; a test push always stays.
  console.log('after push, focused window:', JSON.stringify(await notifications()));
  await p.send('ServiceWorker.deliverPushMessage', { origin, registrationId: reg.registrationId, data: JSON.stringify({ title: 'Stays', body: 'test flag', test: true }) });
  await Bun.sleep(800);
  const shown = await notifications();
  console.log('after test push:', JSON.stringify(shown));
  if (!shown.some((n: any) => n.title === 'Stays')) process.exitCode = 1;
  await p.shot(process.argv[4] ?? '/tmp/push-settings.png');
  if (p.errors.length) console.log('page errors', p.errors);
} finally {
  await close();
}

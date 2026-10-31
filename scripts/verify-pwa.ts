/** Is the deployed hub really an installable PWA? bun scripts/verify-pwa.ts https://host:port <ca.crt> */
import { launch } from './browser.ts';

const [url, ca] = process.argv.slice(2);
const { page, close } = await launch({ caCert: ca });
try {
  await page.goto(url);
  await page.until(`document.querySelector('.app, .loading-screen') !== null`);
  await page.until(`navigator.serviceWorker && navigator.serviceWorker.getRegistration().then(r => !!r && !!r.active)`, 15000);
  const report = {
    isSecureContext: await page.eval('window.isSecureContext'),
    serviceWorker: await page.eval(`navigator.serviceWorker.getRegistration().then(r => ({ scope: r.scope, script: r.active.scriptURL, state: r.active.state }))`),
    manifest: await page.send('Page.getAppManifest'),
    installability: await page.send('Page.getInstallabilityErrors'),
    caches: await page.eval('caches.keys()'),
  };
  const m = report.manifest;
  console.log(JSON.stringify({ ...report, manifest: { url: m.url, errors: m.errors, name: m.parsed && undefined } }, null, 1));
  const parsed = JSON.parse(m.data);
  console.log('manifest', parsed.name, parsed.display, parsed.icons.map((i: any) => `${i.sizes}/${i.purpose}`).join(' '), 'shortcuts', parsed.shortcuts.length);
  const ok = report.isSecureContext && report.installability.installabilityErrors.length === 0 && m.errors.length === 0;
  console.log(ok ? 'INSTALLABLE' : 'NOT INSTALLABLE');
  process.exitCode = ok ? 0 : 1;
} finally {
  await close();
}

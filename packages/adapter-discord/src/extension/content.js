/*
 * ISOLATED-world content script. The only job is to shuttle messages between the
 * MAIN-world hook (window.postMessage) and the service worker (a long-lived
 * chrome.runtime port). It holds no secrets and makes no network calls.
 *
 *   hook.js --window('up')--> content.js --port--> sw.js --ws--> adapter
 *   adapter --ws--> sw.js --port--> content.js --window('down')--> hook.js
 */
(() => {
  'use strict';
  const TAG = '__dither_bridge__';
  let port = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'dither-bridge' });
    } catch (e) {
      // service worker not ready yet; retry shortly
      setTimeout(connect, 1000);
      return;
    }
    port.onMessage.addListener((payload) => {
      // commands + pings coming down from the adapter
      window.postMessage({ [TAG]: 'down', payload }, location.origin);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 1000);
    });
  }

  // Forward everything the hook emits up to the service worker.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d[TAG] !== 'up' || !d.payload) return;
    try {
      if (port) port.postMessage(d.payload);
    } catch (err) {
      // port died between checks; reconnect and drop this frame
      connect();
    }
  });

  // Chrome caps a port's lifetime; re-open well before the 5-minute limit so the
  // worker stays warm and the pipe never goes stale.
  setInterval(() => {
    try {
      port && port.disconnect();
    } catch (e) {}
    connect();
  }, 250000);

  connect();
})();

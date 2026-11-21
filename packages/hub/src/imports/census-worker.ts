/**
 * Runs a backup census off the hub's event loop: stretching the passphrase alone is 250 000 SHA-512 rounds,
 * and a census reads the whole file. Posts { progress } now and then, then { census } or { error, badPassphrase }.
 */
import { BadPassphrase, censusLegacy } from './signal-backup.ts';
import { censusDesktop, unpackDesktop } from './signal-desktop.ts';
import { BadBackupKey, countSnapshot } from './signal-v2.ts';
import { WrongKey } from './sqlcipher.ts';

declare const self: Worker;

type Job = { path: string; passphrase: string } | { v2: string; backupKey: string } | { desktop: { profile: string; key: string; dbPath: string; sourceSha: string } };

self.onmessage = (e: MessageEvent<Job>) => {
  if ('desktop' in e.data) {
    // A Signal Desktop profile: decrypt its database into the source's work folder (the reader uses the same copy).
    const d = e.data.desktop;
    try {
      const unpack = unpackDesktop({ profile: d.profile, key: Buffer.from(d.key, 'hex'), dbPath: d.dbPath, sourceSha: d.sourceSha, progress: (p) => postMessage({ progress: p }) });
      postMessage({ census: censusDesktop(d.dbPath, d.profile, unpack) });
    } catch (err: any) {
      postMessage({ error: String(err?.message ?? err), badKey: err instanceof WrongKey });
    }
    return;
  }
  if ('v2' in e.data) {
    try {
      postMessage({ census: countSnapshot(e.data.v2, Buffer.from(e.data.backupKey, 'hex')) });
    } catch (err: any) {
      postMessage({ error: String(err?.message ?? err), badKey: err instanceof BadBackupKey });
    }
    return;
  }
  try {
    const census = censusLegacy(e.data.path, e.data.passphrase, (pos, total) => postMessage({ progress: pos / total }));
    postMessage({ census });
  } catch (err: any) {
    postMessage({ error: String(err?.message ?? err), badPassphrase: err instanceof BadPassphrase });
  }
};

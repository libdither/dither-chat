/**
 * Shape of a Signal/Molly backup, without its content (packages/hub/src/imports/signal-backup.ts). The hub runs
 * the same census on uploads; this is for a file on disk.
 *
 *   bun scripts/signal-backup-probe.ts legacy <file.backup>
 *       The plaintext header only: format version, salt, IV.
 *   SIGNAL_BACKUP_PASSPHRASE_FILE=<file> bun scripts/signal-backup-probe.ts legacy <file.backup>
 *       Also decrypts the frames, checks their MACs, and counts.
 *   bun scripts/signal-backup-probe.ts v2 <plaintext frames>
 *       Counts frames of a decrypted backup-v2 stream (or Signal's .binproto test vectors).
 *
 * Prints counts, table and column names and month ranges only. The passphrase is read from a file so it stays
 * out of shell history and the process list.
 */
import { readFileSync } from 'node:fs';
import { censusLegacy, censusV2, sniffLegacy } from '../packages/hub/src/imports/signal-backup.ts';

const [mode, path] = process.argv.slice(2);
if (mode === 'legacy' && path) {
  const h = sniffLegacy(path);
  if (!h) {
    console.error('not a legacy Signal backup');
    process.exit(1);
  }
  console.log(`legacy backup: format version ${h.version}, salt ${h.salt ? 'yes' : 'no'}, iv ${h.ivBytes} bytes`);
  const pf = process.env.SIGNAL_BACKUP_PASSPHRASE_FILE;
  if (pf) console.log(censusLegacy(path, readFileSync(pf, 'utf8').trim(), (pos, total) => process.stderr.write(`\r${Math.round((pos / total) * 100)}%`)));
  else console.log('(set SIGNAL_BACKUP_PASSPHRASE_FILE to count frames)');
} else if (mode === 'v2' && path) console.log(censusV2(readFileSync(path)));
else {
  console.error('usage: bun scripts/signal-backup-probe.ts legacy <file.backup> | v2 <frames>');
  process.exit(2);
}

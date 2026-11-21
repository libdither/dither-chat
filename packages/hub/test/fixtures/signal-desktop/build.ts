/**
 * Rebuild db.sqlite and db.sqlite-wal from profile.ts with the real SQLCipher (4.x), so the tests check the reader
 * against SQLCipher's own output. Tests use the committed files and need no sqlcipher.
 *
 *   SQLCIPHER=/path/to/sqlcipher bun packages/hub/test/fixtures/signal-desktop/build.ts
 *   (on NixOS: nix build nixpkgs#sqlcipher, then its bin/sqlcipher)
 *
 * The WAL rows go in after a checkpoint with checkpoints off, and the two files are copied while the connection is
 * still open, so they stay in the log as they would on a running Desktop.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY, rowsSql, SCHEMA, walSql } from './profile.ts';

const bin = process.env.SQLCIPHER ?? 'sqlcipher';
const work = mkdtempSync(join(tmpdir(), 'sigdesk-fixture-'));
const here = import.meta.dir;
const script = [
  `PRAGMA key = "x'${KEY.toString('hex')}'";`,
  'PRAGMA journal_mode = WAL;',
  ...SCHEMA.map((s) => s + ';'),
  'BEGIN;',
  ...rowsSql().map((s) => s + ';'),
  'COMMIT;',
  'PRAGMA wal_checkpoint(TRUNCATE);',
  'PRAGMA wal_autocheckpoint = 0;',
  'BEGIN;',
  ...walSql().map((s) => s + ';'),
  'COMMIT;',
  `.shell cp ${join(work, 'db.sqlite')} ${join(work, 'db.sqlite-wal')} ${here}/`,
  '',
].join('\n');
const p = Bun.spawnSync([bin, join(work, 'db.sqlite')], { stdin: new TextEncoder().encode(script), stdout: 'pipe', stderr: 'pipe' });
rmSync(work, { recursive: true, force: true });
if (p.exitCode !== 0 || p.stderr.length) {
  console.error(p.stderr.toString());
  process.exit(1);
}
console.log(`wrote ${here}/db.sqlite and db.sqlite-wal`);

/**
 * A temporary directory in memory, for a test whose code under test syncs to disk and has no switch to stop it
 * (secret files, the checkpointer's own connection). On a busy disk one fsync of a few megabytes can take seconds, so
 * such a test timed out under load while doing nothing wrong. On a memory filesystem an fsync returns at once, and
 * nothing in a test has to outlive the process. Falls back to the usual temporary directory where there is none
 * (macOS).
 */
import { accessSync, constants, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHM = '/dev/shm';

function memRoot(): string {
  try {
    accessSync(SHM, constants.W_OK);
    return SHM;
  } catch {
    return tmpdir();
  }
}

export function memTempDir(prefix: string): string {
  return mkdtempSync(join(memRoot(), prefix));
}

/**
 * History imports (docs/import.md): raw sources the hub keeps under <data>/imports/sources/<id>/, uploaded
 * from a client or copied in. A source is never changed once complete; everything derived from it can be
 * thrown away and made again.
 */

import type { Network } from './ontology.ts';

export type ImportSourceKind =
  | 'signal-backup' //    Signal/Molly legacy .backup (encrypted, needs the 30-digit passphrase)
  | 'signal-backup-v2' // a SignalBackups/ folder (backup v2)
  | 'discord-package' //  Discord's own data package (zip)
  | 'dce-html' //         DiscordChatExporter HTML, with downloaded media
  | 'dce-json' //         DiscordChatExporter JSON
  | 'unknown';

export type ImportSourceStatus =
  | 'uploading' //        bytes still arriving; send the rest from `received`
  | 'checking' //         complete; hashing and working out what it is
  | 'needs-passphrase' // an encrypted backup with no passphrase yet
  | 'counting' //         reading it through with the passphrase (progress)
  | 'ready' //            hashed and, where it can be, counted
  | 'error';

/** What a census found: counts and shapes only, never content. Format-specific keys beyond these. */
export interface ImportCensus {
  format: string;
  [k: string]: unknown;
}

export interface ImportSourceView {
  id: string;
  network: Network | null;
  /** The hub account its history belongs to, once known. */
  accountId: string | null;
  kind: ImportSourceKind;
  label: string;
  status: ImportSourceStatus;
  /** Total bytes: expected while uploading, found once complete. */
  size: number;
  received: number;
  files: number;
  /** Of the single file, or of the sorted (path, size, sha256) list for a folder: the source's identity. */
  sha256: string | null;
  addedAt: number;
  addedBy: string;
  hasPassphrase: boolean;
  /** 0..1 while counting. */
  progress: number | null;
  census: ImportCensus | null;
  error: string | null;
  notes: string | null;
}

/** Uploads go in pieces of at most this, each a PUT at its offset, so a dropped connection resumes. */
export const IMPORT_CHUNK = 8 * 1024 * 1024;
/** The largest single-file source accepted. */
export const MAX_IMPORT = 64 * 1024 * 1024 * 1024;

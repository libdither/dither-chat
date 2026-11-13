/** What the hub keeps now, from its settings alone (docs/history.md): for Settings → Message history's note and Forget. */
import type * as P from '@dither-chat/protocol';

/** Whether the hub keeps this kind now, everywhere or for some network or account (store.ts keeps, setStatus, logsPresence, recordsMembers). */
export function keeping(r: P.RetentionSettings, what: P.KeptKind): boolean {
  const some = (k: keyof P.KeepSettings) => r[k] || Object.values(r.sources).some((s) => s[k] === true);
  switch (what) {
    case 'deleted':
      return some('deleted'); // kept while hidden too, out of sight
    case 'disappeared':
      return some('disappearing');
    case 'edits':
    case 'reactions':
    case 'receipts':
      return some(what);
    case 'changes':
      return r.changes;
    case 'statuses':
      return r.adversarial && r.statuses && r.changes;
    case 'presence':
      return r.adversarial && r.presence && r.changes;
    case 'members':
      return r.adversarial && r.members;
    case 'voice':
      return r.adversarial && !!r.voice;
  }
}

/** The kinds only adversarial features keep (docs/history.md). */
export const ADVERSARIAL_KINDS: P.KeptKind[] = ['deleted', 'disappeared', 'statuses', 'presence', 'members', 'voice'];

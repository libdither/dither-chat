/**
 * Settings → Mail: when a thread you read is marked read on the server (§14 Q3). After a second in view (the default),
 * or only when you mark it; either way it counts as read here. Kept on the hub (GET/PUT /api/mail/settings), so every
 * device follows it.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api, toast } from '../../state.ts';

export function MailReadSetting() {
  const [s, setS] = useState<P.MailSettings | null>(null);
  useEffect(() => {
    api<P.MailSettings>('/api/mail/settings').then(setS, () => {});
  }, []);
  if (!s) return null;
  const pick = (markRead: P.MailSettings['markRead']) => {
    const was = s;
    setS({ ...s, markRead });
    api<P.MailSettings>('/api/mail/settings', { method: 'PUT', body: { markRead } }).then(setS, (e) => {
      setS(was);
      toast({ kind: 'error', title: 'Could not save that', body: (e as Error).message });
    });
  };
  return (
    <>
      <div class="set-rule mail-read-set">
        <span class="set-rule-label">Mark read on the server</span>
        <div class="level-picker">
          {(
            [
              ['view', 'After a second in view'],
              ['manual', 'Only when I mark it'],
            ] as const
          ).map(([m, label]) => (
            <button class={`chip-btn ${s.markRead === m ? 'on' : ''}`} aria-pressed={s.markRead === m} onClick={() => pick(m)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p class="set-help">
        {s.markRead === 'view'
          ? 'A thread on screen for a second is marked read in your other mail apps too.'
          : 'A thread you read here stays unread in your other mail apps until you choose Mark read.'}
      </p>
    </>
  );
}

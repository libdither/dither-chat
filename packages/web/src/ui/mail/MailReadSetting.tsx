/**
 * Settings → Mail: when a thread you read is marked read on the server (§14 Q3). After a second in view (the default),
 * or only when you mark it; either way it counts as read here. Then which remote pictures load by themselves and
 * whether trackers are removed (docs/mail.md "Pictures and trackers"). Kept on the hub (GET/PUT /api/mail/settings),
 * so every device follows them.
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
  const save = (change: Partial<P.MailSettings>) => {
    const was = s;
    setS({ ...s, ...change });
    api<P.MailSettings>('/api/mail/settings', { method: 'PUT', body: change }).then(setS, (e) => {
      setS(was);
      toast({ kind: 'error', title: 'Could not save that', body: (e as Error).message });
    });
  };
  const pick = (markRead: P.MailSettings['markRead']) => save({ markRead });
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
      <div class="set-rule mail-pictures-set">
        <span class="set-rule-label">Load pictures</span>
        <div class="level-picker">
          {(
            [
              ['none', 'None'],
              ['shared', 'Ones unlikely to tell'],
              ['all', 'All'],
            ] as const
          ).map(([v, label]) => (
            <button class={`chip-btn ${(s.pictures ?? 'shared') === v ? 'on' : ''}`} aria-pressed={(s.pictures ?? 'shared') === v} onClick={() => save({ pictures: v })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p class="set-help">
        {(s.pictures ?? 'shared') === 'none'
          ? 'No picture loads until you ask, so no sender learns when you open their mail.'
          : (s.pictures ?? 'shared') === 'shared'
            ? 'Pictures at addresses every copy of the mail shares (logos, product photos) load; ones whose address is yours alone wait, since loading them tells the sender you opened it.'
            : 'Every picture loads, through your hub: senders can tell when you open their mail, but never see your address.'}{' '}
        A sender’s own rule (Always or Never, from a mail’s picture bar) comes first.
      </p>
      <div class="set-rule mail-trackers-set">
        <span class="set-rule-label">Trackers</span>
        <div class="level-picker">
          {(
            [
              ['remove', 'Remove'],
              ['keep', 'Keep'],
            ] as const
          ).map(([v, label]) => (
            <button class={`chip-btn ${(s.trackers ?? 'remove') === v ? 'on' : ''}`} aria-pressed={(s.trackers ?? 'remove') === v} onClick={() => save({ trackers: v })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p class="set-help">
        {(s.trackers ?? 'remove') === 'remove'
          ? 'Invisible pictures that only report an open are taken out of every mail.'
          : 'Invisible tracking pictures stay in, and load only when a mail loads all its pictures: the sender sees the open, as they meant to.'}
      </p>
    </>
  );
}

/**
 * Settings → Sending (docs/sync.md "The send queue"): how long a held send counts down before it goes by itself, kept
 * on the hub so every device counts the same. 0 to 120 seconds; 0 means no countdown, a held send waits for you.
 */
import type * as P from '@dither-chat/protocol';
import { HOLD_SECONDS_DEFAULT, HOLD_SECONDS_MAX } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api, toast } from '../state.ts';

const CHOICES = [0, 5, 10, 15, 20, 30, 60, HOLD_SECONDS_MAX];

export function SendingSettings() {
  const [s, setS] = useState<P.SendSettings | null>(null);
  useEffect(() => {
    api<P.SendSettings>('/api/send-settings').then(setS, () => setS({ holdSeconds: HOLD_SECONDS_DEFAULT }));
  }, []);
  if (!s) return null;
  const save = (holdSeconds: number) => {
    const before = s;
    setS({ holdSeconds });
    api<P.SendSettings>('/api/send-settings', { method: 'PUT', body: { holdSeconds } }).then(setS, (e) => {
      setS(before);
      toast({ kind: 'error', title: 'Could not save', body: (e as Error).message });
    });
  };
  const choices = CHOICES.includes(s.holdSeconds) ? CHOICES : [...CHOICES, s.holdSeconds].sort((a, b) => a - b);
  return (
    <section class="set-block" id="set-sending">
      <h3>Sending</h3>
      <div class="set-rule">
        <span class="set-rule-label">When the chat moved on while a message waited</span>
        <select class="select" aria-label="When the chat moved on while a message waited" value={s.holdSeconds} onChange={(e) => save(Number((e.target as HTMLSelectElement).value))}>
          {choices.map((n) => (
            <option value={n}>{n === 0 ? 'Wait for me' : `Send after ${n} s`}</option>
          ))}
        </select>
      </div>
      <p class="set-help">
        A message waits when anything came into its chat after what you could see as you pressed Send. It shows Send, Edit
        and Cancel, and counts down only while one of your devices shows that chat. With nobody looking it waits, and you
        are told.
      </p>
    </section>
  );
}

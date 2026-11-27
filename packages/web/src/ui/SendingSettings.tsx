/**
 * Settings → Sending, kept on the hub, which is the one that acts on it:
 * - how long a held send counts down before it goes by itself (docs/sync.md "The send queue"), so every device counts
 *   the same: 0 to 120 seconds; 0 means no countdown, a held send waits for you;
 * - "When a picture is cut off" (docs/uploads.md "A send the hub holds"): how long the hub waits for a phone that stopped
 *   uploading a message's pictures before it sends them as far as they came, and how good they must be by then.
 */
import type * as P from '@dither-chat/protocol';
import { CUT_WAITS, HOLD_SECONDS_DEFAULT, HOLD_SECONDS_MAX } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { cutSettings, loadCutSettings, setCutSettings } from '../cutsettings.ts';
import { api, toast } from '../state.ts';

const CHOICES = [0, 5, 10, 15, 20, 30, 60, HOLD_SECONDS_MAX];

const waitName = (ms: number | null) => (ms === null ? 'Never' : `${ms / 60_000} min`);
const QUALITY: [P.CutQuality, string, string][] = [
  ['preview', 'A preview', 'the whole picture, blurry'],
  ['fair', 'Fair', 'looks done on a phone'],
  ['good', 'Good', 'close to the photo'],
];

export function SendingSettings() {
  const [s, setS] = useState<P.SendSettings | null>(null);
  useEffect(() => {
    api<P.SendSettings>('/api/send-settings').then(setS, () => setS({ holdSeconds: HOLD_SECONDS_DEFAULT }));
    void loadCutSettings();
  }, []);
  const c = cutSettings.value;
  const save = (holdSeconds: number) => {
    const before = s;
    setS({ holdSeconds });
    api<P.SendSettings>('/api/send-settings', { method: 'PUT', body: { holdSeconds } }).then(setS, (e) => {
      setS(before);
      toast({ kind: 'error', title: 'Could not save', body: (e as Error).message });
    });
  };
  const choices = !s || CHOICES.includes(s.holdSeconds) ? CHOICES : [...CHOICES, s.holdSeconds].sort((a, b) => a - b);
  return (
    <section class="set-block" id="set-sending">
      <h3>Sending</h3>
      {s && (
        <>
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
        </>
      )}
      <p class="set-help">
        Photos upload so that whatever part the hub has is the whole picture, sharpening as the rest comes. A message you send while they upload is the hub's to
        send from then on, even if this phone goes away.
      </p>
      <div class="set-rule">
        <span class="set-rule-label">If the phone stops partway, send what the hub has after</span>
        <div class="level-picker" role="group" aria-label="Send what the hub has after">
          {CUT_WAITS.map((ms) => (
            <button
              key={String(ms)}
              class={`chip-btn ${c && c.afterMs === ms ? 'on' : ''}`}
              aria-pressed={!!c && c.afterMs === ms}
              data-wait={String(ms)}
              data-track="settings: cut wait"
              disabled={!c}
              onClick={() => void setCutSettings({ afterMs: ms })}
            >
              {waitName(ms)}
            </button>
          ))}
        </div>
      </div>
      <div class="set-rule">
        <span class="set-rule-label">Only if each picture is at least</span>
        <div class="level-picker" role="group" aria-label="Only if each picture is at least">
          {QUALITY.map(([q, name, what]) => (
            <button
              key={q}
              class={`chip-btn ${c?.atLeast === q ? 'on' : ''}`}
              aria-pressed={c?.atLeast === q}
              data-quality={q}
              title={what}
              data-track="settings: cut quality"
              disabled={!c || c.afterMs === null}
              onClick={() => void setCutSettings({ atLeast: q })}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <p class="set-help">
        {c?.afterMs === null
          ? 'Never: a message whose photos stopped partway waits for this phone, however long.'
          : `${QUALITY.find(([q]) => q === (c?.atLeast ?? 'fair'))![1]}: ${QUALITY.find(([q]) => q === (c?.atLeast ?? 'fair'))![2]}. Videos and other files never go half done: a message with one waits for the phone.`}
      </p>
    </section>
  );
}

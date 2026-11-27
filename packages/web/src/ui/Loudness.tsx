/**
 * The loudness scale on the page (docs/notifications.md), a chunk of its own (LoudnessLazy.tsx): a message's Why
 * (the scale, the reasons with how far each moved it, Louder / Quieter for the person or the chat), the one optional
 * why after an answer, and its part of Settings. The calibration feed is a page of its own (CalibrationPane.tsx).
 */
import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { BAND_NAME, BAND_RANGE, LOUD_BANDS, LOUDER_WAITS, LOUDER_WHY, QUIETER_WAITS, QUIETER_WHY, WAIT_LABEL, WHY_LABEL } from '@dither-chat/protocol';
import { answer, attnState, fetchLoudness, forgetLearned, loadAttention, sendWhy, setAttentionPrefs, whyAsk } from '../loudness.ts';
import { go } from '../state.ts';
import { showSection } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Sheet } from './Sheet.tsx';
import './loudness.css';

/** The scale, 0 to 100, its four bands and where this one sits. */
function LoudScale({ loudness, band }: { loudness: number; band: P.LoudBand }) {
  return (
    <div class="loud-scale" data-loudness={Math.round(loudness)} aria-label={`Loudness ${Math.round(loudness)} of 100: ${BAND_NAME[band]}`}>
      <div class="loud-bar">
        {LOUD_BANDS.map((b) => (
          <span class={`loud-seg loud-${b} ${b === band ? 'on' : ''}`} style={{ flexGrow: BAND_RANGE[b][1] - BAND_RANGE[b][0] }} title={BAND_NAME[b]} />
        ))}
        <span class="loud-mark" style={{ left: `${Math.max(0, Math.min(100, loudness))}%` }} />
      </div>
      <div class="loud-legend">
        <span>Unread</span>
        <span>Show</span>
        <span>Sound</span>
      </div>
    </div>
  );
}

const points = (by: number) => `${by > 0 ? '+' : by < 0 ? '−' : ''}${Math.abs(Math.round(by))}`;

/**
 * A message's loudness and why, under its tier's reasons on the bell: fetched when the bell opens. `marks` false
 * leaves Louder / Quieter out (your own message).
 */
export function WhyLoud({ m, marks = true, onDone }: { m: { id: string; triage?: P.TriageView | null }; marks?: boolean; onDone?: () => void }) {
  const [v, setV] = useState<P.LoudView | null | undefined>(undefined);
  useEffect(() => void fetchLoudness(m.id).then(setV), [m.id]);
  if (v === undefined) return <div class="loud-why loading" aria-busy="true" />;
  const say = (a: 'louder' | 'quieter', scope: 'person' | 'chat') => (e: Event) => {
    e.stopPropagation();
    void answer(m, a, 'sheet', scope);
    onDone?.();
  };
  return (
    <div class="loud-why" data-loud-why>
      {v && (
        <>
          <div class="loud-head">
            <b>{BAND_NAME[v.band]}</b>
            <span class="loud-num">{Math.round(v.loudness)}</span>
            {!v.live && <small> · worked out beside the tiers, not what was sent</small>}
          </div>
          <LoudScale loudness={v.loudness} band={v.band} />
          {v.rule && <div class="loud-rule">{v.rule}</div>}
          <ul class="loud-reasons">
            {v.reasons.map((r, i) => (
              <li key={i} class={r.by > 0 ? 'up' : r.by < 0 ? 'down' : ''}>
                <span>{r.text}</span>
                {i > 0 && Math.round(r.by) !== 0 && <span class="loud-by">{points(r.by)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {marks && (
        <div class="loud-say">
          <button class="chip-btn" data-track="loud louder person" onClick={say('louder', 'person')}>
            <Icon name="chevronUp" size={13} /> Louder for this person
          </button>
          <button class="chip-btn" data-track="loud quieter person" onClick={say('quieter', 'person')}>
            <Icon name="chevronDown" size={13} /> Quieter for this person
          </button>
          <button class="chip-btn" data-track="loud louder chat" onClick={say('louder', 'chat')}>
            <Icon name="chevronUp" size={13} /> Louder for this chat
          </button>
          <button class="chip-btn" data-track="loud quieter chat" onClick={say('quieter', 'chat')}>
            <Icon name="chevronDown" size={13} /> Quieter for this chat
          </button>
        </div>
      )}
      <button
        class="link-btn loud-learned-link"
        data-track="loud what it learned"
        onClick={() => {
          onDone?.();
          go({ view: 'settings' });
          setTimeout(() => showSection('set-loudness', 'auto'), 120);
        }}
      >
        What it learned
      </button>
    </div>
  );
}

/** The one optional why after an answer: a chip, how long it could have waited (or when you'd have wanted it), or your words. */
export function WhyFollowUp() {
  const ask = whyAsk.value;
  const [reason, setReason] = useState<P.WhyReason | null>(null);
  const [wait, setWait] = useState<P.WhyWait | null>(null);
  const [text, setText] = useState('');
  const [until, setUntil] = useState('');
  useEffect(() => {
    setReason(null);
    setWait(null);
    setText('');
    setUntil('');
  }, [ask?.answerId]);
  if (!ask) return null;
  const quieter = ask.side === 'quieter';
  const close = () => (whyAsk.value = null);
  const send = () => {
    const end = until ? new Date(`${until}T23:59`).getTime() : NaN;
    void sendWhy({ answerId: ask.answerId, ...(reason ? { reason } : {}), ...(wait ? { wait } : {}), ...(text.trim() ? { text: text.trim() } : {}), ...(Number.isFinite(end) ? { until: end } : {}) });
  };
  return (
    <Sheet onClose={close} label="Why?" class="loud-follow">
      <div class="loud-follow-body" data-why-ask={ask.side}>
        <h3>{quieter ? 'Why quieter?' : 'Why louder?'}</h3>
        <small>Optional. It changes only the part of what it learned that your answer names.</small>
        <div class="chip-row">
          {(quieter ? QUIETER_WHY : LOUDER_WHY).map((r) => (
            <button class={`chip-btn ${reason === r ? 'on' : ''}`} data-why={r} aria-pressed={reason === r} onClick={() => setReason(reason === r ? null : r)}>
              {WHY_LABEL[r]}
            </button>
          ))}
        </div>
        <b class="loud-q">{quieter ? 'How long could it have waited?' : 'When would you have wanted it?'}</b>
        <div class="chip-row">
          {(quieter ? QUIETER_WAITS : LOUDER_WAITS).map((w) => (
            <button class={`chip-btn ${wait === w ? 'on' : ''}`} data-wait={w} aria-pressed={wait === w} onClick={() => setWait(wait === w ? null : w)}>
              {WAIT_LABEL[w]}
            </button>
          ))}
        </div>
        <input class="input" placeholder="Or say it in your words (read on the hub's machine only)" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <label class="loud-until">
          <span>Until (optional)</span>
          <input class="input" type="date" value={until} onInput={(e) => setUntil((e.target as HTMLInputElement).value)} />
        </label>
        <div class="loud-actions">
          <button class="btn" onClick={close}>
            Skip
          </button>
          <button class="btn primary" data-track="loud why send" disabled={!reason && !wait && !text.trim()} onClick={send}>
            Send
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function Choice<T extends string>({ value, options, onPick, label }: { value: T; options: [T, string][]; onPick: (v: T) => void; label: string }) {
  return (
    <div class="level-picker" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button class={`chip-btn ${value === v ? 'on' : ''}`} role="radio" aria-checked={value === v} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

const MODE_NOTE: Record<P.AttentionMode, string> = {
  tiers: 'Notifications follow the tiers; the scale is off.',
  shadow: 'Worked out beside the tiers for now: what it says is shown and scored, the tiers still decide.',
  on: 'The scale decides what sounds, what shows silently in the shade, and what stays in the inbox.',
};

/** Settings → How readily it sounds: the nudge, the computer first, asking, drifting, and what it learned. */
export function LoudnessSettings() {
  useEffect(() => void loadAttention(), []);
  const s = attnState.value;
  if (!s) return null;
  const p = s.prefs;
  const set = (patch: Partial<P.AttentionPrefs>) => void setAttentionPrefs(patch);
  return (
    <div class="loud-settings" data-mode={s.mode}>
      <small class="set-help">{MODE_NOTE[s.mode]}</small>
      <b>How readily it sounds</b>
      <Choice
        label="How readily it sounds"
        value={p.readily}
        onPick={(readily) => set({ readily })}
        options={[
          ['less', 'Less readily'],
          ['learned', 'As it learned'],
          ['more', 'More readily'],
        ]}
      />
      <small data-sounds-today>
        {s.soundsToday} {s.soundsToday === 1 ? 'sound' : 'sounds'} today. Shown, never a limit.
      </small>
      <label class="toggle-row">
        <input type="checkbox" checked={p.computerFirst} onChange={(e) => set({ computerFirst: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>The computer comes first</b>
          <small>While a computer is in use, the phone stays silent for most things, and a chat open and read there sends nothing.</small>
        </span>
      </label>
      <b>Ask me</b>
      <small>
        Notifications worth asking about open on the Notification calibration page, never in your way: Sound, Show or Inbox, when you get to them. Your answers teach it most.{' '}
        <button class="link-btn" data-track="loud open calibration" onClick={() => go({ view: 'calibration' })}>
          {s.pending ? `${s.pending} to answer` : 'Open it'}
        </button>
      </small>
      <Choice
        label="How many open as cards"
        value={p.ask}
        onPick={(ask) => set({ ask })}
        options={[
          ['never', 'Never'],
          ['rarely', 'One a day'],
          ['often', 'Up to three a day'],
        ]}
      />
      <label class="toggle-row">
        <input type="checkbox" checked={p.drifting} onChange={(e) => set({ drifting: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>People you're drifting from</b>
          <small>A note in Your attention on people you used to answer and lately don't.</small>
        </span>
      </label>
      <b>What it learned</b>
      {s.learned.length ? (
        <ul class="loud-learned">
          {s.learned.map((l) => (
            <li data-learned={l.key}>
              <span>{l.text}</span>
              <button class="link-btn" data-track="loud forget" onClick={() => void forgetLearned(l.key, true)}>
                Forget
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <small>Nothing yet beyond where it starts. Answer a question or say Louder or Quieter on a message's bell.</small>
      )}
    </div>
  );
}

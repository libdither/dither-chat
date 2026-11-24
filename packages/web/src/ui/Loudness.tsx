/**
 * The loudness scale on the page (docs/notifications.md), a chunk of its own (LoudnessLazy.tsx): a message's Why
 * (the scale, the reasons with how far each moved it, Louder / Quieter for the person or the chat), the one optional
 * why after an answer, the check-in card at the top of the inbox, and its part of Settings.
 */
import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { BAND_NAME, BAND_RANGE, LOUD_BANDS, LOUDER_WAITS, LOUDER_WHY, QUIETER_WAITS, QUIETER_WHY, WAIT_LABEL, WHY_LABEL } from '@dither-chat/protocol';
import { answer, answerCheckin, askLess, attnState, checkins, fetchLoudness, forgetLearned, loadAttention, sendWhy, setAttentionPrefs, whyAsk } from '../loudness.ts';
import { go } from '../state.ts';
import { showSection } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Sheet } from './Sheet.tsx';
import './loudness.css';

/** The scale, 0 to 100, its five bands and where this one sits. */
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
        <span>Next look</span>
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

const CHECKIN_ANSWERS: Record<P.CheckinView['side'], { q: string; answers: [string, string][] }> = {
  sounded: {
    q: 'This sounded. Was it worth it?',
    answers: [
      ['worth', 'Worth it'],
      ['could_wait', 'Could have waited'],
      ['shouldnt', "Shouldn't have reached me"],
    ],
  },
  quiet: {
    q: 'This stayed quiet. Would you have wanted it sooner?',
    answers: [
      ['sooner', "Wish I'd known sooner"],
      ['fine', 'Fine where it was'],
    ],
  },
  foryou: {
    q: 'Was this worth seeing?',
    answers: [
      ['glad', 'Glad I saw this'],
      ['not', 'Not for me'],
    ],
  },
};

/** One check-in at a time, at the top of the inbox: answer it, skip it, or ask less. */
export function CheckinCard() {
  const c = checkins.value[0];
  if (!c) return null;
  const s = CHECKIN_ANSWERS[c.side];
  return (
    <div class="loud-checkin" data-checkin={c.side} role="group" aria-label="A question about a notification">
      <div class="loud-checkin-q">
        <Icon name={c.side === 'sounded' ? 'bell' : c.side === 'quiet' ? 'bellOff' : 'sparkles'} size={14} />
        <b>{s.q}</b>
      </div>
      <button class="loud-checkin-msg" onClick={() => c.conversationId && go({ view: 'inbox', conv: c.conversationId, msg: c.messageId })}>
        <span class="loud-checkin-title">{c.title}</span>
        <span class="loud-checkin-preview">{c.preview}</span>
        {c.note && <small>{c.note}</small>}
      </button>
      <div class="chip-row">
        {s.answers.map(([a, label]) => (
          <button class="chip-btn" data-answer={a} data-track={`checkin ${a}`} onClick={() => void answerCheckin(c, a)}>
            {label}
          </button>
        ))}
      </div>
      <div class="loud-checkin-foot">
        <button class="link-btn" data-track="checkin skip" onClick={() => void answerCheckin(c, null)}>
          Skip
        </button>
        <button class="link-btn" data-track="checkin ask less" onClick={() => void askLess()}>
          Ask me less
        </button>
      </div>
    </div>
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
  on: 'The scale decides what sounds, shows, waits for your next look, or stays in the inbox.',
};

/** Settings → How readily it sounds: the nudge, next look, the computer first, asking, drifting, and what it learned. */
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
      <b>Next look</b>
      <small>What can wait comes together in one quiet notification: when you open the app or unlock the phone, at set times, or both.</small>
      <Choice
        label="When the next look comes"
        value={p.nextLook}
        onPick={(nextLook) => set({ nextLook })}
        options={[
          ['open', 'When I look'],
          ['times', 'At set times'],
          ['both', 'Both'],
        ]}
      />
      {p.nextLook !== 'open' && (
        <div class="quiet-times">
          {p.times.map((t, i) => (
            <input class="input" type="time" value={t} aria-label={`Next look time ${i + 1}`} onChange={(e) => set({ times: p.times.map((x, j) => (j === i ? (e.target as HTMLInputElement).value : x)) })} />
          ))}
          {p.times.length < 4 && (
            <button class="chip-btn" onClick={() => set({ times: [...p.times, '20:00'] })}>
              Add a time
            </button>
          )}
          {p.times.length > 0 && (
            <button class="chip-btn" onClick={() => set({ times: p.times.slice(0, -1) })}>
              Remove the last
            </button>
          )}
        </div>
      )}
      {s.held > 0 && <small>{s.held} waiting for the next look.</small>}
      <label class="toggle-row">
        <input type="checkbox" checked={p.computerFirst} onChange={(e) => set({ computerFirst: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>The computer comes first</b>
          <small>While a computer is in use, the phone stays silent for most things, and a chat open and read there sends nothing.</small>
        </span>
      </label>
      <b>Ask me</b>
      <small>A question now and then at the top of the inbox, about something that sounded or stayed quiet. Your answers teach it most.</small>
      <Choice
        label="How often it asks"
        value={p.ask}
        onPick={(ask) => set({ ask })}
        options={[
          ['never', 'Never'],
          ['rarely', 'Once a day'],
          ['often', 'Up to three a day'],
        ]}
      />
      {s.pausedUntil && s.pausedUntil > Date.now() && <small>Paused after three skips, until {new Date(s.pausedUntil).toLocaleDateString()}.</small>}
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

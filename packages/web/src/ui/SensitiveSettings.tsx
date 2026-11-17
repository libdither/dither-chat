/** @jsxRuntime classic */
/** @jsx h */
/**
 * Settings → Sensitive messages (docs/sensitive.md): on or off, the two lines (cover, hide), how a covered message
 * looks and where a hidden one goes; how the model's chances agree with your answers; and the question it is asked,
 * with a new one tried on your answers before it is put in use.
 */
import { h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api, loadSensitive, sensitive, setSensitive } from '../state.ts';

const pct = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`);

function Agreement({ a, label }: { a: P.SensitiveAgreement; label?: string }) {
  if (!a.n) return <p class="set-help">{label ?? 'No answers yet'}: answer on a covered message, or from a message's menu (Sensitive…).</p>;
  const m = a.matrix;
  return (
    <div class="sens-agree">
      <table>
        <tr>
          <th>{label ?? `Your answers (${a.n})`}</th>
          <th>you: sensitive</th>
          <th>you: fine</th>
        </tr>
        <tr>
          <th>model covers or hides</th>
          <td>{m.yesSensitive}</td>
          <td>{m.yesFine}</td>
        </tr>
        <tr>
          <th>model shows</th>
          <td>{m.noSensitive}</td>
          <td>{m.noFine}</td>
        </tr>
      </table>
      <p class="set-help">
        Agrees with you on {pct(a.agreement)} · average precision {a.ap == null ? '–' : a.ap.toFixed(2)}
        {a.best && ` · the cover line that agrees most: ${a.best.line.toFixed(2)} (${pct(a.best.agreement)})`}
        {a.unjudged ? ` · ${a.unjudged} not judged by it yet` : ''}
      </p>
    </div>
  );
}

export function SensitiveSettings() {
  useEffect(() => void loadSensitive(true), []);
  const st = sensitive.value;
  const [question, setQuestion] = useState<string | null>(null);
  const [trial, setTrial] = useState<P.SensitiveTrial | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!st)
    return (
      <section class="set-block" id="set-sensitive">
        <h3>Sensitive messages</h3>
        <p class="set-help">Asking the hub…</p>
      </section>
    );
  const s = st.settings;
  const change = (patch: Partial<P.SensitiveSettings>) => {
    setErr(null);
    setSensitive(patch).catch((e) => setErr((e as Error).message));
  };
  const inUse = st.prompts.find((p) => p.inUse);
  const typed = question ?? inUse?.question ?? '';
  const tryIt = () => {
    setBusy(true);
    setErr(null);
    api<P.SensitiveTrial>('/api/sensitive/prompts', { method: 'POST', body: { question: typed } }).then(
      (t) => (setBusy(false), setTrial(t), void loadSensitive(true)),
      (e) => (setBusy(false), setErr((e as Error).message)),
    );
  };
  const adopt = (v: number) => {
    setErr(null);
    api<P.SensitiveState>(`/api/sensitive/prompts/${v}/adopt`, { method: 'POST' }).then(
      (next) => ((sensitive.value = next), setTrial(null), setQuestion(null)),
      (e) => setErr((e as Error).message),
    );
  };
  const line = (key: 'cover' | 'hide', label: string, help: string) => (
    <div class="set-rule">
      <label class="set-rule-label" for={`sens-${key}`}>
        {label}
      </label>
      <input id={`sens-${key}`} type="range" min={0} max={100} step={1} value={Math.round(s[key] * 100)} onChange={(e) => change({ [key]: +(e.target as HTMLInputElement).value / 100 })} />
      <span class="sens-num">{s[key].toFixed(2)}</span>
      <small class="set-help">{help}</small>
    </div>
  );
  return (
    <section class="set-block" id="set-sensitive">
      <h3>Sensitive messages</h3>
      <label class="toggle-row">
        <input type="checkbox" checked={s.on} onChange={(e) => change({ on: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>Cover messages the model thinks are sensitive</b>
          <small>{st.model ? `The local model (${st.model}) reads each message's text, on this machine.` : 'No model: only messages you mark are covered.'}{st.pending ? ` ${st.pending} waiting to be read.` : ''}</small>
        </span>
      </label>
      {line('cover', 'Cover from', 'The model’s chance from which a message is covered.')}
      {line('hide', 'Hide from', 'From here up it is hidden.')}
      <div class="set-rule">
        <span class="set-rule-label">A covered message</span>
        <div class="level-picker" role="radiogroup" aria-label="A covered message">
          {(
            [
              ['blur', 'Blurred'],
              ['bar', 'Black bars'],
            ] as const
          ).map(([k, label]) => (
            <button role="radio" aria-checked={s.style === k} class={`chip-btn ${s.style === k ? 'on' : ''}`} onClick={() => change({ style: k })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div class="set-rule">
        <span class="set-rule-label">A hidden message</span>
        <div class="level-picker" role="radiogroup" aria-label="A hidden message">
          {(
            [
              ['line', 'One line in its place'],
              ['gone', 'Gone, counted at the top'],
            ] as const
          ).map(([k, label]) => (
            <button role="radio" aria-checked={s.top === k} class={`chip-btn ${s.top === k ? 'on' : ''}`} onClick={() => change({ top: k })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <h4>How the model agrees with you</h4>
      <Agreement a={st.agreement} />

      <h4>The question it is asked</h4>
      <textarea class="sens-question" rows={3} value={typed} onInput={(e) => (setQuestion((e.target as HTMLTextAreaElement).value), setTrial(null))} />
      <div class="set-actions">
        <button class="btn" disabled={busy || !st.model || typed.trim() === inUse?.question} onClick={tryIt}>
          {busy ? 'Asking…' : 'Try on my answers'}
        </button>
        {question !== null && (
          <button class="btn ghost" onClick={() => (setQuestion(null), setTrial(null))}>
            Back to the one in use
          </button>
        )}
      </div>
      {trial && (
        <div class="sens-trial">
          <Agreement a={trial.agreement} label={`Tried (v${trial.prompt.version})`} />
          <Agreement a={trial.inUse} label={`In use (v${trial.inUse.version})`} />
          <button class="btn" onClick={() => adopt(trial.prompt.version)}>
            Use v{trial.prompt.version}
          </button>
          <small class="set-help"> Asks it again about new messages and the last 2,000.</small>
        </div>
      )}
      {st.prompts.length > 1 && (
        <details class="sens-prompts">
          <summary>Earlier questions ({st.prompts.length})</summary>
          {st.prompts.map((p) => (
            <div class="sens-prompt">
              <b>v{p.version}</b> {p.inUse ? '(in use)' : ''} {p.question}
              {!p.inUse && (
                <span>
                  {' '}
                  <button class="link-btn" onClick={() => (setQuestion(p.question), setTrial(null))}>
                    Edit
                  </button>{' '}
                  <button class="link-btn" onClick={() => adopt(p.version)}>
                    Use
                  </button>
                </span>
              )}
            </div>
          ))}
        </details>
      )}
      {err && <p class="set-error">{err}</p>}
    </section>
  );
}

/**
 * A poll in the timeline and making one (docs/polls.md): a chunk of its own, loaded the first time a poll is shown
 * or made (PollLazy.tsx). The card has a bar per option, your vote marked, the voters where the network shows them
 * (Signal), and its end; you choose, then Vote. A poll you made ends early from its card where the network allows.
 */
import { useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { POLL_RULES, pollDraftProblem, pollHoursLabel } from '@dither-chat/protocol';
import { renderMarkdown } from '../markdown.ts';
import { identityName } from '../model.ts';
import { canEndPoll, endPoll, makePoll, vote, voter } from '../polls.ts';
import { Modal } from './bits.tsx';
import { Icon } from './icons.tsx';

/** An option's emoji: a custom one (`<:name:id>`) as its picture. Questions and options are plain text. */
const emoji = (text: string, network: P.Network) => ({ __html: renderMarkdown(text, { network, user: () => null, room: () => null }) });

/** "3 days left", "5 hours left", "less than an hour left". */
function left(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'} left`;
  return 'less than an hour left';
}

export function PollCard({ m }: { m: P.MessageView }) {
  const p = m.poll!;
  const mine = p.options.filter((o) => o.mine).map((o) => o.id);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const account = voter(m);
  const choosing = picked ?? mine;
  const changed = picked !== null && (picked.length !== mine.length || picked.some((x) => !mine.includes(x)));
  const votes = p.options.reduce((n, o) => n + o.count, 0);
  const people = p.voters ?? (p.multi ? null : votes);
  const showCounts = p.ended || mine.length > 0 || !account;
  const pick = (id: string) => {
    if (!account || busy) return;
    if (p.multi) setPicked(choosing.includes(id) ? choosing.filter((x) => x !== id) : [...choosing, id]);
    else setPicked(choosing[0] === id ? [] : [id]);
  };
  const send = async (options: string[]) => {
    setBusy(true);
    if (await vote(m, options)) setPicked(null);
    setBusy(false);
  };
  return (
    <div class={`poll-card ${p.ended ? 'ended' : ''}`} data-track-area="poll">
      <div class="poll-q">{p.question}</div>
      <div class="poll-how">{p.ended ? 'Poll ended' : p.multi ? 'Choose one or more' : 'Choose one'}</div>
      <ul class="poll-options" role={account ? (p.multi ? 'group' : 'radiogroup') : undefined}>
        {p.options.map((o) => {
          const on = choosing.includes(o.id);
          const share = votes ? Math.round((o.count / votes) * 100) : 0;
          const names = o.voters?.map(identityName) ?? [];
          return (
            <li>
              <button
                class={`poll-option ${on ? 'on' : ''} ${o.mine ? 'mine' : ''}`}
                role={account ? (p.multi ? 'checkbox' : 'radio') : undefined}
                aria-checked={account ? on : undefined}
                disabled={!account || busy}
                onClick={() => pick(o.id)}
                title={names.length ? names.join(', ') : undefined}
              >
                {showCounts && p.counted && <span class="poll-bar" style={{ width: `${share}%` }} aria-hidden="true" />}
                <span class="poll-mark" aria-hidden="true">{on || o.mine ? <Icon name="check" size={13} /> : null}</span>
                {o.emoji && <span class="poll-emoji" dangerouslySetInnerHTML={emoji(o.emoji, m.network)} />}
                <span class="poll-text">{o.text}</span>
                {showCounts && p.counted && (
                  <span class="poll-count">
                    {o.count} <small>{share}%</small>
                  </span>
                )}
              </button>
              {showCounts && names.length > 0 && <div class="poll-voters">{names.join(', ')}</div>}
            </li>
          );
        })}
      </ul>
      <div class="poll-foot">
        <span>
          {p.counted ? (people !== null ? `${people} ${people === 1 ? 'person' : 'people'} voted` : `${votes} vote${votes === 1 ? '' : 's'}`) : 'No count yet'}
          {!p.ended && p.expires ? ` · ${left(p.expires - Date.now())}` : ''}
        </span>
        <span class="poll-actions">
          {account && changed && (
            <button class="btn small primary" disabled={busy || (!choosing.length && !mine.length)} onClick={() => send(choosing)}>
              {choosing.length ? 'Vote' : 'Take vote back'}
            </button>
          )}
          {account && changed && (
            <button class="btn small" disabled={busy} onClick={() => setPicked(null)}>
              Cancel
            </button>
          )}
          {account && !changed && mine.length > 0 && (
            <button class="btn small" disabled={busy} onClick={() => send([])}>
              Take vote back
            </button>
          )}
          {canEndPoll(m) && (
            <button class="btn small" disabled={busy} onClick={() => confirm('End this poll now? Nobody can vote after.') && void endPoll(m)}>
              End poll
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

/** Making a poll: a question, 2 to 10 options, one or several choices, and how long, where the network has a timer. */
export function PollMaker({ conversationId, network, accountId, onClose }: { conversationId: string; network: P.Network; accountId?: string; onClose: () => void }) {
  const rules = POLL_RULES[network]!;
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [hours, setHours] = useState(rules.defaultHours);
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const draft: P.PollDraft = { question: question.trim(), options: filled, multi, ...(rules.hours && hours ? { hours } : {}) };
  const problem = question.trim() && filled.length ? pollDraftProblem(network, draft) : null;
  const set = (i: number, v: string) => {
    const next = options.map((o, j) => (j === i ? v : o));
    // A new empty row once the last is used, up to the network's most.
    if (i === next.length - 1 && v && next.length < rules.maxOptions) next.push('');
    setOptions(next);
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (problem || busy || !question.trim() || filled.length < 2) return;
    setBusy(true);
    if (await makePoll(conversationId, draft, accountId)) onClose();
    else setBusy(false);
  };
  return (
    <Modal title="New poll" onClose={onClose}>
      <form class="poll-maker" onSubmit={submit}>
        <label class="field-label" for="poll-q">
          Question
        </label>
        <input id="poll-q" class="poll-maker-q" value={question} maxLength={rules.questionMax} onInput={(e) => setQuestion(e.currentTarget.value)} placeholder="What should we ask?" autoFocus />
        <div class="field-label">Options</div>
        <div class="poll-maker-options">
          {options.map((o, i) => (
            <div class="poll-maker-row">
              <input value={o} maxLength={rules.optionMax} onInput={(e) => set(i, e.currentTarget.value)} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} />
              {options.length > 2 && (
                <button type="button" class="icon-btn small" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        <label class="check-row">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.currentTarget.checked)} />
          <span>Allow more than one choice</span>
        </label>
        {rules.hours && (
          <label class="poll-maker-hours">
            <span>Open for</span>
            <select value={hours} onChange={(e) => setHours(Number(e.currentTarget.value))}>
              {rules.hours.map((h) => (
                <option value={h}>{pollHoursLabel(h)}</option>
              ))}
            </select>
          </label>
        )}
        {problem && <p class="det-note error">{problem}</p>}
        <div class="modal-actions">
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={busy || !!problem || !question.trim() || filled.length < 2}>
            {busy ? 'Sending…' : 'Send poll'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

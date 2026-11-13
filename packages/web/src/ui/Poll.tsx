/**
 * A poll in the timeline and making one (docs/polls.md): a chunk of its own, loaded the first time a poll is shown
 * or made (PollLazy.tsx). The card has a bar per option, your vote marked, the voters where the network shows them
 * (Signal), and its end; you choose, then Vote. A poll you made ends early from its card where the network allows.
 */
import { useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { POLL_RULES, pollDraftProblem, pollHoursLabel } from '@dither-chat/protocol';
import { renderMarkdown } from '../markdown.ts';
import { identityName } from '../model.ts';
import { canEndPoll, endPoll, makePoll, vote, voter } from '../polls.ts';
import { SourceChip } from './bits.tsx';
import { Icon } from './icons.tsx';
import './Poll.css';

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

/**
 * Making a poll, in the composer's place (docs/polls.md "Making one"): shaped like the poll it becomes, with the
 * network's name and limits in its header. `question`: what the box held, as the question to start from. Enter moves
 * to the next line and sends from the last; Esc goes back to the message box.
 */
export function PollMaker({ conversationId, network, accountId, question: initial = '', onClose, onSent }: { conversationId: string; network: P.Network; accountId?: string; question?: string; onClose: () => void; onSent?: () => void }) {
  const rules = POLL_RULES[network]!;
  const [question, setQuestion] = useState(initial.replace(/\s+/g, ' ').trim().slice(0, rules.questionMax));
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [hours, setHours] = useState(rules.defaultHours);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const draft: P.PollDraft = { question: question.trim(), options: filled, multi, ...(rules.hours && hours ? { hours } : {}) };
  const problem = question.trim() && filled.length ? pollDraftProblem(network, draft) : null;
  const ready = !busy && !problem && !!question.trim() && filled.length >= 2;
  const set = (i: number, v: string) => {
    const next = options.map((o, j) => (j === i ? v : o));
    // A new empty row once the last is used, up to the network's most.
    if (i === next.length - 1 && v && next.length < rules.maxOptions) next.push('');
    setOptions(next);
  };
  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    if (await makePoll(conversationId, draft, accountId)) {
      onSent?.();
      onClose();
    } else setBusy(false);
  };
  const fields = () => [...(form.current?.querySelectorAll<HTMLInputElement>('input[data-line]') ?? [])];
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const all = fields();
      const at = all.indexOf(e.currentTarget as HTMLInputElement);
      const next = all[at + 1];
      if (next && !(e.ctrlKey || e.metaKey) && (e.currentTarget as HTMLInputElement).value.trim()) next.focus();
      else void submit();
    }
  };
  const how = `${rules.minOptions} to ${rules.maxOptions} options`;
  return (
    <form class="poll-draft" ref={form} onSubmit={submit} data-track-area="new poll">
      <div class="poll-draft-head">
        <Icon name="list" size={14} />
        New poll
        <SourceChip network={network} />
        <span class="poll-draft-space" />
        <span class="poll-draft-limit">{how}</span>
        <button type="button" class="icon-btn small" data-track="new poll (close)" onClick={onClose} aria-label="Back to the message" title="Back to the message (Esc)">
          <Icon name="x" size={14} />
        </button>
      </div>
      <input data-line class="poll-draft-q" value={question} maxLength={rules.questionMax} onInput={(e) => setQuestion(e.currentTarget.value)} onKeyDown={keys} placeholder="Ask a question" aria-label="Question" autoFocus />
      <div class="poll-draft-options">
        {options.map((o, i) => (
          <div class="poll-draft-row">
            <span class={`poll-mark ${multi ? 'square' : ''}`} aria-hidden="true" />
            <input data-line value={o} maxLength={rules.optionMax} onInput={(e) => set(i, e.currentTarget.value)} onKeyDown={keys} placeholder={i < 2 ? `Option ${i + 1}` : 'Add an option'} aria-label={`Option ${i + 1}`} />
            {options.length > 2 && o && (
              <button type="button" class="icon-btn small" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                <Icon name="x" size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div class="poll-draft-foot">
        <div class="poll-draft-pills" role="radiogroup" aria-label="How many choices">
          <button type="button" role="radio" aria-checked={!multi} class={`poll-pill ${!multi ? 'on' : ''}`} onClick={() => setMulti(false)}>
            One choice
          </button>
          <button type="button" role="radio" aria-checked={multi} class={`poll-pill ${multi ? 'on' : ''}`} onClick={() => setMulti(true)}>
            Several
          </button>
          {rules.hours && (
            <label class="poll-pill poll-pill-select" title="How long it stays open">
              <Icon name="clock" size={12} />
              <select value={hours} onChange={(e) => setHours(Number(e.currentTarget.value))} aria-label="Open for">
                {rules.hours.map((h) => (
                  <option value={h}>Open {pollHoursLabel(h)}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        {problem && <span class="poll-draft-problem">{problem}</span>}
        <span class="poll-draft-space" />
        <button class="send-btn" data-track="send poll" disabled={!ready} aria-label="Send poll" title={ready ? 'Send poll' : 'A question and two options first'}>
          <Icon name="send" size={17} />
        </button>
      </div>
    </form>
  );
}

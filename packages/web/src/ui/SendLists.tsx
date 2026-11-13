/**
 * Send later's time picker and list, and what you saved on Discord (docs/sending.md). A chunk of its own, loaded when
 * one of them is first opened (SendExtras.tsx). Each works the same on a phone (a sheet) and a computer (a dialog).
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, sendLaterProblem } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { authorName, convTitle, plainBody } from '../model.ts';
import { cancelScheduled, editScheduled, fromLocalInput, laterChoices, loadSaved, loadScheduled, scheduled, sendScheduledNow, toLocalInput, unsaveOnNetwork, whenWords } from '../sending.ts';
import { db, go } from '../state.ts';
import { Modal } from './bits.tsx';
import { Icon } from './icons.tsx';
import type { SendPanel } from './SendExtras.tsx';

export function SendPanelView({ panel, onClose }: { panel: SendPanel; onClose: () => void }) {
  if (panel.kind === 'later') return <LaterPicker title={panel.title} initial={panel.initial} onPick={(t) => (onClose(), panel.onPick(t))} onClose={onClose} />;
  if (panel.kind === 'scheduled') return <ScheduledList conversationId={panel.conversationId} onClose={onClose} />;
  return <SavedList onClose={onClose} />;
}

// ------------------------------------------------------------------ the time

function LaterPicker({ title, initial, onPick, onClose }: { title: string; initial?: number; onPick: (t: number) => void; onClose: () => void }) {
  const now = Date.now();
  const [value, setValue] = useState(toLocalInput(initial ?? now + 3_600_000));
  const at = fromLocalInput(value);
  const problem = sendLaterProblem(at ?? NaN, Date.now());
  return (
    <Modal title={title} onClose={onClose}>
      <div class="send-lists">
      <div class="later-picker">
        <div class="later-choices">
          {laterChoices(now).map((c) => (
            <button class="btn" data-track="send later (choice)" onClick={() => onPick(c.at)}>
              {c.label}
            </button>
          ))}
        </div>
        <label class="later-custom">
          <span>Or pick a time</span>
          <input type="datetime-local" value={value} min={toLocalInput(now + 60_000)} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
        </label>
        {at !== null && problem && <p class="form-error">{problem}</p>}
        <p class="muted small">The hub sends it then, from the same account. If that account is not connected, it waits; more than half an hour late, it waits for you to say so.</p>
        <div class="later-actions">
          <button class="btn primary" data-track="send later (custom)" disabled={at === null || !!problem} onClick={() => at !== null && onPick(at)}>
            Schedule
          </button>
        </div>
      </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ what waits

const STATE_WORDS: Record<P.ScheduledState, string> = { waiting: 'Waiting', sending: 'Sending', held: 'Held', failed: 'Failed', sent: 'Sent' };

function ScheduledList({ conversationId, onClose }: { conversationId?: string; onClose: () => void }) {
  const [here, setHere] = useState(!!conversationId);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => void loadScheduled(true), []);
  const all = scheduled.value;
  const items = (all ?? []).filter((x) => !here || x.conversationId === conversationId);
  return (
    <Modal title="Send later" onClose={onClose} wide>
      <div class="send-lists">
      {conversationId && (
        <div class="sched-tabs" role="tablist">
          <button class={here ? 'on' : ''} data-track="scheduled (here)" onClick={() => setHere(true)}>
            This chat
          </button>
          <button class={here ? '' : 'on'} data-track="scheduled (everywhere)" onClick={() => setHere(false)}>
            Everywhere
          </button>
        </div>
      )}
      {all === null ? <p class="muted">Loading…</p> : !items.length ? <p class="muted">Nothing waits to be sent{here ? ' here' : ''}.</p> : null}
      <ul class="scheduled-list">
        {items.map((v) => (
          <ScheduledRow key={v.id} v={v} showPlace={!here} editing={editing === v.id} onEdit={(on) => setEditing(on ? v.id : null)} onOpen={() => (onClose(), go({ view: 'inbox', conv: v.conversationId, ...(v.messageId ? { msg: v.messageId } : {}) }))} />
        ))}
      </ul>
      </div>
    </Modal>
  );
}

function ScheduledRow({ v, showPlace, editing, onEdit, onOpen }: { v: P.ScheduledSendView; showPlace: boolean; editing: boolean; onEdit: (on: boolean) => void; onOpen: () => void }) {
  const c = db.conversations.get(v.conversationId);
  const acc = db.accounts.get(v.accountId);
  const [body, setBody] = useState(v.body);
  const [when, setWhen] = useState(toLocalInput(Math.max(v.dueAt, Date.now() + 5 * 60_000)));
  const at = fromLocalInput(when);
  const problem = sendLaterProblem(at ?? NaN, Date.now());
  const hub = v.where === 'hub';
  return (
    <li class={`scheduled-row ${v.state}`}>
      <div class="scheduled-head">
        <Icon name={v.state === 'sent' ? 'check' : v.state === 'failed' || v.state === 'held' ? 'alert' : 'clock'} size={14} />
        <b>{v.state === 'sent' ? 'Sent' : whenWords(v.dueAt, Date.now())}</b>
        {showPlace && (
          <button class="link" data-track="scheduled (open)" onClick={onOpen}>
            {convTitle(c)}
          </button>
        )}
        <span class="muted small">
          {acc ? `${NETWORK_META[acc.network].name} · ${acc.label}` : ''}
          {v.silent ? ' · silently' : ''}
          {v.mentionReplied === false ? ' · no ping' : ''}
          {v.state !== 'waiting' && v.state !== 'sent' ? ` · ${STATE_WORDS[v.state]}` : ''}
        </span>
      </div>
      {editing ? (
        <div class="scheduled-edit">
          <textarea rows={3} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
          <input type="datetime-local" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} />
          {at !== null && problem && <p class="form-error">{problem}</p>}
          <div class="later-actions">
            <button class="btn" onClick={() => onEdit(false)}>
              Keep as it was
            </button>
            <button
              class="btn primary"
              data-track="scheduled (save edit)"
              disabled={at === null || !!problem || !body.trim()}
              onClick={async () => {
                if (await editScheduled(v.id, { body, dueAt: at! })) onEdit(false);
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <p class="scheduled-body">
          {plainBody(v.body, c?.network ?? 'discord').slice(0, 280) || <em>No text</em>}
          {v.files.length > 0 && <em class="muted"> · {v.files.length === 1 ? v.files[0] : `${v.files.length} files`}</em>}
        </p>
      )}
      {v.note && <p class={`small ${v.state === 'failed' || v.state === 'held' ? 'form-error' : 'muted'}`}>{v.note}</p>}
      {!editing && v.state !== 'sent' && v.state !== 'sending' && (
        <div class="scheduled-actions">
          {hub && (
            <button class="btn small" data-track="scheduled (edit)" onClick={() => onEdit(true)}>
              <Icon name="pencil" size={13} /> Edit
            </button>
          )}
          {hub && (
            <button class="btn small" data-track="scheduled (send now)" onClick={() => void sendScheduledNow(v.id)}>
              <Icon name="send" size={13} /> Send now
            </button>
          )}
          <button class="btn small danger" data-track="scheduled (cancel)" onClick={() => void cancelScheduled(v)}>
            <Icon name="trash" size={13} /> Cancel
          </button>
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ saved on Discord

function SavedList({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState<P.SavedPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadSaved().then(setPage, (e) => setError((e as Error).message));
  }, []);
  const msgs = new Map((page?.messages ?? []).map((m) => [m.id, m]));
  const names = new Map((page?.identities ?? []).map((i) => [i.id, i.nickname || i.displayName || i.handle || '']));
  const who = (id: string | null) => (id && names.get(id)) || authorName(id);
  const now = Date.now();
  const more = async (account: string) => {
    const oldest = Math.min(...(page?.saved ?? []).filter((s) => s.accountId === account).map((s) => s.savedAt));
    try {
      setPage(await loadSaved({ account, before: oldest }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Saved on Discord" onClose={onClose} wide>
      <div class="send-lists">
      {error && <p class="form-error">{error}</p>}
      {page?.errors.map((e) => <p class="muted small">{e.error}</p>)}
      {!page && !error && <p class="muted">Asking Discord…</p>}
      {page && !page.saved.length && <p class="muted">Nothing saved. Save a message from its menu: Save on Discord, or Remind Me.</p>}
      <ul class="scheduled-list">
        {page?.saved.map((s) => {
          const m = msgs.get(s.messageId);
          const c = s.conversationId ? db.conversations.get(s.conversationId) : null;
          const overdue = s.dueAt !== null && s.dueAt <= now;
          return (
            <li class={`scheduled-row ${overdue ? 'held' : ''}`}>
              <div class="scheduled-head">
                <Icon name={s.dueAt !== null ? 'clock' : 'star'} size={14} />
                <b>{m ? who(m.authorId) : (s.summary?.author ?? 'A message')}</b>
                <span class="muted small">
                  {c ? convTitle(c) : (s.summary?.place ?? '')}
                  {s.dueAt !== null ? ` · ${overdue ? 'was due' : 'reminds you'} ${whenWords(s.dueAt, now)}` : ''}
                </span>
              </div>
              <p class="scheduled-body">{m ? plainBody(m.body, m.network).slice(0, 280) || <em>No text</em> : (s.summary?.text ?? <em class="muted">Not loaded here yet</em>)}</p>
              {s.note && <p class="muted small">{s.note}</p>}
              <div class="scheduled-actions">
                {s.conversationId && (
                  <button class="btn small" data-track="saved (open)" onClick={() => (onClose(), go({ view: 'inbox', conv: s.conversationId!, msg: s.messageId }))}>
                    <Icon name="external" size={13} /> Open
                  </button>
                )}
                <button
                  class="btn small danger"
                  data-track="saved (remove)"
                  onClick={async () => {
                    await unsaveOnNetwork({ id: s.messageId });
                    setPage((p) => p && { ...p, saved: p.saved.filter((x) => x.messageId !== s.messageId) });
                  }}
                >
                  <Icon name="trash" size={13} /> Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {page?.more.map((a) => (
        <button class="btn" data-track="saved (more)" onClick={() => void more(a)}>
          More from {db.accounts.get(a)?.label ?? 'Discord'}
        </button>
      ))}
      </div>
    </Modal>
  );
}

/**
 * Settings → Catching up (docs/catch-up.md): each stretch of time where the hub may have missed messages, across an
 * account or in one chat, why it thinks so, and what it is doing about it. The hub finds, plans and fetches; this asks
 * it and draws what it says, and lets you stop a hole, check every chat of it, or put it away. A chunk of its own,
 * loaded when Settings draws it (Settings.tsx CatchUpLazy).
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { clock, dayLabel } from '../format.ts';
import { convLabel } from '../model.ts';
import { api, db, go, rev, toast } from '../state.ts';
import { NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';
import './catchup.css';

const STATE_LABEL: Record<P.CatchUpState, string> = {
  checking: 'Checking',
  fetching: 'Fetching',
  done: 'Done',
  clear: 'Nothing missing',
  unfetchable: 'Needs an import',
  stopped: 'Stopped',
};

/** The pill's look: the index jobs' (styles.css .job-pill). */
const PILL: Record<P.CatchUpState, string> = { checking: 'running', fetching: 'running', done: 'done', clear: 'done', unfetchable: 'failed', stopped: 'paused' };

const CAUSE_LABEL: Record<P.CatchUpCause, string> = {
  lost: 'The hub lost events',
  dropped: 'Dropped while the hub was away',
  offline: 'The account was offline',
  adapter: 'The account missed messages',
  behind: 'The network has newer messages',
  report: 'Reported',
  nearby: 'Other chats missed messages then',
};

const RESTING_LABEL: Record<NonNullable<P.CatchUpHoleView['resting']>['why'], string> = {
  hours: 'Outside your usual hours',
  cap: "Read the day's share",
  break: 'Taking a break',
};

const CHAT_LABEL: Record<P.CatchUpChatView['state'], string> = {
  queued: 'Waiting',
  fetching: 'Fetching',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  unfetchable: 'Can’t fetch',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** "today at 14:05", "Tuesday at 9:30". */
const when = (ts: number) => `${dayLabel(ts).replace(/^(Today|Yesterday)$/, (d) => d.toLowerCase())} at ${clock(ts)}`;
/** The stretch, said once: "today 03:40 – 15:49", or across days "Tuesday 22:10 – today 07:30". */
function stretch(from: number, to: number): string {
  const a = dayLabel(from).replace(/^(Today|Yesterday)$/, (d) => d.toLowerCase());
  const b = dayLabel(to).replace(/^(Today|Yesterday)$/, (d) => d.toLowerCase());
  return a === b ? `${a} ${clock(from)} – ${clock(to)}` : `${a} ${clock(from)} – ${b} ${clock(to)}`;
}

const open = (h: P.CatchUpHoleView) => h.state === 'checking' || h.state === 'fetching';

function chatName(id: string, name: string): string {
  const c = db.conversations.get(id);
  return c ? convLabel(c) : name || 'a chat';
}

function HoleRow({ h, reload }: { h: P.CatchUpHoleView; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<P.CatchUpChatView[] | null>(null);
  const [shown, setShown] = useState(false);
  const act = async (fn: () => Promise<unknown>, what: string) => {
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (e: any) {
      toast({ kind: 'error', title: `Could not ${what}`, body: e.message });
    } finally {
      setBusy(false);
    }
  };
  // The chats, when shown: looked at again with the list (reload bumps h.updatedAt).
  useEffect(() => {
    if (!shown) return;
    let live = true;
    api<P.CatchUpHoleView>(`/api/catch-up/${h.id}`).then(
      (v) => live && setList(v.list ?? []),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, [shown, h.updatedAt, h.pages]);
  const title = h.scope === 'chat' && h.conversationId ? chatName(h.conversationId, h.conversationName ?? '') : h.accountName;
  const pct = h.chats ? Math.round((h.chatsDone / h.chats) * 100) : open(h) ? 0 : 100;
  const left = h.left.reduce((n, l) => n + l.count, 0);
  return (
    <li class={`job catchup ${PILL[h.state]}`} data-hole={h.id}>
      <div class="job-head">
        {h.network ? <NetGlyph network={h.network} size={14} /> : <Icon name="refresh" size={14} />}
        <b class="job-name">{title}</b>
        <span class="job-kind">
          {h.scope === 'chat' ? `${h.accountName} · one chat` : 'Every chat'} · {stretch(h.from, h.to)}
        </span>
        <span class={`job-pill ${PILL[h.state]}`}>{STATE_LABEL[h.state]}</span>
      </div>
      <p class="job-line catchup-why">{h.causes.map((c) => CAUSE_LABEL[c]).join(' · ')}</p>
      {h.notes.length > 0 && <p class="job-line job-when">{h.notes[h.notes.length - 1]}</p>}
      {h.chats > 0 && h.state !== 'unfetchable' && (
        <div class="job-bar" role="progressbar" aria-label={`${title}: ${h.chatsDone} of ${h.chats} chats done`} aria-valuemin={0} aria-valuemax={h.chats} aria-valuenow={h.chatsDone}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <p class="job-line">
        {h.state === 'unfetchable'
          ? `${plural(h.chats, 'chat')} likely had messages then`
          : !h.pages && !open(h)
            ? `${plural(h.chats, 'chat')} planned · nothing fetched`
            : `${h.chatsDone.toLocaleString()} of ${plural(h.chats, 'chat')} done · ${plural(h.found, 'missing message')} fetched in ${plural(h.pages, 'page')}`}
      </p>
      {h.current && (
        <div class="job-line job-now">
          <Loading inline label={`Now: ${h.current}`} />
        </div>
      )}
      {h.resting && open(h) && (
        <p class="job-line job-when">
          {RESTING_LABEL[h.resting.why]}, reading again {when(h.resting.until)}
        </p>
      )}
      {left > 0 && <p class="job-line job-skipped">Left out: {h.left.map((l) => `${plural(l.count, 'chat')} ${l.why}`).join(', ')}</p>}
      <div class="job-controls">
        <div class="job-buttons">
          <button class="btn ghost small" aria-expanded={shown} onClick={() => setShown(!shown)}>
            {shown ? 'Hide chats' : 'Show chats'}
          </button>
          {open(h) && (
            <button class="btn ghost small" disabled={busy} onClick={() => void act(() => api(`/api/catch-up/${h.id}/stop`, { body: {} }), 'stop it')}>
              Stop
            </button>
          )}
          {h.state !== 'unfetchable' && (left > 0 || h.state === 'clear') && (
            <button class="btn ghost small" disabled={busy} title="Fetch every chat of the account for this time, the ones left out too" onClick={() => void act(() => api(`/api/catch-up/${h.id}/all`, { body: {} }), 'check every chat')}>
              <Icon name="refresh" size={13} /> Check every chat
            </button>
          )}
          {!open(h) && (
            <button class="btn ghost small" disabled={busy} aria-label={`Put away the hole for ${title}`} onClick={() => void act(() => api(`/api/catch-up/${h.id}`, { method: 'DELETE' }), 'put it away')}>
              <Icon name="trash" size={13} /> Put away
            </button>
          )}
        </div>
      </div>
      {shown && (
        <ul class="catchup-chats">
          {!list && <Loading inline label="Loading…" />}
          {list && !list.length && <li class="job-line job-when">No chats planned.</li>}
          {list?.map((t) => (
            <li key={t.conversationId} class={`catchup-chat ${t.state}`}>
              <button class="catchup-chat-name" onClick={() => go({ view: 'inbox', conv: t.conversationId })}>
                {chatName(t.conversationId, t.name)}
              </button>
              <span class="catchup-chat-state">{CHAT_LABEL[t.state]}</span>
              <span class="catchup-chat-n">
                {t.found > 0 ? `${t.found.toLocaleString()} found` : t.state === 'done' ? 'whole' : t.expected < 0.1 ? 'quiet then' : `~${t.expected.toLocaleString()} expected`}
              </span>
              {t.error && <span class="catchup-chat-why job-error">{t.error}</span>}
              {!t.error && t.state === 'skipped' && <span class="catchup-chat-why">{t.why}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Settings → Catching up: looked at every 2 s while a hole is open, every 30 s otherwise. */
export function CatchUpSettings() {
  rev.value;
  const [holes, setHoles] = useState<P.CatchUpHoleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const working = !!holes?.some(open);
  useEffect(() => {
    let live = true;
    api<P.CatchUpView>('/api/catch-up').then(
      (r) => {
        if (!live) return;
        setHoles(r.holes);
        setError(null);
      },
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [tick]);
  useEffect(() => {
    const t = setTimeout(reload, working ? 2000 : 30_000);
    return () => clearTimeout(t);
  }, [tick, working]);
  return (
    <section class="set-block" id="set-catchup">
      <h3>Catching up</h3>
      <p class="set-help">
        When the hub may have missed messages (it was restarted or lost events, an account was offline, or a network says a chat has newer messages than the hub), it works out which chats and when, and fetches them through your account at the
        same reading pace as indexing. Each stretch is listed here with why, and what it found. Signal keeps no old messages on its servers: what the hub missed there needs an import.
      </p>
      {error && !holes && (
        <p class="set-help job-error" role="alert">
          Could not load it: {error}
        </p>
      )}
      {!holes && !error && <Loading inline label="Loading…" />}
      {holes && !holes.length && <p class="set-help">Nothing missing that the hub knows of.</p>}
      {holes && holes.length > 0 && (
        <ul class="jobs">
          {holes.map((h) => (
            <HoleRow key={h.id} h={h} reload={reload} />
          ))}
        </ul>
      )}
    </section>
  );
}

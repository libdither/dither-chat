/**
 * A chat's disappearing-messages timer in the message box (docs/group-settings.md, "In the message box"): the send
 * menu's "Disappearing messages" line and its timers, the timer at the end of the line above the box while one is on
 * ("· 1w"), and the stopwatch on each message that will disappear. The timer comes from the About the hub kept (no wait on the network), then the network is asked
 * once per chat while the app is open, so a timer the other side changed shows up. A pick goes through the chat's
 * About, as the About panel's does.
 */
import type * as P from '@dither-chat/protocol';
import { ABOUT_RULES, durationLabel } from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { fullTime } from '../format.ts';
import { api, toast } from '../state.ts';
import { Menu } from './bits.tsx';
import { Icon } from './icons.tsx';

type Timer = { value: number; canEdit: boolean; reason?: string; accountId: string | null };

/** Each chat's timer as last heard, by conversation id. */
const timers = signal<ReadonlyMap<string, Timer>>(new Map());
/** Chats asked of the network since the app opened. */
const asked = new Set<string>();

/** Keep a chat's timer from an About the app got anywhere (the About panel's answers too). */
export function noteTimer(v: P.AboutView) {
  if (v.target.kind !== 'conversation') return;
  const f = v.fields.disappearing;
  if (!f || typeof f.value !== 'number') return;
  const next = new Map(timers.value);
  next.set(v.target.id, { value: f.value, canEdit: v.canConfigure && f.canEdit, ...(f.reason ? { reason: f.reason } : {}), accountId: v.accountId });
  timers.value = next;
}

/** Whether chats on this network have a disappearing timer at all. */
const hasTimer = (network: P.Network) => ABOUT_RULES[network].conversation.includes('disappearing');

function load(convId: string, accountId?: string) {
  const path = `/api/conversations/${convId}/about${accountId ? `?account=${encodeURIComponent(accountId)}` : ''}`;
  const sep = accountId ? '&' : '?';
  if (!timers.value.has(convId)) void api<P.AboutView | null>(`${path}${sep}kept=1`).then((v) => v && noteTimer(v)).catch(() => {});
  if (asked.has(convId)) return;
  asked.add(convId);
  void api<P.AboutView>(path)
    .then((v) => !v.stale && noteTimer(v))
    .catch(() => asked.delete(convId));
}

/** A chat's timer and a way to change it, or null where the network has none (or it is not known yet). */
export function useTimer(conv: P.ConversationView | undefined, accountId?: string) {
  const [busy, setBusy] = useState(false);
  const on = !!conv && hasTimer(conv.network);
  useEffect(() => {
    if (on) load(conv!.id, accountId);
  }, [conv?.id, on, accountId]);
  const t = on ? timers.value.get(conv!.id) : undefined;
  if (!conv || !t) return null;
  const set = async (seconds: number) => {
    if (seconds === t.value || busy) return;
    setBusy(true);
    try {
      const v = await api<P.AboutView>(`/api/conversations/${conv.id}/about`, { body: { change: { key: 'disappearing', value: seconds }, ...(t.accountId ? { accountId: t.accountId } : {}) } });
      noteTimer(v);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not change disappearing messages', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  /** The network's own timers, plus the current one when it is not among them. */
  const offered = [...new Set([...(ABOUT_RULES[conv.network].disappearing ?? []), t.value])].sort((a, b) => a - b);
  return { ...t, busy, set, offered };
}

/**
 * The send menu's Disappearing messages line, with the timer at its end, and the network's timers under it once it is
 * pressed. Its own state: a phone's menu is a sheet that does not redraw with the composer.
 */
export function TimerLines({ timer, close }: { timer: NonNullable<ReturnType<typeof useTimer>>; close: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        class={`menu-item ${timer.value ? 'on' : ''}`}
        data-track="disappearing messages"
        disabled={!timer.canEdit || timer.busy}
        title={timer.canEdit ? 'For everyone in this chat' : timer.reason}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="timer" size={14} /> Disappearing messages<span class="plus-note">{durationLabel(timer.value)}</span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
      </button>
      {open && (
        <div class="send-timers" role="group" aria-label="Disappearing messages">
          {timer.offered.map((s) => (
            <button
              class={`menu-item ${s === timer.value ? 'on' : ''}`}
              data-track="disappearing messages (choice)"
              onClick={() => {
                close();
                void timer.set(s);
              }}
            >
              {durationLabel(s)}
              {s === timer.value && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** "1w", "8h", "5m", "30s": a timer short enough for a message's corner. */
function shortTimer(seconds: number): string {
  const units: [number, string][] = [[7 * 86_400, 'w'], [86_400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']];
  for (const [n, u] of units) if (seconds >= n && seconds % n === 0) return `${seconds / n}${u}`;
  for (const [n, u] of units) if (seconds >= n) return `${Math.round(seconds / n)}${u}`;
  return `${seconds}s`;
}

/**
 * While a timer is on, the end of the line above the box says it: "· 1w" after the route, or "Disappears after 1 week"
 * where the line has nothing else. A press opens the network's timers, Off among them; nothing shows while it is off.
 */
export function TimerLabel({ conv, accountId, alone }: { conv: P.ConversationView | undefined; accountId?: string; alone?: boolean }) {
  const timer = useTimer(conv, accountId);
  if (!timer?.value) return null;
  const full = durationLabel(timer.value);
  const title = `Disappearing messages: ${full}${timer.canEdit ? '' : timer.reason ? `. ${timer.reason}` : ''}`;
  const face = alone ? `Disappears after ${full.toLowerCase()}` : shortTimer(timer.value);
  if (!timer.canEdit)
    return (
      <span class="timer-label fixed" title={title}>
        {!alone && ' · '}
        {face}
      </span>
    );
  return (
    <>
      {!alone && ' · '}
      <Menu
        up
        trigger={(toggle) => (
          <button class="timer-label" data-track="disappearing timer" title={title} aria-label={title} aria-haspopup="menu" disabled={timer.busy} onClick={toggle}>
            {face}
          </button>
        )}
      >
        {(close) => (
          <div class="level-menu pair-menu">
            <div class="menu-title">Disappearing messages</div>
            {timer.offered.map((s) => (
              <button
                class={`menu-item ${s === timer.value ? 'on' : ''}`}
                data-track="disappearing timer (choice)"
                onClick={() => {
                  close();
                  void timer.set(s);
                }}
              >
                {durationLabel(s)}
                {s === timer.value && <Icon name="check" size={12} />}
              </button>
            ))}
          </div>
        )}
      </Menu>
    </>
  );
}

/** On a message that will disappear: a small clock and its timer, the details on hover. */
export function DisappearsMark({ m, self }: { m: P.MessageView; self: boolean }) {
  if (!m.disappears || m.deleted) return null;
  const words = durationLabel(m.disappears).toLowerCase();
  const title = self ? `Disappears ${fullTime(m.ts + m.disappears * 1000)} (${words} after it was sent)` : `Disappears ${words} after you read it`;
  return (
    <span class="msg-disappears" title={title} aria-label={title}>
      <Icon name="timer" size={11} />
      {shortTimer(m.disappears)}
    </span>
  );
}

/**
 * The message box's disappearing-messages button (docs/group-settings.md, "In the message box"): a clock at the end of
 * the route line over the box, with the chat's timer beside it when one is on, that opens the network's own timers.
 * It shows the timer the hub kept from the last time it asked (no wait on the network), then asks once per chat while
 * the app is open, so a timer the other side changed shows up. A pick goes through the chat's About, as the About
 * panel's does.
 */
import type * as P from '@dither-chat/protocol';
import { ABOUT_RULES, durationLabel } from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
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
export const hasTimer = (network: P.Network) => ABOUT_RULES[network].conversation.includes('disappearing');

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

export function DisappearingButton({ convId, network, accountId }: { convId: string; network: P.Network; accountId?: string }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (hasTimer(network)) load(convId, accountId);
  }, [convId, network, accountId]);
  const t = timers.value.get(convId);
  if (!hasTimer(network) || !t) return null;
  const label = t.value ? durationLabel(t.value) : null;
  const face = (
    <>
      <Icon name="clock" size={12} />
      {label}
    </>
  );
  if (!t.canEdit)
    return (
      <span class={`disappearing-btn fixed ${t.value ? 'on' : ''}`} title={`Disappearing messages: ${durationLabel(t.value)}${t.reason ? `. ${t.reason}` : ''}`}>
        {face}
      </span>
    );
  const offered = [...new Set([...(ABOUT_RULES[network].disappearing ?? []), t.value])].sort((a, b) => a - b);
  const pick = async (seconds: number) => {
    if (seconds === t.value || busy) return;
    setBusy(true);
    try {
      const v = await api<P.AboutView>(`/api/conversations/${convId}/about`, { body: { change: { key: 'disappearing', value: seconds }, ...(t.accountId ? { accountId: t.accountId } : {}) } });
      noteTimer(v);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not change disappearing messages', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Menu
      up
      trigger={(toggle) => (
        <button
          class={`disappearing-btn ${t.value ? 'on' : ''}`}
          data-track="disappearing messages"
          title={`Disappearing messages: ${durationLabel(t.value)}`}
          aria-label={`Disappearing messages: ${durationLabel(t.value)}`}
          aria-haspopup="menu"
          disabled={busy}
          onClick={toggle}
        >
          {face}
        </button>
      )}
    >
      {(close) => (
        <div class="level-menu pair-menu">
          <div class="menu-title">Disappearing messages</div>
          {offered.map((s) => (
            <button
              class={`menu-item ${s === t.value ? 'on' : ''}`}
              data-track="disappearing messages (choice)"
              onClick={() => {
                close();
                void pick(s);
              }}
            >
              {durationLabel(s)}
              {s === t.value && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

/**
 * Settings → Notifications → Each device (docs/devices.md): what every device leaves out of the notifications the
 * shared rules let through. Leaving Signal to the Signal app on the phone while the laptop shows it, say. The inbox
 * and its ranking stay the same everywhere.
 */
import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { deviceId, deviceRule, forgetDevice, setDeviceRule } from '../devices.ts';
import { ago } from '../format.ts';
import { netName } from '../model.ts';
import { db, noticesBoot, rev, toast } from '../state.ts';
import { mailRev } from '../versions.ts';
import { AccountChip, NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';

export const DEVICE_LEVELS: P.DeviceLevel[] = ['hub', 'mentions', 'none'];
export const DEVICE_LEVEL_LABEL: Record<P.DeviceLevel, string> = { hub: 'Notify', mentions: 'Mentions only', none: 'Off' };

function DevicePicker({ value, inherited, onChange }: { value: P.DeviceLevel | null; inherited?: P.DeviceLevel; onChange: (l: P.DeviceLevel | null) => void }) {
  const shown = value ?? inherited ?? 'hub';
  return (
    <div class="level-picker">
      {DEVICE_LEVELS.map((l) => (
        <button class={`chip-btn ${shown === l ? 'on' : ''} ${value === null && shown === l && inherited ? 'inherited' : ''}`} onClick={() => onChange(value === l ? null : l)}>
          <Icon name={l === 'hub' ? 'bell' : l === 'mentions' ? 'at' : 'bellOff'} size={13} /> {DEVICE_LEVEL_LABEL[l]}
        </button>
      ))}
    </div>
  );
}

/** Place-level rules a device has, for listing under it. */
function placeLabel(r: P.DeviceRuleView): { network: P.Network | null; text: string } {
  if (r.scope === 'conversation' && r.target.startsWith('mth_')) {
    const t = db.mail.threads.get(r.target);
    return { network: 'email', text: t?.subject || 'a mail thread' };
  }
  if (r.scope === 'conversation') {
    const c = db.conversations.get(r.target);
    return { network: c?.network ?? null, text: c?.name ?? (c ? 'a conversation' : 'a conversation no longer here') };
  }
  const s = db.spaces.get(r.target);
  return { network: s?.network ?? null, text: s?.name ?? 'a community no longer here' };
}

function DeviceBlock({ d, mine }: { d: P.DeviceView; mine: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Device rules', body: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };
  const set = (scope: P.DeviceScope, target: string, level: P.DeviceLevel | null) => run(() => setDeviceRule(d.id, scope, target, level))();
  const accounts = [...db.accounts.values()];
  const networks = [...new Set(accounts.map((a) => a.network))];
  const places = d.rules.filter((r) => r.scope === 'conversation' || r.scope === 'space');
  // Mail (slice 9): Email, and each mail account when there are several.
  const mail = [...db.mail.accounts.values()];
  const email = deviceRule(d, 'network', 'email');
  const phone = /Android|iPhone|iPad/.test(d.label);
  const where = [d.pushIds.length ? 'push on' : 'no push', d.lastSeenAt ? `last open ${ago(d.lastSeenAt)}` : 'not opened since push was turned on'].join(', ');
  return (
    <div class={`device-block ${busy ? 'busy' : ''}`}>
      <div class="device-head">
        <Icon name={phone ? 'phone' : 'monitor'} size={15} />
        <span>
          {d.label}
          {mine && <em class="push-this"> this device</em>}
          <small>{where}</small>
        </span>
        {!mine && (
          <button class="icon-btn small" title="Forget this device and its rules" onClick={run(() => forgetDevice(d.id))}>
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      {networks.map((n) => {
        const own = accounts.filter((a) => a.network === n);
        const net = deviceRule(d, 'network', n);
        return (
          <>
            <div class="set-rule">
              <span class="set-rule-label">
                <NetBadge network={n} size={18} /> {netName(n)}
              </span>
              <DevicePicker value={net} onChange={(l) => set('network', n, l)} />
            </div>
            {own.length > 1 &&
              own.map((a) => (
                <div class="set-rule sub">
                  <span class="set-rule-label">
                    <AccountChip account={a} small />
                  </span>
                  <DevicePicker value={deviceRule(d, 'account', a.id)} inherited={net ?? undefined} onChange={(l) => set('account', a.id, l)} />
                </div>
              ))}
          </>
        );
      })}
      {/* Notices (docs/notices.md): `network:notice`. "Mentions only" keeps those about you by name (a mention, a review asked of you). */}
      {noticesBoot.value && (
        <div class="set-rule" data-device-net="notice">
          <span class="set-rule-label">
            <Icon name="bell" size={18} /> Notices
          </span>
          <DevicePicker value={deviceRule(d, 'network', 'notice')} onChange={(l) => set('network', 'notice', l)} />
        </div>
      )}
      {mail.length > 0 && (
        <>
          <div class="set-rule" data-device-net="email">
            <span class="set-rule-label">
              <NetBadge network="email" size={18} /> {netName('email')}
            </span>
            <DevicePicker value={email} onChange={(l) => set('network', 'email', l)} />
          </div>
          {mail.length > 1 &&
            mail.map((a) => (
              <div class="set-rule sub">
                <span class="set-rule-label">
                  <span class="acc-chip small" title={`Mail account “${a.label}”`}>
                    <span class="acc-dot" style={{ background: a.color }} />
                    {a.address ?? a.label}
                  </span>
                </span>
                <DevicePicker value={deviceRule(d, 'account', a.id)} inherited={email ?? undefined} onChange={(l) => set('account', a.id, l)} />
              </div>
            ))}
        </>
      )}
      {places.map((r) => {
        const l = placeLabel(r);
        return (
          <div class="set-rule sub">
            <span class="set-rule-label">
              {l.network ? <NetBadge network={l.network} size={16} /> : <Icon name="hash" size={14} />} {l.text}
            </span>
            <span class={`level-tag ${r.level === 'hub' ? 'all' : r.level}`}>{DEVICE_LEVEL_LABEL[r.level]}</span>
            <button class="icon-btn small" title="Clear" onClick={() => set(r.scope, r.target, null)}>
              <Icon name="x" size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function DeviceRules() {
  rev.value;
  mailRev.value;
  const me = deviceId();
  const list = [...db.devices].filter((d) => d.id === me || d.pushIds.length || d.rules.length).sort((a, b) => +(b.id === me) - +(a.id === me));
  if (!list.length) return null;
  return (
    <section class="set-block" id="set-devices">
      <h3>Each device</h3>
      <p class="set-help">
        What notifies on each device, on top of the rules above: leave a network to its own app on your phone, or keep only mentions there. Off covers push, the in-app
        toast and the browser notification on that device. The inbox stays the same everywhere.
      </p>
      {list.map((d) => (
        <DeviceBlock key={d.id} d={d} mine={d.id === me} />
      ))}
    </section>
  );
}

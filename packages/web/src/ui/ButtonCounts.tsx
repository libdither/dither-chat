/**
 * Settings → Usage (docs/button-counts.md): whether this device counts which buttons are pressed, and the most
 * pressed ones on the hub over a week or a month, by kind of device.
 */
import { useEffect, useState } from 'preact/hooks';
import { clickTotals, countingClicks, forgetClicks, loadClickTotals, setCountingClicks } from '../clicklog.ts';
import { phone } from '../phone.ts';
import { toast } from '../state.ts';
import { Icon } from './icons.tsx';

/** Rows shown until asked for all. */
const SHOWN = 25;
const failed = (e: any) => toast({ kind: 'error', title: 'Button counts', body: String(e?.message ?? e) });

export function UsageSettings() {
  const on = countingClicks();
  const [days, setDays] = useState(7);
  const [all, setAll] = useState(false);
  useEffect(() => void loadClickTotals(days).catch(failed), [days, on]);
  const v = clickTotals.value?.days === days ? clickTotals.value : null;
  const keys = v?.keys ?? [];
  const shown = all ? keys : keys.slice(0, SHOWN);
  const n = (x: number | undefined) => (x ? x.toLocaleString() : '–');
  return (
    <section class="set-block" id="set-usage">
      <h3>Usage</h3>
      <label class="toggle-row">
        <input type="checkbox" checked={on} onChange={(e) => setCountingClicks((e.target as HTMLInputElement).checked)} />
        <span>
          <b>Count which buttons I press</b>
          <small>
            On this {phone.value ? 'phone' : 'computer'} only: switch it on on each device you want counted. How many times a day each button is pressed, on which page, and
            whether on a phone or a desktop. Never names, messages, people or places. Kept on your hub, sent nowhere else. Off: nothing is counted.
          </small>
        </span>
      </label>
      {(on || keys.length > 0) && (
        <>
          <div class="set-rule">
            <span class="set-rule-label">Most pressed</span>
            <div class="level-picker">
              {[7, 30].map((d) => (
                <button class={`chip-btn ${days === d ? 'on' : ''}`} data-track={`usage table (${d} days)`} onClick={() => setDays(d)}>
                  {d} days
                </button>
              ))}
              <button class="icon-btn small" data-track="usage table (refresh)" title="Count again" aria-label="Count again" onClick={() => void loadClickTotals(days).catch(failed)}>
                <Icon name="refresh" size={13} />
              </button>
            </div>
          </div>
          {!v ? (
            <p class="set-help">Loading…</p>
          ) : !keys.length ? (
            <p class="set-help">Nothing counted in the last {days} days yet.</p>
          ) : (
            <div class="activity-table-wrap">
              <table class="activity-table clicks-table">
                <thead>
                  <tr>
                    <th>Button</th>
                    <th>Phone</th>
                    <th>Desktop</th>
                    <th>All</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((k) => (
                    <tr>
                      <td title={k.key}>{k.key}</td>
                      <td>{n(k.phone)}</td>
                      <td>{n(k.desktop)}</td>
                      <td>{n(k.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {v && keys.length > 0 && (
            <p class="set-help">
              {v.total.toLocaleString()} presses since {new Date(`${v.since}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}. A page's "other" is buttons
              without a name yet.
            </p>
          )}
          <div class="btn-row">
            {!all && keys.length > SHOWN && (
              <button class="btn ghost small" onClick={() => setAll(true)}>
                Show all {keys.length}
              </button>
            )}
            <button
              class="btn ghost small danger"
              disabled={!v}
              onClick={() => {
                if (confirm('Forget every button count on the hub, from every device?')) void forgetClicks().catch(failed);
              }}
            >
              <Icon name="trash" size={13} /> Forget…
            </button>
          </div>
        </>
      )}
    </section>
  );
}

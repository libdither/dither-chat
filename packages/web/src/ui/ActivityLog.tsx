/** Settings → Privacy → Activity log: on or off, how long it is kept, export, delete, and what it has learned (docs/activity.md). */
import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { RETENTION_CHOICES } from '@dither-chat/protocol';
import { activityInfo, deleteActivity, fetchActivity, setActivitySettings } from '../activity.ts';
import { convTitle } from '../model.ts';
import { api, db, toast } from '../state.ts';
import { Icon } from './icons.tsx';

type Learned = P.PlaceActivity & { conversationId: string };

const pct = (r: number | null) => (r == null ? '–' : `${Math.round(r * 100)}%`);
const dur = (ms: number | null) => (ms == null ? '–' : ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);
const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function ActivityLogSettings() {
  useEffect(() => void fetchActivity(), []);
  const info = activityInfo.value;
  const on = info?.settings.enabled ?? true;
  const [learned, setLearned] = useState<Learned[] | null>(null);
  const failed = (e: Error) => toast({ kind: 'error', title: 'Could not change the activity log', body: e.message });

  return (
    <div class="activity-log" id="set-activity">
      <label class="toggle-row">
        <input type="checkbox" checked={on} disabled={!info} onChange={(e) => void setActivitySettings({ enabled: (e.target as HTMLInputElement).checked }).catch(failed)} />
        <span>
          <b>Keep an activity log</b>
          <small>
            Which screens and chats you open, for how long, how you got there, and what each notification led to, so dither-chat can learn which
            messages deserve one. Ids, times and counts only: never what was said or what you searched for. Kept on your hub, never sent anywhere
            else. Off: nothing new is recorded.
          </small>
        </span>
      </label>
      <div class="set-rule">
        <span class="set-rule-label">Keep it for</span>
        <div class="level-picker">
          {RETENTION_CHOICES.map((d) => (
            <button class={`chip-btn ${info?.settings.retentionDays === d ? 'on' : ''}`} disabled={!info} onClick={() => void setActivitySettings({ retentionDays: d }).catch(failed)}>
              {d === 365 ? 'A year' : `${d} days`}
            </button>
          ))}
        </div>
      </div>
      <p class="set-help">
        {!info ? 'Loading…' : `${info.visits} visit${info.visits === 1 ? '' : 's'} and ${info.notifications} notification${info.notifications === 1 ? '' : 's'} recorded${info.oldest ? ` since ${day(info.oldest)}` : ''}.`}
      </p>
      <div class="btn-row">
        <a class="btn ghost small" href="/api/activity/export" download>
          <Icon name="download" size={13} /> Export my activity log
        </a>
        <a class="btn ghost small" href="/api/activity/examples" download title="One line per message triage decided on: its metadata, the decision, and what you did after. No message text.">
          <Icon name="download" size={13} /> Export training examples
        </a>
        <button
          class="btn ghost small danger"
          disabled={!info || (!info.visits && !info.notifications)}
          onClick={() => {
            if (confirm('Delete the whole activity log from your hub? Time spent per place, which orders the sidebar, is kept.')) void deleteActivity().catch(failed);
          }}
        >
          <Icon name="trash" size={13} /> Delete activity log…
        </button>
      </div>
      <details
        class="activity-learned"
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open) api<{ places: Learned[] }>('/api/activity/features?limit=12').then((r) => setLearned(r.places), () => setLearned([]));
        }}
      >
        <summary>What it has learned</summary>
        {learned === null ? (
          <p class="set-help">Loading…</p>
        ) : !learned.length ? (
          <p class="set-help">Nothing yet. It fills in as you get notifications and open chats.</p>
        ) : (
          <div class="activity-table-wrap">
            <table class="activity-table">
              <thead>
                <tr>
                  <th>Place</th>
                  <th title="Pushes sent, and how many you opened within an hour">Opened</th>
                  <th title="Median time from push to open">Within</th>
                  <th title="Median seconds spent after opening">Stayed</th>
                  <th title="Replied within 10 minutes of opening">Replied</th>
                  <th title="Opened within an hour of messages you got no push for">Unprompted</th>
                </tr>
              </thead>
              <tbody>
                {learned.map((f) => (
                  <tr>
                    <td>{convTitle(db.conversations.get(f.conversationId)) || f.conversationId}</td>
                    <td>{f.pushes ? `${f.opened}/${f.pushes}` : '–'}</td>
                    <td>{dur(f.medianTimeToOpen)}</td>
                    <td>{f.medianDwell == null ? '–' : `${Math.round(f.medianDwell)} s`}</td>
                    <td>{pct(f.replyAfterOpenRate)}</td>
                    <td>{f.unpushedBursts ? `${f.openedWithoutPush}/${f.unpushedBursts}` : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p class="set-help">
          {info?.featuresInTriage
            ? 'Triage adds these to its reasons and keeps them with each decision.'
            : 'Triage does not use these yet (the hub runs without DITHER_ACTIVITY_FEATURES).'}
        </p>
      </details>
    </div>
  );
}

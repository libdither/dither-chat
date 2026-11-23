/**
 * Activity on a person's profile page (docs/profile.md "Activity", docs/history.md): their current status and presence
 * at the top, then a chart of when they're around (ActivityChart.tsx), then, with adversarial features shown, how their
 * status changed and their presence (online, idle, do not disturb, offline) over time when those are logged, each
 * collapsed until opened. Absent when there is nothing to show.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago, fullTime, since } from '../format.ts';
import { dotFor, dotLooks, whose as whoseDot, type PresenceOf } from './PresenceDot.tsx';
import { memo } from './memo.ts';
import { keeping, loadChanges, presenceText, retention } from '../history.ts';
import { netName } from '../model.ts';
import { db, readMinute } from '../state.ts';
import { ActivityChart } from './ActivityChart.tsx';
import { NetGlyph } from './bits.tsx';
import { Change } from './HistoryCard.tsx';
import { Icon } from './icons.tsx';
import { StatusEmoji } from './ProfileShell.tsx';

const SHOWN = 8;

type CardProps = {
  path: string;
  chartPath: string;
  self: boolean;
  chart: boolean;
  status?: { text?: string; emoji?: string; emojiUrl?: string } | null;
  at?: number;
  /** Whose status dot to say in words when presence is not logged (PresenceDot.tsx). */
  presence?: PresenceOf;
};
const sameStatus = (a: CardProps['status'], b: CardProps['status']) =>
  a === b || (!!a && !!b && a.text === b.text && a.emoji === b.emoji && a.emojiUrl === b.emojiUrl);

/**
 * Drawn again when what it is handed changes, not with the whole profile (a nickname, a message): the profile hands it
 * new objects each time, so they are compared by value (docs/perf.md "Every click"). What it loads, the retention
 * settings, presence frames and the minute clock draw it themselves.
 */
export const ActivityCard = memo(
  ActivityCardBody,
  (a: CardProps, b: CardProps) =>
    a.path === b.path &&
    a.chartPath === b.chartPath &&
    a.self === b.self &&
    a.chart === b.chart &&
    a.at === b.at &&
    sameStatus(a.status, b.status) &&
    whoseDot(a.presence) === whoseDot(b.presence),
);

function ActivityCardBody({ path, chartPath, self, chart, status, at, presence: whose }: CardProps) {
  // "since …" moves with the clock; the dot with presence frames (dotLooks reads them).
  readMinute();
  const dot = whose && dotLooks(whose) ? dotFor(whose) : null;
  const r = retention.value;
  const [statuses, setStatuses] = useState<P.ChangeView[]>([]);
  const [presence, setPresence] = useState<P.ChangeView[]>([]);
  const [all, setAll] = useState({ statuses: false, presence: false });
  useEffect(() => {
    let live = true;
    setStatuses([]);
    setPresence([]);
    // The hub leaves both out while adversarial features are hidden.
    if (r.adversarial) {
      loadChanges(`${path}?fields=status&limit=200`).then((c) => live && setStatuses(c), () => {});
      loadChanges(`${path}?fields=presence&limit=500`).then((c) => live && setPresence(c), () => {});
    }
    return () => void (live = false);
  }, [path, r.adversarial]);

  const hasStatus = !!(status?.text || status?.emoji);
  if (!chart && !hasStatus && !statuses.length && !presence.length && !dot) return null;
  const now = presence[0];
  const shownStatuses = all.statuses ? statuses : statuses.slice(0, SHOWN);
  const shownPresence = all.presence ? presence : presence.slice(0, SHOWN);

  return (
    <section class="pf-card pf-activity-card">
      <h3>
        <Icon name="activity" size={14} />
        <span>Activity</span>
      </h3>

      <div class="pf-status-now">
        {hasStatus ? (
          <p class="pf-status">
            <StatusEmoji status={status!} />
            <span>{status!.text}</span>
            {at ? (
              <time class="hist-when" title={fullTime(at)}>
                since {ago(at)}
              </time>
            ) : null}
          </p>
        ) : (
          <p class="pf-empty">No status now.</p>
        )}
        {now && r.presence ? (
          <PresenceNow c={now} logging />
        ) : dot ? (
          <p class="pf-status pf-presence">
            <span class={`presence-dot ${dot.state}`} />
            <span>{dot.title}</span>
          </p>
        ) : (
          now && <PresenceNow c={now} logging={false} />
        )}
      </div>

      {chart && <ActivityChart path={chartPath} self={self} statusesKept={keeping(r, 'statuses')} presenceKept={keeping(r, 'presence')} />}

      {r.adversarial && (statuses.length > 0 || r.statuses) && (
        <details class="act-sub pf-status-history">
          <summary>
            <Icon name="chevronRight" size={12} class="act-sub-chevron" />
            Status history
            {statuses.length > 0 && <span class="pf-count">{statuses.length}</span>}
          </summary>
          {!statuses.length ? (
            <p class="pf-empty">No changes logged yet. Each change to their status shows here as it happens.</p>
          ) : (
            <ol class="hist-list">
              {shownStatuses.map((c) => (
                <Change c={c} />
              ))}
            </ol>
          )}
          {!all.statuses && statuses.length > SHOWN && (
            <button class="btn ghost small" onClick={() => setAll({ ...all, statuses: true })}>
              Show all {statuses.length}
            </button>
          )}
          {!r.statuses && statuses.length > 0 && <p class="set-help">Logging statuses is off; this is what was logged before.</p>}
        </details>
      )}

      {r.adversarial && (presence.length > 0 || r.presence) && (
        <details class="act-sub pf-presence-history">
          <summary>
            <Icon name="chevronRight" size={12} class="act-sub-chevron" />
            Presence history
            {presence.length > 0 && <span class="pf-count">{presence.length}</span>}
          </summary>
          {!presence.length ? (
            <p class="pf-empty">Nothing logged yet. Each time they come online, go idle or leave shows here.</p>
          ) : (
            <ol class="hist-list">
              {shownPresence.map((c, i) => (
                <PresenceRow c={c} until={i ? presence[i - 1].at : undefined} />
              ))}
            </ol>
          )}
          {!all.presence && presence.length > SHOWN && (
            <button class="btn ghost small" onClick={() => setAll({ ...all, presence: true })}>
              Show all {presence.length}
            </button>
          )}
        </details>
      )}
    </section>
  );
}

/** Where a presence row was heard, for a person on several networks. */
function Where({ c }: { c: P.ChangeView }) {
  const ident = db.identities.get(c.target.id);
  return ident ? (
    <span class="hist-src" title={netName(ident.network)}>
      <NetGlyph network={ident.network} size={11} />
    </span>
  ) : null;
}

function PresenceNow({ c, logging }: { c: P.ChangeView; logging: boolean }) {
  const p = c.new as P.PresenceView | null;
  return (
    <p class="pf-status pf-presence">
      <span class={`presence-dot ${p?.state ?? 'offline'}`} />
      <Where c={c} />
      <span>{logging ? presenceText(p) : `Last logged: ${presenceText(p)}`}</span>
      <time class="hist-when" title={fullTime(c.at)}>
        since {ago(c.at)}
      </time>
    </p>
  );
}

/** One stretch: how they were from then, and for how long when something came after. */
function PresenceRow({ c, until }: { c: P.ChangeView; until?: number }) {
  const p = c.new as P.PresenceView | null;
  return (
    <li class="hist-item">
      <span class={`presence-dot ${p?.state ?? 'offline'}`} />
      <Where c={c} />
      <span>
        <b>{presenceText(p)}</b>
        {until === undefined ? ' since' : until - c.at < 60_000 ? ' for under a minute' : ` for ${since(c.at, until)}`}
      </span>
      <time class="hist-when" title={fullTime(c.at)}>
        {ago(c.at)}
      </time>
    </li>
  );
}

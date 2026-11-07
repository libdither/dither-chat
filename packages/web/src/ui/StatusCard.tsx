/**
 * Status on a person's profile page (docs/history.md, docs/profile.md): their current status, and, with adversarial
 * features shown, how it changed and their presence (online, idle, do not disturb, offline) over time when those are
 * logged. Collapsed until opened; absent when there is nothing to show.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago, fullTime, since } from '../format.ts';
import { loadChanges, presenceText, retention } from '../history.ts';
import { netName } from '../model.ts';
import { db, rev } from '../state.ts';
import { NetGlyph } from './bits.tsx';
import { Change } from './HistoryCard.tsx';
import { Icon } from './icons.tsx';

const SHOWN = 8;

export function StatusCard({ path, status, at }: { path: string; status?: { text?: string; emoji?: string } | null; at?: number }) {
  rev.value;
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
  if (!hasStatus && !statuses.length && !presence.length) return null;
  const now = presence[0];
  const shownStatuses = all.statuses ? statuses : statuses.slice(0, SHOWN);
  const shownPresence = all.presence ? presence : presence.slice(0, SHOWN);

  return (
    <details class="pf-card pf-status-card">
      <summary>
        <h3>
          <Icon name="smile" size={14} />
          <span>Status</span>
          {statuses.length + presence.length > 0 && <span class="pf-count">{statuses.length + presence.length}</span>}
          <span class="pf-card-extra pf-status-peek">
            {now && r.presence && <span class={`presence-dot ${(now.new as P.PresenceView | null)?.state ?? 'offline'}`} title={presenceText(now.new as P.PresenceView)} />}
            {hasStatus && (
              <span class="pf-status-peek-text">
                {status!.emoji} {status!.text}
              </span>
            )}
          </span>
          <Icon name="chevronDown" size={12} class="pf-status-chevron" />
        </h3>
      </summary>

      <div class="pf-status-now">
        {hasStatus ? (
          <p class="pf-status">
            {status!.emoji && <span class="pf-status-emoji">{status!.emoji}</span>}
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
        {now && <PresenceNow c={now} logging={r.presence} />}
      </div>

      {r.adversarial && (statuses.length > 0 || r.statuses) && (
        <>
          <h4 class="hist-sub">Status history</h4>
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
        </>
      )}

      {r.adversarial && (presence.length > 0 || r.presence) && (
        <>
          <h4 class="hist-sub">Presence history</h4>
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
        </>
      )}
    </details>
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

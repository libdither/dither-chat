/**
 * What an account does here, drawn (docs/accounts.md "One list"): its badge, the small feature icons on its row, and on
 * its page the same features with what each needs, where a dim one can be asked for on dither-accounts' page.
 */
import type * as P from '@dither-chat/protocol';
import { FEATURE_INTERFACE, FEATURE_LABEL, NETWORK_META } from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { type AccountRow, isNetwork, KIND_META, kindName } from '../accountrows.ts';
import { api, db, toast } from '../state.ts';
import { NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';

const FEATURE_ICON: Record<P.AccountFeature, string> = {
  chat: 'chat',
  calls: 'phone',
  spaces: 'hash',
  feed: 'rss',
  mail: 'mail',
  calendar: 'calendar',
  notices: 'bell',
};

/** A feature's name on this row: `spaces` in the network's own word (Servers, Spaces, Communities). */
export function featureLabel(f: P.AccountFeature, network: P.Network | null): string {
  if (f !== 'spaces' || !network) return FEATURE_LABEL[f];
  const noun = NETWORK_META[network].spaceNoun;
  const plural = noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return plural[0].toUpperCase() + plural.slice(1);
}

const STATE_WORD: Record<P.FeatureState, string> = { on: 'on', trouble: 'stopped', off: 'not used here', asked: 'asked for', denied: 'declined' };

/** Round badge: a chat network's own, else the kind's icon on its colour. */
export function KindBadge({ kind, size = 16 }: { kind: string; size?: number }) {
  if (isNetwork(kind)) return <NetBadge network={kind} size={size} />;
  const m = KIND_META[kind] ?? { color: '#5B7083', icon: 'mail' };
  return (
    <span class="net-badge" style={{ width: `${size}px`, height: `${size}px`, background: m.color }} title={kindName(kind)}>
      <Icon name={m.icon} size={Math.round(size * 0.56)} style={{ color: '#fff' }} />
    </span>
  );
}

/** The row's icons: dim for what it offers that is not used here, a dot on what stopped. Labels are in their titles. */
export function FeatureIcons({ row, size = 13 }: { row: AccountRow; size?: number }) {
  if (!row.features.length) return null;
  return (
    <span class="feat-icons" role="list" aria-label="What it does here">
      {row.features.map((f) => {
        const label = featureLabel(f.feature, row.network);
        const title = `${label}: ${STATE_WORD[f.state]}${f.why ? `. ${f.why}` : ''}`;
        return (
          <span class={`feat ${f.state}`} role="listitem" title={title} aria-label={title} data-feature={f.feature} data-state={f.state}>
            <Icon name={FEATURE_ICON[f.feature]} size={size} />
          </span>
        );
      })}
    </span>
  );
}

/** Ask dither-accounts for one interface of one account: a request on its page. */
function AskButton({ row, f, again }: { row: AccountRow; f: P.FeatureView; again?: boolean }) {
  const [busy, setBusy] = useState(false);
  const iface = FEATURE_INTERFACE[f.feature];
  if (!iface) return null;
  return (
    <button
      class="btn small"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/api/accounts/${encodeURIComponent(row.id)}/ask`, { body: { interface: iface } });
          toast({ kind: 'info', title: 'Asked dither-accounts', body: `Approve it on its page to see this account's ${featureLabel(f.feature, row.network).toLowerCase()} here.` });
        } catch (e: any) {
          toast({ kind: 'error', title: 'Could not ask', body: e.message });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Asking…' : again ? 'Ask again' : 'Show it here'}
    </button>
  );
}

/** On the account's page: each feature with its state, what stopped it, and asking for the ones not used here. */
export function FeatureStrip({ row }: { row: AccountRow }) {
  if (!row.features.length) return null;
  const page = db.accountsManager?.url ?? null;
  return (
    <ul class="feat-strip" aria-label="What it does here">
      {row.features.map((f) => {
        const label = featureLabel(f.feature, row.network);
        return (
          <li class={`feat-chip ${f.state}`} data-feature={f.feature} data-state={f.state}>
            <span class="feat-chip-icon">
              <Icon name={FEATURE_ICON[f.feature]} size={16} />
            </span>
            <span class="feat-chip-text">
              <b>{label}</b>
              {f.state === 'on' ? null : f.state === 'asked' ? (
                <small>
                  Asked: approve it on{' '}
                  {page ? (
                    <a href={page} target="_blank" rel="noopener">
                      dither-accounts’ page
                    </a>
                  ) : (
                    'dither-accounts’ page'
                  )}
                </small>
              ) : (
                <small title={f.why}>{f.state === 'off' ? 'Not shown here' : f.state === 'denied' ? 'Declined on dither-accounts’ page' : f.why}</small>
              )}
            </span>
            {(f.state === 'off' || f.state === 'denied') && <AskButton row={row} f={f} again={f.state === 'denied'} />}
          </li>
        );
      })}
    </ul>
  );
}

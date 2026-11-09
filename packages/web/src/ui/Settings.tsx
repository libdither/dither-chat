import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { LEVEL_LABEL, netName } from '../model.ts';
import { api, db, go, mailRev, prefs, rev, setPrefs, setRule, toast } from '../state.ts';
import { STATUS, addingAccount } from './Accounts.tsx';
import { AccountChip, NetBadge, NetGlyph, levelIcon, showSection } from './bits.tsx';
import { Icon } from './icons.tsx';
import { DeviceRules } from './DeviceRules.tsx';
import { PushSettings } from './Push.tsx';
import { PrivacySettings } from './Privacy.tsx';
import { HistorySettings } from './HistorySettings.tsx';
import { AdversarialSettings } from './Adversarial.tsx';
import { UsageSettings } from './ButtonCounts.tsx';
import { DeskSettings } from './DeskSettings.tsx';
import { MailAccessNote, MailAccountRows } from './mail/MailAccounts.tsx';
import { MailReadSetting } from './mail/MailReadSetting.tsx';
import { phone } from '../phone.ts';
import { android } from '../android.ts';
import { Sheet } from './Sheet.tsx';
import { chosenTheme, followsSystem, Swatch, ThemeList } from './Themes.tsx';
import { themeById } from '../themes.ts';

const LEVELS: P.NotifyLevel[] = ['all', 'smart', 'mentions', 'digest', 'none'];

/** Settings' sections: listed beside them on a desktop, and in a sheet from their header on a phone. */
export const SECTIONS: [title: string, icon: string, id: string][] = [
  ['Default notifications', 'bell', 'set-defaults'],
  ['Smart triage', 'sparkles', 'set-triage'],
  ['Push and quiet hours', 'bellOff', 'push'],
  ['Each device', 'phone', 'set-devices'],
  ['Keywords', 'at', 'set-keywords'],
  ['Per-place overrides', 'layers', 'set-overrides'],
  ['Privacy', 'lock', 'set-privacy'],
  ['Message history', 'clock', 'set-history'],
  ['Adversarial features', 'eyeOff', 'set-adversarial'],
  ['Usage', 'activity', 'set-usage'],
  ['Appearance', 'eye', 'set-appearance'],
  ['Mail', 'mail', 'set-mail'],
  // The phone app opens links and files in the phone's apps by itself.
  ...(android ? [] : ([['Desktop helper', 'monitor', 'set-desk']] as [string, string, string][])),
];

/** A phone's way to any section without scrolling past the rest: a button in the header, and the sections in a sheet. */
function SectionsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button class="btn ghost small set-jump" data-track="settings: sections" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="list" size={15} /> Sections
      </button>
      {open && (
        <Sheet onClose={() => setOpen(false)} label="Settings sections">
          <div class="sheet-menu set-sections">
            <div class="menu-title">Go to</div>
            {[['Accounts', 'power', 'set-accounts'] as const, ...SECTIONS]
              // Per-place overrides are there only once there are some.
              .filter(([, , id]) => document.getElementById(id))
              .map(([t, i, id]) => (
                <button
                  class="menu-item"
                  data-section={id}
                  data-track={`settings: section ${t}`}
                  onClick={() => {
                    setOpen(false);
                    showSection(id);
                  }}
                >
                  <Icon name={i} size={18} /> {t}
                </button>
              ))}
          </div>
        </Sheet>
      )}
    </>
  );
}

function LevelPicker({ value, onChange }: { value: P.NotifyLevel; onChange: (l: P.NotifyLevel) => void }) {
  return (
    <div class="level-picker">
      {LEVELS.map((l) => (
        <button class={`chip-btn ${value === l ? 'on' : ''}`} onClick={() => onChange(l)} title={LEVEL_LABEL[l]}>
          <Icon name={levelIcon(l)} size={13} /> {LEVEL_LABEL[l]}
        </button>
      ))}
    </div>
  );
}

function ruleLabel(r: P.RuleView): { icon: P.Network | null; text: string } {
  if (r.scope === 'network') return { icon: r.target as P.Network, text: `All of ${netName(r.target as P.Network)}` };
  if (r.scope === 'global') return { icon: null, text: 'Everything (global default)' };
  if (r.scope === 'keyword') return { icon: null, text: `Keyword “${r.target}”` };
  if (r.scope === 'account') {
    const a = r.target ? db.accounts.get(r.target) : null;
    return { icon: a?.network ?? null, text: a ? `Account ${a.label} (${netName(a.network)})` : 'Account' };
  }
  if (r.scope === 'person') {
    const p = r.target ? db.persons.get(r.target) : null;
    return { icon: null, text: p ? `Person ${p.name}` : 'Person' };
  }
  if (r.scope === 'space') {
    const s = r.target ? db.spaces.get(r.target) : null;
    return { icon: s?.network ?? null, text: s ? `${s.name} (${netName(s.network)})` : 'Space' };
  }
  const c = r.target ? db.conversations.get(r.target) : null;
  return { icon: c?.network ?? null, text: c ? (c.name ?? 'A conversation') : 'Conversation' };
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function QuietHoursSettings() {
  const [q, setQ] = useState<P.QuietHours | null>(null);
  useEffect(() => {
    api<{ quietHours: P.QuietHours | null }>('/api/quiet-hours').then((r) =>
      setQ(r.quietHours ?? { enabled: false, start: '22:00', end: '07:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, days: [], allowStarred: true }),
    );
  }, []);
  if (!q) return null;
  const save = (patch: Partial<P.QuietHours>) => {
    // The hub may sit in another zone, so times mean what they mean on the device that set them.
    const next = { ...q, ...patch, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    setQ(next);
    api('/api/quiet-hours', { method: 'PUT', body: next }).catch((e) => toast({ kind: 'error', title: 'Could not save quiet hours', body: e.message }));
  };
  const days = q.days ?? [];
  const toggleDay = (d: number) => {
    const on = days.length ? days : WEEKDAYS.map((_, i) => i);
    const next = on.includes(d) ? on.filter((x) => x !== d) : [...on, d].sort();
    save({ days: next.length === 7 ? [] : next });
  };
  return (
    <section class="set-block">
      <h3>Quiet hours</h3>
      <label class="toggle-row">
        <input type="checkbox" checked={q.enabled} onChange={(e) => save({ enabled: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>Hold pushes during these hours</b>
          <small>Messages still land in the inbox, marked with why they were held. One notification when the hours end says how many are waiting.</small>
        </span>
      </label>
      <div class="quiet-times">
        <label class="search-field">
          <span>From</span>
          <input class="input" type="time" value={q.start} onChange={(e) => save({ start: (e.target as HTMLInputElement).value })} />
        </label>
        <label class="search-field">
          <span>Until</span>
          <input class="input" type="time" value={q.end} onChange={(e) => save({ end: (e.target as HTMLInputElement).value })} />
        </label>
        <div class="level-picker">
          {WEEKDAYS.map((label, d) => (
            <button class={`chip-btn ${!days.length || days.includes(d) ? 'on' : ''}`} onClick={() => toggleDay(d)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <label class="toggle-row">
        <input type="checkbox" checked={q.allowStarred} onChange={(e) => save({ allowStarred: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>Starred people still get through</b>
          <small>Also anyone set to always notify.</small>
        </span>
      </label>
      <p class="set-help">In {q.timezone}. A day counts from when the hours start, so a Friday night runs into Saturday morning.</p>
    </section>
  );
}

function DailyDigestSettings() {
  const [d, setD] = useState<P.DailyDigest | null>(null);
  useEffect(() => {
    api<{ dailyDigest: P.DailyDigest | null }>('/api/daily-digest').then((r) => setD(r.dailyDigest ?? { enabled: false, time: '18:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
  }, []);
  if (!d) return null;
  const save = (patch: Partial<P.DailyDigest>) => {
    // As with quiet hours: the time means what it means on the device that set it.
    const next = { ...d, ...patch, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    setD(next);
    api('/api/daily-digest', { method: 'PUT', body: next }).catch((e) => toast({ kind: 'error', title: 'Could not save the digest', body: e.message }));
  };
  return (
    <section class="set-block" id="daily-digest">
      <h3>Daily digest</h3>
      <label class="toggle-row">
        <input type="checkbox" checked={d.enabled} onChange={(e) => save({ enabled: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>One notification a day about what the digest gathered</b>
          <small>How many messages and the busiest places since the last one. It opens the inbox. A day with nothing to report sends nothing.</small>
        </span>
      </label>
      <div class="quiet-times">
        <label class="search-field">
          <span>At</span>
          <input class="input" type="time" value={d.time} onChange={(e) => save({ time: (e.target as HTMLInputElement).value })} />
        </label>
      </div>
      <p class="set-help">In {d.timezone}. If quiet hours cover this time, it waits until they end and takes the place of their summary. If the hub was down, one digest catches up.</p>
    </section>
  );
}

/** Mail (docs/mail.md): whether the hub may read it, and its accounts. Added and changed on the dither-accounts page. */
function MailSettings() {
  mailRev.value;
  if (db.mail.access.state === 'off')
    return (
      <section class="set-block" id="set-mail">
        <h3>Mail</h3>
        <p class="set-help">Mail comes through dither-accounts. Set DITHER_ACCOUNTS_URL on the hub to read it here.</p>
      </section>
    );
  return (
    <section class="set-block" id="set-mail">
      <h3>Mail</h3>
      <MailAccessNote />
      <MailAccountRows />
      {db.mail.access.state === 'granted' && <MailReadSetting />}
    </section>
  );
}

/** A phone has no rail with an accounts button: they head its settings, the way Discord's "You" tab does. */
function AccountsBlock() {
  const accounts = [...db.accounts.values()];
  return (
    <section class="set-block phone-only" id="set-accounts">
      <h3>Accounts</h3>
      {accounts.map((a) => (
        <button class="link-row acc-link" onClick={() => go({ view: 'accounts', account: a.id })}>
          <NetBadge network={a.network} size={22} />
          <AccountChip account={a} small />
          <span class={`status-pill ${a.status}`}>{STATUS[a.status]}</span>
          {a.attention && <small class="acc-attention">{a.attention.message}</small>}
          <Icon name="chevronRight" size={16} class="link-row-go" />
        </button>
      ))}
      <button class="btn ghost small" onClick={() => (addingAccount.value = true)}>
        <Icon name="plus" size={13} /> Add account
      </button>
    </section>
  );
}

export function SettingsPane() {
  rev.value;
  const p = prefs.value;
  const [keyword, setKeyword] = useState('');
  const rules = db.rules;
  const defaults = ['global', 'network', 'account'];
  const defaultRules = rules.filter((r) => defaults.includes(r.scope));
  const keywordRules = rules.filter((r) => r.scope === 'keyword');
  const scoped = rules.filter((r) => !defaults.includes(r.scope) && r.scope !== 'keyword');
  const level = (scope: P.NotifyScope, target: string | null) => rules.find((r) => r.scope === scope && (r.target ?? null) === target)?.level;
  const networks = [...new Set([...db.accounts.values()].map((a) => a.network))];

  return (
    <section class="pane settings">
      <header class="board-head">
        <div>
          <div class="set-title">
            <h2>Settings</h2>
            {phone.value && <SectionsButton />}
          </div>
          <p>Notification rules apply to every account at once. The most specific rule always wins.</p>
        </div>
      </header>
      <div class="settings-scroll">
        <AccountsBlock />

        <section class="set-block" id="set-defaults">
          <h3>Default notifications</h3>
          <div class="set-rule">
            <span class="set-rule-label">
              <Icon name="grid" size={15} /> Everything, unless something more specific says otherwise
            </span>
            <LevelPicker value={level('global', null) ?? 'mentions'} onChange={(l) => setRule('global', null, l)} />
          </div>
          {networks.map((n) => (
            <div class="set-rule">
              <span class="set-rule-label">
                <NetBadge network={n} size={18} /> All of {netName(n)}
              </span>
              <LevelPicker value={level('network', n) ?? ('inherit' as any)} onChange={(l) => setRule('network', n, l)} />
              {level('network', n) && (
                <button class="icon-btn small" title="Clear" onClick={() => setRule('network', n, null)}>
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>
          ))}
          <p class="set-help">
            Built-in starting points: DMs push everything, groups use Smart, channels and threads push only mentions, notes to self stay silent. Change any of them above or on a
            conversation.
          </p>
        </section>

        <section class="set-block" id="set-triage">
          <h3>Smart triage</h3>
          <label class="toggle-row">
            <input type="checkbox" checked disabled />
            <span>
              <b>Rule-based scoring</b>
              <small>Mentions, replies to you, questions aimed at you, urgency words, small groups and whether you're active all raise the score. Always on.</small>
            </span>
          </label>
          <label class="toggle-row">
            <input type="checkbox" checked={!!p.notifications} onChange={async (e) => {
              const on = (e.target as HTMLInputElement).checked;
              if (on && 'Notification' in window && Notification.permission !== 'granted') {
                const r = await Notification.requestPermission();
                if (r !== 'granted') return toast({ kind: 'error', title: 'Notifications blocked', body: 'Allow notifications for this site in your browser.' });
              }
              setPrefs({ notifications: on });
            }} />
            <span>
              <b>Notifications while the app is running</b>
              <small>A system notification when something clears triage, delivered over the hub's own connection. It stops when the app is closed; for that, turn on push below.</small>
            </span>
          </label>
          <div class="set-model">
            <Icon name="sparkles" size={15} />
            <div>
              <b>Local model (optional)</b>
              <small>
                With <code>DITHER_EMBEDDINGS=1</code> the hub asks <b>jev</b>, the local yes/no text model on the home machine, about messages where you take part (does it ask something
                of you, is it time-sensitive, does it include you in plans) and gives the model learning in the background those answers next to your votes. You vote with the arrows
                beside a message's level, on the Triage board or in its notification menu. No message ever leaves the hub's machine.
              </small>
            </div>
          </div>
        </section>

        <PushSettings />

        <DeviceRules />

        <QuietHoursSettings />

        <DailyDigestSettings />

        <section class="set-block" id="set-keywords">
          <h3>Keywords that are always Important</h3>
          <p class="set-help">A message containing one of these is Important, buzzing your phone, wherever it lands (unless that place is set to Off).</p>
          <div class="keyword-list">
            {keywordRules.map((r) => (
              <span class="keyword-chip">
                {r.target}
                <button class="icon-btn small" onClick={() => setRule('keyword', r.target, null)} aria-label="Remove">
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
          <form
            class="keyword-add"
            onSubmit={(e) => {
              e.preventDefault();
              const k = keyword.trim();
              if (k) {
                setRule('keyword', k, 'all');
                setKeyword('');
              }
            }}
          >
            <input class="input" placeholder="Add a keyword (your name, a project, a release)" value={keyword} onInput={(e) => setKeyword((e.target as HTMLInputElement).value)} />
            <button class="btn ghost small" type="submit">
              <Icon name="plus" size={13} /> Add
            </button>
          </form>
        </section>

        {scoped.length > 0 && (
          <section class="set-block" id="set-overrides">
            <h3>Per-place overrides</h3>
            {scoped.map((r) => {
              const l = ruleLabel(r);
              return (
                <div class="set-rule">
                  <span class="set-rule-label">
                    {l.icon ? <NetBadge network={l.icon} size={16} /> : <Icon name="at" size={15} />} {l.text}
                  </span>
                  <span class={`level-tag ${r.level}`}>
                    <Icon name={levelIcon(r.level)} size={12} /> {LEVEL_LABEL[r.level]}
                  </span>
                  <button class="icon-btn small" title="Clear" onClick={() => setRule(r.scope, r.target, null)}>
                    <Icon name="x" size={13} />
                  </button>
                </div>
              );
            })}
          </section>
        )}

        <PrivacySettings />
        <HistorySettings />
        <AdversarialSettings />
        <UsageSettings />

        <section class="set-block" id="set-appearance">
          <h3>Appearance</h3>
          <AppearanceTheme />
        </section>

        <DeskSettings />

        <MailSettings />

        <section class="set-block" id="set-calls">
          <h3>Calls</h3>
          <div class="set-rule">
            <span class="set-rule-label">Connect through</span>
            <div class="level-picker">
              {(
                [
                  ['bridge', 'The account'],
                  ['direct', 'This device'],
                ] as const
              ).map(([m, label]) => (
                <button class={`chip-btn ${p.callMode === m ? 'on' : ''}`} onClick={() => setPrefs({ callMode: m })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p class="set-help">
            {p.callMode === 'bridge'
              ? "The account's own client on the hub joins the call, and its audio is passed to this device. Works the way the network's app does, at the cost of the hub's CPU."
              : 'This device joins the call itself, with a one-call token from the account. Its connection still goes through the hub. Lighter on the hub, a little more work for the device.'}
          </p>
        </section>

        <section class="set-block">
          <h3>About</h3>
          <p class="set-help">
            dither-chat runs entirely on your hub and is served to your devices over Tailscale. It aggregates Discord, Signal, Matrix and WhatsApp into one ontology: people, groups, and
            communities with channels and threads, each annotated with the account it came through.
          </p>
          <div class="btn-row">
            <a class="btn ghost small" href="https://github.com/libdither/dither-chat" target="_blank" rel="noreferrer">
              <Icon name="external" size={13} /> Source
            </a>
            {/* Only a demo hub (started with --demo, its own data dir) has demo accounts. */}
            {[...db.accounts.values()].some((a) => a.demo) && (
              <button
                class="btn ghost small"
                onClick={() => {
                  if (confirm('Reset the demo world to its starting state?')) api('/api/demo/reset', { body: {} }).then(() => toast({ kind: 'info', title: 'Demo reset', body: 'Fresh demo data loaded.' }));
                }}
              >
                <Icon name="refresh" size={13} /> Reset demo data
              </button>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

/** The theme: every theme in a list on a desktop; on a phone, a row that opens them in a sheet. */
function AppearanceTheme() {
  const [open, setOpen] = useState(false);
  const p = prefs.value;
  const t = chosenTheme();
  if (!phone.value) return <ThemeList />;
  const label = followsSystem() ? `${themeById(p.themeDark).name} / ${themeById(p.themeLight).name}` : t.name;
  return (
    <>
      <button class="set-rule theme-row" onClick={() => setOpen(true)}>
        <span class="set-rule-label">Theme</span>
        <span class="theme-row-value">
          <Swatch t={t} />
          {label}
          <Icon name="chevronRight" size={15} />
        </span>
      </button>
      {open && (
        <Sheet onClose={() => setOpen(false)} label="Theme" tall>
          <ThemeList />
        </Sheet>
      )}
    </>
  );
}

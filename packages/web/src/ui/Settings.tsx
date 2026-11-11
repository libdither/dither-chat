import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { listPreview } from '../board.ts';
import { liveRules, netName, ruleIcon, ruleName } from '../model.ts';
import { api, db, go, mailRev, prefs, rev, setPrefs, setRule, toast } from '../state.ts';
import { loadPolicy, setListLevel, triagePolicy } from '../triage.ts';
import { STATUS, addingAccount } from './Accounts.tsx';
import { AccountChip, NetBadge, showSection } from './bits.tsx';
import { Icon } from './icons.tsx';
import { DeviceRules } from './DeviceRules.tsx';
import { percent } from './Marks.tsx';
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

/** Settings' sections: listed beside them on a desktop, and in a sheet from their header on a phone. */
export const SECTIONS: [title: string, icon: string, id: string][] = [
  ['Notifications', 'bell', 'set-notifications'],
  ['Push and quiet hours', 'bellOff', 'push'],
  ['Each device', 'phone', 'set-devices'],
  ['Keywords', 'at', 'set-keywords'],
  ['Your rules', 'layers', 'set-overrides'],
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
              // Your rules are there only once there are some.
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

/** The steps the list's level can be set to: 0.1 to 0.9. */
const LIST_STEPS = 9;

/**
 * The phone's list: the importance a message needs to reach it, in steps of ten percent, with how many chats a day
 * the list would have held last week at the step under the thumb.
 */
function ListLevel() {
  const p = triagePolicy.value;
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => void loadPolicy(), []);
  if (!p) return null;
  const level = at ?? p.thresholds.important;
  const step = Math.min(LIST_STEPS, Math.max(1, Math.round(level * 10)));
  const value = (e: Event) => Number((e.target as HTMLInputElement).value) / 10;
  const save = (v: number) =>
    setListLevel(v)
      .catch((e) => toast({ kind: 'error', title: 'Could not save the level', body: e.message }))
      .finally(() => setAt(null));
  return (
    <div class="list-level" id="set-list">
      <b>The phone's list</b>
      <small>A message reaches the list when its importance is at or above this level. Lower it for a longer list.</small>
      <div class="sensitivity">
        <input type="range" min={1} max={LIST_STEPS} step={1} value={step} aria-label="The importance a message needs to reach the list" onInput={(e) => setAt(value(e))} onChange={(e) => save(value(e))} />
        <span class="sensitivity-label" data-list-level>
          {percent(level)}
        </span>
        <span data-list-preview>{listPreview(p.preview, step / 10)}</span>
      </div>
    </div>
  );
}

function ruleLabel(r: P.RuleView): { icon: P.Network | null; text: string } {
  if (r.scope === 'network') return { icon: r.target as P.Network, text: `All of ${netName(r.target as P.Network)}` };
  if (r.scope === 'global') return { icon: null, text: 'Everything' };
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
          <b>Hold alerts during these hours</b>
          <small>A held alert stays a silent conversation or list row, marked with why it was held. One notification when the hours end says how many were held.</small>
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
          <b>People set to always alert still get through</b>
        </span>
      </label>
      <p class="set-help">In {q.timezone}. A day counts from when the hours start, so a Friday night runs into Saturday morning.</p>
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
  const rules = liveRules();
  const keywordRules = rules.filter((r) => r.scope === 'keyword');
  // Every rule on a place or a person, and any wider one kept from before the tiers, so that it can be cleared.
  const scoped = rules.filter((r) => r.scope !== 'keyword');

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

        <section class="set-block" id="set-notifications">
          <h3>Notifications</h3>
          <p class="set-help">
            Alerts sound; conversations are people talking with you, silent; the list is everything else that is important enough, silent, the most important first.
          </p>
          <ListLevel />
          <button class="link-row set-sorts" data-track="how it sorts" onClick={() => go({ view: 'model' })}>
            <Icon name="sparkles" size={15} />
            <span>
              <b>How it sorts</b>
              <small>Where each conversation's messages landed this week and why, your marks, and what was learned from them</small>
            </span>
            <Icon name="chevronRight" size={15} />
          </button>
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
              <small>A system notification for an alert, delivered over the hub's own connection. It stops when the app is closed; for that, turn on push below.</small>
            </span>
          </label>
          <div class="set-model">
            <Icon name="sparkles" size={15} />
            <div>
              <b>Local model</b>
              <small>
                Alerts start from a model on the hub's machine. It reads a message in a conversation and answers one question: does this need you within the next hour or two? Your marks move it from there. Without
                a model only your rules alert: people and places set to Always alert, and keywords. No message ever leaves the hub's machine.
              </small>
            </div>
          </div>
        </section>

        <PushSettings />

        <DeviceRules />

        <QuietHoursSettings />

        <section class="set-block" id="set-keywords">
          <h3>Keywords that always alert</h3>
          <p class="set-help">A message with one of these words is an alert, wherever it lands (unless that place is muted).</p>
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
            <h3>Your rules</h3>
            {scoped.map((r) => {
              const l = ruleLabel(r);
              return (
                <div class="set-rule">
                  <span class="set-rule-label">
                    {l.icon ? <NetBadge network={l.icon} size={16} /> : <Icon name="at" size={15} />} {l.text}
                  </span>
                  <span class={`level-tag ${r.level}`}>
                    <Icon name={ruleIcon(r.level)} size={12} /> {ruleName(r.level)}
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

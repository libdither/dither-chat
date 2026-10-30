import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { LEVEL_LABEL, netName } from '../model.ts';
import { api, db, prefs, rev, setPrefs, setRule, toast } from '../state.ts';
import { NetBadge, NetGlyph, levelIcon } from './bits.tsx';
import { Icon } from './icons.tsx';

const LEVELS: P.NotifyLevel[] = ['all', 'smart', 'mentions', 'digest', 'none'];

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
          <h2>Settings</h2>
          <p>Notification rules apply to every account at once. The most specific rule always wins.</p>
        </div>
      </header>
      <div class="settings-scroll">
        <section class="set-block">
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

        <section class="set-block">
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
              <b>Browser & phone notifications</b>
              <small>Push a system notification when something clears triage. On your phone, install this app first (Share → Add to Home Screen).</small>
            </span>
          </label>
          <div class="set-model">
            <Icon name="sparkles" size={15} />
            <div>
              <b>Local model (optional)</b>
              <small>
                Start the hub with <code>DITHER_TRIAGE_MODEL=llama3.2</code> (and Ollama on the home machine) to score the harder "Smart" cases with a local LLM, using the recent thread
                as context and your thumbs up / down as examples. No message ever leaves the hub.
              </small>
            </div>
          </div>
        </section>

        <section class="set-block">
          <h3>Keywords that always ping</h3>
          <p class="set-help">A message containing one of these pushes no matter where it lands (unless that place is set to Off).</p>
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
          <section class="set-block">
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

        <section class="set-block">
          <h3>Appearance</h3>
          <div class="set-rule">
            <span class="set-rule-label">Theme</span>
            <div class="level-picker">
              {(['dark', 'light', 'system'] as const).map((t) => (
                <button class={`chip-btn ${p.theme === t ? 'on' : ''}`} onClick={() => setPrefs({ theme: t })}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <label class="toggle-row">
            <input type="checkbox" checked={p.showDemo} onChange={(e) => setPrefs({ showDemo: (e.target as HTMLInputElement).checked })} />
            <span>
              <b>Show demo accounts</b>
              <small>The four sample accounts (two Discord, Signal, Matrix) that ship with this preview. Turn off to see only real accounts you've added.</small>
            </span>
          </label>
        </section>

        <section class="set-block">
          <h3>About</h3>
          <p class="set-help">
            dither-chat runs entirely on your hub and is served to your devices over Tailscale. It aggregates Discord, Signal and Matrix into one ontology: people, groups, and
            communities with channels and threads, each annotated with the account it came through.
          </p>
          <div class="btn-row">
            <a class="btn ghost small" href="https://github.com/libdither/dither-chat" target="_blank" rel="noreferrer">
              <Icon name="external" size={13} /> Source
            </a>
            <button
              class="btn ghost small"
              onClick={() => {
                if (confirm('Reset the demo world to its starting state?')) api('/api/demo/reset', { body: {} }).then(() => toast({ kind: 'info', title: 'Demo reset', body: 'Fresh demo data loaded.' }));
              }}
            >
              <Icon name="refresh" size={13} /> Reset demo data
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}

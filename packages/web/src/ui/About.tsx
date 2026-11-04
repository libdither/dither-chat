/**
 * About and settings for a conversation or a space (docs/group-settings.md): what it is, who is in it with what
 * role, who may do what, its invite link and pinned messages, and its settings, each editable only where the
 * network says your account may, with the reason where it may not. The pieces here make up a place's profile page
 * (PlaceProfile.tsx, docs/profile.md).
 */
import type * as P from '@dither-chat/protocol';
import { ABOUT_LABEL, ABOUT_RULES, durationLabel, HISTORY_LABEL, JOIN_RULE_LABEL, NETWORK_META, WHO_LABEL } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { fullTime } from '../format.ts';
import { authorName, convTitle, identityName, netName, plainBody } from '../model.ts';
import { api, db, go, isSelfIdentity, openProfile, toast } from '../state.ts';
import { Avatar } from './bits.tsx';
import { Menuable } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import { identityMenu } from './menus.tsx';

export type AboutTarget = { kind: 'conversation' | 'space'; id: string };

/** About lives on the place's profile page now (PlaceProfile.tsx). */
export function openAbout(kind: AboutTarget['kind'], id: string) {
  go(kind === 'space' ? { view: 'profile', space: id } : { view: 'profile', conv: id });
}

const BOOL_ON: Partial<Record<P.AboutKey, string>> = { nsfw: 'Age-restricted', announceOnly: 'Only admins', joinApproval: 'Admins approve', encrypted: 'On' };
const BOOL_OFF: Partial<Record<P.AboutKey, string>> = { nsfw: 'No', announceOnly: 'Everyone', joinApproval: 'No', encrypted: 'Off' };
const HINT: Partial<Record<P.AboutKey, string>> = {
  disappearing: 'New messages disappear after this long.',
  slowMode: 'How long members wait between messages.',
  nsfw: 'Members confirm their age before they see it.',
  announceOnly: 'Only admins can send messages.',
  joinApproval: 'People with the link wait for an admin to let them in.',
  encrypted: 'Once on, it cannot be turned off.',
};

/** A setting's value in words. */
export function valueText(key: P.AboutKey, v: unknown): string {
  if (v === null || v === undefined) return 'Unknown';
  switch (key) {
    case 'disappearing':
    case 'slowMode':
      return durationLabel(v as number);
    case 'editInfo':
    case 'addMembers':
      return WHO_LABEL[v as P.Who];
    case 'joinRule':
      return JOIN_RULE_LABEL[v as P.JoinRule];
    case 'history':
      return HISTORY_LABEL[v as P.HistoryVisibility];
    default:
      return typeof v === 'boolean' ? (v ? BOOL_ON[key] : BOOL_OFF[key]) ?? (v ? 'On' : 'Off') : String(v);
  }
}

/** The choices a select offers for a setting, with the current value kept even when the network's list lacks it. */
function choices(network: P.Network, key: P.AboutKey, current: unknown): { value: string; label: string }[] {
  const r = ABOUT_RULES[network];
  const nums = (xs: number[] | undefined) => [...new Set([...(xs ?? []), ...(typeof current === 'number' ? [current] : [])])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: durationLabel(n) }));
  if (key === 'disappearing') return nums(r.disappearing);
  if (key === 'slowMode') return nums(r.slowMode);
  if (key === 'editInfo' || key === 'addMembers') return (Object.keys(WHO_LABEL) as P.Who[]).map((w) => ({ value: w, label: WHO_LABEL[w] }));
  if (key === 'joinRule') return (Object.keys(JOIN_RULE_LABEL) as P.JoinRule[]).map((w) => ({ value: w, label: JOIN_RULE_LABEL[w] }));
  if (key === 'history') return (Object.keys(HISTORY_LABEL) as P.HistoryVisibility[]).map((w) => ({ value: w, label: HISTORY_LABEL[w] }));
  return [];
}

const NUMERIC: P.AboutKey[] = ['disappearing', 'slowMode'];
const BOOLEAN: P.AboutKey[] = ['nsfw', 'announceOnly', 'joinApproval', 'encrypted'];
const TOP: P.AboutKey[] = ['name', 'topic', 'avatar'];

/**
 * A place's About, as the network has it now through one of your accounts (`as` picks which), and a way to change
 * one setting through it.
 */
export function useAbout(target: AboutTarget) {
  const [as, setAs] = useState<string | undefined>(undefined);
  const [view, setView] = useState<P.AboutView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const path = `/api/${target.kind === 'space' ? 'spaces' : 'conversations'}/${target.id}/about`;

  const show = (v: P.AboutView) => {
    for (const i of v.identities ?? []) db.identities.set(i.id, i);
    setView(v);
  };
  useEffect(() => {
    let live = true;
    setError(null);
    setView(null);
    api<P.AboutView>(`${path}${as ? `?account=${encodeURIComponent(as)}` : ''}`)
      .then((v) => live && show(v))
      .catch((e: Error) => live && setError(e.message));
    return () => void (live = false);
  }, [path, as]);

  const change = async (c: P.AboutChange, what: string) => {
    if (busy) return false;
    setBusy(c.key);
    try {
      const v = await api<P.AboutView>(path, { body: { change: c, ...(view?.accountId ? { accountId: view.accountId } : {}) } });
      show(v);
      toast({ kind: 'info', title: what, body: '' }, 2500);
      return true;
    } catch (e) {
      toast({ kind: 'error', title: `Could not change ${c.key === 'invite' ? 'the invite link' : c.key === 'pin' ? 'the pins' : ABOUT_LABEL[c.key as P.AboutKey].toLowerCase()}`, body: (e as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { view, error, busy, as, setAs, change };
}

/** The settings a network has here, beyond name, description and picture, that this About carries. */
export function settingKeys(network: P.Network, kind: AboutTarget['kind'], f: P.AboutFields): P.AboutKey[] {
  return (ABOUT_RULES[network][kind] as P.AboutKey[]).filter((k) => !TOP.includes(k) && f[k]);
}

/** "Who can do what", with a tick or a lock for you. */
export function RulesList({ rules }: { rules: P.AboutRule[] }) {
  return (
    <dl class="about-rules">
      {rules.map((r) => (
        <div class={`about-rule ${r.you ? 'you' : ''}`}>
          <dt>{r.what}</dt>
          <dd>
            {r.who}
            <span class="about-you" title={r.you ? 'You can' : 'You cannot'}>
              <Icon name={r.you ? 'check' : 'lock'} size={12} />
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Why a setting is locked, as a small line under it. */
export function Locked({ s }: { s?: P.AboutSetting }) {
  return s && !s.canEdit && s.reason ? (
    <small class="about-reason">
      <Icon name="lock" size={11} /> {s.reason}
    </small>
  ) : null;
}

export function EditableText({
  setting,
  fallback,
  label,
  multiline,
  big,
  busy,
  max,
  onSave,
}: {
  setting?: P.AboutSetting;
  fallback: string;
  label: string;
  multiline?: boolean;
  big?: boolean;
  busy?: boolean;
  max?: number;
  onSave: (v: string) => Promise<boolean>;
}) {
  const value = (setting?.value as string | null) ?? fallback;
  const [draft, setDraft] = useState<string | null>(null);
  const save = async () => {
    if (draft === null) return;
    if (draft.trim() === value.trim()) return setDraft(null);
    if (await onSave(draft.trim())) setDraft(null);
  };
  if (draft !== null) {
    const props = {
      class: `about-input ${big ? 'big' : ''}`,
      value: draft,
      maxLength: max,
      'aria-label': label,
      onInput: (e: Event) => setDraft((e.target as HTMLInputElement).value),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') (e.stopPropagation(), setDraft(null));
        if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey) && !e.isComposing) (e.preventDefault(), void save());
      },
      ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => el && document.activeElement !== el && el.focus(),
    };
    return (
      <div class={`about-edit ${multiline ? 'multi' : ''}`}>
        {multiline ? <textarea rows={3} {...(props as any)} /> : <input {...(props as any)} />}
        <div class="about-edit-btns">
          <button class="btn ghost small" onClick={() => setDraft(null)}>
            Cancel
          </button>
          <button class="btn primary small" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class={`about-text ${big ? 'big' : ''} ${multiline ? 'multi' : ''}`}>
      {big ? <h2>{value}</h2> : <p>{value || <em>No description</em>}</p>}
      {setting?.canEdit ? (
        <button class="icon-btn small about-pencil" title={`Change the ${label.toLowerCase()}`} aria-label={`Change the ${label.toLowerCase()}`} onClick={() => setDraft(value)}>
          <Icon name="pencil" size={13} />
        </button>
      ) : (
        setting?.reason && (
          <span class="about-lock" title={setting.reason} aria-label={`${label}: ${setting.reason}`}>
            <Icon name="lock" size={12} />
          </span>
        )
      )}
    </div>
  );
}

export function SettingRow({ network, k, s, busy, onChange }: { network: P.Network; k: P.AboutKey; s: P.AboutSetting; busy: boolean; onChange: (v: unknown) => void }) {
  const id = `about-${k}`;
  let control;
  if (!s.canEdit) control = <span class="about-value">{valueText(k, s.value)}</span>;
  else if (BOOLEAN.includes(k)) {
    const on = !!s.value;
    control = (
      <label class="about-switch">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={on}
          disabled={busy}
          onChange={(e) => {
            const next = (e.target as HTMLInputElement).checked;
            (e.target as HTMLInputElement).checked = on;
            if (k === 'encrypted' && next && !confirm('Turn on end-to-end encryption? It cannot be turned off again.')) return;
            onChange(next);
          }}
        />
        <span>{valueText(k, on)}</span>
      </label>
    );
  } else {
    const opts = choices(network, k, s.value);
    control = (
      <select id={id} class="select about-select" disabled={busy} value={s.value === null ? '' : String(s.value)} onChange={(e) => onChange(NUMERIC.includes(k) ? Number((e.target as HTMLSelectElement).value) : (e.target as HTMLSelectElement).value)}>
        {s.value === null && <option value="">Unknown</option>}
        {opts.map((o) => (
          <option value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }
  return (
    <div class={`about-row ${s.canEdit ? 'editable' : 'locked'}`} data-key={k}>
      <div class="about-row-text">
        <label for={s.canEdit ? id : undefined}>
          <b>{ABOUT_LABEL[k]}</b>
        </label>
        {HINT[k] && s.canEdit && <small>{HINT[k]}</small>}
        <Locked s={s} />
      </div>
      <div class="about-row-control">
        {control}
        {!s.canEdit && !s.reason && (
          <span class="about-lock" title="You cannot change this">
            <Icon name="lock" size={12} />
          </span>
        )}
      </div>
    </div>
  );
}

export function InviteSection({ inv, busy, onChange }: { inv: P.AboutInvite; busy: boolean; onChange: (op: 'create' | 'revoke') => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section class="about-section about-invite">
      <h3>Invite link</h3>
      {inv.link ? (
        <button
          class="native-id about-link"
          title="Copy"
          onClick={() => {
            navigator.clipboard?.writeText(inv.link!);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          <code>{inv.link}</code>
          <Icon name={copied ? 'check' : 'copy'} size={12} />
        </button>
      ) : (
        <p class="det-note">{inv.canCreate ? 'There is no link yet.' : 'No link you can see.'}</p>
      )}
      {(inv.canCreate || inv.canRevoke) && (
        <div class="btn-row">
          {inv.canCreate && (
            <button
              class="btn ghost small"
              disabled={busy}
              onClick={() => (!inv.link || confirm('Make a new link? The old one stops working for everyone.')) && onChange('create')}
            >
              <Icon name={inv.link ? 'refresh' : 'link'} size={13} /> {inv.link ? 'Reset link' : 'Make a link'}
            </button>
          )}
          {inv.canRevoke && inv.link && (
            <button class="btn ghost small danger" disabled={busy} onClick={() => confirm('Turn the link off? Nobody can join with it any more.') && onChange('revoke')}>
              <Icon name="unlink" size={13} /> Turn off
            </button>
          )}
        </div>
      )}
      {inv.reason && !(inv.canCreate || inv.canRevoke) && (
        <small class="about-reason">
          <Icon name={inv.derived ? 'info' : 'lock'} size={11} /> {inv.reason}
        </small>
      )}
    </section>
  );
}

export function PinnedSection({ p, network, onOpen, onUnpin }: { p: NonNullable<P.AboutView['pinned']>; network: P.Network; onOpen: (m: P.MessageView) => void; onUnpin: (m: P.MessageView) => void }) {
  const total = p.messages.length + p.missing;
  return (
    <section class="about-section about-pinned">
      <h3>Pinned{total ? ` (${total})` : ''}</h3>
      {!total && <p class="det-note">Nothing is pinned.</p>}
      {p.messages.map((m) => (
        <div class="about-pin">
          <button class="about-pin-open" onClick={() => onOpen(m)} title="Go to the message">
            <b>{isSelfIdentity(m.authorId) ? 'You' : authorName(m.authorId)}</b>
            <span>{plainBody(m.body, network).slice(0, 160) || (m.attachments.length ? 'Attachment' : 'Message')}</span>
          </button>
          {p.canEdit && (
            <button class="icon-btn small" title="Unpin" aria-label="Unpin" onClick={() => onUnpin(m)}>
              <Icon name="x" size={13} />
            </button>
          )}
        </div>
      ))}
      {p.missing > 0 && <p class="det-note">{p.missing === 1 ? 'One pinned message is' : `${p.missing} pinned messages are`} older than what the hub has.</p>}
      {!p.canEdit && p.reason && total > 0 && <Locked s={{ value: null, canEdit: false, reason: p.reason }} />}
    </section>
  );
}

const SHOWN = 120;

export function MembersSection({ m }: { m: NonNullable<P.AboutView['members']> }) {
  const [all, setAll] = useState(false);
  // Grouped by role, highest first, as Discord's member list does.
  const sorted = [...m.list].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || identityName(a.identityId).localeCompare(identityName(b.identityId)));
  const shown = all ? sorted : sorted.slice(0, SHOWN);
  const groups: { role: string; list: typeof shown }[] = [];
  for (const x of shown) {
    const role = x.role ?? 'Members';
    const g = groups.at(-1);
    if (g && g.role === role) g.list.push(x);
    else groups.push({ role, list: [x] });
  }
  const total = m.total ?? m.list.length;
  return (
    <section class="about-section about-members">
      <h3>Members ({total})</h3>
      {!m.complete && <p class="det-note">Showing the {m.list.length} the network has loaded.</p>}
      {groups.map((g) => (
        <div class="about-role">
          <h4>{g.role}</h4>
          {g.list.map((x) => {
            const i = db.identities.get(x.identityId);
            const p = i?.personId ? db.persons.get(i.personId) : null;
            const self = isSelfIdentity(x.identityId);
            const name = self ? `${identityName(x.identityId)} (you)` : (p?.name ?? identityName(x.identityId));
            return (
              <Menuable build={() => identityMenu(x.identityId)}>
                {(ctx) => (
                  <button class="member" onClick={() => openProfile(x.identityId)} {...ctx}>
                    <Avatar id={p?.id ?? x.identityId} name={name} url={p?.avatar ?? i?.avatar} size={28} />
                    <span>
                      <b style={x.color ? { color: x.color } : undefined}>{name}</b>
                      <small>{i?.handle ?? i?.nativeId ?? ''}</small>
                    </span>
                  </button>
                )}
              </Menuable>
            );
          })}
        </div>
      ))}
      {!all && sorted.length > SHOWN && (
        <button class="btn ghost small" onClick={() => setAll(true)}>
          Show all {sorted.length}
        </button>
      )}
    </section>
  );
}

/**
 * Moderating a group or server from its page (docs/moderation.md), a chunk of its own loaded only where the About
 * says this account may moderate something (ModerationLazy.tsx): what a member's menu adds (remove or kick, ban,
 * admins, roles, timeouts), the Moderation card (who is banned, unbanning, who asks to join, ending a group), your
 * own member label, a new picture, and leaving a Signal group as its only admin. Every action is one click and a
 * confirm; the hub checks a fresh About again and the network has the last word, shown as its sentence.
 */
import type * as P from '@dither-chat/protocol';
import { modVerb, spanLabel } from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { fullTime } from '../format.ts';
import { identityName, netName } from '../model.ts';
import { api, db, go, isSelfIdentity, openProfile, toast } from '../state.ts';
import { uploadFile } from '../upload.ts';
import type { MenuEntry } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import { Card } from './ProfileShell.tsx';

type Kind = 'conversation' | 'space';
type Member = NonNullable<P.AboutView['members']>['list'][number];

const base = (view: P.AboutView) => `/api/${view.target.kind === 'space' ? 'spaces' : 'conversations'}/${view.target.id}`;
const placeName = (view: P.AboutView) => (view.target.kind === 'space' ? db.spaces.get(view.target.id)?.name : null) ?? (db.conversations.get(view.target.id)?.name || `this ${(view.noun ?? 'group').toLowerCase()}`);
const who = (id: string) => db.persons.get(db.identities.get(id)?.personId ?? '')?.name ?? identityName(id);

/** One action, after the owner's confirm: the About as it now stands, or the network's sentence. */
async function act(view: P.AboutView, action: P.ModAction, question: string, done: (v: P.AboutView) => void, what: string) {
  if (!confirm(question)) return;
  try {
    done(await api<P.AboutView>(`${base(view)}/moderate`, { body: { action, ...(view.accountId ? { accountId: view.accountId } : {}) } satisfies P.ModerateRequest }));
    toast({ kind: 'info', title: what, body: '' }, 2500);
  } catch (e) {
    toast({ kind: 'error', title: `Could not ${modVerb(view.network, action).toLowerCase()}`, body: (e as Error).message });
  }
}

/** Does this About let the account moderate anything here? */
export function moderates(view: P.AboutView | null | undefined): boolean {
  const m = view?.moderation;
  return !!m && [m.remove, m.ban, m.admins, m.roles, m.timeout, m.end].some((p) => p?.can);
}

/** What a member's menu adds for a moderator: only what this account may do to them, each with a confirm. */
export function memberEntries(view: P.AboutView, member: Member, done: (v: P.AboutView) => void): MenuEntry[] {
  const m = view.moderation;
  if (!m || isSelfIdentity(member.identityId)) return [];
  const mod = member.mod;
  const name = who(member.identityId);
  const place = placeName(view);
  const net = netName(view.network);
  const discord = view.network === 'discord';
  if (mod?.above) return [{ kind: 'label', label: mod.reason ?? 'They outrank you here.', note: true }];
  const out: MenuEntry[] = [];
  if (m.admins?.can) {
    const admin = (member.rank ?? 0) >= 100;
    out.push({
      label: admin ? 'Remove as Admin' : 'Make Admin',
      icon: 'star',
      track: admin ? 'mod remove admin' : 'mod make admin',
      run: () => void act(view, { op: 'admin', who: member.identityId, ...(admin ? { remove: true as const } : {}) }, admin ? `Take admin away from ${name} in ${place}?` : `Make ${name} an admin of ${place}? They can then change its settings and remove people, you included.`, done, admin ? `${name} is no longer an admin` : `${name} is an admin`),
    });
  }
  if (m.roles?.can && m.roles.assignable.length) {
    const has = new Set(mod?.roles ?? []);
    out.push({
      label: 'Roles',
      icon: 'idBadge',
      track: 'mod roles',
      sub: m.roles.assignable.map((rid): MenuEntry => {
        const role = view.roles?.find((r) => r.id === rid);
        const on = has.has(rid);
        const rn = role?.name ?? 'role';
        return { label: rn, checked: on, ...(role?.color ? { dot: role.color } : {}), track: on ? 'mod take role' : 'mod give role', run: () => void act(view, { op: 'role', who: member.identityId, role: rid, ...(on ? { remove: true as const } : {}) }, on ? `Take the ${rn} role from ${name}?` : `Give ${name} the ${rn} role?`, done, on ? `Took ${rn} from ${name}` : `Gave ${name} ${rn}`) };
      }),
    });
  }
  if (m.timeout?.can) {
    const until = mod?.timedOutUntil;
    out.push(
      until && until > Date.now()
        ? { label: 'End Timeout', icon: 'clock', track: 'mod end timeout', run: () => void act(view, { op: 'timeout', who: member.identityId, seconds: 0 }, `End ${name}'s timeout now? It would end ${fullTime(until)}.`, done, `${name} can talk again`) }
        : {
            label: 'Time Out',
            icon: 'clock',
            track: 'mod timeout',
            sub: m.timeout.durations.map((s): MenuEntry => ({ label: `For ${spanLabel(s)}`, track: 'mod timeout (span)', run: () => void act(view, { op: 'timeout', who: member.identityId, seconds: s }, `Time out ${name} for ${spanLabel(s)}? Until then they cannot send, react, talk or join voice in ${place}.`, done, `${name} is timed out`) })),
          },
    );
  }
  if (m.remove?.can)
    out.push({
      label: discord ? 'Kick' : 'Remove From Group',
      icon: 'x',
      danger: true,
      track: 'mod remove',
      run: () => void act(view, { op: 'remove', who: member.identityId }, discord ? `Kick ${name} from ${place}? They can come back with an invite.` : `Remove ${name} from ${place}? They can come back by the link or if someone adds them.`, done, discord ? `${name} was kicked` : `${name} was removed`),
    });
  if (m.ban?.can) {
    const ban = (s?: number) => () => void act(view, { op: 'ban', who: member.identityId, ...(s ? { deleteSeconds: s } : {}) }, `Ban ${name} from ${place}? They are taken out and cannot come back until unbanned.${s ? ` Their messages from the last ${spanLabel(s)} are deleted too.` : ''}`, done, `${name} was banned`);
    out.push(
      m.ban.deleteHistory?.length
        ? { label: 'Ban', icon: 'lock', danger: true, track: 'mod ban', sub: m.ban.deleteHistory.map((s): MenuEntry => ({ label: s ? `Ban and delete their last ${spanLabel(s)}` : 'Ban, keep their messages', danger: true, track: 'mod ban (history)', run: ban(s) })) }
        : { label: 'Ban', icon: 'lock', danger: true, track: 'mod ban', run: ban() },
    );
  }
  return out.length ? [{ kind: 'label', label: `Moderate on ${net}` }, ...out] : [];
}

/** The banned (unban), those asking to join, ending a group, and what is left to the network's own app. */
export function ModerationCard({ view, onDone }: { view: P.AboutView; onDone: (v: P.AboutView) => void }) {
  const m = view.moderation!;
  const [bans, setBans] = useState<P.BansView | null>(null);
  const [loading, setLoading] = useState(false);
  const place = placeName(view);
  const banned = m.bansOnRequest ? (bans?.banned ?? null) : (m.banned ?? []).map((identityId) => ({ identityId, reason: undefined as string | undefined }));
  const show = async () => {
    setLoading(true);
    try {
      const v = await api<P.BansView>(`${base(view)}/bans${view.accountId ? `?account=${encodeURIComponent(view.accountId)}` : ''}`);
      for (const i of v.identities) db.identities.set(i.id, i);
      setBans(v);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not read the banned', body: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };
  const unban = (id: string) =>
    void act(view, { op: 'unban', who: id }, `Unban ${who(id)}? They can come back ${view.network === 'discord' ? 'with an invite' : 'by the link, or be added'}.`, (v) => (onDone(v), bans && setBans({ ...bans, banned: bans.banned.filter((b) => b.identityId !== id) })), `${who(id)} was unbanned`);
  const end = () => {
    const typed = prompt(`End ${place} for everyone? Nobody can send in it or change it again, and this cannot be undone.\n\nType the group's name to end it:`);
    if (typed === null) return;
    if (typed.trim() !== place.trim()) return toast({ kind: 'error', title: 'Not ended', body: 'The name did not match.' });
    void act(view, { op: 'end' }, `Last check: end ${place} now?`, onDone, `${place} was ended`);
  };
  return (
    <Card title="Moderation" icon="lock" class="pf-moderation">
      {m.ban?.can && (
        <div class="mod-banned">
          <h4>Banned</h4>
          {banned === null ? (
            <button class="btn ghost small" disabled={loading} onClick={() => void show()}>
              {loading ? 'Asking…' : 'Show who is banned'}
            </button>
          ) : banned.length ? (
            <ul class="mod-list">
              {banned.map((b) => (
                <li>
                  <button class="link-btn" onClick={() => openProfile(b.identityId)}>
                    {who(b.identityId)}
                  </button>
                  {b.reason && <small> · {b.reason}</small>}
                  <button class="btn ghost small" onClick={() => unban(b.identityId)}>
                    Unban
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p class="pf-hint">Nobody is banned.</p>
          )}
          {bans?.more && <p class="pf-hint">{netName(view.network)} lists more than these: see the rest in {netName(view.network)}.</p>}
        </div>
      )}
      {!!m.requesting?.length && (
        <p class="pf-hint">
          {m.requesting.length === 1 ? `${who(m.requesting[0]!)} is asking to join.` : `${m.requesting.length} people are asking to join.`}{' '}
          <button class="link-btn" onClick={() => go({ view: 'inbox' })}>
            Answer under Requests
          </button>
        </p>
      )}
      {m.end?.can && (
        <div class="btn-row">
          <button class="btn ghost small danger" onClick={end}>
            <Icon name="alert" size={13} /> End the group…
          </button>
        </div>
      )}
      {m.elsewhere && <p class="pf-hint">{m.elsewhere}</p>}
    </Card>
  );
}

/** Your own member label in a group (Signal): a few words and an emoji, shown by your name to everyone in it. */
export function LabelCard({ view, onDone }: { view: P.AboutView; onDone: (v: P.AboutView) => void }) {
  const l = view.label!;
  const [text, setText] = useState(l.value ?? '');
  const [emoji, setEmoji] = useState(l.emoji ?? '');
  const [busy, setBusy] = useState(false);
  const changed = text.trim() !== (l.value ?? '') || emoji.trim() !== (l.emoji ?? '');
  const save = async () => {
    setBusy(true);
    try {
      onDone(await api<P.AboutView>(`/api/conversations/${view.target.id}/label`, { body: { text: text.trim(), emoji: emoji.trim(), ...(view.accountId ? { accountId: view.accountId } : {}) } }));
      toast({ kind: 'info', title: text.trim() ? 'Label set' : 'Label cleared', body: '' }, 2500);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not set your label', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Your label" icon="idBadge">
      {l.canEdit ? (
        <div class="mod-label">
          <input class="input mod-emoji" value={emoji} maxLength={8} placeholder="🙂" aria-label="Its emoji" onInput={(e) => setEmoji((e.target as HTMLInputElement).value)} />
          <input class="input" value={text} maxLength={l.max} placeholder="A few words" aria-label="Your label here" onInput={(e) => setText((e.target as HTMLInputElement).value)} />
          <button class="btn small primary" disabled={busy || !changed} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : (
        <p>{l.value ? `${l.emoji ?? ''} ${l.value}` : 'No label'}</p>
      )}
      <p class="pf-hint">{l.canEdit ? 'Shown by your name to everyone in it. Leave it empty to clear it.' : l.reason}</p>
    </Card>
  );
}

/** A new picture for a group or server: uploaded to the hub, then sent through the account whose view this is. */
export async function changePicture(view: P.AboutView, file: File | undefined, onDone: (v: P.AboutView) => void) {
  if (!file) return;
  try {
    const up = await uploadFile(file, file.name, file.type || 'application/octet-stream');
    onDone(await api<P.AboutView>(`${base(view)}/about`, { body: { change: { key: 'avatar', value: up.id }, ...(view.accountId ? { accountId: view.accountId } : {}) } }));
    toast({ kind: 'info', title: 'Picture changed', body: '' }, 2500);
  } catch (e) {
    toast({ kind: 'error', title: 'Could not change the picture', body: (e as Error).message });
  }
}

/**
 * Leaving a Signal group: as its only admin, pick who takes over first (Signal wants one); forgetting it on this
 * device is a choice of its own, with its own confirm. Shown in place of the plain confirm.
 */
export function LeaveCard({ kind, id, name, view, onCancel }: { kind: Kind; id: string; name: string; view: P.AboutView; onCancel: () => void }) {
  const l = view.leaving!;
  const others = (view.members?.list ?? []).filter((m) => !isSelfIdentity(m.identityId));
  const [next, setNext] = useState<string>('');
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    if (l.needsAdmin && !next) return;
    if (!confirm(`Leave ${name}?${next ? `\n\n${who(next)} becomes an admin as you go.` : ''}\n\nYou stop getting its messages; what you have here stays, read-only.`)) return;
    if (forget && !confirm(`Also forget ${name} on this device? signal-cli deletes its copy of the group; the hub keeps what it has.`)) return;
    setBusy(true);
    try {
      await api<P.LeaveResult>(`/api/${kind === 'space' ? 'spaces' : 'conversations'}/${id}/leave`, { body: { ...(view.accountId ? { accountId: view.accountId } : {}), ...(next ? { admins: [next] } : {}), ...(forget ? { forget: true } : {}) } satisfies P.LeaveRequest });
      toast({ kind: 'info', title: `You left ${name}`, body: '' }, 3000);
      go({ view: 'inbox' });
    } catch (e) {
      toast({ kind: 'error', title: `Could not leave ${name}`, body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={`Leave ${name}`} icon="back" class="pf-leave">
      {l.needsAdmin && (
        <label class="pf-level">
          <span>{l.warning ?? 'You are its only admin: pick who becomes admin.'}</span>
          <select class="select" value={next} onChange={(e) => setNext((e.target as HTMLSelectElement).value)}>
            <option value="">Who becomes admin…</option>
            {others.map((m) => (
              <option value={m.identityId}>{who(m.identityId)}</option>
            ))}
          </select>
        </label>
      )}
      {l.canForget && (
        <label class="pf-check">
          <input type="checkbox" checked={forget} onChange={(e) => setForget((e.target as HTMLInputElement).checked)} /> Also forget it on this device
        </label>
      )}
      <div class="btn-row">
        <button class="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
        <button class="btn small danger" disabled={busy || (l.needsAdmin && !next)} onClick={() => void leave()}>
          {busy ? 'Leaving…' : 'Leave'}
        </button>
      </div>
    </Card>
  );
}

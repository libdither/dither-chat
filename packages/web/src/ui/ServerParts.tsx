/**
 * A server's page beyond its settings (docs/servers.md): its scheduled events with Interested, what it asks of you on
 * joining (its rules, an application, onboarding), your nickname there, its invite links with an expiry and a use
 * limit, and leaving it. Each write only where the network says your account may, with the reason where it may not,
 * and the network's own sentence when it refuses.
 */
import type * as P from '@dither-chat/protocol';
import { inviteAgeLabel, inviteUsesLabel } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { fullTime } from '../format.ts';
import { convTitle, identityName } from '../model.ts';
import { calledOff, gateReady, repeatText } from '../servers.ts';
import { api, db, go, toast } from '../state.ts';
import { EditableText, Locked } from './About.tsx';
import { Icon } from './icons.tsx';
import { Card } from './ProfileShell.tsx';
import { QrImage } from './QrCodes.tsx';

// ---------------------------------------------------------------- events

/** Where an event happens, in words. */
export function eventWhere(e: P.ScheduledEventView): string | null {
  if (!e.place) return null;
  if (e.place.kind === 'external') return e.place.location;
  const c = db.conversations.get(e.place.conversationId);
  return c ? convTitle(c) : e.place.kind === 'stage' ? 'A stage channel' : 'A voice channel';
}

const STATUS_TEXT: Partial<Record<P.EventStatus, string>> = { active: 'Happening now', completed: 'Over', cancelled: 'Called off' };

/** A server's scheduled events, soonest first, with Interested. */
export function EventsCard({ spaceId, accountId, id, onCount }: { spaceId: string; accountId?: string | null; id?: string; onCount?: (n: number) => void }) {
  const [view, setView] = useState<P.SpaceEventsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/spaces/${spaceId}/events`;
  const load = (fresh: boolean) =>
    api<P.SpaceEventsView>(`${path}?${new URLSearchParams({ ...(accountId ? { account: accountId } : {}), ...(fresh ? { fresh: '1' } : {}) })}`)
      .then((v) => (setView(v), setError(null), onCount?.(v.events.length)))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    setView(null);
    void load(false);
  }, [spaceId, accountId]);
  if (!view && !error) return null;
  const events = view?.events ?? [];
  if (!events.length && !error) return null;
  const answer = async (e: P.ScheduledEventView, interested: boolean) => {
    setBusy(e.id);
    try {
      const after = await api<P.ScheduledEventView>(`${path}/${e.id}/rsvp`, { body: { interested, ...(view?.accountId ? { accountId: view.accountId } : {}) } });
      setView((v) => v && { ...v, events: v.events.map((x) => (x.id === after.id ? after : x)) });
    } catch (err) {
      toast({ kind: 'error', title: interested ? 'Could not say Interested' : 'Could not take it back', body: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div id={id}>
      <Card
        title="Events"
        icon="calendar"
        count={events.length}
        extra={
          <button class="icon-btn small" title="Ask again: counts and your answers" aria-label="Refresh events" onClick={() => void load(true)}>
            <Icon name="refresh" size={13} />
          </button>
        }
      >
        {error && <p class="about-error">{error}</p>}
        {view?.stale && <p class="pf-stale">{view.stale}</p>}
        <div class="srv-events">
          {events.map((e) => {
            const over = e.status === 'completed' || e.status === 'cancelled';
            const where = eventWhere(e);
            const repeat = repeatText(e.rrule);
            const off = calledOff(e, Date.now());
            return (
              <article class={`srv-event ${over ? 'over' : ''}`} data-status={e.status}>
                {e.image && <img class="srv-event-cover" src={e.image} alt="" loading="lazy" />}
                <div class="srv-event-text">
                  <small class="srv-event-when">
                    {STATUS_TEXT[e.status] ? <b>{STATUS_TEXT[e.status]} · </b> : null}
                    {fullTime(e.start)}
                    {repeat && ` · ${repeat}`}
                    {off > 0 && ` · ${off} called off`}
                  </small>
                  <b class="srv-event-name">{e.name}</b>
                  {where && (
                    <span class="srv-event-where">
                      <Icon name={e.place?.kind === 'external' ? 'globe' : e.place?.kind === 'stage' ? 'stage' : 'voice'} size={12} /> {where}
                    </span>
                  )}
                  {e.description && <p class="srv-event-desc">{e.description}</p>}
                  <div class="srv-event-foot">
                    {e.interested !== null && (
                      <span class="pf-hint">
                        {e.interested.toLocaleString()} interested{e.creatorId ? ` · by ${identityName(e.creatorId)}` : ''}
                      </span>
                    )}
                    <span class="srv-event-btns">
                      {view?.canRsvp && !over && (
                        <button class={`btn small ${e.youInterested ? 'primary' : 'ghost'}`} aria-pressed={!!e.youInterested} disabled={busy === e.id} onClick={() => void answer(e, !e.youInterested)}>
                          <Icon name={e.youInterested ? 'check' : 'bell'} size={13} /> Interested
                        </button>
                      )}
                      {e.url && (
                        <a class="btn ghost small" href={e.url} target="_blank" rel="noopener noreferrer" title="Open it in the network's own app">
                          <Icon name="external" size={13} />
                        </a>
                      )}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        {view && !view.canRsvp && events.length > 0 && <p class="pf-hint">Saying Interested from here needs this account connected, with an adapter that can.</p>}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- gates

/** What a server asks of you now, answered here by you: rules ticked, questions written, channels picked. */
export function GateCard({ spaceId, accountId }: { spaceId: string; accountId?: string | null }) {
  const [view, setView] = useState<P.SpaceGateView | null>(null);
  const [agree, setAgree] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const path = `/api/spaces/${spaceId}/gate`;
  useEffect(() => {
    setView(null);
    api<P.SpaceGateView>(`${path}${accountId ? `?account=${encodeURIComponent(accountId)}` : ''}`)
      .then(setView)
      .catch(() => setView(null));
  }, [spaceId, accountId]);
  const g = view?.gate;
  if (!g) return null;
  const reset = () => (setAgree(false), setAnswers({}), setPicks(new Set()));
  const send = async () => {
    setBusy(true);
    try {
      const answer: P.GateAnswer = { kind: g.kind, ...(g.kind !== 'onboarding' && agree ? { agree: true } : {}), ...(g.kind === 'apply' ? { answers } : {}), ...(g.kind === 'onboarding' ? { picks: [...picks] } : {}) };
      const r = await api<P.GateResult>(path, { body: { answer, ...(view?.accountId ? { accountId: view.accountId } : {}) } });
      toast({ kind: 'info', title: r.status === 'submitted' ? 'Application sent' : g.kind === 'onboarding' ? 'Done' : 'You agreed to the rules', body: '' }, 2500);
      reset();
      setView({ ...view!, gate: r.status === 'submitted' ? { ...g, status: 'submitted' } : (r.next ?? null) });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not answer', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const title = g.kind === 'rules' ? 'Rules to agree to' : g.kind === 'apply' ? 'Apply to join' : 'Pick what you want to see';
  const waiting = g.status === 'submitted' || g.status === 'rejected';
  const ready = gateReady(g, agree, answers, picks);
  return (
    <Card title={title} icon="rules" class="srv-gate">
      {g.status === 'submitted' && <p>Your application is waiting for a moderator. You can read but not post until they let you in.</p>}
      {g.status === 'rejected' && <p class="about-error">Your application was turned down{g.reason ? `: ${g.reason}` : '.'}</p>}
      {!waiting && g.description && <p>{g.description}</p>}
      {!waiting && g.rules && g.rules.length > 0 && (
        <>
          <ol class="srv-rules">
            {g.rules.map((r) => (
              <li>{r}</li>
            ))}
          </ol>
          <label class="srv-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree((e.target as HTMLInputElement).checked)} /> I have read and agree to the rules
          </label>
        </>
      )}
      {!waiting &&
        (g.questions ?? []).map((q) => (
          <label class="srv-question">
            <b>
              {q.label}
              {q.required ? ' *' : ''}
            </b>
            {q.description && <small>{q.description}</small>}
            {q.kind === 'choice' ? (
              <select class="select" value={answers[q.id] === undefined ? '' : String(answers[q.id])} onChange={(e) => setAnswers({ ...answers, [q.id]: Number((e.target as HTMLSelectElement).value) })}>
                <option value="" disabled>
                  Pick one
                </option>
                {(q.choices ?? []).map((c, i) => (
                  <option value={String(i)}>{c}</option>
                ))}
              </select>
            ) : q.kind === 'paragraph' ? (
              <textarea class="about-input" rows={3} value={String(answers[q.id] ?? '')} onInput={(e) => setAnswers({ ...answers, [q.id]: (e.target as HTMLTextAreaElement).value })} />
            ) : (
              <input class="about-input" value={String(answers[q.id] ?? '')} onInput={(e) => setAnswers({ ...answers, [q.id]: (e.target as HTMLInputElement).value })} />
            )}
          </label>
        ))}
      {!waiting &&
        (g.prompts ?? []).map((p) => (
          <fieldset class="srv-prompt">
            <legend>
              {p.title}
              {p.required ? ' *' : ''}
            </legend>
            {p.options.map((o) => (
              <label class="srv-check">
                <input
                  type={p.single ? 'radio' : 'checkbox'}
                  name={`prompt-${p.id}`}
                  checked={picks.has(o.id)}
                  onChange={(e) => {
                    const next = new Set(picks);
                    if (p.single) for (const x of p.options) next.delete(x.id);
                    if ((e.target as HTMLInputElement).checked) next.add(o.id);
                    else next.delete(o.id);
                    setPicks(next);
                  }}
                />{' '}
                {o.emoji ? `${o.emoji} ` : ''}
                {o.title}
                {o.description && <small> · {o.description}</small>}
              </label>
            ))}
          </fieldset>
        ))}
      {!waiting && (
        <div class="btn-row">
          <button class="btn primary small" disabled={busy || !ready || !!view?.reason} onClick={() => void send()}>
            {busy ? 'Sending…' : g.kind === 'rules' ? 'Agree' : g.kind === 'apply' ? 'Send application' : 'Finish'}
          </button>
        </div>
      )}
      {view?.reason && <Locked s={{ value: null, canEdit: false, reason: view.reason }} />}
    </Card>
  );
}

// ---------------------------------------------------------------- nickname

/** Your nickname in a server, set or cleared through the account whose view this is. */
export function NickCard({ spaceId, view, onDone }: { spaceId: string; view: P.AboutView; onDone: (v: P.AboutView) => void }) {
  const [busy, setBusy] = useState(false);
  const n = view.nick;
  if (!n) return null;
  return (
    <Card title="Your nickname here" icon="idBadge">
      <EditableText
        setting={{ value: n.value ?? '', canEdit: n.canEdit && !view.stale, ...(n.reason ? { reason: n.reason } : {}) }}
        fallback=""
        label="Nickname"
        busy={busy}
        max={n.max}
        onSave={async (v) => {
          setBusy(true);
          try {
            onDone(await api<P.AboutView>(`/api/spaces/${spaceId}/nick`, { body: { nick: v, ...(view.accountId ? { accountId: view.accountId } : {}) } }));
            toast({ kind: 'info', title: v ? 'Nickname set' : 'Nickname cleared', body: '' }, 2500);
            return true;
          } catch (e) {
            toast({ kind: 'error', title: 'Could not change your nickname', body: (e as Error).message });
            return false;
          } finally {
            setBusy(false);
          }
        }}
      />
      {!n.value && <p class="pf-hint">None: people see your own name.</p>}
    </Card>
  );
}

// ---------------------------------------------------------------- invite links

/** A server's invite links: the expiry and use limit picked before one is made (Discord's defaults shown), each link with its uses, and turning one off. */
export function InviteLinks({ inv, busy, onChange }: { inv: P.AboutInvite; busy: boolean; onChange: (c: Extract<P.AboutChange, { key: 'invite' }>, what: string) => void }) {
  const o = inv.options!;
  const [maxAge, setMaxAge] = useState(o.defaults.maxAge);
  const [maxUses, setMaxUses] = useState(o.defaults.maxUses);
  const [qr, setQr] = useState<string | null>(null);
  const links = inv.links ?? [];
  const copyLink = (url: string) => {
    navigator.clipboard?.writeText(url);
    toast({ kind: 'info', title: 'Link copied', body: '' }, 1500);
  };
  return (
    <section class="about-section about-invite srv-invites">
      <h3>Invite links</h3>
      {inv.vanity && (
        <p class="srv-vanity">
          <button class="native-id about-link" title="Copy" onClick={() => copyLink(inv.vanity!)}>
            <code>{inv.vanity}</code>
            <Icon name="copy" size={12} />
          </button>
          <small class="pf-hint">The server's own address: it never runs out.</small>
        </p>
      )}
      {links.map((l) => (
        <div class="srv-link">
          <div class="about-invite-link">
            <button class="native-id about-link" title="Copy" onClick={() => copyLink(l.url)}>
              <code>{l.url}</code>
              <Icon name="copy" size={12} />
            </button>
            <button class="btn ghost small about-qr" aria-expanded={qr === l.code} onClick={() => setQr(qr === l.code ? null : l.code)}>
              <Icon name="qr" size={13} />
            </button>
            {l.canRevoke && (
              <button class="btn ghost small danger" disabled={busy} onClick={() => confirm('Turn this link off? Nobody can join with it any more.') && onChange({ key: 'invite', op: 'revoke', code: l.code }, 'Invite link turned off')}>
                <Icon name="unlink" size={13} /> Turn off
              </button>
            )}
          </div>
          <small class="pf-hint">
            {l.uses ?? 0} use{l.uses === 1 ? '' : 's'}
            {l.maxUses ? ` of ${l.maxUses}` : ''} · {l.expiresAt ? `runs out ${fullTime(l.expiresAt)}` : 'never runs out'}
            {l.temporary ? ' · temporary membership' : ''}
          </small>
          {qr === l.code && <QrImage text={l.url} label="The invite link as a QR code" />}
        </div>
      ))}
      {!links.length && !inv.vanity && <p class="det-note">{inv.canCreate ? 'No links you can see yet.' : 'No link you can see.'}</p>}
      {inv.canCreate && (
        <div class="srv-new-link">
          <label>
            <small>Expire after</small>
            <select class="select" value={String(maxAge)} onChange={(e) => setMaxAge(Number((e.target as HTMLSelectElement).value))}>
              {o.maxAge.map((s) => (
                <option value={String(s)}>{inviteAgeLabel(s)}</option>
              ))}
            </select>
          </label>
          <label>
            <small>Max uses</small>
            <select class="select" value={String(maxUses)} onChange={(e) => setMaxUses(Number((e.target as HTMLSelectElement).value))}>
              {o.maxUses.map((n) => (
                <option value={String(n)}>{inviteUsesLabel(n)}</option>
              ))}
            </select>
          </label>
          <button class="btn ghost small" disabled={busy} onClick={() => onChange({ key: 'invite', op: 'create', maxAge, maxUses }, 'New invite link made')}>
            <Icon name="link" size={13} /> Make a link
          </button>
        </div>
      )}
      {inv.reason && !inv.canCreate && (
        <small class="about-reason">
          <Icon name="lock" size={11} /> {inv.reason}
        </small>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- leaving

/** Leave a server or conversation, after a confirm that says what happens; where you may not, why not. */
export async function leavePlace(kind: 'space' | 'conversation', id: string, name: string, view: P.AboutView) {
  const l = view.leaving;
  if (!l) return;
  if (!l.can) {
    toast({ kind: 'error', title: `You cannot leave ${name}`, body: l.reason ?? '' });
    return;
  }
  if (!confirm(`Leave ${name}?${l.warning ? `\n\n${l.warning}` : ''}\n\nYou stop getting its messages, and need an invite to come back.`)) return;
  try {
    await api<P.LeaveResult>(`/api/${kind === 'space' ? 'spaces' : 'conversations'}/${id}/leave`, { body: { ...(view.accountId ? { accountId: view.accountId } : {}) } });
    toast({ kind: 'info', title: `You left ${name}`, body: '' }, 3000);
    go({ view: 'inbox' });
  } catch (e) {
    toast({ kind: 'error', title: `Could not leave ${name}`, body: (e as Error).message });
  }
}

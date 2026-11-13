/**
 * The composer's side of sending mail (docs/mail.md): what it opens with, drafts, sending, Undo, and the hub's outbox.
 *
 * Drafts are kept on the hub (2 s after you stop typing) and on this device at once, so a draft written without the
 * hub, or cut off by a reload, is still there; opening takes the newer of the two. A send carries a `clientId`, so one
 * retried after a lost answer goes once. Without the hub, a send waits in the composer and goes when the hub is back;
 * the draft stays on this device meanwhile, so closing the composer loses nothing.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { api, db } from '../state.ts';
import { mailChanged } from '../versions.ts';

/** How long after the last change a draft goes to the hub. */
export const SAVE_AFTER_MS = 2000;
const LOCAL = 'dither-chat:mail-draft:';

export const emptyDraft = (accountId: string, kind: P.MailComposeKind = 'new'): P.MailDraft => ({ accountId, kind, replyTo: null, from: null, to: [], cc: [], bcc: [], subject: '', text: '', quote: true, files: [], forwardParts: [] });

/** Nothing written: closing it keeps no draft. */
export const isBlank = (d: P.MailDraft) => !d.to.length && !d.cc.length && !d.bcc.length && !d.subject.trim() && !d.text.trim() && !d.files.length && d.kind === 'new';

/** The page's time zone, for the quote's date. */
export const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

// ------------------------------------------------------------------ this device's copy

interface Local {
  draft: P.MailDraft;
  at: number;
}

function readLocal(key: string): Local | null {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL + key) ?? 'null');
    return v && v.draft && typeof v.at === 'number' ? v : null;
  } catch {
    return null;
  }
}
function writeLocal(key: string, draft: P.MailDraft) {
  try {
    localStorage.setItem(LOCAL + key, JSON.stringify({ draft, at: Date.now() }));
  } catch {}
}
export function dropLocal(key: string) {
  try {
    localStorage.removeItem(LOCAL + key);
  } catch {}
}

/** Drafts kept only on this device (the hub never had them): listed with the hub's. */
function localDrafts(): P.MailDraftView[] {
  const out: P.MailDraftView[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(LOCAL)) continue;
      const v = readLocal(k.slice(LOCAL.length));
      if (v) out.push({ key: k.slice(LOCAL.length), draft: v.draft, updatedAt: v.at });
    }
  } catch {}
  return out;
}

// ------------------------------------------------------------------ opening

export interface Opened {
  key: string;
  draft: P.MailDraft;
  start: P.MailComposeStart | null;
  /** It is a draft you left, not a fresh reply. */
  resumed: boolean;
}

/** The hub's draft and this device's: the newer. */
async function storedDraft(key: string): Promise<{ draft: P.MailDraft; at: number } | null> {
  const local = readLocal(key);
  const hub = await api<{ drafts: P.MailDraftView[] }>(`/api/mail/drafts?key=${encodeURIComponent(key)}`).then(
    (r) => r.drafts[0] ?? null,
    () => null,
  );
  if (hub && (!local || hub.updatedAt >= local.at)) return { draft: hub.draft, at: hub.updatedAt };
  return local ? { draft: local.draft, at: local.at } : null;
}

/**
 * What the composer opens with. A thread with a draft opens that draft (as a mail app does), whichever button was
 * pressed; otherwise the hub fills in the reply or forward.
 */
export async function openDraft(o: { kind: P.MailComposeKind; messageId?: string; threadId?: string; accountId?: string; draftKey?: string; draft?: P.MailDraft }): Promise<Opened> {
  const key = o.draftKey ?? (o.threadId && o.kind !== 'new' ? `t:${o.threadId}` : null);
  if (o.draft && key) return { key, draft: o.draft, start: await startFor(o.draft).catch(() => null), resumed: true };
  if (key) {
    const had = await storedDraft(key);
    if (had) return { key, draft: had.draft, start: await startFor(had.draft).catch(() => null), resumed: true };
  }
  const q = new URLSearchParams({ kind: o.kind, ...(o.messageId ? { message: o.messageId } : {}), ...(o.accountId ? { account: o.accountId } : {}), ...(timeZone() ? { tz: timeZone()! } : {}) });
  const start = await api<P.MailComposeStart>(`/api/mail/compose?${q}`);
  return { key: start.draftKey, draft: start.draft, start, resumed: false };
}

/** A draft's choices and quote, from the message it answers. */
function startFor(d: P.MailDraft): Promise<P.MailComposeStart> {
  const q = new URLSearchParams({ kind: d.kind, ...(d.replyTo ? { message: d.replyTo } : { account: d.accountId }), ...(timeZone() ? { tz: timeZone()! } : {}) });
  return api<P.MailComposeStart>(`/api/mail/compose?${q}`);
}

// ------------------------------------------------------------------ saving

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const waiting = new Map<string, P.MailDraft>();
/** Each draft: saved on the hub, or kept on this device only for now. */
export const draftState = signal<Record<string, 'saved' | 'local' | 'saving'>>({});
const setState = (key: string, s: 'saved' | 'local' | 'saving' | null) => {
  const next = { ...draftState.value };
  if (s) next[key] = s;
  else delete next[key];
  draftState.value = next;
};

/** Kept here now, and on the hub once you stop for SAVE_AFTER_MS. */
export function saveDraft(key: string, d: P.MailDraft) {
  writeLocal(key, d);
  waiting.set(key, d);
  if (draftState.value[key] !== 'local') setState(key, 'saving');
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => void flushDraft(key), SAVE_AFTER_MS));
}

/** Saves now what waits for `key`. */
export async function flushDraft(key: string): Promise<void> {
  clearTimeout(timers.get(key));
  timers.delete(key);
  const d = waiting.get(key);
  if (!d) return;
  waiting.delete(key);
  try {
    await api(`/api/mail/drafts/${encodeURIComponent(key)}`, { method: 'PUT', body: d });
    // The hub has it: this device's copy is only needed until then (unless it changed meanwhile).
    if (!waiting.has(key)) dropLocal(key);
    setState(key, 'saved');
  } catch {
    setState(key, 'local');
  }
  void loadDrafts();
}

export async function deleteDraft(key: string) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  waiting.delete(key);
  dropLocal(key);
  setState(key, null);
  await api(`/api/mail/drafts/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {});
  void loadDrafts();
}

/** Every draft, the hub's and this device's, newest first. */
export const drafts = signal<P.MailDraftView[]>([]);
export async function loadDrafts() {
  const hub = await api<{ drafts: P.MailDraftView[] }>('/api/mail/drafts').then(
    (r) => r.drafts,
    () => null,
  );
  const all = new Map<string, P.MailDraftView>();
  for (const d of hub ?? drafts.value) all.set(d.key, d);
  for (const d of localDrafts()) if (!all.has(d.key) || all.get(d.key)!.updatedAt < d.updatedAt) all.set(d.key, d);
  drafts.value = [...all.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ------------------------------------------------------------------ sending

export type SendResult = { ok: true; item: P.MailOutboxView | null } | { ok: false; offline: boolean; error: string; status?: number };

/** One press of Send: the same clientId however often it is tried. */
export async function send(key: string, d: P.MailDraft, clientId: string): Promise<SendResult> {
  const body: P.MailSendRequest = { ...d, clientId, draftKey: key, tz: timeZone() };
  try {
    const r = await api<{ ok: true; outboxId: string; item: P.MailOutboxView | null }>('/api/mail/send', { method: 'POST', body });
    clearTimeout(timers.get(key));
    timers.delete(key);
    waiting.delete(key);
    dropLocal(key);
    setState(key, null);
    if (r.item) {
      db.mail.outbox.set(r.item.id, r.item);
      mailChanged();
    }
    void loadDrafts();
    return { ok: true, item: r.item };
  } catch (e: any) {
    if (e instanceof TypeError) return { ok: false, offline: true, error: 'Waiting for the hub: it goes when the hub is back.' };
    return { ok: false, offline: false, error: String(e?.message ?? e), status: e?.status };
  }
}

/** Undo while it is held: the draft comes back. */
export async function undoSend(id: string): Promise<{ draftKey: string; draft: P.MailDraft }> {
  const r = await api<{ draftKey: string; draft: P.MailDraft }>(`/api/mail/outbox/${encodeURIComponent(id)}`, { method: 'DELETE' });
  db.mail.outbox.delete(id);
  mailChanged();
  void loadDrafts();
  return r;
}

/** Send now, while it is held: the countdown ends and it goes. */
export async function sendNow(id: string) {
  const r = await api<{ item: P.MailOutboxView | null }>(`/api/mail/outbox/${encodeURIComponent(id)}/send`, { method: 'POST', body: {} });
  if (r.item && db.mail.outbox.has(id)) {
    db.mail.outbox.set(id, r.item);
    mailChanged();
  }
}

export function dismissSend(id: string) {
  db.mail.outbox.delete(id);
  mailChanged();
  return api(`/api/mail/outbox/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: {} }).catch(() => {});
}

/** The outbox as the hub has it now (after the page was away). */
export async function loadOutbox() {
  const r = await api<{ items: P.MailOutboxView[] }>('/api/mail/outbox').catch(() => null);
  if (!r) return;
  db.mail.outbox = new Map(r.items.map((o) => [o.id, o]));
  mailChanged();
}

/** "Try again" after the account answered 501. */
export function sendingAgain(accountId: string) {
  return api(`/api/mail/accounts/${encodeURIComponent(accountId)}/sending`, { method: 'POST', body: {} });
}

// ------------------------------------------------------------------ recipients

/** Addresses for what is typed: email identities of people you know first, then those in your mail. */
export async function findAddresses(q: string): Promise<P.MailAddressHit[]> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const people: P.MailAddressHit[] = [];
  for (const i of db.identities.values()) {
    if (i.network !== 'email') continue;
    const name = (i.personId ? db.persons.get(i.personId)?.name : null) ?? i.displayName ?? null;
    if (i.nativeId.toLowerCase().includes(needle) || name?.toLowerCase().includes(needle)) people.push({ name, email: i.nativeId, identityId: i.id, personId: i.personId ?? undefined, wroteTo: true, count: 0 });
  }
  const hub = await api<{ addresses: P.MailAddressHit[] }>(`/api/mail/addresses?q=${encodeURIComponent(q)}`).then(
    (r) => r.addresses,
    () => [],
  );
  const seen = new Set<string>();
  return [...people, ...hub].filter((a) => !seen.has(a.email.toLowerCase()) && !!seen.add(a.email.toLowerCase())).slice(0, 8);
}

/** Sending works from this account now: not read-only, not turned off. */
export function canSendFrom(a: P.MailAccountView | undefined): boolean {
  return !!a && a.level === 'write' && a.send.ok !== false;
}

/** Why it cannot, in a sentence; null when it can. */
export function cannotSend(a: P.MailAccountView | undefined): string | null {
  if (!a) return 'This account is not here any more.';
  if (a.level === null) return 'dither-chat no longer has access to this account.';
  if (a.level === 'read') return 'dither-accounts lets dither-chat read this account, not send from it.';
  if (a.send.ok === false) return `${a.address ?? a.label} can't send from here: ${a.send.why ?? 'sending is off'}. Reading, archiving and starring work.`;
  return null;
}

/**
 * Bots and apps on the page (docs/apps.md), the light part: what the hub says of interactions as they go, the forms
 * bots opened, which account can do what, and the calls to the hub. The pickers and the form dialog are a chunk of
 * their own (ui/apps/Apps.tsx); a bot's buttons and selects are drawn by the rich-message chunk (ui/rich/Rich.tsx).
 *
 * Every press, choice, command and form goes from one click or Enter of the owner's, once: nothing here sends again.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { api, db, eventHooks, toast } from './state.ts';

/** Outcomes heard, by nonce, newest last. */
export const interactions = signal<Map<string, P.InteractionView>>(new Map());
/** The last interaction sent from this page on each message, by message id: what its controls show. */
export const pressed = signal<Map<string, string>>(new Map());
/** Forms bots opened in answer, oldest first: the dialog shows the first. */
export const forms = signal<P.AppModalView[]>([]);
/** A message's Apps (its message commands), asked for from its menu. */
export const appsFor = signal<P.MessageView | null>(null);

const KEEP = 200;

function heard(v: P.InteractionView) {
  const next = new Map(interactions.value);
  next.delete(v.nonce);
  next.set(v.nonce, v);
  while (next.size > KEEP) next.delete(next.keys().next().value!);
  interactions.value = next;
}

eventHooks.add((ev) => {
  if (ev.t === 'interaction') heard(ev.interaction);
  else if (ev.t === 'appModal') {
    if (!forms.value.some((f) => f.id === ev.modal.id && f.accountId === ev.modal.accountId)) forms.value = [...forms.value, ev.modal];
  }
});

/** The account that would act in a conversation (as the composer picks it) and whether it has `cap`. */
export function accountFor(convId: string, requested?: string): P.AccountView | null {
  const conv = db.conversations.get(convId);
  const accs = (conv?.vantages ?? []).map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a);
  return accs.find((a) => a.id === requested) ?? accs.find((a) => a.status === 'online') ?? accs[0] ?? null;
}
export function can(convId: string, cap: P.Capability, requested?: string): boolean {
  const a = accountFor(convId, requested);
  return !!a && a.capabilities.includes(cap);
}
/** Whether a message's controls can be pressed from here: one of the accounts that has it can. */
export function canPress(m: P.MessageView): boolean {
  return m.seenVia.some((id) => db.accounts.get(id)?.capabilities.includes('interactComponents'));
}

/** The state of the last press on a message from this page, if any. */
export function pressState(messageId: string): P.InteractionView | null {
  const n = pressed.value.get(messageId);
  return (n && interactions.value.get(n)) || null;
}

const say = (e: unknown, what: string) => toast({ kind: 'error', title: what, body: (e as Error).message });

/** Press a button (no values) or choose in a select, once. Resolves to the nonce, or null when the hub refused. */
export async function press(m: P.MessageView, component: string, values?: string[]): Promise<string | null> {
  try {
    const r = await api<P.InteractView>(`/api/conversations/${m.conversationId}/apps/interact`, { body: { interaction: { kind: 'component', messageId: m.id, component, ...(values ? { values } : {}) } satisfies P.InteractRequestBody } });
    pressed.value = new Map(pressed.value).set(m.id, r.nonce);
    if (!interactions.value.has(r.nonce)) heard({ nonce: r.nonce, conversationId: m.conversationId, messageId: m.id, state: 'sending', ts: Date.now() });
    return r.nonce;
  } catch (e) {
    say(e, 'The bot did not get it');
    return null;
  }
}

/** Run a command (with `targetMessageId`, a message command), once. Resolves to the nonce, or throws the hub's words. */
export async function run(convId: string, body: Extract<P.InteractRequestBody, { kind: 'command' }>, accountId?: string): Promise<string> {
  const r = await api<P.InteractView>(`/api/conversations/${convId}/apps/interact`, { body: { interaction: body, ...(accountId ? { accountId } : {}) } });
  if (!interactions.value.has(r.nonce)) heard({ nonce: r.nonce, conversationId: convId, state: 'sending', ts: Date.now() });
  return r.nonce;
}

/** Send a form's answers, once; it is gone from the page's list whatever the hub says (a form sends once). */
export async function sendForm(f: P.AppModalView, values: P.ModalValue[]): Promise<string> {
  const r = await api<P.InteractView>(`/api/conversations/${f.conversationId}/apps/interact`, { body: { interaction: { kind: 'modal', modal: f.id, values }, accountId: f.accountId } });
  closeForm(f);
  return r.nonce;
}
export function closeForm(f: P.AppModalView) {
  forms.value = forms.value.filter((x) => !(x.id === f.id && x.accountId === f.accountId));
}

/** A conversation's commands, asked of the hub once per place and kind while the page is open (as the client keeps its index). */
const lists = new Map<string, Promise<P.AppCommandsView>>();
export function commandsOf(convId: string, kind: P.AppCommandKind, accountId?: string): Promise<P.AppCommandsView> {
  const key = `${convId}\0${kind}\0${accountId ?? ''}`;
  let p = lists.get(key);
  if (!p) {
    p = api<P.AppCommandsView>(`/api/conversations/${convId}/apps/commands?kind=${kind}${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}`);
    p.catch(() => lists.delete(key));
    lists.set(key, p);
  }
  return p;
}

/** People, roles or channels of the place, from what the hub knows. */
export function picksOf(convId: string, select: P.SelectKind | 'user' | 'role' | 'channel' | 'mentionable', q: string): Promise<P.AppPickView[]> {
  return api<{ choices: P.AppPickView[] }>(`/api/conversations/${convId}/apps/choices?select=${select}&q=${encodeURIComponent(q)}`).then((r) => r.choices);
}

/** Words for an interaction's state, as a status line shows them. */
export function stateWords(v: P.InteractionView): string {
  switch (v.state) {
    case 'sending':
      return 'Sending…';
    case 'answered':
      return 'The bot answered';
    case 'modal':
      return 'The bot opened a form';
    case 'timedOut':
      return 'No answer came back';
    case 'failed':
      return v.error && v.error !== 'This interaction failed' ? `This interaction failed: ${v.error}` : 'This interaction failed';
  }
}

// ------------------------------------------------------------ the composer's slash commands

/**
 * While a command is picked in a conversation's composer, the picker claims its send: the composer asks here first,
 * and a claimed send runs the command instead of sending the text.
 */
const claims = new Map<string, () => boolean>();
export function claimSends(convId: string, fn: (() => boolean) | null) {
  if (fn) claims.set(convId, fn);
  else claims.delete(convId);
}
/** The composer's send: true when a picked command took it. */
export function claimSend(convId: string): boolean {
  return claims.get(convId)?.() ?? false;
}

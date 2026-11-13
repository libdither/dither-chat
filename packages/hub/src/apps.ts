/**
 * Bots and apps (docs/apps.md): pressing a bot's buttons and choosing in its selects, its slash commands and apps'
 * message commands, and the forms (modals) a bot opens in answer. Each write is one click on the hub's own page and
 * goes out once: checked here against what the hub has (the message and its controls as stored, the commands the
 * adapter last listed, the form as the bot opened it), then sent through the account's adapter. Nothing here retries,
 * and nothing presses or runs anything that is not a click of the owner's: a bot's controls and texts are untrusted,
 * shown and never followed.
 *
 * Outcomes and forms come back as adapter events (`interaction`, `appModal`) and go to the page as they come; the hub
 * keeps only the forms still open, in memory, to check an answer against.
 */
import type * as P from '@dither-chat/protocol';
import { commandProblem, MODAL_TEXT_MAX, MODAL_TTL_MS, modalProblem, NETWORK_META } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { StoredExtra } from './rich.ts';
import type { AccountRow, Store } from './store.ts';

type Row = Record<string, any>;

type Cmd =
  | { t: 'appCommands'; conversation: string; kind?: P.AppCommandKind }
  | { t: 'appAutocomplete'; conversation: string; command: string; app: string; options: P.AppOptionValue[]; focused: string; query: string }
  | { t: 'interact'; conversation: string; interaction: P.InteractRequest };

export interface AppsDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: Cmd, timeoutMs?: number) => Promise<T>;
  /** Which account speaks for a conversation, honouring a request. */
  pickAccount: (conversationId: string, requested?: string) => string | null;
  note?: (accountId: string, line: string) => void;
  now?: () => number;
}

export class AppsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A command list is asked of the adapter again after this long (its client keeps its own index anyway). */
const COMMANDS_FRESH_MS = 10 * 60_000;
const QUERY_MAX = 100;
const PICKS_MAX = 25;

// ---------------------------------------------------------------- forms, as the adapters say them

interface OpenForm {
  accountId: string;
  network: P.Network;
  fact: P.AppModalFact;
  at: number;
}
const forms = new WeakMap<Store, Map<string, OpenForm>>();
function formsOf(store: Store): Map<string, OpenForm> {
  let m = forms.get(store);
  if (!m) forms.set(store, (m = new Map()));
  return m;
}
const formKey = (accountId: string, id: string) => `${accountId}\0${id}`;

const str = (x: unknown, max = 300): string | undefined => (typeof x === 'string' && x ? x.slice(0, max) : undefined);
const int = (x: unknown): number | undefined => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 10_000 ? x : undefined);
const SELECT_KINDS = new Set(['string', 'user', 'role', 'mentionable', 'channel']);

function cleanOptions(list: unknown): P.SelectOptionFact[] {
  if (!Array.isArray(list)) return [];
  const out: P.SelectOptionFact[] = [];
  for (const o of list.slice(0, 25)) {
    if (!o || typeof o !== 'object' || typeof o.value !== 'string') continue;
    out.push({ label: str(o.label, 100) ?? o.value, value: o.value.slice(0, 100), ...(str(o.description, 100) ? { description: str(o.description, 100) } : {}), ...(o.default === true ? { default: true } : {}) });
  }
  return out;
}

/** A form's fields as the hub keeps and shows them: known kinds, bounded strings; anything else is dropped. */
export function cleanFields(list: unknown): P.ModalFieldFact[] {
  if (!Array.isArray(list)) return [];
  const out: P.ModalFieldFact[] = [];
  for (const f of list.slice(0, 25)) {
    if (!f || typeof f !== 'object') continue;
    const base = { ...(str(f.label, 100) ? { label: str(f.label, 100) } : {}), ...(str(f.description, 300) ? { description: str(f.description, 300) } : {}) };
    const id = str(f.id, 100);
    const required = f.required === true ? { required: true as const } : {};
    switch (f.kind) {
      case 'display':
        if (str(f.text, 4000)) out.push({ kind: 'display', text: str(f.text, 4000)! });
        break;
      case 'text':
        if (id) out.push({ kind: 'text', id, ...base, style: f.style === 'paragraph' ? 'paragraph' : 'short', ...(str(f.placeholder, 100) ? { placeholder: str(f.placeholder, 100) } : {}), ...(str(f.value, MODAL_TEXT_MAX) ? { value: str(f.value, MODAL_TEXT_MAX) } : {}), ...required, ...(int(f.minLength) !== undefined ? { minLength: int(f.minLength) } : {}), ...(int(f.maxLength) !== undefined ? { maxLength: int(f.maxLength) } : {}) });
        break;
      case 'select':
        if (id && SELECT_KINDS.has(f.select)) out.push({ kind: 'select', id, ...base, select: f.select, ...(f.select === 'string' ? { options: cleanOptions(f.options) } : {}), ...(str(f.placeholder, 150) ? { placeholder: str(f.placeholder, 150) } : {}), ...(int(f.min) !== undefined ? { min: int(f.min) } : {}), ...(int(f.max) !== undefined ? { max: int(f.max) } : {}), ...required });
        break;
      case 'radio':
        if (id) out.push({ kind: 'radio', id, ...base, options: cleanOptions(f.options), ...required });
        break;
      case 'checkboxes':
        if (id) out.push({ kind: 'checkboxes', id, ...base, options: cleanOptions(f.options), ...(int(f.min) !== undefined ? { min: int(f.min) } : {}), ...(int(f.max) !== undefined ? { max: int(f.max) } : {}), ...required });
        break;
      case 'checkbox':
        if (id) out.push({ kind: 'checkbox', id, ...base, ...(f.default === true ? { default: true as const } : {}) });
        break;
      case 'file':
        if (id) out.push({ kind: 'file', id, ...base, ...required });
        break;
    }
  }
  return out;
}

function appView(network: P.Network, a: P.AppFact | undefined): P.AppView {
  return { id: String(a?.id ?? ''), name: str(a?.name, 100) ?? 'An app', ...(a?.icon && /^https:\/\//.test(a.icon) ? { icon: a.icon } : {}), ...(a?.bot ? { identityId: hubId('idn', network, a.bot) } : {}) };
}

function formView(f: OpenForm): P.AppModalView {
  return { id: f.fact.id, nonce: f.fact.nonce, conversationId: hubId('cnv', f.network, f.fact.conversation), accountId: f.accountId, network: f.network, app: appView(f.network, f.fact.app), title: f.fact.title, fields: f.fact.fields, at: f.at };
}

/** An adapter's interaction and appModal events (store.ts ingest): to the page as they come, open forms kept. */
export function ingestApps(store: Store, acc: AccountRow, ev: P.InteractEvent, now = Date.now()) {
  if (ev.t === 'interaction') {
    const o = ev.outcome;
    if (!o || typeof o.nonce !== 'string' || typeof o.conversation !== 'string' || !['sending', 'answered', 'failed', 'timedOut', 'modal'].includes(o.state)) return;
    store.dirty.extra.push({
      t: 'interaction',
      interaction: { nonce: o.nonce, conversationId: hubId('cnv', acc.network, o.conversation), ...(typeof o.message === 'string' ? { messageId: hubId('msg', acc.network, o.message) } : {}), state: o.state, ...(str(o.error) ? { error: str(o.error) } : {}), ts: now },
    });
    return;
  }
  const m = ev.modal;
  if (!m || typeof m.id !== 'string' || typeof m.nonce !== 'string' || typeof m.conversation !== 'string') return;
  const fact: P.AppModalFact = { id: m.id, nonce: m.nonce, conversation: m.conversation, app: { id: String(m.app?.id ?? ''), name: str(m.app?.name, 100) ?? 'An app', ...(m.app?.icon ? { icon: m.app.icon } : {}), ...(m.app?.bot ? { bot: String(m.app.bot) } : {}) }, title: str(m.title, 100) ?? 'A form', fields: cleanFields(m.fields) };
  const open = formsOf(store);
  for (const [k, f] of open) if (now - f.at > MODAL_TTL_MS) open.delete(k);
  const f: OpenForm = { accountId: acc.id, network: acc.network, fact, at: now };
  open.set(formKey(acc.id, m.id), f);
  store.dirty.extra.push({ t: 'appModal', modal: formView(f) });
}

// ---------------------------------------------------------------- the hub's side

const CAP_WORDS: Record<string, string> = { interactComponents: 'Pressing buttons', interactCommands: 'Slash commands', interactContext: 'Apps', interactModals: 'Sending forms' };

export class Apps {
  private lists = new Map<string, { at: number; result: P.AppCommandsResult }>();
  constructor(private d: AppsDeps) {}

  private get now() {
    return this.d.now?.() ?? Date.now();
  }

  private conv(id: string): { network: P.Network; nativeId: string } {
    const c = this.d.store.nativeOf('conversation', id);
    if (!c) throw new AppsError('No such conversation', 404);
    return c;
  }

  private caps(accountId: string): P.Capability[] {
    try {
      return JSON.parse(this.d.store.account(accountId)?.capabilities ?? '[]');
    } catch {
      return [];
    }
  }

  /** The account, connected and with the capability, or an error sentence. */
  private able(accountId: string | null, network: P.Network, cap: P.Capability): AccountRow {
    const acc = accountId ? this.d.store.account(accountId) : null;
    if (!acc) throw new AppsError('None of your accounts is in this conversation', 404);
    if (!this.caps(acc.id).includes(cap)) throw new AppsError(`${CAP_WORDS[cap] ?? 'This'} isn't built for this ${NETWORK_META[network].name} account yet`, 501);
    if (!this.d.online(acc.id)) throw new AppsError(`${NETWORK_META[network].name} · ${acc.label} is not connected`, 503);
    return acc;
  }

  // ------------------------------------------------------------ commands

  /** GET /api/conversations/:id/apps/commands?kind=&account=: what this account may run here, from its adapter. */
  async commands(conversationId: string, kind: P.AppCommandKind, requested?: string | null): Promise<P.AppCommandsView> {
    const c = this.conv(conversationId);
    const accountId = this.d.pickAccount(conversationId, requested ?? undefined);
    const cap = kind === 'chat' ? 'interactCommands' : 'interactContext';
    if (kind === 'user') return { accountId, commands: [], apps: [], reason: 'User commands are not built yet: run them on the network' };
    if (!accountId || !this.caps(accountId).includes(cap)) return { accountId, commands: [], apps: [], reason: `${CAP_WORDS[cap]} isn't built for this ${NETWORK_META[c.network].name} account` };
    if (!this.d.online(accountId)) return { accountId, commands: [], apps: [], reason: `${NETWORK_META[c.network].name} · ${this.d.store.account(accountId)?.label} is not connected` };
    const r = await this.list(accountId, c, kind, true);
    return { accountId, commands: r.commands, apps: r.apps.map((a) => appView(c.network, a)) };
  }

  private async list(accountId: string, c: { network: P.Network; nativeId: string }, kind: P.AppCommandKind, fresh: boolean): Promise<P.AppCommandsResult> {
    const key = `${accountId}\0${c.nativeId}\0${kind}`;
    const kept = this.lists.get(key);
    if (kept && (!fresh || this.now - kept.at < COMMANDS_FRESH_MS)) return kept.result;
    let r: P.AppCommandsResult;
    try {
      r = await this.d.command<P.AppCommandsResult>(accountId, { t: 'appCommands', conversation: c.nativeId, kind }, 30_000);
    } catch (e) {
      throw new AppsError(`Could not ask ${NETWORK_META[c.network].name}: ${(e as Error).message}`, 502);
    }
    const result = { commands: Array.isArray(r?.commands) ? r.commands : [], apps: Array.isArray(r?.apps) ? r.apps : [] };
    this.lists.set(key, { at: this.now, result });
    if (this.lists.size > 200) this.lists.delete(this.lists.keys().next().value!);
    return result;
  }

  private async findCommand(accountId: string, c: { network: P.Network; nativeId: string }, kind: P.AppCommandKind, id: string, app: string): Promise<P.AppCommandFact> {
    const match = (r: P.AppCommandsResult) => r.commands.find((x) => x.id === id && x.app === app && x.kind === kind);
    const cmd = match(await this.list(accountId, c, kind, false)) ?? match(await this.list(accountId, c, kind, true));
    if (!cmd) throw new AppsError('That command is not offered here', 404);
    return cmd;
  }

  /** Option values from the page, in native terms: a picked person, role or channel as its native id, a typed name as it is. */
  private optionValues(network: P.Network, cmd: P.AppCommandFact, given: unknown): P.AppOptionValue[] {
    if (!Array.isArray(given) || given.length > 25) throw new AppsError('Give the options as a list', 400);
    const out: P.AppOptionValue[] = [];
    for (const g of given) {
      if (!g || typeof g !== 'object' || typeof g.name !== 'string') throw new AppsError('An option without a name', 400);
      const o = cmd.options.find((x) => x.name === g.name);
      if (!o) throw new AppsError(`/${cmd.name} has no option ${g.name}`, 400);
      const v = g.value;
      if (v === undefined || v === null || v === '') continue;
      if (o.type === 'user' || o.type === 'role' || o.type === 'channel' || o.type === 'mentionable') {
        if (typeof v !== 'string') throw new AppsError(`${o.name}: name one`, 400);
        const ref = this.refOf(network, v);
        if (ref) {
          const fits = o.type === 'mentionable' ? ref.ref !== 'channel' : ref.ref === o.type;
          if (!fits) throw new AppsError(`${o.name} takes ${o.type === 'mentionable' ? 'a person or a role' : `a ${o.type}`}`, 400);
          out.push({ name: o.name, value: ref.id, ref: ref.ref });
        } else out.push({ name: o.name, value: v.trim().slice(0, 100) });
        continue;
      }
      out.push({ name: o.name, value: v });
    }
    return out;
  }

  /** A pick's value (AppPickView) as a native id: idn_… a person, cnv_… a channel, role:… a role. */
  private refOf(network: P.Network, v: string): { ref: 'user' | 'role' | 'channel'; id: string } | null {
    if (/^idn_[\w-]+$/.test(v)) {
      const n = this.d.store.nativeOf('identity', v);
      return n && n.network === network ? { ref: 'user', id: n.nativeId } : null;
    }
    if (/^cnv_[\w-]+$/.test(v)) {
      const n = this.d.store.nativeOf('conversation', v);
      return n && n.network === network ? { ref: 'channel', id: n.nativeId } : null;
    }
    const m = v.match(/^role:(\d{1,22})$/);
    return m ? { ref: 'role', id: m[1] } : null;
  }

  /** POST /api/conversations/:id/apps/autocomplete { command, app, options, focused, query, accountId? } */
  async autocomplete(conversationId: string, b: Record<string, unknown>): Promise<P.AppAutocompleteResult> {
    const c = this.conv(conversationId);
    if (typeof b.command !== 'string' || typeof b.app !== 'string' || typeof b.focused !== 'string') throw new AppsError('Which command and option?', 400);
    const query = typeof b.query === 'string' || typeof b.query === 'number' ? String(b.query).slice(0, QUERY_MAX) : '';
    const acc = this.able(this.d.pickAccount(conversationId, typeof b.accountId === 'string' ? b.accountId : undefined), c.network, 'interactCommands');
    const cmd = await this.findCommand(acc.id, c, 'chat', b.command, b.app);
    const o = cmd.options.find((x) => x.name === b.focused);
    if (!o?.autocomplete) throw new AppsError('That option has no suggestions', 400);
    const options = this.optionValues(c.network, cmd, (Array.isArray(b.options) ? b.options : []).filter((g: any) => g?.name !== b.focused));
    try {
      const r = await this.d.command<P.AppAutocompleteResult>(acc.id, { t: 'appAutocomplete', conversation: c.nativeId, command: cmd.id, app: cmd.app, options, focused: o.name, query }, 15_000);
      const choices = (Array.isArray(r?.choices) ? r.choices : []).filter((x) => x && typeof x.name === 'string' && (typeof x.value === 'string' || typeof x.value === 'number')).slice(0, 25);
      return { choices: choices.map((x) => ({ name: x.name.slice(0, 100), value: x.value })) };
    } catch (e) {
      throw new AppsError(String((e as Error).message ?? e), 502);
    }
  }

  // ------------------------------------------------------------ picks

  /** GET /api/conversations/:id/apps/choices?select=&q=: people, roles or channels of the place, from what the hub has. */
  choices(conversationId: string, select: string, q: string): { choices: P.AppPickView[] } {
    const c = this.conv(conversationId);
    if (!['user', 'role', 'channel', 'mentionable'].includes(select)) throw new AppsError('Pick people, roles or channels', 400);
    const needle = q.trim().toLowerCase().replace(/^[@#]/, '').slice(0, 50);
    const hit = (name: string | null | undefined) => !!name && (!needle || name.toLowerCase().includes(needle));
    const db = this.d.store.db;
    const space = communityOf(this.d.store, conversationId);
    const out: P.AppPickView[] = [];
    if (select === 'user' || select === 'mentionable') {
      // People seen here: who wrote here lately, a group's members, and the server's members the hub keeps.
      const rows = db
        .query(
          `SELECT i.id, COALESCE(NULLIF(i.nickname, ''), i.display_name, i.handle) AS name FROM identity i WHERE i.network = ? AND i.id IN (
             SELECT author_id FROM (SELECT author_id FROM message WHERE conversation_id = ? AND author_id IS NOT NULL ORDER BY ts DESC LIMIT 500)
             UNION SELECT identity_id FROM participant WHERE conversation_id = ?
             UNION SELECT identity_id FROM membership WHERE space_id = ?)`,
        )
        .all(c.network, conversationId, conversationId, space ?? '') as Row[];
      for (const r of rows) if (hit(r.name)) out.push({ value: r.id, name: r.name, kind: 'user' });
    }
    if ((select === 'role' || select === 'mentionable') && space) {
      // The server's roles as its About last said, any account's.
      const a = db.query('SELECT data FROM about WHERE target_id = ? ORDER BY fetched_at DESC LIMIT 1').get(space) as Row | null;
      let roles: P.AboutRole[] = [];
      try {
        roles = a ? ((JSON.parse(a.data) as P.About).roles ?? []) : [];
      } catch {}
      for (const r of roles) if (/^\d{1,22}$/.test(String(r.id)) && hit(r.name)) out.push({ value: `role:${r.id}`, name: r.name, kind: 'role', ...(r.color ? { color: r.color } : {}) });
    }
    if (select === 'channel' && space) {
      for (const r of channelsOf(this.d.store, space)) if (hit(r.name)) out.push({ value: r.id, name: r.name, kind: 'channel' });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { choices: out.slice(0, PICKS_MAX) };
  }

  // ------------------------------------------------------------ interacting

  /** POST /api/conversations/:id/apps/interact { interaction, accountId? }: one click's interaction, checked, sent once. */
  async interact(conversationId: string, b: { interaction?: unknown; accountId?: unknown }): Promise<P.InteractView> {
    const c = this.conv(conversationId);
    const i = b.interaction as P.InteractRequestBody | undefined;
    const requested = typeof b.accountId === 'string' ? b.accountId : undefined;
    if (!i || typeof i !== 'object') throw new AppsError('What should it do?', 400);
    let acc: AccountRow;
    let interaction: P.InteractRequest;
    let line: string;
    if (i.kind === 'component') {
      const r = this.component(conversationId, c.network, i, requested);
      acc = r.acc;
      interaction = r.interaction;
      line = r.line;
    } else if (i.kind === 'command') {
      if (typeof i.command !== 'string' || typeof i.app !== 'string') throw new AppsError('Which command?', 400);
      const kind: P.AppCommandKind = i.targetMessageId ? 'message' : 'chat';
      acc = this.able(this.d.pickAccount(conversationId, requested), c.network, kind === 'chat' ? 'interactCommands' : 'interactContext');
      const cmd = await this.findCommand(acc.id, c, kind, i.command, i.app);
      const options = this.optionValues(c.network, cmd, i.options ?? []);
      const problem = commandProblem(cmd, options.map((o) => ({ name: o.name, value: o.ref ? 'x' : o.value })));
      if (problem) throw new AppsError(problem, 400);
      let target: { kind: 'message'; id: string } | undefined;
      if (i.targetMessageId) {
        const m = this.d.store.one<Row>('SELECT native_id, conversation_id, deleted FROM message WHERE id = ?', i.targetMessageId);
        if (!m || m.conversation_id !== conversationId || m.deleted) throw new AppsError('No such message here', 404);
        target = { kind: 'message', id: m.native_id };
      }
      interaction = { kind: 'command', command: cmd.id, app: cmd.app, options, ...(target ? { target } : {}) };
      line = `ran ${kind === 'chat' ? `/${cmd.name}` : `${cmd.name} on a message`}`;
    } else if (i.kind === 'modal') {
      const r = this.form(conversationId, c.network, i, requested);
      acc = r.acc;
      interaction = r.interaction;
      line = r.line;
    } else throw new AppsError('What should it do?', 400);
    let r: P.InteractResult;
    try {
      r = await this.d.command<P.InteractResult>(acc.id, { t: 'interact', conversation: c.nativeId, interaction }, 45_000);
    } catch (e) {
      throw new AppsError(String((e as Error).message ?? e), 502);
    }
    this.d.note?.(acc.id, `[app] ${line}`);
    return { nonce: String(r?.nonce ?? '') };
  }

  /** A press or a choice, against the message's controls as stored. */
  private component(conversationId: string, network: P.Network, i: Extract<P.InteractRequestBody, { kind: 'component' }>, requested?: string) {
    if (typeof i.messageId !== 'string' || typeof i.component !== 'string') throw new AppsError('Which control?', 400);
    const m = this.d.store.one<Row>('SELECT id, native_id, conversation_id, deleted, extra FROM message WHERE id = ?', i.messageId);
    if (!m || m.conversation_id !== conversationId || m.deleted) throw new AppsError('No such message here', 404);
    let x: StoredExtra = {};
    try {
      x = m.extra ? JSON.parse(m.extra) : {};
    } catch {}
    if (!x.application) throw new AppsError('This message is not from a bot', 400);
    const control = (x.components ?? []).flat().find((k) => k.id === i.component);
    if (!control) throw new AppsError('This message has no such control', 404);
    if (control.disabled) throw new AppsError('The bot turned this off', 409);
    let values: string[] | undefined;
    if (control.kind === 'button') {
      if (control.style === 'link' || control.style === 'premium') throw new AppsError('This button is not pressed from here', 400);
      if (i.values !== undefined) throw new AppsError('A button takes no values', 400);
    } else {
      if (!Array.isArray(i.values) || i.values.some((v) => typeof v !== 'string')) throw new AppsError('Choose something first', 400);
      const min = control.min ?? 1;
      const max = control.max ?? 1;
      if (i.values.length < min || i.values.length > max) throw new AppsError(min === max ? `Choose ${min}` : `Choose ${min} to ${max}`, 400);
      if (control.select === 'string') {
        const ok = new Set((control.options ?? []).map((o) => o.value));
        if (i.values.some((v) => !ok.has(v))) throw new AppsError('That is not one of its options', 400);
        values = i.values;
      } else {
        values = i.values.map((v) => {
          const ref = this.refOf(network, v);
          const fits = ref && (control.select === 'mentionable' ? ref.ref !== 'channel' : ref.ref === control.select);
          if (!ref || !fits) throw new AppsError('That is not something this select takes', 400);
          return ref.id;
        });
      }
    }
    // Through an account that has the message: an ephemeral one only its own account sees.
    const saw = (this.d.store.db.query('SELECT account_id FROM message_seen WHERE message_id = ?').all(m.id) as Row[]).map((r) => r.account_id as string);
    const usual = this.d.pickAccount(conversationId, requested);
    const pick = requested && saw.includes(requested) ? requested : usual && saw.includes(usual) ? usual : (saw.find((a) => this.d.online(a)) ?? saw[0] ?? usual);
    const acc = this.able(pick, network, 'interactComponents');
    const label = control.kind === 'button' ? (control.label ?? control.emoji ?? 'a button') : (control.placeholder ?? 'a select');
    return { acc, interaction: { kind: 'component' as const, message: m.native_id as string, component: i.component, ...(values ? { values } : {}) }, line: `${control.kind === 'button' ? 'pressed' : 'chose in'} "${String(label).slice(0, 60)}"` };
  }

  /** A form's answers, against the form as the bot opened it: once, within its time. */
  private form(conversationId: string, network: P.Network, i: Extract<P.InteractRequestBody, { kind: 'modal' }>, requested?: string) {
    if (typeof i.modal !== 'string' || !Array.isArray(i.values)) throw new AppsError('Which form, and what answers?', 400);
    const open = formsOf(this.d.store);
    let found: OpenForm | undefined;
    for (const f of open.values()) if (f.fact.id === i.modal && hubId('cnv', f.network, f.fact.conversation) === conversationId && (!requested || f.accountId === requested)) found = f;
    if (!found || this.now - found.at > MODAL_TTL_MS) throw new AppsError('This form has closed: do what opened it again', 410);
    const problem = modalProblem(found.fact.fields, i.values);
    if (problem) throw new AppsError(problem, 400);
    // User, role and channel selects answer in native ids.
    const values: P.ModalValue[] = i.values.map((v) => {
      const f = found!.fact.fields.find((x) => x.kind !== 'display' && x.id === v.field);
      if (f?.kind === 'select' && f.select !== 'string' && v.values)
        return {
          field: v.field,
          values: v.values.map((x) => {
            const ref = this.refOf(network, x);
            if (!ref) throw new AppsError(`${f.label ?? 'A field'}: pick from the list`, 400);
            return ref.id;
          }),
        };
      return { field: v.field, ...(typeof v.value === 'string' ? { value: v.value } : {}), ...(Array.isArray(v.values) ? { values: v.values } : {}), ...(typeof v.checked === 'boolean' ? { checked: v.checked } : {}) };
    });
    const acc = this.able(found.accountId, network, 'interactModals');
    // Sent once: a second submit of the same form is refused here, as the network would.
    open.delete(formKey(found.accountId, found.fact.id));
    return { acc, interaction: { kind: 'modal' as const, modal: found.fact.id, values }, line: `sent the form "${found.fact.title}"` };
  }

  /** The forms still open in a conversation, newest first (a page that missed the event). */
  openForms(conversationId: string): P.AppModalView[] {
    const now = this.now;
    return [...formsOf(this.d.store).values()].filter((f) => now - f.at <= MODAL_TTL_MS && hubId('cnv', f.network, f.fact.conversation) === conversationId).map(formView).sort((a, b) => b.at - a.at);
  }

  // ------------------------------------------------------------ routes

  static handles(path: string): boolean {
    return /^\/api\/conversations\/[\w-]+\/apps\/(commands|autocomplete|choices|interact|forms)$/.test(path);
  }

  async route(req: Request, url: URL, path: string, flush?: () => void): Promise<Response | null> {
    const m = path.match(/^\/api\/conversations\/([\w-]+)\/apps\/(commands|autocomplete|choices|interact|forms)$/);
    if (!m) return null;
    const [, id, what] = m;
    const method = req.method;
    const body = async () => (await req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      if (what === 'commands' && method === 'GET') {
        const kind = url.searchParams.get('kind') ?? 'chat';
        if (kind !== 'chat' && kind !== 'message' && kind !== 'user') throw new AppsError('kind is chat, message or user', 400);
        return Response.json(await this.commands(id, kind, url.searchParams.get('account')));
      }
      if (what === 'choices' && method === 'GET') return Response.json(this.choices(id, url.searchParams.get('select') ?? '', url.searchParams.get('q') ?? ''));
      if (what === 'forms' && method === 'GET') return Response.json({ forms: this.openForms(id) });
      // A write, and a suggestion asked for as the owner types, come from the owner on the hub's own page: a browser
      // sends Origin, and the server has refused any other site's.
      if ((what === 'interact' || what === 'autocomplete') && method === 'POST') {
        if (!req.headers.get('origin')) throw new AppsError('This is done from the app itself', 403);
        if (what === 'autocomplete') return Response.json(await this.autocomplete(id, await body()));
        const r = await this.interact(id, await body());
        flush?.();
        return Response.json(r);
      }
    } catch (e) {
      if (e instanceof AppsError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}

/** The top-level community a conversation is in (through a thread's channel and sections), or null. */
export function communityOf(store: Store, convId: string): string | null {
  let id: string | null = convId;
  for (let i = 0; i < 3 && id; i++) {
    const p: Row | null = store.db.query('SELECT parent_id FROM conversation WHERE id = ?').get(id) as Row | null;
    if (!p?.parent_id) break;
    id = p.parent_id;
  }
  let frontier = id ? (store.db.query(`SELECT parent_id FROM space_edge WHERE child_kind = 'conversation' AND child_id = ?`).all(id) as Row[]).map((r) => r.parent_id as string) : [];
  for (let depth = 0; frontier.length && depth < 6; depth++) {
    const next: string[] = [];
    for (const sid of frontier) {
      if ((store.db.query('SELECT kind FROM space WHERE id = ?').get(sid) as Row | null)?.kind === 'community') return sid;
      next.push(...(store.db.query(`SELECT parent_id FROM space_edge WHERE child_kind = 'space' AND child_id = ?`).all(sid) as Row[]).map((r) => r.parent_id as string));
    }
    frontier = next;
  }
  return null;
}

/** A community's channels (directly or in its sections), threads left out. */
function channelsOf(store: Store, space: string): { id: string; name: string }[] {
  const sections = [space, ...(store.db.query(`SELECT child_id FROM space_edge WHERE parent_id = ? AND child_kind = 'space'`).all(space) as Row[]).map((r) => r.child_id as string)];
  const ph = sections.map(() => '?').join(',');
  return (store.db.query(`SELECT DISTINCT c.id, c.name FROM space_edge e JOIN conversation c ON c.id = e.child_id WHERE e.child_kind = 'conversation' AND e.parent_id IN (${ph}) AND c.shape = 'channel' AND c.name IS NOT NULL`).all(...sections) as Row[]).map((r) => ({ id: r.id, name: r.name }));
}

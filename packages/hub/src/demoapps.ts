/**
 * The demo world's bot (docs/apps.md): a message with buttons and selects, slash commands with options, suggestions
 * and subcommands, a message command, and a form, answered the way the Discord adapter answers (dither-accounts
 * extractors/discord/src/interact.ts): an `interaction` event as it goes, the bot's reply as a message, a form as an
 * `appModal`. demo.ts hands each Discord account's appCommands, appAutocomplete and interact here.
 */
import type * as P from '@dither-chat/protocol';

export interface DemoAppsHost {
  key: string;
  selfId: string;
  emit: (ev: P.AdapterEvent) => void;
  later: (ms: number, fn: () => void) => void;
  /** A snowflake-like id for a key. */
  snow: (k: string) => string;
  /** The channel the bot posts its controls in, for this account; null where it has none. */
  botChannel: string | null;
  /** Whether this account is in a conversation the bot can be used in (Discord channels and DMs). */
  inConversation: (conversation: string) => boolean;
}

export const DEMO_APP_CAPS: P.Capability[] = ['interactComponents', 'interactCommands', 'interactContext', 'interactModals'];

const WHEN = ['in 10 minutes', 'in an hour', 'tonight at 8', 'tomorrow at 9', 'next Monday'];
const ROLES: P.SelectOptionFact[] = [
  { label: 'Rust', value: 'rust', description: 'Talk about the language' },
  { label: 'Routing', value: 'routing', description: 'The coordinate routing work' },
  { label: 'Off-topic', value: 'offtopic' },
];

export class DemoApps {
  readonly bot: P.IdentityFact;
  readonly app: P.AppFact;
  private seq = 0;
  /** Forms opened, by id: the custom id they answer. */
  private forms = new Map<string, string>();

  constructor(private h: DemoAppsHost) {
    this.bot = { nativeId: h.snow('bot-helper'), handle: 'helper', displayName: 'Helper', isBot: true };
    this.app = { id: h.snow('app-helper'), name: 'Helper', bot: this.bot.nativeId };
  }

  /** The bot, and its message with controls where this account has the bot's channel. */
  announce(epoch: number) {
    this.h.emit({ t: 'identity', identity: this.bot });
    const c = this.h.botChannel;
    if (!c) return;
    const rows: P.ComponentRow[] = [
      [
        { kind: 'button', id: 'helper:roll', label: 'Roll a die', emoji: '🎲', style: 'primary' },
        { kind: 'button', id: 'helper:ticket', label: 'Open a ticket', style: 'success' },
        { kind: 'button', id: 'helper:broken', label: 'Broken button', style: 'danger' },
        { kind: 'button', label: 'Docs', style: 'link', url: 'https://example.com/helper' },
      ],
      [{ kind: 'select', id: 'helper:roles', select: 'string', placeholder: 'Pick your roles', options: ROLES, min: 0, max: 3 }],
      [{ kind: 'select', id: 'helper:thank', select: 'user', placeholder: 'Thank someone', min: 1, max: 1 }],
    ];
    this.h.emit({
      t: 'message',
      live: false,
      message: { nativeId: `${c}~helper-menu`, conversation: c, author: this.bot.nativeId, ts: epoch - 3 * 3_600_000, body: '**Helper** is here. Press a button, pick roles, or type `/` for my commands.', extra: { components: rows, application: this.app.id } },
    });
  }

  commands(kind: P.AppCommandKind): P.AppCommandsResult {
    const list: P.AppCommandFact[] =
      kind === 'message'
        ? [
            { id: this.h.snow('cmd-quote'), name: 'Quote this', app: this.app.id, kind: 'message', options: [] },
            { id: this.h.snow('cmd-count'), name: 'Count words', app: this.app.id, kind: 'message', options: [] },
          ]
        : kind === 'chat'
          ? [
              { id: this.h.snow('cmd-roll'), name: 'roll', description: 'Roll a die', app: this.app.id, kind: 'chat', options: [{ name: 'sides', type: 'integer', description: 'How many sides', min: 2, max: 100 }] },
              {
                id: `${this.h.snow('cmd-remind')}\0me`,
                name: 'remind me',
                description: 'Remind you of something',
                app: this.app.id,
                kind: 'chat',
                options: [
                  { name: 'when', type: 'string', description: 'When', required: true, autocomplete: true },
                  { name: 'what', type: 'string', description: 'What about', required: true, maxLength: 200 },
                ],
              },
              { id: this.h.snow('cmd-ticket'), name: 'ticket', description: 'Open a support ticket', app: this.app.id, kind: 'chat', options: [] },
              { id: this.h.snow('cmd-thank'), name: 'thank', description: 'Thank someone', app: this.app.id, kind: 'chat', options: [{ name: 'who', type: 'user', description: 'Who', required: true }, { name: 'loud', type: 'boolean', description: 'Say it to everyone' }] },
              { id: this.h.snow('cmd-size'), name: 'size', description: 'Pick a size', app: this.app.id, kind: 'chat', options: [{ name: 'size', type: 'string', required: true, choices: [{ name: 'Small', value: 's' }, { name: 'Large', value: 'l' }] }] },
            ]
          : [];
    return { commands: list, apps: [this.app] };
  }

  autocomplete(cmd: Extract<P.AdapterCommand, { t: 'appAutocomplete' }>): P.AppAutocompleteResult {
    if (cmd.focused !== 'when') throw new Error('This option has no suggestions');
    const q = cmd.query.toLowerCase();
    return { choices: WHEN.filter((w) => w.includes(q)).map((w) => ({ name: w, value: w })) };
  }

  /** One interaction: its nonce at once, its outcome and the bot's answer a moment later. */
  interact(cmd: Extract<P.AdapterCommand, { t: 'interact' }>): P.InteractResult {
    if (!this.h.inConversation(cmd.conversation)) throw new Error('Discord does not have this channel');
    const nonce = this.h.snow(`nonce-${this.h.key}-${++this.seq}-${Date.now()}`);
    const i = cmd.interaction;
    const conv = cmd.conversation;
    const message = i.kind === 'component' ? i.message : undefined;
    const outcome = (state: P.InteractionState, error?: string) => this.h.emit({ t: 'interaction', outcome: { nonce, conversation: conv, ...(message ? { message } : {}), state, ...(error ? { error } : {}) } });
    outcome('sending');
    const answer = (body: string, opts: { ephemeral?: boolean; interaction?: P.InteractionFact } = {}) =>
      this.h.later(600, () => {
        outcome('answered');
        this.h.emit({
          t: 'message',
          live: true,
          message: { nativeId: `${conv}~helper-${nonce}`, conversation: conv, author: this.bot.nativeId, ts: Date.now(), body, extra: { application: this.app.id, ...(opts.ephemeral ? { marks: { ephemeral: true } } : {}), ...(opts.interaction ? { interaction: opts.interaction } : {}) } },
        });
      });
    const by = (kind: P.InteractionFact['kind'], name?: string): P.InteractionFact => ({ kind, user: this.h.selfId, ...(name ? { name } : {}) });
    const form = (customId: string, title: string, fields: P.ModalFieldFact[]) =>
      this.h.later(400, () => {
        const id = this.h.snow(`form-${nonce}`);
        this.forms.set(id, customId);
        outcome('modal');
        this.h.emit({ t: 'appModal', modal: { id, nonce, conversation: conv, app: this.app, title, fields } });
      });
    const ticketFields: P.ModalFieldFact[] = [
      { kind: 'display', text: 'Tell us what went wrong. A person will answer in this channel.' },
      { kind: 'text', id: 'subject', label: 'Subject', style: 'short', required: true, maxLength: 80, placeholder: 'One line' },
      { kind: 'text', id: 'details', label: 'Details', style: 'paragraph', maxLength: 1000 },
      { kind: 'select', id: 'area', label: 'Area', select: 'string', options: ROLES, min: 1, max: 1, required: true },
      { kind: 'checkbox', id: 'urgent', label: 'It is urgent' },
    ];
    switch (i.kind) {
      case 'component':
        if (i.component === 'helper:roll') answer(`🎲 You rolled a **${1 + Math.floor(Math.random() * 6)}**.`, { interaction: by('component') });
        else if (i.component === 'helper:ticket') form('helper:ticket', 'Open a ticket', ticketFields);
        else if (i.component === 'helper:broken') this.h.later(800, () => outcome('failed', 'This interaction failed'));
        else if (i.component === 'helper:roles') answer(i.values?.length ? `Your roles are now: ${i.values.map((v) => ROLES.find((r) => r.value === v)?.label ?? v).join(', ')}.` : 'You have no roles from me now.', { ephemeral: true, interaction: by('component') });
        else if (i.component === 'helper:thank') answer(`Thanks sent to <@${i.values?.[0] ?? ''}>.`, { ephemeral: true, interaction: by('component') });
        else throw new Error('This message no longer has that control');
        break;
      case 'command': {
        const name = this.commands(i.target ? i.target.kind : 'chat').commands.find((c) => c.id === i.command)?.name;
        if (!name) throw new Error('This command is not offered here any more');
        const opt = (n: string) => i.options.find((o) => o.name === n)?.value;
        if (name === 'roll') answer(`🎲 You rolled a **${1 + Math.floor(Math.random() * Number(opt('sides') ?? 6))}**.`, { interaction: by('command', 'roll') });
        else if (name === 'remind me') answer(`Okay, I will remind you ${opt('when')}: ${opt('what')}`, { ephemeral: true, interaction: by('command', 'remind me') });
        else if (name === 'ticket') form('helper:ticket', 'Open a ticket', ticketFields);
        else if (name === 'thank') answer(`Thank you, <@${opt('who')}>!`, opt('loud') === true ? { interaction: by('command', 'thank') } : { ephemeral: true, interaction: by('command', 'thank') });
        else if (name === 'size') answer(`You picked ${opt('size') === 'l' ? 'Large' : 'Small'}.`, { ephemeral: true, interaction: by('command', 'size') });
        else if (name === 'Quote this') answer('> (a quote of that message)', { interaction: by('context', 'Quote this') });
        else if (name === 'Count words') answer('That message has a few words.', { ephemeral: true, interaction: by('context', 'Count words') });
        break;
      }
      case 'modal': {
        if (!this.forms.delete(i.modal)) throw new Error('This form has closed: do what opened it again');
        const v = (f: string) => i.values.find((x) => x.field === f);
        answer(`Ticket opened: **${v('subject')?.value ?? ''}**${v('urgent')?.checked ? ' (urgent)' : ''}.`, { interaction: by('modal') });
        break;
      }
    }
    return { nonce };
  }
}

/**
 * The composer's part of sending with more than words (docs/sending.md), kept out of the composer itself: the reply
 * bar's @ toggle (ping the author or not, remembered per account), the send button's menu (Send silently, Send
 * later…), the line above the box saying what waits to go out here, and the layer the lists open in. The lists and
 * the time picker are a chunk of their own (SendLists.tsx), loaded when first opened.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { canReplyQuietly, canSaveOnNetwork, canSendSilently, knowSaved, rememberReplyMentions, replyMentions, scheduled, scheduleSend, waitingIn, watchScheduled, whenWords } from '../sending.ts';
import { db } from '../state.ts';
import { Menu } from './bits.tsx';
import { Icon } from './icons.tsx';

/** What the lists' layer shows: the Send later picker, a list of what waits, or what you saved on the network. */
export type SendPanel =
  | { kind: 'later'; title: string; onPick: (dueAt: number) => void; initial?: number }
  | { kind: 'scheduled'; conversationId?: string }
  | { kind: 'saved' };
export const sendPanel = signal<SendPanel | null>(null);

type Lists = typeof import('./SendLists.tsx');
let lists: Lists | null = null;
let loading: Promise<Lists> | null = null;
const load = () =>
  (loading ??= import('./SendLists.tsx').then(
    (m) => (lists = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));

/** Mounted once beside the app's other layers (App.tsx). */
export function SendingLayer() {
  const p = sendPanel.value;
  const [m, setM] = useState(lists);
  useEffect(() => {
    if (p && !m) load().then(setM, () => {});
  }, [p]);
  if (!p || !m) return null;
  return <m.SendPanelView panel={p} onClose={() => (sendPanel.value = null)} />;
}

interface ExtrasInput {
  conv: P.ConversationView | undefined;
  sender: P.AccountView | undefined;
  reply: P.MessageView | null;
  /** The composer has something it could send now, and nothing stops it. */
  canSend: boolean;
  /** Editing a message, or the conversation cannot be written in: none of this applies. */
  blocked: boolean;
  /** What the composer holds, its files uploaded (their upload ids): for Send later. */
  draft: () => Promise<{ body: string; attachments: string[] } | null>;
  /** It was taken (scheduled): the composer empties as after a send. */
  done: () => void;
}

/** The composer's additions, and the options its send carries. */
export function useSendExtras(o: ExtrasInput) {
  const accountId = o.sender?.id;
  const [silent, setSilent] = useState(false);
  const [mention, setMention] = useState(() => replyMentions(accountId));
  useEffect(() => setMention(replyMentions(accountId)), [accountId]);
  useEffect(() => setSilent(false), [o.conv?.id]);
  useEffect(watchScheduled, []);
  // The message menu says Save or Remove from what the hub last heard: read it once, where it can mean anything.
  useEffect(() => {
    if (o.conv && (o.conv.vantages ?? []).some((v) => canSaveOnNetwork(db.accounts.get(v.accountId)))) void knowSaved();
  }, [o.conv?.id]);
  const quiet = canSendSilently(o.sender);
  const pingable = !!o.reply && canReplyQuietly(o.sender);
  const opts = { ...(silent && quiet ? { silent: true } : {}), ...(pingable && !mention ? { mentionReplied: false } : {}) };

  const toggleMention = () => {
    const next = !mention;
    setMention(next);
    rememberReplyMentions(accountId, next);
  };
  const replyToggle = pingable ? (
    <button
      class={`reply-mention ${mention ? 'on' : ''}`}
      data-track="reply ping"
      aria-pressed={mention}
      title={mention ? 'They are pinged: click to reply without pinging' : 'They are not pinged: click to ping them'}
      onClick={toggleMention}
    >
      <Icon name="at" size={12} />
      {mention ? 'On' : 'Off'}
    </button>
  ) : null;

  const later = async () => {
    const conv = o.conv;
    if (!conv || !o.sender) return;
    sendPanel.value = {
      kind: 'later',
      title: 'Send later',
      onPick: async (dueAt) => {
        const d = await o.draft();
        if (!d) return;
        const v = await scheduleSend({
          conversationId: conv.id,
          accountId: o.sender!.id,
          body: d.body,
          ...(d.attachments.length ? { attachments: d.attachments } : {}),
          ...(o.reply ? { replyTo: o.reply.id } : {}),
          ...opts,
          dueAt,
        });
        if (v) {
          setSilent(false);
          o.done();
        }
      },
    };
  };

  const button = o.conv && !o.blocked && (
    <Menu
      up
      align="right"
      trigger={(toggle) => (
        <button class={`icon-btn send-more ${silent ? 'on' : ''}`} data-track="send options" onClick={toggle} title={silent ? 'Sends silently' : 'More ways to send'} aria-label="More ways to send">
          <Icon name={silent ? 'bellOff' : 'chevronUp'} size={14} />
        </button>
      )}
    >
      {(close) => (
        <div class="level-menu">
          {quiet && (
            <button
              class={`menu-item ${silent ? 'on' : ''}`}
              data-track="send silently"
              onClick={() => {
                setSilent(!silent);
                close();
              }}
            >
              <Icon name="bellOff" size={14} /> {silent ? 'Silently: on (nobody is notified)' : 'Send silently'}
            </button>
          )}
          <button
            class="menu-item"
            data-track="send later"
            disabled={!o.canSend}
            title={o.canSend ? undefined : 'Write something first'}
            onClick={() => {
              close();
              void later();
            }}
          >
            <Icon name="clock" size={14} /> Send later…
          </button>
        </div>
      )}
    </Menu>
  );

  return {
    /** Goes with the send (state.ts send). */
    opts,
    /** A message went: silent is for one message, as Discord's @silent is. */
    sent: () => setSilent(false),
    replyToggle,
    button,
  };
}

/** One line above the box: what waits to go out here, and when the first does. */
export function ScheduledStrip({ conversationId }: { conversationId: string }) {
  const here = waitingIn(scheduled.value, conversationId);
  if (!here.length) return null;
  const first = here[0];
  const trouble = here.find((x) => x.state === 'held' || x.state === 'failed');
  return (
    <button class={`scheduled-strip ${trouble ? 'trouble' : ''}`} data-track="scheduled here" onClick={() => (sendPanel.value = { kind: 'scheduled', conversationId })}>
      <Icon name="clock" size={13} />
      {trouble ? (trouble.state === 'held' ? 'A message waits for you to send it or cancel it' : 'A message to send later failed') : here.length === 1 ? `1 message goes out ${whenWords(first.dueAt, Date.now())}` : `${here.length} messages to send later, the first ${whenWords(first.dueAt, Date.now())}`}
      <span class="scheduled-strip-view">View</span>
    </button>
  );
}

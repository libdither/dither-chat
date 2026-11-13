/**
 * Threads, forums and group DMs beyond messages (docs/threads.md): the menu entries for following a thread and how it
 * notifies, starting threads, browsing a channel's archived threads, and publishing a message; and the calls behind
 * them. Each is offered only where an account here has the capability and is connected. The bigger parts (the forum
 * view, the thread browser, the About cards) are a chunk of their own (ui/Threads.tsx).
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { MUTE_TIMERS, muteTimerLabel, THREAD_NOTIFY_LABEL } from '@dither-chat/protocol';
import { api, db, isSelfIdentity, toast } from './state.ts';
import type { MenuEntry } from './ui/ContextMenu.tsx';

/** What the threads chunk shows over the page: a channel's thread browser, or the form to start a thread or a post. */
export type ThreadDialog = { kind: 'browse'; convId: string; tab?: 'active' | 'archived' | 'mine' } | { kind: 'start'; convId: string; messageId?: string; name?: string } | { kind: 'post'; convId: string };
export const threadDialog = signal<ThreadDialog | null>(null);

/** A connected account that sees this conversation and can do this, the first of them; null when none. */
export function ableAccount(c: P.ConversationView, cap: P.Capability): string | null {
  for (const v of c.vantages) {
    const a = db.accounts.get(v.accountId);
    if (a?.status === 'online' && a.capabilities.includes(cap)) return a.id;
  }
  return null;
}

const textChannel = (c: P.ConversationView) => c.shape === 'channel' && (c.variant === 'text' || c.variant === 'announcement' || c.variant === 'rules');
const postable = (c: P.ConversationView) => c.shape === 'channel' && (c.variant === 'forum' || c.variant === 'media');

/** The mute timers a thread's card offers, Discord's own: [value for the select, label]. Here so the chunk shares them. */
export const threadMuteChoices = (): [string, string][] => MUTE_TIMERS.map((m) => [m === null ? 'forever' : String(m), `Mute: ${muteTimerLabel(m)}`]);

/** Follow or unfollow a thread, through the account that sees it. */
export async function followThread(c: P.ConversationView, follow: boolean) {
  const accountId = ableAccount(c, 'followThreads');
  try {
    await api(`/api/conversations/${c.id}/follow`, { body: { follow, ...(accountId ? { accountId } : {}) } });
    toast({ kind: 'info', title: follow ? 'Following the thread' : 'No longer following the thread', body: follow ? 'Discord tells you of its messages now.' : 'Only mentions of you reach you from it now.' }, 3000);
  } catch (e) {
    toast({ kind: 'error', title: follow ? 'Could not follow it' : 'Could not unfollow it', body: (e as Error).message });
  }
}

/** How a thread notifies you on the network, or its mute (minutes; null until turned off). */
export async function threadNotify(c: P.ConversationView, change: { notify?: P.ThreadNotify; muted?: boolean; minutes?: number | null }) {
  const accountId = ableAccount(c, 'followThreads');
  try {
    await api(`/api/conversations/${c.id}/thread-notify`, { body: { ...change, ...(change.minutes === null ? { minutes: undefined } : {}), ...(accountId ? { accountId } : {}) } });
  } catch (e) {
    toast({ kind: 'error', title: 'Could not change how the thread notifies you', body: (e as Error).message });
  }
}

/** Publish your message to the channels that follow this announcement channel, after a confirm. */
export async function publish(m: P.MessageView) {
  if (!confirm('Publish this message?\n\nIt goes out to every server that follows this channel, and cannot be taken back from there.')) return;
  try {
    await api(`/api/messages/${m.id}/crosspost`, { body: {} });
    toast({ kind: 'info', title: 'Published', body: 'It goes out to the channels that follow this one.' }, 3000);
  } catch (e) {
    toast({ kind: 'error', title: 'Could not publish it', body: (e as Error).message });
  }
}

/** A thread's or channel's thread entries for its menu: follow, how it notifies, start one, browse them. */
export function threadConvEntries(c: P.ConversationView): MenuEntry[] {
  const out: MenuEntry[] = [];
  if (c.shape === 'thread' && ableAccount(c, 'followThreads')) {
    const on = !!c.thread?.following.length;
    out.push({ label: on ? 'Unfollow Thread' : 'Follow Thread', icon: on ? 'bellOff' : 'bell', track: on ? 'unfollow thread' : 'follow thread', run: () => void followThread(c, !on) });
    if (on)
      out.push({
        label: 'Thread Notifications',
        icon: 'bell',
        sub: (['all', 'mentions', 'none'] as const).map((n): MenuEntry => ({ label: THREAD_NOTIFY_LABEL[n], radio: true, checked: c.thread?.notify === n, track: `thread notify ${n}`, run: () => void threadNotify(c, { notify: n }) })),
      });
  }
  if (textChannel(c) && ableAccount(c, 'createThreads')) out.push({ label: 'Start Thread', icon: 'thread', track: 'start thread', run: () => (threadDialog.value = { kind: 'start', convId: c.id }) });
  if (postable(c) && ableAccount(c, 'forumPosts')) out.push({ label: 'New Post', icon: 'pencil', track: 'new post', run: () => (threadDialog.value = { kind: 'post', convId: c.id }) });
  if (c.shape === 'channel' && c.variant !== 'voice' && c.variant !== 'stage' && ableAccount(c, 'listThreads'))
    out.push({ label: postable(c) ? 'Archived Posts' : 'Browse Threads', icon: 'archive', track: 'browse threads', run: () => (threadDialog.value = { kind: 'browse', convId: c.id, tab: postable(c) ? 'archived' : 'active' }) });
  return out;
}

/** A message's thread entries: start a thread from it, publish it. */
export function threadMessageEntries(m: P.MessageView): MenuEntry[] {
  const c = db.conversations.get(m.conversationId);
  if (!c || m.deleted || m.kind === 'system') return [];
  const out: MenuEntry[] = [];
  if (textChannel(c) && !m.threadId && ableAccount(c, 'createThreads')) {
    const name = m.body.replace(/\s+/g, ' ').trim().slice(0, 40);
    out.push({ label: 'Create Thread', icon: 'thread', track: 'create thread', run: () => (threadDialog.value = { kind: 'start', convId: c.id, messageId: m.id, name }) });
  }
  if (c.variant === 'announcement' && c.shape === 'channel' && isSelfIdentity(m.authorId) && !m.rich?.marks?.published && ableAccount(c, 'crosspost'))
    out.push({ label: 'Publish', icon: 'send', track: 'publish', run: () => void publish(m) });
  return out;
}

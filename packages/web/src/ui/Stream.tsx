/**
 * A channel's stream (stream.ts, docs/threads.md "The channel stream"), a chunk of its own (Timeline.tsx StreamLazy):
 * the page, its box's thread chip (TopicChip.tsx), and the place under the last message where "Next unread topic"
 * goes (StreamFoot).
 */
import type * as P from '@dither-chat/protocol';
import { threadNameProblem } from '@dither-chat/protocol';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { convLabel, convTitle, threadWords } from '../model.ts';
import { api, db, editing, openMessage, rev, timelineKey, timelineRev, timelines, toast } from '../state.ts';
import { openConv } from '../opening.ts';
import { reactionContext } from '../reactions.ts';
import { chipDefault, pickedThread, pickThread, streamConvIds, takesOwn } from '../stream.ts';
import { ableAccount } from '../threads.ts';
import { LinkBanner } from './Requests.tsx';
import { TopicChip } from './TopicChip.tsx';
import { TypingBar } from './Typing.tsx';
import './Stream.css';
import { Composer, composerBlocker, ConvHeader, firstUnread, Timeline, ViewSwitch, type StreamOpts } from './Timeline.tsx';

/**
 * Under a stream's last message, over the box: where "Next unread topic" goes (docs/threads.md). Nothing yet.
 */
export function StreamFoot(_: { c: P.ConversationView }) {
  return null;
}

/**
 * A channel's stream (stream.ts, docs/threads.md "The channel stream"): every thread's messages together by time, with
 * the channel's own where it takes any, a header where the thread changes; a click on a header opens that thread
 * alone, and back comes back here at the same place. The box sends to the thread on its chip: the one of the message
 * you last clicked or replied to, else the latest; another picked on the chip, or a new topic named there.
 */
export function StreamPane({ c, onBack, focus }: { c: P.ConversationView; onBack?: () => void; focus?: string }) {
  rev.value;
  const tkey = timelineKey('k', c.id);
  const ids = streamConvIds(c);
  const own = takesOwn(c);
  const words = threadWords(c);
  const [reply, setReply] = useState<P.MessageView | null>(null);
  const [picked, setPicked] = useState<string | null>(() => pickedThread(c.id));
  const [newName, setNewName] = useState<string | null>(null);
  const unreadAt = useMemo(() => firstUnread(ids.map((id) => db.conversations.get(id)).filter((x): x is P.ConversationView => !!x)), [c.id]);
  useEffect(() => void reactionContext(c.id), [c.id]);
  const pick = useMemo(
    () => (id: string) => {
      pickThread(c.id, id);
      setPicked(id);
      setNewName(null);
    },
    [],
  );
  const onReply = useMemo(
    () => (m: P.MessageView) => {
      setReply(m);
      pick(m.conversationId);
    },
    [],
  );
  // Until a thread is picked, the default follows what the stream holds: its newest message's (stream.ts chipDefault).
  const held = picked ? undefined : (timelineRev(tkey).value, timelines.get(tkey)?.messages);
  const threads = (db.threads.get(c.id) ?? []).map((id) => db.conversations.get(id)).filter((x): x is P.ConversationView => !!x);
  const target = newName === null ? chipDefault({ channel: c.id, own, picked, messages: held ?? [], threads }) : null;
  // Once the stream has messages, that default stays: a message coming in on another thread does not move the box
  // while you write. (Not remembered as a pick: opened again, the default is worked out again.)
  useEffect(() => {
    if (!picked && newName === null && target && held?.length) setPicked(target);
  });
  // Editing a message of another thread: the box goes there, where the edit is.
  const ed = editing.value;
  useEffect(() => {
    if (ed && ids.includes(ed.conversationId) && ed.conversationId !== target) pick(ed.conversationId);
  }, [ed?.id]);
  const opts = useMemo<StreamOpts>(
    () => ({
      channel: c.id,
      onOpen: (id) => {
        const t = db.conversations.get(id);
        if (t) openConv(t);
      },
      onPick: pick,
      // A message linked to further back than the stream pages: its thread alone, at it.
      onMissing: () => {
        if (focus)
          void api<P.MessageContext>(`/api/messages/${focus}/context`).then(
            (p) => {
              const m = p.messages.find((x) => x.id === focus);
              if (m && m.conversationId !== c.id) openMessage(m.conversationId, focus);
            },
            () => {},
          );
      },
    }),
    [focus],
  );
  const canNew = !!ableAccount(c, 'forumPosts') && !own;
  const post = async (body: string, attachments: string[]) => {
    const name = newName ?? '';
    try {
      const r = await api<P.CreatedThreadView>(`/api/conversations/${c.id}/posts`, { body: { name, body, attachments, accountId: ableAccount(c, 'forumPosts') } });
      pick(r.conversationId);
      return true;
    } catch (e) {
      toast({ kind: 'error', title: `Could not start the ${words.one}`, body: (e as Error).message });
      return false;
    }
  };
  const to = target ? db.conversations.get(target) : undefined;
  const blocked =
    newName !== null
      ? (threadNameProblem(newName) ?? (canNew ? null : `No account here can start a ${words.one}`))
      : to
        ? composerBlocker(to)
        : `Pick a ${words.one}${canNew ? ' or name a new one' : ''} on the line above`;
  const where = newName ?? (to && to.id !== c.id ? convTitle(to) : null);
  return (
    <section class="pane stream-pane">
      <ConvHeader c={c} onBack={onBack} />
      <ViewSwitch c={c} shows="stream" />
      {c.pending && <LinkBanner c={c} />}
      <Timeline tkey={tkey} convIds={ids} onReply={onReply} firstUnreadTs={unreadAt} focus={focus} stream={opts} />
      <StreamFoot c={c} />
      <TypingBar convIds={ids} lead={<TopicChip c={c} value={target} newName={newName} own={own} canNew={canNew} onPick={pick} onNew={setNewName} />} />
      <Composer
        targets={{ convId: newName === null && to ? to.id : c.id }}
        draft={`stream:${c.id}`}
        placeholder={`Message ${convLabel(c)}${where ? ` › ${where}` : ''}`}
        reply={reply}
        clearReply={() => setReply(null)}
        disabledReason={blocked}
        post={newName !== null ? post : undefined}
      />
    </section>
  );
}

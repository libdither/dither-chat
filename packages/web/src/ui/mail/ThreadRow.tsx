/**
 * One thread in a list: who wrote (latest last, you as "me"), how many, when, the subject and the start of the last
 * message. A thread with more people is named by its subject, as its chat is, with who wrote under it. Bold while unread; a dot in the account's colour when more than one account shows. slots.tsx ROW_WRAPPERS
 * go around it (slice 4's swipes).
 */
import type * as P from '@dither-chat/protocol';
import { bareSubject } from '@dither-chat/protocol';
import { isGroupThread, senderLine, threadName } from '../../mail/model.ts';
import { MailTile } from '../MailChat.tsx';
import { go } from '../../state.ts';
import { memo } from '../memo.ts';
import { Avatar } from '../bits.tsx';
import { Icon } from '../icons.tsx';
import { listTime } from './listTime.ts';
import { ROW_WRAPPERS } from './slots.tsx';

export const ThreadRow = memo(function ThreadRow({ thread: t, active, account, showAccount, list }: { thread: P.MailThreadView; active: boolean; account: P.MailAccountView | undefined; showAccount: boolean; list: string }) {
  const other = [...t.from].reverse().find((f) => !f.self) ?? t.from[t.from.length - 1];
  const name = other?.name || other?.email || '?';
  const group = isGroupThread(t);
  let row = (
    <button class={`row mail-row ${active ? 'active' : ''} ${t.unread ? 'unread' : ''}`} data-row={t.id} data-thread={t.id} onClick={() => go({ view: 'inbox', mail: list, conv: t.id })}>
      <span class="row-avatar">
        {/* One colour per sender name: a sender writing from news@ and events@ is one face. A thread with more people is a chat named by its subject, with the envelope tile. */}
        {group ? <MailTile /> : <Avatar id={other?.name || other?.email || t.id} name={name} size={36} />}
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            {showAccount && account && <span class="mail-acc-dot" style={{ background: account.color }} title={account.address ?? account.label} />}
            <span class="mail-row-who">{group ? threadName(t) : senderLine(t)}</span>
            {t.count > 1 && <span class="mail-count">{t.count}</span>}
          </span>
          {t.flagged && <Icon name="star" size={12} class="mail-star" />}
          {t.attachments && <Icon name="paperclip" size={12} class="mail-clip" />}
          <span class="row-time">{listTime(t.lastAt)}</span>
        </span>
        {/* Until a body is here (slice 2 fetches them ahead), the subject is the last line. */}
        <span class="row-bottom">
          <span class="mail-row-subject">{group ? senderLine(t) : bareSubject(t.subject) || '(no subject)'}</span>
          {!t.preview && t.unread > 0 && <span class="unread-dot" />}
        </span>
        {t.preview && (
          <span class="row-bottom">
            <span class="row-preview">{t.preview}</span>
            {t.unread > 0 && <span class="unread-dot" />}
          </span>
        )}
      </span>
    </button>
  );
  for (const W of [...ROW_WRAPPERS].reverse()) row = <W thread={t}>{row}</W>;
  return row;
});

/**
 * What someone wrote to you in public, in their chat (docs/places.md "A person's networks"): their reply to your post,
 * their post that mentions or quotes you, one short row at its time among the chat's messages, as their mail in
 * threads with others is (MailChat.tsx ElsewhereRows draws these rows too). "Answer there" opens the post's thread.
 */
import type * as P from '@dither-chat/protocol';
import { clock, fullTime } from '../format.ts';
import { go } from '../state.ts';
import { NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';
import { netColor } from '../model.ts';

// redraws: everything it draws is in its props, the row the hub sent.
export function PublicRow({ person, e }: { person: P.PersonView; e: P.ElsewhereView }) {
  const net = e.post!.network;
  const open = () => go({ view: 'inbox', conv: e.place });
  return (
    <div class="elsewhere-row public-row" data-public-row={e.place.replace(/^pst_[a-z]+_/, '')}>
      <div class="elsewhere-head public-head" title={`${person.name} ${e.title}, ${fullTime(e.ts)}`}>
        <NetGlyph network={net} size={12} color={netColor(net)} />
        <span class="elsewhere-title">
          {person.name.split(' ')[0]} {e.title}
        </span>
        <span class="elsewhere-time">· {clock(e.ts)}</span>
      </div>
      <div class="elsewhere-body">
        {e.excerpt && <p class="elsewhere-text">{e.excerpt}</p>}
        <button class="link-btn elsewhere-answer" data-track="public answer" onClick={open}>
          Answer there <Icon name="chevronRight" size={12} />
        </button>
      </div>
    </div>
  );
}

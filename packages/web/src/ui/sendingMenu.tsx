/**
 * A message menu's entries for what the network keeps beside the message (docs/sending.md, docs/menus.md): Save
 * Message and Remind Me on Discord (and the list of what you saved), Remove Embeds on your own message, and Report,
 * which opens the message in Discord's own app, where reporting is done. In Discord's names.
 */
import type * as P from '@dither-chat/protocol';
import { deepLink } from '../model.ts';
import { canRemovePreviews, canSaveOnNetwork, knowSaved, remindChoices, removePreviews, saved, saveOnNetwork, unsaveOnNetwork } from '../sending.ts';
import { db, isSelfIdentity, toast } from '../state.ts';
import { openLink } from '../desk.ts';
import type { MenuEntry } from './ContextMenu.tsx';
import { sendPanel } from './SendExtras.tsx';

const accountsOf = (m: P.MessageView) => m.seenVia.map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);

export function sendingEntries(m: P.MessageView): (MenuEntry | false)[] {
  if (m.network !== 'discord' || m.deleted || m.kind === 'system') return [];
  const accs = accountsOf(m);
  const self = isSelfIdentity(m.authorId);
  const saver = accs.find((a) => a.status === 'online' && canSaveOnNetwork(a)) ?? accs.find(canSaveOnNetwork);
  // What the hub last heard; the next menu knows it once read.
  if (saver && saved.value === null) void knowSaved();
  const isSaved = !!saved.value?.has(m.id);
  const author = self ? accs.find((a) => a.selfIdentityId === m.authorId) ?? accs[0] : null;
  const c = db.conversations.get(m.conversationId);
  return [
    !!saver && (isSaved ? { label: 'Remove From Saved', icon: 'star', track: 'unsave', run: () => void unsaveOnNetwork(m) } : { label: 'Save Message', icon: 'star', track: 'save', run: () => void saveOnNetwork(m) }),
    !!saver && {
      label: 'Remind Me',
      icon: 'clock',
      track: 'remind me',
      sub: [
        ...remindChoices(Date.now()).map((t): MenuEntry => ({ label: t.label, track: 'remind me (time)', run: () => void saveOnNetwork(m, t.at) })),
        { kind: 'sep' },
        {
          label: 'Pick a Time…',
          track: 'remind me (pick)',
          run: () => (sendPanel.value = { kind: 'later', title: 'Remind me', onPick: (at) => void saveOnNetwork(m, at) }),
        },
      ],
    },
    !!saver && { label: 'Saved Messages', icon: 'list', track: 'saved list', run: () => (sendPanel.value = { kind: 'saved' }) },
    self && m.embeds.length > 0 && canRemovePreviews(author) && { label: 'Remove Embeds', icon: 'eyeOff', track: 'remove embeds', run: () => void removePreviews(m) },
    !self &&
      !!c &&
      !!deepLink(c) && {
        label: 'Report on Discord',
        icon: 'flag',
        track: 'report',
        run: () => {
          const url = `${deepLink(c)!}/${m.nativeId}`;
          void openLink(url).then((ok) => ok || window.open(url, '_blank', 'noopener,noreferrer'));
          toast({ kind: 'info', title: 'Opened in Discord', body: "Report it from the message's own menu there." });
        },
      },
  ];
}

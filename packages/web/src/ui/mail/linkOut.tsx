/**
 * A link out of a mail (docs/mail.md "Links"), for the framed mail (HtmlBody.tsx) and a mail's words in a chat
 * (MailChat.tsx): opened as chat's links are, and one whose text names another site than it goes to asks first.
 */
import { hostsDiffer, shownHost } from '@dither-chat/protocol';
import { openLink } from '../../desk.ts';
import { copy, openMenu } from '../ContextMenu.tsx';

/** Opened as chat's links are: the desktop helper, else a new tab (Android: its browser). */
export function openOut(url: string) {
  void openLink(url).then((ok) => {
    if (ok) return;
    if (/^mailto:/i.test(url)) window.location.assign(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  });
}

/** The site a link's text names when it is not where the link goes; null when they agree (or the text names none). */
export function linkMismatch(url: URL, text: string): string | null {
  const shown = url.protocol === 'mailto:' ? null : shownHost(text);
  return shown && hostsDiffer(shown, url.hostname) ? shown : null;
}

/** Asks before opening a link whose text names `shown` but goes elsewhere: where it really goes, Open, Copy. */
export function askLink(url: URL, shown: string, at: { x: number; y: number }) {
  openMenu(at, {
    label: 'Open link',
    head: (
      <div class="cm-sheet-title mail-link-ask">
        The link shows {shown} but goes to <b>{url.hostname}</b>
      </div>
    ),
    items: [
      { kind: 'label', label: `Shows ${shown}, goes to ${url.hostname}` },
      { label: `Open ${url.hostname}`, icon: 'external', run: () => openOut(url.href) },
      { label: 'Copy the link', icon: 'copy', run: () => void copy(url.href, 'Link copied') },
    ],
  });
}

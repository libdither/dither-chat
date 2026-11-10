/** The app's addresses: a route and the hash that names it. Pure, so tests can import it; state.ts keeps the live route. */

export type Route =
  | { view: 'inbox'; conv?: string; msg?: string }
  /** Catch up (docs/inbox.md#catch-up). On a desktop it is the inbox with nothing open; a phone gives it a tab of its own. */
  | { view: 'triage' }
  /** How it sorts (docs/notifications.md#voting): where triage put each conversation's messages this week, and why. */
  | { view: 'model' }
  /** graph: the people graph (graph/GraphView.tsx) in place of a thread. */
  | { view: 'people'; person?: string; graph?: boolean }
  /** A profile page (docs/profile.md): a person, an identity not merged into one, or a conversation or space. */
  | { view: 'profile'; person?: string; identity?: string; conv?: string; space?: string }
  | { view: 'spaces' }
  | { view: 'space'; space: string; conv?: string }
  | { view: 'folder'; folder: string; conv?: string; person?: string }
  | { view: 'accounts'; account?: string }
  | { view: 'settings' }
  | { view: 'directory' }
  | { view: 'search'; q: string; conv?: string; msg?: string }
  /** Mail (docs/mail.md): a list (a view or a mailbox, mail/model.ts keys), and the thread open beside it. */
  | { view: 'mail'; list?: string; thread?: string }
  /** Requests waiting on you (docs/add.md), `request` the one to show. */
  | { view: 'requests'; request?: string };

export function parseHash(h = location.hash): Route {
  const [path, query] = h.replace(/^#\/?/, '').split('?');
  const p = path.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query ?? '');
  switch (p[0]) {
    case 'people':
      return p[1] === 'graph' && !p[2] ? { view: 'people', graph: true } : { view: 'people', person: p[1] };
    case 'p':
      return { view: 'profile', person: p[1] };
    case 'i':
      return { view: 'profile', identity: p[1] };
    case 'about':
      return p[1] === 's' ? { view: 'profile', space: p[2] } : { view: 'profile', conv: p[2] };
    // The Groups list joined the inbox; its links still open the same conversation there.
    case 'groups':
      return { view: 'inbox', conv: p[1] === 'c' ? p[2] : undefined };
    case 'spaces':
      return { view: 'spaces' };
    case 's':
      return { view: 'space', space: p[1], conv: p[2] === 'c' ? p[3] : undefined };
    case 'f':
      return { view: 'folder', folder: p[1], conv: p[2] === 'c' ? p[3] : undefined, person: p[2] === 'p' ? p[3] : undefined };
    case 'accounts':
      return { view: 'accounts', account: p[1] };
    case 'settings':
      return { view: 'settings' };
    case 'triage':
      return { view: 'triage' };
    case 'model':
      return { view: 'model' };
    case 'directory':
      return { view: 'directory' };
    case 'search':
      return { view: 'search', q: q.get('q') ?? '', conv: p[1] === 'c' ? p[2] : undefined, msg: q.get('m') ?? undefined };
    case 'c':
      return { view: 'inbox', conv: p[1], msg: q.get('m') ?? undefined };
    case 'requests':
      return { view: 'requests', request: p[1] };
    case 'mail':
      // #/mail, #/mail/l/<list>, #/mail/t/<thread>, #/mail/l/<list>/t/<thread>
      return p[1] === 'l' ? { view: 'mail', list: p[2], thread: p[3] === 't' ? p[4] : undefined } : { view: 'mail', thread: p[1] === 't' ? p[2] : undefined };
    default:
      return { view: 'inbox', conv: p[1] === 'c' ? p[2] : undefined, msg: q.get('m') ?? undefined };
  }
}

export function href(r: Route): string {
  const e = encodeURIComponent;
  switch (r.view) {
    case 'inbox':
      return r.conv ? `#/inbox/c/${e(r.conv)}${r.msg ? `?m=${e(r.msg)}` : ''}` : '#/inbox';
    case 'people':
      return r.person ? `#/people/${e(r.person)}` : r.graph ? '#/people/graph' : '#/people';
    case 'profile':
      if (r.conv) return `#/about/c/${e(r.conv)}`;
      if (r.space) return `#/about/s/${e(r.space)}`;
      return r.person ? `#/p/${e(r.person)}` : `#/i/${e(r.identity ?? '')}`;
    case 'spaces':
      return '#/spaces';
    case 'space':
      return `#/s/${e(r.space)}${r.conv ? `/c/${e(r.conv)}` : ''}`;
    case 'folder':
      return `#/f/${e(r.folder)}${r.conv ? `/c/${e(r.conv)}` : r.person ? `/p/${e(r.person)}` : ''}`;
    case 'accounts':
      return r.account ? `#/accounts/${e(r.account)}` : '#/accounts';
    case 'settings':
      return '#/settings';
    case 'triage':
      return '#/triage';
    case 'model':
      return '#/model';
    case 'directory':
      return '#/directory';
    case 'search':
      return `#/search${r.conv ? `/c/${e(r.conv)}` : ''}?q=${e(r.q)}${r.msg ? `&m=${e(r.msg)}` : ''}`;
    case 'mail':
      return `#/mail${r.list ? `/l/${e(r.list)}` : ''}${r.thread ? `/t/${e(r.thread)}` : ''}`;
    case 'requests':
      return `#/requests${r.request ? `/${e(r.request)}` : ''}`;
  }
}


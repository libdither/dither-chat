/** The app's addresses: a route and the hash that names it. Pure, so tests can import it; state.ts keeps the live route. */

export type Route =
  /**
   * `mail`: a list of mail shown in the inbox's place (docs/mail.md "Mail as chats"): Updates, Everything, Starred, Sent,
   * a mailbox or a search (mail/model.ts keys). There is no Mail page: mail is chats, and these are its lists.
   */
  | { view: 'inbox'; conv?: string; msg?: string; mail?: string }
  /** For you (docs/foryou.md). On a desktop it is the inbox with nothing open; a phone gives it a tab of its own. */
  | { view: 'foryou' }
  /** How it sorts (docs/notifications.md): which tier triage put each conversation's messages in this week, and why. */
  | { view: 'model' }
  /** Your attention (docs/scorecard.md, "The weekly report"): what notifications cost, and who waits on you. */
  | { view: 'attention' }
  /** graph: the people graph (graph/GraphView.tsx) in place of a thread. */
  | { view: 'people'; person?: string; graph?: boolean; same?: boolean }
  /** A profile page (docs/profile.md): a person, an identity not merged into one, or a conversation or space. */
  | { view: 'profile'; person?: string; identity?: string; conv?: string; space?: string }
  | { view: 'spaces' }
  | { view: 'space'; space: string; conv?: string }
  | { view: 'folder'; folder: string; conv?: string; person?: string }
  | { view: 'accounts'; account?: string }
  | { view: 'settings' }
  | { view: 'directory' }
  | { view: 'search'; q: string; conv?: string; msg?: string }
  /** Requests waiting on you (docs/add.md), `request` the one to show. */
  | { view: 'requests'; request?: string }
  /** What your accounts and services told you (docs/notices.md), `notice` the one to show. */
  | { view: 'notices'; notice?: string }
  /** Notification calibration (docs/notifications.md, "Asking, without nagging"): questions about single notifications, waiting for you. */
  | { view: 'calibration' }
  /** dither-calendar beside the hub (docs/calendar.md): `at` is the calendar's own hash without "#/", query and all. */
  | { view: 'calendar'; at?: string }
  /**
   * The Feed (docs/feed.md "The Feed page"): a source (`home`, `activity`, `mine`, `drafts`, `<account>:following`,
   * `<account>:foryou`, `<account>:activity`, `<account>:mine`; Home when absent) and the post open beside it (a
   * post key, feed.ts postKey).
   */
  | { view: 'feed'; source?: string; post?: string };

/** A mail list in the inbox's place (`?mail=`). */
const mailOf = (q: URLSearchParams) => (q.get('mail') ? { mail: q.get('mail')! } : {});

export function parseHash(h = location.hash): Route {
  // The calendar's address is its own, kept verbatim (#/calendar/day/2026-11-14?e=…).
  const raw = h.replace(/^#\/?/, '');
  if (raw === 'calendar' || raw.startsWith('calendar/')) {
    const at = raw.slice('calendar/'.length);
    return at ? { view: 'calendar', at } : { view: 'calendar' };
  }
  const [path, query] = h.replace(/^#\/?/, '').split('?');
  const p = path.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query ?? '');
  switch (p[0]) {
    case 'people':
      return p[1] === 'graph' && !p[2] ? { view: 'people', graph: true } : p[1] === 'same' && !p[2] ? { view: 'people', same: true } : { view: 'people', person: p[1] };
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
    // Catch up's old address opens For you, which took its place.
    case 'foryou':
    case 'triage':
      return { view: 'foryou' };
    case 'model':
      return { view: 'model' };
    case 'attention':
      return { view: 'attention' };
    case 'directory':
      return { view: 'directory' };
    case 'search':
      return { view: 'search', q: q.get('q') ?? '', conv: p[1] === 'c' ? p[2] : undefined, msg: q.get('m') ?? undefined };
    case 'c':
      return { view: 'inbox', conv: p[1], msg: q.get('m') ?? undefined, ...mailOf(q) };
    case 'requests':
      return { view: 'requests', request: p[1] };
    case 'notices':
      return { view: 'notices', notice: p[1] };
    case 'calibration':
      return { view: 'calibration' };
    case 'feed': {
      // #/feed, #/feed/<source>, #/feed/<source>/p/<post key>
      const source = p[1] && p[1] !== 'p' ? p[1] : undefined;
      const at = p.indexOf('p', 1);
      const post = at > 0 ? p[at + 1] : undefined;
      return { view: 'feed', ...(source ? { source } : {}), ...(post ? { post } : {}) };
    }
    case 'mail': {
      // The Mail page's old addresses (#/mail, #/mail/l/<list>, #/mail/t/<thread>, #/mail/l/<list>/t/<thread>): mail is
      // chats now, so a thread opens as its chat, and a list in the inbox's place. Its Inbox is the inbox's Mail.
      const list = p[1] === 'l' ? p[2] : undefined;
      const thread = p[1] === 't' ? p[2] : p[3] === 't' ? p[4] : undefined;
      return { view: 'inbox', ...(thread ? { conv: thread } : {}), ...(list && !/^v:inbox(:|$)/.test(list) ? { mail: list } : {}) };
    }
    default:
      return { view: 'inbox', conv: p[1] === 'c' ? p[2] : undefined, msg: q.get('m') ?? undefined, ...mailOf(q) };
  }
}

export function href(r: Route): string {
  const e = encodeURIComponent;
  switch (r.view) {
    case 'inbox': {
      const q = [r.msg && `m=${e(r.msg)}`, r.mail && `mail=${e(r.mail)}`].filter(Boolean).join('&');
      return `${r.conv ? `#/inbox/c/${e(r.conv)}` : '#/inbox'}${q ? `?${q}` : ''}`;
    }
    case 'people':
      return r.person ? `#/people/${e(r.person)}` : r.graph ? '#/people/graph' : r.same ? '#/people/same' : '#/people';
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
    case 'foryou':
      return '#/foryou';
    case 'model':
      return '#/model';
    case 'attention':
      return '#/attention';
    case 'directory':
      return '#/directory';
    case 'search':
      return `#/search${r.conv ? `/c/${e(r.conv)}` : ''}?q=${e(r.q)}${r.msg ? `&m=${e(r.msg)}` : ''}`;
    case 'requests':
      return `#/requests${r.request ? `/${e(r.request)}` : ''}`;
    case 'notices':
      return `#/notices${r.notice ? `/${e(r.notice)}` : ''}`;
    case 'calibration':
      return '#/calibration';
    case 'calendar':
      return r.at ? `#/calendar/${r.at}` : '#/calendar';
    case 'feed':
      // An account's source keeps its colon readable (`#/feed/acc_1:foryou`).
      return `#/feed${r.source ? `/${e(r.source).replace(/%3A/g, ':')}` : ''}${r.post ? `/p/${e(r.post)}` : ''}`;
  }
}


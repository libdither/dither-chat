/**
 * Sending a decided message to the devices (docs/notifications.md, "One notification per conversation"): chat's,
 * mail's and notices'. main.ts makes one Notifier and hands it what it sends through.
 */
import type { ActivityStore } from './activity.ts';
import type { Delivery } from './delivery.ts';
import type { Devices } from './devices.ts';
import type { MailNotice } from './mail/triage.ts';
import type { NoticeDelivery } from './notices/index.ts';
import type { PhoneList } from './phonelist.ts';
import type { PushService } from './push.ts';
import type { HubServer } from './server.ts';
import type { Store } from './store.ts';

export interface NotifierDeps {
  store: Pick<Store, 'notifyLook' | 'one'>;
  activity: Pick<ActivityStore, 'notification' | 'sent'>;
  devices: Pick<Devices, 'addressed' | 'quietOn'>;
  push: Pick<PushService, 'desktops' | 'notify'>;
  delivery: Pick<Delivery, 'listDue' | 'plan'>;
  server: Pick<HubServer, 'notify' | 'warm'>;
  /** Which list rows reach the phones (phonelist.ts). */
  phone: Pick<PhoneList, 'list' | 'higher'>;
}

export type Tier = 'push' | 'quiet' | 'digest';

/** The pictures a push names: the phone fetches each from the hub while it draws the notification. */
function pictures(look: { icon?: string } | undefined, g: { conv?: { icon?: string }; sender?: { icon?: string }; icons?: Record<string, string> } | null): (string | undefined)[] {
  return [look?.icon, g?.conv?.icon, g?.sender?.icon, ...Object.values(g?.icons ?? {})];
}

export class Notifier {
  /** Each push, once sent: for tests, which wait for it. */
  last: Promise<unknown> = Promise.resolve();

  constructor(private d: NotifierDeps) {}

  /**
   * An alert ('push') goes everywhere and sounds. A Conversation ('quiet') and a list row ('digest') go only to phones,
   * silently, and to open pages as an entry in the list rather than a notification (docs/notifications.md). A message's
   * push carries its tier, its importance and its id, so the row can be sorted and marked from where it shows. `level`
   * says the same to an app from before the tiers, which knows only 'push' and 'quiet'. Each one gets an id the devices
   * see (`nid`), so what they say happened to it lands in the activity log.
   *
   * A list row reaches the phones only as the phone's list allows (phonelist.ts, `prior`: the start alone puts it on
   * the list); held, nothing is sent at all, as within the list's ten minutes (open pages show no list row anyway,
   * state.ts `showsHere`). A Conversation or an alert in a chat ends its list episode.
   */
  message(title: string, body: string, conversationId: string, messageId: string, reasons: string[], pushExtra: Record<string, unknown> = {}, kind: 'message' | 'held' = 'held', tier: Tier = 'push', importance: number | null = null, prior = true) {
    const { store, activity, devices, push, delivery, server, phone } = this.d;
    // A chat's row in the list is brought up to date now and then, not with every message.
    if (tier === 'digest' && !delivery.listDue(conversationId)) return;
    if (kind === 'message' && tier === 'digest') {
      if (!phone.list(conversationId, prior, store.one<{ ts: number }>('SELECT ts FROM message WHERE id = ?', messageId)?.ts ?? Date.now()).send) return;
    } else if (kind === 'message') phone.higher(conversationId);
    const nid = activity.notification({ kind, messageId, conversationId });
    // Devices whose own rules keep this off them: their push is not sent, and their open pages show no toast.
    const addressed = kind === 'message' && devices.addressed(messageId);
    const quiet = devices.quietOn(conversationId, addressed);
    const level = tier === 'push' ? 'push' : 'quiet';
    const look = store.notifyLook(conversationId, kind === 'message' ? messageId : undefined);
    server.notify({ t: 'notify', messageId, conversationId, title, body, reasons, ...look, ...(nid ? { nid } : {}), ...(quiet.length ? { quiet } : {}), ...(tier !== 'push' ? { level: tier } : {}) });
    const skip = tier === 'push' ? quiet : [...quiet, ...push.desktops()];
    const vote = kind === 'message' ? { messageId, level, tier, ...(importance !== null ? { importance } : {}) } : {};
    const grouped = kind === 'message' ? delivery.plan(conversationId, messageId, tier, addressed) : null;
    // The row keeps the highest tier of what it shows (delivery.ts `Grouped.tier`); only this message's own tier sounds.
    if (grouped?.tier && kind === 'message') Object.assign(vote, { tier: grouped.tier, level: grouped.tier === 'push' ? 'push' : 'quiet' });
    this.last = server
      .warm(pictures(look, grouped))
      .then(() => push.notify(title, body, conversationId, { ...pushExtra, ...look, ...vote, ...grouped, ...(nid ? { nid } : {}) }, skip, level))
      .then((r) => nid && activity.sent(nid, r))
      .catch((e) => console.error('push failed', e));
  }

  /**
   * Mail's notifications (mail/triage.ts), as chat's: an alert for mail from someone set to always alert, else a row
   * on the list (through the phone's list, as chat's); one notification per thread (delivery.ts), the devices whose
   * rules keep Email or that account off left out (devices.ts), marks from the notification itself. The push's
   * conversation is the thread, which the app and the worker open beside the inbox.
   */
  mail(n: MailNotice) {
    const { activity, devices, push, delivery, server, phone } = this.d;
    if (n.level === 'digest' && !delivery.listDue(n.threadId)) return;
    if (n.level !== 'digest') phone.higher(n.threadId);
    else if (!phone.list(n.threadId, n.prior ?? true, Date.now()).send) return;
    const nid = activity.notification({ kind: 'message', messageId: n.messageId, conversationId: n.threadId });
    const quiet = devices.quietOn(n.threadId, n.addressed);
    const level = n.level === 'push' ? 'push' : 'quiet';
    const mail = { mailThreadId: n.threadId };
    server.notify({ t: 'notify', messageId: n.messageId, conversationId: n.threadId, title: n.title, body: n.body, reasons: n.reasons, ...n.look, ...mail, ...(nid ? { nid } : {}), ...(quiet.length ? { quiet } : {}), ...(n.level !== 'push' ? { level: n.level } : {}) });
    const skip = n.level === 'push' ? quiet : [...quiet, ...push.desktops()];
    const grouped = delivery.plan(n.threadId, n.messageId, n.level, n.addressed);
    this.last = server
      .warm(pictures(n.look, grouped))
      .then(() => push.notify(n.title, n.body, n.threadId, { ...n.look, ...mail, messageId: n.messageId, level, tier: n.level, ...(n.importance !== null ? { importance: n.importance } : {}), ...grouped, ...(nid ? { nid } : {}) }, skip, level))
      .then((r) => nid && activity.sent(nid, r))
      .catch((e) => console.error('push failed', e));
  }

  /**
   * A notice's notification (notices/, docs/notices.md), as mail's: an alert, or a row on the list through the
   * phone's list; one notification per group (its repository, its app: the push's conversation), the devices whose
   * rules keep Notices, that account or that group off left out, the marks from the notification itself. The push
   * carries `noticeId`, which the worker and the app open under Notices. Returns whether it went out.
   */
  notice(n: NoticeDelivery): boolean {
    const { activity, devices, push, delivery, server, phone } = this.d;
    if (n.level === 'digest' && !delivery.listDue(n.group)) return false;
    if (n.level !== 'digest') phone.higher(n.group);
    else if (!phone.list(n.group, n.prior, Date.now()).send) return false;
    const nid = activity.notification({ kind: 'message', messageId: n.id, conversationId: n.group });
    const quiet = devices.quietOn(n.group, n.addressed);
    const level = n.level === 'push' ? 'push' : 'quiet';
    server.notify({ t: 'notify', messageId: n.id, conversationId: n.group, noticeId: n.id, title: n.title, body: n.body, reasons: n.reasons, ...(nid ? { nid } : {}), ...(quiet.length ? { quiet } : {}), ...(n.level !== 'push' ? { level: n.level } : {}) });
    const skip = n.level === 'push' ? quiet : [...quiet, ...push.desktops()];
    const grouped = delivery.plan(n.group, n.id, n.level, n.addressed);
    this.last = push
      .notify(n.title, n.body, n.group, { ...n.look, noticeId: n.id, messageId: n.id, level, tier: n.level, ...(n.importance !== null ? { importance: n.importance } : {}), ...grouped, ...(nid ? { nid } : {}) }, skip, level)
      .then((r) => nid && activity.sent(nid, r))
      .catch((e) => console.error('push failed', e));
    return true;
  }
}

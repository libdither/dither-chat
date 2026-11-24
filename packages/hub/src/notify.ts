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
import { arrivedCopy, fitArrived } from './arrived.ts';
import { jobFailed } from './errors.ts';
import { pushPayload } from './webpush.ts';

interface NotifierDeps {
  /** With messageView and conversationView, a message's push carries a copy of it (arrived.ts). */
  store: Pick<Store, 'notifyLook' | 'one'> & Partial<Pick<Store, 'messageView' | 'conversationView'>>;
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

/**
 * Whether a push sounds where it goes, as the devices read it (sw.js, the Android app): an alert's row, unless the hub
 * said this update is silent (delivery.ts `alert`). Kept with the notification for the scorecard's sounds a day.
 */
export function sounded(level: 'push' | 'quiet', extra: { tier?: unknown; alert?: unknown }): boolean {
  return level === 'push' && (extra.tier ?? 'push') === 'push' && extra.alert !== false;
}

/** Room for the device id push.ts adds to each device's payload, when measuring what fits. */
const DEVICE_ROOM = 'x'.repeat(40);

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
   *
   * A held one (a reminder you set on a network, the summary when quiet hours end) carries `keep`: it shows no
   * message's time, and no read closes it, only a tap or a swipe (docs/notifications.md, "Read elsewhere, gone here").
   */
  message(title: string, body: string, conversationId: string, messageId: string, reasons: string[], pushExtra: Record<string, unknown> = {}, kind: 'message' | 'held' = 'held', tier: Tier = 'push', importance: number | null = null, prior = true) {
    const { store, activity, devices, push, delivery, server, phone } = this.d;
    // A chat's row in the list is brought up to date now and then, not with every message.
    if (tier === 'digest' && !delivery.listDue(conversationId)) return;
    if (kind === 'message' && tier === 'digest') {
      if (!phone.list(conversationId, prior, store.one<{ ts: number }>('SELECT ts FROM message WHERE id = ?', messageId)?.ts ?? Date.now(), Date.now(), importance).send) return;
    } else if (kind === 'message') phone.higher(conversationId);
    const nid = activity.notification({ kind, messageId, conversationId });
    // Devices whose own rules keep this off them: their push is not sent, and their open pages show no toast.
    const addressed = kind === 'message' && devices.addressed(messageId);
    const quiet = devices.quietOn(conversationId, addressed);
    const level = tier === 'push' ? 'push' : 'quiet';
    const look = store.notifyLook(conversationId, kind === 'message' ? messageId : undefined);
    const keep = kind === 'held' ? { keep: true as const } : {};
    server.notify({ t: 'notify', messageId, conversationId, title, body, reasons, ...look, ...keep, ...(nid ? { nid } : {}), ...(quiet.length ? { quiet } : {}), ...(tier !== 'push' ? { level: tier } : {}) });
    const skip = tier === 'push' ? quiet : [...quiet, ...push.desktops()];
    const vote = kind === 'message' ? { messageId, level, tier, ...(importance !== null ? { importance } : {}) } : {};
    const grouped = kind === 'message' ? delivery.plan(conversationId, messageId, tier, addressed) : null;
    // The row keeps the highest tier of what it shows (delivery.ts `Grouped.tier`); only this message's own tier sounds.
    if (grouped?.tier && kind === 'message') Object.assign(vote, { tier: grouped.tier, level: grouped.tier === 'push' ? 'push' : 'quiet' });
    const extra: Record<string, unknown> = { ...pushExtra, ...look, ...vote, ...grouped, ...keep, ...(nid ? { nid } : {}) };
    // A copy of the message, so the device shows it before it reaches the hub, where it fits (arrived.ts).
    const copy = kind === 'message' && store.messageView && store.conversationView ? arrivedCopy(store as Required<NotifierDeps['store']>, conversationId, messageId) : null;
    const arrived = copy && fitArrived(pushPayload(title, body, conversationId, { ...extra, device: DEVICE_ROOM }), copy);
    if (arrived) extra.arrived = arrived;
    const sounds = sounded(level, extra);
    this.last = server
      .warm(pictures(look, grouped))
      .then(() => push.notify(title, body, conversationId, extra, skip, level))
      .then((r) => nid && activity.sent(nid, r, sounds))
      .catch((e) => (console.error('push failed', e), jobFailed('push: request', e)));
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
    else if (!phone.list(n.threadId, n.prior ?? true, Date.now(), Date.now(), n.importance).send) return;
    const nid = activity.notification({ kind: 'message', messageId: n.messageId, conversationId: n.threadId });
    const quiet = devices.quietOn(n.threadId, n.addressed);
    const level = n.level === 'push' ? 'push' : 'quiet';
    const mail = { mailThreadId: n.threadId };
    server.notify({ t: 'notify', messageId: n.messageId, conversationId: n.threadId, title: n.title, body: n.body, reasons: n.reasons, ...n.look, ...mail, ...(nid ? { nid } : {}), ...(quiet.length ? { quiet } : {}), ...(n.level !== 'push' ? { level: n.level } : {}) });
    const skip = n.level === 'push' ? quiet : [...quiet, ...push.desktops()];
    const grouped = delivery.plan(n.threadId, n.messageId, n.level, n.addressed);
    const extra = { ...n.look, ...mail, messageId: n.messageId, level, tier: n.level, ...(n.importance !== null ? { importance: n.importance } : {}), ...grouped, ...(nid ? { nid } : {}) };
    this.last = server
      .warm(pictures(n.look, grouped))
      .then(() => push.notify(n.title, n.body, n.threadId, extra, skip, level))
      .then((r) => nid && activity.sent(nid, r, sounded(level, extra)))
      .catch((e) => (console.error('push failed', e), jobFailed('push: request', e)));
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
    else if (!phone.list(n.group, n.prior, Date.now(), Date.now(), n.importance).send) return false;
    const nid = activity.notification({ kind: 'message', messageId: n.id, conversationId: n.group });
    const quiet = devices.quietOn(n.group, n.addressed);
    const level = n.level === 'push' ? 'push' : 'quiet';
    server.notify({ t: 'notify', messageId: n.id, conversationId: n.group, noticeId: n.id, title: n.title, body: n.body, reasons: n.reasons, ...(nid ? { nid } : {}), ...(quiet.length ? { quiet } : {}), ...(n.level !== 'push' ? { level: n.level } : {}) });
    const skip = n.level === 'push' ? quiet : [...quiet, ...push.desktops()];
    const grouped = delivery.plan(n.group, n.id, n.level, n.addressed);
    const extra = { ...n.look, noticeId: n.id, messageId: n.id, level, tier: n.level, ...(n.importance !== null ? { importance: n.importance } : {}), ...grouped, ...(nid ? { nid } : {}) };
    this.last = push
      .notify(n.title, n.body, n.group, extra, skip, level)
      .then((r) => nid && activity.sent(nid, r, sounded(level, extra)))
      .catch((e) => (console.error('push failed', e), jobFailed('push: request', e)));
    return true;
  }
}

# Notices: what your accounts and services tell you

GitHub tells you a review was asked of you; dither-accounts knows an account stopped and needs you. dither-chat takes
those through dither-accounts' `notifications` interface, ranks them with your chats, and notifies through the same
tiers, the same phone list and the same marks. They are listed under **Notices**, a row in the inbox and the page
`#/notices`.

Code: `packages/hub/src/notices/` (`index.ts`: keeping, catch-up, reads, the routes, one notification per group;
`triage.ts`: the decision; `fake.ts`: the demo's source), `remote.ts` (the grant and the events), `notify.ts`
(`Notifier.notice`); `packages/protocol/src/notices.ts`; `packages/web/src/notices.ts`, `ui/Notices.tsx` (the row),
`ui/NoticesPane.tsx` (the page, a lazy chunk). The sources are in dither-accounts: `extractors/github`,
`extractors/telegram` (Telegram Desktop's notifications) and the manager's own account of kind `notices`.

```
 GitHub API ──────────▶ extractors/github ──┐  notify.new { notification (+ urgency) }
 Telegram Desktop ────▶ extractors/telegram ┤  notify.read { ids }
 the manager itself (account health) ───────┤
                                            ▼
                dither-accounts manager (grant: notifications, write, accounts '*')
                                            │ events, gaps / notify.list, notify.markRead
                                            ▼
                     hub: notices/  (RoutedSupervisor.notices, mail's sibling)
     keep (notice table) → triage (urgency start + local model + your marks) → Notifier.notice → push
     marks → votes.ts `others` (chat's model)        read sync ⇄ notify.markRead / notify.read
                                            ▼
               phone (Android app) / browsers (sw.js) / open pages: #/notices/<id>
```

## Access

The hub asks for `notifications` at `write` on every account (`NOTICES_REQUEST` in remote.ts), once, as it asks for
mail: in its registration when it is new, else with `requestAccess` on the next start. A request waiting for you or one
you declined is not asked again; the page says which, links to the manager's page, and after a no offers "Ask
again" (`POST /api/notices/access/ask`). While it waits, the manager is asked every minute whether you answered.

An account counts as one of notices' when the manager lists it with the `notifications` interface and a `read` or
`write` grant, **unless the hub also holds a chat grant on it**. Telegram with dither-accounts'
`DITHER_TELEGRAM_DESKTOP=1` carries both, and Desktop raises a popup (`notify.new`) for every message chat already
triages and notifies: such an account is left to chat, its events go only there, and a gap restarts it as before.

## Keeping them

Table `notice` (schema.sql), one row per notice: `id` = `ntc_<hash(account, native id)>` (also the id marks take),
the account, the extractor's id, its group (`ntg_<hash(account, context or source)>`: a repository, an app, an
account), source, title, body, link (http and https only), reason, context, subject and actors as JSON, urgency,
when, unread, and the decision: tier, importance, alert chance, reasons, facts, words, whether it notified, your
marks. Kept 30 days; a marked one while it is learned from.

- **Catch-up** (`notify.list`, unread only, since the oldest unread kept (else the newest kept), 50 a page, ten pages
  at most, nothing older than 30 days): when an account is first listed, when the connection comes back, and after a
  gap. What it finds is rated but **notifies nobody** ("Came by a catch-up: no notification"), as mail's late mail.
  Upstream `since` is exclusive ("updated after", whole seconds), so the hub asks from a second before the oldest
  unread. A notice whose live arrival is still waiting on the local model is left alone by a catch-up (it is decided,
  and may notify, as live), and a live decision is not dropped for a catch-up's that came meanwhile.
  **What it no longer lists was read there meanwhile** (a `notify.read` lost in a gap or a manager restart): a notice
  unread here, inside the window the listing covered (all of it, or from the oldest it reached when cut off) and kept
  before the listing began, is read here, quietly: no notification, no `notify.markRead`.
- **Live** (`notify.new`): kept, triaged, notified. The same notice again with nothing new (same time, still unread)
  is ignored; with a newer time, or back unread, it is triaged again. One a catch-up found first (GitHub's list reads
  the API at once, while `notify.new` waits for its poll) and that therefore notified nobody is decided again, live,
  and may notify, while it is unread and raised within the hour.
- **The local model is asked outside the queue** that keeps notices and reads in order, so a slow answer holds up
  nothing else. Each notice's own steps stay in order: a read that comes while its answer is awaited is applied
  first, and the notice is then decided as read (notifying nobody); a newer arrival of the same notice waits for the
  one before, whose decision gives way to it.
- **Read there** (`notify.read`): read here, never notified. Its notification leaves the phones once its group has
  no unread notice that a notification showed: `readTs` is just below the earliest `shown_ts` (a notice's time as
  its notification last showed it, set only when `Notifier.notice` really sent one, and kept when the notice is
  updated) among unread notices; delivery.ts `read` then sends a `{ clear }` push. So a notice raised again inside
  the list's ten minutes, the update held, keeps its notification until it is read. The phone list's held episodes
  ask another question, whether anything in the group is unread (`readAllTs`): a group with an unread notice is not
  read, whether or not it was shown.
- **Read here** (opening it from a notification, Open, Mark read): read here, and `notify.markRead` on the service,
  best effort, when the grant is `write`. The service's echo (`notify.read`) changes nothing. A later catch-up that
  still lists it unread (the mark not there yet, failed, or a `read` grant) leaves it read, unless it was raised again
  since (a newer time).

## Tiers

Notices have no Conversation tier: an **Alert**, a row on the **List**, **Below the list**, or **silent**.

1. Muted (a rule of yours on its account, `PUT /api/rules { scope: 'account' }`, or on its group, scope
   `conversation` with the `ntg_` id): silent.
2. One of your keywords, or Always alert on the group or the account: an alert.
3. Else the two chances, starting from the source's urgency and moved by your marks (learn.ts `predict`; the start is
   kept in the facts as `start`, so learning starts from the same place):

| Urgency (absent: normal) | Alert chance starts at | Importance starts at | Local model |
| --- | --- | --- | --- |
| `high`: act soon (a security alert, an account that needs you) | 0.7 | 0.9 | not asked |
| `normal`: addressed to you (a mention, a review asked of you) | its answer to the stop-now question on title and body, held to the bar of 0.2 (`ALERT_BAR.other`); 0.02 when it is off or did not answer within 3 s | 0.72 | asked |
| `low`: ambient (CI, activity you only watch) | 0.01 | 0.15 | not asked |

An alert at 0.5 or more; else on the list at your level of importance (0.6 until you set it) or more; else below
it. A normal notice starts at 0.72, a margin over the default level, so what chat learned about features a notice
shares (anything, a link) cannot sink every review request below the list before you mark one. List only on the
group or the account keeps it from alerting. Quiet hours hold an alert as a row on the list, and count it for their
summary when they end ("2 messages held for you"), as chat's held alerts are: only one that would have notified,
and once (`held_at`), however often it is decided again. A summary whose last held one is a notice carries its
`noticeId`, so its tap opens it under Notices; a group's id opened as a conversation shows Notices too. Already read, or raised over an hour
before it came here, it is rated and notifies nobody. A slow local model is not asked again later.

**Reasons**, the deciding one first: "GitHub says it is urgent", "Reads as urgent: the local model's answer is 0.6
against a bar of 0.2", "On the list: importance 60%, at or over your level of 60%", "List, learned from your marks
(was Alert)", "Held by quiet hours until 07:00"; then what the source said: "GitHub says: review requested
(normal)".

**The facts** are learn.ts's: network `notice:<source>` (`notice:github`), shape `notice`, the group as the
conversation, the account as the space, the first actor (their link, else their name) as the author, a mention when
the reason is `mention`, `team_mention`, `review_requested` or `assign`, `urgent` for high, `link`. Chat's own flags
(a reply to you, a question, @everyone, you active there, and a mention when the reason is not about you) are left
out rather than false, so none of chat's "does not …" weights moves a notice. So "Alert was wrong" on a repository's
notices moves that repository first, then that person, then the account.

## Marks

The three marks, as chat's: **Should have alerted**, **Alert was wrong**, **Less like this**. On the page, on the
notification (sw.js and the Android app offer them by tier, as for a message), or
`POST /api/messages/:id/feedback` with the `ntc_` id. They are kept on the notice and join chat's examples
(`TriageVotes.others`), so they teach the one model, and a mark is followed at once by learning again.

## Notifications

`Notifier.notice` (notify.ts), as mail's: one notification per group (its tag and `conversationId` is the `ntg_` id),
the title "GitHub · libdither/dither-chat", the body "title — text", the group's unread notices as its lines. An
alert goes everywhere and sounds once a burst; a list row is silent, phones only, through the phone's list (its start
puts it on the list unless it is low and not about you), at most every ten minutes a group. The push and the live
`notify` event carry `noticeId` and `messageId` (the same `ntc_` id); `network` is `notice`. The phone's list is
shared with chat and mail: a group of notices counts as one chat toward its eight open rows (`LIST_CAP`) and toward
its three trials a day.

**A tap** opens `#/notices/<id>` in the page (sw.js), the Android app (`Notifications.kt` reads `noticeId`) and from
an ntfy topic, which marks it read. On Android an alert is a plain notification tagged with its group (so the hub's
clear takes it away), with the marks, never a conversation's: no shortcut, not in the Conversations section; a list
row is a row of the ranked list as any other. **Device rules**: a group's chain is the group, its account, then
`network:notice`; Settings → Notifications → Each device lists **Notices**. "Mentions only" keeps the ones about you
by name.

## The page

`#/notices`: newest first, the last 30 days; each with its source, context, title, text, age, tier and its first
reason, and a dot while unread. A notice opens to all its reasons, **Open** (its link, in a new tab, which reads it),
**Mark read** and the marks. The inbox's Notices row shows how many are unread and the newest. API: `GET
/api/notices` (`NoticesPage`), `GET /api/notices/:id`, `POST /api/notices/:id/read`, `POST
/api/notices/access/ask`; the bootstrap's `notices: { access }` when the hub has them.

## The demo world

A demo hub (`--demo`) has a fake source (`notices/fake.ts`) in place of the manager: a GitHub account and
dither-accounts' own, with a security alert (high), a review request and a mention (normal), CI and a release
(low), and "Signal needs you" (high), there before the start, so the catch-up finds them quietly; four seconds after
the start, "Proton Mail stopped" (high) and an assignment (normal) arrive live and notify.

## Not done

- FinanceTracker's notices (it could talk to the manager as an app, or the hub could take a local POST).
- A Mute button. A hub rule mutes (`PUT /api/rules` on the account, or on the group as a conversation), but nothing on
  the page sets one, and the service's own `notify.mute` is not used.
- Asking the local model again when it was slow, as chat's late check does.
- A notice's row in Catch up or How it sorts; a feed of its own beyond the list.
- Android grouping beyond one notification per group.

Checked by `packages/hub/test/notices.test.ts` (the tiers, ingest and reads both ways, a gap, marks, the push, the
routes, asking once) and `scripts/verify-notices.ts` (the row, the page, a mark, a tap's page, a device's rule, a
phone's width, on a demo hub).

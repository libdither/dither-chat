package org.libdither.chat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.LocusId
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.StyleSpan
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Message notifications, from the hub's push payload (webpush.ts pushPayload), as the web app's sw.js shows them.
 * The push's tier says which kind it is (docs/android.md). An alert or a Conversation is a conversation notification:
 * one per conversation, its last few messages in MessagingStyle, linked to a long-lived shortcut so Android draws the
 * conversation's picture on the left with the network's mark as its badge, each a row of its own. A row of the ranked
 * list is a plain notification, all of them in one bundle that Android orders by importance.
 */
object Notifications {
    /** Alerts: the only ones that sound. The ids are older than the tiers, so the sounds set on them stay. */
    const val MESSAGES = "messages"
    /** Conversations: in the shade and on the lock screen, without sound or vibration. */
    const val QUIET = "messages-quiet"
    /** The ranked list's rows: silent too, with a channel of their own so they can be turned off alone. */
    const val LIST = "list"
    const val CALLS = "calls"
    const val UPLOADS = "uploads"
    const val REPLY = "reply"
    private const val ID = 1
    /** Every list row is in this group, under one summary whose tag this is too. */
    private const val LIST_GROUP = "dither-list"
    /** The list shows this many rows at most. */
    private const val LIST_MAX = 20
    private const val DIGEST = "dither-digest"
    /** A list row's line in the summary, kept in its extras. */
    private const val LINE = "org.libdither.chat.line"
    /** How many rows the list's summary speaks of, kept in its extras. */
    private const val COUNT = "org.libdither.chat.count"
    /** How long this app's own note of what it posted or cancelled stands in for the system's list. */
    private const val SETTLE_MS = 5_000L
    /** A time in milliseconds is taken from this for the sort key, so that the newer comes first; fourteen digits. */
    private const val MAX_TS = 99_999_999_999_999L

    private fun nm(c: Context) = c.getSystemService(NotificationManager::class.java)

    fun shortcutId(conv: String) = "conv:$conv"

    fun channels(c: Context) {
        // A channel that is there already keeps the sound and importance its owner set: only its name follows.
        nm(c).createNotificationChannels(listOf(
            NotificationChannel(MESSAGES, "Alerts", NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(QUIET, "Conversations (silent)", NotificationManager.IMPORTANCE_LOW),
            NotificationChannel(LIST, "Ranked list (silent)", NotificationManager.IMPORTANCE_LOW),
            NotificationChannel(CALLS, "Ongoing call", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
            NotificationChannel(UPLOADS, "History uploads", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
        ))
    }

    fun open(c: Context, hash: String?, code: Int): PendingIntent =
        PendingIntent.getActivity(c, code, Intent(c, MainActivity::class.java).putExtra(MainActivity.EXTRA_HASH, hash), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun show(c: Context, d: JSONObject) {
        channels(c)
        // Read on some device: its notification goes, quietly, and that is no outcome of the notification's own.
        d.optString("clear").ifEmpty { null }?.let { return clear(c, it) }
        val conv = d.optString("conversationId").ifEmpty { null }
        val inbox = d.optBoolean("inbox")
        val test = d.optBoolean("test")
        val nid = d.optString("nid").ifEmpty { null }
        val device = d.optString("device")
        outcome(c, nid, device, "delivered")
        // The page is on screen and raises its own toast from the live socket.
        if (!test && MainActivity.resumed != null) return outcome(c, nid, device, "suppressed")
        if (!nm(c).areNotificationsEnabled()) return outcome(c, nid, device, "blocked")
        // A request waiting on you (docs/add.md): a row of its own, opening it under Requests.
        val request = d.optString("requestId").ifEmpty { null }
        // A notice (docs/notices.md): its conversation is its group, and a tap opens it under Notices.
        val notice = d.optString("noticeId").ifEmpty { null }
        val tier = tierOf(d)
        // The push's id rides in the hash, so the page can say which visit the tap led to (docs/activity.md).
        val n = if (nid != null) "?n=$nid" else ""
        val hash = if (notice != null) "/notices/$notice$n" else if (conv != null) "/inbox/c/$conv$n" else if (request != null) "/requests/$request$n" else if (inbox || tier == "digest") "/inbox$n" else null
        val title = d.optString("title", "dither-chat")
        val app = c.applicationContext
        val canReply = conv != null && d.optBoolean("canReply")
        val replyTo = if (canReply) d.optString("replyTo").ifEmpty { null } else null
        val marks = marksOf(d, tier)
        // Pictures come from the hub: off the thread the push arrived on.
        Thread {
            val shown = if (tier == "digest") {
                listRow(app, conv ?: request?.let { "request:$it" } ?: "inbox", d, hash, nid, device, marks)
            } else if (notice != null) {
                // Not a conversation: no shortcut, no Conversations section. One plain notification per group (tagged
                // with it, so the hub's clear takes it away), sounding only when the hub says so.
                val look = Looks.of(app, d.optString("network"), d.optString("icon").ifEmpty { null }, title)
                post(app, conv ?: "notice:$notice", title, d.optString("body"), hash, nid = nid, device = device, look = look, quiet = !d.optBoolean("alert", true), marks = marks)
                true
            } else if (conv != null) {
                conversation(app, conv, d, tier, hash, replyTo, canReply, nid, device, marks)
                true
            } else {
                val tag = request?.let { "request:$it" } ?: if (inbox) DIGEST else "dither"
                val look = Looks.of(app, d.optString("network"), d.optString("icon").ifEmpty { null }, title)
                post(app, tag, title, d.optString("body"), hash, nid = nid, device = device, look = look, quiet = tier == "quiet")
                true
            }
            if (shown) outcome(app, nid, device, "shown")
        }.start()
    }

    /**
     * The push's tier: "push" an alert, "quiet" a Conversation, "digest" a row of the ranked list. A hub from before
     * the tiers sends only `level`, which knows the first two.
     */
    private fun tierOf(d: JSONObject): String = when (val tier = d.optString("tier")) {
        "push", "quiet", "digest" -> tier
        else -> if (d.optString("level") == "quiet") "quiet" else "push"
    }

    /**
     * What became of a notification, for the hub's activity log: its id and this push registration, never its content.
     * Android says when one is swiped away (the delete intent), which browsers mostly do not.
     */
    fun outcome(c: Context, nid: String?, device: String?, event: String) {
        if (nid == null) return
        val app = c.applicationContext
        val e = JSONObject().put("id", nid).put("device", device ?: "").put("event", event).put("at", System.currentTimeMillis())
        Thread { runCatching { Hub.request(app, "POST", "/api/activity/notifications", JSONObject().put("events", org.json.JSONArray().put(e))) } }.start()
    }

    /**
     * What you can say of a message from its notification (docs/notifications.md): it should have alerted, its alert
     * was wrong, or less like this. The last two take the row away.
     */
    enum class Mark(val id: String, val label: String, val closes: Boolean) {
        ALERT("alert", "Should have alerted", false),
        CALM("calm", "Not urgent", true),
        LESS("less", "Less like this", true);

        /** What the hub is told (POST /api/messages/:id/feedback; for mail, /api/mail/triage/:id/vote). */
        fun body(): JSONObject = when (this) {
            ALERT -> JSONObject().put("alert", true)
            CALM -> JSONObject().put("alert", false)
            LESS -> JSONObject().put("less", true)
        }

        companion object {
            fun of(id: String?): Mark? = entries.firstOrNull { it.id == id }
        }
    }

    /** The message a notification is about and the marks it offers. Mail's marks go to mail's own route. */
    class Marks(val messageId: String, val mail: Boolean, val offered: List<Mark>)

    /**
     * The marks by tier: an alert can be called not urgent, a Conversation one that should have alerted, a list row
     * either less like this or one that should have alerted. Mail has no alert marks, only "Less like this".
     */
    private fun marksOf(d: JSONObject, tier: String): Marks? {
        val id = d.optString("messageId").ifEmpty { return null }
        val mail = d.optString("mailThreadId").isNotEmpty()
        val offered = when {
            mail -> listOf(Mark.LESS)
            tier == "push" -> listOf(Mark.CALM)
            tier == "quiet" -> listOf(Mark.ALERT)
            else -> listOf(Mark.LESS, Mark.ALERT)
        }
        return Marks(id, mail, offered)
    }

    /** One message in a notification, from the payload's `lines`. */
    private class Line(val author: String, val key: String, val body: String, val ts: Long)

    /** What a push says of its chat: its name, whether it is a group, its unread lines and where its pictures are. */
    private class Chat(private val d: JSONObject) {
        private val title = d.optString("title", "dither-chat")
        private val cv = d.optJSONObject("conv")
        val group = cv != null && cv.optString("shape", "direct") != "direct"
        val name = cv?.optString("title")?.ifEmpty { null } ?: title
        private val sender = d.optJSONObject("sender")
        val senderKey = sender?.optString("key")?.ifEmpty { null } ?: title
        private val icons = d.optJSONObject("icons")
        private val now = System.currentTimeMillis()
        val lines: List<Line> = d.optJSONArray("lines")?.let { a ->
            (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { l ->
                Line(l.optString("author", "?"), l.optString("key").ifEmpty { l.optString("author", "?") }, l.optString("body"), l.optLong("ts", now))
            }
        }?.takeIf { it.isNotEmpty() }
            // An older hub sends one message as title and body, and so does a request.
            ?: listOf(Line(sender?.optString("name")?.ifEmpty { null } ?: title, senderKey, d.optString("body"), now))
        val last get() = lines.last()

        /** A line outside MessagingStyle: in a group it says who wrote it. */
        fun text(l: Line) = if (group) "${l.author}: ${l.body}" else l.body

        /** Every picture the push names. */
        fun pictures(): List<String> = buildList {
            icons?.keys()?.forEach { k -> icons.optString(k).ifEmpty { null }?.let(::add) }
            sender?.optString("icon")?.ifEmpty { null }?.let(::add)
            cv?.optString("icon")?.ifEmpty { null }?.let(::add)
            d.optString("icon").ifEmpty { null }?.let(::add)
        }

        fun iconOf(key: String): String? =
            icons?.optString(key)?.ifEmpty { null }
                ?: (if (key == senderKey) sender?.optString("icon")?.ifEmpty { null } else null)
                // An older hub's one picture is the sender's, else the conversation's.
                ?: (if (sender == null && !group) d.optString("icon").ifEmpty { null } else null)

        /** Where the chat's picture is: the group's or server's, or for a DM the person's. The first that loads is it. */
        fun icon(): List<String> =
            if (group) listOfNotNull(cv?.optString("icon")?.ifEmpty { null }) else listOfNotNull(iconOf(senderKey), iconOf(last.key))
    }

    /**
     * A conversation's notification, for an alert or a Conversation: its last few messages, each with its author as a
     * Person (name and plain round picture), linked to the conversation's shortcut. An alert is on the channel that
     * sounds and a Conversation on the silent one, the same row either way. `alert` false updates it, or posts it,
     * without sound, vibration or heads-up.
     */
    private fun conversation(c: Context, conv: String, d: JSONObject, tier: String, hash: String?, replyTo: String?, canReply: Boolean, nid: String?, device: String?, marks: Marks?) {
        val chat = Chat(d)
        val pictures = HashMap<String, Bitmap?>()
        fun picture(src: String?): Bitmap? = src?.let { pictures.getOrPut(it) { runCatching { Looks.picture(c, it) }.getOrNull() } }
        // All of them at once first: one at a time, a slow hub ran out the wait.
        pictures.putAll(Looks.pictures(c, chat.pictures()))
        val people = LinkedHashMap<String, Person>()
        fun person(l: Line): Person = people.getOrPut(l.key) {
            Person.Builder().setName(l.author).setKey(l.key).apply {
                picture(chat.iconOf(l.key))?.let { setIcon(Icon.createWithBitmap(Looks.round(it))) }
            }.build()
        }
        val me = Person.Builder().setName("You").setKey("self").build()
        val style = Notification.MessagingStyle(me).setConversationTitle(if (chat.group) chat.name else null).setGroupConversation(chat.group)
        for (l in chat.lines) style.addMessage(Notification.MessagingStyle.Message(l.body, l.ts, person(l)))

        val last = chat.last
        val pic = chat.icon().firstNotNullOfOrNull { picture(it) }
        publish(c, conv, chat.name, Looks.adaptive(pic, chat.name), people.values.toList())
        // A chat shows once: its row on the list goes.
        unlist(c, conv)

        val alert = d.optBoolean("alert", true)
        val (small, color) = Looks.badge(c, d.optString("network"))
        val sid = shortcutId(conv)
        val b = Notification.Builder(c, if (tier == "quiet") QUIET else MESSAGES)
            .setSmallIcon(small)
            .setColor(color)
            .setContentTitle(chat.name)
            .setContentText(chat.text(last))
            .setStyle(style)
            .setShortcutId(sid)
            .setLocusId(LocusId(sid))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setWhen(last.ts)
            .setShowWhen(true)
            .setContentIntent(open(c, hash, conv.hashCode()))
            .setAutoCancel(true)
            // A burst updates the text without sounding again.
            .setOnlyAlertOnce(!alert)
            // A group of its own, which never gets a summary: Android shows such a notification as a row by itself,
            // and does not gather it into a bundle of its own making as it does those without any group.
            .setGroup(sid)
        // Not even a new one may sound: a notification in a group that leaves alerting to the group's summary is
        // muted, and this group has none. setSilent (Android 12+) does exactly this; this also works on 10 and 11.
        if (!alert) b.setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
        actions(c, b, conv, nid, device, marks, canReply, replyTo, list = false)
        nm(c).notify(conv, ID, b.build())
    }

    /**
     * One long-lived shortcut per conversation: what makes Android draw a conversation notification, with the
     * conversation's picture on the left. Opening it opens the conversation.
     */
    private fun publish(c: Context, conv: String, title: String, icon: Icon, people: List<Person>) {
        val sm = c.getSystemService(ShortcutManager::class.java) ?: return
        val sid = shortcutId(conv)
        val s = ShortcutInfo.Builder(c, sid)
            .setShortLabel(title.take(25).ifEmpty { "Conversation" })
            .setLongLabel(title.ifEmpty { "Conversation" })
            .setIcon(icon)
            .setIntent(Intent(c, MainActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra(MainActivity.EXTRA_HASH, "/inbox/c/$conv"))
            .setLocusId(LocusId(sid))
            .setPersons(people.toTypedArray())
            .setLongLived(true)
            .setCategories(setOf("org.libdither.chat.category.CONVERSATION"))
            .build()
        // Android caps dynamic shortcuts at about 15 and drops the least used; those a notification uses are cached.
        if (Build.VERSION.SDK_INT >= 30) runCatching { sm.pushDynamicShortcut(s) }
        else runCatching { if (!sm.updateShortcuts(listOf(s))) sm.addDynamicShortcuts(listOf(s)) }
    }

    /**
     * A chat's row on the ranked list (a request's too): a plain notification, not a conversation's, so it stays out
     * of Android's Conversations section, in one bundle with the other rows. Android orders the bundle by the sort
     * key. False when the row is not shown, because the list is full of rows that come before it.
     */
    private fun listRow(c: Context, key: String, d: JSONObject, hash: String?, nid: String?, device: String?, marks: Marks?): Boolean {
        val chat = Chat(d)
        val tag = "list:$key"
        val last = chat.last
        val text = chat.text(last)
        val pic = chat.icon().firstNotNullOfOrNull { runCatching { Looks.picture(c, it) }.getOrNull() }
        val importance = d.optDouble("importance", 0.5).let { if (it.isNaN()) 0.5 else it }
        val row = Row(
            SpannableStringBuilder(chat.name).apply {
                setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                append("  ").append(text)
            },
            sortKey(importance, last.ts),
        )
        val (small, color) = Looks.badge(c, d.optString("network"))
        val b = Notification.Builder(c, LIST)
            .setSmallIcon(small)
            .setColor(color)
            .setContentTitle(chat.name)
            .setContentText(text)
            .setWhen(last.ts)
            .setShowWhen(true)
            .setContentIntent(open(c, hash, tag.hashCode()))
            .setAutoCancel(true)
            .setGroup(LIST_GROUP)
            .setSortKey(row.sort)
            .setOnlyAlertOnce(true)
            .addExtras(Bundle().apply { putCharSequence(LINE, row.line) })
        // Several messages are a line each; one is shown whole.
        if (chat.lines.size > 1) b.setStyle(Notification.InboxStyle().also { s -> chat.lines.forEach { s.addLine(chat.text(it)) } })
        else b.setStyle(Notification.BigTextStyle().bigText(text))
        Looks.row(c, d.optString("network"), pic, chat.name)?.let { b.setLargeIcon(Icon.createWithBitmap(it)) }
        actions(c, b, tag, nid, device, marks, false, null, list = true)
        return synchronized(changes) {
            val rows = listing(c).rows
            rows[tag] = row
            // The list is full: the rows that come last go, and a new one that would be last is not shown at all.
            val over = rows.entries.sortedBy { it.value.sort }.drop(LIST_MAX).map { it.key }
            for (t in over) {
                rows.remove(t)
                nm(c).cancel(t, ID)
                note(t, null)
            }
            val shown = tag !in over
            if (shown) {
                // A chat shows once: its conversation notification goes.
                nm(c).cancel(key, ID)
                nm(c).notify(tag, ID, b.build())
                note(tag, row)
            }
            summarize(c, rows)
            shown
        }
    }

    /**
     * Where a list row comes in its bundle, as text that sorts the way the rows should: the more important first
     * and, between two as important, the newer first.
     */
    fun sortKey(importance: Double, ts: Long): String {
        val rank = 1000 - (importance.coerceIn(0.0, 1.0) * 1000).roundToInt()
        return String.format(Locale.US, "%04d-%014d", rank, (MAX_TS - ts).coerceIn(0, MAX_TS))
    }

    /** A list row as its summary needs it: its line and its place. */
    private class Row(val line: CharSequence, val sort: String)

    /** What this app last did to a list row and when: the row it posted, or null for one it cancelled. */
    private class Change(val row: Row?, val at: Long)

    /** The list as it shows: its rows by tag, and how many rows its summary speaks of (0 without one). */
    private class Listing(val rows: HashMap<String, Row>, val count: Int)

    /** This app's own latest changes to the list, by tag; the lock for everything that changes the list. */
    private val changes = HashMap<String, Change>()

    /** How many rows this app's last summary spoke of, and when it posted it. */
    private var counted: Pair<Int, Long>? = null

    private fun note(tag: String, row: Row?) {
        changes[tag] = Change(row, SystemClock.elapsedRealtime())
    }

    /**
     * The list now showing. The system adds and removes notifications asynchronously, so for a few seconds what this
     * app itself posted or cancelled is taken from its own note of it, not from the system's list.
     */
    private fun listing(c: Context): Listing {
        val rows = HashMap<String, Row>()
        var count = 0
        for (s in nm(c).activeNotifications) {
            val n = s.notification
            if (s.id != ID || n.group != LIST_GROUP) continue
            if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) count = n.extras.getInt(COUNT)
            else rows[s.tag ?: continue] = Row(n.extras.getCharSequence(LINE) ?: continue, n.sortKey ?: continue)
        }
        val now = SystemClock.elapsedRealtime()
        changes.values.removeIf { now - it.at > SETTLE_MS }
        for ((tag, change) in changes) if (change.row != null) rows[tag] = change.row else rows.remove(tag)
        counted?.let { (rows, at) -> if (now - at <= SETTLE_MS) count = rows }
        return Listing(rows, count)
    }

    /**
     * The list's summary, which makes the rows one bundle: how many chats, and the first six in the bundle's order.
     * It never sounds. Cancelling a summary cancels its children, so it goes only once no row is left; with one row
     * the system shows that row alone.
     */
    private fun summarize(c: Context, rows: Map<String, Row>) {
        counted = rows.size to SystemClock.elapsedRealtime()
        if (rows.isEmpty()) return nm(c).cancel(LIST_GROUP, ID)
        val sorted = rows.values.sortedBy { it.sort }
        val inbox = Notification.InboxStyle()
        sorted.take(6).forEach { inbox.addLine(it.line) }
        if (sorted.size > 6) inbox.setSummaryText("+${sorted.size - 6} more")
        val b = Notification.Builder(c, LIST)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(c.getColor(R.color.accent))
            .setContentTitle(if (rows.size == 1) "1 chat" else "${rows.size} chats")
            .setContentText(sorted.first().line)
            .setStyle(inbox)
            .setContentIntent(open(c, "/inbox", LIST_GROUP.hashCode()))
            .setAutoCancel(true)
            .setGroup(LIST_GROUP)
            .setGroupSummary(true)
            .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
            .setOnlyAlertOnce(true)
            .addExtras(Bundle().apply { putInt(COUNT, rows.size) })
        nm(c).notify(LIST_GROUP, ID, b.build())
    }

    /**
     * A chat's row leaves the list: the chat was read, or it now has a conversation notification, and a chat never
     * shows twice. The summary follows, also when the system closed the row itself (a tap does, without a word).
     */
    private fun unlist(c: Context, chat: String) = synchronized(changes) {
        val tag = "list:$chat"
        val list = listing(c)
        val had = list.rows.remove(tag) != null
        nm(c).cancel(tag, ID)
        if (had) note(tag, null)
        if (had || list.rows.size != list.count) summarize(c, list.rows)
    }

    /** A notification that is neither a conversation's nor a list row: a test, a reply that did not go. */
    fun post(c: Context, tag: String, title: String, body: String, hash: String?, sticky: Boolean = false, nid: String? = null, device: String? = null, look: Looks.Look? = null, quiet: Boolean = false, marks: Marks? = null) {
        val b = Notification.Builder(c, if (quiet) QUIET else MESSAGES)
            .setSmallIcon(look?.small ?: R.drawable.ic_notification)
            .setColor(look?.color ?: c.getColor(R.color.accent))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(open(c, hash, tag.hashCode()))
            .setAutoCancel(!sticky)
        look?.large?.let { b.setLargeIcon(Icon.createWithBitmap(it)) }
        actions(c, b, tag, nid, device, marks, false, null, list = false)
        nm(c).notify(tag, ID, b.build())
    }

    /** The delete intent, Reply and the marks. */
    private fun actions(c: Context, b: Notification.Builder, tag: String, nid: String?, device: String?, marks: Marks?, canReply: Boolean, replyTo: String?, list: Boolean) {
        // A swipe is reported, and a list row's also brings the summary up to date.
        if (nid != null || list) {
            val gone = Intent(c, DismissReceiver::class.java).putExtra("nid", nid).putExtra("device", device).putExtra("tag", if (list) tag else null)
            b.setDeleteIntent(PendingIntent.getBroadcast(c, tag.hashCode(), gone, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        if (canReply) {
            val intent = Intent(c, ReplyReceiver::class.java).putExtra("conversation", tag).putExtra("replyTo", replyTo).putExtra("nid", nid).putExtra("device", device)
            // Mutable: the system writes the typed text into it.
            val pi = PendingIntent.getBroadcast(c, tag.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            b.addAction(Notification.Action.Builder(null, "Reply", pi).addRemoteInput(RemoteInput.Builder(REPLY).setLabel("Message").build()).build())
        }
        marks?.offered?.forEach { mark ->
            val intent = Intent(c, VoteReceiver::class.java).putExtra("message", marks.messageId).putExtra("mark", mark.id).putExtra("mail", marks.mail).putExtra("tag", tag)
            val pi = PendingIntent.getBroadcast(c, tag.hashCode() * 31 + mark.ordinal + 1, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            b.addAction(Notification.Action.Builder(null, mark.label, pi).build())
        }
    }

    /**
     * After a reply from the shade, the conversation stays, with what you wrote as its newest message, quietly. The
     * system keeps the notification's messages in it, so they come back from the one showing.
     */
    fun replied(c: Context, conv: String, text: String) {
        c.getSystemService(ShortcutManager::class.java)?.reportShortcutUsed(shortcutId(conv))
        val n = nm(c).activeNotifications.firstOrNull { it.tag == conv && it.id == ID }?.notification ?: return
        val b = Notification.Builder.recoverBuilder(c, n)
        val style = b.style as? Notification.MessagingStyle ?: return clear(c, conv)
        style.addMessage(Notification.MessagingStyle.Message(text, System.currentTimeMillis(), null as Person?))
        b.setOnlyAlertOnce(true).setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY).setWhen(System.currentTimeMillis())
        nm(c).notify(conv, ID, b.build())
    }

    /**
     * The hub took a mark that leaves its row there: the row stays as it was, quietly, without that button, which
     * shows the mark went and keeps it from going twice.
     */
    fun marked(c: Context, tag: String, mark: Mark) {
        val n = nm(c).activeNotifications.firstOrNull { it.tag == tag && it.id == ID }?.notification ?: return
        val b = Notification.Builder.recoverBuilder(c, n)
        b.setActions(*n.actions.orEmpty().filter { it.title?.toString() != mark.label }.toTypedArray())
        b.setOnlyAlertOnce(true).setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
        nm(c).notify(tag, ID, b.build())
    }

    /**
     * A chat read here or elsewhere: its notification goes, whichever of the two it has, and the list's summary is
     * brought up to date.
     */
    fun clear(c: Context, chat: String) {
        nm(c).cancel(chat, ID)
        unlist(c, chat)
    }

    /** One notification closed by its own button. */
    fun cancel(c: Context, tag: String) {
        nm(c).cancel(tag, ID)
        dismissed(c, tag)
    }

    /** A notification is gone. When it was a list row, the summary follows. */
    fun dismissed(c: Context, tag: String) {
        if (!tag.startsWith("list:")) return
        synchronized(changes) {
            note(tag, null)
            summarize(c, listing(c).rows)
        }
    }
}

/**
 * How a notification looks: the network's mark as the small icon (status bar and header, in the network's colour).
 * A conversation notification is drawn by the system from its shortcut's picture with that mark as a badge; the
 * others carry a picture (the sender's, or for a list row the chat's), round, with the network's badge in a corner,
 * as the large icon. sw.js draws the same for browsers. Without a picture, the title's first letter on a plain disc.
 */
object Looks {
    class Look(val small: Int, val color: Int, val large: Bitmap?)

    private val NETWORKS = mapOf(
        "discord" to (R.drawable.ic_net_discord to 0xFF5865F2.toInt()),
        "signal" to (R.drawable.ic_net_signal to 0xFF3A91F5.toInt()),
        "matrix" to (R.drawable.ic_net_matrix to 0xFF0DBD8B.toInt()),
        "whatsapp" to (R.drawable.ic_net_whatsapp to 0xFF1DAA61.toInt()),
    )
    private const val SIZE = 192
    private const val GREY = 0xFF5C6370.toInt()

    fun of(c: Context, network: String, icon: String?, title: String): Look? {
        val (glyph, color) = NETWORKS[network] ?: return null
        val pic = icon?.let { runCatching { picture(c, it) }.getOrNull() }
        val large = runCatching { draw(c, pic, glyph to color, title) }.getOrNull()
        return Look(glyph, color, large)
    }

    /** A list row's large icon: the chat's picture with the network's badge, when the network has a mark. */
    fun row(c: Context, network: String, pic: Bitmap?, title: String): Bitmap? =
        runCatching { draw(c, pic, NETWORKS[network], title) }.getOrNull()

    /** The network's mark and colour, or the app's. */
    fun badge(c: Context, network: String): Pair<Int, Int> = NETWORKS[network] ?: (R.drawable.ic_notification to c.getColor(R.color.accent))

    /**
     * A picture by its hub path, kept on disk: the same people and servers come back, and the hub can be slow to
     * fetch one it has not seen (it warms the push's pictures first, but waits for them only so long).
     */
    fun picture(c: Context, src: String): Bitmap? {
        if (src.startsWith("data:")) return Base64.decode(src.substringAfter(","), Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        val dir = File(c.cacheDir, "pictures").apply { mkdirs() }
        val file = File(dir, MessageDigest.getInstance("SHA-256").digest(src.toByteArray()).joinToString("") { "%02x".format(it) })
        if (file.isFile) BitmapFactory.decodeFile(file.path)?.let { file.setLastModified(System.currentTimeMillis()); return it }
        val bytes = Hub.bytes(c, src, 8_000) ?: return null
        val pic = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        runCatching {
            file.writeBytes(bytes)
            // Keeps the newest 300.
            dir.listFiles()?.takeIf { it.size > 300 }?.sortedByDescending { it.lastModified() }?.drop(300)?.forEach { it.delete() }
        }
        return pic
    }

    /** Several pictures at once, each fetched on its own thread, so a slow one does not hold up the others. */
    fun pictures(c: Context, srcs: Collection<String>): Map<String, Bitmap?> {
        val out = java.util.Collections.synchronizedMap(HashMap<String, Bitmap?>())
        srcs.toSet().map { src -> Thread { out[src] = runCatching { picture(c, src) }.getOrNull() }.apply { start() } }.forEach { it.join(10_000) }
        return synchronized(out) { HashMap(out) }
    }

    /**
     * The picture in a circle, for a Person: no ring and no badge, since the conversation's badge is the system's.
     * Some versions crop a message's avatar round themselves and some (the emulator's Android 15) draw it square.
     */
    fun round(pic: Bitmap, size: Int = SIZE): Bitmap {
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val g = Canvas(out)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        g.drawCircle(size / 2f, size / 2f, size / 2f, p)
        p.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
        g.saveLayer(null, p)
        cover(g, pic, RectF(0f, 0f, size.toFloat(), size.toFloat()))
        g.restore()
        return out
    }

    /**
     * A shortcut's adaptive icon: the picture in the middle 72 of 108, which the launcher's mask leaves whole, on
     * its own edges blown up; without one, the title's first letter on grey.
     */
    fun adaptive(pic: Bitmap?, title: String): Icon {
        val size = 216
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val g = Canvas(out)
        val inner = RectF(size / 6f, size / 6f, size * 5 / 6f, size * 5 / 6f)
        if (pic != null) {
            cover(g, pic, RectF(0f, 0f, size.toFloat(), size.toFloat()))
            cover(g, pic, inner)
        } else {
            g.drawColor(GREY)
            letter(g, title, size / 2f, inner.width())
        }
        return Icon.createWithAdaptiveBitmap(out)
    }

    /** Draws the picture over `to`, its shorter side filling it. */
    private fun cover(g: Canvas, pic: Bitmap, to: RectF) {
        val k = maxOf(to.width() / pic.width, to.height() / pic.height)
        val p = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        p.shader = BitmapShader(pic, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
            setLocalMatrix(Matrix().apply { setScale(k, k); postTranslate(to.centerX() - pic.width * k / 2, to.centerY() - pic.height * k / 2) })
        }
        g.drawRect(to, p)
    }

    private fun letter(g: Canvas, title: String, r: Float, size: Float) {
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.color = Color.WHITE
        p.textSize = size * 0.45f
        p.textAlign = Paint.Align.CENTER
        p.isFakeBoldText = true
        val letter = title.trim().firstOrNull()?.uppercase() ?: "?"
        g.drawText(letter, r, r - (p.descent() + p.ascent()) / 2, p)
    }

    private fun draw(c: Context, pic: Bitmap?, mark: Pair<Int, Int>?, title: String): Bitmap {
        val out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
        val g = Canvas(out)
        val r = SIZE / 2f
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        if (pic != null) {
            // Cover: the shorter side fills the circle.
            val k = SIZE.toFloat() / minOf(pic.width, pic.height)
            p.shader = BitmapShader(pic, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
                setLocalMatrix(Matrix().apply { setScale(k, k); postTranslate((SIZE - pic.width * k) / 2, (SIZE - pic.height * k) / 2) })
            }
            g.drawCircle(r, r, r, p)
            p.shader = null
        } else {
            p.color = GREY
            g.drawCircle(r, r, r, p)
            letter(g, title, r, SIZE.toFloat())
        }
        // The badge: the network's colour behind its white mark, ringed so it stands off any picture.
        val (glyph, color) = mark ?: return out
        val b = SIZE * 0.2f
        val x = SIZE - b
        p.color = Color.WHITE
        g.drawCircle(x, x, b + SIZE * 0.025f, p)
        p.color = color
        g.drawCircle(x, x, b, p)
        val half = (b * 0.6f).toInt()
        c.getDrawable(glyph)?.mutate()?.apply {
            setTint(Color.WHITE)
            setBounds((x - half).toInt(), (x - half).toInt(), (x + half).toInt(), (x + half).toInt())
            draw(g)
        }
        return out
    }
}

/**
 * A reply typed into a notification goes through the hub's ordinary send, which decides whether it may go out at
 * all, as sw.js does in a browser. Sent, it joins the conversation's notification; on failure what was typed stays
 * readable in the notification.
 */
class ReplyReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        val conv = intent.getStringExtra("conversation") ?: return
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifications.REPLY)?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        val replyTo = intent.getStringExtra("replyTo")
        val done = goAsync()
        Thread {
            try {
                val body = JSONObject().put("body", text)
                if (replyTo != null) body.put("replyTo", replyTo)
                val (code, res) = runCatching { Hub.request(c, "POST", "/api/conversations/$conv/send", body, 60_000) }.getOrElse { 0 to "" }
                if (code in 200..299) {
                    Notifications.outcome(c, intent.getStringExtra("nid"), intent.getStringExtra("device"), "replied")
                    Notifications.replied(c, conv, text)
                } else {
                    val why = if (code == 0) "Could not reach the hub" else Hub.errorOf(res).ifEmpty { "The hub answered $code" }
                    Notifications.post(c, conv, "Reply not sent", "$why. You wrote: $text".take(1000), "/inbox/c/$conv", sticky = true)
                }
            } finally {
                done.finish()
            }
        }.start()
    }
}

/** A notification swiped away. Tapping one does not come here: auto-cancel on a tap is not a dismissal. */
class DismissReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        Notifications.outcome(c, intent.getStringExtra("nid"), intent.getStringExtra("device"), "dismissed")
        intent.getStringExtra("tag")?.let { Notifications.dismissed(c, it) }
    }
}

/**
 * A mark from the shade (docs/notifications.md): the hub learns from it. "Not urgent" and "Less like this" take the
 * row away at once; after "Should have alerted" the row stays, without that button once the hub has the mark. Mail
 * keeps its marks itself, on its own route.
 */
class VoteReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        val message = intent.getStringExtra("message") ?: return
        val mark = Notifications.Mark.of(intent.getStringExtra("mark")) ?: return
        val tag = intent.getStringExtra("tag")
        if (mark.closes && tag != null) Notifications.cancel(c, tag)
        val path = if (intent.getBooleanExtra("mail", false)) "/api/mail/triage/$message/vote" else "/api/messages/$message/feedback"
        val done = goAsync()
        Thread {
            try {
                val code = runCatching { Hub.request(c, "POST", path, mark.body()).first }.getOrDefault(0)
                if (code in 200..299 && !mark.closes && tag != null) Notifications.marked(c, tag, mark)
            } finally {
                done.finish()
            }
        }.start()
    }
}

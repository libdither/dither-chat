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
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.StyleSpan
import android.util.Base64
import org.json.JSONObject

/**
 * Message notifications, from the hub's push payload (webpush.ts pushPayload), as the web app's sw.js shows them.
 * A message is a conversation notification (docs/android.md): one per conversation, its last few messages in
 * MessagingStyle, linked to a long-lived shortcut so Android draws the conversation's picture on the left with the
 * network's mark as its badge, all in one group with a summary.
 */
object Notifications {
    const val MESSAGES = "messages"
    /** Active (docs/notifications.md): in the shade and on the lock screen, without sound or vibration. */
    const val QUIET = "messages-quiet"
    const val CALLS = "calls"
    const val UPLOADS = "uploads"
    const val REPLY = "reply"
    private const val ID = 1
    /** Every conversation notification, under one summary. */
    private const val GROUP = "dither-messages"
    private const val SUMMARY = "dither-summary"
    private const val DIGEST = "dither-digest"
    /** A conversation notification's line in the summary, kept in its extras. */
    private const val LINE = "org.libdither.chat.line"

    private fun nm(c: Context) = c.getSystemService(NotificationManager::class.java)

    fun shortcutId(conv: String) = "conv:$conv"

    fun channels(c: Context) {
        nm(c).createNotificationChannels(listOf(
            NotificationChannel(MESSAGES, "Important messages", NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(QUIET, "Active messages (silent)", NotificationManager.IMPORTANCE_LOW),
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
        // A request waiting on you (docs/add.md): a notification of its own, opening it under Requests.
        val request = d.optString("requestId").ifEmpty { null }
        val tag = conv ?: request?.let { "request:$it" } ?: if (inbox) DIGEST else "dither"
        // The push's id rides in the hash, so the page can say which visit the tap led to (docs/activity.md).
        val n = if (nid != null) "?n=$nid" else ""
        val hash = if (conv != null) "/inbox/c/$conv$n" else if (request != null) "/requests/$request$n" else if (inbox) "/inbox$n" else null
        val title = d.optString("title", "dither-chat")
        val app = c.applicationContext
        val canReply = conv != null && d.optBoolean("canReply")
        val replyTo = if (canReply) d.optString("replyTo").ifEmpty { null } else null
        // Pictures come from the hub: off the thread the push arrived on.
        Thread {
            val vote = d.optString("messageId").ifEmpty { null }?.let { Vote(it, d.optString("level", "push")) }
            if (conv != null) {
                conversation(app, conv, d, hash, replyTo, canReply, nid, device, vote)
            } else {
                val look = Looks.of(app, d.optString("network"), d.optString("icon").ifEmpty { null }, title)
                post(app, tag, title, d.optString("body"), hash, null, false, nid = nid, device = device, look = look, vote = vote, group = if (inbox) DIGEST else null, level = d.optString("level").ifEmpty { null })
            }
            outcome(app, nid, device, "shown")
        }.start()
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

    /** The message a notification is about and its level, so it can be voted up or down from the shade. */
    data class Vote(val messageId: String, val level: String)

    /** One message in a conversation notification, from the payload's `lines`. */
    private class Line(val author: String, val key: String, val body: String, val ts: Long)

    /**
     * A conversation's notification: its last few messages, each with its author as a Person (name and plain round
     * picture), linked to the conversation's shortcut. `alert` false updates it, or
     * posts it, without sound, vibration or heads-up.
     */
    private fun conversation(c: Context, conv: String, d: JSONObject, hash: String?, replyTo: String?, canReply: Boolean, nid: String?, device: String?, vote: Vote?) {
        val title = d.optString("title", "dither-chat")
        val cv = d.optJSONObject("conv")
        val group = cv != null && cv.optString("shape", "direct") != "direct"
        val convTitle = cv?.optString("title")?.ifEmpty { null } ?: title
        val sender = d.optJSONObject("sender")
        val senderKey = sender?.optString("key")?.ifEmpty { null } ?: title
        val icons = d.optJSONObject("icons")
        val now = System.currentTimeMillis()
        val lines = d.optJSONArray("lines")?.let { a ->
            (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { l ->
                Line(l.optString("author", "?"), l.optString("key").ifEmpty { l.optString("author", "?") }, l.optString("body"), l.optLong("ts", now))
            }
        }?.takeIf { it.isNotEmpty() }
            // An older hub sends one message as title and body.
            ?: listOf(Line(sender?.optString("name")?.ifEmpty { null } ?: title, senderKey, d.optString("body"), now))

        val pictures = HashMap<String, Bitmap?>()
        fun picture(src: String?): Bitmap? = src?.let { pictures.getOrPut(it) { runCatching { Looks.picture(c, it) }.getOrNull() } }
        fun iconOf(key: String): String? =
            icons?.optString(key)?.ifEmpty { null }
                ?: (if (key == senderKey) sender?.optString("icon")?.ifEmpty { null } else null)
                // An older hub's one picture is the sender's, else the conversation's.
                ?: (if (sender == null && !group) d.optString("icon").ifEmpty { null } else null)
        val people = LinkedHashMap<String, Person>()
        fun person(l: Line): Person = people.getOrPut(l.key) {
            Person.Builder().setName(l.author).setKey(l.key).apply {
                picture(iconOf(l.key))?.let { setIcon(Icon.createWithBitmap(Looks.round(it))) }
            }.build()
        }
        val me = Person.Builder().setName("You").setKey("self").build()
        val style = Notification.MessagingStyle(me).setConversationTitle(if (group) convTitle else null).setGroupConversation(group)
        for (l in lines) style.addMessage(Notification.MessagingStyle.Message(l.body, l.ts, person(l)))

        // The conversation's picture: the group's or server's, or for a DM the person's.
        val last = lines.last()
        val pic = if (group) picture(cv?.optString("icon")?.ifEmpty { null }) else picture(iconOf(senderKey)) ?: picture(iconOf(last.key))
        publish(c, conv, convTitle, Looks.adaptive(pic, convTitle), people.values.toList())

        val quiet = vote?.level == "quiet"
        val alert = d.optBoolean("alert", true)
        val (small, color) = Looks.badge(c, d.optString("network"))
        val line = SpannableStringBuilder(convTitle).apply {
            setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            append("  ").append(if (group) "${last.author}: ${last.body}" else last.body)
        }
        val sid = shortcutId(conv)
        val b = Notification.Builder(c, if (quiet) QUIET else MESSAGES)
            .setSmallIcon(small)
            .setColor(color)
            .setContentTitle(convTitle)
            .setContentText(if (group) "${last.author}: ${last.body}" else last.body)
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
            .setGroup(GROUP)
            .addExtras(Bundle().apply { putCharSequence(LINE, line) })
        // Not even a new one may sound: a child that leaves alerting to its summary (whose behaviour is to leave it to
        // the children) is muted. setSilent (Android 12+) does exactly this; this also works on 10 and 11.
        if (!alert) b.setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
        actions(c, b, conv, nid, device, vote, canReply, replyTo, dismissTag = conv)
        val built = b.build()
        nm(c).notify(conv, ID, built)
        summary(c, conv, line, built.channelId)
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
     * The group's summary: one line per conversation showing, posted once there are two. It never sounds; its
     * children do. With one left the system shows that one alone, so the summary only goes with the last.
     */
    private fun summary(c: Context, changed: String?, line: CharSequence?, channel: String? = null) {
        val nm = nm(c)
        class Row(val line: CharSequence, val time: Long, val channel: String)
        val rows = HashMap<String, Row>()
        // The system adds and removes notifications asynchronously, so what just changed is taken from the caller.
        for (s in nm.activeNotifications) {
            val n = s.notification
            if (s.id != ID || n.group != GROUP || n.flags and Notification.FLAG_GROUP_SUMMARY != 0 || s.tag == changed) continue
            rows[s.tag] = Row(n.extras.getCharSequence(LINE) ?: continue, n.`when`, n.channelId)
        }
        if (changed != null && line != null) rows[changed] = Row(line, Long.MAX_VALUE, channel ?: MESSAGES)
        if (rows.isEmpty()) return nm.cancel(SUMMARY, ID)
        // Cancelling a summary cancels its children, so with one child left it stays, and the system hides it.
        if (rows.size < 2) return
        val sorted = rows.values.sortedByDescending { it.time }
        val inbox = Notification.InboxStyle()
        sorted.take(6).forEach { inbox.addLine(it.line) }
        if (sorted.size > 6) inbox.setSummaryText("+${sorted.size - 6} more")
        val b = Notification.Builder(c, if (sorted.any { it.channel == MESSAGES }) MESSAGES else QUIET)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(c.getColor(R.color.accent))
            .setContentTitle("${rows.size} conversations")
            .setContentText(sorted.first().line)
            .setStyle(inbox)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(open(c, "/inbox", SUMMARY.hashCode()))
            .setAutoCancel(true)
            .setGroup(GROUP)
            .setGroupSummary(true)
            .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
            .setOnlyAlertOnce(true)
        nm.notify(SUMMARY, ID, b.build())
    }

    /** A notification that is not a conversation's: the digest, a test, a reply that did not go. */
    fun post(c: Context, tag: String, title: String, body: String, hash: String?, replyTo: String?, canReply: Boolean, sticky: Boolean = false, nid: String? = null, device: String? = null, look: Looks.Look? = null, vote: Vote? = null, group: String? = null, level: String? = null) {
        // Active: the silent channel, with or without votes (a request's has none).
        val quiet = (vote?.level ?: level) == "quiet"
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
        group?.let { b.setGroup(it) }
        actions(c, b, tag, nid, device, vote, canReply, replyTo, dismissTag = null)
        nm(c).notify(tag, ID, b.build())
    }

    /** The delete intent, the votes and Reply. */
    private fun actions(c: Context, b: Notification.Builder, tag: String, nid: String?, device: String?, vote: Vote?, canReply: Boolean, replyTo: String?, dismissTag: String?) {
        if (nid != null || dismissTag != null) {
            val gone = Intent(c, DismissReceiver::class.java).putExtra("nid", nid).putExtra("device", device).putExtra("tag", dismissTag)
            b.setDeleteIntent(PendingIntent.getBroadcast(c, tag.hashCode(), gone, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        val quiet = vote?.level == "quiet"
        // Up and down a level from the shade (docs/notifications.md). Active: up to Important or down to the digest,
        // before Reply. Important: Reply, then down to Active, or up, which says it was right.
        val votes = when (vote?.level) {
            "quiet" -> listOf("up" to "▲ Important", "down" to "▼ Digest")
            "push" -> listOf("down" to "▼ Active", "up" to "✓ Right")
            else -> emptyList()
        }
        fun addVotes() = votes.forEachIndexed { i, (dir, label) ->
            val intent = Intent(c, VoteReceiver::class.java).putExtra("message", vote!!.messageId).putExtra("vote", dir).putExtra("tag", tag)
            val pi = PendingIntent.getBroadcast(c, tag.hashCode() * 31 + i + 1, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            b.addAction(Notification.Action.Builder(null, label, pi).build())
        }
        if (quiet) addVotes()
        if (canReply) {
            val intent = Intent(c, ReplyReceiver::class.java).putExtra("conversation", tag).putExtra("replyTo", replyTo).putExtra("nid", nid).putExtra("device", device)
            // Mutable: the system writes the typed text into it.
            val pi = PendingIntent.getBroadcast(c, tag.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            b.addAction(Notification.Action.Builder(null, "Reply", pi).addRemoteInput(RemoteInput.Builder(REPLY).setLabel("Message").build()).build())
        }
        if (!quiet) addVotes()
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
        val title = style.conversationTitle ?: style.messages.lastOrNull { it.senderPerson != null }?.senderPerson?.name ?: ""
        val line = SpannableStringBuilder(title).apply {
            setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            append("  You: ").append(text)
        }
        b.setOnlyAlertOnce(true).setWhen(System.currentTimeMillis()).addExtras(Bundle().apply { putCharSequence(LINE, line) })
        nm(c).notify(conv, ID, b.build())
        summary(c, conv, line, n.channelId)
    }

    /** A notification closed by the app (read here or elsewhere, voted on), and the summary without it. */
    fun clear(c: Context, tag: String) {
        nm(c).cancel(tag, ID)
        dismissed(c, tag)
    }

    /** A conversation notification is gone: the summary follows. */
    fun dismissed(c: Context, tag: String) = summary(c, tag, null)
}

/**
 * How a notification looks: the network's mark as the small icon (status bar and header, in the network's colour).
 * A conversation notification is drawn by the system from its shortcut's picture with that mark as a badge; the
 * others carry the sender's picture, round, with the network's badge in a corner, as the large icon. sw.js draws the
 * same for browsers. Without a picture, the title's first letter on a plain disc.
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
        val large = runCatching { draw(c, pic, glyph, color, title) }.getOrNull()
        return Look(glyph, color, large)
    }

    /** The network's mark and colour, or the app's. */
    fun badge(c: Context, network: String): Pair<Int, Int> = NETWORKS[network] ?: (R.drawable.ic_notification to c.getColor(R.color.accent))

    fun picture(c: Context, src: String): Bitmap? {
        val bytes = if (src.startsWith("data:")) Base64.decode(src.substringAfter(","), Base64.DEFAULT) else Hub.bytes(c, src, 4_000) ?: return null
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
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

    private fun draw(c: Context, pic: Bitmap?, glyph: Int, color: Int, title: String): Bitmap {
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
                    Notifications.post(c, conv, "Reply not sent", "$why. You wrote: $text".take(1000), "/inbox/c/$conv", null, false, sticky = true)
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

/** A vote from the shade (docs/notifications.md): the hub moves the message a level and learns from it. */
class VoteReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        val message = intent.getStringExtra("message") ?: return
        val vote = intent.getStringExtra("vote") ?: return
        intent.getStringExtra("tag")?.let { Notifications.clear(c, it) }
        val done = goAsync()
        Thread {
            try {
                runCatching { Hub.request(c, "POST", "/api/messages/$message/feedback", JSONObject().put("vote", vote)) }
            } finally {
                done.finish()
            }
        }.start()
    }
}

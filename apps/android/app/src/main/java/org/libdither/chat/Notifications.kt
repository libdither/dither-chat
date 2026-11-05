package org.libdither.chat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.drawable.Icon
import android.util.Base64
import org.json.JSONObject

/** Message notifications, from the hub's push payload (webpush.ts pushPayload), as the web app's sw.js shows them. */
object Notifications {
    const val MESSAGES = "messages"
    /** Active (docs/notifications.md): in the shade and on the lock screen, without sound or vibration. */
    const val QUIET = "messages-quiet"
    const val CALLS = "calls"
    const val REPLY = "reply"
    private const val ID = 1

    private fun nm(c: Context) = c.getSystemService(NotificationManager::class.java)

    fun channels(c: Context) {
        nm(c).createNotificationChannels(listOf(
            NotificationChannel(MESSAGES, "Important messages", NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(QUIET, "Active messages (silent)", NotificationManager.IMPORTANCE_LOW),
            NotificationChannel(CALLS, "Ongoing call", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
        ))
    }

    fun open(c: Context, hash: String?, code: Int): PendingIntent =
        PendingIntent.getActivity(c, code, Intent(c, MainActivity::class.java).putExtra(MainActivity.EXTRA_HASH, hash), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun show(c: Context, d: JSONObject) {
        channels(c)
        val conv = d.optString("conversationId").ifEmpty { null }
        val inbox = d.optBoolean("inbox")
        val test = d.optBoolean("test")
        val nid = d.optString("nid").ifEmpty { null }
        val device = d.optString("device")
        outcome(c, nid, device, "delivered")
        // The page is on screen and raises its own toast from the live socket.
        if (!test && MainActivity.resumed != null) return outcome(c, nid, device, "suppressed")
        if (!nm(c).areNotificationsEnabled()) return outcome(c, nid, device, "blocked")
        val tag = conv ?: if (inbox) "dither-digest" else "dither"
        // The push's id rides in the hash, so the page can say which visit the tap led to (docs/activity.md).
        val n = if (nid != null) "?n=$nid" else ""
        val hash = if (conv != null) "/inbox/c/$conv$n" else if (inbox) "/inbox$n" else null
        val title = d.optString("title", "dither-chat")
        val app = c.applicationContext
        // The sender's picture comes from the hub: off the thread the push arrived on.
        Thread {
            val look = Looks.of(app, d.optString("network"), d.optString("icon").ifEmpty { null }, title)
            val vote = d.optString("messageId").ifEmpty { null }?.let { Vote(it, d.optString("level", "push")) }
            post(app, tag, title, d.optString("body"), hash, if (conv != null && d.optBoolean("canReply")) d.optString("replyTo").ifEmpty { null } else null, conv != null && d.optBoolean("canReply"), nid = nid, device = device, look = look, vote = vote)
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

    fun post(c: Context, tag: String, title: String, body: String, hash: String?, replyTo: String?, canReply: Boolean, sticky: Boolean = false, nid: String? = null, device: String? = null, look: Looks.Look? = null, vote: Vote? = null) {
        val quiet = vote?.level == "quiet"
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
        if (nid != null) {
            val gone = Intent(c, DismissReceiver::class.java).putExtra("nid", nid).putExtra("device", device)
            b.setDeleteIntent(PendingIntent.getBroadcast(c, tag.hashCode(), gone, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
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
        nm(c).notify(tag, ID, b.build())
    }

    fun clear(c: Context, tag: String) = nm(c).cancel(tag, ID)
}

/**
 * How a message notification looks: the network's mark as the small icon (status bar and header, in the network's
 * colour), and the sender's picture, round, with the network's badge in a corner as the large icon. sw.js draws the
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

    fun of(c: Context, network: String, icon: String?, title: String): Look? {
        val (glyph, color) = NETWORKS[network] ?: return null
        val pic = icon?.let { runCatching { picture(c, it) }.getOrNull() }
        val large = runCatching { draw(c, pic, glyph, color, title) }.getOrNull()
        return Look(glyph, color, large)
    }

    private fun picture(c: Context, src: String): Bitmap? {
        val bytes = if (src.startsWith("data:")) Base64.decode(src.substringAfter(","), Base64.DEFAULT) else Hub.bytes(c, src, 4_000) ?: return null
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
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
            p.color = 0xFF5C6370.toInt()
            g.drawCircle(r, r, r, p)
            p.color = Color.WHITE
            p.textSize = SIZE * 0.45f
            p.textAlign = Paint.Align.CENTER
            p.isFakeBoldText = true
            val letter = title.trim().firstOrNull()?.uppercase() ?: "?"
            g.drawText(letter, r, r - (p.descent() + p.ascent()) / 2, p)
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
 * all, as sw.js does in a browser. On failure what was typed stays readable in the notification.
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
                    Notifications.clear(c, conv)
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

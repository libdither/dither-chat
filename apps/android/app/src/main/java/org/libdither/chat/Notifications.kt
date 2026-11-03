package org.libdither.chat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject

/** Message notifications, from the hub's push payload (webpush.ts pushPayload), as the web app's sw.js shows them. */
object Notifications {
    const val MESSAGES = "messages"
    const val CALLS = "calls"
    const val REPLY = "reply"
    private const val ID = 1

    private fun nm(c: Context) = c.getSystemService(NotificationManager::class.java)

    fun channels(c: Context) {
        nm(c).createNotificationChannels(listOf(
            NotificationChannel(MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH),
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
        // The page is on screen and raises its own toast from the live socket.
        if (!test && MainActivity.resumed != null) return
        val tag = conv ?: if (inbox) "dither-digest" else "dither"
        val hash = if (conv != null) "/inbox/c/$conv" else if (inbox) "/inbox" else null
        post(c, tag, d.optString("title", "dither-chat"), d.optString("body"), hash, if (conv != null && d.optBoolean("canReply")) d.optString("replyTo").ifEmpty { null } else null, conv != null && d.optBoolean("canReply"))
    }

    fun post(c: Context, tag: String, title: String, body: String, hash: String?, replyTo: String?, canReply: Boolean, sticky: Boolean = false) {
        val b = Notification.Builder(c, MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(c.getColor(R.color.accent))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(open(c, hash, tag.hashCode()))
            .setAutoCancel(!sticky)
        if (canReply) {
            val intent = Intent(c, ReplyReceiver::class.java).putExtra("conversation", tag).putExtra("replyTo", replyTo)
            // Mutable: the system writes the typed text into it.
            val pi = PendingIntent.getBroadcast(c, tag.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            b.addAction(Notification.Action.Builder(null, "Reply", pi).addRemoteInput(RemoteInput.Builder(REPLY).setLabel("Message").build()).build())
        }
        nm(c).notify(tag, ID, b.build())
    }

    fun clear(c: Context, tag: String) = nm(c).cancel(tag, ID)
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
                if (code in 200..299) Notifications.clear(c, conv)
                else {
                    val why = if (code == 0) "Could not reach the hub" else Hub.errorOf(res).ifEmpty { "The hub answered $code" }
                    Notifications.post(c, conv, "Reply not sent", "$why. You wrote: $text".take(1000), "/inbox/c/$conv", null, false, sticky = true)
                }
            } finally {
                done.finish()
            }
        }.start()
    }
}

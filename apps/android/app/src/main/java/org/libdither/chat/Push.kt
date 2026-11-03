package org.libdither.chat

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Push through UnifiedPush. A WebView has no Push API, so the page cannot subscribe as a browser does. Instead a
 * distributor app (ntfy, say) holds one connection for every app that uses it, and gives this app an endpoint plus
 * RFC 8291 keys: the same shape as a browser subscription. The app registers it with the hub itself, so a new
 * endpoint (distributors rotate them) reaches the hub even while the page is closed.
 */
object Push {
    private const val TAG = "DitherPush"
    const val INSTANCE = "default"
    var vapid: String? = null
    private val main = Handler(Looper.getMainLooper())

    fun error(msg: String): JSONObject = JSONObject().put("t", "push.error").put("error", msg)

    fun status(c: Context): JSONObject {
        val p = Hub.prefs(c)
        val o = JSONObject().put("t", "push")
        val endpoint = p.getString("push.endpoint", null) ?: return o.put("endpoint", JSONObject.NULL)
        return o.put("endpoint", endpoint).put("p256dh", p.getString("push.p256dh", "")).put("auth", p.getString("push.auth", ""))
    }

    fun register(c: Context) = UnifiedPush.register(c, INSTANCE, "dither-chat", vapid)

    fun unregister(c: Context) {
        UnifiedPush.unregister(c, INSTANCE)
        forget(c)
        toPage(status(c))
    }

    /** On the main thread, to whichever page is open. */
    fun toPage(o: JSONObject) {
        main.post { MainActivity.current?.bridge?.send(o) }
    }

    private fun forget(c: Context) {
        val p = Hub.prefs(c)
        val old = p.getString("push.endpoint", null) ?: return
        p.edit().remove("push.endpoint").remove("push.p256dh").remove("push.auth").apply()
        Thread { runCatching { Hub.request(c, "POST", "/api/push/unsubscribe", JSONObject().put("endpoint", old)) } }.start()
    }

    fun onEndpoint(c: Context, e: PushEndpoint) {
        val keys = e.pubKeySet ?: return toPage(error("The distributor gave no encryption keys."))
        val p = Hub.prefs(c)
        val old = p.getString("push.endpoint", null)
        Thread {
            val sub = JSONObject().put("endpoint", e.url).put("keys", JSONObject().put("p256dh", keys.pubKey).put("auth", keys.auth))
            val (code, text) = runCatching { Hub.request(c, "POST", "/api/push/subscribe", JSONObject().put("subscription", sub).put("label", "Android app, ${Build.MODEL}")) }
                .getOrElse { 0 to (it.message ?: "network error") }
            if (code !in 200..299) {
                Log.w(TAG, "the hub refused the endpoint: $code")
                // The hub names the push server it does not send to yet; the page offers to allow it.
                val refusal = runCatching { JSONObject(text) }.getOrNull()
                val o = error("The hub did not take this device's endpoint: ${Hub.errorOf(text)}")
                refusal?.optString("server")?.takeIf { it.isNotEmpty() }?.let { o.put("server", it).put("http", refusal.optBoolean("http")) }
                return@Thread toPage(o)
            }
            p.edit().putString("push.endpoint", e.url).putString("push.p256dh", keys.pubKey).putString("push.auth", keys.auth).apply()
            if (old != null && old != e.url) runCatching { Hub.request(c, "POST", "/api/push/unsubscribe", JSONObject().put("endpoint", old)) }
            toPage(status(c))
        }.start()
    }

    fun onFailed(c: Context, reason: FailedReason) {
        toPage(error(when (reason) {
            FailedReason.NETWORK -> "The distributor could not reach its server. Try again when online."
            FailedReason.ACTION_REQUIRED -> "The distributor needs something from you first: open it."
            FailedReason.VAPID_REQUIRED -> "The distributor wants a VAPID key, and the hub sent none."
            else -> "The distributor refused ($reason)."
        }).also { o ->
            val pkg = UnifiedPush.getAckDistributor(c) ?: UnifiedPush.getSavedDistributor(c)
            if (reason == FailedReason.ACTION_REQUIRED && pkg != null) o.put("action", "open").put("pkg", pkg)
        })
    }

    fun onUnregistered(c: Context) {
        forget(c)
        toPage(status(c))
    }
}

/** The connector's callbacks. It has already decrypted the message with this app's keys. */
class PushReceiver : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) = Push.onEndpoint(this, endpoint)

    override fun onMessage(message: PushMessage, instance: String) {
        if (!message.decrypted) {
            Log.w("DitherPush", "dropped a push that was not encrypted for this app")
            return
        }
        val d = runCatching { JSONObject(String(message.content)) }.getOrNull() ?: return
        Notifications.show(this, d)
        // A test asks to be confirmed, so Settings can tell "ntfy took it" from "it reached the phone".
        val device = d.optString("device")
        if (d.optBoolean("test") && device.isNotEmpty()) {
            val app = applicationContext
            Thread { runCatching { Hub.request(app, "POST", "/api/push/arrived", JSONObject().put("id", device)) } }.start()
        }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) = Push.onFailed(this, reason)

    override fun onUnregistered(instance: String) = Push.onUnregistered(this)
}

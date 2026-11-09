package org.libdither.chat

import android.app.NotificationManager
import android.net.Uri
import android.os.PowerManager
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush

/**
 * The page's side is packages/web/src/android.ts. Registered with an allowed-origin rule of the hub's origin only, so
 * no other page, frame or redirect target can post here; the check below repeats it. Runs on the main thread.
 */
class Bridge(private val activity: MainActivity, private val origin: Uri) : WebViewCompat.WebMessageListener {
    private var proxy: JavaScriptReplyProxy? = null
    private val queue = ArrayList<String>()

    override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
        if (!isMainFrame || !Hub.sameOrigin(sourceOrigin, origin)) return
        val m = runCatching { JSONObject(message.data ?: return) }.getOrNull() ?: return
        when (m.optString("t")) {
            "hello" -> {
                // A new page (first load, or a reload for an update): it replaces the old one's channel.
                proxy = replyProxy
                send(info())
                send(Push.status(activity))
                send(Uploads.state(activity))
                queue.forEach(replyProxy::postMessage)
                queue.clear()
            }
            "ready" -> activity.onPageTiming("content", m.optLong("ms"), m.optString("source"))
            "fresh" -> activity.onPageTiming("fresh from the hub", m.optLong("ms"), null)
            "probe" -> activity.onProbe(m.optLong("ms"), m.optLong("at"), m.optLong("origin"))
            "call" -> activity.onCall(m)
            "audio.get" -> send(Audio.state(activity))
            "audio.set" -> {
                Audio.select(activity, m.optInt("id"))
                send(Audio.state(activity))
            }
            "push.register" -> activity.registerPush(m.optString("vapid"))
            "push.unregister" -> Push.unregister(activity)
            "push.status" -> send(Push.status(activity))
            "theme" -> activity.onTheme(m.optString("bg"))
            "hub.change" -> activity.changeHub()
            "open" -> activity.openForPage(m.optString("what"), m.optString("pkg").ifEmpty { null })
            "upload.pick" -> activity.pickUpload(m.optString("accountId"), m.optString("mode"))
            "upload.pause" -> UploadService.pause(activity)
            "upload.resume" -> activity.resumeUpload()
            "upload.forget" -> activity.forgetUpload()
            "upload.status" -> send(Uploads.state(activity))
            "file" -> activity.openFileForPage(m.optString("url"), m.optString("name").ifEmpty { null }, m.optString("mime").ifEmpty { null })
        }
    }

    /** A distributor may have been installed meanwhile: the page hears again on every return to the app. */
    fun resumed() {
        if (proxy != null) send(info())
    }

    /** Version, the UnifiedPush distributors and whether Android lets them run in the background, and what can be opened. */
    private fun info(): JSONObject {
        val power = activity.getSystemService(PowerManager::class.java)
        val distributors = JSONArray()
        for (pkg in UnifiedPush.getDistributors(activity)) {
            distributors.put(JSONObject().put("pkg", pkg).put("label", activity.appLabel(pkg)).put("batteryOk", power.isIgnoringBatteryOptimizations(pkg)))
        }
        return JSONObject()
            .put("t", "info")
            .put("version", activity.packageManager.getPackageInfo(activity.packageName, 0).versionName)
            .put("distributors", distributors)
            .put("current", UnifiedPush.getAckDistributor(activity) ?: UnifiedPush.getSavedDistributor(activity) ?: JSONObject.NULL)
            .put("notifications", activity.getSystemService(NotificationManager::class.java).areNotificationsEnabled())
            .put("opens", JSONArray(listOf("app", "appInfo", "notifications", "file", "upload")))
    }

    /** To the page, or held until it says hello. */
    fun send(o: JSONObject) {
        val s = o.toString()
        proxy?.postMessage(s) ?: queue.add(s)
    }
}

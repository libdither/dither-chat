package org.libdither.chat

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import org.json.JSONObject

/**
 * Debug builds only (src/debug): shows a push payload as if it had come through UnifiedPush, for trying
 * notifications on an emulator (docs/android.md). `b64` is the payload's JSON in base64; `hub` sets the hub's origin;
 * `cancel` cancels the notification with that tag, as the app alone could.
 *
 *   adb shell am broadcast -a org.libdither.chat.DEBUG_PUSH -n org.libdither.chat/.DebugPushReceiver --es b64 <base64>
 */
class DebugPushReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        intent.getStringExtra("hub")?.let { Hub.setOrigin(c, Uri.parse(it)) }
        intent.getStringExtra("cancel")?.let { c.getSystemService(NotificationManager::class.java).cancel(it, 1) }
        val b64 = intent.getStringExtra("b64") ?: return
        Notifications.show(c, JSONObject(String(Base64.decode(b64, Base64.DEFAULT))))
    }
}

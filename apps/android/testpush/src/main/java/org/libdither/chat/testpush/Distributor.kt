package org.libdither.chat.testpush

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Base64
import android.util.Log
import java.util.UUID

/**
 * A UnifiedPush distributor with no server of its own, for the emulator tests (build.gradle.kts says why). What the
 * app's connector sends it, and what it answers, as the ntfy app would:
 *
 * - REGISTER (token, application, vapid): the endpoint `<server>/up/<token>` comes back to the app as NEW_ENDPOINT;
 * - UNREGISTER (token): UNREGISTERED back, and the token is forgotten;
 * - MESSAGE_ACK: the app had a message; nothing to do.
 *
 * And the test's two commands, from adb's shell:
 *
 *   am broadcast --include-stopped-packages -n org.libdither.chat.testpush/.Distributor \
 *     -a org.libdither.chat.testpush.SERVER --es url http://127.0.0.1:<port>
 *   am broadcast -n org.libdither.chat.testpush/.Distributor -a org.libdither.chat.testpush.DELIVER \
 *     --es token <token> --es b64 <the Web Push request's body, base64>
 *
 * SERVER names where the test's push server listens (it must come before REGISTER), and its broadcast also takes this
 * app out of the stopped state a fresh install is in, which no broadcast from the connector would. DELIVER hands one
 * encrypted body to the app registered with that token, as MESSAGE; the connector decrypts it with the app's keys.
 */
class Distributor : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        val p = c.getSharedPreferences("testpush", Context.MODE_PRIVATE)
        val token = i.getStringExtra("token")
        when (i.action) {
            SERVER -> {
                val url = i.getStringExtra("url")?.trimEnd('/')
                p.edit().putString("server", url).commit()
                Log.i(TAG, "server: $url")
            }
            REGISTER -> {
                if (token == null) return
                @Suppress("DEPRECATION")
                val app = i.getStringExtra("application") ?: i.getParcelableExtra<PendingIntent>("pi")?.creatorPackage ?: return
                val server = p.getString("server", null)
                if (server == null) {
                    Log.w(TAG, "REGISTER from $app before the test named its server")
                    send(c, app, Intent(TO_APP + "REGISTRATION_FAILED").putExtra("token", token).putExtra("reason", "INTERNAL_ERROR"))
                    return
                }
                p.edit().putString("app.$token", app).commit()
                Log.i(TAG, "REGISTER $app")
                send(c, app, Intent(TO_APP + "NEW_ENDPOINT").putExtra("token", token).putExtra("endpoint", "$server/up/$token").putExtra("id", UUID.randomUUID().toString()))
            }
            UNREGISTER -> {
                if (token == null) return
                val app = p.getString("app.$token", null) ?: return
                p.edit().remove("app.$token").commit()
                Log.i(TAG, "UNREGISTER $app")
                send(c, app, Intent(TO_APP + "UNREGISTERED").putExtra("token", token))
            }
            DELIVER -> {
                val app = token?.let { p.getString("app.$it", null) }
                val body = i.getStringExtra("b64")?.let { Base64.decode(it, Base64.DEFAULT) }
                if (app == null || body == null) {
                    Log.w(TAG, "DELIVER for a token no app registered, or with no body")
                    resultCode = 404
                    return
                }
                Log.i(TAG, "DELIVER ${body.size} bytes to $app")
                send(c, app, Intent(TO_APP + "MESSAGE").putExtra("token", token).putExtra("bytesMessage", body).putExtra("id", UUID.randomUUID().toString()))
                resultCode = 200
            }
            ACK -> Log.i(TAG, "MESSAGE_ACK")
        }
    }

    /** To the app's connector (its MessagingReceiverImpl), in the foreground queue so a ring is not held behind others. */
    private fun send(c: Context, app: String, i: Intent) {
        c.sendBroadcast(i.setPackage(app).addFlags(Intent.FLAG_RECEIVER_FOREGROUND))
    }

    private companion object {
        const val TAG = "DitherTestPush"
        const val TO_APP = "org.unifiedpush.android.connector."
        const val REGISTER = "org.unifiedpush.android.distributor.REGISTER"
        const val UNREGISTER = "org.unifiedpush.android.distributor.UNREGISTER"
        const val ACK = "org.unifiedpush.android.distributor.MESSAGE_ACK"
        const val SERVER = "org.libdither.chat.testpush.SERVER"
        const val DELIVER = "org.libdither.chat.testpush.DELIVER"
    }
}

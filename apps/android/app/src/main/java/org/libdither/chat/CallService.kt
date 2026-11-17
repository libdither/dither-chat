package org.libdither.chat

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executor

/**
 * Runs while a call is live (the page says so through the bridge). A foreground service is what lets the WebView keep
 * the microphone, the peer connection and its timers with the screen off or the app in the background. The ongoing
 * notification hangs up, mutes and switches the audio route.
 *
 * Its types (docs/android.md, "The call service"): `phoneCall` from the start, which needs no runtime permission (MANAGE_OWN_CALLS
 * is granted at install), and `microphone` as well once the microphone is allowed. A page starts its call while it is
 * still asking for the microphone, and Android 14+ throws, killing the app, at a `microphone` service without it.
 */
class CallService : Service() {
    companion object {
        private const val TAG = "DitherCall"
        private const val ID = 2
        private const val HANGUP = "hangup"
        private const val MUTE = "mute"
        private const val ROUTE = "route"
        private var running: CallService? = null

        fun update(c: Context, state: JSONObject) {
            val active = state.optBoolean("active")
            val s = running
            try {
                when {
                    active && s != null -> s.apply(state)
                    active -> c.startForegroundService(Intent(c, CallService::class.java).putExtra("state", state.toString()))
                    else -> c.stopService(Intent(c, CallService::class.java))
                }
            } catch (e: Exception) {
                // Android refuses a foreground service started from the background (12+): the call goes on while the
                // app is open, and the page hears nothing different. Never a reason to take the app down.
                Log.w(TAG, "call service not started", e)
                Crashes.note(c, "/android/call-service", e)
            }
        }

        /** The microphone was allowed or refused: the running service takes, or keeps without, the microphone type. */
        fun permissionsChanged() {
            running?.refresh()
        }
    }

    private var state = JSONObject()
    private var types = 0
    private var cpu: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var proximity: PowerManager.WakeLock? = null
    private var deviceListener: Any? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Crashes.install(this)
        running = this
        val pm = getSystemService(PowerManager::class.java)
        cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dither:call").apply { acquire(6 * 3600_000L) }
        @Suppress("DEPRECATION")
        wifi = getSystemService(WifiManager::class.java).createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "dither:call").apply { acquire() }
        if (pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) proximity = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "dither:ear")
        if (Build.VERSION.SDK_INT >= 31) {
            val l = AudioManager.OnCommunicationDeviceChangedListener { refresh() }
            getSystemService(AudioManager::class.java).addOnCommunicationDeviceChangedListener(Executor { mainExecutor.execute(it) }, l)
            deviceListener = l
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            HANGUP -> Push.toPage(JSONObject().put("t", "call.hangup"))
            MUTE -> Push.toPage(JSONObject().put("t", "call.mute").put("muted", !state.optBoolean("muted")))
            ROUTE -> {
                Audio.next(this)
                refresh()
            }
            else -> intent?.getStringExtra("state")?.let { apply(JSONObject(it)) } ?: apply(state)
        }
        return START_NOT_STICKY
    }

    fun apply(s: JSONObject) {
        state = s
        refresh()
    }

    /** `phoneCall` always; `microphone` too while the app holds the microphone. */
    private fun wantedTypes(): Int {
        val mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        return ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or (if (mic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
    }

    /**
     * The notification, and the service's types when they change. Only a change of types calls startForeground again:
     * Android checks a `microphone` type against the app being in the foreground at each call, and a route or phase
     * change can come with the screen off.
     */
    fun refresh() {
        val n = build()
        val want = wantedTypes()
        if (want != types) {
            try {
                startForeground(ID, n, want)
                types = want
            } catch (e: Exception) {
                Log.w(TAG, "foreground as $want refused", e)
                Crashes.note(this, "/android/call-service", e)
                // Already in the foreground with what it had: keep that. Not yet: the type that needs no permission,
                // since a service started for the foreground must get there or Android ends the app.
                if (types == 0) {
                    startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
                    types = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                } else getSystemService(NotificationManager::class.java).notify(ID, n)
            }
        } else getSystemService(NotificationManager::class.java).notify(ID, n)
        // Held to the ear on the earpiece: the screen goes off, as in a phone call.
        val ear = Audio.currentRoute(this)?.kind == "earpiece"
        proximity?.let { if (ear && !it.isHeld) it.acquire(6 * 3600_000L) else if (!ear && it.isHeld) it.release() }
        Push.toPage(Audio.state(this))
    }

    private fun action(name: String, title: String): Notification.Action {
        val pi = PendingIntent.getService(this, name.hashCode(), Intent(this, CallService::class.java).setAction(name), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Action.Builder(null, title, pi).build()
    }

    private fun build(): Notification {
        val conv = state.optString("conversationId").ifEmpty { null }
        val live = state.optString("phase") == "live"
        val muted = state.optBoolean("muted")
        val title = state.optString("title").ifEmpty { "Call" }
        val b = Notification.Builder(this, Notifications.CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(getColor(R.color.accent))
            .setContentTitle(title)
            .setContentText(if (live) (if (muted) "In the call, muted" else "In the call") else "Connecting…")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_CALL)
            .setContentIntent(Notifications.open(this, conv?.let { "/inbox/c/$it" }, ID))
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(action(HANGUP, "Hang up"))
            .addAction(action(MUTE, if (muted) "Unmute" else "Mute"))
            .addAction(action(ROUTE, "Audio: ${Audio.currentRoute(this)?.name ?: "default"}"))
        val since = state.optLong("since")
        if (live && since > 0) b.setWhen(since).setUsesChronometer(true).setShowWhen(true)
        return b.build()
    }

    override fun onDestroy() {
        running = null
        if (Build.VERSION.SDK_INT >= 31) (deviceListener as? AudioManager.OnCommunicationDeviceChangedListener)?.let { getSystemService(AudioManager::class.java).removeOnCommunicationDeviceChangedListener(it) }
        Audio.reset(this)
        cpu?.takeIf { it.isHeld }?.release()
        wifi?.takeIf { it.isHeld }?.release()
        proximity?.takeIf { it.isHeld }?.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}

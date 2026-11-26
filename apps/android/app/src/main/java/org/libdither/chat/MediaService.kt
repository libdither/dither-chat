package org.libdither.chat

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject

/**
 * Runs while the page plays a voice message, a sound file or a video with sound (packages/web/src/nowplaying.ts tells
 * the app through the bridge, docs/android.md "Playing in the background"). A `mediaPlayback` foreground service is
 * what keeps the WebView playing with the screen off or the app in the background, as [CallService] does for calls.
 *
 * Its notification and media session give the system's controls: play and pause, the position bar, the lock screen,
 * a headset's button. Each goes back to the page as `media.do`; the page answers with its new state. It stays while
 * paused, so play from the notification needs no new foreground service from the background, and goes after
 * [PAUSED_FOR] paused, at Close, when what played ends, or when its page goes.
 */
class MediaService : Service() {
    companion object {
        private const val TAG = "DitherMedia"
        private const val ID = 4
        private const val PLAY = "play"
        private const val PAUSE = "pause"
        private const val STOP = "stop"
        private const val PAUSED_FOR = 10 * 60_000L
        private var running: MediaService? = null

        fun update(c: Context, state: JSONObject) {
            val on = state.optString("state") in setOf("playing", "paused")
            val s = running
            try {
                when {
                    on && s != null -> s.apply(state)
                    // Started only by playing: a tap in the app, which is in front then (Android 12+ refuses one
                    // started from the background). The page says `paused` again on its way out; that starts nothing.
                    on && state.optString("state") == "playing" -> c.startForegroundService(Intent(c, MediaService::class.java).putExtra("state", state.toString()))
                    !on -> c.stopService(Intent(c, MediaService::class.java))
                }
            } catch (e: Exception) {
                // Refused: it plays while the app is open, as before. Never a reason to take the app down.
                Log.w(TAG, "media service not started", e)
                Crashes.note(c, "/android/media-service", e)
            }
        }

        fun stop(c: Context) {
            if (running != null) c.stopService(Intent(c, MediaService::class.java))
        }
    }

    private var state = JSONObject()
    private var foreground = false
    private var session: MediaSession? = null
    private var cpu: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private val main = Handler(Looper.getMainLooper())
    private val idle = Runnable { stopSelf() }

    /** Headphones out, or the Bluetooth set gone: pause, as every player does, before it comes out of the speaker. */
    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            if (i.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) toPage(PAUSE)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Crashes.install(this)
        running = this
        Notifications.channels(this)
        session = MediaSession(this, "dither").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = toPage(PLAY)
                override fun onPause() = toPage(PAUSE)
                override fun onStop() = toPage(STOP)
                override fun onSeekTo(pos: Long) = Push.toPage(JSONObject().put("t", "media.do").put("action", "seek").put("to", pos))
                override fun onCustomAction(action: String, extras: android.os.Bundle?) {
                    if (action == STOP) close()
                }
            })
            setSessionActivity(Notifications.open(this@MediaService, null, ID))
            isActive = true
        }
        registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            PLAY, PAUSE -> toPage(intent.action!!)
            STOP -> close()
            else -> intent?.getStringExtra("state")?.let { apply(JSONObject(it)) } ?: apply(state)
        }
        return START_NOT_STICKY
    }

    /** Close: the page forgets what it played, and the notification goes. */
    private fun close() {
        toPage(STOP)
        stopSelf()
    }

    private fun toPage(action: String) = Push.toPage(JSONObject().put("t", "media.do").put("action", action))

    fun apply(s: JSONObject) {
        state = s
        val playing = s.optString("state") == "playing"
        val duration = s.optLong("duration")
        val rate = s.optDouble("rate", 1.0).toFloat()
        session?.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, s.optString("title").ifEmpty { "Playing" })
                .putString(MediaMetadata.METADATA_KEY_ARTIST, s.optString("artist"))
                .putString(MediaMetadata.METADATA_KEY_ALBUM, s.optString("album"))
                .apply { if (duration > 0) putLong(MediaMetadata.METADATA_KEY_DURATION, duration) }
                .build(),
        )
        session?.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or PlaybackState.ACTION_SEEK_TO)
                // Android 13+ draws the media controls from this, not from the notification's buttons: Close is one of its own.
                .addCustomAction(PlaybackState.CustomAction.Builder(STOP, "Close", android.R.drawable.ic_menu_close_clear_cancel).build())
                .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, s.optLong("position"), if (playing) rate else 0f, SystemClock.elapsedRealtime())
                .build(),
        )
        val n = build(playing)
        if (!foreground) {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            foreground = true
        } else getSystemService(android.app.NotificationManager::class.java).notify(ID, n)
        // The CPU and Wi-Fi stay up while it plays (a file streams from the hub), not while it waits paused.
        if (playing) {
            main.removeCallbacks(idle)
            if (cpu == null) cpu = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dither:media").apply { setReferenceCounted(false) }
            cpu?.acquire(3 * 3600_000L)
            @Suppress("DEPRECATION")
            if (wifi == null) wifi = getSystemService(WifiManager::class.java).createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "dither:media").apply { setReferenceCounted(false) }
            wifi?.acquire()
        } else {
            release()
            main.removeCallbacks(idle)
            main.postDelayed(idle, PAUSED_FOR)
        }
    }

    private fun action(name: String, icon: Int, title: String): Notification.Action {
        val pi = PendingIntent.getService(this, name.hashCode(), Intent(this, MediaService::class.java).setAction(name), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION")
        return Notification.Action.Builder(icon, title, pi).build()
    }

    private fun build(playing: Boolean): Notification {
        val conv = state.optString("conversationId").ifEmpty { null }
        val who = state.optString("artist")
        val where = state.optString("album")
        return Notification.Builder(this, Notifications.PLAYING)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(getColor(R.color.accent))
            .setContentTitle(state.optString("title").ifEmpty { "Playing" })
            .setContentText(listOf(who, where).filter { it.isNotEmpty() }.joinToString(" · "))
            .setOngoing(playing)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(Notifications.open(this, conv?.let { "/inbox/c/$it" }, ID))
            .setDeleteIntent(PendingIntent.getService(this, STOP.hashCode() + 1, Intent(this, MediaService::class.java).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(if (playing) action(PAUSE, android.R.drawable.ic_media_pause, "Pause") else action(PLAY, android.R.drawable.ic_media_play, "Play"))
            .addAction(action(STOP, android.R.drawable.ic_menu_close_clear_cancel, "Close"))
            .setStyle(Notification.MediaStyle().setMediaSession(session?.sessionToken).setShowActionsInCompactView(0))
            .build()
    }

    private fun release() {
        cpu?.takeIf { it.isHeld }?.release()
        wifi?.takeIf { it.isHeld }?.release()
    }

    override fun onDestroy() {
        running = null
        main.removeCallbacks(idle)
        runCatching { unregisterReceiver(noisy) }
        session?.release()
        session = null
        release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}

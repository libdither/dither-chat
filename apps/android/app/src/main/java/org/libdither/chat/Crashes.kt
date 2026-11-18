package org.libdither.chat

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * What took the app down, or nearly did, for the hub's errors.ndjson (docs/android.md, "Crashes"). A crash kills the
 * process before anything can be sent, so it is written to a file here and handed to the next page that says hello,
 * which posts it to /api/errors as app `android`. Without this, a crash on a phone left nothing anywhere: the page
 * simply started again.
 *
 * Kept: the exception's class, message and frames (the app's own code and Android's, never a page's content), exits
 * Android recorded (ANR, native crash, the renderer) by reason and description, and errors caught on purpose that
 * should not happen. At most [MAX] wait at a time.
 */
object Crashes {
    private const val TAG = "DitherCrashes"
    private const val FILE = "crashes.json"
    private const val MAX = 20
    private const val FRAMES = 12
    @Volatile
    private var installed = false

    /** Writes an uncaught exception down before Android's own handler ends the process. Once per process. */
    fun install(c: Context) {
        if (installed) return
        installed = true
        val app = c.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            runCatching { add(app, report("/android/uncaught", e, "thread ${t.name}")) }
            previous?.uncaughtException(t, e)
        }
    }

    /** An error the app caught and went on from, which should still not happen. */
    fun note(c: Context, where: String, e: Throwable) = runCatching { add(c.applicationContext, report(where, e, null)) }

    /** The page's renderer died on its own (not reclaimed for memory, which is Android's to do). */
    fun rendererCrashed(c: Context) = runCatching {
        add(c.applicationContext, JSONObject().put("where", "/android/renderer").put("name", "RendererCrash").put("message", "the page's renderer process crashed; the app reloaded the page").put("at", System.currentTimeMillis()))
    }

    /** Exits Android recorded since the last look that were not the app's own choosing (11+). */
    fun collectExits(c: Context) {
        if (Build.VERSION.SDK_INT < 30) return
        runCatching {
            val prefs = Hub.prefs(c)
            val since = prefs.getLong("crashes.exitsSeen", 0)
            val exits = c.getSystemService(ActivityManager::class.java).getHistoricalProcessExitReasons(c.packageName, 0, 10)
            var newest = since
            for (x in exits) {
                if (x.timestamp <= since) continue
                newest = maxOf(newest, x.timestamp)
                // A Java crash is in the file already, with its stack; this list says only that it happened.
                val name = when (x.reason) {
                    ApplicationExitInfo.REASON_ANR -> "ANR"
                    ApplicationExitInfo.REASON_CRASH_NATIVE -> "NativeCrash"
                    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "InitializationFailure"
                    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "ExcessiveResourceUsage"
                    else -> null
                } ?: continue
                add(c, JSONObject().put("where", "/android/exit").put("name", name).put("message", (x.description ?: name).take(300)).put("at", x.timestamp).put("process", x.processName ?: ""))
            }
            if (since == 0L && newest == 0L) newest = System.currentTimeMillis()
            if (newest != since) prefs.edit().putLong("crashes.exitsSeen", newest).apply()
        }.onFailure { Log.w(TAG, "exit reasons", it) }
    }

    /** What waits for the page, emptied. */
    fun take(c: Context): JSONArray {
        val f = File(c.filesDir, FILE)
        synchronized(this) {
            val list = read(f)
            f.delete()
            return list
        }
    }

    private fun report(where: String, e: Throwable, note: String?): JSONObject {
        // The innermost cause says what happened; its frames say where.
        var root = e
        while (root.cause != null && root.cause !== root) root = root.cause!!
        val frames = JSONArray()
        for (f in (if (root.stackTrace.isNotEmpty()) root.stackTrace else e.stackTrace).take(FRAMES)) frames.put("at $f")
        if (root !== e) frames.put("via ${e.javaClass.name}: ${(e.message ?: "").take(200)}")
        return JSONObject()
            .put("where", where)
            .put("name", root.javaClass.simpleName.ifEmpty { "Throwable" })
            .put("message", (root.message ?: root.javaClass.name).take(300))
            .put("stack", frames)
            .put("at", System.currentTimeMillis())
            .also { if (note != null) it.put("note", note) }
    }

    private fun add(c: Context, r: JSONObject) {
        val f = File(c.filesDir, FILE)
        synchronized(this) {
            val list = read(f)
            if (list.length() >= MAX) return
            list.put(r.put("sdk", Build.VERSION.SDK_INT))
            f.writeText(list.toString())
        }
    }

    private fun read(f: File): JSONArray = runCatching { JSONArray(f.readText()) }.getOrElse { JSONArray() }
}

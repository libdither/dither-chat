package org.libdither.chat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

/**
 * Copies of the messages pushes were about, and reads elsewhere, kept for the page's next start (docs/notifications.md,
 * "A copy in the push"; the page's side is packages/web/src/arrived.ts). A WebView has no service worker push, so the
 * app keeps what public/sw.js keeps in a browser, as the same records, in a file, and hands them to each page that
 * says hello, and to an open page as they come. The page tells it which it has caught up past (`arrived.done`), and
 * those go; on sign-out, all of them. At most [MAX], none older than [KEEP_MS]. Holds what the notification itself
 * showed, on this phone only. The file is read and written on [work], one job at a time, never on the main thread.
 */
object Arrived {
    private const val FILE = "arrived.json"
    private const val MAX = 300
    private const val KEEP_MS = 3L * 24 * 3600 * 1000

    /** Where the file is read and written: in order, off the main thread. */
    val work = Executors.newSingleThreadExecutor()

    /**
     * A push came: its message's copy, or the reads it carries. Returns the records it kept, for an open page. A read
     * replaces the conversation's last one, keeping the furthest `upTo`; one without `upTo` (a phone-list row the hub
     * took back, not a read) is not kept.
     */
    fun keep(c: Context, d: JSONObject, at: Long = System.currentTimeMillis()): List<JSONObject> = keep(c.filesDir, d, at)

    /** [keep] in `dir`, the app's files directory; tests pass a temporary one (src/test/.../ArrivedTest.kt). */
    @Synchronized
    internal fun keep(dir: File, d: JSONObject, at: Long): List<JSONObject> {
        val records = records(d, at)
        if (records.isEmpty()) return records
        val byKey = LinkedHashMap<String, JSONObject>()
        for (r in read(dir)) byKey[r.getString("key")] = r
        for (r in records) {
            val was = byKey[r.getString("key")]
            if (was != null && r.optString("kind") == "clear" && was.optLong("upTo") > r.optLong("upTo")) r.put("upTo", was.optLong("upTo"))
            byKey[r.getString("key")] = r
        }
        val kept = byKey.values.filter { at - it.optLong("at") <= KEEP_MS }.sortedByDescending { it.optLong("at") }.take(MAX)
        write(dir, kept)
        return records
    }

    /** Everything kept, for a page that said hello; none older than [KEEP_MS]. */
    fun list(c: Context, now: Long = System.currentTimeMillis()): JSONArray = list(c.filesDir, now)

    @Synchronized
    internal fun list(dir: File, now: Long): JSONArray = JSONArray().also { a -> read(dir).filter { now - it.optLong("at") <= KEEP_MS }.forEach { a.put(it) } }

    /** The page caught up with the hub as of `upTo` (its clock, which is this phone's): what came before goes. */
    fun done(c: Context, upTo: Long) = done(c.filesDir, upTo)

    @Synchronized
    internal fun done(dir: File, upTo: Long) {
        val all = read(dir)
        val left = all.filter { it.optLong("at") > upTo }
        if (left.size != all.size) write(dir, left)
    }

    private fun records(d: JSONObject, at: Long): List<JSONObject> {
        val conv = d.optString("conversationId")
        val a = d.optJSONObject("arrived")
        val m = a?.optJSONObject("message")
        if (a != null && m != null && m.optString("id").isNotEmpty() && m.optString("conversationId") == conv) {
            return listOf(JSONObject().put("key", "m:${m.getString("id")}").put("kind", "message").put("conv", conv).put("arrived", a).put("at", at))
        }
        val clear = d.optString("clear")
        if (clear.isEmpty()) return emptyList()
        val all = mutableListOf(JSONObject().put("clear", clear).apply { if (d.has("upTo")) put("upTo", d.optLong("upTo")) })
        d.optJSONArray("more")?.let { more -> for (i in 0 until more.length()) more.optJSONObject(i)?.let(all::add) }
        return all.filter { it.optString("clear").isNotEmpty() && it.has("upTo") }.map { x ->
            JSONObject().put("key", "c:${x.getString("clear")}").put("kind", "clear").put("conv", x.getString("clear")).put("at", at).put("upTo", x.optLong("upTo"))
        }
    }

    private fun read(dir: File): List<JSONObject> {
        val f = File(dir, FILE)
        if (!f.exists()) return emptyList()
        val a = runCatching { JSONArray(f.readText()) }.getOrNull() ?: return emptyList()
        return (0 until a.length()).mapNotNull { a.optJSONObject(it) }
    }

    private fun write(dir: File, list: List<JSONObject>) {
        val f = File(dir, FILE)
        if (list.isEmpty()) {
            f.delete()
            return
        }
        // Written aside and moved in place: a push and the page can't leave half a file.
        val tmp = File(dir, "$FILE.tmp")
        FileOutputStream(tmp).use { o ->
            o.write(JSONArray().also { a -> list.forEach { a.put(it) } }.toString().toByteArray())
            o.fd.sync()
        }
        if (!tmp.renameTo(f)) tmp.delete()
    }
}

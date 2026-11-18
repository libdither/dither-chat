package org.libdither.chat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Copies of the messages pushes were about, and reads elsewhere, kept for the page's next start (docs/notifications.md,
 * "A copy in the push"; the page's side is packages/web/src/arrived.ts). A WebView has no service worker push, so the
 * app keeps what public/sw.js keeps in a browser, as the same records, in a file, and hands them to each page that
 * says hello. The page tells it which it has caught up past (`arrived.done`), and those go. At most [MAX], none older
 * than [KEEP_MS]. Holds what the notification itself showed, on this phone only.
 */
object Arrived {
    private const val FILE = "arrived.json"
    private const val MAX = 300
    private const val KEEP_MS = 3L * 24 * 3600 * 1000

    /** A push came: its message's copy, or each read it carries. */
    @Synchronized
    fun keep(c: Context, d: JSONObject, at: Long = System.currentTimeMillis()) {
        val records = records(d, at)
        if (records.isEmpty()) return
        val byKey = LinkedHashMap<String, JSONObject>()
        for (r in read(c)) byKey[r.getString("key")] = r
        for (r in records) byKey[r.getString("key")] = r
        val kept = byKey.values.filter { at - it.optLong("at") <= KEEP_MS }.sortedByDescending { it.optLong("at") }.take(MAX)
        write(c, kept)
    }

    /** Everything kept, for a page that said hello. */
    @Synchronized
    fun list(c: Context): JSONArray = JSONArray().also { a -> read(c).forEach { a.put(it) } }

    /** The page caught up with the hub as of `upTo` (its clock, which is this phone's): what came before goes. */
    @Synchronized
    fun done(c: Context, upTo: Long) {
        val all = read(c)
        val left = all.filter { it.optLong("at") > upTo }
        if (left.size != all.size) write(c, left)
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
        return all.filter { it.optString("clear").isNotEmpty() }.mapIndexed { i, x ->
            JSONObject().put("key", "c:${x.getString("clear")}:$at:$i").put("kind", "clear").put("conv", x.getString("clear")).put("at", at).apply {
                if (x.has("upTo")) put("upTo", x.optLong("upTo"))
            }
        }
    }

    private fun read(c: Context): List<JSONObject> {
        val f = File(c.filesDir, FILE)
        if (!f.exists()) return emptyList()
        val a = runCatching { JSONArray(f.readText()) }.getOrNull() ?: return emptyList()
        return (0 until a.length()).mapNotNull { a.optJSONObject(it) }
    }

    private fun write(c: Context, list: List<JSONObject>) {
        val f = File(c.filesDir, FILE)
        if (list.isEmpty()) {
            f.delete()
            return
        }
        // Written aside and moved in place: a push and the page can't leave half a file.
        val tmp = File(c.filesDir, "$FILE.tmp")
        tmp.writeText(JSONArray().also { a -> list.forEach { a.put(it) } }.toString())
        tmp.renameTo(f)
    }
}

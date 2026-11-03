package org.libdither.chat

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Which hub this app talks to, and the few calls the app makes to it itself (push registration, replies). */
object Hub {
    private const val PREFS = "dither"

    fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The hub's origin, like https://chat.example.net, or null before the first run's setup. */
    fun origin(c: Context): Uri? = prefs(c).getString("hub", null)?.let(Uri::parse)

    fun setOrigin(c: Context, origin: Uri) = prefs(c).edit().putString("hub", origin.toString()).apply()

    /** What was typed, as an origin: scheme, host, port. https unless it says otherwise. */
    fun normalize(input: String): Uri? {
        val s = input.trim().trimEnd('/')
        if (s.isEmpty()) return null
        val u = Uri.parse(if ("://" in s) s else "https://$s")
        if (u.scheme != "https" && u.scheme != "http") return null
        val host = u.host ?: return null
        return Uri.Builder().scheme(u.scheme).encodedAuthority(if (u.port > 0) "$host:${u.port}" else host).build()
    }

    fun sameOrigin(a: Uri, b: Uri?): Boolean =
        b != null && a.scheme == b.scheme && a.host.equals(b.host, true) && effectivePort(a) == effectivePort(b)

    private fun effectivePort(u: Uri) = if (u.port > 0) u.port else if (u.scheme == "https") 443 else 80

    /**
     * A request from the app itself, not the page. It carries no Origin header, which the hub reads as "not a browser",
     * the same as its CLI: the tailnet is the only gate, as for everything else on the hub.
     */
    fun request(c: Context, method: String, path: String, body: JSONObject? = null, timeoutMs: Int = 15_000): Pair<Int, String> {
        val origin = origin(c) ?: return 0 to "no hub"
        val conn = URL("$origin$path").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("content-type", "application/json")
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return code to text
        } finally {
            conn.disconnect()
        }
    }

    /** A GET from the hub as bytes (a notification's picture), or null. `path` is a hub path like /media/... */
    fun bytes(c: Context, path: String, timeoutMs: Int = 15_000): ByteArray? {
        val origin = origin(c) ?: return null
        if (!path.startsWith("/")) return null
        val conn = URL("$origin$path").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            if (conn.responseCode !in 200..299) return null
            return conn.inputStream.use { it.readBytes() }
        } finally {
            conn.disconnect()
        }
    }

    fun errorOf(text: String): String = runCatching { JSONObject(text).optString("error") }.getOrNull()?.takeIf { it.isNotEmpty() } ?: text.take(200)
}

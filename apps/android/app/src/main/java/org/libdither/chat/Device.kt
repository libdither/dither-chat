package org.libdither.chat

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.util.Size
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.security.SecureRandom
import java.util.concurrent.Executors

/**
 * The phone's own photos and files, for the message box's panel (docs/uploads.md, "The panel"): the gallery newest
 * first, by album, and the shared storage as folders, recent files and a search, so the page never needs the system's
 * pickers. Lists go to the page over the bridge; the bytes (thumbnails, whole files) are served at
 * `<hub origin>/__device/<token>/…`, intercepted before any request leaves the phone. The token is new each time the
 * app starts and only the hub's page hears it (Bridge info), so no other page can read the phone through it.
 *
 * The gallery needs Android's photos and videos permission (all, or the ones picked: Android 14's "selected photos");
 * folders need "All files access" (Android 11+), a switch in Settings, or the storage permission on Android 10.
 */
object Device {
    private const val TAG = "DitherDevice"
    private const val PREFIX = "/__device/"
    val token: String = ByteArray(18).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val work = Executors.newFixedThreadPool(2)

    /** Off the main thread; `done` gets the answer back on it. */
    fun run(activity: MainActivity, job: () -> JSONObject, done: (JSONObject) -> Unit) {
        work.execute {
            val r = runCatching(job).getOrElse { e ->
                Log.w(TAG, "device list failed", e)
                JSONObject().put("error", e.message ?: "Failed")
            }
            activity.runOnUiThread { done(r) }
        }
    }

    // ---------------------------------------------------------------- what the app may read

    private fun granted(c: Context, p: String) = c.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    /** all, partial (Android 14's selected photos), or none. */
    fun mediaAccess(c: Context): String = when {
        filesAccess(c) -> "all"
        Build.VERSION.SDK_INT >= 33 && granted(c, Manifest.permission.READ_MEDIA_IMAGES) -> "all"
        Build.VERSION.SDK_INT >= 34 && granted(c, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> "partial"
        Build.VERSION.SDK_INT < 33 && granted(c, Manifest.permission.READ_EXTERNAL_STORAGE) -> "all"
        else -> "none"
    }

    /** What to ask Android for, to read the gallery. */
    fun mediaPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    fun filesAccess(c: Context): Boolean =
        if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else granted(c, Manifest.permission.READ_EXTERNAL_STORAGE)

    fun access(c: Context): JSONObject = JSONObject().put("media", mediaAccess(c)).put("files", filesAccess(c)).put("token", token)

    // ---------------------------------------------------------------- the gallery

    private val filesUri: Uri = MediaStore.Files.getContentUri("external")

    private fun mediaUri(kind: Int, id: Long): Uri =
        ContentUris.withAppendedId(if (kind == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)

    /**
     * Photos and videos, newest first: `limit` of them modified before `before` (seconds; a page's cursor), in one
     * album or all. The first page also lists the albums, largest first, each with its newest picture.
     */
    fun media(c: Context, album: String?, before: String?, limit: Int): JSONObject {
        val access = mediaAccess(c)
        val out = JSONObject().put("access", access)
        if (access == "none") return out.put("items", JSONArray()).put("next", JSONObject.NULL)
        val T = MediaStore.Files.FileColumns.MEDIA_TYPE
        val sel = StringBuilder("($T = ${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE} OR $T = ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})")
        val args = ArrayList<String>()
        if (album != null) sel.append(" AND ${MediaStore.MediaColumns.BUCKET_ID} = ?").also { args.add(album) }
        // The cursor is the last one's time and id, so pictures taken in the same second are neither lost nor repeated.
        val cursor = before?.split(':')?.takeIf { it.size == 2 }
        if (cursor != null) {
            val D = MediaStore.MediaColumns.DATE_MODIFIED
            sel.append(" AND ($D < ? OR ($D = ? AND ${MediaStore.MediaColumns._ID} < ?))")
            args.addAll(listOf(cursor[0], cursor[0], cursor[1]))
        }
        val cols = arrayOf(
            MediaStore.MediaColumns._ID, T, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, MediaStore.MediaColumns.DURATION, MediaStore.MediaColumns.DATE_MODIFIED,
        )
        val items = JSONArray()
        var last: Long? = null
        var lastId = 0L
        query(c, cols, sel.toString(), args, "${MediaStore.MediaColumns.DATE_MODIFIED} DESC, ${MediaStore.MediaColumns._ID} DESC", limit)?.use { cur ->
            while (cur.moveToNext()) {
                val kind = cur.getInt(1)
                val id = cur.getLong(0)
                last = cur.getLong(8)
                lastId = id
                items.put(
                    JSONObject().put("id", "${if (kind == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) "v" else "i"}$id").put("kind", if (kind == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) "video" else "image")
                        .put("name", cur.getString(2) ?: "photo").put("mime", cur.getString(3) ?: JSONObject.NULL).put("size", cur.getLong(4))
                        .put("w", cur.getInt(5)).put("h", cur.getInt(6)).put("ms", cur.getLong(7)).put("at", last!! * 1000),
                )
            }
        }
        out.put("items", items).put("next", if (items.length() == limit && last != null) "$last:$lastId" else JSONObject.NULL)
        if (before == null && album == null) out.put("albums", albums(c))
        return out
    }

    private fun albums(c: Context): JSONArray {
        val T = MediaStore.Files.FileColumns.MEDIA_TYPE
        val sel = "($T = ${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE} OR $T = ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})"
        val byId = LinkedHashMap<String, Triple<String, Int, String>>()
        query(c, arrayOf(MediaStore.MediaColumns.BUCKET_ID, MediaStore.MediaColumns.BUCKET_DISPLAY_NAME, MediaStore.MediaColumns._ID, T), sel, emptyList(), "${MediaStore.MediaColumns.DATE_MODIFIED} DESC", 20000)?.use { cur ->
            while (cur.moveToNext()) {
                val id = cur.getString(0) ?: continue
                val prev = byId[id]
                val cover = "${if (cur.getInt(3) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) "v" else "i"}${cur.getLong(2)}"
                byId[id] = Triple(prev?.first ?: (cur.getString(1) ?: "Other"), (prev?.second ?: 0) + 1, prev?.third ?: cover)
            }
        }
        val a = JSONArray()
        for ((id, v) in byId.entries.sortedByDescending { it.value.second }) a.put(JSONObject().put("id", id).put("name", v.first).put("count", v.second).put("cover", v.third))
        return a
    }

    private fun query(c: Context, cols: Array<String>, sel: String, args: List<String>, order: String, limit: Int) =
        c.contentResolver.query(
            filesUri, cols,
            Bundle().apply {
                putString(ContentResolver.QUERY_ARG_SQL_SELECTION, sel)
                putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args.toTypedArray())
                putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, order)
                putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
            },
            null,
        )

    // ---------------------------------------------------------------- files

    private fun root(): File = Environment.getExternalStorageDirectory().canonicalFile

    /** A path under the shared storage, or null for anything outside it. */
    private fun under(path: String): File? {
        val r = root()
        val f = File(r, path.trimStart('/')).canonicalFile
        return if (f == r || f.path.startsWith(r.path + File.separator)) f else null
    }

    private fun rel(f: File) = f.path.removePrefix(root().path).trimStart('/')

    private fun mimeOf(name: String): String? = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())

    private fun entry(f: File): JSONObject {
        val o = JSONObject().put("name", f.name).put("path", rel(f)).put("dir", f.isDirectory).put("at", f.lastModified())
        if (f.isDirectory) o.put("count", f.list()?.count { !it.startsWith(".") } ?: 0)
        else o.put("size", f.length()).put("mime", mimeOf(f.name) ?: JSONObject.NULL)
        return o
    }

    /**
     * One folder (`path`, "" for the top), the most recently changed files anywhere (`recent`), or files whose name
     * holds `q`. Hidden files and Android/ (other apps' own data) are left out.
     */
    fun files(c: Context, path: String, q: String?, recent: Boolean): JSONObject {
        val out = JSONObject().put("access", filesAccess(c)).put("path", path)
        if (!filesAccess(c)) return out.put("entries", JSONArray())
        val entries = JSONArray()
        if (recent || !q.isNullOrBlank()) {
            val sel = StringBuilder("${MediaStore.Files.FileColumns.MIME_TYPE} IS NOT NULL")
            val args = ArrayList<String>()
            if (!q.isNullOrBlank()) sel.append(" AND ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?").also { args.add("%${q.trim()}%") }
            @Suppress("DEPRECATION") val data = MediaStore.MediaColumns.DATA
            query(c, arrayOf(data), sel.toString(), args, "${MediaStore.MediaColumns.DATE_MODIFIED} DESC", 200)?.use { cur ->
                while (cur.moveToNext() && entries.length() < 80) {
                    val f = cur.getString(0)?.let(::File) ?: continue
                    if (!f.isFile || f.name.startsWith(".") || under(f.path.removePrefix(root().path)) == null) continue
                    if (rel(f).split('/').any { it.startsWith(".") } || rel(f).startsWith("Android/")) continue
                    entries.put(entry(f))
                }
            }
            return out.put("entries", entries)
        }
        val dir = under(path) ?: return out.put("entries", entries).put("error", "Not on this phone's storage")
        val list = dir.listFiles()?.filter { !it.name.startsWith(".") && !(dir == root() && it.name == "Android") } ?: emptyList()
        for (f in list.sortedWith(compareByDescending<File> { it.isDirectory }.thenBy { it.name.lowercase() })) entries.put(entry(f))
        return out.put("entries", entries)
    }

    // ---------------------------------------------------------------- the bytes

    /**
     * `<origin>/__device/<token>/media/<id>` (whole), `…/media/<id>/thumb`, `…/file?path=<path>`: for the hub's page
     * only, from the WebView's request interception. Anything else (or a wrong token) is not ours: null.
     */
    fun serve(c: Context, origin: Uri?, url: Uri): WebResourceResponse? {
        if (origin == null || !Hub.sameOrigin(url, origin)) return null
        val p = url.path ?: return null
        if (!p.startsWith(PREFIX)) return null
        val rest = p.removePrefix(PREFIX).split('/')
        if (rest.firstOrNull() != token) return deny(403, "Forbidden")
        return runCatching {
            when (rest.getOrNull(1)) {
                "media" -> {
                    if (mediaAccess(c) == "none") return deny(403, "No access to photos")
                    val id = rest.getOrNull(2) ?: return deny(404, "Not found")
                    val uri = mediaUri(if (id.startsWith("v")) MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO else MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE, id.drop(1).toLong())
                    if (rest.getOrNull(3) == "thumb") {
                        val b = c.contentResolver.loadThumbnail(uri, Size(360, 360), null)
                        val bytes = ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.JPEG, 82, it) }.toByteArray()
                        ok("image/jpeg", ByteArrayInputStream(bytes), bytes.size.toLong(), cache = true)
                    } else {
                        val mime = c.contentResolver.getType(uri) ?: "application/octet-stream"
                        val size = c.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1
                        ok(mime, c.contentResolver.openInputStream(uri) ?: return deny(404, "Not found"), size)
                    }
                }
                "file" -> {
                    if (!filesAccess(c)) return deny(403, "No access to files")
                    val f = under(url.getQueryParameter("path") ?: "") ?: return deny(403, "Forbidden")
                    if (!f.isFile) return deny(404, "Not found")
                    ok(mimeOf(f.name) ?: "application/octet-stream", FileInputStream(f), f.length())
                }
                else -> deny(404, "Not found")
            }
        }.getOrElse { e ->
            Log.w(TAG, "serving $p failed", e)
            deny(500, e.message ?: "Failed")
        }
    }

    private fun ok(mime: String, body: java.io.InputStream, size: Long, cache: Boolean = false): WebResourceResponse {
        val h = HashMap<String, String>()
        if (size >= 0) h["Content-Length"] = size.toString()
        h["Cache-Control"] = if (cache) "private, max-age=3600" else "no-store"
        return WebResourceResponse(mime, null, 200, "OK", h, body)
    }

    private fun deny(code: Int, why: String) = WebResourceResponse("text/plain", "utf-8", code, why, mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(why.toByteArray()))
}

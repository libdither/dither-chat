package org.libdither.chat

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.widget.Toast
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * A file from a message, opened in another app: downloaded from the hub into the cache, then offered with the
 * system's chooser as content://org.libdither.chat.files/<name>, readable only by the app the intent grants it to.
 */
object HubFiles {
    private const val TAG = "DitherFiles"
    private const val KEEP_MS = 24 * 3600 * 1000L

    fun dir(c: Context) = File(c.cacheDir, "open").apply { mkdirs() }

    fun isHubFile(u: Uri, hub: Uri?) = Hub.sameOrigin(u, hub) && (u.path?.startsWith("/media/") == true || u.path?.startsWith("/emoji/") == true)

    /** `name` and `mime` from the page when it knows them, else from the hub's headers. */
    fun open(a: Activity, u: Uri, name: String?, mime: String?, disposition: String? = null) {
        Toast.makeText(a, "Downloading…", Toast.LENGTH_SHORT).show()
        Thread {
            val r = runCatching { download(a, u, name, mime, disposition) }
            a.runOnUiThread {
                r.onFailure {
                    Log.w(TAG, "could not download a file", it)
                    Toast.makeText(a, "Could not download it: ${it.message}", Toast.LENGTH_LONG).show()
                }
                r.onSuccess { (f, type) ->
                    val view = Intent(Intent.ACTION_VIEW).setDataAndType(FilesProvider.uri(a, f), type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    try {
                        a.startActivity(Intent.createChooser(view, f.name))
                    } catch (e: ActivityNotFoundException) {
                        Toast.makeText(a, "No app here opens $type", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }.start()
    }

    private fun download(c: Context, u: Uri, name: String?, mime: String?, disposition: String?): Pair<File, String> {
        val conn = URL(u.toString()).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        try {
            if (conn.responseCode != 200) throw IOException("the hub answered ${conn.responseCode}")
            val type = (mime?.takeIf { it.isNotBlank() && it != "application/octet-stream" } ?: conn.contentType ?: "application/octet-stream").substringBefore(';').trim().lowercase()
            val file = safeName(name?.takeIf { it.isNotBlank() } ?: URLUtil.guessFileName(u.toString(), disposition ?: conn.getHeaderField("Content-Disposition"), type))
            val dir = dir(c)
            // Yesterday's files are gone by now from whatever opened them.
            dir.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > KEEP_MS) it.delete() }
            val f = File(dir, file)
            conn.inputStream.use { input -> f.outputStream().use { input.copyTo(it) } }
            return f to type
        } finally {
            conn.disconnect()
        }
    }

    /** One path segment: no separators or control characters, no leading dots. */
    fun safeName(name: String): String {
        val n = name.replace(Regex("[\\u0000-\\u001f\\u007f/\\\\:*?\"<>|\\u202a-\\u202e\\u2066-\\u2069]"), "_").trim().trimStart('.', '-', ' ').take(120)
        return n.ifEmpty { "file" }
    }
}

/** Serves HubFiles' cache folder, read-only, to apps an intent granted a URI to. Not exported. */
class FilesProvider : ContentProvider() {
    companion object {
        fun uri(c: Context, f: File): Uri = Uri.Builder().scheme("content").authority("${c.packageName}.files").appendPath(f.name).build()
    }

    private fun file(uri: Uri): File? {
        val dir = HubFiles.dir(context ?: return null).canonicalFile
        val f = File(dir, uri.lastPathSegment ?: return null).canonicalFile
        return f.takeIf { it.parentFile == dir && it.isFile }
    }

    override fun onCreate() = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("read only")
        return ParcelFileDescriptor.open(file(uri) ?: throw FileNotFoundException(), ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri): String =
        file(uri)?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.extension.lowercase()) } ?: "application/octet-stream"

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
        val f = file(uri) ?: return null
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(cols).apply {
            addRow(cols.map { when (it) { OpenableColumns.DISPLAY_NAME -> f.name; OpenableColumns.SIZE -> f.length(); else -> null } })
        }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = throw UnsupportedOperationException()
}

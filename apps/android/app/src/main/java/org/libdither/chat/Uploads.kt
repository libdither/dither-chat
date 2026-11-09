package org.libdither.chat

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * History uploads that go on with the app closed (docs/import.md). The page asks for a pick; the app lists what was
 * picked (files, or every file under a folder, which a WebView's picker can't do), finds or makes the hub's upload for
 * it, and [UploadService] sends it in pieces at their offsets, as the page does, from a dataSync foreground service.
 *
 * The job is kept in a file, so a pause, a lost connection or Android stopping the app carries on from what the hub
 * has, never from the start. The picked files are read through persisted read permissions on their content URIs.
 */
object Uploads {
    private const val TAG = "DitherUpload"
    /** The hub's IMPORT_CHUNK (packages/protocol/src/imports.ts): it refuses larger pieces. */
    const val PIECE = 8 * 1024 * 1024

    class Part(val uri: Uri, val path: String, val size: Long)

    class Job(
        /** The hub's upload; null until the picked files are listed (state `listing`). */
        val source: String?,
        val account: String,
        val name: String,
        val parts: List<Part>,
        /** listing, running, paused, error */
        var state: String,
        var error: String?,
        var received: Long,
        /** What was picked, kept until it's listed: documents, or one folder. */
        val picked: List<Uri> = emptyList(),
        val tree: Uri? = null,
    ) {
        val size: Long get() = parts.sumOf { it.size }
    }

    private fun file(c: Context) = File(c.filesDir, "upload.json")

    @Synchronized
    fun load(c: Context): Job? = runCatching {
        val o = JSONObject(file(c).readText())
        val a = o.getJSONArray("parts")
        val parts = (0 until a.length()).map { a.getJSONObject(it).let { p -> Part(Uri.parse(p.getString("uri")), p.getString("path"), p.getLong("size")) } }
        val picked = o.optJSONArray("picked")?.let { p -> (0 until p.length()).map { Uri.parse(p.getString(it)) } } ?: emptyList()
        Job(o.optString("source").ifEmpty { null }, o.getString("account"), o.getString("name"), parts, o.getString("state"), o.optString("error").ifEmpty { null }, o.optLong("received"), picked, o.optString("tree").ifEmpty { null }?.let(Uri::parse))
    }.getOrNull()

    @Synchronized
    fun save(c: Context, j: Job) {
        val parts = JSONArray()
        for (p in j.parts) parts.put(JSONObject().put("uri", p.uri.toString()).put("path", p.path).put("size", p.size))
        val o = JSONObject().put("source", j.source ?: "").put("account", j.account).put("name", j.name).put("parts", parts)
            .put("state", j.state).put("error", j.error ?: "").put("received", j.received)
            .put("picked", JSONArray(j.picked.map { it.toString() })).put("tree", j.tree?.toString() ?: "")
        val tmp = File(c.filesDir, "upload.json.tmp")
        tmp.writeText(o.toString())
        tmp.renameTo(file(c))
    }

    /** Forget the job and give back the read permissions it held. What the hub has stays there. */
    @Synchronized
    fun clear(c: Context) {
        file(c).delete()
        for (p in c.contentResolver.persistedUriPermissions) {
            runCatching { c.contentResolver.releasePersistableUriPermission(p.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        }
    }

    /** What the page shows: the job, or none. `received` is live while the service runs. */
    fun state(c: Context, j: Job? = load(c), state: String? = null): JSONObject {
        val o = JSONObject().put("t", "upload")
        if (j == null) return o.put("state", state ?: "none")
        return o.put("state", state ?: j.state).put("source", j.source ?: JSONObject.NULL).put("accountId", j.account).put("name", j.name.ifEmpty { JSONObject.NULL })
            .put("received", UploadService.live?.received?.get() ?: j.received).put("size", j.size).put("files", j.parts.size)
            .put("error", j.error ?: JSONObject.NULL)
    }

    // ---------------------------------------------------------------- after the pick

    /**
     * Right after the pick, while the app is in front (Android lets a foreground service start only then): keep read
     * access to what was picked, and start the service, which lists it and uploads it.
     */
    fun begin(c: Context, account: String, uris: List<Uri>, tree: Uri?) {
        (if (tree != null) listOf(tree) else uris).forEach { take(c, it) }
        save(c, Job(null, account, "", emptyList(), "listing", null, 0, if (tree != null) emptyList() else uris, tree))
        UploadService.start(c)
    }

    /**
     * List the picked files, then find the hub's unfinished upload of the same files or make a new one. On the
     * service's thread. Returns the job as it will be sent.
     */
    fun prepare(c: Context, j: Job): Job {
        val (name, parts) = if (j.tree != null) listTree(c, j.tree) else listFiles(c, j.picked)
        if (parts.isEmpty()) throw IOException("There are no files in $name.")
        if (parts.sumOf { it.size } <= 0) throw IOException("Those files are empty.")
        Push.toPage(JSONObject().put("t", "upload").put("state", "listing").put("accountId", j.account).put("name", name).put("files", parts.size))
        val source = findPartial(c, j.account, parts) ?: create(c, j.account, parts)
        return Job(source, j.account, name, parts, "running", null, 0)
    }

    private fun take(c: Context, u: Uri) {
        if (c.contentResolver.persistedUriPermissions.any { it.uri == u && it.isReadPermission }) return
        runCatching { c.contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            .onFailure { Log.w(TAG, "no lasting permission for a picked file; it uploads while the app lives", it) }
    }

    private fun listFiles(c: Context, uris: List<Uri>): Pair<String, List<Part>> {
        val parts = ArrayList<Part>()
        val seen = HashSet<String>()
        for (u in uris) {
            var name: String? = null
            var size = -1L
            c.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { q ->
                if (q.moveToFirst()) {
                    name = q.getString(0)
                    if (!q.isNull(1)) size = q.getLong(1)
                }
            }
            if (size < 0) size = c.contentResolver.openFileDescriptor(u, "r")?.use { it.statSize } ?: -1
            if (size < 0) throw IOException("Android doesn't say how large ${name ?: "a picked file"} is.")
            var path = clean(name ?: "file")
            // Two picked files with the same name: the hub wants distinct paths.
            var n = 2
            val base = path
            while (!seen.add(path)) path = "${base.substringBeforeLast('.')} ($n)${if ('.' in base) "." + base.substringAfterLast('.') else ""}".also { n++ }
            parts.add(Part(u, path, size))
        }
        return (if (parts.size == 1) parts[0].path else "${parts.size} files") to parts
    }

    /** Every file under a picked folder, with paths that start at the folder, as a browser's folder pick gives them. */
    private fun listTree(c: Context, tree: Uri): Pair<String, List<Part>> {
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        var rootName = "folder"
        c.contentResolver.query(DocumentsContract.buildDocumentUriUsingTree(tree, rootId), arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { q ->
            if (q.moveToFirst()) rootName = q.getString(0) ?: rootName
        }
        rootName = clean(rootName)
        val parts = ArrayList<Part>()
        val dirs = ArrayDeque(listOf(rootId to rootName))
        val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE)
        while (dirs.isNotEmpty()) {
            val (id, at) = dirs.removeFirst()
            c.contentResolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, id), cols, null, null, null)?.use { q ->
                while (q.moveToNext()) {
                    val childId = q.getString(0)
                    val name = clean(q.getString(1) ?: "")
                    if (name.isEmpty()) {
                        // nameless: skipped
                    } else if (q.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) dirs.add(childId to "$at/$name")
                    else parts.add(Part(DocumentsContract.buildDocumentUriUsingTree(tree, childId), "$at/$name", if (q.isNull(3)) 0 else q.getLong(3)))
                }
            }
        }
        parts.sortBy { it.path }
        return rootName to parts
    }

    /** One path segment's worth of name: no slashes, no dot-only names (the hub cleans paths the same way). */
    private fun clean(name: String): String = name.replace('/', '_').replace('\u0000', '_').trim().let { if (it == "." || it == "..") "_" else it }

    /** The hub's unfinished upload of these same files for this account, if there is one: carry it on. */
    private fun findPartial(c: Context, account: String, parts: List<Part>): String? {
        val (code, text) = Hub.request(c, "GET", "/api/imports")
        if (code !in 200..299) throw IOException("The hub didn't answer (${Hub.errorOf(text)}).")
        val sources = JSONObject(text).optJSONArray("sources") ?: return null
        val size = parts.sumOf { it.size }
        for (i in 0 until sources.length()) {
            val s = sources.getJSONObject(i)
            if (s.optString("status") != "uploading" || s.optString("accountId") != account || s.optLong("size") != size || s.optInt("files") != parts.size) continue
            val id = s.getString("id")
            val (fc, ft) = Hub.request(c, "GET", "/api/imports/$id/files")
            if (fc !in 200..299) continue
            val files = JSONObject(ft).optJSONArray("files") ?: continue
            val mine = parts.map { it.path to it.size }
            val theirs = (0 until files.length()).map { files.getJSONObject(it).let { f -> f.optString("path") to f.optLong("size") } }
            if (mine == theirs) return id
        }
        return null
    }

    private fun create(c: Context, account: String, parts: List<Part>): String {
        val body = JSONObject().put("accountId", account)
        if (parts.size == 1) body.put("name", parts[0].path).put("size", parts[0].size)
        else body.put("files", JSONArray().also { a -> parts.forEach { a.put(JSONObject().put("path", it.path).put("size", it.size)) } })
        val (code, text) = Hub.request(c, "POST", "/api/imports", body, 60_000)
        if (code !in 200..299) throw IOException(Hub.errorOf(text).ifEmpty { "The hub refused the upload ($code)." })
        return JSONObject(text).getString("id")
    }
}

/**
 * Sends the job's files a few at a time, each from what the hub already has of it, while an ongoing notification shows
 * how far it got and offers Pause. Android may stop a dataSync service after 6 hours in a day (Android 15); then it
 * pauses, and opening the app carries on.
 */
class UploadService : Service() {
    companion object {
        private const val TAG = "DitherUpload"
        const val ID = 3
        /**
         * How it ended (done, paused, failed), under an id of its own: Android re-posts the service's last progress
         * notification when it leaves the foreground, which would overwrite an outcome posted under the same id.
         */
        const val OUTCOME = 4
        private const val PAUSE = "pause"
        private const val WORKERS = 3
        /** A lost connection is tried again with growing waits, up to this many times in a row, before pausing. */
        private const val TRIES = 12

        @Volatile
        var live: UploadService? = null

        fun start(c: Context) {
            c.startForegroundService(Intent(c, UploadService::class.java))
        }

        fun pause(c: Context) {
            val s = live
            if (s != null) s.stop("paused", null)
            else Uploads.load(c)?.let { if (it.state == "running") { it.state = "paused"; Uploads.save(c, it); Push.toPage(Uploads.state(c, it)) } }
        }

        /** The app came to the front: a job Android stopped carries on. */
        fun resumeIfStopped(c: Context) {
            if (live == null && Uploads.load(c)?.state.let { it == "running" || it == "listing" }) start(c)
        }
    }

    val received = AtomicLong()
    private var job: Uploads.Job? = null
    /** Set when the workers should stop sending: a pause, a failure, the end. */
    @Volatile private var halt = false
    /** The job's outcome was settled (paused, failed, done); later outcomes are ignored. */
    private val settled = java.util.concurrent.atomic.AtomicBoolean(false)
    private var worker: Thread? = null
    private var cpu: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var lastNote = 0L
    private var lastPage = 0L
    private var lastSave = 0L
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        live = this
        Notifications.channels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val j = Uploads.load(this)
        foreground(j)
        if (intent?.action == PAUSE) {
            stop("paused", null)
            return START_NOT_STICKY
        }
        if (j == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (worker?.isAlive == true && !halt) return START_NOT_STICKY
        // Carried on right after a pause: let the last piece's sender finish first.
        worker?.join(5000)
        if (j.source != null) j.state = "running"
        j.error = null
        Uploads.save(this, j)
        job = j
        halt = false
        settled.set(false)
        received.set(j.received)
        val pm = getSystemService(PowerManager::class.java)
        if (cpu == null) cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dither:upload").apply { acquire(6 * 3600_000L) }
        @Suppress("DEPRECATION")
        if (wifi == null) wifi = getSystemService(WifiManager::class.java).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "dither:upload").apply { acquire() }
        worker = Thread({ run(j) }, "dither-upload").also { it.start() }
        Push.toPage(Uploads.state(this, j))
        return START_NOT_STICKY
    }

    /** Android 15 ends a dataSync service after its daily allowance: pause, and carry on when the app is opened. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        stop("paused", "Android stopped the upload in the background. Open the app to carry on.")
    }

    private fun foreground(j: Uploads.Job?) {
        getSystemService(NotificationManager::class.java).cancel(OUTCOME)
        val n = note(j, "running")
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(ID, n)
    }

    /** Pause (or fail) from any thread: the workers stop at their next read, and the job keeps what was sent. */
    fun stop(state: String, error: String?) {
        halt = true
        if (!settled.compareAndSet(false, true)) return
        val j = job ?: Uploads.load(this)
        if (j != null) {
            j.state = state
            j.error = error
            j.received = received.get()
            Uploads.save(this, j)
        }
        main.post { finish(j, state) }
    }

    private fun finish(j: Uploads.Job?, state: String) {
        release()
        if (state != "done" && Uploads.load(this) == null) {
            // Forgotten on the page meanwhile: nothing to show.
            stopForeground(STOP_FOREGROUND_REMOVE)
            getSystemService(NotificationManager::class.java).cancel(OUTCOME)
            Push.toPage(Uploads.state(this, null))
            stopSelf()
            return
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        // A notification saying how it ended, or how to carry on.
        if (j != null) getSystemService(NotificationManager::class.java).notify(OUTCOME, note(j, state))
        Push.toPage(if (state == "done") Uploads.state(this, j, "done") else Uploads.state(this, j))
        if (state == "done") Uploads.clear(this)
        stopSelf()
    }

    private fun release() {
        cpu?.takeIf { it.isHeld }?.release()
        wifi?.takeIf { it.isHeld }?.release()
        cpu = null
        wifi = null
    }

    // ---------------------------------------------------------------- sending

    private fun run(start: Uploads.Job) {
        try {
            var j = start
            if (j.source == null) {
                j = Uploads.prepare(this, j)
                if (halt) return
                Uploads.save(this, j)
                job = j
                Push.toPage(Uploads.state(this, j))
            }
            val (code, text) = Hub.request(this, "GET", "/api/imports/${j.source}/files", null, 30_000)
            if (code == 404) return stop("error", "The hub no longer has this upload.")
            if (code !in 200..299) throw IOException(Hub.errorOf(text))
            val files = JSONObject(text).getJSONArray("files")
            val have = LongArray(j.parts.size) { if (it < files.length()) files.getJSONObject(it).optLong("received") else 0 }
            received.set(have.sum())
            progress(j)
            val next = AtomicInteger(0)
            var failure: Exception? = null
            val threads = (0 until WORKERS).map {
                Thread {
                    try {
                        while (!halt) {
                            val i = next.getAndIncrement()
                            if (i >= j.parts.size) break
                            if (have[i] < j.parts[i].size || j.parts[i].size == 0L) send(j, i, have[i])
                        }
                    } catch (e: Exception) {
                        synchronized(this) { if (failure == null) failure = e }
                        halt = true
                    }
                }.also { t -> t.start() }
            }
            threads.forEach { it.join() }
            failure?.let { throw it }
            stop(if (halt) "paused" else "done", null)
        } catch (e: Fatal) {
            stop("error", e.message)
        } catch (e: Exception) {
            Log.w(TAG, "upload stopped", e)
            if (job?.source == null) return stop("error", e.message ?: "The picked files could not be listed.")
            stop("paused", "Lost the hub: ${e.message ?: e.javaClass.simpleName}. Carry on when it's back.")
        }
    }

    private class Fatal(message: String) : Exception(message)

    /** One file, from `from`, a piece at a time. A refused offset is followed; a lost connection is tried again. */
    private fun send(j: Uploads.Job, index: Int, from: Long) {
        val part = j.parts[index]
        var offset = from
        var failures = 0
        var input: InputStream? = null
        val buf = ByteArray(64 * 1024)
        try {
            while (!halt && (offset < part.size || (part.size == 0L && offset == 0L))) {
                if (input == null) input = openAt(part.uri, offset)
                val len = minOf(Uploads.PIECE.toLong(), part.size - offset).toInt()
                val conn = URL("${Hub.origin(this) ?: throw Fatal("No hub is set.")}/api/imports/${j.source}/data?file=$index&offset=$offset").openConnection() as HttpURLConnection
                var sent = 0
                try {
                    conn.requestMethod = "PUT"
                    conn.connectTimeout = 20_000
                    conn.readTimeout = 120_000
                    conn.doOutput = true
                    conn.setFixedLengthStreamingMode(len)
                    conn.setRequestProperty("content-type", "application/octet-stream")
                    conn.outputStream.use { out ->
                        while (sent < len) {
                            if (halt) throw IOException("stopped")
                            val n = input.read(buf, 0, minOf(buf.size, len - sent))
                            if (n < 0) throw Fatal("${part.path} got shorter since it was picked.")
                            out.write(buf, 0, n)
                            sent += n
                        }
                    }
                    val code = conn.responseCode
                    val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                    when {
                        code in 200..299 -> {
                            offset += len
                            received.addAndGet(len.toLong())
                            failures = 0
                            progress(j)
                            if (part.size == 0L) break
                        }
                        code == 409 && JSONObject(text).has("received") -> {
                            // The hub has a different amount (a piece cut off midway): go on from there.
                            val at = JSONObject(text).getLong("received")
                            received.addAndGet(at - offset)
                            offset = at
                            input.close()
                            input = null
                        }
                        code == 409 -> return // already complete: the hub is checking it
                        code == 404 -> throw Fatal("The hub no longer has this upload.")
                        code in 400..499 -> throw Fatal(Hub.errorOf(text).ifEmpty { "The hub refused a piece ($code)." })
                        else -> throw IOException(Hub.errorOf(text).ifEmpty { "HTTP $code" })
                    }
                } catch (e: IOException) {
                    if (halt) return
                    input?.close()
                    input = null
                    if (++failures > TRIES) throw e
                    Log.i(TAG, "piece failed (${e.message}), trying again")
                    SystemClock.sleep(minOf(60_000L, 1000L shl minOf(failures, 6)))
                } finally {
                    conn.disconnect()
                }
            }
        } finally {
            input?.close()
        }
    }

    /** The file from `offset`: seeking when the provider gives a real file, skipping otherwise. */
    private fun openAt(uri: Uri, offset: Long): InputStream {
        val fd = contentResolver.openFileDescriptor(uri, "r") ?: throw Fatal("A picked file can no longer be read.")
        val s = ParcelInput(fd)
        if (offset > 0) {
            try {
                s.channel.position(offset)
            } catch (e: IOException) {
                var left = offset
                while (left > 0) {
                    val n = s.skip(left)
                    if (n <= 0) throw IOException("could not skip to $offset")
                    left -= n
                }
            }
        }
        return s
    }

    private class ParcelInput(private val fd: android.os.ParcelFileDescriptor) : FileInputStream(fd.fileDescriptor) {
        override fun close() {
            super.close()
            fd.close()
        }
    }

    @Synchronized
    private fun progress(j: Uploads.Job) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastNote > 1000 && !halt) {
            lastNote = now
            getSystemService(NotificationManager::class.java).notify(ID, note(j, "running"))
        }
        if (now - lastPage > 500) {
            lastPage = now
            Push.toPage(Uploads.state(this, j))
        }
        // Kept now and then, so the page shows about where a stopped process got to.
        if (now - lastSave > 10_000 && !halt) {
            lastSave = now
            j.received = received.get()
            Uploads.save(this, j)
        }
    }

    private fun note(j: Uploads.Job?, state: String): Notification {
        val size = j?.size ?: 0
        val got = if (state == "running") received.get() else j?.received ?: 0
        val b = Notification.Builder(this, Notifications.UPLOADS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(getColor(R.color.accent))
            .setContentIntent(Notifications.open(this, j?.let { "/accounts/${it.account}" }, ID))
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .setOnlyAlertOnce(true)
        val amount = "${bytes(got)} of ${bytes(size)}"
        when (state) {
            "running" -> {
                b.setContentTitle(if (j?.source == null) "Getting the upload ready" else "Uploading ${j.name}").setContentText(amount).setOngoing(true)
                    .setProgress(1000, if (size > 0) (got * 1000 / size).toInt() else 0, j == null)
                val pi = PendingIntent.getService(this, 1, Intent(this, UploadService::class.java).setAction(PAUSE), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                b.addAction(Notification.Action.Builder(null, "Pause", pi).build())
            }
            "done" -> b.setContentTitle("Uploaded ${j?.name}").setContentText("${bytes(size)} on the hub, which is checking it now.").setAutoCancel(true)
            "paused" -> b.setContentTitle("Upload paused: ${j?.name}").setContentText(j?.error ?: "$amount. Open the account in dither to carry on.").setAutoCancel(true)
            else -> b.setContentTitle("Upload stopped: ${j?.name}").setContentText(j?.error ?: amount).setAutoCancel(true)
        }
        return b.build()
    }

    private fun bytes(n: Long): String {
        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        var v = n.toDouble()
        var i = 0
        while (v >= 1024 && i < units.size - 1) {
            v /= 1024
            i++
        }
        return if (i == 0) "$n B" else String.format(if (v < 10) "%.1f %s" else "%.0f %s", v, units[i])
    }

    override fun onDestroy() {
        if (worker?.isAlive == true) stop("paused", null)
        release()
        live = null
        super.onDestroy()
    }
}

package org.libdither.chat

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.LocusId
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.provider.MediaStore
import android.text.InputType
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.inputmethod.EditorInfo
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush

/**
 * One WebView on the hub's own origin, so the page is the same app a browser gets: same origin, same service worker,
 * same storage, no CORS and no login. Around it, what a browser tab cannot do: runtime permissions, the file picker,
 * back through the page's history, a call that outlives the screen (CallService) and push (PushReceiver).
 */
class MainActivity : Activity() {
    companion object {
        const val EXTRA_HASH = "hash"
        private const val TAG = "DitherStartup"
        private const val REQ_FILES = 1
        private const val REQ_MEDIA = 2
        private const val REQ_NOTIFY = 3
        private const val REQ_UPLOAD = 4

        /** The activity on screen, if any: a push for what the page is showing needs no notification. */
        @Volatile
        var resumed: MainActivity? = null

        /** The live activity, for messages from services. Main thread only. */
        var current: MainActivity? = null
        private var firstInProcess = true

        /**
         * Time to content, the same for any build of the page: the first frame with the app's layout in it (the
         * loading screen has none). docs/android.md compares builds with it.
         */
        private const val PROBE = """(() => {
  if (window.top !== window || !window.DitherAndroid) return;
  const report = () => requestAnimationFrame(() => setTimeout(() => DitherAndroid.postMessage(JSON.stringify({ t: 'probe', ms: Math.round(performance.now()), at: Date.now(), origin: Math.round(performance.timeOrigin) }))));
  const seen = () => !!document.querySelector('#app > .app');
  document.addEventListener('DOMContentLoaded', () => {
    if (seen()) return report();
    const o = new MutationObserver(() => seen() && (o.disconnect(), report()));
    // Preact may turn the loading screen's div into the layout's by changing its class: watch both.
    o.observe(document.getElementById('app') || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
})();"""
    }

    private lateinit var root: FrameLayout
    private var web: WebView? = null
    var bridge: Bridge? = null
        private set
    private var hub: Uri? = null
    private var bg = 0
    private var files: ValueCallback<Array<Uri>>? = null
    /** Where the camera app is writing the photo a page's `capture` input asked for. */
    private var captured: Uri? = null
    private var mediaRequest: PermissionRequest? = null
    private var afterNotify: ((Boolean) -> Unit)? = null
    private val createdAt = SystemClock.uptimeMillis()
    private val cold = firstInProcess.also { firstInProcess = false }
    private var drawnReported = false
    private var loadAt = 0L
    var callActive = false
        private set
    private var backCallback: Any? = null
    /** The system splash stays up until the page has drawn its own sphere in the same place, or for 1.5 s at most. */
    private var splashHeld = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        Notifications.channels(this)
        bg = Hub.prefs(this).getInt("bg", getColor(R.color.app_bg))
        window.setBackgroundDrawable(ColorDrawable(bg))
        root = FrameLayout(this).apply { setBackgroundColor(bg) }
        setContentView(root)
        edgeToEdge()
        lightBars(isLight(bg))
        registerBack()
        holdSplash()
        hub = Hub.origin(this)
        val h = hub
        if (h == null) showSetup(null, null) else showWeb(h, hashFrom(intent))
    }

    // ---------------------------------------------------------------- splash

    /**
     * Android 12+ shows res/drawable/splash_orb.xml dithering in, then this keeps it until the page is on screen: the
     * page starts with the same sphere at the same size and place (index.html), so the hand-over does not show.
     */
    private fun holdSplash() {
        if (Build.VERSION.SDK_INT < 31) return
        splashHeld = true
        val content = findViewById<View>(android.R.id.content)
        content.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                if (splashHeld && SystemClock.uptimeMillis() - createdAt < 1500) return false
                content.viewTreeObserver.removeOnPreDrawListener(this)
                return true
            }
        })
        // No exit animation of its own: what is under it already looks the same.
        splashScreen.setOnExitAnimationListener { it.remove() }
    }

    // ---------------------------------------------------------------- layout

    /** Content between the system bars and above the keyboard; the bars themselves show the page's colour. */
    private fun edgeToEdge() {
        if (Build.VERSION.SDK_INT < 30) return
        // Android 15 does this by itself for apps targeting it; 11 to 14 need asking.
        @Suppress("DEPRECATION") window.setDecorFitsSystemWindows(false)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsets.CONSUMED
        }
    }

    private fun lightBars(light: Boolean) {
        if (Build.VERSION.SDK_INT < 30) return
        val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(if (light) mask else 0, mask)
    }

    private fun isLight(c: Int) = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000 > 140

    /** The page's background, e.g. "rgb(20, 21, 27)": kept for the next launch's first frame. */
    fun onTheme(css: String) {
        val m = Regex("""rgba?\((\d+),\s*(\d+),\s*(\d+)""").find(css) ?: return
        val (r, g, b) = m.destructured
        val c = Color.rgb(r.toInt(), g.toInt(), b.toInt())
        if (c == bg) return
        bg = c
        Hub.prefs(this).edit().putInt("bg", c).apply()
        window.setBackgroundDrawable(ColorDrawable(c))
        root.setBackgroundColor(c)
        web?.setBackgroundColor(c)
        lightBars(isLight(c))
    }

    // ---------------------------------------------------------------- the page

    private fun showWeb(origin: Uri, hash: String?) {
        dropWeb()
        val w = WebView(this)
        w.setBackgroundColor(bg)
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Call audio and notification sounds start without a tap.
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
        }
        w.webViewClient = Client()
        w.webChromeClient = Chrome()
        w.setDownloadListener { url, _, disposition, mime, _ ->
            val u = Uri.parse(url)
            if (HubFiles.isHubFile(u, hub)) HubFiles.open(this, u, null, mime, disposition) else openExternal(u)
        }
        // Only the hub's origin gets the bridge: a page it links to never sees DitherAndroid at all.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            val b = Bridge(this, origin)
            WebViewCompat.addWebMessageListener(w, "DitherAndroid", setOf(origin.toString()), b)
            bridge = b
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) WebViewCompat.addDocumentStartJavaScript(w, PROBE, setOf(origin.toString()))
        } else Log.w(TAG, "this WebView has no WebMessageListener: calls and push stay off")
        root.addView(w, FrameLayout.LayoutParams(-1, -1))
        web = w
        loadAt = SystemClock.uptimeMillis()
        w.loadUrl("$origin/" + (hash?.let { "#$it" } ?: ""))
    }

    private fun dropWeb() {
        val w = web ?: return
        web = null
        bridge = null
        root.removeView(w)
        w.destroy()
    }

    private fun isAppPath(path: String?) = path.isNullOrEmpty() || path == "/" || path == "/index.html"

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val u = request.url
            if (Hub.sameOrigin(u, hub) && isAppPath(u.path)) return false
            // The hub's own files are downloaded and offered to the apps that open them; links out of the app go to the system.
            if (HubFiles.isHubFile(u, hub)) HubFiles.open(this@MainActivity, u, null, null) else openExternal(u)
            return true
        }

        override fun onPageCommitVisible(view: WebView, url: String?) {
            splashHeld = false
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            // Once the service worker holds the shell this does not happen offline; before that it can.
            if (request.isForMainFrame) showSetup(hub?.toString(), "Could not open the hub: ${error.description}")
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            // Opening a conversation clears its notification, as the service worker does in a browser.
            val conv = Regex("""#/.*?/?c/([\w-]+)""").find(url ?: "")?.groupValues?.get(1)
            conv?.let { Notifications.clear(this@MainActivity, it) }
            // A request opened: its row on the list goes the same way.
            Regex("""#/requests/([\w-]+)""").find(url ?: "")?.groupValues?.get(1)?.let { Notifications.clear(this@MainActivity, "request:$it") }
            // And tells the system which conversation is on screen, the one its shortcut and notification name.
            if (Build.VERSION.SDK_INT >= 30) setLocusContext(conv?.let { LocusId(Notifications.shortcutId(it)) }, null)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "renderer gone (crashed: ${detail.didCrash()}), reloading")
            if (view == web) {
                web = null
                bridge = null
                root.removeView(view)
                view.destroy()
                hub?.let { showWeb(it, null) }
            } else view.destroy()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
                if (!Hub.sameOrigin(request.origin, hub)) return@runOnUiThread request.deny()
                val needed = request.resources.mapNotNull(::permissionFor).filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
                if (needed.isEmpty()) grantGranted(request)
                else {
                    mediaRequest?.deny()
                    mediaRequest = request
                    requestPermissions(needed.distinct().toTypedArray(), REQ_MEDIA)
                }
            }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (mediaRequest == request) mediaRequest = null
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            files?.onReceiveValue(null)
            files = callback
            captured = null
            val intent = chooserIntent(params)
            try {
                startActivityForResult(intent, REQ_FILES)
            } catch (e: Exception) {
                // No app for it, or the camera app refused us: the plain picker, else nothing.
                Log.w(TAG, "could not open ${intent.action}", e)
                captured = null
                val plain = params.createIntent().putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                try {
                    if (intent.action == plain.action) throw e
                    startActivityForResult(plain, REQ_FILES)
                } catch (e: Exception) {
                    files = null
                    callback.onReceiveValue(null)
                }
            }
            return true
        }

        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
            // Release builds keep only the app's own timing lines, never what a page logs about messages.
            val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
            if (debuggable || m.message().startsWith("[dither]")) Log.i("DitherWeb", "${m.messageLevel()}: ${m.message()}")
            return true
        }
    }

    /**
     * What the page's file input asks for (docs/uploads.md, "On a phone"). WebView's own intent keeps only the first
     * of its types and ignores `capture`, so an input for photos and videos would offer photos alone. Instead:
     * - `capture` on an image input: the camera app, writing to a file of ours (Captures). Only with the camera
     *   allowed, since Android refuses that intent to an app that declares CAMERA without holding it; a page asks
     *   for this after the camera was refused, so then it is the photo picker.
     * - Photos and videos: the system photo picker (Android 13+), which reads them without any permission of ours.
     *   Before 13, the documents picker for both kinds.
     * - Anything else: WebView's own, several at once where the input allows.
     */
    private fun chooserIntent(params: WebChromeClient.FileChooserParams): Intent {
        val multiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        val types = params.acceptTypes.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        val images = types.isNotEmpty() && types.all { it.startsWith("image/") }
        val videos = types.isNotEmpty() && types.all { it.startsWith("video/") }
        val media = types.isNotEmpty() && types.all { it.startsWith("image/") || it.startsWith("video/") }
        if (params.isCaptureEnabled && images && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            val uri = Captures.newPhoto(this)
            captured = uri
            return Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        if (media && Build.VERSION.SDK_INT >= 33) {
            return Intent(MediaStore.ACTION_PICK_IMAGES).apply {
                if (images) type = "image/*" else if (videos) type = "video/*"
                if (multiple) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit())
            }
        }
        if (media) {
            return Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                .putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
        }
        return params.createIntent().putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
    }

    private fun permissionFor(resource: String) = when (resource) {
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
        else -> null
    }

    /** Grants what Android allowed, refuses the rest (protected media, MIDI: the app uses neither). */
    private fun grantGranted(request: PermissionRequest) {
        val ok = request.resources.filter { r -> permissionFor(r)?.let { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED } == true }
        if (ok.isEmpty()) request.deny() else request.grant(ok.toTypedArray())
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        when (requestCode) {
            REQ_MEDIA -> mediaRequest?.let(::grantGranted).also { mediaRequest = null }
            REQ_NOTIFY -> afterNotify?.invoke(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED).also { afterNotify = null }
        }
    }

    fun ensureNotifications(then: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return then(true)
        afterNotify = then
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
    }

    @Deprecated("Activity result API", level = DeprecationLevel.WARNING)
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_UPLOAD) return onUploadPicked(resultCode, data)
        if (requestCode != REQ_FILES) return super.onActivityResult(requestCode, resultCode, data)
        val cb = files ?: return
        files = null
        val photo = captured
        captured = null
        // The camera app wrote to our file and says nothing more.
        val picked = if (photo != null) photo.takeIf { resultCode == RESULT_OK && Captures.taken(this, it) }?.let { arrayOf(it) }
        else if (resultCode != RESULT_OK || data == null) null
        else data.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } } ?: data.data?.let { arrayOf(it) }
        cb.onReceiveValue(picked)
    }

    private fun openExternal(u: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "nothing opens $u")
        }
    }

    // ---------------------------------------------------------------- back

    /**
     * Back walks the page's history (its routes, sheets and panels push entries); at the start the app goes to the
     * background, kept alive so the next open is instant. Decided at the press: WebView does not report the page's
     * hash and pushState entries through doUpdateVisitedHistory, so registering only while canGoBack() misses them.
     */
    private fun back() {
        val w = web
        if (w != null && w.canGoBack()) w.goBack() else moveTaskToBack(true)
    }

    private fun registerBack() {
        if (Build.VERSION.SDK_INT < 33 || backCallback != null) return
        val cb = OnBackInvokedCallback { back() }
        onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb)
        backCallback = cb
    }

    @Deprecated("Before Android 13", level = DeprecationLevel.WARNING)
    override fun onBackPressed() = back()

    // ---------------------------------------------------------------- lifecycle

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val hash = hashFrom(intent) ?: return
        val b = bridge
        if (b != null) b.send(JSONObject().put("t", "open").put("hash", hash)) else hub?.let { showWeb(it, hash) }
    }

    private fun hashFrom(i: Intent?) = i?.getStringExtra(EXTRA_HASH)?.takeIf { it.startsWith("/") }

    override fun onResume() {
        super.onResume()
        resumed = this
        web?.onResume()
        bridge?.resumed()
        UploadService.resumeIfStopped(this)
    }

    override fun onPause() {
        super.onPause()
        resumed = null
        // A call keeps the page running. Otherwise pause what can be (animations, sensors); JS and the socket go on.
        if (!callActive) web?.onPause()
    }

    override fun onDestroy() {
        if (current == this) current = null
        dropWeb()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- from the page

    /** What the page says it painted from (`ready`) and when the hub's own data arrived (`fresh`). */
    fun onPageTiming(what: String, pageMs: Long, source: String?) {
        Log.i(TAG, "$what${source?.let { " from the $it" } ?: ""}: ${pageMs} ms after the page started")
    }

    /** The first frame with content (PROBE). `at` and `origin` are the page's wall clock: when it posted, when it started. */
    fun onProbe(pageMs: Long, at: Long, origin: Long) {
        val now = SystemClock.uptimeMillis()
        val kind = if (cold && !drawnReported) "cold" else "warm"
        val toWall = System.currentTimeMillis() - now
        val proc = Process.getStartUptimeMillis()
        Log.i(TAG, "probe content ($kind): ${now - proc} ms after process start, ${now - createdAt} ms after onCreate, ${pageMs} ms after the page started" +
            " (page started ${origin - toWall - proc} ms after process start, loadUrl at ${loadAt - proc}; posted ${at - toWall - proc}, delivered ${now - (at - toWall)} ms later)")
        if (!drawnReported) {
            drawnReported = true
            reportFullyDrawn()
        }
    }

    fun onCall(m: JSONObject) {
        val active = m.optBoolean("active")
        callActive = active
        // During a call the renderer keeps its priority with the screen off, so Android does not reclaim it first.
        web?.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, !active)
        CallService.update(this, m)
        // Android 13+ hides a foreground service's notification without this, and with it the hang-up button.
        // A notification posted before the grant stays hidden, so post it again after.
        if (active) ensureNotifications { granted -> if (granted && callActive) CallService.update(this, m) }
    }

    fun changeHub() = showSetup(hub?.toString(), null)

    // ---------------------------------------------------------------- history uploads (Uploads.kt)

    private var uploadFor: Pair<String, String>? = null

    /** The system picker for an upload that goes on with the app closed: files ("files"), or a whole folder ("folder"). */
    fun pickUpload(accountId: String, mode: String) {
        val b = bridge ?: return
        if (accountId.isEmpty()) return
        if (Uploads.load(this)?.state == "running") return b.send(JSONObject().put("t", "upload.error").put("error", "An upload is already running."))
        val i = if (mode == "folder") Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        else Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        uploadFor = accountId to mode
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(i, REQ_UPLOAD)
        } catch (e: ActivityNotFoundException) {
            uploadFor = null
            b.send(JSONObject().put("t", "upload.error").put("error", "This phone has no file picker."))
        }
    }

    private fun onUploadPicked(resultCode: Int, data: Intent?) {
        val (account, mode) = uploadFor ?: return
        uploadFor = null
        val uris = if (resultCode != RESULT_OK || data == null) emptyList()
        else data.clipData?.let { c -> List(c.itemCount) { c.getItemAt(it).uri } } ?: listOfNotNull(data.data)
        if (uris.isEmpty()) return bridge?.send(JSONObject().put("t", "upload.error").put("error", "cancelled")) ?: Unit
        bridge?.send(JSONObject().put("t", "upload").put("state", "listing").put("accountId", account))
        Uploads.begin(this, account, if (mode == "folder") emptyList() else uris, if (mode == "folder") uris[0] else null)
        // Without notifications Android still runs the upload; it only can't show how far it got.
        ensureNotifications { }
    }

    fun resumeUpload() {
        val j = Uploads.load(this) ?: return
        if (j.state == "error") return
        j.state = "running"
        Uploads.save(this, j)
        UploadService.start(this)
    }

    /** Stop and forget the upload on this phone. What the hub has of it stays there, to delete or carry on from. */
    fun forgetUpload() {
        UploadService.pause(this)
        Uploads.clear(this)
        getSystemService(android.app.NotificationManager::class.java).cancel(UploadService.OUTCOME)
        bridge?.send(Uploads.state(this))
    }

    /** A file from a message, with the name and type the page knows. Only the hub's own files. */
    fun openFileForPage(url: String, name: String?, mime: String?) {
        val h = hub ?: return
        val u = runCatching { Uri.parse(java.net.URL(java.net.URL(h.toString()), url).toString()) }.getOrNull() ?: return
        if (HubFiles.isHubFile(u, hub)) HubFiles.open(this, u, name, mime)
    }

    fun registerPush(vapid: String) {
        val b = bridge ?: return
        ensureNotifications { granted ->
            if (!granted) return@ensureNotifications b.send(Push.error("Notifications are off for this app. Allow them in Android's settings, then try again."))
            Push.vapid = vapid.ifEmpty { null }
            UnifiedPush.tryUseCurrentOrDefaultDistributor(this) { ok ->
                runOnUiThread {
                    if (ok) return@runOnUiThread Push.register(this)
                    val all = UnifiedPush.getDistributors(this)
                    when (all.size) {
                        0 -> b.send(Push.error("No UnifiedPush distributor is installed. Install one, such as ntfy, and try again."))
                        1 -> UnifiedPush.saveDistributor(this, all[0]).also { Push.register(this) }
                        else -> AlertDialog.Builder(this)
                            .setTitle("Push through")
                            .setItems(all.map(::appLabel).toTypedArray()) { _, i ->
                                UnifiedPush.saveDistributor(this, all[i])
                                Push.register(this)
                            }
                            .setOnCancelListener { b.send(Push.error("No distributor picked.")) }
                            .show()
                    }
                }
            }
        }
    }

    /** What the push settings can send the user to: the distributor, its App info (battery use), or this app's notifications. */
    fun openForPage(what: String, pkg: String?) {
        val i = when (what) {
            "app" -> pkg?.let { packageManager.getLaunchIntentForPackage(it) }
            "appInfo" -> pkg?.let { Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$it")) }
            "notifications" -> Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName)
            else -> null
        } ?: return
        try {
            startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "cannot open $what for $pkg", e)
        }
    }

    fun appLabel(pkg: String): String =
        runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)

    // ---------------------------------------------------------------- first run

    private fun showSetup(prefill: String?, error: String?) {
        splashHeld = false
        dropWeb()
        root.removeAllViews()
        val dp = { v: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt() }
        val fg = Color.rgb(230, 230, 240)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }
        fun text(s: String, size: Float, color: Int) = TextView(this).apply {
            this.text = s
            textSize = size
            setTextColor(color)
            setPadding(0, 0, 0, dp(12))
        }
        col.addView(text("dither-chat", 26f, fg))
        col.addView(text("The address of your hub, as you open it in a browser on your tailnet. https is needed for calls and the offline start.", 15f, Color.rgb(160, 162, 180)))
        val input = EditText(this).apply {
            hint = "https://chat.example.net"
            setText(prefill ?: "")
            setTextColor(fg)
            setHintTextColor(Color.rgb(110, 112, 130))
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
        }
        col.addView(input)
        val status = text(error ?: "", 14f, Color.rgb(255, 120, 120)).apply { visibility = if (error == null) View.GONE else View.VISIBLE }
        col.addView(status)
        val go = Button(this).apply { text = if (error == null) "Connect" else "Try again" }
        val anyway = Button(this).apply { text = "Use it anyway"; visibility = View.GONE }
        col.addView(go)
        col.addView(anyway)
        root.addView(col, FrameLayout.LayoutParams(-1, -1))

        fun use(u: Uri) {
            Hub.setOrigin(this, u)
            hub = u
            root.removeAllViews()
            showWeb(u, null)
        }
        fun connect() {
            val u = Hub.normalize(input.text.toString())
            if (u == null) {
                status.text = "That is not an address."
                status.visibility = View.VISIBLE
                return
            }
            go.isEnabled = false
            status.text = "Checking $u …"
            status.visibility = View.VISIBLE
            Thread {
                val result = runCatching { probe(u) }.getOrElse { it.message ?: it.toString() }
                runOnUiThread {
                    go.isEnabled = true
                    if (result == null) return@runOnUiThread use(u)
                    status.text = "Could not reach $u: $result"
                    anyway.visibility = View.VISIBLE
                    anyway.setOnClickListener { use(u) }
                }
            }.start()
        }
        go.setOnClickListener { connect() }
        input.setOnEditorActionListener { _, id, _ -> (id == EditorInfo.IME_ACTION_GO).also { if (it) connect() } }
    }

    /** null when the hub answers its health check. */
    private fun probe(u: Uri): String? {
        val conn = java.net.URL("$u/api/health").openConnection() as java.net.HttpURLConnection
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        return try {
            if (conn.responseCode == 200 && JSONObject(conn.inputStream.bufferedReader().readText()).optBoolean("ok")) null
            else "it answered ${conn.responseCode}"
        } finally {
            conn.disconnect()
        }
    }
}

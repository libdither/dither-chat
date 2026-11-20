plugins {
    id("com.android.application")
}

/**
 * Not an app anyone installs: a UnifiedPush distributor for the emulator tests, which stands in for the ntfy app where
 * a device has no distributor (CI's emulator). It speaks the distributor's side of the UnifiedPush protocol to the
 * app's connector and has no server of its own: scripts/verify-android-call.ts runs one on the computer, takes the
 * hub's Web Push requests there, and hands each body to this app over adb, which passes it on to the app as ntfy would.
 */
android {
    namespace = "org.libdither.chat.testpush"
    compileSdk {
        version = release(36) { minorApiLevel = 1 }
    }
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "org.libdither.chat.testpush"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1"
    }
}

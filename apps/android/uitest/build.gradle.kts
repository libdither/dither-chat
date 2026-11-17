plugins {
    id("com.android.application")
}

/**
 * Not an app anyone installs: a test APK that instruments itself, so `am instrument` restarts only this package and
 * never the app under test (a call in it would end). Android's UiAutomation is system-wide, so it reaches the shade.
 * scripts/verify-android-call.ts runs it to press a notification's buttons while a call draws, which `uiautomator
 * dump` cannot: it waits for a screen that is still for a second, and a call's chronometer ticks every second.
 */
android {
    namespace = "org.libdither.chat.uitest"
    compileSdk {
        version = release(36) { minorApiLevel = 1 }
    }
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "org.libdither.chat.uitest"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
}

dependencies {
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}

plugins {
    id("com.android.application")
}

android {
    namespace = "org.libdither.chat"
    compileSdk {
        version = release(36) { minorApiLevel = 1 }
    }
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "org.libdither.chat"
        // 29: Android 10. Older phones lack the audio routing and notification APIs this uses.
        minSdk = 29
        targetSdk = 36
        // CI sets these from the release tag and run number (.github/workflows/android.yml).
        versionCode = (System.getenv("DITHER_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("DITHER_VERSION_NAME") ?: "0.1.0"
    }

    // A release key from the environment (CI keeps it in repository secrets), so every published APK installs
    // over the last. Without one, release builds use the debug key, which only updates builds from the same machine.
    val releaseKey = System.getenv("DITHER_KEYSTORE")?.takeIf { file(it).exists() }
    signingConfigs {
        if (releaseKey != null) {
            create("release") {
                storeFile = file(releaseKey)
                storePassword = System.getenv("DITHER_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DITHER_KEY_ALIAS")
                keyPassword = System.getenv("DITHER_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName(if (releaseKey != null) "release" else "debug")
        }
    }
    packaging {
        resources.excludes += setOf("META-INF/*.version", "META-INF/**/*.kotlin_builtins", "kotlin/**", "DebugProbesKt.bin")
    }
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("org.unifiedpush.android:connector:3.3.5")
}

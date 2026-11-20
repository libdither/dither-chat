pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "dither-chat"
include(":app")
// Presses notification buttons for scripts/verify-android-call.ts (uitest/build.gradle.kts); never shipped.
include(":uitest")
// A UnifiedPush distributor for the emulator tests where a device has none (testpush/build.gradle.kts); never shipped.
include(":testpush")

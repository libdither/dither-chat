package org.libdither.chat.uitest

import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import org.junit.Assert.fail
import org.junit.Test
import java.util.regex.Pattern

/**
 * Presses a button in the notification shade by its words:
 *
 *   am instrument -w -e class org.libdither.chat.uitest.Shade#press -e words 'Hang up' \
 *     org.libdither.chat.uitest.test/androidx.test.runner.AndroidJUnitRunner
 *
 * `words` match whole, ignoring case and the direction marks Android puts around a call notification's buttons.
 * Never waits for the screen to be still: a call notification's chronometer never lets it be.
 */
class Shade {
    @Test
    fun press() {
        val words = InstrumentationRegistry.getArguments().getString("words") ?: return fail("pass -e words '<button words>'")
        val ms = InstrumentationRegistry.getArguments().getString("ms")?.toLongOrNull() ?: 10_000L
        Configurator.getInstance().apply {
            waitForIdleTimeout = 0
            waitForSelectorTimeout = 0
        }
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val want = Pattern.compile("[\\p{Cf}\\s\\uFFFD]*" + Pattern.quote(words) + "[\\p{Cf}\\s\\uFFFD]*", Pattern.CASE_INSENSITIVE)
        device.openNotification()
        val end = SystemClock.uptimeMillis() + ms
        while (SystemClock.uptimeMillis() < end) {
            val hit = device.findObject(By.text(want)) ?: device.findObject(By.desc(want))
            if (hit != null) {
                hit.click()
                println("pressed: $words")
                return
            }
            SystemClock.sleep(250)
        }
        val seen = device.findObjects(By.clickable(true)).mapNotNull { it.text ?: it.contentDescription }.joinToString(" | ")
        fail("no button \"$words\" in the shade; buttons: $seen")
    }
}

package org.libdither.chat

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * Where call audio goes. Android 12+ picks among the devices the platform offers for communication
 * (setCommunicationDevice); before that, only speaker or earpiece.
 */
object Audio {
    private const val EARPIECE = -1
    private const val SPEAKER = -2

    class Route(val id: Int, val kind: String, val name: String)

    private fun am(c: Context) = c.getSystemService(AudioManager::class.java)

    private fun kind(type: Int) = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> "bluetooth"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
        AudioDeviceInfo.TYPE_HEARING_AID -> "hearing aid"
        else -> null
    }

    private fun label(kind: String, product: CharSequence?) = when (kind) {
        "speaker" -> "Speaker"
        "earpiece" -> "Phone"
        else -> product?.toString()?.takeIf { it.isNotBlank() } ?: kind.replaceFirstChar { it.uppercase() }
    }

    fun routes(c: Context): List<Route> =
        if (Build.VERSION.SDK_INT >= 31) am(c).availableCommunicationDevices.mapNotNull { d -> kind(d.type)?.let { Route(d.id, it, label(it, d.productName)) } }
        else listOf(Route(EARPIECE, "earpiece", "Phone"), Route(SPEAKER, "speaker", "Speaker"))

    fun current(c: Context): Int? =
        if (Build.VERSION.SDK_INT >= 31) am(c).communicationDevice?.id
        else @Suppress("DEPRECATION") if (am(c).isSpeakerphoneOn) SPEAKER else EARPIECE

    fun currentRoute(c: Context): Route? = current(c)?.let { id -> routes(c).firstOrNull { it.id == id } }

    fun select(c: Context, id: Int) {
        if (Build.VERSION.SDK_INT >= 31) am(c).availableCommunicationDevices.firstOrNull { it.id == id }?.let { am(c).setCommunicationDevice(it) }
        else @Suppress("DEPRECATION") run { am(c).isSpeakerphoneOn = id == SPEAKER }
    }

    /** The next device, for the call notification's one audio button. */
    fun next(c: Context) {
        val rs = routes(c)
        if (rs.isEmpty()) return
        val i = rs.indexOfFirst { it.id == current(c) }
        select(c, rs[(i + 1) % rs.size].id)
    }

    fun reset(c: Context) {
        if (Build.VERSION.SDK_INT >= 31) am(c).clearCommunicationDevice()
        else @Suppress("DEPRECATION") run { am(c).isSpeakerphoneOn = false }
    }

    fun state(c: Context): JSONObject = JSONObject()
        .put("t", "audio")
        .put("routes", JSONArray(routes(c).map { JSONObject().put("id", it.id).put("kind", it.kind).put("name", it.name) }))
        .put("current", current(c) ?: JSONObject.NULL)
}

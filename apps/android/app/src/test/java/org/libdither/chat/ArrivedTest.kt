package org.libdither.chat

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * The records Arrived.kt keeps for the page (docs/notifications.md, "A copy in the push"): the same as the service
 * worker keeps in a browser (packages/web/test/sw.test.ts), in a file.
 */
class ArrivedTest {
    private lateinit var dir: File
    private val day = 24 * 3600 * 1000L
    private val t = 1_800_000_000_000L

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("arrived").toFile()
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    private fun copy(conv: String, id: String) = JSONObject()
        .put("conversationId", conv)
        .put("arrived", JSONObject().put("message", JSONObject().put("id", id).put("conversationId", conv).put("body", "hi")))

    private fun clear(conv: String, upTo: Long? = null) = JSONObject().put("clear", conv).apply { if (upTo != null) put("upTo", upTo) }

    private fun kept(now: Long = t): List<JSONObject> = Arrived.list(dir, now).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

    @Test
    fun keepsAMessagesCopy() {
        val r = Arrived.keep(dir, copy("conv_a", "msg_1"), t)
        assertEquals(1, r.size)
        assertEquals("m:msg_1", r[0].getString("key"))
        assertEquals("message", r[0].getString("kind"))
        assertEquals("conv_a", r[0].getString("conv"))
        assertEquals(t, r[0].getLong("at"))
        assertEquals("hi", r[0].getJSONObject("arrived").getJSONObject("message").getString("body"))
        assertEquals(listOf("m:msg_1"), kept().map { it.getString("key") })
    }

    @Test
    fun aCopyOfAnotherChatsMessageIsNotKept() {
        val d = copy("conv_a", "msg_1").put("conversationId", "conv_b")
        assertTrue(Arrived.keep(dir, d, t).isEmpty())
        assertFalse(File(dir, "arrived.json").exists())
    }

    @Test
    fun aPushWithNeitherKeepsNothing() {
        assertTrue(Arrived.keep(dir, JSONObject().put("title", "x").put("conversationId", "conv_a"), t).isEmpty())
        assertFalse(File(dir, "arrived.json").exists())
    }

    @Test
    fun aReadIsKeptWithItsUpToAndASweepIsNot() {
        // A clear without upTo is the hub taking back a phone-list row, not a read.
        assertTrue(Arrived.keep(dir, clear("conv_a"), t).isEmpty())
        val r = Arrived.keep(dir, clear("conv_a", 500).put("more", JSONArray().put(clear("conv_b", 700)).put(clear("conv_c"))), t)
        assertEquals(listOf("c:conv_a" to 500L, "c:conv_b" to 700L), r.map { it.getString("key") to it.getLong("upTo") })
        assertEquals(setOf("c:conv_a", "c:conv_b"), kept().map { it.getString("key") }.toSet())
    }

    @Test
    fun readsOfAChatAreOneRecordKeepingTheFurthest() {
        Arrived.keep(dir, clear("conv_a", 900), t)
        Arrived.keep(dir, clear("conv_a", 400), t + 1)
        assertEquals(listOf(900L), kept().map { it.getLong("upTo") })
        Arrived.keep(dir, clear("conv_a", 1200), t + 2)
        assertEquals(listOf(1200L), kept().map { it.getLong("upTo") })
        assertEquals(t + 2, kept().single().getLong("at"))
    }

    @Test
    fun theSameMessageAgainReplacesItsCopy() {
        Arrived.keep(dir, copy("conv_a", "msg_1"), t)
        Arrived.keep(dir, copy("conv_a", "msg_1"), t + 5)
        assertEquals(listOf(t + 5), kept().map { it.getLong("at") })
    }

    @Test
    fun nothingOlderThanThreeDaysIsListedOrKept() {
        Arrived.keep(dir, copy("conv_a", "msg_old"), t)
        Arrived.keep(dir, copy("conv_a", "msg_new"), t + 2 * day)
        assertEquals(setOf("m:msg_old", "m:msg_new"), kept(t + 2 * day).map { it.getString("key") }.toSet())
        // Listed: the old one is past three days now, though still in the file.
        assertEquals(listOf("m:msg_new"), kept(t + 3 * day + 1).map { it.getString("key") })
        // Kept: a write drops it from the file.
        Arrived.keep(dir, copy("conv_a", "msg_newer"), t + 3 * day + 1)
        assertEquals(setOf("m:msg_new", "m:msg_newer"), kept(t).map { it.getString("key") }.toSet())
    }

    @Test
    fun atMostThreeHundredTheNewest() {
        for (i in 0 until 305) Arrived.keep(dir, copy("conv_a", "msg_$i"), t + i)
        val keys = kept(t + 305).map { it.getString("key") }
        assertEquals(300, keys.size)
        assertFalse("m:msg_4" in keys)
        assertTrue("m:msg_5" in keys && "m:msg_304" in keys)
    }

    @Test
    fun doneDeletesWhatCameUpToThatTime() {
        Arrived.keep(dir, copy("conv_a", "msg_1"), t)
        Arrived.keep(dir, clear("conv_b", 10), t + 10)
        Arrived.keep(dir, copy("conv_a", "msg_2"), t + 20)
        Arrived.done(dir, t + 10)
        assertEquals(listOf("m:msg_2"), kept().map { it.getString("key") })
        Arrived.done(dir, t + 20)
        assertTrue(kept().isEmpty())
        assertFalse(File(dir, "arrived.json").exists())
    }

    @Test
    fun aDamagedFileReadsAsEmptyAndIsReplaced() {
        File(dir, "arrived.json").writeText("{not json")
        assertTrue(kept().isEmpty())
        Arrived.keep(dir, copy("conv_a", "msg_1"), t)
        assertEquals(listOf("m:msg_1"), kept().map { it.getString("key") })
        assertFalse(File(dir, "arrived.json.tmp").exists())
    }
}

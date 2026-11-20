package org.libdither.chat

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a push's payload means before anything is drawn (docs/android.md, "Notifications"): its tier, marks and chat. */
class NotificationsTest {
    @Test
    fun theTierOfAPush() {
        assertEquals("push", Notifications.tierOf(JSONObject().put("tier", "push")))
        assertEquals("quiet", Notifications.tierOf(JSONObject().put("tier", "quiet")))
        assertEquals("digest", Notifications.tierOf(JSONObject().put("tier", "digest")))
        // A hub from before the tiers sends only `level`, which knows the first two.
        assertEquals("quiet", Notifications.tierOf(JSONObject().put("level", "quiet")))
        assertEquals("push", Notifications.tierOf(JSONObject().put("level", "alert")))
        assertEquals("push", Notifications.tierOf(JSONObject().put("tier", "something-new")))
        assertEquals("push", Notifications.tierOf(JSONObject()))
    }

    @Test
    fun theMarksEachTierOffers() {
        val m = JSONObject().put("messageId", "msg_1")
        assertEquals(listOf(Notifications.Mark.CALM), Notifications.marksOf(m, "push")!!.offered)
        assertEquals(listOf(Notifications.Mark.ALERT), Notifications.marksOf(m, "quiet")!!.offered)
        assertEquals(listOf(Notifications.Mark.LESS, Notifications.Mark.ALERT), Notifications.marksOf(m, "digest")!!.offered)
        // Mail has no alert marks, and its marks go to mail's own route.
        val mail = Notifications.marksOf(JSONObject(m.toString()).put("mailThreadId", "t1"), "push")!!
        assertTrue(mail.mail)
        assertEquals(listOf(Notifications.Mark.LESS), mail.offered)
        // A push about no message (a request) has none.
        assertNull(Notifications.marksOf(JSONObject(), "push"))
    }

    @Test
    fun whatEachMarkTellsTheHub() {
        assertEquals("""{"alert":true}""", Notifications.Mark.ALERT.body().toString())
        assertEquals("""{"alert":false}""", Notifications.Mark.CALM.body().toString())
        assertEquals("""{"less":true}""", Notifications.Mark.LESS.body().toString())
        assertEquals(Notifications.Mark.LESS, Notifications.Mark.of("less"))
        assertNull(Notifications.Mark.of("nope"))
        assertFalse(Notifications.Mark.ALERT.closes)
    }

    private fun line(author: String, key: String, body: String, ts: Long) = JSONObject().put("author", author).put("key", key).put("body", body).put("ts", ts)

    @Test
    fun aGroupsLinesSayWhoWroteThem() {
        val d = JSONObject()
            .put("title", "Ada")
            .put("conv", JSONObject().put("shape", "group").put("title", "Climbing").put("icon", "/g.png"))
            .put("sender", JSONObject().put("key", "p_ada").put("name", "Ada").put("icon", "/ada.png"))
            .put("icons", JSONObject().put("p_bo", "/bo.png"))
            .put("lines", JSONArray().put(line("Bo", "p_bo", "first", 1)).put(line("Ada", "p_ada", "second", 2)))
        val chat = Notifications.Chat(d)
        assertTrue(chat.group)
        assertEquals("Climbing", chat.name)
        assertEquals(listOf("first", "second"), chat.lines.map { it.body })
        assertEquals("Ada: second", chat.text(chat.last))
        assertEquals(listOf("/g.png"), chat.icon())
        assertEquals("/bo.png", chat.iconOf("p_bo"))
        assertEquals("/ada.png", chat.iconOf("p_ada"))
        assertEquals(setOf("/bo.png", "/ada.png", "/g.png"), chat.pictures().toSet())
    }

    @Test
    fun aDirectChatIsThePerson() {
        val d = JSONObject()
            .put("title", "Bo")
            .put("conv", JSONObject().put("shape", "direct"))
            .put("sender", JSONObject().put("key", "p_bo").put("name", "Bo").put("icon", "/bo.png"))
            .put("lines", JSONArray().put(line("Bo", "p_bo", "hey", 1)))
        val chat = Notifications.Chat(d)
        assertFalse(chat.group)
        assertEquals("Bo", chat.name)
        assertEquals("hey", chat.text(chat.last))
        assertEquals(listOf("/bo.png", "/bo.png"), chat.icon())
    }

    @Test
    fun anOlderHubsOneMessageIsTitleAndBody() {
        // No `lines` and no `sender`: one line from the title, its picture the push's icon.
        val chat = Notifications.Chat(JSONObject().put("title", "Cy").put("body", "old style").put("icon", "/cy.png"))
        assertEquals(1, chat.lines.size)
        assertEquals("Cy", chat.last.author)
        assertEquals("old style", chat.last.body)
        assertEquals("/cy.png", chat.iconOf("Cy"))
        // An empty `lines` falls back the same way.
        assertEquals("x", Notifications.Chat(JSONObject().put("title", "Cy").put("body", "x").put("lines", JSONArray())).last.body)
    }

    @Test
    fun aLineWithoutAKeyIsItsAuthor() {
        val l = JSONObject().put("author", "Dee").put("body", "b").put("ts", 3)
        val chat = Notifications.Chat(JSONObject().put("lines", JSONArray().put(l)))
        assertEquals("Dee", chat.last.key)
        assertEquals("dither-chat", chat.name)
    }
}

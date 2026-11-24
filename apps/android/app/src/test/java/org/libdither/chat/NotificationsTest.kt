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
    fun theAnswersEachTierOffers() {
        val m = JSONObject().put("messageId", "msg_1")
        assertEquals(listOf(Notifications.Mark.WORTH, Notifications.Mark.COULD_WAIT), Notifications.marksOf(m, "push")!!.offered)
        assertEquals(listOf(Notifications.Mark.LOUDER), Notifications.marksOf(m, "quiet")!!.offered)
        assertEquals(listOf(Notifications.Mark.QUIETER, Notifications.Mark.LOUDER), Notifications.marksOf(m, "digest")!!.offered)
        // A notice keeps the marks from before the scale.
        val notice = JSONObject(m.toString()).put("noticeId", "ntc_1")
        assertEquals(listOf(Notifications.Mark.CALM), Notifications.marksOf(notice, "push")!!.offered)
        assertEquals(listOf(Notifications.Mark.LESS, Notifications.Mark.ALERT), Notifications.marksOf(notice, "digest")!!.offered)
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
        assertEquals("/api/messages/msg_1/feedback", Notifications.Mark.LESS.path("msg_1", false))
        assertEquals("/api/mail/triage/mml_1/vote", Notifications.Mark.LESS.path("mml_1", true))
        // An answer goes to the scale's answers, saying where it came from.
        assertEquals("/api/loudness/answers", Notifications.Mark.COULD_WAIT.path("msg_1", false))
        val b = Notifications.Mark.COULD_WAIT.body("msg_1")
        assertEquals("msg_1", b.getString("messageId"))
        assertEquals("could_wait", b.getString("answer"))
        assertEquals("notification", b.getString("source"))
        assertEquals(Notifications.Mark.LESS, Notifications.Mark.of("less"))
        assertEquals(Notifications.Mark.WORTH, Notifications.Mark.of("worth"))
        assertNull(Notifications.Mark.of("nope"))
        assertFalse(Notifications.Mark.ALERT.closes)
        assertFalse(Notifications.Mark.LOUDER.closes)
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

    @Test
    fun aClearDropsOnlyWhatWasRead() {
        val ts = longArrayOf(100, 200, 300)
        // Read up to the second: the third, which came after the read, stays.
        assertEquals(listOf(2), Notifications.unreadAfter(ts, 200))
        // At its time counts as read.
        assertEquals(emptyList<Int>(), Notifications.unreadAfter(ts, 300))
        assertEquals(listOf(0, 1, 2), Notifications.unreadAfter(ts, 50))
        // Without upTo (a read here, an older hub) the whole notification goes.
        assertEquals(emptyList<Int>(), Notifications.unreadAfter(ts, null))
        assertEquals(emptyList<Int>(), Notifications.unreadAfter(LongArray(0), 10))
    }

    @Test
    fun theNewestMessageAPushShows() {
        assertEquals(500L, Notifications.newest(JSONObject().put("ts", 500).put("lines", JSONArray().put(line("A", "a", "x", 400)))))
        assertEquals(400L, Notifications.newest(JSONObject().put("lines", JSONArray().put(line("A", "a", "x", 300)).put(line("A", "a", "y", 400)))))
        assertNull(Notifications.newest(JSONObject().put("body", "no lines")))
        assertNull(Notifications.newest(JSONObject().put("lines", JSONArray().put(JSONObject().put("body", "no time")))))
    }
}

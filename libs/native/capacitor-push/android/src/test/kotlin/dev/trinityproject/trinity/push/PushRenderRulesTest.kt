package dev.trinityproject.trinity.push

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** native/push-render/push-render-cases.json, the fixture the iOS XCTest suite runs too. */
internal fun sharedFixture(): JSONObject = JSONObject(
    // build.gradle passes the fixture's path; the module is no fixed distance from the root.
    File(
        checkNotNull(System.getProperty("trinity.pushRenderCases")) {
            "trinity.pushRenderCases is unset: run this test through Gradle"
        },
    ).readText(),
)

class PushRenderRulesTest {
    @Test
    fun everySharedFixtureCaseRendersAsExpected() {
        val cases = sharedFixture().getJSONArray("cases")
        assertTrue("the fixture has cases", cases.length() > 0)
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val storedRoom = case.optJSONObject("storedRoom")?.let {
                HandoffRoom(it.getString("name"), it.getBoolean("direct"), it.optBoolean("encrypted", true))
            }
            val expected = case.getJSONObject("expected")
            val mode = case.optString("mode", NotificationTextMode.SHOW)
            assertTrue("${case.getString("name")}: unknown mode", mode in NotificationTextMode.ALL)
            val actual = PushRenderRules.render(
                case.optJSONObject("event"),
                storedRoom,
                case.opt("stateRoomName") as? String,
                case.opt("senderName") as? String,
                case.optBoolean("tokenExpired", false),
                mode,
            )
            assertEquals(
                case.getString("name"),
                RenderedNotification(
                    expected.getString("title"),
                    expected.getString("subtitle"),
                    expected.getString("body"),
                ),
                actual,
            )
        }
    }

    @Test
    fun alwaysHideNeverReadsTheEvent() {
        val event = JSONObject()
            .put("type", "m.room.message")
            .put("content", JSONObject().put("msgtype", "m.text").put("body", "Secret plans"))
        assertEquals(
            RenderedNotification("", "", "New message"),
            PushRenderRules.render(event, HandoffRoom("Team", false), "Team", "Alice", false, NotificationTextMode.ALWAYS_HIDE),
        )
    }
}

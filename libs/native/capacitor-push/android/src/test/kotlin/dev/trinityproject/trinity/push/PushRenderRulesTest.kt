package dev.trinityproject.trinity.push

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs native/push-render/push-render-cases.json, the fixture the iOS XCTest suite runs too. */
class PushRenderRulesTest {
    @Test
    fun everySharedFixtureCaseRendersAsExpected() {
        // build.gradle passes the fixture's path; the module is no fixed distance from the root.
        val fixture = File(
            checkNotNull(System.getProperty("trinity.pushRenderCases")) {
                "trinity.pushRenderCases is unset: run this test through Gradle"
            },
        )
        val cases = JSONObject(fixture.readText()).getJSONArray("cases")
        assertTrue("the fixture has cases", cases.length() > 0)
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val storedRoom = case.optJSONObject("storedRoom")?.let {
                HandoffRoom(it.getString("name"), it.getBoolean("direct"))
            }
            val expected = case.getJSONObject("expected")
            val actual = PushRenderRules.render(
                case.optJSONObject("event"),
                storedRoom,
                case.opt("stateRoomName") as? String,
                case.opt("senderName") as? String,
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
}

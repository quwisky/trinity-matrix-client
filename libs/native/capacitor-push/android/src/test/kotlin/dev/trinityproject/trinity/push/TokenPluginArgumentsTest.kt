package dev.trinityproject.trinity.push

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class TokenPluginArgumentsTest {
    private fun complete() = JSONObject()
        .put("userId", "@a:hs")
        .put("lineage", "L")
        .put("accessToken", "a0")
        .put("refreshToken", "r0")
        .put("accessTokenExpiresAt", 1_760_000_300_000L)
        .put("tokenEndpoint", "https://op.example/token")
        .put("revocationEndpoint", "https://op.example/revoke")
        .put("clientId", "c")
        .put("deviceId", "D")

    @Test
    fun aMigrationNeedsUserIdLineageTokensEndpointClientAndDevice() {
        val (userId, record) = tokenRecordFromPluginCall(complete())!!
        assertEquals("@a:hs", userId)
        assertEquals(R0, record)

        val required = listOf("userId", "lineage", "accessToken", "refreshToken", "tokenEndpoint", "clientId", "deviceId")
        for (field in required) {
            assertNull("missing $field", tokenRecordFromPluginCall(complete().apply { remove(field) }))
            assertNull("$field not a string", tokenRecordFromPluginCall(complete().put(field, 7)))
        }
        for (field in required - "lineage") {
            assertNull("empty $field", tokenRecordFromPluginCall(complete().put(field, "")))
        }

        for (bad in listOf<Any>("soon", true, 0)) {
            val parsed = tokenRecordFromPluginCall(complete().put("accessTokenExpiresAt", bad))
            assertNull(parsed!!.second.expiresAtMillis)
        }
        assertNull(tokenRecordFromPluginCall(complete().apply { remove("accessTokenExpiresAt") })!!.second.expiresAtMillis)

        assertNull(tokenRecordFromPluginCall(complete().apply { remove("revocationEndpoint") })!!.second.revocationEndpoint)
        assertNull(tokenRecordFromPluginCall(complete().put("revocationEndpoint", ""))!!.second.revocationEndpoint)
        assertNull(tokenRecordFromPluginCall(complete().put("revocationEndpoint", 7))!!.second.revocationEndpoint)
    }

    @Test
    fun lineageMayBeEmpty() {
        val parsed = tokenRecordFromPluginCall(complete().put("lineage", ""))
        assertNotNull(parsed)
        assertEquals("", parsed!!.second.lineage)
    }

    @Test
    fun aRemovalNamesOneAccountOrAsksForAll() {
        assertEquals(TokenRemoval("@a:hs"), tokenRemovalFromPluginCall(JSONObject().put("userId", "@a:hs")))
        assertEquals(TokenRemoval(null), tokenRemovalFromPluginCall(JSONObject().put("all", true)))
    }

    @Test
    fun aMalformedUserIdRemovesNothing() {
        for (bad in listOf<Any>(JSONObject.NULL, "", 7, true, JSONObject())) {
            assertNull(tokenRemovalFromPluginCall(JSONObject().put("userId", bad)))
        }
    }

    @Test
    fun onlyALiteralTrueRemovesEverything() {
        for (bad in listOf<Any>(JSONObject.NULL, false, 1, "true")) {
            assertNull(tokenRemovalFromPluginCall(JSONObject().put("all", bad)))
        }
    }

    @Test
    fun aRemovalWithNeitherOrBothRemovesNothing() {
        assertNull(tokenRemovalFromPluginCall(JSONObject()))
        assertNull(tokenRemovalFromPluginCall(JSONObject().put("userId", "@a:hs").put("all", true)))
        assertNull(tokenRemovalFromPluginCall(JSONObject().put("userId", "@a:hs").put("all", false)))
        assertNull(tokenRemovalFromPluginCall(JSONObject().put("userId", JSONObject.NULL).put("all", true)))
    }

    @Test
    fun aSweepKeepsTheListedAccounts() {
        val data = JSONObject().put("userIds", JSONArray().put("@a:hs").put("@b:hs"))
        assertEquals(setOf("@a:hs", "@b:hs"), keptUserIdsFromPluginCall(data))
    }

    @Test
    fun anEmptyListIsAnExplicitSweepOfEverything() {
        assertEquals(emptySet<String>(), keptUserIdsFromPluginCall(JSONObject().put("userIds", JSONArray())))
    }

    @Test
    fun aMissingOrMalformedListSweepsNothing() {
        assertNull(keptUserIdsFromPluginCall(JSONObject()))
        val malformed = listOf<Any>(
            JSONObject.NULL,
            "@a:hs",
            7,
            true,
            JSONObject(),
            JSONArray().put(7),
            JSONArray().put("@a:hs").put(7),
            JSONArray().put(""),
            JSONArray().put(JSONObject.NULL),
        )
        for (bad in malformed) {
            assertNull(keptUserIdsFromPluginCall(JSONObject().put("userIds", bad)))
        }
    }
}

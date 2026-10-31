package dev.trinityproject.trinity.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenWireTest {
    private val results = listOf(
        TokenRefreshResult.Busy,
        TokenRefreshResult.Gone,
        TokenRefreshResult.Refused,
        TokenRefreshResult.Transient,
        TokenRefreshResult.Unavailable,
        TokenRefreshResult.Current(R0),
        TokenRefreshResult.Rotated(R0, unsaved = true),
        TokenRefreshResult.Rotated(R0, unsaved = false),
    )

    @Test
    fun theWireNeverCarriesARefreshToken() {
        for (result in results) {
            val wire = result.wire()
            for (field in listOf("refreshToken", "tokenEndpoint", "revocationEndpoint", "clientId", "deviceId", "lineage")) {
                assertFalse(field, wire.has(field))
            }
            assertFalse(wire.toString().contains("r0"))
            assertFalse(wire.toString().contains("op.example"))
        }
    }

    @Test
    fun aResultWithoutTokensCarriesOnlyItsKind() {
        val kinds = mapOf(
            TokenRefreshResult.Busy to "busy",
            TokenRefreshResult.Gone to "gone",
            TokenRefreshResult.Refused to "refused",
            TokenRefreshResult.Transient to "transient",
            TokenRefreshResult.Unavailable to "unavailable",
        )
        for ((result, kind) in kinds) {
            assertEquals(1, result.wire().length())
            assertEquals(kind, result.wire().getString("kind"))
        }
    }

    @Test
    fun currentCarriesTheAccessTokenAndItsExpiry() {
        val wire = TokenRefreshResult.Current(R0).wire()

        assertEquals(3, wire.length())
        assertEquals("current", wire.getString("kind"))
        assertEquals("a0", wire.getString("accessToken"))
        assertEquals(1_760_000_300_000L, wire.getLong("accessTokenExpiresAt"))
    }

    @Test
    fun aMissingExpiryIsLeftOffTheWire() {
        assertFalse(TokenRefreshResult.Current(R0.copy(expiresAtMillis = null)).wire().has("accessTokenExpiresAt"))
    }

    @Test
    fun anExpiryJavaScriptCannotHoldIsLeftOffTheWire() {
        for (expiry in listOf(Long.MAX_VALUE, 9_007_199_254_740_992L, 0L, -1L, Long.MIN_VALUE)) {
            assertFalse(TokenRefreshResult.Current(R0.copy(expiresAtMillis = expiry)).wire().has("accessTokenExpiresAt"))
            assertFalse(TokenRefreshResult.Rotated(R0.copy(expiresAtMillis = expiry), unsaved = false).wire().has("accessTokenExpiresAt"))
        }

        val largestSafe = TokenRefreshResult.Current(R0.copy(expiresAtMillis = 9_007_199_254_740_991L)).wire()
        assertEquals(9_007_199_254_740_991L, largestSafe.getLong("accessTokenExpiresAt"))
    }

    @Test
    fun rotatedCarriesUnsavedOnlyWhenUnsaved() {
        val unsaved = TokenRefreshResult.Rotated(R0, unsaved = true).wire()
        assertEquals("rotated", unsaved.getString("kind"))
        assertEquals("a0", unsaved.getString("accessToken"))
        assertEquals(1_760_000_300_000L, unsaved.getLong("accessTokenExpiresAt"))
        assertTrue(unsaved.getBoolean("unsaved"))

        assertFalse(TokenRefreshResult.Rotated(R0, unsaved = false).wire().has("unsaved"))
    }

    @Test
    fun theRevocationWire() {
        assertEquals("revoked", TokenRevokeResult.REVOKED.wire().getString("kind"))
        assertEquals("gone", TokenRevokeResult.GONE.wire().getString("kind"))
        assertEquals("transient", TokenRevokeResult.TRANSIENT.wire().getString("kind"))
        assertEquals(1, TokenRevokeResult.REVOKED.wire().length())
    }

    @Test
    fun noDescriptionShowsATokenOrAnEndpoint() {
        val descriptions = listOf(
            R0.toString(),
            TokenVaultRead.Record(R0).toString(),
            TokenRefreshResult.Current(R0).toString(),
            TokenRefreshResult.Rotated(R0, unsaved = true).toString(),
            TokenGrantAnswer.Tokens("a0", "r0", 300L).toString(),
        )
        for (description in descriptions) {
            for (secret in listOf("a0", "r0", "op.example")) {
                assertFalse(description, description.contains(secret))
            }
        }
    }

    @Test
    fun aRotationReplacesThePairAndIsActive() {
        val rotated = R0.marked(TokenState.REFUSED).rotated("a1", "r1", 5L)

        assertEquals(R0.copy(accessToken = "a1", refreshToken = "r1", expiresAtMillis = 5L), rotated)
        assertEquals("r0", R0.rotated("a1", null, null).refreshToken)
    }

    @Test
    fun samePairComparesOnlyTheTokens() {
        assertTrue(R0.samePair(R0.copy(lineage = "L2", state = TokenState.REFUSED)))
        assertFalse(R0.samePair(R0.copy(accessToken = "a1")))
        assertFalse(R0.samePair(R0.copy(refreshToken = "r1")))
    }
}

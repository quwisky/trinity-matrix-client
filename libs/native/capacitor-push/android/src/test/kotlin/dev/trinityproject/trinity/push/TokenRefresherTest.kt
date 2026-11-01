package dev.trinityproject.trinity.push

import java.util.concurrent.Callable
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs [call] on a daemon thread, so one that never ends cannot keep the test JVM alive. */
internal fun onThread(call: () -> TokenRefreshResult): FutureTask<TokenRefreshResult> =
    FutureTask(Callable { call() }).also { task -> Thread(task).apply { isDaemon = true }.start() }

private class FakeVault(var stored: TokenRecord? = R0) : TokenVault {
    var unavailable = false
    var failedUpdates = 0
    var writes = 0
    var writesFail = false
    var listed: List<String>? = emptyList()
    val removalsFailing = mutableSetOf<String>()
    val removed = mutableListOf<String>()

    override fun accounts(): List<String>? = listed

    override fun read(userId: String): TokenVaultRead {
        if (unavailable) return TokenVaultRead.Unavailable
        return stored?.let { TokenVaultRead.Record(it) } ?: TokenVaultRead.Absent
    }

    override fun write(userId: String, record: TokenRecord): Boolean {
        if (writesFail) return false
        stored = record
        writes += 1
        return true
    }

    override fun update(userId: String, record: TokenRecord): TokenVaultWrite {
        if (failedUpdates > 0) {
            failedUpdates -= 1
            return TokenVaultWrite.FAILED
        }
        if (stored == null) return TokenVaultWrite.ABSENT
        stored = record
        return TokenVaultWrite.WRITTEN
    }

    override fun remove(userId: String): Boolean {
        if (userId in removalsFailing) return false
        removed.add(userId)
        stored = null
        return true
    }

    override fun removeAll(): Boolean {
        stored = null
        return true
    }
}

private class FakeLease : TokenLease {
    var busy = false
    var lapsed = false
    var onTake: () -> Unit = {}
    val waits = mutableListOf<Long>()
    val lifetimes = mutableListOf<Long>()
    val released = mutableListOf<String>()

    override fun take(account: String, lifetimeMillis: Long, waitMillis: Long): LeaseTicket? {
        waits.add(waitMillis)
        lifetimes.add(lifetimeMillis)
        onTake()
        return if (busy) null else LeaseTicket(account, "ticket${waits.size}")
    }

    override fun holds(ticket: LeaseTicket): Boolean = !lapsed

    override fun release(ticket: LeaseTicket) {
        released.add(ticket.owner)
    }
}

private class FakeClient : TokenGrantClient {
    var answer: TokenGrantAnswer = TokenGrantAnswer.Tokens("a1", "r1", 300L)
    var revokeAnswer = true
    var onGrant: () -> Unit = {}
    var onRevoke: () -> Unit = {}
    val grants = CopyOnWriteArrayList<TokenRecord>()
    val revokes = CopyOnWriteArrayList<TokenRecord>()
    val revoked = CountDownLatch(1)

    override fun grant(record: TokenRecord, deadline: Deadline): TokenGrantAnswer {
        grants.add(record)
        onGrant()
        return answer
    }

    override fun revoke(record: TokenRecord, deadline: Deadline): Boolean {
        revokes.add(record)
        revoked.countDown()
        onRevoke()
        return revokeAnswer
    }
}

class TokenRefresherTest {
    private val user = "@a:hs"
    private val now = 1_000_000L
    private val vault = FakeVault()
    private val lease = FakeLease()
    private val client = FakeClient()
    private val refresher = TokenRefresher(vault, lease, client, WallClock { now })
    private val a1r1 = R0.rotated("a1", "r1", now + 300_000L)
    private val r1Stored = R0.copy(accessToken = "b1", refreshToken = "s1")
    private val r2Stored = R0.copy(accessToken = "b2", refreshToken = "s2")

    private fun deadline() = Deadline(8_000L, { 0L })

    private fun refresh(tokenSeen: String = "a0") = refresher.refresh(user, "L", tokenSeen, deadline())

    private fun leaveAnUnsavedPair() {
        vault.failedUpdates = 1
        assertEquals(TokenRefreshResult.Rotated(a1r1, true), refresh())
    }

    @Test
    fun busyPastTheBudgetSendsNothing() {
        lease.busy = true

        assertEquals(TokenRefreshResult.Busy, refresh())

        assertEquals(listOf(8_000L), lease.waits)
        assertTrue(client.grants.isEmpty())
    }

    @Test
    fun theLeaseLastsTwiceTheBudgetAndTheMarginAndIsReleased() {
        refresh()

        assertEquals(listOf(2 * 8_000L + TokenBudgets.LEASE_MARGIN_MILLIS), lease.lifetimes)
        assertEquals(listOf("ticket1"), lease.released)
    }

    @Test
    fun aMissingRecordOrAnotherLineageIsGone() {
        vault.stored = null
        assertEquals(TokenRefreshResult.Gone, refresh())

        vault.stored = R0.copy(lineage = "other")
        assertEquals(TokenRefreshResult.Gone, refresh())

        assertTrue(client.grants.isEmpty())
    }

    @Test
    fun aKeychainFaultIsTransientNeverGone() {
        vault.unavailable = true

        assertEquals(TokenRefreshResult.Transient, refresh())
        assertTrue(client.grants.isEmpty())
    }

    @Test
    fun aRefusedRecordIsRefusedWithoutAGrant() {
        vault.stored = R0.marked(TokenState.REFUSED)

        assertEquals(TokenRefreshResult.Refused, refresh())
        assertTrue(client.grants.isEmpty())
    }

    @Test
    fun anAlreadyRotatedTokenIsCurrentWithoutAGrant() {
        assertEquals(TokenRefreshResult.Current(R0), refresh("old"))
        assertTrue(client.grants.isEmpty())
    }

    @Test
    fun noRefreshTokenOrEndpointIsUnavailable() {
        for (incomplete in listOf(R0.copy(refreshToken = null), R0.copy(tokenEndpoint = null), R0.copy(clientId = null))) {
            vault.stored = incomplete

            assertEquals(TokenRefreshResult.Unavailable, refresh())
        }
        assertTrue(client.grants.isEmpty())
    }

    @Test
    fun theGrantUsesWhatWasReadUnderTheLease() {
        lease.onTake = { vault.stored = R0.copy(refreshToken = "r1") }

        refresh()

        assertEquals("r1", client.grants.single().refreshToken)
    }

    @Test
    fun successWritesThePair() {
        assertEquals(TokenRefreshResult.Rotated(a1r1, false), refresh())
        assertEquals(a1r1, vault.stored)
    }

    @Test
    fun aNoRotationAnswerKeepsTheOldRefreshToken() {
        client.answer = TokenGrantAnswer.Tokens("a1", null, null)

        refresh()

        assertEquals("r0", vault.stored?.refreshToken)
        assertNull(vault.stored?.expiresAtMillis)
    }

    @Test
    fun aFailedGrantIsTransientAndKeepsTheSpentToken() {
        client.answer = TokenGrantAnswer.Failed

        assertEquals(TokenRefreshResult.Transient, refresh())
        assertEquals(R0, vault.stored)
    }

    @Test
    fun aRefusalMarksRefused() {
        client.answer = TokenGrantAnswer.Refused

        assertEquals(TokenRefreshResult.Refused, refresh())
        assertEquals(TokenState.REFUSED, vault.stored?.state)
    }

    @Test
    fun aPushRefusalIsNotRecorded() {
        client.answer = TokenGrantAnswer.Refused

        assertEquals(TokenRefreshResult.Refused, refresher.refreshForPush(user, "a0", deadline()))
        assertEquals(R0, vault.stored)

        client.answer = TokenGrantAnswer.Tokens("a1", "r1", 300L)

        assertEquals(TokenRefreshResult.Rotated(a1r1, false), refresh())
        assertEquals(a1r1, vault.stored)
    }

    @Test
    fun aPushRefusalKeepsAnUnsavedPair() {
        leaveAnUnsavedPair()
        vault.failedUpdates = 2
        client.answer = TokenGrantAnswer.Refused

        assertEquals(TokenRefreshResult.Refused, refresher.refreshForPush(user, "a1", deadline()))

        assertEquals(TokenRefreshResult.Current(a1r1), refresher.current(user, "L"))
    }

    @Test
    fun aRefusalClearsTheUnsavedPair() {
        leaveAnUnsavedPair()
        vault.failedUpdates = 1 // fails the flush; the refusal's own mark then lands
        client.answer = TokenGrantAnswer.Refused

        assertEquals(TokenRefreshResult.Refused, refresh("a1"))

        assertEquals(TokenRefreshResult.Refused, refresh("a1"))
        assertEquals(TokenState.REFUSED, vault.stored?.state)
        assertEquals(2, client.grants.size)
    }

    @Test
    fun aRefusalAfterAnotherProcessRotatedIsCurrent() {
        client.answer = TokenGrantAnswer.Refused
        client.onGrant = { vault.stored = r1Stored }

        assertEquals(TokenRefreshResult.Current(r1Stored), refresh())
        assertEquals(TokenState.ACTIVE, vault.stored?.state)
    }

    @Test
    fun aRefusalOfARemovedRecordIsGone() {
        client.answer = TokenGrantAnswer.Refused
        client.onGrant = { vault.stored = null }

        assertEquals(TokenRefreshResult.Gone, refresh())
        assertNull(vault.stored)
    }

    @Test
    fun aRefusalOfAnOlderSignInIsGoneAndMarksNothing() {
        val newer = R0.copy(lineage = "L2")
        client.answer = TokenGrantAnswer.Refused
        client.onGrant = { vault.stored = newer }

        assertEquals(TokenRefreshResult.Gone, refresh())

        assertEquals(newer, vault.stored)
    }

    @Test
    fun aRefusalThatCannotReadTheStoreIsTransient() {
        client.answer = TokenGrantAnswer.Refused
        client.onGrant = { vault.unavailable = true }

        assertEquals(TokenRefreshResult.Transient, refresh())
    }

    @Test
    fun aLateAnswerIsDiscardedWhenAnotherProcessRotated() {
        client.onGrant = { vault.stored = r2Stored }

        assertEquals(TokenRefreshResult.Current(r2Stored), refresh())
        assertEquals(r2Stored, vault.stored)
    }

    @Test
    fun aLateAnswerDoesNotResurrectARemovedRecord() {
        client.onGrant = { vault.stored = null }

        assertEquals(TokenRefreshResult.Gone, refresh())
        assertNull(vault.stored)
    }

    @Test
    fun aLateAnswerNeverOverwritesANewerSignIn() {
        val newer = R0.copy(lineage = "L2")
        client.onGrant = { vault.stored = newer }

        assertEquals(TokenRefreshResult.Gone, refresh())
        assertEquals(newer, vault.stored)
    }

    @Test
    fun anUnreadableStoreAfterAGrantKeepsThePairUnsaved() {
        client.onGrant = { vault.unavailable = true }

        assertEquals(TokenRefreshResult.Rotated(a1r1, true), refresh())
    }

    @Test
    fun aWriteFailureIsUnsavedAndTheStoredPairStays() {
        vault.failedUpdates = 1

        assertEquals(TokenRefreshResult.Rotated(a1r1, true), refresh())
        assertEquals(R0, vault.stored)
    }

    @Test
    fun theNextCallRetriesAnUnsavedWrite() {
        leaveAnUnsavedPair()

        refresher.current(user, "L")

        assertEquals(a1r1, vault.stored)
    }

    @Test
    fun currentAnswersWithAnUnsavedPair() {
        leaveAnUnsavedPair()
        vault.failedUpdates = 1

        assertEquals(TokenRefreshResult.Current(a1r1), refresher.current(user, "L"))
        assertEquals(R0, vault.stored)
    }

    @Test
    fun currentAnswersWithAnUnsavedPairWhenTheLeaseIsBusy() {
        leaveAnUnsavedPair()
        lease.busy = true

        assertEquals(TokenRefreshResult.Current(a1r1), refresher.current(user, "L"))
        assertEquals(TokenBudgets.REMOVAL_WAIT_MILLIS, lease.waits.last())
        assertEquals(R0, vault.stored)
    }

    @Test
    fun currentIgnoresAnUnsavedPairOfAnotherLineage() {
        leaveAnUnsavedPair()
        vault.failedUpdates = 1

        assertEquals(TokenRefreshResult.Gone, refresher.current(user, "other"))
    }

    @Test
    fun currentReleasesALeaseItTookToFlush() {
        leaveAnUnsavedPair()

        refresher.current(user, "L")

        assertEquals(listOf("ticket1", "ticket2"), lease.released)
        assertEquals(TokenBudgets.LEASE_MARGIN_MILLIS, lease.lifetimes.last())
    }

    @Test
    fun currentWithNothingUnsavedTakesNoLease() {
        refresher.current(user, "L")

        assertTrue(lease.waits.isEmpty())
    }

    @Test
    fun currentReadsTheStore() {
        assertEquals(TokenRefreshResult.Current(R0), refresher.current(user, "L"))
        assertEquals(TokenRefreshResult.Gone, refresher.current(user, "other"))

        vault.stored = R0.marked(TokenState.REFUSED)
        assertEquals(TokenRefreshResult.Refused, refresher.current(user, "L"))

        vault.unavailable = true
        assertEquals(TokenRefreshResult.Transient, refresher.current(user, "L"))

        vault.unavailable = false
        vault.stored = null
        assertEquals(TokenRefreshResult.Gone, refresher.current(user, "L"))
    }

    @Test
    fun anUnsavedPairStillRefreshesWhenWritesKeepFailing() {
        leaveAnUnsavedPair()
        vault.failedUpdates = 2
        client.answer = TokenGrantAnswer.Tokens("a2", "r2", null)

        val result = refresh("a1")

        assertEquals("r1", client.grants.last().refreshToken)
        assertEquals(TokenRefreshResult.Rotated(a1r1.rotated("a2", "r2", null), true), result)
    }

    @Test
    fun anUnsavedPairIsDroppedWhenAnotherProcessRotated() {
        leaveAnUnsavedPair()
        vault.stored = r1Stored

        assertEquals(TokenRefreshResult.Current(r1Stored), refresh("a1"))

        assertEquals(TokenRefreshResult.Current(r1Stored), refresher.current(user, "L"))
        assertEquals(r1Stored, vault.stored)
    }

    @Test
    fun anUnsavedPairIsDroppedWhenTheRecordWasRemoved() {
        leaveAnUnsavedPair()
        vault.stored = null

        assertEquals(TokenRefreshResult.Gone, refresher.current(user, "L"))

        assertNull(vault.stored)
    }

    /** The pair is the same: only the lineage tells the two sign-ins apart. */
    @Test
    fun anUnsavedPairIsNeverWrittenOverANewerSignIn() {
        leaveAnUnsavedPair()
        val newer = R0.copy(lineage = "L2")
        vault.stored = newer

        assertEquals(TokenRefreshResult.Gone, refresh("a1"))

        assertEquals(newer, vault.stored)
    }

    @Test
    fun anUnsavedPairSurvivesAnUnreadableStore() {
        leaveAnUnsavedPair()
        vault.unavailable = true

        assertEquals(TokenRefreshResult.Current(a1r1), refresher.current(user, "L"))
    }

    @Test
    fun aSavedRotationClearsTheUnsavedPair() {
        leaveAnUnsavedPair()
        vault.failedUpdates = 1 // fails the flush; the rotation's own write then lands
        client.answer = TokenGrantAnswer.Tokens("a2", "r2", null)
        val saved = a1r1.rotated("a2", "r2", null)

        assertEquals(TokenRefreshResult.Rotated(saved, false), refresh("a1"))

        assertEquals(TokenRefreshResult.Current(saved), refresher.current(user, "L"))
    }

    @Test
    fun aLapsedLeaseIsRetakenBeforeTheCompare() {
        // The store changes only during the retake, so a compare before it would see the old pair.
        client.onGrant = {
            lease.lapsed = true
            lease.onTake = { vault.stored = r2Stored }
        }

        assertEquals(TokenRefreshResult.Current(r2Stored), refresh())

        assertEquals(r2Stored, vault.stored)
        assertEquals(2, lease.waits.size)
        assertEquals(listOf("ticket2"), lease.released)
    }

    @Test
    fun aPushRefusalAfterALapsedLeaseIsRetakenBeforeTheCompare() {
        client.answer = TokenGrantAnswer.Refused
        client.onGrant = {
            lease.lapsed = true
            lease.onTake = { vault.stored = r2Stored }
        }

        assertEquals(TokenRefreshResult.Current(r2Stored), refresher.refreshForPush(user, "a0", deadline()))

        assertEquals(r2Stored, vault.stored)
    }

    @Test
    fun anAppRefusalAfterALapsedLeaseIsTransient() {
        client.answer = TokenGrantAnswer.Refused
        client.onGrant = { lease.lapsed = true }

        assertEquals(TokenRefreshResult.Transient, refresh())

        assertEquals(R0, vault.stored)
        assertEquals("a lapse answers before any retake", 1, lease.waits.size)
    }

    @Test
    fun anAppRefusalAfterALapseKeepsAnUnsavedPair() {
        vault.failedUpdates = 2 // The write, then the flush before the next refresh.
        assertEquals(TokenRefreshResult.Rotated(a1r1, true), refresh())
        client.answer = TokenGrantAnswer.Refused
        client.onGrant = { lease.lapsed = true }

        assertEquals(TokenRefreshResult.Transient, refresh("a1"))

        assertEquals(R0, vault.stored)
        assertEquals(TokenRefreshResult.Current(a1r1), refresher.current(user, "L"))
    }

    @Test
    fun aGrantNeedsThreeSecondsOfBudget() {
        fun budget(millis: Long) = Deadline(millis, { 0L })

        assertEquals(TokenRefreshResult.Transient, refresher.refresh(user, "L", "a0", budget(2_999L)))
        assertEquals(TokenRefreshResult.Transient, refresher.refreshForPush(user, "a0", budget(2_999L)))
        assertTrue(client.grants.isEmpty())
        assertEquals(R0, vault.stored)

        assertEquals(TokenRefreshResult.Rotated(a1r1, false), refresher.refreshForPush(user, "a0", budget(3_000L)))
        assertEquals(1, client.grants.size)
    }

    @Test
    fun aRetakeWaitsAtLeastTheFloorOnceTheDeadlineIsSpent() {
        var now = 0L
        client.onGrant = {
            lease.lapsed = true
            now = 100_000L
        }

        refresher.refresh(user, "L", "a0", Deadline(8_000L, { now }))

        assertEquals(listOf(8_000L, 1_000L), lease.waits)
    }

    @Test
    fun tokensWithABusyRetakeStillCompareAndWrite() {
        fun refreshWithABusyRetake(alsoDuringTheGrant: () -> Unit = {}): TokenRefreshResult {
            vault.stored = R0
            lease.busy = false
            lease.lapsed = false
            client.onGrant = {
                lease.lapsed = true
                lease.busy = true
                alsoDuringTheGrant()
            }
            return refresh()
        }

        assertEquals(TokenRefreshResult.Rotated(a1r1, false), refreshWithABusyRetake())
        assertEquals(a1r1, vault.stored)

        assertEquals(TokenRefreshResult.Current(r2Stored), refreshWithABusyRetake { vault.stored = r2Stored })
        assertEquals(r2Stored, vault.stored)

        assertEquals(TokenRefreshResult.Gone, refreshWithABusyRetake { vault.stored = null })
        assertNull(vault.stored)

        assertEquals(TokenRefreshResult.Rotated(a1r1, true), refreshWithABusyRetake { vault.failedUpdates = 1 })
        assertEquals(R0, vault.stored)
    }

    @Test
    fun aPushRefusalWhoseLeaseCannotBeRetakenIsTransient() {
        client.answer = TokenGrantAnswer.Refused
        client.onGrant = {
            lease.lapsed = true
            lease.busy = true
        }

        assertEquals(TokenRefreshResult.Transient, refresher.refreshForPush(user, "a0", deadline()))
        assertEquals(R0, vault.stored)
    }

    @Test(timeout = 30_000L)
    fun twoConcurrentCallersShareOneGrant() {
        val table = LeaseTable()
        val bothCalledTake = CountDownLatch(2)
        val counting = object : TokenLease by table {
            override fun take(account: String, lifetimeMillis: Long, waitMillis: Long): LeaseTicket? {
                bothCalledTake.countDown()
                return table.take(account, lifetimeMillis, waitMillis)
            }
        }
        client.onGrant = { bothCalledTake.await(10, TimeUnit.SECONDS) }
        val shared = TokenRefresher(vault, counting, client, WallClock { now })

        val results = List(2) { onThread { shared.refresh(user, "L", "a0", deadline()) } }.map { it.get(20, TimeUnit.SECONDS) }

        assertEquals(1, client.grants.size)
        assertEquals(1, results.filterIsInstance<TokenRefreshResult.Rotated>().size)
        assertEquals(1, results.filterIsInstance<TokenRefreshResult.Current>().size)
    }

    @Test
    fun refreshForPushUsesTheStoredLineage() {
        vault.stored = R0.copy(lineage = "stored")

        assertEquals(
            TokenRefreshResult.Rotated(a1r1.copy(lineage = "stored"), false),
            refresher.refreshForPush(user, "a0", deadline()),
        )
    }

    @Test
    fun refreshForPushWithNoRecordIsGone() {
        vault.stored = null

        assertEquals(TokenRefreshResult.Gone, refresher.refreshForPush(user, "a0", deadline()))
        assertTrue(client.grants.isEmpty())
    }

    @Test
    fun refreshForPushOnAStoreFaultIsTransient() {
        vault.unavailable = true

        assertEquals(TokenRefreshResult.Transient, refresher.refreshForPush(user, "a0", deadline()))
    }

    @Test
    fun migrationWritesARecord() {
        vault.stored = null

        assertTrue(refresher.migrate(R0, user))

        assertEquals(R0, vault.stored)
        assertEquals(listOf(TokenBudgets.APP_GRANT_MILLIS), lease.waits)
        assertEquals(listOf("ticket1"), lease.released)
    }

    @Test
    fun migrationKeepsAStoredRefreshTokenOfTheSameLineage() {
        vault.stored = a1r1

        assertTrue(refresher.migrate(R0, user))

        assertEquals(a1r1, vault.stored)
        assertEquals(0, vault.writes)
    }

    @Test
    fun migrationReplacesAnotherLineage() {
        val newer = R0.copy(lineage = "L2")

        assertTrue(refresher.migrate(newer, user))

        assertEquals(newer, vault.stored)
    }

    @Test
    fun migrationOverAnotherDeviceRevokesTheOldPairBestEffort() {
        val old = R0.copy(deviceId = "OLD", lineage = "L1")
        val newer = R0.copy(accessToken = "a9", refreshToken = "r9", lineage = "L2")
        vault.stored = old
        client.revokeAnswer = false

        assertTrue(refresher.migrate(newer, user))

        assertTrue(client.revoked.await(5, TimeUnit.SECONDS))
        assertEquals(listOf(old), client.revokes.toList())
        assertEquals(newer, vault.stored)
    }

    @Test
    fun aRevocationThatThrowsDoesNotEscapeItsThread() {
        val escaped = CountDownLatch(1)
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { _, _ -> escaped.countDown() }
        try {
            vault.stored = R0.copy(accessToken = "a8", refreshToken = "r8", deviceId = "OLD", lineage = "L1")
            client.onRevoke = { throw IllegalStateException("disconnect") }

            assertTrue(refresher.migrate(R0.copy(lineage = "L2"), user))

            assertTrue(client.revoked.await(5, TimeUnit.SECONDS))
            assertFalse(escaped.await(300, TimeUnit.MILLISECONDS))
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(previous)
        }
    }

    @Test
    fun migrationReplacesARecordOfTheSameLineageWithNoRefreshToken() {
        vault.stored = R0.copy(refreshToken = null)

        assertTrue(refresher.migrate(R0, user))

        assertEquals(R0, vault.stored)
    }

    @Test
    fun aMigrationWhoseWriteFailsIsNotStoredAndRevokesNothing() {
        vault.stored = R0.copy(accessToken = "a8", refreshToken = "r8", deviceId = "OLD", lineage = "L1")
        vault.writesFail = true

        assertFalse(refresher.migrate(R0.copy(lineage = "L2"), user))

        assertFalse(client.revoked.await(200, TimeUnit.MILLISECONDS))
        assertEquals(listOf("ticket1"), lease.released)
    }

    @Test
    fun migrationOverAnotherDeviceWithNoRefreshTokenRevokesNothing() {
        vault.stored = R0.copy(refreshToken = null, deviceId = "OLD", lineage = "L1")

        assertTrue(refresher.migrate(R0.copy(lineage = "L2"), user))

        assertFalse(client.revoked.await(200, TimeUnit.MILLISECONDS))
    }

    @Test
    fun migrationOverAnotherDeviceWithTheSamePairRevokesNothing() {
        val incoming = R0.copy(lineage = "L2")
        vault.stored = R0.copy(deviceId = "OLD", lineage = "L1")

        assertTrue(refresher.migrate(incoming, user))

        assertFalse(client.revoked.await(200, TimeUnit.MILLISECONDS))
        assertTrue(client.revokes.isEmpty())
        assertEquals(incoming, vault.stored)
    }

    @Test
    fun migrationOverTheSameDeviceRevokesNothing() {
        assertTrue(refresher.migrate(R0.copy(lineage = "L2"), user))

        assertFalse(client.revoked.await(200, TimeUnit.MILLISECONDS))
        assertTrue(client.revokes.isEmpty())
    }

    @Test
    fun migrationWhileTheKeychainIsUnavailableIsNotStored() {
        vault.unavailable = true

        assertFalse(refresher.migrate(R0.copy(lineage = "L2"), user))
        assertEquals(0, vault.writes)
    }

    @Test
    fun migrationOnABusyLeaseIsNotStored() {
        lease.busy = true

        assertFalse(refresher.migrate(R0.copy(lineage = "L2"), user))

        assertEquals(listOf(TokenBudgets.APP_GRANT_MILLIS), lease.waits)
        assertEquals(0, vault.writes)
    }

    @Test(timeout = 30_000L)
    fun aLapsedHolderDoesNotOverwriteAMigration() {
        var leaseNow = 1_000L
        val table = LeaseTable({ leaseNow })
        val holder = TokenRefresher(vault, table, client, WallClock { now })
        val newer = R0.copy(accessToken = "a9", refreshToken = "r9", lineage = "L2")
        client.onGrant = {
            leaseNow += 2 * 8_000L + TokenBudgets.LEASE_MARGIN_MILLIS + 1
            assertTrue(holder.migrate(newer, user))
        }

        assertEquals(TokenRefreshResult.Gone, holder.refresh(user, "L", "a0", deadline()))
        assertEquals("L2", vault.stored?.lineage)
        assertEquals(newer, vault.stored)
    }

    @Test
    fun revokeUsesThePinnedEndpointAndKeepsTheRecord() {
        assertEquals(TokenRevokeResult.REVOKED, refresher.revoke(user, "L"))

        assertEquals(listOf(R0), client.revokes.toList())
        assertEquals(R0, vault.stored)
        assertEquals(listOf(TokenBudgets.REVOKE_WAIT_MILLIS), lease.waits)
        assertEquals(listOf("ticket1"), lease.released)
    }

    @Test
    fun revokeWithNoRecordOrEndpointOrOtherLineageIsGone() {
        assertEquals(TokenRevokeResult.GONE, refresher.revoke(user, "other"))

        vault.stored = R0.copy(revocationEndpoint = null)
        assertEquals(TokenRevokeResult.GONE, refresher.revoke(user, "L"))

        vault.stored = null
        assertEquals(TokenRevokeResult.GONE, refresher.revoke(user, "L"))

        assertTrue(client.revokes.isEmpty())
    }

    @Test
    fun revokeFailureIsTransient() {
        client.revokeAnswer = false
        assertEquals(TokenRevokeResult.TRANSIENT, refresher.revoke(user, "L"))

        vault.unavailable = true
        assertEquals(TokenRevokeResult.TRANSIENT, refresher.revoke(user, "L"))

        lease.busy = true
        assertEquals(TokenRevokeResult.TRANSIENT, refresher.revoke(user, "L"))

        assertEquals(R0, vault.stored)
    }

    @Test
    fun revokeUsesAnUnsavedPair() {
        leaveAnUnsavedPair()
        vault.failedUpdates = 1

        assertEquals(TokenRevokeResult.REVOKED, refresher.revoke(user, "L"))

        assertEquals(listOf(a1r1), client.revokes.toList())
    }

    @Test
    fun revokeFlushesAStaleUnsavedPairFirst() {
        leaveAnUnsavedPair()
        vault.stored = r1Stored

        assertEquals(TokenRevokeResult.REVOKED, refresher.revoke(user, "L"))

        assertEquals(listOf(r1Stored), client.revokes.toList())
    }

    @Test
    fun removeDeletesEvenWhenTheLeaseStaysBusy() {
        lease.busy = true

        assertTrue(refresher.remove(user))

        assertNull(vault.stored)
        assertEquals(listOf(TokenBudgets.REMOVAL_WAIT_MILLIS), lease.waits)
    }

    @Test
    fun removeReleasesALeaseItTook() {
        refresher.remove(user)

        assertEquals(listOf("ticket1"), lease.released)
    }

    @Test
    fun removeDropsAnUnsavedPair() {
        leaveAnUnsavedPair()
        lease.busy = true

        refresher.remove(user)

        assertEquals(TokenRefreshResult.Gone, refresher.current(user, "L"))
    }

    @Test
    fun removeWithNoAccountDropsEverything() {
        leaveAnUnsavedPair()
        lease.busy = true

        assertTrue(refresher.remove(null))

        assertNull(vault.stored)
        assertEquals(TokenRefreshResult.Gone, refresher.current(user, "L"))
    }

    @Test
    fun aSweepRemovesOnlyTheUnlistedAccountsEachUnderItsLease() {
        vault.listed = listOf("@a:hs", "@b:hs", "@c:hs")

        assertEquals(2, refresher.removeExcept(setOf("@b:hs")))

        assertEquals(listOf("@a:hs", "@c:hs"), vault.removed)
        assertEquals(listOf(TokenBudgets.REMOVAL_WAIT_MILLIS, TokenBudgets.REMOVAL_WAIT_MILLIS), lease.waits)
        assertEquals(listOf("ticket1", "ticket2"), lease.released)
    }

    @Test
    fun aSweepKeepingNothingRemovesEverything() {
        vault.listed = listOf("@a:hs", "@b:hs")

        assertEquals(2, refresher.removeExcept(emptySet()))

        assertEquals(listOf("@a:hs", "@b:hs"), vault.removed)
    }

    @Test
    fun aSweepWithNothingToRemoveAnswersZero() {
        vault.listed = listOf("@a:hs")

        assertEquals(0, refresher.removeExcept(setOf("@a:hs", "@b:hs")))

        assertTrue(vault.removed.isEmpty())
        assertTrue(lease.waits.isEmpty())
    }

    @Test
    fun aSweepThatCannotListRemovesNothing() {
        vault.listed = null

        assertNull(refresher.removeExcept(emptySet()))

        assertTrue(vault.removed.isEmpty())
        assertTrue(lease.waits.isEmpty())
    }

    @Test
    fun aSweepTriesEveryAccountAndAnswersNullWhenARemovalFails() {
        vault.listed = listOf("@a:hs", "@b:hs")
        vault.removalsFailing.add("@a:hs")

        assertNull(refresher.removeExcept(emptySet()))

        assertEquals(listOf("@b:hs"), vault.removed)
    }

    @Test
    fun aSweepDropsARemovedAccountsUnsavedPair() {
        leaveAnUnsavedPair()
        vault.listed = listOf(user)

        refresher.removeExcept(emptySet())

        assertEquals(TokenRefreshResult.Gone, refresher.current(user, "L"))
    }

    @Test
    fun twoCallersOfTheSharedRefresherShareAnUnsavedPair() {
        val shared = SharedRefresher()
        val plugin = shared.get { TokenRefresher(vault, lease, client, WallClock { now }) }
        val service = shared.get { error("built twice") }
        assertSame(plugin, service)
        vault.failedUpdates = 100

        assertEquals(TokenRefreshResult.Rotated(a1r1, true), plugin.refresh(user, "L", "a0", deadline()))

        // The service saw the old token: it gets the unsaved pair, and r0 is not sent again.
        assertEquals(TokenRefreshResult.Current(a1r1), service.refreshForPush(user, "a0", deadline()))
        client.answer = TokenGrantAnswer.Tokens("a2", "r2", null)
        service.refreshForPush(user, "a1", deadline())

        assertEquals(listOf("r0", "r1"), client.grants.map { it.refreshToken })
    }

    @Test
    fun theAppDeadlineIsTheAppGrantBudget() {
        val remaining = TokenRefresher.appDeadline().remainingMillis()

        assertTrue(remaining in 1..TokenBudgets.APP_GRANT_MILLIS)
    }
}

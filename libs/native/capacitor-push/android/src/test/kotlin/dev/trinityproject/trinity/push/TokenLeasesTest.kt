package dev.trinityproject.trinity.push

import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenLeasesTest {
    private var now = 1_000L
    private val table = LeaseTable({ now })

    private fun held(lease: TokenLease = table, account: String = "@a:hs", lifetimeMillis: Long = 100): LeaseTicket =
        lease.take(account, lifetimeMillis, 0)!!

    @Test
    fun aSecondTakerWaitsThenGivesUp() {
        val ticking = LeaseTable({
            now += 20
            now
        })
        val first = held(ticking, lifetimeMillis = 60_000)
        val started = now

        assertNull(ticking.take("@a:hs", 60_000, 100))

        assertTrue("gave up before the wait was spent", now - started >= 100)
        assertTrue(ticking.holds(first))
    }

    @Test
    fun aWaitingTakerDoesNotBlockTheHolderFromReleasing() {
        val realClock = LeaseTable()
        val first = held(realClock, lifetimeMillis = 60_000)
        val second = AtomicReference<LeaseTicket?>()

        val waiter = Thread { second.set(realClock.take("@a:hs", 60_000, 5_000)) }
        waiter.start()
        Thread.sleep(100)
        realClock.release(first)
        waiter.join(5_000)

        assertNotNull(second.get())
    }

    @Test
    fun anInterruptedWaitGivesUpAndKeepsTheFlag() {
        held(lifetimeMillis = 60_000)

        Thread.currentThread().interrupt()
        val ticket = table.take("@a:hs", 60_000, 5_000)

        assertTrue(Thread.interrupted())
        assertNull(ticket)
    }

    @Test
    fun aReleasedLeaseIsFree() {
        val first = held()

        table.release(first)

        assertFalse(table.holds(first))
        assertNotNull(table.take("@a:hs", 100, 0))
    }

    @Test
    fun anExpiredLeaseIsTakenOver() {
        held()
        assertNull(table.take("@a:hs", 100, 0))

        now += 100

        assertNotNull(table.take("@a:hs", 100, 0))
    }

    @Test
    fun holdsIsFalseOnceTakenOver() {
        val first = held()
        assertTrue(table.holds(first))

        now += 100
        assertFalse(table.holds(first))

        val second = held()
        assertFalse(table.holds(first))
        assertTrue(table.holds(second))
    }

    @Test
    fun releaseIsANoOpForAnotherOwner() {
        val first = held()
        now += 100
        val second = held()

        table.release(first)

        assertTrue(table.holds(second))
        assertNull(table.take("@a:hs", 100, 0))
    }

    @Test
    fun accountsDoNotExcludeEachOther() {
        val a = held(account = "@a:hs")
        val b = held(account = "@b:hs")

        assertEquals("@b:hs", b.account)
        assertTrue(table.holds(a))
        assertTrue(table.holds(b))
    }
}

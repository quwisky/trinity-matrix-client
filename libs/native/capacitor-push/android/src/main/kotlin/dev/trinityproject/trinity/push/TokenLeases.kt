package dev.trinityproject.trinity.push

import java.util.UUID

data class LeaseTicket(val account: String, val owner: String)

/** Exclusive access to one account's tokens, with expiry. `take` blocks: call it on a worker thread. */
interface TokenLease {
    fun take(account: String, lifetimeMillis: Long, waitMillis: Long): LeaseTicket?

    fun holds(ticket: LeaseTicket): Boolean

    fun release(ticket: LeaseTicket)
}

class LeaseTable(private val clock: () -> Long = ::monotonicMillis) : TokenLease {
    private class Lease(val owner: String, val expiresAtMillis: Long)

    private val leases = HashMap<String, Lease>()

    // Not @Synchronized: sleeping inside the monitor would stop the holder releasing.
    override fun take(account: String, lifetimeMillis: Long, waitMillis: Long): LeaseTicket? {
        val giveUpAt = clock() + waitMillis
        var ticket = tryTake(account, lifetimeMillis)
        while (ticket == null && clock() < giveUpAt) {
            try {
                Thread.sleep(RETRY_MILLIS)
            } catch (error: InterruptedException) {
                Thread.currentThread().interrupt()
                return null
            }
            ticket = tryTake(account, lifetimeMillis)
        }
        return ticket
    }

    @Synchronized
    override fun holds(ticket: LeaseTicket): Boolean {
        val lease = leases[ticket.account] ?: return false
        return lease.owner == ticket.owner && lease.expiresAtMillis > clock()
    }

    @Synchronized
    override fun release(ticket: LeaseTicket) {
        if (leases[ticket.account]?.owner == ticket.owner) leases.remove(ticket.account)
    }

    @Synchronized
    private fun tryTake(account: String, lifetimeMillis: Long): LeaseTicket? {
        val now = clock()
        val held = leases[account]
        if (held != null && held.expiresAtMillis > now) return null
        val owner = UUID.randomUUID().toString()
        leases[account] = Lease(owner, now + lifetimeMillis)
        return LeaseTicket(account, owner)
    }

    private companion object {
        const val RETRY_MILLIS = 50L
    }
}

/** The process-wide mutex, not on any store instance: the plugin and the service each build their own. */
object TokenLeases : TokenLease by LeaseTable()

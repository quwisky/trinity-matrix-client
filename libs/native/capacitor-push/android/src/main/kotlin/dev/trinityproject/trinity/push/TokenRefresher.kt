package dev.trinityproject.trinity.push

import android.content.Context

/** What a push renderer may do with an account's tokens. Blocking: call it on a worker thread. */
interface PushTokenRefreshing {
    fun refreshForPush(account: String, tokenSeen: String, deadline: Deadline): TokenRefreshResult
}

/** Builds one refresher and hands it to every caller. */
internal class SharedRefresher {
    private var refresher: TokenRefresher? = null

    @Synchronized
    fun get(build: () -> TokenRefresher): TokenRefresher = refresher ?: build().also { refresher = it }
}

/**
 * The one place an account's tokens rotate. The order of [refreshUnderLease] is what keeps someone
 * signed in: read under the lease, send what was read, compare again before any write. Blocking:
 * call it on a worker thread. Logs nothing.
 */
class TokenRefresher(
    private val vault: TokenVault,
    private val lease: TokenLease = TokenLeases,
    private val client: TokenGrantClient = HttpTokenGrantClient(),
    private val wallClock: WallClock = WallClock.SYSTEM,
) : PushTokenRefreshing {
    private class Unsaved(val base: TokenRecord, val next: TokenRecord)

    // A pair the vault would not take. Per process because fromContext shares one instance;
    // `current` reads it without the lease.
    private val pending = HashMap<String, Unsaved>()

    fun refresh(account: String, lineage: String, tokenSeen: String, deadline: Deadline): TokenRefreshResult =
        refreshUnderLease(account, lineage, tokenSeen, deadline, recordRefusal = true)

    /**
     * Only the app records a refusal. A lapsed lease lets a push reuse a token the suspended app
     * already spent, and a provider with no reuse tolerance refuses it though the session is fine.
     */
    override fun refreshForPush(account: String, tokenSeen: String, deadline: Deadline): TokenRefreshResult =
        when (val read = vault.read(account)) {
            TokenVaultRead.Absent -> TokenRefreshResult.Gone
            TokenVaultRead.Unavailable -> TokenRefreshResult.Transient
            is TokenVaultRead.Record ->
                refreshUnderLease(account, read.record.lineage, tokenSeen, deadline, recordRefusal = false)
        }

    private fun refreshUnderLease(
        account: String,
        lineage: String,
        tokenSeen: String,
        deadline: Deadline,
        recordRefusal: Boolean,
    ): TokenRefreshResult {
        val budget = deadline.remainingMillis().coerceAtLeast(0)
        // Twice: connecting and reading each get what is left of the budget.
        var ticket = lease.take(account, 2 * budget + TokenBudgets.LEASE_MARGIN_MILLIS, budget)
            ?: return TokenRefreshResult.Busy
        try {
            flushPending(account)
            val onDisk = when (val read = vault.read(account)) {
                TokenVaultRead.Absent -> return TokenRefreshResult.Gone
                TokenVaultRead.Unavailable -> return TokenRefreshResult.Transient
                is TokenVaultRead.Record -> read.record
            }
            // A write that still fails: the unsaved pair stays the truth here.
            val record = unsaved(account)?.next ?: onDisk
            if (record.lineage != lineage) return TokenRefreshResult.Gone
            if (record.state == TokenState.REFUSED) return TokenRefreshResult.Refused
            if (record.accessToken != tokenSeen) return TokenRefreshResult.Current(record)
            if (record.refreshToken == null || record.tokenEndpoint == null || record.clientId == null) {
                return TokenRefreshResult.Unavailable
            }
            // With less left the answer can be lost after the provider spends the token, and the
            // next refresh is then refused, which ends a live session.
            if (deadline.remainingMillis() < TokenBudgets.GRANT_FLOOR_MILLIS) return TokenRefreshResult.Transient
            val started = wallClock.nowMillis()
            return when (val answer = client.grant(record, deadline)) {
                TokenGrantAnswer.Failed -> TokenRefreshResult.Transient
                TokenGrantAnswer.Refused -> {
                    // After a lapse the refusal may be another caller's overlap: only the next try can tell.
                    if (recordRefusal && !lease.holds(ticket)) return TokenRefreshResult.Transient
                    ticket = retake(ticket, account, deadline) ?: return TokenRefreshResult.Transient
                    when (val read = vault.read(account)) {
                        TokenVaultRead.Absent -> TokenRefreshResult.Gone
                        TokenVaultRead.Unavailable -> TokenRefreshResult.Transient
                        is TokenVaultRead.Record -> {
                            val stored = read.record
                            if (stored.samePair(onDisk) && stored.lineage == lineage) {
                                if (recordRefusal) {
                                    vault.update(account, stored.marked(TokenState.REFUSED))
                                    // A later flush must not overwrite the refused state.
                                    clearPending(account)
                                }
                                TokenRefreshResult.Refused
                            } else {
                                storedOrGone(stored, lineage)
                            }
                        }
                    }
                }
                is TokenGrantAnswer.Tokens -> {
                    val next = record.rotated(
                        answer.accessToken,
                        answer.refreshToken,
                        answer.expiresIn?.let { started + it * 1_000L },
                    )
                    // Busy still compares and writes: the provider has spent the old token, so dropping
                    // this pair gets the next refresh refused, and a process death would lose `pending`.
                    ticket = retake(ticket, account, deadline) ?: ticket
                    when (val read = vault.read(account)) {
                        TokenVaultRead.Absent -> TokenRefreshResult.Gone
                        TokenVaultRead.Unavailable -> keepUnsaved(account, onDisk, next)
                        is TokenVaultRead.Record -> {
                            val stored = read.record
                            if (!stored.samePair(onDisk) || stored.lineage != lineage) {
                                // Discard the late answer.
                                storedOrGone(stored, lineage)
                            } else {
                                // Update-only: never recreates a removed record.
                                when (vault.update(account, next)) {
                                    TokenVaultWrite.WRITTEN -> {
                                        clearPending(account)
                                        TokenRefreshResult.Rotated(next, unsaved = false)
                                    }
                                    TokenVaultWrite.ABSENT -> TokenRefreshResult.Gone
                                    TokenVaultWrite.FAILED -> keepUnsaved(account, onDisk, next)
                                }
                            }
                        }
                    }
                }
            }
        } finally {
            lease.release(ticket)
        }
    }

    fun current(account: String, lineage: String): TokenRefreshResult {
        val ticket = if (unsaved(account) == null) {
            null
        } else {
            lease.take(account, TokenBudgets.LEASE_MARGIN_MILLIS, TokenBudgets.REMOVAL_WAIT_MILLIS)
        }
        if (ticket != null) {
            try {
                flushPending(account)
            } finally {
                lease.release(ticket)
            }
        }
        unsaved(account)?.next?.takeIf { it.lineage == lineage }?.let { return TokenRefreshResult.Current(it) }
        return when (val read = vault.read(account)) {
            TokenVaultRead.Absent -> TokenRefreshResult.Gone
            TokenVaultRead.Unavailable -> TokenRefreshResult.Transient
            is TokenVaultRead.Record -> when {
                read.record.lineage != lineage -> TokenRefreshResult.Gone
                read.record.state == TokenState.REFUSED -> TokenRefreshResult.Refused
                else -> TokenRefreshResult.Current(read.record)
            }
        }
    }

    /** False means nothing was stored. A record of this lineage that has a refresh token stays: it may be newer. */
    fun migrate(record: TokenRecord, account: String): Boolean {
        val ticket = lease.take(
            account,
            TokenBudgets.APP_GRANT_MILLIS + TokenBudgets.LEASE_MARGIN_MILLIS,
            TokenBudgets.APP_GRANT_MILLIS,
        ) ?: return false
        val overwritten = try {
            val read = vault.read(account)
            if (read == TokenVaultRead.Unavailable) return false
            val stored = (read as? TokenVaultRead.Record)?.record
            if (stored != null && stored.lineage == record.lineage && stored.refreshToken != null) return true
            if (!vault.write(account, record)) return false
            stored
        } finally {
            lease.release(ticket)
        }
        if (
            overwritten != null &&
            overwritten.refreshToken != null &&
            overwritten.deviceId != record.deviceId &&
            !overwritten.samePair(record) // revoking it would sign out the record just stored
        ) {
            val deadline = deadlineIn(TokenBudgets.REVOKE_REQUEST_MILLIS)
            // Nobody waits on this thread, and an exception escaping it would end the process.
            Thread { runCatching { client.revoke(overwritten, deadline) } }.apply { isDaemon = true }.start()
        }
        return true
    }

    fun revoke(account: String, lineage: String): TokenRevokeResult {
        val ticket = lease.take(
            account,
            TokenBudgets.REVOKE_REQUEST_MILLIS + TokenBudgets.LEASE_MARGIN_MILLIS,
            TokenBudgets.REVOKE_WAIT_MILLIS,
        ) ?: return TokenRevokeResult.TRANSIENT
        try {
            // A stale unsaved pair must not be revoked in place of the stored, live one.
            flushPending(account)
            val stored = when (val read = vault.read(account)) {
                TokenVaultRead.Absent -> return TokenRevokeResult.GONE
                TokenVaultRead.Unavailable -> return TokenRevokeResult.TRANSIENT
                is TokenVaultRead.Record -> read.record
            }
            val record = unsaved(account)?.next?.takeIf { it.lineage == lineage } ?: stored
            if (record.lineage != lineage || record.revocationEndpoint == null || record.clientId == null) {
                return TokenRevokeResult.GONE
            }
            return if (client.revoke(record, deadlineIn(TokenBudgets.REVOKE_REQUEST_MILLIS))) {
                TokenRevokeResult.REVOKED
            } else {
                TokenRevokeResult.TRANSIENT
            }
        } finally {
            lease.release(ticket)
        }
    }

    /** One account, or every record when [account] is null. Deletes even when the lease stays busy. */
    fun remove(account: String?): Boolean {
        if (account == null) {
            synchronized(pending) { pending.clear() }
            return vault.removeAll()
        }
        val ticket = lease.take(account, TokenBudgets.LEASE_MARGIN_MILLIS, TokenBudgets.REMOVAL_WAIT_MILLIS)
        try {
            clearPending(account)
            return vault.remove(account)
        } finally {
            if (ticket != null) lease.release(ticket)
        }
    }

    /**
     * Every record whose account is not in [keeping], each under its lease. Null when the store
     * cannot list them, and then nothing goes, or when a removal failed, after trying the others.
     */
    fun removeExcept(keeping: Set<String>): Int? {
        val accounts = vault.accounts() ?: return null
        val removals = accounts.filter { it !in keeping }.map { remove(it) }
        return if (removals.all { it }) removals.size else null
    }

    /** A stored pair still equal to the unsaved pair's base gets the unsaved pair. */
    private fun flushPending(account: String) {
        val unsaved = unsaved(account) ?: return
        when (val read = vault.read(account)) {
            TokenVaultRead.Absent -> clearPending(account)
            TokenVaultRead.Unavailable -> Unit
            is TokenVaultRead.Record -> {
                val base = unsaved.base
                if (read.record.samePair(base) && read.record.lineage == base.lineage) {
                    if (vault.update(account, unsaved.next) != TokenVaultWrite.FAILED) clearPending(account)
                } else {
                    clearPending(account)
                }
            }
        }
    }

    private fun retake(ticket: LeaseTicket, account: String, deadline: Deadline): LeaseTicket? {
        if (lease.holds(ticket)) return ticket
        val wait = deadline.remainingMillis().coerceAtLeast(RETAKE_FLOOR_MILLIS)
        return lease.take(account, wait + TokenBudgets.LEASE_MARGIN_MILLIS, wait)
    }

    private fun storedOrGone(stored: TokenRecord, lineage: String): TokenRefreshResult =
        if (stored.lineage == lineage) TokenRefreshResult.Current(stored) else TokenRefreshResult.Gone

    private fun keepUnsaved(account: String, base: TokenRecord, next: TokenRecord): TokenRefreshResult {
        synchronized(pending) { pending[account] = Unsaved(base, next) }
        return TokenRefreshResult.Rotated(next, unsaved = true)
    }

    private fun unsaved(account: String): Unsaved? = synchronized(pending) { pending[account] }

    private fun clearPending(account: String) {
        synchronized(pending) { pending.remove(account) }
    }

    companion object {
        private const val RETAKE_FLOOR_MILLIS = 1_000L
        private val SHARED = SharedRefresher()

        /** One instance per process: the plugin and the service must see the same unsaved pair. */
        @JvmStatic
        fun fromContext(context: Context): TokenRefresher = SHARED.get { TokenRefresher(KeystoreTokenVault(context)) }

        @JvmStatic
        fun appDeadline(): Deadline = deadlineIn(TokenBudgets.APP_GRANT_MILLIS)

        private fun deadlineIn(millis: Long) = Deadline(monotonicMillis() + millis, ::monotonicMillis)
    }
}

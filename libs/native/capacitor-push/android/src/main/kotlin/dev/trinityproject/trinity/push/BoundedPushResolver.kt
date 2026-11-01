package dev.trinityproject.trinity.push

import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Resolves a push within one total time budget. [HttpMatrixApi] bounds each read, which does
 * not cover a stalled DNS lookup or a trickling body, so the resolution runs on a worker
 * thread and, once the budget is spent, the push reads as if every fetch had failed: the
 * stored room name (or "Trinity") with "New message", without further network or a refresh.
 *
 * The worker's reads share this budget, so nothing starts once the push has moved on, when the
 * process may die with a grant's answer. What is already in flight is not interrupted: on Android's
 * HTTP stack an interrupt can end the read that carries the rotated pair, after the provider has
 * spent the old one, and that gets the next refresh refused.
 */
class BoundedPushResolver(
    store: HandoffReader,
    api: MatrixApi,
    tokens: PushTokenRefreshing? = null,
    private val budgetMillis: Long = Deadline.BUDGET_MILLIS,
    private val wallClock: WallClock = WallClock.SYSTEM,
) {
    private val store: HandoffReader = FaultTolerantReader(store)
    private val resolver = PushResolver(this.store, api, wallClock, tokens)

    fun resolve(data: Map<String, String>): PushOutcome {
        val deadline = Deadline(monotonicMillis() + budgetMillis, ::monotonicMillis)
        val pending = EXECUTOR.submit<PushOutcome> { resolver.resolve(data, deadline) }
        return try {
            pending.get(budgetMillis, TimeUnit.MILLISECONDS)
        } catch (error: TimeoutException) {
            pending.cancel(false)
            offline(data)
        } catch (error: ExecutionException) {
            offline(data)
        } catch (error: InterruptedException) {
            pending.cancel(false)
            Thread.currentThread().interrupt()
            offline(data)
        }
    }

    private fun offline(data: Map<String, String>): PushOutcome = PushResolver(store, NoNetworkApi, wallClock).resolve(data)

    /**
     * A store fault reads as "no such account or room", which resolves to the generic fallback,
     * and as Always hide for the Notification text (fail closed).
     */
    internal class FaultTolerantReader(private val delegate: HandoffReader) : HandoffReader {
        override fun account(userId: String): HandoffAccount? = try {
            delegate.account(userId)
        } catch (error: RuntimeException) {
            null
        }

        override fun room(userId: String, roomId: String): HandoffRoom? = try {
            delegate.room(userId, roomId)
        } catch (error: RuntimeException) {
            null
        }

        override fun notificationText(): String = try {
            delegate.notificationText()
        } catch (error: RuntimeException) {
            NotificationTextMode.ALWAYS_HIDE
        }
    }

    private object NoNetworkApi : MatrixApi {
        override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline) = PushEventRead.Failed

        override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String? = null

        override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? = null
    }

    private companion object {
        /** Daemon workers so a read stuck past its budget never keeps the process alive. */
        val EXECUTOR = Executors.newCachedThreadPool { task ->
            Thread(task, "trinity-push-resolve").apply { isDaemon = true }
        }
    }
}

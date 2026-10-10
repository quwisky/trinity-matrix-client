package dev.trinityproject.trinity.push

import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import org.json.JSONObject

/**
 * Resolves a push within one total time budget. [HttpMatrixApi] bounds each read, which does
 * not cover a stalled DNS lookup or a trickling body, so the resolution runs on a worker
 * thread and, once the budget is spent, the push reads as if every fetch had failed: the
 * stored room name (or "Trinity") with "New message", without further network.
 */
class BoundedPushResolver(
    private val store: HandoffReader,
    api: MatrixApi,
    private val budgetMillis: Long = Deadline.BUDGET_MILLIS,
) {
    private val resolver = PushResolver(store, api)

    fun resolve(data: Map<String, String>): PushOutcome {
        val pending = EXECUTOR.submit<PushOutcome> { resolver.resolve(data) }
        return try {
            pending.get(budgetMillis, TimeUnit.MILLISECONDS)
        } catch (error: TimeoutException) {
            pending.cancel(true)
            offline(data)
        } catch (error: ExecutionException) {
            offline(data)
        } catch (error: InterruptedException) {
            pending.cancel(true)
            Thread.currentThread().interrupt()
            offline(data)
        }
    }

    private fun offline(data: Map<String, String>): PushOutcome = PushResolver(store, NoNetworkApi).resolve(data)

    private object NoNetworkApi : MatrixApi {
        override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): JSONObject? = null

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

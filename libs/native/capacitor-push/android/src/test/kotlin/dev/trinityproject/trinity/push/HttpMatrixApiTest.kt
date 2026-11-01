package dev.trinityproject.trinity.push

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Runs HttpMatrixApi against a JDK HttpServer on the loopback interface. */
class HttpMatrixApiTest {
    private lateinit var server: HttpServer
    private val paths = mutableListOf<String>()
    private val authorizations = mutableListOf<String?>()

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.start()
    }

    @After
    fun stop() {
        server.stop(0)
    }

    private fun account() = HandoffAccount("http://127.0.0.1:${server.address.port}/", "secret", true)

    private fun respond(status: Int, body: String, delayMillis: Long = 0) {
        server.createContext("/") { exchange ->
            paths += exchange.requestURI.rawPath
            authorizations += exchange.requestHeaders.getFirst("Authorization")
            Thread.sleep(delayMillis)
            val bytes = body.toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
    }

    @Test
    fun encodesEachIdAsOnePathSegment() {
        assertEquals("%24abc%2Bdef%2Fghi", encodePathSegment("\$abc+def/ghi"))
        assertEquals("%21room%3Ahs", encodePathSegment("!room:hs"))
        assertEquals("%40alice%3Ahs", encodePathSegment("@alice:hs"))
    }

    @Test
    fun fetchesTheEventWithTheAccountsToken() {
        respond(200, """{"type":"m.room.message","sender":"@a:hs"}""")

        val read = HttpMatrixApi().event(account(), "!room:hs", "\$abc+def/ghi", Deadline.start())

        assertEquals("@a:hs", (read as PushEventRead.Event).json.getString("sender"))
        assertEquals(listOf("/_matrix/client/v3/rooms/%21room%3Ahs/event/%24abc%2Bdef%2Fghi"), paths)
        assertEquals(listOf<String?>("Bearer secret"), authorizations)
    }

    @Test
    fun aFetchSeparatesUnauthorizedFromFailed() {
        fun readAfter(status: Int, body: String = """{"errcode":"M_X"}"""): PushEventRead {
            respond(status, body)
            return HttpMatrixApi().event(account(), "!r:hs", "\$e", Deadline.start()).also { server.removeContext("/") }
        }

        assertEquals(PushEventRead.Unauthorized, readAfter(401))
        assertEquals(PushEventRead.Failed, readAfter(403))
        assertEquals(PushEventRead.Failed, readAfter(404))
        assertEquals(PushEventRead.Failed, readAfter(500))
        assertEquals(PushEventRead.Failed, readAfter(200, "<html>captive portal</html>"))
    }

    @Test
    fun aRejectedNameReadIsNoName() {
        respond(401, """{"errcode":"M_UNKNOWN_TOKEN"}""")

        assertNull(HttpMatrixApi().memberDisplayName(account(), "!r:hs", "@a:hs", Deadline.start()))
        assertNull(HttpMatrixApi().roomName(account(), "!r:hs", Deadline.start()))
    }

    @Test
    fun aReadEventNeverPrintsItsContent() {
        assertFalse(PushEventRead.Event(JSONObject().put("body", "Secret plans")).toString().contains("Secret"))
    }

    @Test
    fun givesUpWhenTheBudgetRunsOut() {
        respond(200, """{"type":"m.room.message"}""", delayMillis = 2_000)
        val started = monotonicMillis()

        val read = HttpMatrixApi().event(account(), "!r:hs", "\$e", Deadline(started + 300, ::monotonicMillis))

        assertEquals(PushEventRead.Failed, read)
        assertTrue(monotonicMillis() - started < 1_500)
    }

    @Test
    fun sendsNothingOnceTheBudgetIsSpent() {
        respond(200, """{"name":"Lobby"}""")

        assertNull(HttpMatrixApi().roomName(account(), "!r:hs", Deadline(0, { 1L })))
        assertTrue(paths.isEmpty())
    }

    @Test
    fun readsAMissingDisplayNameAsNull() {
        respond(200, """{"membership":"join","displayname":null}""")

        assertNull(HttpMatrixApi().memberDisplayName(account(), "!r:hs", "@a:hs", Deadline.start()))
    }

    @Test
    fun neverFollowsARedirectWithTheToken() {
        val targetPaths = mutableListOf<String>()
        val target = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        target.createContext("/") { exchange ->
            targetPaths += exchange.requestURI.rawPath
            val bytes = """{"type":"m.room.message"}""".toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        target.start()
        try {
            server.createContext("/") { exchange ->
                paths += exchange.requestURI.rawPath
                exchange.responseHeaders.add("Location", "http://127.0.0.1:${target.address.port}/stolen")
                exchange.sendResponseHeaders(302, -1)
                exchange.close()
            }

            assertEquals(PushEventRead.Failed, HttpMatrixApi().event(account(), "!r:hs", "\$e", Deadline.start()))
            assertEquals(1, paths.size)
            assertTrue(targetPaths.isEmpty())
        } finally {
            target.stop(0)
        }
    }
}

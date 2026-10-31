package dev.trinityproject.trinity.push

import com.sun.net.httpserver.HttpServer
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Runs HttpTokenGrantClient against a JDK HttpServer on the loopback interface. */
class HttpTokenGrantClientTest {
    private class Request(val method: String, val path: String, val contentType: String?, val body: String) {
        val form: List<String> = body.split("&")
    }

    private lateinit var server: HttpServer
    private val requests = CopyOnWriteArrayList<Request>()

    @Volatile
    private var status = 200

    @Volatile
    private var answer = """{"access_token":"a1","refresh_token":"r1","expires_in":300}"""

    @Volatile
    private var delayMillis = 0L

    @Volatile
    private var statusFor: ((String) -> Int)? = null

    @Volatile
    private var location: String? = null

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val body = exchange.requestBody.bufferedReader().use { it.readText() }
            requests.add(
                Request(
                    exchange.requestMethod,
                    exchange.requestURI.rawPath,
                    exchange.requestHeaders.getFirst("Content-Type"),
                    body,
                ),
            )
            Thread.sleep(delayMillis)
            val bytes = answer.toByteArray()
            location?.let { exchange.responseHeaders.add("Location", it) }
            exchange.sendResponseHeaders(statusFor?.invoke(body) ?: status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @After
    fun stop() {
        server.stop(0)
    }

    private fun record(): TokenRecord {
        val base = "http://127.0.0.1:${server.address.port}"
        return R0.copy(tokenEndpoint = "$base/token", revocationEndpoint = "$base/revoke")
    }

    private fun deadline() = Deadline(8_000L, { 0L })

    // Only a 401 leaves the production path: the JDK throws on one in streaming mode, Android does not.
    private fun grantAnswering(answeredStatus: Int, body: String): TokenGrantAnswer {
        status = answeredStatus
        answer = body
        val client = if (answeredStatus == 401) HttpTokenGrantClient(streaming = false) else HttpTokenGrantClient()
        return client.grant(record(), deadline())
    }

    @Test
    fun aGrantIsAFormPostToThePinnedEndpointOnly() {
        HttpTokenGrantClient().grant(record(), deadline())

        assertEquals(1, requests.size)
        val request = requests[0]
        assertEquals("POST", request.method)
        assertEquals("/token", request.path)
        assertEquals("application/x-www-form-urlencoded", request.contentType)
        assertTrue(request.form.contains("grant_type=refresh_token"))
        assertTrue(request.form.contains("client_id=c"))
        assertTrue(request.form.contains("refresh_token=r0"))
    }

    @Test
    fun aGrantEncodesItsFormValues() {
        HttpTokenGrantClient().grant(record().copy(refreshToken = "r&a=b c"), deadline())

        assertTrue(requests[0].form.contains("refresh_token=r%26a%3Db+c"))
    }

    @Test
    fun a200ParsesTokensAndExpiresIn() {
        assertEquals(TokenGrantAnswer.Tokens("a1", "r1", 300L), HttpTokenGrantClient().grant(record(), deadline()))
    }

    @Test
    fun anEmptyRefreshTokenReadsAsNone() {
        assertEquals(
            TokenGrantAnswer.Tokens("a1", null, 300L),
            grantAnswering(200, """{"access_token":"a1","refresh_token":"","expires_in":300}"""),
        )
    }

    @Test
    fun anUnusableExpiresInReadsAsNone() {
        for (expiresIn in listOf("\"300\"", "-1", "0", "1e30")) {
            assertEquals(
                TokenGrantAnswer.Tokens("a1", null, null),
                grantAnswering(200, """{"access_token":"a1","expires_in":$expiresIn}"""),
            )
        }
    }

    @Test
    fun a400Or401WithAnOAuthBodyIsRefused() {
        val codes = listOf(
            "invalid_request",
            "invalid_client",
            "invalid_grant",
            "unauthorized_client",
            "unsupported_grant_type",
            "invalid_scope",
        )
        for (refusing in listOf(400, 401)) {
            for (code in codes) {
                assertEquals(TokenGrantAnswer.Refused, grantAnswering(refusing, """{"error":"$code"}"""))
            }
        }
    }

    @Test
    fun a401WithoutAnOAuthBodyIsTransient() {
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(401, "<html>"))
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(401, ""))
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(400, """{"error":{"code":1}}"""))
    }

    @Test
    fun aGatewaysJsonErrorIsTransient() {
        for (notARefusal in listOf(400, 401)) {
            assertEquals(TokenGrantAnswer.Failed, grantAnswering(notARefusal, """{"status":401,"error":"Unauthorized"}"""))
            assertEquals(TokenGrantAnswer.Failed, grantAnswering(notARefusal, """{"error":""}"""))
        }
    }

    @Test
    fun aMatrixErrorBodyIsTransient() {
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(401, """{"errcode":"M_UNKNOWN","error":"x"}"""))
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(401, """{"errcode":"M_UNKNOWN","error":"invalid_grant"}"""))
    }

    @Test
    fun aDroppedAnswerIsNotResent() {
        server.removeContext("/")
        server.createContext("/") { exchange ->
            requests.add(
                Request(
                    exchange.requestMethod,
                    exchange.requestURI.rawPath,
                    null,
                    exchange.requestBody.bufferedReader().use { it.readText() },
                ),
            )
            exchange.close()
        }

        assertEquals(TokenGrantAnswer.Failed, HttpTokenGrantClient().grant(record(), deadline()))

        assertEquals(1, requests.size)
    }

    @Test
    fun aDeadlineSpentWhileConnectingSendsNoBody() {
        var reads = 0
        val spentAfterTheFirstRead = Deadline(100L, { if (reads++ == 0) 0L else 1_000L })

        assertEquals(TokenGrantAnswer.Failed, HttpTokenGrantClient().grant(record(), spentAfterTheFirstRead))

        assertTrue(requests.isEmpty())
    }

    private fun aBodyOfBytes(size: Int): String {
        val start = "{\"access_token\":\"a1\",\"pad\":\""
        val end = "\"}"
        return start + "x".repeat(size - start.length - end.length) + end
    }

    @Test
    fun aBodyUpToTheCapIsRead() {
        assertEquals(TokenGrantAnswer.Tokens("a1", null, null), grantAnswering(200, aBodyOfBytes(64 * 1024)))
    }

    @Test
    fun aBodyOverTheCapIsTransient() {
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(200, aBodyOfBytes(64 * 1024 + 1)))
    }

    @Test
    fun aTricklingBodyStopsAtTheDeadline() {
        server.removeContext("/")
        server.createContext("/") { exchange ->
            exchange.sendResponseHeaders(200, 0)
            exchange.responseBody.use { body ->
                repeat(30) {
                    body.write(' '.code)
                    body.flush()
                    Thread.sleep(100)
                }
                body.write("""{"access_token":"a1"}""".toByteArray())
            }
        }
        val started = monotonicMillis()

        val answered = HttpTokenGrantClient().grant(record(), Deadline(started + 300, ::monotonicMillis))

        assertEquals(TokenGrantAnswer.Failed, answered)
        assertTrue(monotonicMillis() - started < 1_500)
    }

    @Test
    fun aSlowCompleteBodyPastTheDeadlineIsUsed() {
        val spent = AtomicBoolean(false)
        server.removeContext("/")
        server.createContext("/") { exchange ->
            exchange.sendResponseHeaders(200, 0)
            exchange.responseBody.use { body ->
                body.write("""{"access_token":"a1",""".toByteArray())
                body.flush()
                Thread.sleep(300)
                spent.set(true)
                body.write(""" "refresh_token":"r1"}""".toByteArray())
            }
        }

        val answered = HttpTokenGrantClient().grant(record(), Deadline(8_000L, { if (spent.get()) 9_000L else 0L }))

        assertEquals(TokenGrantAnswer.Tokens("a1", "r1", null), answered)
    }

    @Test
    fun aBodyUnfinishedAtTheDeadlineIsTransient() {
        val spent = AtomicBoolean(false)
        server.removeContext("/")
        server.createContext("/") { exchange ->
            spent.set(true)
            exchange.sendResponseHeaders(200, 0)
            exchange.responseBody.use { body ->
                body.write("""{"access_token":"a1",""".toByteArray())
                body.flush()
                Thread.sleep(300)
            }
        }

        val answered = HttpTokenGrantClient().grant(record(), Deadline(8_000L, { if (spent.get()) 9_000L else 0L }))

        assertEquals(TokenGrantAnswer.Failed, answered)
    }

    @Test
    fun aCompleteBodyWhoseEndNeverArrivesIsUsed() {
        server.removeContext("/")
        server.createContext("/") { exchange ->
            exchange.sendResponseHeaders(200, 0)
            exchange.responseBody.use { body ->
                body.write("""{"access_token":"a1"}""".toByteArray())
                body.flush()
                Thread.sleep(1_000)
            }
        }
        val started = monotonicMillis()

        val answered = HttpTokenGrantClient().grant(record(), Deadline(started + 300, ::monotonicMillis))

        assertEquals(TokenGrantAnswer.Tokens("a1", null, null), answered)
    }

    @Test
    fun aDeeplyNestedBodyIsTransient() {
        val deep = """{"access_token":"a1","x":""" + "[".repeat(60_000)

        assertEquals(TokenGrantAnswer.Failed, grantAnswering(200, deep))
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(400, deep))
    }

    @Test
    fun aSpentDeadlineSendsNothing() {
        val client = HttpTokenGrantClient()

        for (spent in listOf(Deadline(1L, { 1L }), Deadline(0L, { 1L }))) {
            assertEquals(TokenGrantAnswer.Failed, client.grant(record(), spent))
            assertFalse(client.revoke(record(), spent))
        }

        assertTrue(requests.isEmpty())
    }

    @Test
    fun otherStatusesAndTimeoutsAreTransient() {
        for (other in listOf(403, 404, 429, 503)) {
            assertEquals(TokenGrantAnswer.Failed, grantAnswering(other, """{"error":"invalid_grant"}"""))
        }

        delayMillis = 2_000L
        val started = monotonicMillis()
        val answered = HttpTokenGrantClient().grant(record(), Deadline(started + 300, ::monotonicMillis))

        assertEquals(TokenGrantAnswer.Failed, answered)
        assertTrue(monotonicMillis() - started < 1_500)
    }

    @Test
    fun a200WithoutAnAccessTokenIsTransient() {
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(200, "<html>"))
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(200, """{"token_type":"Bearer"}"""))
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(200, """{"access_token":""}"""))
    }

    @Test
    fun anEndpointThatIsNotHttpIsTransient() {
        val client = HttpTokenGrantClient()

        assertEquals(TokenGrantAnswer.Failed, client.grant(record().copy(tokenEndpoint = "file:///etc/hosts"), deadline()))
        assertEquals(TokenGrantAnswer.Failed, client.grant(record().copy(tokenEndpoint = "not a url"), deadline()))
    }

    @Test
    fun aRedirectIsRefusedAndNeverCarriesTheRefreshToken() {
        val targetBodies = CopyOnWriteArrayList<String>()
        val target = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        target.createContext("/") { exchange ->
            targetBodies.add(exchange.requestBody.bufferedReader().use { it.readText() })
            val bytes = """{"access_token":"stolen"}""".toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        target.start()
        try {
            server.removeContext("/")
            server.createContext("/") { exchange ->
                requests.add(Request(exchange.requestMethod, exchange.requestURI.rawPath, null, ""))
                exchange.responseHeaders.add("Location", "http://127.0.0.1:${target.address.port}/stolen")
                exchange.sendResponseHeaders(302, -1)
                exchange.close()
            }

            assertEquals(TokenGrantAnswer.Failed, HttpTokenGrantClient().grant(record(), deadline()))
            assertEquals(1, requests.size)
            assertTrue(targetBodies.isEmpty())
        } finally {
            target.stop(0)
        }
    }

    @Test
    fun revokeSendsBothTokensWithHints() {
        answer = ""

        assertTrue(HttpTokenGrantClient().revoke(record(), deadline()))

        assertEquals(listOf("/revoke", "/revoke"), requests.map { it.path })
        assertTrue(requests[0].form.containsAll(listOf("token=r0", "token_type_hint=refresh_token", "client_id=c")))
        assertTrue(requests[1].form.containsAll(listOf("token=a0", "token_type_hint=access_token", "client_id=c")))
    }

    @Test
    fun aStalledRevocationHasAlreadySentTheRefreshToken() {
        delayMillis = 2_000L
        val started = monotonicMillis()

        assertFalse(HttpTokenGrantClient().revoke(record(), Deadline(started + 300, ::monotonicMillis)))

        assertEquals(1, requests.size)
        assertTrue(requests[0].form.contains("token=r0"))
    }

    @Test
    fun aRefusedRevocationIsFalseAndStillTriesBothTokens() {
        status = 503

        assertFalse(HttpTokenGrantClient().revoke(record(), deadline()))

        assertEquals(2, requests.size)
    }

    @Test
    fun anyTwoHundredAnswerIsRevoked() {
        answer = ""
        status = 202

        assertTrue(HttpTokenGrantClient().revoke(record(), deadline()))
    }

    @Test
    fun revokeWithNoRefreshTokenSendsTheAccessToken() {
        answer = ""

        assertTrue(HttpTokenGrantClient().revoke(record().copy(refreshToken = null), deadline()))

        assertEquals(1, requests.size)
        assertTrue(requests[0].form.contains("token=a0"))
    }

    @Test
    fun eitherTokenFailingIsFalseAndBothAreTried() {
        answer = ""
        for (failing in listOf("token=r0", "token=a0")) {
            requests.clear()
            statusFor = { body -> if (failing in body.split("&")) 503 else 200 }

            assertFalse(failing, HttpTokenGrantClient().revoke(record(), deadline()))

            assertEquals(failing, 2, requests.size)
        }
    }

    @Test
    fun aRedirectedRevocationIsFalse() {
        answer = ""
        status = 302
        location = "http://127.0.0.1:${server.address.port}/elsewhere"

        assertFalse(HttpTokenGrantClient().revoke(record(), deadline()))

        assertEquals(listOf("/revoke", "/revoke"), requests.map { it.path })
    }

    @Test
    fun aDisconnectThatThrowsKeepsTheAnswer() {
        val connection = object : HttpURLConnection(URI.create("http://unused.invalid/").toURL()) {
            override fun connect() = Unit
            override fun disconnect(): Unit = throw IllegalStateException("disconnect")
            override fun usingProxy() = false
            override fun getOutputStream(): OutputStream = ByteArrayOutputStream()
            override fun getResponseCode() = 200
            override fun getInputStream(): InputStream = """{"access_token":"a1"}""".byteInputStream()
        }
        val client = HttpTokenGrantClient(true) { connection }

        assertEquals(TokenGrantAnswer.Tokens("a1", null, null), client.grant(record(), deadline()))
    }

    @Test
    fun revokeWithoutAnEndpointSendsNothing() {
        assertFalse(HttpTokenGrantClient().revoke(record().copy(revocationEndpoint = null), deadline()))

        assertTrue(requests.isEmpty())
    }
}

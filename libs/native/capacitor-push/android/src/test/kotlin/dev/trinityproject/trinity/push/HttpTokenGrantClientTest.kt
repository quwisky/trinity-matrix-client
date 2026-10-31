package dev.trinityproject.trinity.push

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
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

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            requests.add(
                Request(
                    exchange.requestMethod,
                    exchange.requestURI.rawPath,
                    exchange.requestHeaders.getFirst("Content-Type"),
                    exchange.requestBody.bufferedReader().use { it.readText() },
                ),
            )
            Thread.sleep(delayMillis)
            val bytes = answer.toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
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

    private fun grantAnswering(answeredStatus: Int, body: String): TokenGrantAnswer {
        status = answeredStatus
        answer = body
        return HttpTokenGrantClient().grant(record(), deadline())
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
        for (refusing in listOf(400, 401)) {
            assertEquals(TokenGrantAnswer.Refused, grantAnswering(refusing, """{"error":"invalid_grant"}"""))
        }
    }

    @Test
    fun a401WithoutAnOAuthBodyIsTransient() {
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(401, "<html>"))
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(401, ""))
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(400, """{"error":{"code":1}}"""))
    }

    @Test
    fun aMatrixErrorBodyIsTransient() {
        assertEquals(TokenGrantAnswer.Failed, grantAnswering(401, """{"errcode":"M_UNKNOWN","error":"x"}"""))
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
        assertTrue(requests[0].form.containsAll(listOf("token=a0", "token_type_hint=access_token", "client_id=c")))
        assertTrue(requests[1].form.containsAll(listOf("token=r0", "token_type_hint=refresh_token", "client_id=c")))
    }

    @Test
    fun aRefusedRevocationIsFalseAndStillTriesBothTokens() {
        status = 503

        assertFalse(HttpTokenGrantClient().revoke(record(), deadline()))

        assertEquals(2, requests.size)
    }

    @Test
    fun revokeWithoutAnEndpointSendsNothing() {
        assertFalse(HttpTokenGrantClient().revoke(record().copy(revocationEndpoint = null), deadline()))

        assertTrue(requests.isEmpty())
    }
}

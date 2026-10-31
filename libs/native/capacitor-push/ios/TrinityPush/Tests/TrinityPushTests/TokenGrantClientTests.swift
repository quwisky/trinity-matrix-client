import Foundation
import Network
import XCTest
@testable import TrinityPush

/// A real HTTP/1.1 listener on the loopback interface. URLProtocol stubs sit above the stack that
/// could re-send a spent token, follow a redirect or hold a body back, so these tests use sockets.
private final class LoopbackServer: @unchecked Sendable {
    struct Request: Sendable {
        let head: String
        let body: String

        var requestLine: String { head.components(separatedBy: "\r\n").first ?? "" }
        var form: [String] { body.components(separatedBy: "&") }

        func header(_ name: String) -> String? {
            let prefix = name.lowercased() + ":"
            return head.components(separatedBy: "\r\n")
                .first { $0.lowercased().hasPrefix(prefix) }?
                .dropFirst(prefix.count)
                .trimmingCharacters(in: .whitespaces)
        }
    }

    enum Step: Sendable {
        case send(String)
        case sendBytes(Data)
        case wait(TimeInterval)
        case run(@Sendable () -> Void)
        /// Ends the connection with no more bytes, as a dropped answer would.
        case drop
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "loopback-server")
    private let received = LockedState<[Request]>([])
    private let connections = LockedState<[NWConnection]>([])
    private let script: LockedState<@Sendable (Request) -> [Step]>

    init(_ script: @escaping @Sendable (Request) -> [Step] = { _ in LoopbackServer.answer(200, "") }) throws {
        self.script = LockedState(script)
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 10) == .success else { throw URLError(.cannotConnectToHost) }
    }

    var requests: [Request] { received.withLock { $0 } }
    var base: String { "http://127.0.0.1:\(listener.port?.rawValue ?? 0)" }

    func answer(_ script: @escaping @Sendable (Request) -> [Step]) {
        self.script.withLock { $0 = script }
    }

    func stop() {
        listener.cancel()
        connections.withLock { $0.forEach { $0.forceCancel() } }
    }

    static func head(_ status: Int, headers: [String] = []) -> String {
        let lines = ["HTTP/1.1 \(status) Answer", "Content-Type: application/json", "X-Content-Type-Options: nosniff",
                     "Connection: close"] + headers
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    static func answer(_ status: Int, _ body: String, headers: [String] = []) -> [Step] {
        [.send(head(status, headers: headers + ["Content-Length: \(body.utf8.count)"]) + "\r\n" + body)]
    }

    /// The head of an answer whose body has no stated length, so the server can stall inside it.
    static func openEnded(_ status: Int = 200) -> Step {
        .send(head(status) + "\r\n")
    }

    private func accept(_ connection: NWConnection) {
        connections.withLock { $0.append(connection) }
        connection.start(queue: queue)
        receive(connection, Data())
    }

    private func receive(_ connection: NWConnection, _ sofar: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, done, _ in
            guard let self else { return }
            let bytes = sofar + (data ?? Data())
            if let request = Self.parse(bytes) {
                self.received.withLock { $0.append(request) }
                self.run(self.script.withLock { $0 }(request)[...], on: connection)
            } else if !done {
                self.receive(connection, bytes)
            }
        }
    }

    private static func parse(_ bytes: Data) -> Request? {
        guard let end = bytes.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: bytes[..<end.lowerBound], as: UTF8.self)
        let partial = Request(head: head, body: "")
        let length = partial.header("Content-Length").flatMap(Int.init) ?? 0
        let body = bytes[end.upperBound...]
        guard body.count >= length else { return nil }
        return Request(head: head, body: String(decoding: body, as: UTF8.self))
    }

    private func run(_ steps: ArraySlice<Step>, on connection: NWConnection) {
        guard let step = steps.first else {
            connection.send(content: nil, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
            return
        }
        let rest = steps.dropFirst()
        switch step {
        case .send(let text):
            connection.send(content: Data(text.utf8), completion: .contentProcessed { [weak self] _ in
                self?.run(rest, on: connection)
            })
        case .sendBytes(let bytes):
            connection.send(content: bytes, completion: .contentProcessed { [weak self] _ in
                self?.run(rest, on: connection)
            })
        case .wait(let seconds):
            queue.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.run(rest, on: connection) }
        case .run(let work):
            work()
            run(rest, on: connection)
        case .drop:
            connection.forceCancel()
        }
    }
}

final class TokenGrantClientTests: XCTestCase {
    private var server: LoopbackServer!
    private let client = URLSessionTokenGrantClient()
    /// Well under the servers' 30 s stalls and the real timeouts, and far over a loaded runner's delay.
    private let stallBound: TimeInterval = 10

    override func setUpWithError() throws {
        server = try LoopbackServer { _ in
            LoopbackServer.answer(200, #"{"access_token":"a1","refresh_token":"r1","expires_in":300}"#)
        }
    }

    override func tearDown() {
        server.stop()
    }

    private func record(refreshToken: String? = "r0") -> TokenRecord {
        tokenRecord(
            refreshToken: refreshToken, tokenEndpoint: "\(server.base)/token",
            revocationEndpoint: "\(server.base)/revoke")
    }

    private func deadline(_ seconds: TimeInterval = 8) -> Date { Date().addingTimeInterval(seconds) }

    private func grantAnswering(_ status: Int, _ body: String) async -> TokenGrantAnswer {
        server.answer { _ in LoopbackServer.answer(status, body) }
        return await client.grant(record(), deadline: deadline())
    }

    // MARK: The request

    func testAGrantIsAFormPostToThePinnedEndpointOnly() async throws {
        _ = await client.grant(record(), deadline: deadline())

        XCTAssertEqual(server.requests.count, 1)
        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(request.requestLine, "POST /token HTTP/1.1")
        XCTAssertEqual(request.header("Content-Type"), "application/x-www-form-urlencoded")
        XCTAssertEqual(request.header("Accept"), "application/json")
        XCTAssertEqual(request.form.sorted(), ["client_id=c", "grant_type=refresh_token", "refresh_token=r0"])
    }

    func testAGrantEncodesItsFormValues() async throws {
        _ = await client.grant(record(refreshToken: "r&a=b c+d"), deadline: deadline())

        XCTAssertTrue(try XCTUnwrap(server.requests.first).form.contains("refresh_token=r%26a%3Db%20c%2Bd"))
    }

    func testAnEndpointThatIsNotHttpIsTransient() async {
        for endpoint in ["file:///etc/hosts", "not a url", ""] {
            let notHttp = tokenRecord(tokenEndpoint: endpoint)
            let answer = await client.grant(notHttp, deadline: deadline())
            XCTAssertEqual(answer, .failed, endpoint)
        }
    }

    func testASpentDeadlineSendsNothing() async {
        for spent in [Date(), Date().addingTimeInterval(-1)] {
            let answer = await client.grant(record(), deadline: spent)
            let revoked = await client.revoke(record(), deadline: spent)
            XCTAssertEqual(answer, .failed)
            XCTAssertFalse(revoked)
        }
        XCTAssertEqual(server.requests.count, 0)
    }

    func testADeadlineAtNowSendsNothing() async {
        let now = Date()
        let stopped = URLSessionTokenGrantClient(configuration: .ephemeral, now: { now })

        let answer = await stopped.grant(record(), deadline: now)

        XCTAssertEqual(answer, .failed)
        XCTAssertEqual(server.requests.count, 0)
    }

    func testADeadlineSpentJustBeforeSendingSendsNothing() async {
        let reads = LockedState(0)
        let start = Date()
        let spentAfterTheFirstRead = URLSessionTokenGrantClient(configuration: .ephemeral, now: {
            let read = reads.withLock { value -> Int in
                value += 1
                return value
            }
            return read == 1 ? start : start.addingTimeInterval(9)
        })

        let answer = await spentAfterTheFirstRead.grant(record(), deadline: start.addingTimeInterval(8))

        XCTAssertEqual(answer, .failed)
        XCTAssertEqual(server.requests.count, 0)
    }

    func testNoSessionKeepsCookiesOrCachesOrWaitsForConnectivity() throws {
        let base = URLSessionConfiguration.default
        base.waitsForConnectivity = true

        let session = try XCTUnwrap(URLSessionTokenGrantClient.sessionConfiguration(from: base, timeout: 3))

        XCTAssertNil(session.urlCache)
        XCTAssertEqual(session.requestCachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertNil(session.httpCookieStorage)
        XCTAssertFalse(session.httpShouldSetCookies)
        XCTAssertEqual(session.httpCookieAcceptPolicy, .never)
        XCTAssertNil(session.urlCredentialStorage)
        XCTAssertFalse(session.waitsForConnectivity)
        XCTAssertEqual(session.timeoutIntervalForRequest, 3)
        XCTAssertEqual(session.timeoutIntervalForResource, 3)
        XCTAssertTrue(base.waitsForConnectivity, "the caller's configuration stays as it was")
    }

    func testACookieFromOneGrantIsNotSentOnTheNext() async throws {
        server.answer { _ in
            LoopbackServer.answer(200, #"{"access_token":"a1"}"#, headers: ["Set-Cookie: seen=1; Path=/"])
        }

        _ = await client.grant(record(), deadline: deadline())
        _ = await client.grant(record(), deadline: deadline())

        XCTAssertEqual(server.requests.count, 2)
        XCTAssertNil(try XCTUnwrap(server.requests.last).header("Cookie"))
    }

    // MARK: Answers that hold tokens

    func test200ParsesTokensAndExpiresIn() async {
        let answer = await client.grant(record(), deadline: deadline())
        XCTAssertEqual(answer, .tokens(accessToken: "a1", refreshToken: "r1", expiresIn: 300))
    }

    func testAnEmptyRefreshTokenReadsAsNone() async {
        let answer = await grantAnswering(200, #"{"access_token":"a1","refresh_token":"","expires_in":300}"#)
        XCTAssertEqual(answer, .tokens(accessToken: "a1", refreshToken: nil, expiresIn: 300))
    }

    func testAnUnusableExpiresInReadsAsNone() async {
        for expiresIn in [#""300""#, "-1", "0", "1e30", "true", "null"] {
            let answer = await grantAnswering(200, #"{"access_token":"a1","expires_in":\#(expiresIn)}"#)
            XCTAssertEqual(answer, .tokens(accessToken: "a1", refreshToken: nil, expiresIn: nil), expiresIn)
        }
    }

    func test200WithoutAnAccessTokenIsTransient() async {
        for body in ["<html>", #"{"token_type":"Bearer"}"#, #"{"access_token":""}"#, #"{"access_token":7}"#, "[]"] {
            let answer = await grantAnswering(200, body)
            XCTAssertEqual(answer, .failed, body)
        }
    }

    // MARK: Refusals

    func test400Or401WithAnOAuthBodyIsRefused() async {
        let codes = ["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
                     "unsupported_grant_type", "invalid_scope"]
        for status in [400, 401] {
            for code in codes {
                let answer = await grantAnswering(status, #"{"error":"\#(code)"}"#)
                XCTAssertEqual(answer, .refused, "\(status) \(code)")
            }
        }
    }

    func test401WithoutAnOAuthBodyIsTransient() async {
        for body in ["<html>", "", #"{"error":{"code":1}}"#] {
            let answer = await grantAnswering(401, body)
            XCTAssertEqual(answer, .failed, body)
        }
    }

    func testAGatewaysJsonErrorIsTransient() async {
        for status in [400, 401] {
            for body in [#"{"status":401,"error":"Unauthorized"}"#, #"{"error":""}"#] {
                let answer = await grantAnswering(status, body)
                XCTAssertEqual(answer, .failed, body)
            }
        }
    }

    func testAMatrixErrorBodyIsTransient() async {
        for body in [#"{"errcode":"M_UNKNOWN","error":"x"}"#, #"{"errcode":"M_UNKNOWN","error":"invalid_grant"}"#] {
            let answer = await grantAnswering(401, body)
            XCTAssertEqual(answer, .failed, body)
        }
    }

    func testOtherStatusesAndTimeoutsAreTransient() async {
        for status in [403, 404, 429, 503] {
            let answer = await grantAnswering(status, #"{"error":"invalid_grant"}"#)
            XCTAssertEqual(answer, .failed, "\(status)")
        }

        server.answer { _ in [.wait(30)] }
        let started = Date()
        let answer = await client.grant(record(), deadline: deadline(0.3))

        XCTAssertEqual(answer, .failed)
        XCTAssertLessThan(Date().timeIntervalSince(started), stallBound)
    }

    // MARK: No second send

    /// URLSession answers these by sending the POST again, refresh token and all.
    func test401WithAnAuthChallengeIsSentOnce() async {
        let challenges = [#"Basic realm="x""#, #"Digest realm="x", nonce="n", qop="auth""#, "Negotiate"]
        for challenge in challenges {
            let before = server.requests.count
            server.answer { _ in
                LoopbackServer.answer(401, #"{"error":"invalid_grant"}"#, headers: ["WWW-Authenticate: \(challenge)"])
            }

            let answer = await client.grant(record(), deadline: deadline())

            XCTAssertEqual(answer, .failed, challenge)
            XCTAssertEqual(server.requests.count, before + 1, challenge)
        }
    }

    func testOnlyServerTrustKeepsDefaultHandling() {
        XCTAssertEqual(
            URLSessionTokenGrantClient.disposition(for: NSURLAuthenticationMethodServerTrust), .performDefaultHandling)
        for method in [NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest,
                       NSURLAuthenticationMethodNegotiate, NSURLAuthenticationMethodNTLM,
                       NSURLAuthenticationMethodClientCertificate, NSURLAuthenticationMethodDefault] {
            XCTAssertEqual(URLSessionTokenGrantClient.disposition(for: method), .cancelAuthenticationChallenge, method)
        }
    }

    func testARedirectIsRefusedAndNeverCarriesTheRefreshToken() async throws {
        let target = try LoopbackServer { _ in LoopbackServer.answer(200, #"{"access_token":"stolen"}"#) }
        defer { target.stop() }
        for status in [301, 302, 303, 307, 308] {
            let before = server.requests.count
            let location = "\(target.base)/stolen"
            server.answer { _ in LoopbackServer.answer(status, "", headers: ["Location: \(location)"]) }

            let answer = await client.grant(record(), deadline: deadline())

            XCTAssertEqual(answer, .failed, "\(status)")
            XCTAssertEqual(server.requests.count, before + 1, "\(status)")
        }
        XCTAssertEqual(target.requests.count, 0)
    }

    func testADroppedAnswerIsNotResent() async {
        server.answer { _ in [.drop] }

        let answer = await client.grant(record(), deadline: deadline())

        XCTAssertEqual(answer, .failed)
        XCTAssertEqual(server.requests.count, 1)
    }

    // MARK: Reading the body

    private func bodyOfBytes(_ size: Int) -> String {
        let start = #"{"access_token":"a1","pad":""#
        let end = #""}"#
        return start + String(repeating: "x", count: size - start.utf8.count - end.utf8.count) + end
    }

    func testABodyUpToTheCapIsRead() async {
        let answer = await grantAnswering(200, bodyOfBytes(64 * 1024))
        XCTAssertEqual(answer, .tokens(accessToken: "a1", refreshToken: nil, expiresIn: nil))
    }

    func testABodyOverTheCapIsTransient() async {
        let answer = await grantAnswering(200, bodyOfBytes(64 * 1024 + 1))
        XCTAssertEqual(answer, .failed)
    }

    func testACompleteAnswerThatRunsOverTheCapIsTransient() async {
        let answer = await grantAnswering(200, #"{"access_token":"a1"}"# + String(repeating: " ", count: 64 * 1024))
        XCTAssertEqual(answer, .failed)
    }

    func testATricklingBodyStopsWhenTheGraceEnds() async {
        server.answer { _ in
            [LoopbackServer.openEnded()] + Array(repeating: [.send(" "), .wait(0.1)], count: 100).flatMap { $0 }
                + [.send(#"{"access_token":"a1"}"#)]
        }
        let started = Date()

        let answer = await client.grant(record(), deadline: deadline(0.3))

        XCTAssertEqual(answer, .failed)
        XCTAssertLessThan(Date().timeIntervalSince(started), stallBound)
    }

    func testASlowCompleteBodyPastTheGraceIsUsed() async {
        let start = Date()
        let spent = LockedState(false)
        let lateClient = URLSessionTokenGrantClient(configuration: .ephemeral, now: {
            spent.withLock { $0 } ? start.addingTimeInterval(24) : start
        })
        server.answer { _ in
            [LoopbackServer.openEnded(), .send(#"{"access_token":"a1","#), .wait(1),
             .run { spent.withLock { $0 = true } }, .send(#" "refresh_token":"r1"}"#), .wait(30)]
        }

        let answer = await lateClient.grant(record(), deadline: start.addingTimeInterval(20))

        XCTAssertEqual(answer, .tokens(accessToken: "a1", refreshToken: "r1", expiresIn: nil))
        XCTAssertLessThan(Date().timeIntervalSince(start), stallBound, "the clock ends the read, not the server")
    }

    func testABodyUnfinishedPastTheGraceIsTransient() async {
        let start = Date()
        let spent = LockedState(false)
        let lateClient = URLSessionTokenGrantClient(configuration: .ephemeral, now: {
            spent.withLock { $0 } ? start.addingTimeInterval(24) : start
        })
        server.answer { _ in
            [.run { spent.withLock { $0 = true } }, LoopbackServer.openEnded(), .send(#"{"access_token":"a1","#), .wait(30)]
        }

        let answer = await lateClient.grant(record(), deadline: start.addingTimeInterval(20))

        XCTAssertEqual(answer, .failed)
        XCTAssertLessThan(Date().timeIntervalSince(start), stallBound, "the clock ends the read, not the server")
    }

    /// The real clock: the answer's bytes straddle the deadline, and all of them still count.
    func testAnAnswerPastTheDeadlineIsUsedWithinTheGrace() async {
        server.answer { _ in
            [LoopbackServer.openEnded(), .send(#"{"access_token":"#), .wait(2), .send(#""a1","#), .wait(0.3),
             .send(#""refresh_token":"r1"}"#)]
        }
        let started = Date()

        let answer = await client.grant(record(), deadline: deadline(1))

        XCTAssertEqual(answer, .tokens(accessToken: "a1", refreshToken: "r1", expiresIn: nil))
        XCTAssertGreaterThan(Date().timeIntervalSince(started), 1)
    }

    /// A request URLProtocol never answers reports no bytes sent, as a connection still being made
    /// would, so the grace is not for it.
    func testNothingSentByTheDeadlineGetsNoGrace() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        StubURLProtocol.reset()
        let started = Date()

        let answer = await URLSessionTokenGrantClient(configuration: configuration).grant(record(), deadline: deadline(0.3))

        XCTAssertEqual(answer, .failed)
        XCTAssertLessThan(Date().timeIntervalSince(started), TokenBudgets.grace - 0.5)
    }

    func testARevocationGetsNoGraceAndAStallCannotLeaveTheRefreshTokenLive() async throws {
        server.answer { _ in [.wait(30)] }
        let started = Date()

        let revoked = await client.revoke(record(), deadline: deadline(0.3))

        XCTAssertFalse(revoked)
        XCTAssertLessThan(Date().timeIntervalSince(started), TokenBudgets.grace - 0.5)
        XCTAssertEqual(server.requests.count, 1)
        XCTAssertTrue(try XCTUnwrap(server.requests.first).form.contains("token=r0"))
    }

    func testAClockStepBackCannotMakeAHugeTimeout() {
        let now = Date()

        XCTAssertEqual(URLSessionTokenGrantClient.window(until: now.addingTimeInterval(3_600), from: now), TokenBudgets.longestLifetime)
        XCTAssertEqual(URLSessionTokenGrantClient.window(until: now.addingTimeInterval(8), from: now), 8)
        XCTAssertLessThan(URLSessionTokenGrantClient.window(until: now.addingTimeInterval(-1), from: now), 0)
    }

    func testACompleteBodyWhoseEndNeverArrivesIsUsed() async {
        server.answer { _ in
            [LoopbackServer.openEnded(), .send(#"{"access_token":"a1"}"#), .wait(30)]
        }
        let started = Date()

        let answer = await client.grant(record(), deadline: deadline(2))

        XCTAssertEqual(answer, .tokens(accessToken: "a1", refreshToken: nil, expiresIn: nil))
        XCTAssertLessThan(Date().timeIntervalSince(started), stallBound)
    }

    func testARefusalWhoseEndNeverArrivesIsStillARefusal() async {
        server.answer { _ in
            [LoopbackServer.openEnded(400), .send(#"{"error":"invalid_grant"}"#), .wait(30)]
        }

        let answer = await client.grant(record(), deadline: deadline(2))

        XCTAssertEqual(answer, .refused)
    }

    func testAHostileBodyIsTransient() async {
        let open = String(repeating: "[", count: 30_000)
        let close = String(repeating: "]", count: 30_000)
        let bodies = [
            #"{"access_token":"a1","x":"# + String(repeating: "[", count: 60_000),
            #"{"access_token":"a1","x":"# + open + close + "}",
            String(repeating: #"{"a":"#, count: 12_000),
        ]
        for status in [200, 400] {
            for body in bodies {
                let answer = await grantAnswering(status, body)
                XCTAssertEqual(answer, .failed, "\(status)")
            }
        }
    }

    func testABodyNestedPastTheLimitIsNeverParsedButAStringOfBracketsIs() async {
        let nested = String(repeating: "[", count: 65) + String(repeating: "]", count: 65)
        let answer = await grantAnswering(200, #"{"access_token":"a1","x":\#(nested)}"#)
        XCTAssertEqual(answer, .failed)

        let allowed = String(repeating: "[", count: 63) + String(repeating: "]", count: 63)
        let deepest = await grantAnswering(200, #"{"access_token":"a1","x":\#(allowed)}"#)
        XCTAssertEqual(deepest, .tokens(accessToken: "a1", refreshToken: nil, expiresIn: nil))

        let brackets = String(repeating: "{[", count: 1_000)
        let inAString = await grantAnswering(200, #"{"access_token":"a\\\"\#(brackets)"}"#)
        XCTAssertEqual(inAString, .tokens(accessToken: #"a\""# + brackets, refreshToken: nil, expiresIn: nil))
    }

    /// U+2200 is the byte 0x22 in UTF-16, so a scan reading quotes byte by byte would think the
    /// deep objects sit inside a string, and the parser, which accepts UTF-16, would recurse.
    func testADeepBodyDisguisedAsUTF16IsTransient() async throws {
        let text = "\"\u{2200}\":" + String(repeating: #"{"a":"#, count: 6_000)
        let bytes = try XCTUnwrap(("{" + text).data(using: .utf16LittleEndian))
        server.answer { _ in
            [.send(LoopbackServer.head(200, headers: ["Content-Length: \(bytes.count)"]) + "\r\n"), .sendBytes(bytes)]
        }

        let answer = await client.grant(record(), deadline: deadline())

        XCTAssertEqual(answer, .failed)
    }

    func testTheNestingGuardIsOpenToThePackage() {
        XCTAssertTrue(isSafeToParse(Data(#"{"a":[1]}"#.utf8)))
        XCTAssertFalse(isSafeToParse(Data(String(repeating: #"{"a":"#, count: 65).utf8)))
    }

    // MARK: Revocation

    func testRevokeSendsBothTokensWithHints() async throws {
        let revoked = await client.revoke(record(), deadline: deadline())

        XCTAssertTrue(revoked)
        XCTAssertEqual(server.requests.map(\.requestLine), ["POST /revoke HTTP/1.1", "POST /revoke HTTP/1.1"])
        XCTAssertEqual(
            try XCTUnwrap(server.requests.first).form.sorted(),
            ["client_id=c", "token=r0", "token_type_hint=refresh_token"])
        XCTAssertEqual(
            try XCTUnwrap(server.requests.last).form.sorted(),
            ["client_id=c", "token=a0", "token_type_hint=access_token"])
    }

    func testAnyTwoHundredAnswerIsRevoked() async {
        server.answer { _ in LoopbackServer.answer(204, "") }

        let revoked = await client.revoke(record(), deadline: deadline())

        XCTAssertTrue(revoked)
    }

    func testRevokeWithNoRefreshTokenSendsTheAccessToken() async {
        let revoked = await client.revoke(record(refreshToken: nil), deadline: deadline())

        XCTAssertTrue(revoked)
        XCTAssertEqual(server.requests.count, 1)
    }

    func testARefusedRevocationIsFalseAndStillTriesBothTokens() async {
        server.answer { request in
            LoopbackServer.answer(request.form.contains("token=a0") ? 503 : 200, "")
        }

        let revoked = await client.revoke(record(), deadline: deadline())

        XCTAssertFalse(revoked)
        XCTAssertEqual(server.requests.count, 2)
    }

    func testOnlyTheRefreshTokenFailingIsFalse() async {
        server.answer { request in
            LoopbackServer.answer(request.form.contains("token=r0") ? 503 : 200, "")
        }

        let revoked = await client.revoke(record(), deadline: deadline())

        XCTAssertFalse(revoked)
    }

    func testARedirectedRevocationIsFalse() async {
        let location = "\(server.base)/elsewhere"
        server.answer { _ in LoopbackServer.answer(302, "", headers: ["Location: \(location)"]) }

        let revoked = await client.revoke(record(), deadline: deadline())

        XCTAssertFalse(revoked)
        XCTAssertEqual(server.requests.map(\.requestLine), ["POST /revoke HTTP/1.1", "POST /revoke HTTP/1.1"])
    }

    func testRevokeWithoutAnEndpointSendsNothing() async {
        let noEndpoint = tokenRecord(tokenEndpoint: "\(server.base)/token", revocationEndpoint: nil)

        let revoked = await client.revoke(noEndpoint, deadline: deadline())

        XCTAssertFalse(revoked)
        XCTAssertEqual(server.requests.count, 0)
    }

    // MARK: Printing

    func testNoAnswerPrintsATokenByAnyRoute() {
        let secret = tokenRecord(accessToken: "secret-access", refreshToken: "secret-refresh")
        let answers: [Any] = [
            TokenGrantAnswer.tokens(accessToken: "secret-access", refreshToken: "secret-refresh", expiresIn: 300),
            TokenRefreshResult.current(secret), TokenRefreshResult.rotated(secret, unsaved: true), secret,
        ]
        for answer in answers {
            var dumped = ""
            dump(answer, to: &dumped)
            for printed in ["\(answer)", String(reflecting: answer), dumped] {
                XCTAssertFalse(printed.contains("secret"), printed)
            }
        }
    }
}

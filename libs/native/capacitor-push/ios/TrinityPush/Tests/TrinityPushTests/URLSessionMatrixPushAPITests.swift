import Foundation
import XCTest
@testable import TrinityPush

/// Answers every request from `reply`; a nil reply never answers, so the request times out.
/// A reply with a `location` redirects there instead, as a server's 3xx would.
final class StubURLProtocol: URLProtocol {
    struct Reply {
        var status: Int
        var body: String
        var location: String?

        init(_ status: Int, _ body: String, location: String? = nil) {
            self.status = status
            self.body = body
            self.location = location
        }
    }

    private struct State {
        var reply: (@Sendable (URLRequest) -> Reply?)?
        var requests: [URLRequest] = []
    }

    private static let state = LockedState(State())

    static var requests: [URLRequest] { state.withLock { $0.requests } }

    static func reset(reply: (@Sendable (URLRequest) -> Reply?)? = nil) {
        state.withLock { $0 = State(reply: reply) }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (reply, _) = Self.state.withLock { state -> ((@Sendable (URLRequest) -> Reply?)?, Void) in
            state.requests.append(request)
            return (state.reply, ())
        }
        guard let answer = reply?(request), let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: answer.status,
                  httpVersion: nil,
                  headerFields: answer.location.map { ["Location": $0] }
              )
        else { return }
        if let location = answer.location, let target = URL(string: location) {
            var redirected = URLRequest(url: target)
            redirected.setValue(request.value(forHTTPHeaderField: "Authorization"), forHTTPHeaderField: "Authorization")
            client?.urlProtocol(self, wasRedirectedTo: redirected, redirectResponse: response)
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A value behind a lock, for test doubles that URLSession and async code touch from
/// several threads.
final class LockedState<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) { self.value = value }

    func withLock<Result>(_ body: (inout Value) -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

private extension PushEventRead {
    var object: [String: Any]? {
        if case .event(let object) = self { return object }
        return nil
    }

    var isUnauthorized: Bool {
        if case .unauthorized = self { return true }
        return false
    }

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}

final class URLSessionMatrixPushAPITests: XCTestCase {
    private let account = HandoffAccount(homeserverUrl: "https://hs.example/", accessToken: "secret", sound: true)

    private func api() -> URLSessionMatrixPushAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSessionMatrixPushAPI(configuration: configuration)
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    func testEncodesEachIdAsOnePathSegment() {
        XCTAssertEqual(URLSessionMatrixPushAPI.segment("$abc+def/ghi"), "%24abc%2Bdef%2Fghi")
        XCTAssertEqual(URLSessionMatrixPushAPI.segment("!room:hs"), "%21room%3Ahs")
        XCTAssertEqual(URLSessionMatrixPushAPI.segment("@alice:hs"), "%40alice%3Ahs")
    }

    func testFetchesTheEventWithTheAccountsToken() async {
        StubURLProtocol.reset { _ in .init(200, #"{"type":"m.room.message","sender":"@a:hs"}"#) }

        let event = await api().event(account: account, roomId: "!room:hs", eventId: "$abc+def/ghi", deadline: Date().addingTimeInterval(5))

        XCTAssertEqual(event.object?["sender"] as? String, "@a:hs")
        XCTAssertEqual(
            StubURLProtocol.requests.first?.url?.absoluteString,
            "https://hs.example/_matrix/client/v3/rooms/%21room%3Ahs/event/%24abc%2Bdef%2Fghi"
        )
        XCTAssertEqual(StubURLProtocol.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
    }

    func testAFetchSeparatesUnauthorizedFromFailed() async {
        for body in [#"{"errcode":"M_UNKNOWN_TOKEN"}"#, "<html>Unauthorized</html>"] {
            StubURLProtocol.reset { _ in .init(401, body) }
            let event = await api().event(account: account, roomId: "!r:hs", eventId: "$e", deadline: Date().addingTimeInterval(5))
            XCTAssertTrue(event.isUnauthorized, body)
        }
        for status in [403, 404, 500] {
            StubURLProtocol.reset { _ in .init(status, #"{"errcode":"M_FORBIDDEN"}"#) }
            let event = await api().event(account: account, roomId: "!r:hs", eventId: "$e", deadline: Date().addingTimeInterval(5))
            XCTAssertTrue(event.isFailed, "\(status)")
        }
        StubURLProtocol.reset { _ in .init(200, "not json") }
        let unreadable = await api().event(account: account, roomId: "!r:hs", eventId: "$e", deadline: Date().addingTimeInterval(5))
        XCTAssertTrue(unreadable.isFailed)
        StubURLProtocol.reset { _ in nil }
        let noAnswer = await api().event(account: account, roomId: "!r:hs", eventId: "$e", deadline: Date().addingTimeInterval(0.3))
        XCTAssertTrue(noAnswer.isFailed)
    }

    /// A room member can send this, and JSONSerialization would die of it with a SIGBUS.
    func testADeeplyNestedEventFallsBackInsteadOfCrashing() async {
        StubURLProtocol.reset { _ in .init(200, String(repeating: #"{"a":"#, count: 20_000)) }
        let deadline = Date().addingTimeInterval(5)

        let event = await api().event(account: account, roomId: "!r:hs", eventId: "$e", deadline: deadline)
        let member = await api().memberDisplayName(account: account, roomId: "!r:hs", userId: "@a:hs", deadline: deadline)
        let room = await api().roomName(account: account, roomId: "!r:hs", deadline: deadline)

        XCTAssertTrue(event.isFailed)
        XCTAssertNil(member)
        XCTAssertNil(room)
    }

    func testGivesUpWhenTheBudgetRunsOut() async {
        StubURLProtocol.reset { _ in nil }
        let started = Date()

        let event = await api().event(account: account, roomId: "!r:hs", eventId: "$e", deadline: Date().addingTimeInterval(0.3))

        XCTAssertTrue(event.isFailed)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
    }

    func testSendsNothingOnceTheBudgetIsSpent() async {
        StubURLProtocol.reset { _ in .init(200, #"{"name":"Lobby"}"#) }

        let name = await api().roomName(account: account, roomId: "!r:hs", deadline: Date.distantPast)

        XCTAssertNil(name)
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testReadsAMissingDisplayNameAsNil() async {
        StubURLProtocol.reset { _ in .init(200, #"{"membership":"join","displayname":null}"#) }

        let name = await api().memberDisplayName(account: account, roomId: "!r:hs", userId: "@a:hs", deadline: Date().addingTimeInterval(5))

        XCTAssertNil(name)
    }

    func testRefusesRedirectsSoTheTokenStaysOnTheHomeserver() async {
        StubURLProtocol.reset { request in
            request.url?.host == "hs.example"
                ? .init(302, "", location: "https://elsewhere.example/steal")
                : .init(200, #"{"type":"m.room.message","sender":"@a:hs"}"#)
        }

        let event = await api().event(account: account, roomId: "!r:hs", eventId: "$e", deadline: Date().addingTimeInterval(5))

        XCTAssertTrue(event.isFailed)
        XCTAssertEqual(StubURLProtocol.requests.map { $0.url?.host }, ["hs.example"])
    }

    func testEncodesTheOtherIdsAsSingleSegmentsToo() async {
        StubURLProtocol.reset { _ in .init(200, #"{"displayname":"Carol"}"#) }

        let name = await api().memberDisplayName(
            account: account,
            roomId: "!ro/om+x:hs",
            userId: "@car/ol+x:hs",
            deadline: Date().addingTimeInterval(5)
        )

        XCTAssertEqual(name, "Carol")
        XCTAssertEqual(
            StubURLProtocol.requests.first?.url?.absoluteString,
            "https://hs.example/_matrix/client/v3/rooms/%21ro%2Fom%2Bx%3Ahs/state/m.room.member/%40car%2Fol%2Bx%3Ahs"
        )
    }

    func testSharesOneDeadlineAcrossReads() async {
        StubURLProtocol.reset { _ in nil }
        let deadline = Date().addingTimeInterval(0.3)
        let started = Date()

        let event = await api().event(account: account, roomId: "!r:hs", eventId: "$e", deadline: deadline)
        let name = await api().roomName(account: account, roomId: "!r:hs", deadline: deadline)

        XCTAssertTrue(event.isFailed)
        XCTAssertNil(name)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
    }
}


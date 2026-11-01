import Foundation
import Network
import XCTest
@testable import TrinityPush

/// The app and the notification process as two real processes (`token-lease-probe`) over one
/// account's lease and vault, against a local provider with no reuse tolerance. Two stand-ins:
/// `FileVault` for the keychain, and `FileHandoff` for `PushHandoffStore.account`. Modelled on matrix-rust-sdk's `test_cross_process_concurrent_refresh`,
/// `test_refresh_interrupted_by_suspension_does_not_sign_out` and the NSE's shared-store test.
final class TokenProcessRaceTests: XCTestCase {
    private let account = "@a:hs"
    private let firstAccess = "race-access-0"
    private let firstRefresh = "race-refresh-0"
    private var container: URL!
    private var provider: FakeProvider!
    private var probes: [Probe] = []

    override func setUpWithError() throws {
        signal(SIGPIPE, SIG_IGN)
        container = FileManager.default.temporaryDirectory.appendingPathComponent("race-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        provider = try FakeProvider()
        try seed()
    }

    override func tearDownWithError() throws {
        for probe in probes {
            let output = probe.finish()
            XCTAssertFalse(output.contains("race-"), "a probe printed a token")
        }
        probes = []
        provider.stop()
        try FileManager.default.removeItem(at: container)
    }

    /// Lock-then-read: whoever waits for the lease reads the new pair, and spends nothing.
    func testTheAppAndAPushRaceForOneRotation() throws {
        for round in 0..<8 {
            try seed()
            let app = try start("app", account, firstAccess)
            let push = try startPush()
            for side in [app, push] { XCTAssertEqual(side.line(), "ready") }

            for side in round.isMultiple(of: 2) ? [app, push] : [push, app] { side.say("go") }

            let answer = app.line()
            XCTAssertEqual(push.line(), "hello", "round \(round)")
            XCTAssertTrue(["rotated", "current"].contains(answer), "round \(round): \(answer)")
            XCTAssertEqual(provider.counts, .init(grants: 1), "round \(round)")
            let stored = try stored()
            XCTAssertEqual(stored.accessToken, "race-access-1", "round \(round)")
            XCTAssertEqual(stored.state, .active, "round \(round)")
        }
    }

    /// The other process rotated while this one sat idle with the old token, or before it started.
    func testAProcessHoldingAnOldTokenFindsTheRotatedPair() throws {
        let idle = try start("app", account, firstAccess)
        XCTAssertEqual(idle.line(), "ready")
        XCTAssertEqual(try render(with: startPush()), "hello")
        let rotated = try stored()

        idle.say("go")
        XCTAssertEqual(idle.line(), "current")
        let late = try start("app", account, firstAccess)
        XCTAssertEqual(late.line(), "ready")
        late.say("go")
        XCTAssertEqual(late.line(), "current")

        XCTAssertEqual(provider.counts, .init(grants: 1))
        XCTAssertEqual(try stored(), rotated)
    }

    /// The app froze holding the lease, before its read, for longer than the lease lasts. It must
    /// not send the token it was asked about, which the push has since spent.
    func testAnAppSuspendedHoldingTheLeaseFindsTheRotatedPair() throws {
        let app = try start("app", account, firstAccess, "0.2", "stop")
        XCTAssertEqual(app.line(), "ready")
        app.say("go")
        XCTAssertEqual(app.line(), "holding")

        XCTAssertEqual(try render(with: startPush()), "hello", "the push outwaits the lapsed lease")
        app.resume()

        XCTAssertEqual(app.line(), "current")
        XCTAssertEqual(provider.counts, .init(grants: 1))
        XCTAssertEqual(try stored().accessToken, "race-access-1")
    }

    /// The app froze after its grant reached the provider. A push can't know the token is spent,
    /// and sends it. This test has one push, but an app frozen for an hour with N pushes makes N
    /// spent sends. An app holding an unsaved pair leaves a spent pair in the vault, so pushes spend
    /// that too. Each refusal must cost nothing here: it is not recorded, the app's late answer is
    /// still kept, and the next push shows the text. A provider that revokes on reuse is untested.
    func testAnAppSuspendedMidGrantKeepsTheAccountSignedIn() throws {
        provider.holdAnswers()
        let app = try start("app", account, firstAccess, "0.2")
        XCTAssertEqual(app.line(), "ready")
        app.say("go")
        XCTAssertTrue(provider.waitForGrant(), "the app's grant never arrived")
        app.suspend()

        let push = try startPush()
        XCTAssertEqual(try render(with: push), "Open Trinity to read this message")
        XCTAssertEqual(try stored().state, .active, "only the app may record a refusal")

        app.resume()
        provider.releaseAnswers()

        XCTAssertEqual(app.line(), "rotated")
        XCTAssertEqual(provider.counts, .init(grants: 1, spentSends: 1))
        XCTAssertEqual(try stored().accessToken, "race-access-1")
        XCTAssertEqual(try render(with: push, ready: false), "hello")
    }

    /// iOS reuses a notification process, and the app rotates between its pushes. Nothing the
    /// process learned at the first push may stand in for the vault at the next.
    func testAReusedNotificationProcessReadsTheVaultAgain() throws {
        let push = try startPush()
        XCTAssertEqual(try render(with: push), "hello")
        let app = try start("app", account, "race-access-1")
        XCTAssertEqual(app.line(), "ready")
        app.say("go")
        XCTAssertEqual(app.line(), "rotated")
        let rotated = try stored()
        try store(rotated.rotated(rotated.accessToken, nil, expiresAt: Date(timeIntervalSince1970: 1)))

        XCTAssertEqual(try render(with: push, ready: false), "hello")

        XCTAssertEqual(provider.counts, .init(grants: 3))
        XCTAssertEqual(try stored().accessToken, "race-access-3")
    }

    // MARK: Helpers

    private var vaultFile: URL { container.appendingPathComponent("vault.json") }

    /// An expired pair, the one the provider will take.
    private func seed() throws {
        provider.reset(access: firstAccess, refresh: firstRefresh)
        try store(TokenRecord(
            accessToken: firstAccess, refreshToken: firstRefresh, expiresAt: Date(timeIntervalSince1970: 1),
            tokenEndpoint: provider.url.appendingPathComponent("token").absoluteString, revocationEndpoint: nil,
            clientId: "c", deviceId: "D", lineage: "L", state: .active))
    }

    private func store(_ record: TokenRecord) throws {
        try JSONEncoder().encode(record).write(to: vaultFile, options: .atomic)
    }

    private func stored() throws -> TokenRecord {
        try JSONDecoder().decode(TokenRecord.self, from: Data(contentsOf: vaultFile))
    }

    private func start(_ role: String, _ arguments: String...) throws -> Probe {
        let probe = try Probe(role: role, container: container, arguments: arguments)
        probes.append(probe)
        return probe
    }

    private func startPush() throws -> Probe {
        try start("push", account, provider.url.absoluteString)
    }

    private func render(with push: Probe, ready: Bool = true) throws -> String {
        if ready { XCTAssertEqual(push.line(), "ready") }
        push.say("go")
        return push.line()
    }
}

/// One `token-lease-probe` process, spoken to a line at a time.
final class Probe {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private var buffered = Data()

    init(role: String, container: URL, arguments: [String]) throws {
        let bundle = try XCTUnwrap(Bundle.allBundles.first { $0.bundlePath.hasSuffix(".xctest") })
        process.executableURL = bundle.bundleURL.deletingLastPathComponent().appendingPathComponent("token-lease-probe")
        process.arguments = [role, container.path] + arguments
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        // A hung probe then answers with nothing, which fails the test instead of hanging it. Only
        // SIGKILL ends a stopped one.
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + 60) { [process] in
            if process.isRunning { kill(pid, SIGKILL) }
        }
    }

    func say(_ line: String) {
        try? input.fileHandleForWriting.write(contentsOf: Data((line + "\n").utf8))
    }

    /// The next line it prints; empty once it has exited.
    func line() -> String {
        while true {
            if let end = buffered.firstIndex(of: UInt8(ascii: "\n")) {
                let line = String(decoding: buffered[..<end], as: UTF8.self)
                buffered.removeSubrange(...end)
                return line
            }
            let more = output.fileHandleForReading.availableData
            if more.isEmpty { return "" }
            buffered.append(more)
        }
    }

    func suspend() { kill(process.processIdentifier, SIGSTOP) }
    func resume() { kill(process.processIdentifier, SIGCONT) }

    /// Ends the process and answers everything it printed but was not read.
    func finish() -> String {
        try? input.fileHandleForWriting.close()
        if process.isRunning { kill(process.processIdentifier, SIGCONT) }
        let rest = output.fileHandleForReading.readDataToEndOfFile()
        let printed = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: buffered + rest + printed, as: UTF8.self)
    }
}

/// An OAuth provider with no reuse tolerance, spending a refresh token the moment it arrives, and
/// the one homeserver read a push makes. Plain HTTP on loopback; one request per connection.
private final class FakeProvider: @unchecked Sendable {
    struct Counts: Equatable {
        var grants = 0
        var spentSends = 0
        var staleBearers = 0
    }

    /// Long enough that the other process is running, and waiting for the lease, when it ends.
    private static let answerDelay: TimeInterval = 0.2

    private let queue = DispatchQueue(label: "fake-provider")
    private let listener: NWListener
    private let grantArrived = DispatchSemaphore(value: 0)
    private(set) var url: URL!
    private var access = ""
    private var refresh = ""
    private var generation = 0
    private var recorded = Counts()
    private var heldAnswers: [() -> Void]?

    var counts: Counts { queue.sync { recorded } }

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
        listener.newConnectionHandler = { [unowned self] connection in
            connection.start(queue: queue)
            read(connection, Data())
        }
        listener.start(queue: queue)
        XCTAssertEqual(ready.wait(timeout: .now() + 10), .success)
        url = URL(string: "http://127.0.0.1:\(try XCTUnwrap(listener.port).rawValue)")
    }

    func stop() { listener.cancel() }

    func reset(access: String, refresh: String) {
        queue.sync {
            self.access = access
            self.refresh = refresh
            generation = 0
            recorded = Counts()
        }
    }

    /// Grants are spent as usual, but their answers wait for `releaseAnswers`.
    func holdAnswers() { queue.sync { heldAnswers = [] } }

    func releaseAnswers() {
        queue.sync {
            heldAnswers?.forEach { $0() }
            heldAnswers = nil
        }
    }

    func waitForGrant() -> Bool { grantArrived.wait(timeout: .now() + 10) == .success }

    private func read(_ connection: NWConnection, _ received: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [self] data, _, _, error in
            let all = received + (data ?? Data())
            guard error == nil, !all.isEmpty else { return connection.cancel() }
            guard let request = Self.complete(all) else { return read(connection, all) }
            request.hasPrefix("POST") ? grant(connection, request) : homeserverRead(connection, request)
        }
    }

    /// The request as text once all of it has arrived.
    private static func complete(_ data: Data) -> String? {
        let text = String(decoding: data, as: UTF8.self)
        guard let end = text.range(of: "\r\n\r\n") else { return nil }
        let length = text[..<end.lowerBound].lowercased().components(separatedBy: "\r\n")
            .first { $0.hasPrefix("content-length:") }
            .flatMap { Int($0.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) } ?? 0
        return text[end.upperBound...].utf8.count >= length ? text : nil
    }

    private func grant(_ connection: NWConnection, _ request: String) {
        let form = request.components(separatedBy: "\r\n\r\n").last ?? ""
        guard form.components(separatedBy: "&").contains("refresh_token=\(refresh)") else {
            recorded.spentSends += 1
            return send(connection, 400, #"{"error":"invalid_grant"}"#)
        }
        generation += 1
        access = "race-access-\(generation)"
        refresh = "race-refresh-\(generation)"
        recorded.grants += 1
        let body = #"{"access_token":"\#(access)","refresh_token":"\#(refresh)","expires_in":300}"#
        let reply = { [self] in send(connection, 200, body) }
        grantArrived.signal()
        if heldAnswers != nil {
            heldAnswers?.append(reply)
        } else {
            queue.asyncAfter(deadline: .now() + Self.answerDelay, execute: reply)
        }
    }

    private func homeserverRead(_ connection: NWConnection, _ request: String) {
        guard request.contains("Bearer \(access)\r\n") else {
            recorded.staleBearers += 1
            return send(connection, 401, #"{"errcode":"M_UNKNOWN_TOKEN"}"#)
        }
        send(connection, 200, request.contains("m.room.member")
            ? #"{"displayname":"Alice"}"#
            : #"{"type":"m.room.message","sender":"@alice:hs","content":{"msgtype":"m.text","body":"hello"}}"#)
    }

    private func send(_ connection: NWConnection, _ status: Int, _ body: String) {
        let head = "HTTP/1.1 \(status) X\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in connection.cancel() })
    }
}

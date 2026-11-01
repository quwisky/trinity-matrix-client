import Foundation
import XCTest
@testable import TrinityPush

private let startOfTest = Date(timeIntervalSince1970: 1_000_000)

/// The contract's `R0`, with any field replaced.
func tokenRecord(
    accessToken: String = "a0", refreshToken: String? = "r0", expiresAt: Date? = startOfTest.addingTimeInterval(300),
    tokenEndpoint: String? = "https://op.example/token", revocationEndpoint: String? = "https://op.example/revoke",
    clientId: String? = "c", deviceId: String? = "D", lineage: String = "L", state: TokenState = .active
) -> TokenRecord {
    TokenRecord(
        accessToken: accessToken, refreshToken: refreshToken, expiresAt: expiresAt, tokenEndpoint: tokenEndpoint,
        revocationEndpoint: revocationEndpoint, clientId: clientId, deviceId: deviceId, lineage: lineage, state: state)
}

private final class FakeClock: @unchecked Sendable {
    private let date = LockedState(startOfTest)

    var now: Date { date.withLock { $0 } }

    func advance(_ seconds: TimeInterval) {
        date.withLock { $0 = $0.addingTimeInterval(seconds) }
    }
}

final class FakeVault: TokenVault, @unchecked Sendable {
    private struct State {
        var stored: TokenRecord?
        var unavailable = false
        var failedUpdates = 0
        var writes = 0
        var removeBeforeUpdate = false
        var writesFail = false
        var listed: [String]? = []
        var removalsFailing: Set<String> = []
        var removed: [String] = []
    }

    private let state: LockedState<State>

    init(_ stored: TokenRecord? = tokenRecord()) {
        state = LockedState(State(stored: stored))
    }

    var stored: TokenRecord? {
        get { state.withLock { $0.stored } }
        set { state.withLock { $0.stored = newValue } }
    }
    var unavailable: Bool {
        get { state.withLock { $0.unavailable } }
        set { state.withLock { $0.unavailable = newValue } }
    }
    var failedUpdates: Int {
        get { state.withLock { $0.failedUpdates } }
        set { state.withLock { $0.failedUpdates = newValue } }
    }
    var removeBeforeUpdate: Bool {
        get { state.withLock { $0.removeBeforeUpdate } }
        set { state.withLock { $0.removeBeforeUpdate = newValue } }
    }
    var writesFail: Bool {
        get { state.withLock { $0.writesFail } }
        set { state.withLock { $0.writesFail = newValue } }
    }
    var writes: Int { state.withLock { $0.writes } }
    var listed: [String]? {
        get { state.withLock { $0.listed } }
        set { state.withLock { $0.listed = newValue } }
    }
    var removalsFailing: Set<String> {
        get { state.withLock { $0.removalsFailing } }
        set { state.withLock { $0.removalsFailing = newValue } }
    }
    var removed: [String] { state.withLock { $0.removed } }

    func accounts() -> [String]? { listed }

    func read(_ userId: String) -> TokenVaultRead {
        state.withLock { state in
            if state.unavailable { return .unavailable }
            return state.stored.map { .record($0) } ?? .absent
        }
    }

    func write(_ record: TokenRecord, for userId: String) -> Bool {
        state.withLock { state in
            if state.writesFail { return false }
            state.stored = record
            state.writes += 1
            return true
        }
    }

    func update(_ record: TokenRecord, for userId: String) -> TokenVaultWrite {
        state.withLock { state in
            if state.failedUpdates > 0 {
                state.failedUpdates -= 1
                return .failed
            }
            if state.removeBeforeUpdate { state.stored = nil }
            guard state.stored != nil else { return .absent }
            state.stored = record
            return .written
        }
    }

    func remove(_ userId: String) -> Bool {
        state.withLock { state in
            if state.removalsFailing.contains(userId) { return false }
            state.removed.append(userId)
            state.stored = nil
            return true
        }
    }

    func removeAll() -> Bool { remove("") }
}

final class FakeLease: TokenLease, @unchecked Sendable {
    private struct State {
        var answer: LeaseAnswer = .taken
        var lapsed = false
        var onTake: @Sendable () -> Void = {}
        var waits: [TimeInterval] = []
        var lifetimes: [TimeInterval] = []
        var released: [String] = []
        var discarded: [String] = []
        var discardedAll = 0
    }

    enum LeaseAnswer {
        case taken, busy, unavailable
    }

    private let state = LockedState(State())

    var answer: LeaseAnswer {
        get { state.withLock { $0.answer } }
        set { state.withLock { $0.answer = newValue } }
    }
    var lapsed: Bool {
        get { state.withLock { $0.lapsed } }
        set { state.withLock { $0.lapsed = newValue } }
    }
    var onTake: @Sendable () -> Void {
        get { state.withLock { $0.onTake } }
        set { state.withLock { $0.onTake = newValue } }
    }
    var waits: [TimeInterval] { state.withLock { $0.waits } }
    var lifetimes: [TimeInterval] { state.withLock { $0.lifetimes } }
    var released: [String] { state.withLock { $0.released } }
    var discarded: [String] { state.withLock { $0.discarded } }
    var discardedAll: Int { state.withLock { $0.discardedAll } }

    func take(_ account: String, lifetime: TimeInterval, wait: TimeInterval) async -> LeaseTake {
        let hook = state.withLock { state -> @Sendable () -> Void in
            state.waits.append(wait)
            state.lifetimes.append(lifetime)
            return state.onTake
        }
        hook()
        return state.withLock { state in
            switch state.answer {
            case .taken: .taken(LeaseTicket(account: account, owner: "ticket\(state.waits.count)"))
            case .busy: .busy
            case .unavailable: .unavailable
            }
        }
    }

    func holds(_ ticket: LeaseTicket) -> Bool { !lapsed }

    func release(_ ticket: LeaseTicket) {
        state.withLock { $0.released.append(ticket.owner) }
    }

    func discard(_ ticket: LeaseTicket) {
        state.withLock { $0.discarded.append(ticket.owner) }
    }

    func discardAll() {
        state.withLock { $0.discardedAll += 1 }
    }
}

final class FakeClient: TokenGrantClient, @unchecked Sendable {
    private struct State {
        var answer = TokenGrantAnswer.tokens(accessToken: "a1", refreshToken: "r1", expiresIn: 300)
        var revokeAnswer = true
        var onGrant: @Sendable () async -> Void = {}
        var onRevoke: @Sendable () -> Void = {}
        var grants: [TokenRecord] = []
        var grantDeadlines: [Date] = []
        var revokes: [TokenRecord] = []
        var revokeDeadlines: [Date] = []
    }

    private let state = LockedState(State())

    var answer: TokenGrantAnswer {
        get { state.withLock { $0.answer } }
        set { state.withLock { $0.answer = newValue } }
    }
    var revokeAnswer: Bool {
        get { state.withLock { $0.revokeAnswer } }
        set { state.withLock { $0.revokeAnswer = newValue } }
    }
    var onGrant: @Sendable () async -> Void {
        get { state.withLock { $0.onGrant } }
        set { state.withLock { $0.onGrant = newValue } }
    }
    var onRevoke: @Sendable () -> Void {
        get { state.withLock { $0.onRevoke } }
        set { state.withLock { $0.onRevoke = newValue } }
    }
    var grants: [TokenRecord] { state.withLock { $0.grants } }
    var grantDeadlines: [Date] { state.withLock { $0.grantDeadlines } }
    var revokes: [TokenRecord] { state.withLock { $0.revokes } }
    var revokeDeadlines: [Date] { state.withLock { $0.revokeDeadlines } }

    func grant(_ record: TokenRecord, deadline: Date) async -> TokenGrantAnswer {
        let hook = state.withLock { state -> @Sendable () async -> Void in
            state.grants.append(record)
            state.grantDeadlines.append(deadline)
            return state.onGrant
        }
        await hook()
        return answer
    }

    func revoke(_ record: TokenRecord, deadline: Date) async -> Bool {
        let (hook, answer) = state.withLock { state -> (@Sendable () -> Void, Bool) in
            state.revokes.append(record)
            state.revokeDeadlines.append(deadline)
            return (state.onRevoke, state.revokeAnswer)
        }
        hook()
        return answer
    }
}

/// Counts callers of a real lease, so a test can tell the second caller has reached it.
private struct CountingLease: TokenLease {
    let lease: TokenLease
    let takes: LockedState<Int>

    func take(_ account: String, lifetime: TimeInterval, wait: TimeInterval) async -> LeaseTake {
        takes.withLock { $0 += 1 }
        return await lease.take(account, lifetime: lifetime, wait: wait)
    }

    func holds(_ ticket: LeaseTicket) -> Bool { lease.holds(ticket) }
    func release(_ ticket: LeaseTicket) { lease.release(ticket) }
    func discard(_ ticket: LeaseTicket) { lease.discard(ticket) }
    func discardAll() { lease.discardAll() }
}

final class TokenRefresherTests: XCTestCase {
    private let user = "@a:hs"
    private let budget: TimeInterval = 8
    private let r0 = tokenRecord()
    private let a1r1 = tokenRecord().rotated("a1", "r1", expiresAt: startOfTest.addingTimeInterval(300))
    private let r1Stored = tokenRecord(accessToken: "b1", refreshToken: "s1")
    private let r2Stored = tokenRecord(accessToken: "b2", refreshToken: "s2")

    private var clock: FakeClock!
    private var vault: FakeVault!
    private var lease: FakeLease!
    private var client: FakeClient!
    private var refresher: TokenRefresher!
    private var container: URL!

    override func setUpWithError() throws {
        clock = FakeClock()
        vault = FakeVault()
        lease = FakeLease()
        client = FakeClient()
        refresher = makeRefresher(lease: lease)
        container = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: container)
    }

    private func makeRefresher(lease: TokenLease) -> TokenRefresher {
        let clock = clock!
        return TokenRefresher(vault: vault, lease: lease, client: client, now: { clock.now })
    }

    /// A real lease on a temporary file, on the fake clock.
    private func realLease() -> AppGroupTokenLease {
        let clock = clock!
        return AppGroupTokenLease(containerURL: container, now: { clock.now })
    }

    private func refresh(_ tokenSeen: String = "a0") async -> TokenRefreshResult {
        await refresher.refresh(account: user, lineage: "L", tokenSeen: tokenSeen, budget: budget)
    }

    private func refreshForPush(_ tokenSeen: String = "a0") async -> TokenRefreshResult {
        await refresher.refreshForPush(account: user, tokenSeen: tokenSeen, budget: budget)
    }

    private func leaveAnUnsavedPair(file: StaticString = #filePath, line: UInt = #line) async {
        vault.failedUpdates = 1
        let result = await refresh()
        XCTAssertEqual(result, .rotated(a1r1, unsaved: true), file: file, line: line)
    }

    /// A test that never ends fails here, naming itself, rather than hanging the suite.
    private func finishing<Value: Sendable>(
        within seconds: TimeInterval = 20, _ body: @escaping @Sendable () async -> Value
    ) async throws -> Value {
        let answer = LockedState<Value?>(nil)
        let done = expectation(description: "finished")
        Task {
            let value = await body()
            answer.withLock { $0 = value }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: seconds)
        return try XCTUnwrap(answer.withLock { $0 })
    }

    // MARK: Taking the lease

    func testBusyPastTheBudgetSendsNothing() async {
        lease.answer = .busy

        let result = await refresh()

        XCTAssertEqual(result, .busy)
        XCTAssertEqual(lease.waits, [budget])
        XCTAssertEqual(client.grants.count, 0)
    }

    func testALeaseThePlatformRefusesIsTransientNotUnavailable() async {
        lease.answer = .unavailable

        let result = await refresh()

        XCTAssertEqual(result, .transient)
        XCTAssertEqual(client.grants.count, 0)
    }

    func testTheLeaseLastsTheBudgetAndTheMarginAndIsReleased() async {
        _ = await refresh()

        XCTAssertEqual(lease.lifetimes, [budget + TokenBudgets.leaseMargin])
        XCTAssertEqual(lease.released, ["ticket1"])
    }

    // MARK: The read under the lease

    func testAMissingRecordOrAnotherLineageIsGone() async {
        vault.stored = nil
        let missing = await refresh()
        XCTAssertEqual(missing, .gone)

        vault.stored = tokenRecord(lineage: "other")
        let other = await refresh()
        XCTAssertEqual(other, .gone)

        XCTAssertEqual(client.grants.count, 0)
    }

    func testAKeychainFaultIsTransientNeverGone() async {
        vault.unavailable = true

        let result = await refresh()

        XCTAssertEqual(result, .transient)
        XCTAssertEqual(client.grants.count, 0)
    }

    func testARefusedRecordIsRefusedWithoutAGrant() async {
        vault.stored = r0.marked(.refused)

        let result = await refresh()

        XCTAssertEqual(result, .refused)
        XCTAssertEqual(client.grants.count, 0)
    }

    func testAnAlreadyRotatedTokenIsCurrentWithoutAGrant() async {
        let result = await refresh("old")

        XCTAssertEqual(result, .current(r0))
        XCTAssertEqual(client.grants.count, 0)
    }

    func testNoRefreshTokenOrEndpointIsUnavailable() async {
        for incomplete in [tokenRecord(refreshToken: nil), tokenRecord(tokenEndpoint: nil), tokenRecord(clientId: nil)] {
            vault.stored = incomplete

            let result = await refresh()

            XCTAssertEqual(result, .unavailable)
        }
        XCTAssertEqual(client.grants.count, 0)
    }

    func testTheGrantUsesWhatWasReadUnderTheLease() async {
        lease.onTake = { [vault = vault!] in vault.stored = tokenRecord(refreshToken: "r1") }

        _ = await refresh()

        XCTAssertEqual(client.grants.map(\.refreshToken), ["r1"])
    }

    func testTheGrantIsBoundedByTheBudget() async {
        _ = await refresh()

        XCTAssertEqual(client.grantDeadlines, [clock.now.addingTimeInterval(budget)])
    }

    // MARK: A grant with tokens

    func testSuccessWritesThePair() async {
        // The expiry counts from the send: the token's lifetime began before the answer came back.
        client.onGrant = { [clock = clock!] in clock.advance(5) }

        let result = await refresh()

        XCTAssertEqual(result, .rotated(a1r1, unsaved: false))
        XCTAssertEqual(vault.stored, a1r1)
    }

    func testANoRotationAnswerKeepsTheOldRefreshToken() async {
        client.answer = .tokens(accessToken: "a1", refreshToken: nil, expiresIn: nil)

        _ = await refresh()

        XCTAssertEqual(vault.stored?.refreshToken, "r0")
        XCTAssertNil(vault.stored?.expiresAt)
    }

    func testAFailedGrantIsTransientAndKeepsTheSpentToken() async {
        client.answer = .failed

        let result = await refresh()

        XCTAssertEqual(result, .transient)
        XCTAssertEqual(vault.stored, r0)
    }

    func testALateAnswerIsDiscardedWhenAnotherProcessRotated() async {
        client.onGrant = { [vault = vault!, r2Stored] in vault.stored = r2Stored }

        let result = await refresh()

        XCTAssertEqual(result, .current(r2Stored))
        XCTAssertEqual(vault.stored, r2Stored)
    }

    func testALateAnswerDoesNotResurrectARemovedRecord() async {
        client.onGrant = { [vault = vault!] in vault.stored = nil }

        let result = await refresh()

        XCTAssertEqual(result, .gone)
        XCTAssertNil(vault.stored)
    }

    func testALateAnswerNeverOverwritesANewerSignIn() async {
        let newer = tokenRecord(lineage: "L2")
        client.onGrant = { [vault = vault!] in vault.stored = newer }

        let result = await refresh()

        XCTAssertEqual(result, .gone)
        XCTAssertEqual(vault.stored, newer)
    }

    func testARecordRemovedAtTheWriteIsGone() async {
        vault.removeBeforeUpdate = true

        let result = await refresh()

        XCTAssertEqual(result, .gone)
        XCTAssertNil(vault.stored)
    }

    func testAnUnreadableStoreAfterAGrantKeepsThePairUnsaved() async {
        client.onGrant = { [vault = vault!] in vault.unavailable = true }

        let result = await refresh()

        XCTAssertEqual(result, .rotated(a1r1, unsaved: true))
    }

    // MARK: A write that fails

    func testAWriteFailureIsUnsavedAndTheStoredPairStays() async {
        vault.failedUpdates = 1

        let result = await refresh()

        XCTAssertEqual(result, .rotated(a1r1, unsaved: true))
        XCTAssertEqual(vault.stored, r0)
    }

    func testTheNextCallRetriesAnUnsavedWrite() async {
        await leaveAnUnsavedPair()

        _ = await refresher.current(account: user, lineage: "L")

        XCTAssertEqual(vault.stored, a1r1)
    }

    func testCurrentAnswersWithAnUnsavedPair() async {
        await leaveAnUnsavedPair()
        vault.failedUpdates = 1

        let result = await refresher.current(account: user, lineage: "L")

        XCTAssertEqual(result, .current(a1r1))
        XCTAssertEqual(vault.stored, r0)
    }

    func testCurrentAnswersWithAnUnsavedPairWhenTheLeaseIsBusy() async {
        await leaveAnUnsavedPair()
        lease.answer = .busy

        let result = await refresher.current(account: user, lineage: "L")

        XCTAssertEqual(result, .current(a1r1))
        XCTAssertEqual(lease.waits.last, TokenBudgets.removalWait)
        XCTAssertEqual(vault.stored, r0)
    }

    func testCurrentIgnoresAnUnsavedPairOfAnotherLineage() async {
        await leaveAnUnsavedPair()
        vault.failedUpdates = 1

        let result = await refresher.current(account: user, lineage: "other")

        XCTAssertEqual(result, .gone)
    }

    func testCurrentReleasesALeaseItTookToFlush() async {
        await leaveAnUnsavedPair()

        _ = await refresher.current(account: user, lineage: "L")

        XCTAssertEqual(lease.released, ["ticket1", "ticket2"])
        XCTAssertEqual(lease.lifetimes.last, TokenBudgets.leaseMargin)
    }

    func testCurrentWithNothingUnsavedTakesNoLease() async {
        _ = await refresher.current(account: user, lineage: "L")

        XCTAssertEqual(lease.waits, [])
    }

    func testCurrentReadsTheStore() async {
        let current = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(current, .current(r0))
        let other = await refresher.current(account: user, lineage: "other")
        XCTAssertEqual(other, .gone)

        vault.stored = r0.marked(.refused)
        let refused = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(refused, .refused)

        vault.unavailable = true
        let fault = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(fault, .transient)

        vault.unavailable = false
        vault.stored = nil
        let missing = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(missing, .gone)
    }

    func testAnUnsavedPairStillRefreshesWhenWritesKeepFailing() async {
        await leaveAnUnsavedPair()
        vault.failedUpdates = 2
        client.answer = .tokens(accessToken: "a2", refreshToken: "r2", expiresIn: nil)

        let result = await refresh("a1")

        XCTAssertEqual(client.grants.last?.refreshToken, "r1")
        XCTAssertEqual(result, .rotated(a1r1.rotated("a2", "r2", expiresAt: nil), unsaved: true))
        XCTAssertEqual(vault.stored, r0)

        // The second unsaved pair still sits on what is stored, so it lands once writes work.
        _ = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(vault.stored, a1r1.rotated("a2", "r2", expiresAt: nil))
    }

    func testAnUnsavedPairIsDroppedWhenAnotherProcessRotated() async {
        await leaveAnUnsavedPair()
        vault.stored = r1Stored

        let refreshed = await refresh("a1")
        XCTAssertEqual(refreshed, .current(r1Stored))

        let current = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(current, .current(r1Stored))
        XCTAssertEqual(vault.stored, r1Stored)
    }

    func testAnUnsavedPairIsDroppedWhenTheRecordWasRemoved() async {
        await leaveAnUnsavedPair()
        vault.stored = nil

        let current = await refresher.current(account: user, lineage: "L")

        XCTAssertEqual(current, .gone)
        XCTAssertNil(vault.stored)
    }

    /// The pair is the same: only the lineage tells the two sign-ins apart.
    func testAnUnsavedPairIsNeverWrittenOverANewerSignIn() async {
        await leaveAnUnsavedPair()
        let newer = tokenRecord(lineage: "L2")
        vault.stored = newer

        let refreshed = await refresh("a1")

        XCTAssertEqual(refreshed, .gone)
        XCTAssertEqual(vault.stored, newer)
    }

    func testAnUnsavedPairSurvivesAnUnreadableStore() async {
        await leaveAnUnsavedPair()
        vault.unavailable = true

        let current = await refresher.current(account: user, lineage: "L")

        XCTAssertEqual(current, .current(a1r1))
    }

    func testASavedRotationClearsTheUnsavedPair() async {
        await leaveAnUnsavedPair()
        vault.failedUpdates = 1 // fails the flush; the rotation's own write then lands
        client.answer = .tokens(accessToken: "a2", refreshToken: "r2", expiresIn: nil)
        let saved = a1r1.rotated("a2", "r2", expiresAt: nil)

        let refreshed = await refresh("a1")
        XCTAssertEqual(refreshed, .rotated(saved, unsaved: false))
        lease.answer = .busy

        let current = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(current, .current(saved))
    }

    // MARK: A lapsed lease and tokens in hand

    func testALapsedLeaseIsRetakenBeforeTheCompare() async {
        client.onGrant = { [lease = lease!, vault = vault!, r2Stored] in
            lease.lapsed = true
            lease.onTake = { vault.stored = r2Stored }
        }

        let result = await refresh()

        XCTAssertEqual(result, .current(r2Stored))
        XCTAssertEqual(vault.stored, r2Stored)
        XCTAssertEqual(lease.waits.count, 2)
        XCTAssertEqual(lease.released, ["ticket2"])
    }

    func testAHeldLeaseIsNotRetaken() async {
        _ = await refresh()

        XCTAssertEqual(lease.waits.count, 1)
    }

    func testARetakeWaitsWhatIsLeftOfTheDeadline() async {
        client.onGrant = { [lease = lease!, clock = clock!] in
            lease.lapsed = true
            clock.advance(3)
        }

        _ = await refresh()

        XCTAssertEqual(lease.waits, [budget, 5])
        XCTAssertEqual(lease.lifetimes.last, 5 + TokenBudgets.leaseMargin)
    }

    func testARetakeWaitsAtLeastTheFloorOnceTheDeadlineIsSpent() async {
        client.onGrant = { [lease = lease!, clock = clock!] in
            lease.lapsed = true
            clock.advance(100)
        }

        _ = await refresh()

        XCTAssertEqual(lease.waits, [budget, 1])
    }

    /// Dropping good tokens spends the old refresh token, and the next refresh is refused.
    func testTokensWithABusyRetakeStillCompareAndWrite() async {
        lapse(retake: .busy)

        let result = await refresh()

        XCTAssertEqual(result, .rotated(a1r1, unsaved: false))
        XCTAssertEqual(vault.stored, a1r1)
        XCTAssertEqual(lease.released, ["ticket1"], "the first ticket is all it has")
    }

    func testTokensWithAnUnavailableRetakeStillCompareAndWrite() async {
        lapse(retake: .unavailable)

        let result = await refresh()

        XCTAssertEqual(result, .rotated(a1r1, unsaved: false))
        XCTAssertEqual(vault.stored, a1r1)
    }

    private func lapse(retake: FakeLease.LeaseAnswer) {
        client.onGrant = { [lease = lease!] in
            lease.lapsed = true
            lease.answer = retake
        }
    }

    func testTokensWithABusyRetakeDiscardWhenAnotherProcessRotated() async {
        client.onGrant = { [lease = lease!, vault = vault!, r2Stored] in
            lease.lapsed = true
            lease.answer = .busy
            vault.stored = r2Stored
        }

        let result = await refresh()

        XCTAssertEqual(result, .current(r2Stored))
        XCTAssertEqual(vault.stored, r2Stored)
    }

    func testTokensWithABusyRetakeNeverOverwriteANewerSignIn() async {
        let newer = tokenRecord(lineage: "L2")
        client.onGrant = { [lease = lease!, vault = vault!] in
            lease.lapsed = true
            lease.answer = .busy
            vault.stored = newer
        }

        let result = await refresh()

        XCTAssertEqual(result, .gone)
        XCTAssertEqual(vault.stored, newer)
    }

    func testTokensWithABusyRetakeAndAFailedWriteAreUnsaved() async {
        lapse(retake: .busy)
        vault.failedUpdates = 1

        let result = await refresh()

        XCTAssertEqual(result, .rotated(a1r1, unsaved: true))
        XCTAssertEqual(vault.stored, r0)
    }

    // MARK: A refusal

    func testARefusalMarksRefused() async {
        client.answer = .refused

        let result = await refresh()

        XCTAssertEqual(result, .refused)
        XCTAssertEqual(vault.stored?.state, .refused)
        XCTAssertEqual(vault.stored?.accessToken, "a0")
    }

    func testAnAppRefusalAfterALapsedLeaseIsTransient() async {
        client.answer = .refused
        client.onGrant = { [lease = lease!] in lease.lapsed = true }

        let result = await refresh()

        XCTAssertEqual(result, .transient)
        XCTAssertEqual(vault.stored?.state, .active)
        XCTAssertEqual(lease.waits.count, 1, "a lapse answers before any retake")
    }

    func testAPushRefusalIsNotRecorded() async {
        client.answer = .refused

        let refused = await refreshForPush()
        XCTAssertEqual(refused, .refused)
        XCTAssertEqual(vault.stored, r0)

        client.answer = .tokens(accessToken: "a1", refreshToken: "r1", expiresIn: 300)
        let later = await refresh()
        XCTAssertEqual(later, .rotated(a1r1, unsaved: false))
        XCTAssertEqual(vault.stored, a1r1)
    }

    func testAPushRefusalKeepsAnUnsavedPair() async {
        await leaveAnUnsavedPair()
        vault.failedUpdates = 2
        client.answer = .refused

        let refused = await refreshForPush("a1")
        XCTAssertEqual(refused, .refused)

        let current = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(current, .current(a1r1))
    }

    func testAPushRefusalAfterALapsedLeaseIsRetakenBeforeTheCompare() async {
        client.answer = .refused
        client.onGrant = { [lease = lease!, vault = vault!, r2Stored] in
            lease.lapsed = true
            lease.onTake = { vault.stored = r2Stored }
        }

        let result = await refreshForPush()

        XCTAssertEqual(result, .current(r2Stored))
        XCTAssertEqual(vault.stored, r2Stored)
        XCTAssertEqual(lease.released, ["ticket2"])
    }

    func testAPushRefusalWhoseLeaseCannotBeRetakenIsTransient() async {
        client.answer = .refused
        client.onGrant = { [lease = lease!] in
            lease.lapsed = true
            lease.answer = .busy
        }

        let result = await refreshForPush()

        XCTAssertEqual(result, .transient)
        XCTAssertEqual(vault.stored, r0)
    }

    func testARefusalClearsTheUnsavedPair() async {
        await leaveAnUnsavedPair()
        vault.failedUpdates = 1 // fails the flush; the refusal's own mark then lands
        client.answer = .refused

        let refused = await refresh("a1")
        XCTAssertEqual(refused, .refused)
        XCTAssertEqual(vault.stored?.state, .refused)

        let again = await refresh("a1")
        XCTAssertEqual(again, .refused)
        XCTAssertEqual(vault.stored?.state, .refused)
        XCTAssertEqual(client.grants.count, 2, "the second answer came from the record, not a grant")
    }

    func testARefusalAfterAnotherProcessRotatedIsCurrent() async {
        client.answer = .refused
        client.onGrant = { [vault = vault!, r1Stored] in vault.stored = r1Stored }

        let result = await refresh()

        XCTAssertEqual(result, .current(r1Stored))
        XCTAssertEqual(vault.stored?.state, .active)
    }

    func testARefusalOfARemovedRecordIsGone() async {
        client.answer = .refused
        client.onGrant = { [vault = vault!] in vault.stored = nil }

        let result = await refresh()

        XCTAssertEqual(result, .gone)
        XCTAssertNil(vault.stored)
    }

    /// The pair is the same: only the lineage tells the two sign-ins apart.
    func testARefusalOfAnOlderSignInIsGoneAndMarksNothing() async {
        let newer = tokenRecord(lineage: "L2")
        client.answer = .refused
        client.onGrant = { [vault = vault!] in vault.stored = newer }

        let result = await refresh()

        XCTAssertEqual(result, .gone)
        XCTAssertEqual(vault.stored, newer)
    }

    func testARefusalThatCannotReadTheStoreIsTransient() async {
        client.answer = .refused
        client.onGrant = { [vault = vault!] in vault.unavailable = true }

        let result = await refresh()

        XCTAssertEqual(result, .transient)
    }

    // MARK: Two callers

    func testTwoConcurrentCallersShareOneGrant() async throws {
        let user = user
        let takes = LockedState(0)
        let shared = makeRefresher(lease: CountingLease(lease: realLease(), takes: takes))
        client.onGrant = {
            for _ in 0..<1_000 where takes.withLock({ $0 }) < 2 {
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
        }

        let results = try await finishing {
            async let first = shared.refresh(account: user, lineage: "L", tokenSeen: "a0", budget: 8)
            async let second = shared.refresh(account: user, lineage: "L", tokenSeen: "a0", budget: 8)
            return await [first, second]
        }

        XCTAssertEqual(client.grants.count, 1)
        XCTAssertEqual(results.filter { if case .rotated = $0 { true } else { false } }.count, 1)
        XCTAssertEqual(results.filter { if case .current = $0 { true } else { false } }.count, 1)
    }

    func testALapsedHolderDoesNotOverwriteAMigration() async throws {
        let user = user
        let holder = makeRefresher(lease: realLease())
        let newer = tokenRecord(accessToken: "a9", refreshToken: "r9", lineage: "L2")
        let migrated = LockedState(false)
        let lifetime = budget + TokenBudgets.leaseMargin
        client.onGrant = { [clock = clock!] in
            clock.advance(lifetime + 1)
            let stored = await holder.migrate(newer, for: user)
            migrated.withLock { $0 = stored }
        }

        let result = try await finishing {
            await holder.refresh(account: user, lineage: "L", tokenSeen: "a0", budget: 8)
        }

        XCTAssertTrue(migrated.withLock { $0 })
        XCTAssertEqual(result, .gone)
        XCTAssertEqual(vault.stored, newer)
    }

    func testRemovalDuringAGrantIsNotResurrected() async throws {
        let user = user
        let holder = makeRefresher(lease: realLease())
        client.onGrant = { _ = await holder.remove(account: user) }

        let result = try await finishing {
            await holder.refresh(account: user, lineage: "L", tokenSeen: "a0", budget: 8)
        }

        XCTAssertEqual(result, .gone)
        XCTAssertNil(vault.stored)
    }

    // MARK: The push path

    func testRefreshForPushUsesTheStoredLineage() async {
        vault.stored = tokenRecord(lineage: "stored")

        let result = await refreshForPush()

        XCTAssertEqual(result, .rotated(tokenRecord(lineage: "stored").rotated("a1", "r1", expiresAt: a1r1.expiresAt), unsaved: false))
    }

    func testRefreshForPushWithNoRecordIsGone() async {
        vault.stored = nil

        let result = await refreshForPush()

        XCTAssertEqual(result, .gone)
        XCTAssertEqual(client.grants.count, 0)
    }

    func testRefreshForPushOnAStoreFaultIsTransient() async {
        vault.unavailable = true

        let result = await refreshForPush()

        XCTAssertEqual(result, .transient)
    }

    func testRefreshForPushUsesAnUnsavedPairInsteadOfAgainSendingASpentToken() async {
        vault.failedUpdates = 100
        _ = await refresh()

        let stale = await refreshForPush("a0")
        XCTAssertEqual(stale, .current(a1r1))

        client.answer = .tokens(accessToken: "a2", refreshToken: "r2", expiresIn: nil)
        _ = await refreshForPush("a1")

        XCTAssertEqual(client.grants.map(\.refreshToken), ["r0", "r1"])
    }

    // MARK: Migration

    func testMigrationWritesARecord() async {
        vault.stored = nil

        let stored = await refresher.migrate(r0, for: user)

        XCTAssertTrue(stored)
        XCTAssertEqual(vault.stored, r0)
        XCTAssertEqual(lease.waits, [TokenBudgets.appGrant])
        XCTAssertEqual(lease.lifetimes, [TokenBudgets.appGrant + TokenBudgets.leaseMargin])
        XCTAssertEqual(lease.released, ["ticket1"])
    }

    func testMigrationKeepsAStoredRefreshTokenOfTheSameLineage() async {
        vault.stored = a1r1

        let stored = await refresher.migrate(r0, for: user)

        XCTAssertTrue(stored)
        XCTAssertEqual(vault.stored, a1r1)
        XCTAssertEqual(vault.writes, 0)
    }

    func testMigrationReplacesARecordOfTheSameLineageWithNoRefreshToken() async {
        vault.stored = tokenRecord(refreshToken: nil)

        let stored = await refresher.migrate(r0, for: user)

        XCTAssertTrue(stored)
        XCTAssertEqual(vault.stored, r0)
    }

    func testMigrationReplacesAnotherLineage() async {
        let newer = tokenRecord(lineage: "L2")

        let stored = await refresher.migrate(newer, for: user)

        XCTAssertTrue(stored)
        XCTAssertEqual(vault.stored, newer)
    }

    func testMigrationOverAnotherDeviceRevokesTheOldPairBestEffort() async {
        let old = tokenRecord(deviceId: "OLD", lineage: "L1")
        let newer = tokenRecord(accessToken: "a9", refreshToken: "r9", lineage: "L2")
        vault.stored = old
        client.revokeAnswer = false
        let revoked = expectation(description: "revoked")
        client.onRevoke = { revoked.fulfill() }

        let stored = await refresher.migrate(newer, for: user)

        XCTAssertTrue(stored)
        await fulfillment(of: [revoked], timeout: 5)
        XCTAssertEqual(client.revokes, [old])
        XCTAssertEqual(client.revokeDeadlines, [clock.now.addingTimeInterval(TokenBudgets.revokeRequest)])
        XCTAssertEqual(vault.stored, newer)
    }

    func testMigrationOverAnotherDeviceWithNoRefreshTokenRevokesNothing() async {
        vault.stored = tokenRecord(refreshToken: nil, deviceId: "OLD", lineage: "L1")

        let (stored, revocation) = await refresher.migrateRevokingOverwritten(tokenRecord(lineage: "L2"), for: user)

        XCTAssertTrue(stored)
        XCTAssertNil(revocation)
    }

    func testMigrationOverTheSameDeviceRevokesNothing() async {
        let (stored, revocation) = await refresher.migrateRevokingOverwritten(tokenRecord(lineage: "L2"), for: user)

        XCTAssertTrue(stored)
        XCTAssertNil(revocation)
    }

    /// Revoking the old record would revoke the pair just stored.
    func testMigrationOfTheSamePairOverAnotherDeviceRevokesNothing() async {
        vault.stored = tokenRecord(deviceId: "OLD", lineage: "L1")

        let (stored, revocation) = await refresher.migrateRevokingOverwritten(tokenRecord(lineage: "L2"), for: user)

        XCTAssertTrue(stored)
        XCTAssertNil(revocation)
    }

    func testMigrationOverAnotherDeviceWithADifferentPairHandsBackItsRevocation() async {
        let old = tokenRecord(accessToken: "a8", refreshToken: "r8", deviceId: "OLD", lineage: "L1")
        vault.stored = old

        let (stored, revocation) = await refresher.migrateRevokingOverwritten(tokenRecord(lineage: "L2"), for: user)

        XCTAssertTrue(stored)
        await revocation?.value
        XCTAssertEqual(client.revokes, [old])
    }

    func testMigrationWhileTheKeychainIsUnavailableIsNotStored() async {
        vault.unavailable = true

        let stored = await refresher.migrate(tokenRecord(lineage: "L2"), for: user)

        XCTAssertFalse(stored)
        XCTAssertEqual(vault.writes, 0)
        XCTAssertEqual(lease.released, ["ticket1"])
    }

    func testAMigrationWhoseWriteFailsIsNotStoredAndRevokesNothing() async {
        vault.stored = tokenRecord(accessToken: "a8", refreshToken: "r8", deviceId: "OLD", lineage: "L1")
        vault.writesFail = true

        let (stored, revocation) = await refresher.migrateRevokingOverwritten(tokenRecord(lineage: "L2"), for: user)

        XCTAssertFalse(stored)
        XCTAssertNil(revocation)
        XCTAssertEqual(lease.released, ["ticket1"])
    }

    func testMigrationOnABusyLeaseIsNotStored() async {
        for answer in [FakeLease.LeaseAnswer.busy, .unavailable] {
            lease.answer = answer

            let stored = await refresher.migrate(tokenRecord(lineage: "L2"), for: user)

            XCTAssertFalse(stored)
            XCTAssertEqual(lease.waits.last, TokenBudgets.appGrant)
            XCTAssertEqual(vault.writes, 0)
        }
    }

    // MARK: Revocation and removal

    func testRevokeUsesThePinnedEndpointAndKeepsTheRecord() async {
        let result = await refresher.revoke(account: user, lineage: "L")

        XCTAssertEqual(result, .revoked)
        XCTAssertEqual(client.revokes, [r0])
        XCTAssertEqual(client.revokeDeadlines, [clock.now.addingTimeInterval(TokenBudgets.revokeRequest)])
        XCTAssertEqual(vault.stored, r0)
        XCTAssertEqual(lease.waits, [TokenBudgets.revokeWait])
        XCTAssertEqual(lease.lifetimes, [TokenBudgets.revokeRequest + TokenBudgets.leaseMargin])
        XCTAssertEqual(lease.released, ["ticket1"])
    }

    func testRevokeWithNoRecordOrEndpointOrOtherLineageIsGone() async {
        let other = await refresher.revoke(account: user, lineage: "other")
        XCTAssertEqual(other, .gone)

        vault.stored = tokenRecord(revocationEndpoint: nil)
        let noEndpoint = await refresher.revoke(account: user, lineage: "L")
        XCTAssertEqual(noEndpoint, .gone)

        vault.stored = tokenRecord(clientId: nil)
        let noClient = await refresher.revoke(account: user, lineage: "L")
        XCTAssertEqual(noClient, .gone)

        vault.stored = nil
        let missing = await refresher.revoke(account: user, lineage: "L")
        XCTAssertEqual(missing, .gone)

        XCTAssertEqual(client.revokes.count, 0)
    }

    func testRevokeFailureIsTransient() async {
        client.revokeAnswer = false
        let refused = await refresher.revoke(account: user, lineage: "L")
        XCTAssertEqual(refused, .transient)

        vault.unavailable = true
        let fault = await refresher.revoke(account: user, lineage: "L")
        XCTAssertEqual(fault, .transient)

        lease.answer = .busy
        let busy = await refresher.revoke(account: user, lineage: "L")
        XCTAssertEqual(busy, .transient)

        lease.answer = .unavailable
        let refusedLease = await refresher.revoke(account: user, lineage: "L")
        XCTAssertEqual(refusedLease, .transient)

        vault.unavailable = false
        XCTAssertEqual(vault.stored, r0)
    }

    func testRevokeFlushesAnUnsavedPairFirst() async {
        await leaveAnUnsavedPair()

        let result = await refresher.revoke(account: user, lineage: "L")

        XCTAssertEqual(result, .revoked)
        XCTAssertEqual(vault.stored, a1r1)
        XCTAssertEqual(client.revokes, [a1r1])
    }

    func testRevokeUsesAnUnsavedPairThatStillCannotBeWritten() async {
        await leaveAnUnsavedPair()
        vault.failedUpdates = 1

        let result = await refresher.revoke(account: user, lineage: "L")

        XCTAssertEqual(result, .revoked)
        XCTAssertEqual(vault.stored, r0)
        XCTAssertEqual(client.revokes, [a1r1])
    }

    func testRemoveDeletesEvenWhenTheLeaseStaysBusy() async {
        for answer in [FakeLease.LeaseAnswer.busy, .unavailable] {
            vault.stored = r0
            lease.answer = answer

            let removed = await refresher.remove(account: user)

            XCTAssertTrue(removed)
            XCTAssertNil(vault.stored)
            XCTAssertEqual(lease.waits.last, TokenBudgets.removalWait)
        }
    }

    func testRemoveDiscardsALeaseItTook() async {
        _ = await refresher.remove(account: user)

        XCTAssertEqual(lease.discarded, ["ticket1"])
        XCTAssertEqual(lease.released, [])
    }

    func testRemovingAnAccountThatNeverHadALeaseLeavesNoFile() async throws {
        let refresher = makeRefresher(lease: realLease())

        let removed = await refresher.remove(account: user)

        XCTAssertTrue(removed)
        let leases = container.appendingPathComponent("push-handoff/leases")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: leases.path), [])
    }

    func testRemoveDropsAnUnsavedPair() async {
        await leaveAnUnsavedPair()
        lease.answer = .busy

        _ = await refresher.remove(account: user)

        let current = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(current, .gone)
    }

    func testRemoveWithNoAccountDropsEverything() async {
        await leaveAnUnsavedPair()
        lease.answer = .busy

        let removed = await refresher.remove(account: nil)

        XCTAssertTrue(removed)
        XCTAssertNil(vault.stored)
        XCTAssertEqual(lease.discardedAll, 1)
        let current = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(current, .gone)
    }

    // MARK: Sweeping

    func testASweepRemovesOnlyTheUnlistedAccountsEachUnderItsLease() async {
        vault.listed = ["@a:hs", "@b:hs", "@c:hs"]

        let removed = await refresher.remove(except: ["@b:hs"])

        XCTAssertEqual(removed, 2)
        XCTAssertEqual(vault.removed, ["@a:hs", "@c:hs"])
        XCTAssertEqual(lease.waits, [TokenBudgets.removalWait, TokenBudgets.removalWait])
        XCTAssertEqual(lease.discarded, ["ticket1", "ticket2"])
    }

    func testASweepKeepingNothingRemovesEverything() async {
        vault.listed = ["@a:hs", "@b:hs"]

        let removed = await refresher.remove(except: [])

        XCTAssertEqual(removed, 2)
        XCTAssertEqual(vault.removed, ["@a:hs", "@b:hs"])
    }

    func testASweepWithNothingToRemoveAnswersZero() async {
        vault.listed = ["@a:hs"]

        let removed = await refresher.remove(except: ["@a:hs", "@b:hs"])

        XCTAssertEqual(removed, 0)
        XCTAssertEqual(vault.removed, [])
        XCTAssertEqual(lease.waits, [])
    }

    func testASweepThatCannotListRemovesNothing() async {
        vault.listed = nil

        let removed = await refresher.remove(except: [])

        XCTAssertNil(removed)
        XCTAssertEqual(vault.removed, [])
        XCTAssertEqual(lease.waits, [])
    }

    func testASweepTriesEveryAccountAndAnswersNilWhenARemovalFails() async {
        vault.listed = ["@a:hs", "@b:hs"]
        vault.removalsFailing = ["@a:hs"]

        let removed = await refresher.remove(except: [])

        XCTAssertNil(removed)
        XCTAssertEqual(vault.removed, ["@b:hs"])
    }

    func testASweepDropsARemovedAccountsUnsavedPair() async {
        await leaveAnUnsavedPair()
        vault.listed = [user]

        _ = await refresher.remove(except: [])

        let current = await refresher.current(account: user, lineage: "L")
        XCTAssertEqual(current, .gone)
    }

    func testAHostWithNoAppGroupHasNoRefresher() {
        XCTAssertNil(TokenRefresher.fromMainBundle())
    }
}

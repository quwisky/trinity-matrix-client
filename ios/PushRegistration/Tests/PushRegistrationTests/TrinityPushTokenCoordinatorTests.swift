import Foundation
import XCTest
@testable import PushRegistration

final class TrinityPushTokenCoordinatorTests: XCTestCase {
    private struct TestError: Error, Equatable {}

    func testDelegateBeforeAPNsIsIgnored() {
        var tokens: [String] = []
        let coordinator = makeCoordinator(emitToken: { tokens.append($0) })

        coordinator.didReceiveFCMToken("early")

        XCTAssertTrue(tokens.isEmpty)
    }

    func testAPNsIsMappedBeforeFCMFetch() {
        var events: [String] = []
        let coordinator = makeCoordinator(
            mapAPNs: { _ in events.append("map") },
            fetchFCM: { _ in events.append("fetch") }
        )
        coordinator.setAPNsToken(Data([1]))

        XCTAssertEqual(events, ["map", "fetch"])
    }

    func testSuccessfulNonemptyFCMTokenIsForwarded() {
        var completion: TrinityPushTokenCoordinator.FCMCompletion?
        var tokens: [String] = []
        let coordinator = makeCoordinator(
            fetchFCM: { completion = $0 },
            emitToken: { tokens.append($0) }
        )

        coordinator.setAPNsToken(Data([1]))
        completion?("fcm", nil)

        XCTAssertEqual(tokens, ["fcm"])
    }

    func testFCMErrorsEmptyAndNilAreSafe() {
        var completions: [TrinityPushTokenCoordinator.FCMCompletion] = []
        var failures: [Error] = []
        let coordinator = makeCoordinator(
            fetchFCM: { completions.append($0) },
            emitFailure: { failures.append($0) }
        )
        coordinator.setAPNsToken(Data([1]))
        completions[0](nil, TestError())
        coordinator.register()
        completions[1]("", nil)
        coordinator.register()
        completions[2](nil, nil)

        XCTAssertEqual(failures.count, 3)
    }

    func testRefreshSupersedesStaleFetchSuccessAndError() {
        var completions: [TrinityPushTokenCoordinator.FCMCompletion] = []
        var tokens: [String] = []
        var failures: [Error] = []
        let coordinator = makeCoordinator(
            fetchFCM: { completions.append($0) },
            emitToken: { tokens.append($0) },
            emitFailure: { failures.append($0) }
        )

        coordinator.setAPNsToken(Data([1]))
        coordinator.didReceiveFCMToken("refreshed")
        completions[0]("stale", nil)
        completions[0](nil, TestError())

        XCTAssertEqual(tokens, ["refreshed"])
        XCTAssertTrue(failures.isEmpty)
    }

    func testRegistrationAfterFailureFetchesCurrentTokenAndRecovers() {
        var completions: [TrinityPushTokenCoordinator.FCMCompletion] = []
        var tokens: [String] = []
        var failures: [Error] = []
        let coordinator = makeCoordinator(
            fetchFCM: { completions.append($0) },
            emitToken: { tokens.append($0) },
            emitFailure: { failures.append($0) }
        )

        coordinator.setAPNsToken(Data([1]))
        completions[0](nil, TestError())
        coordinator.register()
        completions[1]("recovered", nil)

        XCTAssertEqual(tokens, ["recovered"])
        XCTAssertEqual(failures.count, 1)
    }

    func testNewerAPNsFetchSupersedesOldFetch() {
        var mapped: [Data] = []
        var completions: [TrinityPushTokenCoordinator.FCMCompletion] = []
        var tokens: [String] = []
        let coordinator = makeCoordinator(
            mapAPNs: { mapped.append($0) },
            fetchFCM: { completions.append($0) },
            emitToken: { tokens.append($0) }
        )

        coordinator.setAPNsToken(Data([1]))
        coordinator.setAPNsToken(Data([2]))
        completions[0]("old", nil)
        completions[1]("new", nil)

        XCTAssertEqual(mapped, [Data([1]), Data([2])])
        XCTAssertEqual(tokens, ["new"])
    }

    func testRetryFetchesCurrentAPNsTokenAndReportsLatestError() {
        var requests = 0
        var mapped: [Data] = []
        var completions: [TrinityPushTokenCoordinator.FCMCompletion] = []
        var failures: [Error] = []
        let coordinator = makeCoordinator(
            requestAPNs: { requests += 1 },
            mapAPNs: { mapped.append($0) },
            fetchFCM: { completions.append($0) },
            emitFailure: { failures.append($0) }
        )

        coordinator.setAPNsToken(Data([3]))
        coordinator.register()
        completions[0](nil, TestError())
        completions[1](nil, TestError())

        XCTAssertEqual(requests, 1)
        XCTAssertEqual(mapped, [Data([3]), Data([3])])
        XCTAssertEqual(failures.count, 1)
    }

    func testRetryRequestsAPNsWhenNoCurrentTokenExists() {
        var requests = 0
        var fetches = 0
        let coordinator = makeCoordinator(
            requestAPNs: { requests += 1 },
            fetchFCM: { _ in fetches += 1 }
        )

        coordinator.register()

        XCTAssertEqual(requests, 1)
        XCTAssertEqual(fetches, 0)
    }

    func testOnlyFCMStringsAreEmitted() {
        var tokens: [String] = []
        let coordinator = makeCoordinator(emitToken: { tokens.append($0) })

        coordinator.setAPNsToken(Data([0, 255]))
        coordinator.didReceiveFCMToken("fcm")

        XCTAssertEqual(tokens, ["fcm"])
    }

    private func makeCoordinator(
        requestAPNs: @escaping () -> Void = {},
        mapAPNs: @escaping (Data) -> Void = { _ in },
        fetchFCM: @escaping (@escaping TrinityPushTokenCoordinator.FCMCompletion) -> Void = { $0(nil, nil) },
        emitToken: @escaping (String) -> Void = { _ in },
        emitFailure: @escaping (Error) -> Void = { _ in }
    ) -> TrinityPushTokenCoordinator {
        TrinityPushTokenCoordinator(
            requestAPNs: requestAPNs,
            mapAPNs: mapAPNs,
            fetchFCM: fetchFCM,
            emitToken: emitToken,
            emitFailure: emitFailure
        )
    }
}

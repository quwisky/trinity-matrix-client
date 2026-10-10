import XCTest
@testable import TrinityPush

/// The NotificationService extension's per-request delivery bookkeeping: iOS may hand one
/// extension instance overlapping requests, and each must reach the system exactly once with
/// its own content.
final class PushDeliveriesTests: XCTestCase {
    private final class Content {
        var title: String
        init(_ title: String) { self.title = title }
    }

    private final class Received: @unchecked Sendable {
        private let lock = NSLock()
        private var titles: [String] = []

        func handler(_ content: Content) {
            lock.lock()
            defer { lock.unlock() }
            titles.append(content.title)
        }

        var all: [String] {
            lock.lock()
            defer { lock.unlock() }
            return titles
        }
    }

    func testOverlappingRequestsKeepTheirOwnContentAndHandler() {
        let deliveries = PushDeliveries<Content>()
        let receivedA = Received()
        let receivedB = Received()
        let first = deliveries.begin(Content("A fallback"), handler: receivedA.handler)
        let second = deliveries.begin(Content("B fallback"), handler: receivedB.handler)

        first.update { $0.title = "A rendered" }
        second.finish()

        XCTAssertEqual(receivedB.all, ["B fallback"])
        XCTAssertEqual(receivedA.all, [])

        first.finish()

        XCTAssertEqual(receivedA.all, ["A rendered"])
        XCTAssertEqual(receivedB.all, ["B fallback"])
        XCTAssertEqual(deliveries.pendingCount, 0)
    }

    func testTimeRunningOutDeliversEveryPendingRequestOnceAndCancelsItsRendering() {
        let deliveries = PushDeliveries<Content>()
        let receivedA = Received()
        let receivedB = Received()
        let first = deliveries.begin(Content("A fallback"), handler: receivedA.handler)
        let second = deliveries.begin(Content("B fallback"), handler: receivedB.handler)
        let renderingA = Task<Void, Never> { try? await Task.sleep(nanoseconds: 60_000_000_000) }
        let renderingB = Task<Void, Never> { try? await Task.sleep(nanoseconds: 60_000_000_000) }
        first.track(renderingA)
        second.track(renderingB)

        deliveries.finishAll()
        first.update { $0.title = "A rendered too late" }
        first.finish()
        deliveries.finishAll()

        XCTAssertEqual(receivedA.all, ["A fallback"])
        XCTAssertEqual(receivedB.all, ["B fallback"])
        XCTAssertTrue(renderingA.isCancelled)
        XCTAssertTrue(renderingB.isCancelled)
        XCTAssertEqual(deliveries.pendingCount, 0)
    }

    func testAFinishedRequestLeavesTheOthersPending() {
        let deliveries = PushDeliveries<Content>()
        let received = Received()
        let first = deliveries.begin(Content("A"), handler: received.handler)
        _ = deliveries.begin(Content("B"), handler: received.handler)

        first.finish()

        XCTAssertEqual(deliveries.pendingCount, 1)
        deliveries.finishAll()
        XCTAssertEqual(received.all, ["A", "B"])
        XCTAssertEqual(deliveries.pendingCount, 0)
    }

    func testRenderingTrackedAfterDeliveryIsCancelled() {
        let deliveries = PushDeliveries<Content>()
        let delivery = deliveries.begin(Content("A"), handler: Received().handler)
        delivery.finish()
        let rendering = Task<Void, Never> { try? await Task.sleep(nanoseconds: 60_000_000_000) }

        delivery.track(rendering)

        XCTAssertTrue(rendering.isCancelled)
    }
}

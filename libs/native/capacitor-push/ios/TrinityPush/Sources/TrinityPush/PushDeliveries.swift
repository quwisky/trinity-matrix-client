import Foundation

/// One notification request's content on its way to the system. Rendering may change it while
/// it is pending; it is handed over exactly once, when rendering finishes or time runs out.
public final class PushDelivery<Content: AnyObject>: @unchecked Sendable {
    private let lock = NSLock()
    private var content: Content?
    private var handler: ((Content) -> Void)?
    private var rendering: Task<Void, Never>?
    private let onFinish: (PushDelivery<Content>) -> Void

    init(
        content: Content,
        handler: @escaping (Content) -> Void,
        onFinish: @escaping (PushDelivery<Content>) -> Void
    ) {
        self.content = content
        self.handler = handler
        self.onFinish = onFinish
    }

    /// Ties the rendering task to this delivery, so delivering early cancels it.
    public func track(_ task: Task<Void, Never>) {
        lock.lock()
        guard content != nil else {
            lock.unlock()
            task.cancel()
            return
        }
        rendering = task
        lock.unlock()
    }

    /// Changes the content while it is pending; does nothing once it was delivered.
    public func update(_ change: (Content) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        if let content { change(content) }
    }

    /// Hands the content to the system now; later calls do nothing.
    public func finish() {
        lock.lock()
        let content = self.content
        let handler = self.handler
        let rendering = self.rendering
        self.content = nil
        self.handler = nil
        self.rendering = nil
        lock.unlock()
        guard let content, let handler else { return }
        rendering?.cancel()
        onFinish(self)
        handler(content)
    }
}

/// The pending deliveries of one NotificationService instance. iOS may hand one instance
/// overlapping requests, so each request gets its own delivery, and time running out delivers
/// every pending one with whatever it holds.
public final class PushDeliveries<Content: AnyObject>: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [ObjectIdentifier: PushDelivery<Content>] = [:]

    public init() {}

    var pendingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return pending.count
    }

    /// Starts one request's delivery with its initial content.
    public func begin(_ content: Content, handler: @escaping (Content) -> Void) -> PushDelivery<Content> {
        let delivery = PushDelivery(content: content, handler: handler) { [weak self] finished in
            self?.remove(finished)
        }
        lock.lock()
        pending[ObjectIdentifier(delivery)] = delivery
        lock.unlock()
        return delivery
    }

    /// Delivers every pending request as it stands and cancels its rendering.
    public func finishAll() {
        lock.lock()
        let all = Array(pending.values)
        lock.unlock()
        all.forEach { $0.finish() }
    }

    private func remove(_ delivery: PushDelivery<Content>) {
        lock.lock()
        pending[ObjectIdentifier(delivery)] = nil
        lock.unlock()
    }
}

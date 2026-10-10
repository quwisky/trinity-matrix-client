import Foundation

/// The client-server reads the renderer makes; every failure reads as nil.
public protocol MatrixPushAPI {
    func event(account: HandoffAccount, roomId: String, eventId: String, deadline: Date) async -> [String: Any]?
    func memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Date) async -> String?
    func roomName(account: HandoffAccount, roomId: String, deadline: Date) async -> String?
}

/// Refuses every redirect, so the access token never follows one to another host. The 3xx
/// then reads as a failed fetch.
private final class RefusingRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

/// `MatrixPushAPI` over URLSession. Every read of a push shares one deadline: each request's
/// timeouts are what is left of it, nothing is sent once it is spent, and nothing is retried.
/// Redirects are refused. Logs nothing.
public struct URLSessionMatrixPushAPI: MatrixPushAPI {
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )
    private let configuration: URLSessionConfiguration

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        self.configuration = configuration
    }

    /// One percent-encoded path segment: `/`, `+`, `$`, `!`, `:` and `@` never reach a path raw.
    public static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    public func event(account: HandoffAccount, roomId: String, eventId: String, deadline: Date) async -> [String: Any]? {
        await get(account, path: "\(room(roomId))/event/\(Self.segment(eventId))", deadline: deadline)
    }

    public func memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Date) async -> String? {
        let member = await get(account, path: "\(room(roomId))/state/m.room.member/\(Self.segment(userId))", deadline: deadline)
        return PushRenderRules.nonBlank(member?["displayname"] as? String)
    }

    public func roomName(account: HandoffAccount, roomId: String, deadline: Date) async -> String? {
        let state = await get(account, path: "\(room(roomId))/state/m.room.name", deadline: deadline)
        return PushRenderRules.nonBlank(state?["name"] as? String)
    }

    private func room(_ roomId: String) -> String {
        "/_matrix/client/v3/rooms/\(Self.segment(roomId))"
    }

    private func get(_ account: HandoffAccount, path: String, deadline: Date) async -> [String: Any]? {
        let remaining = deadline.timeIntervalSinceNow
        var base = account.homeserverUrl
        while base.hasSuffix("/") { base.removeLast() }
        guard remaining > 0,
              let url = URL(string: base + path),
              let session = session(timeout: remaining)
        else { return nil }
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: remaining)
        request.setValue("Bearer \(account.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await session.data(for: request, delegate: RefusingRedirects()),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func session(timeout: TimeInterval) -> URLSession? {
        guard let copy = configuration.copy() as? URLSessionConfiguration else { return nil }
        copy.timeoutIntervalForRequest = timeout
        copy.timeoutIntervalForResource = timeout
        return URLSession(configuration: copy)
    }
}

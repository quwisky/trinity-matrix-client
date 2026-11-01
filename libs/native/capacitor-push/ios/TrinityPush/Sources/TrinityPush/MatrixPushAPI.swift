import Foundation

/// What reading an event answered. Only a 401 says the token itself was rejected.
public enum PushEventRead {
    case event([String: Any])
    case unauthorized
    case failed
}

/// The client-server reads the renderer makes. Every failed name read is nil.
public protocol MatrixPushAPI {
    func event(account: HandoffAccount, roomId: String, eventId: String, deadline: Date) async -> PushEventRead
    func memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Date) async -> String?
    func roomName(account: HandoffAccount, roomId: String, deadline: Date) async -> String?
}

/// Refuses every redirect, so the access token never follows one to another host. The 3xx
/// then reads as a failed fetch.
class RefusingRedirects: NSObject, URLSessionTaskDelegate {
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

    public func event(account: HandoffAccount, roomId: String, eventId: String, deadline: Date) async -> PushEventRead {
        await get(account, path: "\(room(roomId))/event/\(Self.segment(eventId))", deadline: deadline)
    }

    public func memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Date) async -> String? {
        let path = "\(room(roomId))/state/m.room.member/\(Self.segment(userId))"
        guard case .event(let member) = await get(account, path: path, deadline: deadline) else { return nil }
        return PushRenderRules.nonBlank(member["displayname"] as? String)
    }

    public func roomName(account: HandoffAccount, roomId: String, deadline: Date) async -> String? {
        let path = "\(room(roomId))/state/m.room.name"
        guard case .event(let state) = await get(account, path: path, deadline: deadline) else { return nil }
        return PushRenderRules.nonBlank(state["name"] as? String)
    }

    private func room(_ roomId: String) -> String {
        "/_matrix/client/v3/rooms/\(Self.segment(roomId))"
    }

    private func get(_ account: HandoffAccount, path: String, deadline: Date) async -> PushEventRead {
        let remaining = deadline.timeIntervalSinceNow
        var base = account.homeserverUrl
        while base.hasSuffix("/") { base.removeLast() }
        guard remaining > 0,
              let url = URL(string: base + path),
              let session = session(timeout: remaining)
        else { return .failed }
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: remaining)
        request.setValue("Bearer \(account.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await session.data(for: request, delegate: RefusingRedirects()),
              let status = (response as? HTTPURLResponse)?.statusCode
        else { return .failed }
        if status == 401 { return .unauthorized }
        // Event JSON comes from any room member: see `isSafeToParse`.
        guard status == 200, isSafeToParse(data),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return .failed }
        return .event(object)
    }

    private func session(timeout: TimeInterval) -> URLSession? {
        guard let copy = configuration.copy() as? URLSessionConfiguration else { return nil }
        copy.timeoutIntervalForRequest = timeout
        copy.timeoutIntervalForResource = timeout
        return URLSession(configuration: copy)
    }
}

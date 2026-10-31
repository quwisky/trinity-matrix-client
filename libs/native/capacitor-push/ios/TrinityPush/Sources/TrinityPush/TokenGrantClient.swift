import Foundation

public protocol TokenGrantClient: Sendable {
    func grant(_ record: TokenRecord, deadline: Date) async -> TokenGrantAnswer
    /// True only when every token held was revoked.
    func revoke(_ record: TokenRecord, deadline: Date) async -> Bool
}

/// Grants and revocations over URLSession, to the record's pinned endpoints only, with no retry,
/// no discovery and no redirect. A failure is an answer. Logs nothing: bodies and URLs carry
/// tokens and endpoints. Unchecked: the stored configuration is only ever copied.
public struct URLSessionTokenGrantClient: TokenGrantClient, @unchecked Sendable {
    private struct Answer {
        let status: Int
        let body: Data
    }

    /// Ends the read at the cap, or once the deadline and its grace are over. Then, or on a failed
    /// read, what arrived decides: the provider has already spent the old refresh token, so a
    /// complete answer is used and an unfinished one does not parse. Anything later is lost.
    private final class CappedRead: RefusingRedirects, URLSessionDataDelegate, @unchecked Sendable {
        private static let maxBodyBytes = 64 * 1024

        private let readsUntil: Date
        private let now: @Sendable () -> Date
        private let continuation: CheckedContinuation<Answer?, Never>
        private var body = Data()
        private var overCap = false

        init(readsUntil: Date, now: @escaping @Sendable () -> Date, continuation: CheckedContinuation<Answer?, Never>) {
            self.readsUntil = readsUntil
            self.now = now
            self.continuation = continuation
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            guard body.count + data.count <= Self.maxBodyBytes else {
                overCap = true
                dataTask.cancel()
                return
            }
            body.append(data)
            if now() >= readsUntil { dataTask.cancel() }
        }

        // Answering a challenge sends the POST again, refresh token and all. So a real refusal that
        // carries one reads as failed and never reaches soft logout, which stays signed in.
        func urlSession(
            _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            let method = challenge.protectionSpace.authenticationMethod
            completionHandler(URLSessionTokenGrantClient.disposition(for: method), nil)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard !overCap, let status = (task.response as? HTTPURLResponse)?.statusCode else {
                continuation.resume(returning: nil)
                return
            }
            continuation.resume(returning: Answer(status: status, body: body))
        }
    }

    // RFC 6749 section 5.2.
    private static let oauthErrors: Set<String> = [
        "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type",
        "invalid_scope",
    ]

    private let configuration: URLSessionConfiguration
    private let now: @Sendable () -> Date

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        self.init(configuration: configuration, now: { Date() })
    }

    init(configuration: URLSessionConfiguration, now: @escaping @Sendable () -> Date) {
        self.configuration = configuration
        self.now = now
    }

    /// A copy of `base` that keeps nothing between grants and fails at once with no network.
    static func sessionConfiguration(
        from base: URLSessionConfiguration, timeout: TimeInterval
    ) -> URLSessionConfiguration? {
        guard let copy = base.copy() as? URLSessionConfiguration else { return nil }
        copy.urlCache = nil
        copy.requestCachePolicy = .reloadIgnoringLocalCacheData
        copy.httpCookieStorage = nil
        copy.httpShouldSetCookies = false
        copy.httpCookieAcceptPolicy = .never
        copy.urlCredentialStorage = nil
        copy.waitsForConnectivity = false
        copy.timeoutIntervalForRequest = timeout
        copy.timeoutIntervalForResource = timeout
        return copy
    }

    /// Clamped, so a clock stepped back cannot make a huge timeout.
    static func window(until deadline: Date, from now: Date) -> TimeInterval {
        min(deadline.timeIntervalSince(now), TokenBudgets.longestLifetime)
    }

    /// ServerTrust stays with the system, so TLS validation is untouched.
    static func disposition(for authenticationMethod: String) -> URLSession.AuthChallengeDisposition {
        authenticationMethod == NSURLAuthenticationMethodServerTrust
            ? .performDefaultHandling : .cancelAuthenticationChallenge
    }

    public func grant(_ record: TokenRecord, deadline: Date) async -> TokenGrantAnswer {
        guard let endpoint = record.tokenEndpoint, let refreshToken = record.refreshToken,
              let clientId = record.clientId,
              let answer = await post(
                  endpoint,
                  [("grant_type", "refresh_token"), ("client_id", clientId), ("refresh_token", refreshToken)],
                  deadline: deadline, grace: TokenBudgets.grace)
        else { return .failed }
        switch answer.status {
        case 200: return Self.tokens(answer.body)
        case 400, 401: return Self.isOAuthError(answer.body) ? .refused : .failed
        default: return .failed
        }
    }

    public func revoke(_ record: TokenRecord, deadline: Date) async -> Bool {
        guard let endpoint = record.revocationEndpoint, let clientId = record.clientId else { return false }
        // The refresh token first, so a stall on the shared deadline cannot leave it live.
        let tokens = [("refresh_token", record.refreshToken), ("access_token", record.accessToken)]
            .compactMap { hint, token in token.map { (hint, $0) } }
        var revoked = true
        // Every token is tried: one failing must not leave the other unrevoked.
        for (hint, token) in tokens {
            let answer = await post(
                endpoint, [("token", token), ("token_type_hint", hint), ("client_id", clientId)],
                deadline: deadline, grace: 0)
            if answer.map({ !(200..<300).contains($0.status) }) ?? true { revoked = false }
        }
        return revoked
    }

    private static func tokens(_ body: Data) -> TokenGrantAnswer {
        guard let json = object(body), let accessToken = nonEmpty(json["access_token"]) else { return .failed }
        return .tokens(
            accessToken: accessToken, refreshToken: nonEmpty(json["refresh_token"]),
            expiresIn: expiresIn(json["expires_in"]))
    }

    // A gateway or captive portal answers 400 and 401 too, some in JSON, and a refusal signs out.
    private static func isOAuthError(_ body: Data) -> Bool {
        guard let json = object(body), let code = json["error"] as? String else { return false }
        return oauthErrors.contains(code) && json["errcode"] == nil
    }

    private static func object(_ body: Data) -> [String: Any]? {
        guard isSafeToParse(body) else { return nil }
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }

    private static func nonEmpty(_ value: Any?) -> String? {
        (value as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    // Past Int32 it is no real lifetime. A JSON `true` is an NSNumber too, and reads as 1.
    private static func expiresIn(_ value: Any?) -> TimeInterval? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let seconds = number.doubleValue.rounded(.down)
        return seconds >= 1 && seconds <= TimeInterval(Int32.max) ? seconds : nil
    }

    /// Waits for the session's answer even if the caller's task is cancelled: the provider may
    /// have spent the old refresh token, and the deadline still bounds the wait.
    private func post(
        _ endpoint: String, _ form: [(String, String)], deadline: Date, grace: TimeInterval
    ) async -> Answer? {
        let remaining = Self.window(until: deadline, from: now())
        guard let url = URL(string: endpoint),
              let session = Self.sessionConfiguration(from: configuration, timeout: remaining + grace)
        else { return nil }
        var request = URLRequest(
            url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: remaining + grace)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(Self.encoded(form).utf8)
        return await withCheckedContinuation { continuation in
            let read = CappedRead(readsUntil: deadline.addingTimeInterval(grace), now: now, continuation: continuation)
            let urlSession = URLSession(configuration: session, delegate: read, delegateQueue: nil)
            guard now() < deadline else {
                urlSession.invalidateAndCancel()
                continuation.resume(returning: nil)
                return
            }
            let task = urlSession.dataTask(with: request)
            task.resume()
            urlSession.finishTasksAndInvalidate()
            // The grace is for an answer on its way, not for a send that has yet to start.
            DispatchQueue.global().asyncAfter(deadline: .now() + remaining) { [weak task] in
                if task?.countOfBytesSent == 0 { task?.cancel() }
            }
        }
    }

    private static func encoded(_ form: [(String, String)]) -> String {
        form.map { "\($0)=\(URLSessionMatrixPushAPI.segment($1))" }.joined(separator: "&")
    }
}

/// JSONSerialization recurses on nested objects with no limit: 15 KB of `{"a":` overflows a
/// task's stack, which is a SIGBUS nothing can catch. A NUL means UTF-16 or UTF-32, which the
/// parser accepts and this byte scan cannot follow, and no token answer needs either.
func isSafeToParse(_ body: Data) -> Bool {
    let maxNesting = 64
    var depth = 0
    var inString = false
    var escaped = false
    for byte in body {
        if byte == 0 { return false }
        if escaped {
            escaped = false
        } else if inString {
            if byte == UInt8(ascii: "\\") { escaped = true }
            if byte == UInt8(ascii: "\"") { inString = false }
        } else if byte == UInt8(ascii: "\"") {
            inString = true
        } else if byte == UInt8(ascii: "{") || byte == UInt8(ascii: "[") {
            depth += 1
            if depth > maxNesting { return false }
        } else if byte == UInt8(ascii: "}") || byte == UInt8(ascii: "]") {
            depth -= 1
        }
    }
    return true
}

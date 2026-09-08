import Foundation

public enum TrinityPushTokenCoordinatorError: Error, Equatable {
    case missingFCMToken
    case registrationFailed
}

/// Coordinates the APNs readiness boundary and the asynchronous FCM token lookup.
///
/// The host supplies the Firebase and notification callbacks. Host code is responsible
/// for serializing calls and callback delivery on the main thread.
public final class TrinityPushTokenCoordinator {
    public typealias FCMCompletion = (_ token: String?, _ error: Error?) -> Void

    private let requestAPNs: () -> Void
    private let mapAPNs: (Data) -> Void
    private let fetchFCM: (@escaping FCMCompletion) -> Void
    private let emitToken: (String) -> Void
    private let emitFailure: (Error) -> Void

    private var apnsToken: Data?
    private var generation = 0

    public init(
        requestAPNs: @escaping () -> Void,
        mapAPNs: @escaping (Data) -> Void,
        fetchFCM: @escaping (@escaping FCMCompletion) -> Void,
        emitToken: @escaping (String) -> Void,
        emitFailure: @escaping (Error) -> Void
    ) {
        self.requestAPNs = requestAPNs
        self.mapAPNs = mapAPNs
        self.fetchFCM = fetchFCM
        self.emitToken = emitToken
        self.emitFailure = emitFailure
    }

    public func register() {
        generation += 1
        requestAPNs()
        fetchCurrentAPNsToken()
    }

    public func setAPNsToken(_ token: Data) {
        guard !token.isEmpty else {
            apnsToken = nil
            generation += 1
            return
        }

        apnsToken = token
        generation += 1
        fetchCurrentAPNsToken()
    }

    public func didReceiveFCMToken(_ token: String?) {
        guard apnsToken != nil, let token, !token.isEmpty else { return }

        // A delegate refresh is a newer registration result than any outstanding lookup.
        generation += 1
        emitToken(token)
    }

    private func fetchCurrentAPNsToken() {
        guard let apnsToken else { return }

        let requestedGeneration = generation
        mapAPNs(apnsToken)
        fetchFCM { [weak self] token, error in
            guard let self, requestedGeneration == self.generation else { return }

            if let error {
                self.emitFailure(error)
            } else if let token, !token.isEmpty {
                self.emitToken(token)
            } else {
                self.emitFailure(TrinityPushTokenCoordinatorError.missingFCMToken)
            }
        }
    }
}

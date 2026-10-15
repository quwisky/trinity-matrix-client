// swift-tools-version: 5.9
import PackageDescription

// The App lock PIN verifier shared by the TrinityAppLock plugin. Foundation, Security and
// CommonCrypto only, so `swift test` runs it on the macOS host; the rules are pinned by
// native/app-lock/pin-policy-cases.json, which the Electron and Android suites run too.
let package = Package(
    name: "TrinityAppLockCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "TrinityAppLockCore", targets: ["TrinityAppLockCore"])
    ],
    targets: [
        .target(name: "TrinityAppLockCore"),
        .testTarget(name: "TrinityAppLockCoreTests", dependencies: ["TrinityAppLockCore"]),
    ]
)

// swift-tools-version: 5.9
import PackageDescription

// The TrinityAppLock Capacitor plugin. `cap sync ios` adds this package to CapApp-SPM as
// TrinityCapacitorAppLock, the name Capacitor derives from @trinity/capacitor-app-lock. The
// verifier is the TrinityAppLockCore package in ios/TrinityAppLockCore, which has no Capacitor
// dependency so `swift test` runs it on the macOS host.
let package = Package(
    name: "TrinityCapacitorAppLock",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "TrinityCapacitorAppLock", targets: ["AppLockPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(path: "ios/TrinityAppLockCore"),
    ],
    targets: [
        .target(
            name: "AppLockPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "TrinityAppLockCore", package: "TrinityAppLockCore"),
            ],
            path: "ios/Sources/AppLockPlugin"
        )
    ]
)

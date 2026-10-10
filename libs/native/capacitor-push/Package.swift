// swift-tools-version: 5.9
import PackageDescription

// The PushHandoff Capacitor plugin. `cap sync ios` adds this package to CapApp-SPM as
// TrinityCapacitorPush, the name Capacitor derives from @trinity/capacitor-push. The push
// rendering it shares with the NotificationService extension is the TrinityPush package in
// ios/TrinityPush, which has no Capacitor dependency so `swift test` runs it on the macOS host.
let package = Package(
    name: "TrinityCapacitorPush",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "TrinityCapacitorPush", targets: ["PushHandoffPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(path: "ios/TrinityPush"),
    ],
    targets: [
        .target(
            name: "PushHandoffPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "TrinityPush", package: "TrinityPush"),
            ],
            path: "ios/Sources/PushHandoffPlugin"
        )
    ]
)

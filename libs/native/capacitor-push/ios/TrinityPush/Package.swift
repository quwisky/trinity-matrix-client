// swift-tools-version: 5.9
import PackageDescription

// Push rendering shared by the PushHandoff plugin (TrinityCapacitorPush, two levels up) and the
// NotificationService extension. Foundation and Security only, so `swift test` runs it on the
// macOS host; the text rules are pinned by native/push-render/push-render-cases.json, which the
// Android JUnit suite runs too.
let package = Package(
    name: "TrinityPush",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "TrinityPush", targets: ["TrinityPush"])
    ],
    targets: [
        .target(name: "TrinityPush"),
        .testTarget(name: "TrinityPushTests", dependencies: ["TrinityPush"]),
    ]
)

// swift-tools-version: 5.9
import PackageDescription

// The TrinityAuthSession Capacitor plugin. `cap sync ios` adds this package to CapApp-SPM as
// TrinityCapacitorAuthSession, the name Capacitor derives from @trinity/capacitor-auth-session.
// iOS only: the package declares no Android module.
let package = Package(
    name: "TrinityCapacitorAuthSession",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "TrinityCapacitorAuthSession", targets: ["AuthSessionPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.5.3")
    ],
    targets: [
        .target(
            name: "AuthSessionPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/AuthSessionPlugin"
        )
    ]
)

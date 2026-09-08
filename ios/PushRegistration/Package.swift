// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PushRegistration",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "PushRegistration", targets: ["PushRegistration"]),
    ],
    targets: [
        .target(name: "PushRegistration"),
        .testTarget(name: "PushRegistrationTests", dependencies: ["PushRegistration"]),
    ]
)

import Foundation
import TrinityPush

// Usage: token-lease-probe <container> <account> <lifetime> <wait>
// Takes the lease, prints `taken`, `busy` or `unavailable`, and exits without releasing.
//
// token-lease-probe app|push ...: the two sides of a race, in RaceRoles.swift.
let arguments = CommandLine.arguments
switch arguments[1] {
case "app":
    await runApp(Array(arguments.dropFirst(2)))
case "push":
    await runPush(Array(arguments.dropFirst(2)))
default:
    let lease = AppGroupTokenLease(containerURL: URL(fileURLWithPath: arguments[1]))
    switch await lease.take(arguments[2], lifetime: Double(arguments[3])!, wait: Double(arguments[4])!) {
    case .taken: print("taken")
    case .busy: print("busy")
    case .unavailable: print("unavailable")
    }
}

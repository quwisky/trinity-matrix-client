import Foundation
import TrinityPush

// Usage: token-lease-probe <container> <account> <lifetime> <wait>
// Takes the lease, prints `taken`, `busy` or `unavailable`, and exits without releasing.
let arguments = CommandLine.arguments
let lease = AppGroupTokenLease(containerURL: URL(fileURLWithPath: arguments[1]))
switch await lease.take(arguments[2], lifetime: Double(arguments[3])!, wait: Double(arguments[4])!) {
case .taken: print("taken")
case .busy: print("busy")
case .unavailable: print("unavailable")
}

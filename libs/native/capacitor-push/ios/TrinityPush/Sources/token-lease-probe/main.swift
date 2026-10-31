import Foundation
import TrinityPush

// Usage: token-lease-probe <container> <account> <lifetime> <wait>
// Takes the lease, prints `taken` or `busy`, and exits without releasing.
let arguments = CommandLine.arguments
let lease = AppGroupTokenLease(containerURL: URL(fileURLWithPath: arguments[1]))
let ticket = await lease.take(arguments[2], lifetime: Double(arguments[3])!, wait: Double(arguments[4])!)
print(ticket == nil ? "busy" : "taken")

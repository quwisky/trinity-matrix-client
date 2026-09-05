---
status: accepted
---

# Use Account Runtime and keyed Conversation Runtime seams

Account Runtime owns the lifecycle of every live Account, while Conversation Runtime owns messaging behaviour for one immutable Account-and-Room pair. Authentication produces an opaque grant rather than owning an Account, routing remains outside both runtimes, and a Conversation handle never retargets; these boundaries preserve concurrent Accounts and prevent route state or raw SDK clients from becoming product APIs.

## Current guidance

This decision records its accepted context. See the [current architecture contract](../architecture/target-architecture.md), [capability ownership](../architecture/libraries.md) and [runtime lifetimes](../architecture/state-and-reactivity.md) for the implemented boundaries.

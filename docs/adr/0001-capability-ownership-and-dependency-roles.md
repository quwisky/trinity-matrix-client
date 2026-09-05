---
status: accepted
---

# Organize product code by capability and architectural role

Trinity will migrate from technical layer ownership to product capabilities, application workflows, a small shared kernel, technology adapters, a domain-neutral design system, and thin application composition roots. Nx projects carry `role:*` and `capability:*` metadata because capability ownership improves change locality, while explicit roles preserve an acyclic dependency direction; cross-capability workflows belong in application modules rather than capability-to-capability imports or a generic event bus.

## Current guidance

This decision records its accepted context. See the [current architecture contract](../architecture/target-architecture.md), [capability ownership](../architecture/libraries.md) and [runtime lifetimes](../architecture/state-and-reactivity.md) for the implemented boundaries.

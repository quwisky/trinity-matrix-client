---
status: accepted
---

# Expose state with signals and commands with cold RxJS Observables

Capability state is exposed as read-only Angular signals, while commands return cold, finite RxJS Observables. Expected operational failures are emitted as typed outcomes, the error channel is reserved for defects or broken adapters, and commands do not start detached subscriptions; explicit application runtimes may own long-lived streams with equally explicit start and stop lifetimes.

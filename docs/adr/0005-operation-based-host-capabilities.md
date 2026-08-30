---
status: accepted
---

# Select operation-based host capabilities at composition

Product code asks for narrow operations such as secure storage, deep links, host back, file export, notification presentation, badges, lifecycle, and updates instead of detecting Web, Capacitor, or Electron. Composition roots select supported adapters, and Electron negotiates a versioned capability set, reducing platform branching while making unavailable operations and IPC security explicit.

The public contracts live in `@trinity/runtime/host`. Signals remain the state mechanism;
one-shot host commands are cold, finite Observables whose expected failures are typed outcomes.
Every host publishes an explicit support manifest for the complete operation catalogue. An absent
adapter is therefore `unavailable`, never an optional method or an implicit no-op.

`@trinity/platform-native` owns Web and Capacitor adapter selection at the application composition
root. Electron exposes protocol v1 through its context-isolated preload. The main process validates
the sender and payload of each capability-scoped IPC handler; responses contain stable diagnostic
codes rather than request data. Adding an Electron operation requires both negotiation support and
a dedicated versioned channel—it must not expose `ipcRenderer` or broaden the bridge generically.

The badge is the cross-host production tracer. Badge coordination depends only on
`HostBadgeService`; Web Badging, the Capacitor badge plugin, and Electron dock/launcher behavior
implement the same contract and share conformance tests. Authentication handoff, deep-link and
Back events, and notification presentation now also enter product code through composition-selected
operation services. File export, location, and secure storage expose capability semantics through
their platform adapters rather than leaking host identity. Electron's preload bridge contains only
required, grouped capability objects; runtime validation rejects a bridge missing any required
operation instead of casting a partial object into a valid protocol.

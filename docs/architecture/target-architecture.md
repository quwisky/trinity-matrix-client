# Target architecture

Trinity uses capability-centered ownership. The existing `type:*`, `scope:*`, and `ui:*` rules remain enforced alongside `role:*` and `capability:*` metadata; the architecture contract is in its `contracted` phase and permits no migration exceptions.

## Dependency direction

```text
Host applications → Application workflows → Product capabilities → Shared kernel
       │                    │                       │                    ↑
       └────────────────────┴───────────────────────┴→ Adapters ─────────┘
```

The design system is a domain-neutral presentation dependency available to applications and capabilities. A capability may depend on projects carrying the same `capability:*` tag while it is being consolidated, but a cross-capability workflow belongs in `role:application`. The exact live graph, role matrix, and frozen exceptions are in the [generated dependency map](generated/dependency-map.md).

## Roles

| Role                 | Responsibility                                                                    |
| -------------------- | --------------------------------------------------------------------------------- |
| `role:app`           | Select adapters and compose one deployable host application.                      |
| `role:application`   | Coordinate workflows spanning multiple product capabilities.                      |
| `role:capability`    | Own product policy, state projections, commands, and its presentation adapters.   |
| `role:kernel`        | Provide a small reusable runtime primitive without product policy.                |
| `role:adapter`       | Contain Matrix SDK, browser, Capacitor, Electron, storage, and transport details. |
| `role:design-system` | Provide reusable domain-neutral UI through Trinity-owned APIs.                    |

Tooling and black-box test projects are outside this runtime dependency model. Web, Android, iOS and Electron are classified `role:app` composition roots; no host classification exception remains.

## Product capabilities

- **Accounts** owns saved Accounts and Account Runtime lifecycle. Authentication Attempts end by
  issuing an opaque authenticated grant; Account Runtime consumes the grant with an explicit
  active/inactive placement intent and never exposes credentials back to the caller.
- **Room Library** owns the current user's relationship to the Room and Space graph.
- **Conversations** owns keyed timelines, composer intent, messages, threads, pins, and read position.
- **Room Administration** owns governance within a Room.
- **Trust** owns verification, cross-signing, secret storage, recovery, key transfer, and encryption health.
- **Identity** owns user summaries, profiles, avatars, presence, and lookup.
- **Notifications** owns SDK-free delivery policy and immutable notification intents. Matrix
  adapters normalize events and user-rule results before policy sees them; host presenters own
  permission and delivery. Activation round-trips an exact Account, Room, and event destination
  into Workspace, which performs its normal validation, Account transition, repair, Conversation
  focus, and canonical URL projection.
- **Discovery** owns remote homeserver, public-Room, and user-directory discovery.

Workspace, Settings, Global Search, Badge coordination, and Application Runtime are application workflows. `BadgeCoordinator` reads Room Library's aggregate unread state without taking ownership of it and writes only through a host-neutral `BadgeSink`; Conversation continues to own read position. Matrix Runtime, Projection Runtime, Media Pipeline, Preferences Store, Host Capabilities, pure utilities, and the design system form the deliberately small shared kernel and supporting seams.

Application Runtime is the sole startup and session owner. Its ordered attempt negotiates the
host, hydrates preferences, restores Accounts, establishes optional session capabilities,
restores Workspace and crosses one final readiness stage. Required failures block with typed
executable recovery; optional failures are retained and presented as non-blocking warnings. The
application root keeps that warning region visible and keyboard-scrollable, caps it at one quarter
of the visual viewport, and gives the remaining height to the routed surface. Its one lifetime
subscription owns every session-long source and can be stopped and restarted without retained
listeners.

Workspace is the live cross-capability coordinator for navigation. It exposes one immutable
Account, sidebar-scope, optional-Conversation, and pane view. Its URL is a canonical projection and
an inbound restoration source: deep links win over persisted selection, user intent pushes
history, canonicalization and repair replace history, and responsive placement changes neither the
destination nor history. A cold RxJS transition validates and projects the URL before an Active
Account commit can begin, publishes the view only after Account readiness, and retains ownership
through post-commit completion if its initiating subscriber disappears.

## State and commands

The Matrix SDK remains authoritative for protocol state. Adapters normalize SDK input before capabilities consume it. Capabilities project state to private writable signals and expose only read-only signals and computed views.

Commands are cold, finite RxJS Observables. Expected operational failures are typed outcomes with recovery meaning and safe metadata; defects and broken adapters use the Observable error channel. A command never hides a detached subscription. Application Runtime is the explicit owner of session-long streams.

Host Capabilities applies this rule to authentication handoff, deep links, Back, file export,
notification presentation, location, badges, secure storage, lifecycle, and updates. Product code
depends on narrow operation services from `@trinity/runtime/host`; the application root selects a
Web, Capacitor, or Electron adapter. Support is negotiated explicitly. Electron protocol v1 uses
validated senders and capability-scoped IPC, and returns only secret-safe diagnostic codes.

Preferences Store applies the same rule to capability-owned configuration. Capabilities contribute
typed descriptors with explicit installation, Account, Conversation, or server-authoritative
scope plus defaults, validation, versioned migration, sensitivity, storage/export policy, and
editor metadata. `@trinity/runtime/preferences` owns only the catalog and context-keyed signal
runtime; Settings renders it without importing raw keys or product policy. Device and future
Matrix adapters enforce the declared policy, and recovery diagnostics never contain preference
values.

Appearance applies that ownership rule across capabilities rather than creating one persistence
record. Design System owns Mode, Theme, text size, and density; Conversations owns code size and
code-line presentation. `@trinity/application/appearance` composes their six read-only preference
cells into one value plus per-axis state, delegates hydration to Preferences Store, and turns any
partial result into one warning-ready outcome while each failed axis keeps only its own default.
It resolves committed values with the current system Mode through a platform-neutral function.
One cold effect lifetime owns the system-Mode observation, document-root carrier adapter, and a
Mode-only native-chrome projection; unsuccessful persistence never publishes a candidate into
that lifetime.

## Public interfaces

Cross-project imports use one explicit `@trinity/*` entrypoint per library. Secondary and wildcard entrypoints are rejected. Raw SDK clients, writable signals, Router objects, platform flags, and generic connect/disconnect methods do not belong in capability interfaces.

## Contracted enforcement

Future architecture changes still follow expand-migrate-contract slices:

1. Add the target interface and adapter beside the current path.
2. Freeze the current callers and dependency exceptions.
3. Move complete user journeys while keeping both paths behaviorally equivalent.
4. Remove the old path when its counters reach zero.
5. Tighten the static boundary so the exception cannot return.

Run `pnpm architecture:check` to validate the live Nx graph, role and capability direction, explicit entrypoints, empty migration ledgers, cycles, quality-baseline registry, and committed map. Repository structural tests additionally enforce SDK, Router, platform-vendor, design-system, and host containment. Run `pnpm architecture:map` after an intentional architecture change, then review the generated diff rather than editing it directly.

## Decisions

- [Capability ownership and dependency roles](../adr/0001-capability-ownership-and-dependency-roles.md)
- [Matrix SDK authoritative state](../adr/0002-matrix-sdk-authoritative-state.md)
- [Account and Conversation Runtime seams](../adr/0003-account-and-conversation-runtime-seams.md)
- [Workspace authority and URL projection](../adr/0004-workspace-authority-and-url-projection.md)
- [Operation-based host capabilities](../adr/0005-operation-based-host-capabilities.md)
- [Signals for state and RxJS for commands](../adr/0006-signals-for-state-and-rxjs-for-commands.md)
- [Incremental facade migration](../adr/0007-incremental-facade-migration.md)
- [Capability-owned typed preferences](../adr/0008-capability-owned-typed-preferences.md)

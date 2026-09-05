# Architecture contract and decisions

Use this guide when changing a public boundary or deciding where a cross-capability
workflow belongs. It describes the current architecture of `refactor/refine-architecture`.
The filename is retained for existing links; this is a living contract, not a future plan.
Start with [capability ownership](libraries.md) for the owning library and
[state and runtime lifetimes](state-and-reactivity.md) for execution details.

## Dependency direction

Runtime projects carry `role:*` and `capability:*` metadata in addition to the existing
`type:*`, `scope:*` and `ui:*` tags. These constraints apply together. A permitted role
edge does not exempt an import from a type, scope, vendor or public-entrypoint restriction.

The [generated dependency map](generated/dependency-map.md) gives the exact permitted
role matrix, current edges, entrypoints and classifications. Read it when assessing an
edge; a simplified layering sketch cannot express all adapter dependencies.

## Roles

| Role                 | Ownership                                                                |
| -------------------- | ------------------------------------------------------------------------ |
| `role:app`           | Compose a deployable host and select its adapters.                       |
| `role:application`   | Coordinate a workflow across product capabilities.                       |
| `role:capability`    | Own product policy, projected state, commands and presentation adapters. |
| `role:kernel`        | Provide a reusable runtime primitive without product policy.             |
| `role:adapter`       | Contain SDK, browser, native, desktop, storage or transport details.     |
| `role:design-system` | Expose domain-neutral UI through Trinity-owned APIs.                     |

Web, Android, iOS and Electron are application composition roots. Tooling and black-box
test projects are classified separately from runtime dependencies. Cross-capability
coordination belongs in an application workflow; a feature must not import another feature.
Shared projects cannot reach into product-scoped projects merely because a helper is useful.

## Product capabilities

The [library guide](libraries.md) maps each capability to its public entrypoint and source.
These ownership rules are the contract to preserve when moving code:

- **Accounts** owns saved Accounts and Account Runtime lifecycle. Authentication produces an
  opaque grant; Accounts consumes it with explicit active/inactive placement intent.
- **Room Library** owns relationships to Rooms and Spaces, invitations, hierarchy, ordering
  and aggregate unread. Its selected view is the cross-Account read boundary. One internal
  source registry supplies Room, Space and invitation projections; single-Account views reuse
  active projections. Shared-row writes follow the target policy in ADR 0009.
- **Conversations** owns exact Account-and-Room timelines, composer intent, messages, threads,
  pins and read position. **Room Administration** owns governance within a Room.
- **Trust** owns verification, cross-signing, secret storage, recovery, key transfer and
  encryption health. **Identity** owns user summaries, profiles, avatars and presence.
- **Discovery** owns remote homeserver, public-Room and user-directory discovery.
- **Notifications** owns delivery policy and immutable notification intents. Matrix adapters
  normalize events and user rules; host presenters own permission and delivery. Activation
  carries an exact Account, Room and event into Workspace's normal transition path.

Workspace, Settings, Global Search, Badge coordination and Application Runtime coordinate
capabilities. Badge coordination reads Room Library unread totals and writes through a
host-neutral sink; it does not take over Conversation read position. The shared kernel and
adapter seams provide Matrix Runtime, Projection Runtime, Media Pipeline, Preferences Store,
Host Capabilities and pure utilities. The design system stays domain-neutral.

## State and commands

The Matrix SDK is authoritative for protocol state. Adapters normalize its events before
capabilities publish immutable views through private writable signals and public read-only
signals. Commands are cold, finite RxJS Observables. Expected operational failures carry
safe typed recovery meaning; defects use the error channel. A finite command's subscription
contract must say whether work is cancellable or continues after unsubscribe: a Promise
wrapped in `defer` does not become cancellable automatically.

Preserve these lifetime boundaries; their sequences and cancellation rules live in the
[state guide](state-and-reactivity.md):

- Application Runtime owns ordered startup, readiness, recovery, stop/restart and the single
  session subscription. Deep links, Back, notifications, updates, badges and surface streams
  stay gated until final readiness. Its one producer-policy ledger gives every required
  preparation a first-result budget and no automatic retry, with an overall watchdog for the
  complete staged path. Required Host, Active Account, Room Library, safe Workspace destination,
  and readiness failures block; optional operations settle independently, dependent operations
  record an explicit skipped settlement, and recovery resumes at the narrowest stage that can
  recreate required ownership. The warning region
  stays keyboard scrollable and occupies at most a quarter of the visual viewport.
- A session-owned capability exposes a cold `runProjection()` lifetime. Subscription owns
  attachment and acknowledgement; teardown releases listeners, pending work, warnings and
  the view. Routed Room demand controls Identity, Notifications and Room Administration;
  exact Conversation and local settings lifetimes retain their own owners.
- Workspace owns one semantic destination and projects it to the URL. Deep links take
  precedence over saved selection; user navigation pushes history, repair replaces it, and
  responsive placement changes neither. URL preparation precedes Account commit. Publication
  waits for Account readiness; accepted post-commit completion retains its owner even if the
  initiating subscriber disappears.
- The page-scoped Room surface lifecycle owns panels, return intent and focus. Members starts
  closed and is remembered for the shell lifetime. Temporary exact-Conversation surfaces
  replace the roster without erasing that choice. Entering drawer layout clears remembered
  members; widening an explicitly opened drawer preserves it. Events, Back and dismissal
  enter semantic commands; consumers cannot seed private surface records or jump counters.

Host operations use narrow services from `@trinity/runtime/host`, explicit support negotiation
and host-selected adapters. Electron IPC is versioned, sender-validated and capability-scoped.
See the [host guides](../platforms/index.md) for implementations and validation limits.

Capabilities own preference descriptors: scope, default, validation, migration, sensitivity,
storage/export policy and editor metadata. Preferences Store owns the typed catalog and
context-keyed runtime; Settings renders descriptors without owning raw keys or product policy.
Diagnostics omit values. Design System owns Mode, Theme, text size and density; Conversations
owns code size and code-line presentation. Appearance combines these six cells, keeps per-axis
fallbacks on partial hydration, and owns one effect lifetime for system Mode, document carriers
and Mode-only native chrome. Failed persistence must not publish a candidate value. The
[UI guide](ui-and-theming.md) owns the design and contribution details.

## Public interfaces

Use each library's explicit primary `@trinity/*` entrypoint. Wildcard and secondary
entrypoints are rejected by the architecture contract. Product-facing capability interfaces
must not expose raw SDK clients, writable signals, Router instances, platform flags or generic
connection controls. Matrix-specific adapters use their contained SDK seams; that does not
make those seams acceptable for presentation consumers.

Third-party UI is contained behind the public component tier and its vendor wrappers. Product
features consume `@trinity/components/*`, not `@trinity/helm/*` or UI vendor packages directly.

## Contracted enforcement

The [architecture contract](../../architecture/contract.json) is `contracted`: every
classification, secondary-entrypoint, multi-capability, dependency-exception and source-baseline
ledger must be empty. ADR 0007 records the completed expand/migrate/contract method; it is not
permission to add a facade or exception under the current contract. Future boundary changes
must account for current callers, behavior parity, removal ownership and the final tightened
boundary without silently weakening these guards.

After an intentional graph change, regenerate and check the map:

```bash
pnpm architecture:map
pnpm architecture:check
```

Review the generated diff. The check validates graph classification, allowed direction,
explicit entrypoints, empty ledgers, cycles, baseline registry structure and exact generated
map content. Its script also runs design-system and host contracts. Repository structural
suites enforce source-level SDK, Router, platform and retired-interface containment. Neither
a map check nor registry membership proves runtime parity or performance. Use the
[measurement contracts](migration-baselines.md) and [testing guide](../contributing/testing.md)
to select the corresponding checks.

## Decisions

The ADRs preserve the reasoning and status accepted at the time. Current implementation
belongs in these architecture guides; a historical migration description does not override
the current contracted boundary.

| Decision                                                         | Subject                                   |
| ---------------------------------------------------------------- | ----------------------------------------- |
| [0001](../adr/0001-capability-ownership-and-dependency-roles.md) | Capability ownership and dependency roles |
| [0002](../adr/0002-matrix-sdk-authoritative-state.md)            | Matrix SDK authoritative state            |
| [0003](../adr/0003-account-and-conversation-runtime-seams.md)    | Account and Conversation Runtime seams    |
| [0004](../adr/0004-workspace-authority-and-url-projection.md)    | Workspace authority and URL projection    |
| [0005](../adr/0005-operation-based-host-capabilities.md)         | Operation-based host capabilities         |
| [0006](../adr/0006-signals-for-state-and-rxjs-for-commands.md)   | Signals for state and RxJS for commands   |
| [0007](../adr/0007-incremental-facade-migration.md)              | Incremental facade migration              |
| [0008](../adr/0008-capability-owned-typed-preferences.md)        | Capability-owned typed preferences        |
| [0009](../adr/0009-selected-room-library-view.md)                | Selected Room Library Account scope       |

[Historical validation](final-validation.md) preserves dated delivery evidence; it is not a
current run report.

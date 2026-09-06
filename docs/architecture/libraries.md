# Library boundaries

Trinity libraries are organised around capability ownership, not around Angular
artifact types. A library should expose a narrow public API for one owner; its
internal adapters, projections, and helper types remain inside that boundary.

The [generated dependency map](generated/dependency-map.md) is the canonical
source for current project roots, aliases, tags, and direct dependencies.
Consult it and resolved Nx configuration before moving code. This guide explains
how to use that map when making a design decision.

## The layers

| Layer         | Locations                                   | Use it for                                                                | Do not use it for                           |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| composition   | apps/trinity, android, ios, electron        | route and provider assembly; host-specific entrypoints                    | product state or reusable Matrix access     |
| application   | libs/application                            | startup, Workspace, search, appearance and cross-capability orchestration | a general home for screen-local logic       |
| capability    | libs/data-access, libs/feature              | a Matrix domain's state and commands, or the screen that presents one     | an SDK shortcut from a component            |
| adapter       | selected data-access and platform libraries | Matrix and platform implementation behind a contract                      | exposing raw SDK state to a feature         |
| kernel        | libs/runtime, libs/util, theme foundation   | policy-free primitive contracts and shared behaviour                      | a dependency on a Matrix product capability |
| design system | libs/components, libs/spartan               | domain-neutral presentation and generated vendor wrappers                 | account, room, SDK, or product state        |

The thin application project composes the layers. Dependencies point inward:
presentation calls capability APIs, capability code uses adapters and kernels,
and the composition root selects implementations. Module-boundary lint checks
the tag relationship.

## Capability and kernel ownership

Use the narrowest owner that can state the contract.

| Public area                              | Owner and boundary                                                                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @trinity/runtime/projection              | lifecycle kernel for active account, all live accounts, exact account, and exact conversation projections; it does not own Matrix data                                                       |
| @trinity/runtime/host                    | host operation contracts and supported or unavailable manifests; host selection stays in composition                                                                                         |
| @trinity/runtime/preferences             | descriptor catalogue and context-keyed state; capability owners define defaults, validation, migration, sensitivity, and scope                                                               |
| @trinity/data-access/accounts            | account restore, opaque authenticated establishment, active switching, sign-out and installation reset                                                                                       |
| @trinity/data-access/matrix-client       | Matrix client foundation, session state and SDK-facing adapters                                                                                                                              |
| @trinity/data-access/room-library        | exact-Account Room organisation tags, Room and Space summaries, invitations, hierarchy, ordering, filters, and unread aggregates                                                             |
| @trinity/data-access/notifications       | notification policy, delivery state, and authoritative exact-Account per-Room rule reads and commands                                                                                        |
| @trinity/data-access/timeline            | the Conversations capability; Conversation Runtime owns exact timeline-handle lifetime, while its public API exposes message presentation, drafts, media, threads, pins, and focused proxies |
| @trinity/data-access/trust               | trust health, recovery and device verification                                                                                                                                               |
| @trinity/data-access/room-administration | members, bans, power-level policy, aliases, configuration and moderation ports                                                                                                               |
| @trinity/application/runtime             | ordered startup, scoped capability-health policy, targeted recovery and the session-long host stream                                                                                         |
| @trinity/application/workspace           | semantic navigation, URL and history projection, account readiness, and conversation focus                                                                                                   |

Other data-access capabilities follow the same rule: Discovery owns homeserver,
public-room, room-link, and directory lookup; Notifications owns notification
policy and delivery state; Media owns staging and transfer; Identity owns
identity flows. Find their exact public aliases in the generated map.

## Public APIs

Every library exposes its supported imports from its source index. Use the alias
listed in the generated map, such as @trinity/data-access/room-library, rather
than a path under src/lib. This keeps refactors from coupling consumers to
private adapters.

Some boundaries are particularly important:

- Components and features never import matrix-js-sdk. The owning data-access
  library turns SDK events into application read models and provides commands.
- Components receive read-only signals and invoke cold commands. They do not
  receive writable signals, an active client, or another feature's service.
- A cross-capability operation is a declared port bound in the composition
  root. For example, Conversation's redaction and pin policy comes from Room
  Administration without either capability reaching into the other's internals.
- The Spartan libraries are generated vendor wrappers. Consume their
  domain-neutral counterpart in libs/components. If a public wrapper is missing, add it
  through that tier before feature use; do not import the vendor directly or put Matrix
  behaviour into a vendor wrapper.
- The web output is the host-neutral artifact. Capacitor and Electron consume
  it through their host adapters; platform code does not fork the product
  capability model.

## Placement decisions

Ask these questions in order.

1. Is the state authoritative in matrix-js-sdk or in a host API? Put its
   adapter in the owning data-access or platform capability.
2. Is the result a product read model and a set of commands for one domain?
   Put it in that domain's data-access library.
3. Does it coordinate several capabilities or define a semantic application
   lifetime? Put it in an application library.
4. Is it reusable without Matrix product knowledge or Angular dependency
   injection? Put it in a kernel or utility library.
5. Is it domain-neutral presentation only? Put it in the public component tier.
6. Is it provider selection, route registration, or platform bootstrapping?
   Put it in a composition root.

Do not solve a forbidden dependency by importing a private file. Prefer the
owner's public signal or command, a narrow interface supplied by composition,
or a new capability API.

## Inspect and validate a boundary

Nx project names are not always directory names. Resolve them before editing
configuration or choosing a target:

```bash
pnpm nx show project application-workspace --json
pnpm nx show project data-access-timeline --json
pnpm nx show project projection-runtime --json
pnpm nx graph --print
```

The resolved output gives the root, tags, and declared targets. Add or change
an edge only after checking it satisfies the type, scope, UI, and external
import rules. Run the owner's test, typecheck, and lint targets that Nx reports,
then use the journey that reaches the behaviour. See
[commands](../contributing/commands.md) and
[testing](../contributing/testing.md) for the canonical commands.

## What is intentionally not a library boundary

A route, dialog, or page is not permission to create a new state owner. A
temporary migration adapter is not a public API. An internal Matrix SDK
type is not an application model. Keep each of those behind the capability
that owns the lifecycle. Record the boundary rationale in the relevant
[architecture decision record](../adr/0001-capability-ownership-and-dependency-roles.md);
[final validation](final-validation.md) is dated delivery evidence, not a
current contract.

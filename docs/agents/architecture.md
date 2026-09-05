# Find the architecture contract

Before changing ownership, dependencies, state, or routing, identify the owner in
[Architecture](../architecture/index.md). Follow the relevant contract below instead
of copying a capability summary into agent instructions.

| Change reaches                                                               | Read before editing                                                                                                                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library boundaries or cross-capability composition                           | [Dependency roles](../architecture/index.md#dependency-roles-and-public-boundaries) and [where a change belongs](../architecture/index.md#where-a-change-belongs) |
| Startup, recovery, deep links, Back, or application surfaces                 | [Application startup](../architecture/index.md#application-startup), including its composition source links                                                       |
| Account/Conversation lifetimes, projections, signals, or action cancellation | [State and reactivity](../architecture/state-and-reactivity.md); use each operation's lifecycle contract                                                          |
| SDK events, authentication, encryption, or persistence                       | [Matrix and encryption](../architecture/matrix-and-encryption.md)                                                                                                 |
| Public UI, vendors, themes, overlays, or responsive geometry                 | [UI and theming](../architecture/ui-and-theming.md)                                                                                                               |
| Platform selection or unsupported operations                                 | [Platform guides](../platforms/index.md) and the selected host capability                                                                                         |
| Vocabulary or a previous decision                                            | [Domain documentation](domain.md)                                                                                                                                 |

Trace the public entrypoint, concrete adapter, and relevant tests before changing a
boundary. Matrix SDK authority does not make it the owner of every preference or
workspace state; finite product actions and ongoing runtime lifetimes have different
contracts. Record the inspected revision and unresolved behavior in the
[handoff](../../.agents/roles.md#handoffs).

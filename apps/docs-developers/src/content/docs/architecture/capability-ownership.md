---
title: Capability ownership
description: Place state, commands, orchestration, and presentation in the Trinity project that owns them.
audience: developer
contentChannel: develop
canonicalTopic: architecture-capability-ownership
pageType: explanation
platforms: [web, desktop, android, ios]
---

Start with the behavior's owner, not the screen where it appears. A capability owns its state, its adapter to Matrix or a host, and the commands that change that state. Features present capabilities; application services coordinate them.

## Primary owners {#primary-owners}

| Concern                                                                      | Owner                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Process startup, readiness, recovery, and session streams                    | Application Runtime                                          |
| Saved accounts, authentication lifecycle, active account, sign-out, reset    | Accounts                                                     |
| Room and Space summaries, invitations, hierarchy, ordering, aggregate unread | Room Library                                                 |
| Canonical destination, browser history, account readiness, focused room      | Workspace                                                    |
| Exact account-and-room timeline retention                                    | Conversation Runtime within the conversations capability     |
| Messages, drafts, relations, threads, pins, and room media                   | Conversation data access                                     |
| Verification and encryption health                                           | Trust                                                        |
| Context-keyed persisted settings                                             | Preferences Runtime plus contributing capability descriptors |
| Matrix client, sync, SDK persistence, and SDK event adaptation               | Matrix Client data access                                    |
| Platform support and host operations                                         | Host Runtime contracts and selected host adapters            |

The capability list and allowed role dependencies are recorded in `architecture/contract.json`. Project tags in each `project.json` assign a role and capability to the live Nx graph.

## Choose an owner {#choose-owner}

Use these placement questions in order:

1. Which capability defines the product meaning of the state or action?
2. Is this a capability concern, cross-capability application orchestration, a reusable kernel, a host adapter, or presentation?
3. Which public entrypoint already exposes the nearest contract?
4. Does the intended dependency direction permit that import?

If one screen needs another capability's state, read the owning data-access signal or use an application-level port. Do not move ownership into the screen and do not import another feature.

## Preserve lifetimes {#preserve-lifetimes}

Ownership includes creation and cleanup. Account-scoped state follows the exact account lifecycle; conversation-scoped state follows the exact account and room; application startup owns its single retained subscription. A component can observe and command a capability, but it must not outlive, duplicate, or reset the owner's state.

Read [state and reactivity](../state-and-reactivity/) for projection rules and [workspace and navigation](../workspace-and-navigation/) for destination ownership.

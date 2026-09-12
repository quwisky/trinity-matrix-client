---
title: Workspace and navigation
description: Keep semantic destinations, browser URLs, history, and focused conversations under Workspace ownership.
audience: developer
contentChannel: develop
canonicalTopic: architecture-workspace-navigation
pageType: explanation
platforms: [web, desktop, android, ios]
---

Workspace owns Trinity's canonical application destination. Routes are a presentation of that destination, not a competing source of navigation state.

## Navigate semantically {#semantic-navigation}

Call Workspace with an intent such as opening the room list, a room, or settings. The application surface adapter turns the committed destination into an Angular route and translates browser or host navigation back into Workspace state.

Feature libraries do not build URLs for another feature or mutate browser history directly. This keeps deep links, browser Back, native Back, account readiness, and responsive presentation on the same destination model.

## Preserve room-page lifetime {#room-route-lifetime}

The application route table uses one matcher for both `/rooms` and `/rooms/:roomId`. One route object allows Angular's route reuse behavior to retain the Rooms page while the selected room changes. Splitting those URLs into sibling route definitions would recreate the page and its scoped providers.

The room segment is encoded for a path; it is not the raw Matrix room ID. Use the shared Workspace encoding and decoding API rather than duplicating the URL format.

## Coordinate account readiness {#account-readiness}

Startup prepares the selected account's required Room Library projection before Workspace restores a saved destination. Workspace owns the transition from an unavailable or unready account to a committed surface. A component should not race startup by navigating as soon as it sees a client instance.

Conversation Runtime retains the exact account-and-room timeline handle associated with focus and releases the previous handle when focus changes. Workspace chooses the focus; the conversation capability owns its room-bound state.

## Keep route behavior centralized {#route-behavior}

Public authentication routes remain reachable without an account. Product routes use application guards, the empty path redirects to rooms, and the final wildcard recovers stale same-origin navigations. Add route-specific behavior in the composition root and application adapters, not in a reusable component.

Read [capability ownership](../capability-ownership/) for the owner table and [host capabilities](../host-capabilities/) for deep-link and Back integration.

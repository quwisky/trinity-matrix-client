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

Startup does not wait for an account's first sync. The SDK replays its sync cache first, and that cache can be minutes old, so a restored room or space may not be held yet. Workspace keeps both until the account has completed a sync with its homeserver (`MatrixClientService.serverSynced`):

- A room its client does not hold yet is kept, and the conversation decides once the account is live-synced.
- A space is judged by `SelectedRoomLibraryService.spaceAvailability`: `available` when a shown account has joined it, `unconfirmed` while one of those accounts has not synced, and `unavailable` once they all have. An unconfirmed space stays selected and the sidebar reads "Loading space…".
- Workspace watches the selected space for the whole app lifetime. Once it is `unavailable` (the account synced without it, or it was removed, left elsewhere, or its account was unticked in the mixed view), Workspace returns the rail to Recent with a replacing repair and keeps the open room, which is then judged on its own. The watch waits while a transition is in flight, while the app's own leave of that space is in flight, while the view's account is not the active one, and outside `/rooms`.
- A repair is a navigation the person did not make. Workspace marks it with Router `info` (`BACKGROUND_NAVIGATION_INFO` from `@trinity/util/ui`), and the runtime's post-navigation focus handling leaves focus where it is, so typing in the composer continues. When the control that held focus was removed (the space's pill or header goes with the space), focus moves to the nearest landmark that remains, else into the page.

Conversation Runtime retains the exact account-and-room timeline handle associated with focus and releases the previous handle when focus changes. Workspace chooses the focus; the conversation capability owns its room-bound state.

## Keep route behavior centralized {#route-behavior}

Public authentication routes remain reachable without an account. Product routes use application guards, the empty path redirects to rooms, and the final wildcard recovers stale same-origin navigations. Add route-specific behavior in the composition root and application adapters, not in a reusable component.

Read [capability ownership](../capability-ownership/) for the owner table and [host capabilities](../host-capabilities/) for deep-link and Back integration.

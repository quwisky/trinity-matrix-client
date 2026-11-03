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

Startup does not wait for an account's first sync. The SDK replays its sync cache first, and that cache can be minutes old, so a restored room or space may not be held yet:

- A room its client does not hold yet is kept whatever the sync state; the conversation decides once the account is live-synced. Only a room whose client is not live, or whose id is malformed, is repaired.
- A space is judged by `SelectedRoomLibraryService.spaceAvailability`. It is `available` when a shown account has joined it. It is `unconfirmed` while the acting account has not completed a sync with its homeserver (`MatrixClientService.serverSynced`), or while another selected account has not loaded even its sync cache (`MatrixClientService.roomsPrepared`). Otherwise it is `unavailable`. A selected account whose client is not live does not count as holding it. An unconfirmed space stays selected; the sidebar reads "Loading space…" and marks its list busy.
- Workspace watches the selected space for the whole app lifetime (`WorkspaceSpaceRepair`). Once it is `unavailable` (the account synced without it, or it was removed, left elsewhere, or its account was unticked in the mixed view), Workspace returns the rail to Recent with a replacing repair and keeps the open room, which is then judged on its own. The watch waits while a Workspace transition or any Router navigation is in flight, while the app's own leave of that space is in flight, and while the view's account is not the active one. Outside `/rooms` it does nothing; the return restores through the same repair.
- The Inbox is a Workspace scope (`kind: 'inbox'`, `?view=inbox`), like Recent and a space: choosing it adds no history entry. It exists only while Settings' **Show the inbox** is on. `WorkspaceAvailability.inboxShown` reads that preference. A transition or restored destination that names the Inbox with it off lands on Recent, and `WorkspaceSpaceRepair` returns an open Inbox to Recent with a replacing repair when it is turned off. A switch that is unread or failed to read holds its default, on, so the view stays.
- A repair is a navigation the person did not make. Workspace marks it with Router `info` (`BACKGROUND_NAVIGATION_INFO` from `@trinity/util/ui`), and the runtime's post-navigation focus handling leaves focus where it is, so typing in the composer continues. When the control that held focus was removed (the space's pill or header goes with the space), focus moves to the nearest landmark that remains, else into the page.

Conversation Runtime retains the exact account-and-room timeline handle associated with focus and releases the previous handle when focus changes. Workspace chooses the focus; the conversation capability owns its room-bound state.

## Present room panels {#room-panels}

The open room panel (members, the threads list, a thread, pinned messages or search) is part of the Workspace destination, written as `?panel=` and, for a thread, `&root=`. `WorkspaceNavigationService.openPanel` and `closePanel` change it, and history follows the panel: opening one pushes an entry, and Back steps back through them at every width.

Width decides only how the panel is presented, so a resize adds no history:

- From the `members` breakpoint (1100px) up, the panel is a column beside the timeline.
- Between `md` (768px) and `members`, it is a drawer over the timeline, with a backdrop that dismisses it.
- Below `md`, it is a page of its own. It fills the conversation pane under the top safe area, over the room's header, timeline and composer. The room stays mounted and inert underneath, so its scroll position and draft are there on the way back. The panel's header leads with a back arrow in place of the close button. The right-edge swipe still opens the roster.

On iOS, WebKit's edge swipe is a history step. It is on for a panel page pushed over its room (`WorkspaceNavigationService.panelOverRoom`), and off for a panel beside the room, for one restored from a link with no entry below it, and for dialogs. Member info and room settings stay modal at every width.

## Keep route behavior centralized {#route-behavior}

Public authentication routes remain reachable without an account. Product routes use application guards, the empty path redirects to rooms, and the final wildcard recovers stale same-origin navigations. Add route-specific behavior in the composition root and application adapters, not in a reusable component.

Read [capability ownership](../capability-ownership/) for the owner table and [host capabilities](../host-capabilities/) for deep-link and Back integration.

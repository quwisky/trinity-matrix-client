---
status: accepted
---

# Make Workspace authoritative and project it into the URL

Workspace owns one immutable semantic view: Account, sidebar scope, optional Conversation, and
pane. Consumers receive read-only signals derived from that view; they do not reconstruct it from
independent route, Account, Space, and Room signals. Responsive placement is another derived
signal and is deliberately absent from the semantic destination.

The URL is Workspace's canonical projection and an inbound restoration source, not a second state
store. `/rooms` or `/rooms/:room` identifies the optional Conversation; the `account` query
parameter is mandatory in canonical URLs; `view=home|rooms` and `space=:space` identify sidebar
scope; omitting both means Recent; and `pane=list` retains a selected Room while the compact list
pane is showing. Room and Space identifiers use the existing base64url encoding so the same links
work through the PWA and Electron fallbacks. A deep-linked Account overrides Account Runtime's
persisted Active selection. Addressable Workspace coordinates are never recovered from a second
preference store; persistence may fill only non-addressable presentation preferences. Invalid
combinations and unavailable Rooms or Spaces repair to a safe, canonical list destination.

Every transition is a cold, finite RxJS command. It resolves the destination against the exact
Account and writes the canonical URL as Account Runtime preparation, so a rejected route cancels
before the Account commit. It then activates the Account, waits for projection readiness, and only
then publishes the complete view and focuses its Conversation. Once Account commit begins,
Workspace owns the remaining coordination to completion even if its initiating page or route
subscriber disappears. Account Runtime signals that boundary only after adapter preparation
settles, so teardown before the signal cancels the switch and repairs the pre-commit URL. Explicit
user selections and compact-list close push history, while semantic Workspace Back replaces the
current compact surface. Because Router promises are not cancellable, teardown starts an owned
replacement navigation immediately and retains the transition lock until that repair settles;
another destination cannot race the rollback. Restoration, legacy-URL canonicalization, and
repair replace history.
Responsive placement creates no history. This keeps browser Back,
native Back, dialogs, reloads, and compact-layout changes coherent without exposing a half-old
Workspace.

Product navigation crosses Workspace as semantic intent rather than as a caller-built destination.
Account selection, sidebar scope selection, exact Account-and-Room opens, compact-list close, Room
removal, shortcuts, Room hopping, and Workspace Back all use that interface. Workspace derives the
retained scope, Conversation pane, history policy, URL projection, and transition coordination when
the cold command is subscribed. Visit history preserves the exact Account-and-Room pair, so a
shortcut never re-derives ownership from a mixed projection. An exact-current intent therefore completes as
`ready`/`unchanged`, while selecting the retained Room from the compact list is a
`ready`/`committed` pane transition. Account, route, and in-flight conflicts are normalized into
typed `unavailable` reasons; Router booleans and legacy destinations do not cross the semantic
interface.

Global Search, local-notification activation, native-push activation, and inbound URL restoration
use the same command. Conversation and Space results retain exact Account ownership; person and
invitation results complete their Account-scoped create or join work before opening the ready
destination. Notification activation carries an optional event anchor through Workspace's
canonical URL projection. Repeating the same anchor in the already-open Room republishes a fresh
event target without treating unchanged Router state as failure. Application Runtime submits only
the host-neutral intent. When the lazy Room shell is absent, a composition adapter mounts it without
changing browser location, then the registered Workspace implementation performs the transition.

During the incremental migration, the destination-based `open` seam has zero production callers
outside Workspace. `scripts/workspace-navigation-contract.spec.mjs` freezes that empty allowlist.
Issue #368 migrated the final search and activation/restoration callers; issue #369 deletes the
remaining package-internal destination and page-scoped transition implementation.

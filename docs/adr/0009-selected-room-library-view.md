---
status: accepted
---

# Room Library owns one selected-Account view

Room Library publishes one `SelectedRoomLibraryView` containing the effective Account set, its
active or mixed mode, and the Room, Space, and invitation rows derived for that set. Consumers read
that record instead of choosing between active and mixed projections. Local search, Room-shell
presentation, shortcuts, and Room actions all consume the selected generation or the exact row
identity emitted from it.

The active Account is always present. Persisted Account identifiers remain stored when their
accounts are temporarily absent, but only live Account identifiers contribute rows. A one-Account
selection reads the existing active projections directly and attaches no additional Matrix
listeners. More than one Account is projected directly behind the selected view. One internal
Account-source registry owns live-set reconciliation, same-id client replacement, and listener
attachment and detachment; Room, Space, and invitation projectors own only domain policy.

Room identity is exact. A Room shared by selected Accounts renders once, prefers the active
Account as its action identity, retains every contributing Account, and carries the loudest unread
and highlight state. A shared Space likewise prefers the active Account and unions the joined
child Room identifiers from every contributing Account. The view separately preserves each
Account's space-child membership, so a deduplicated Room's winning Account decides whether it is
filed under a Space or remains in the flat Rooms list. Invitations are not deduplicated across
Accounts: membership is Account-specific, so every selected Account's pending invitation remains
visible with its exact owner.

The selected Account set is an installation-scoped, private, non-portable Room Library preference.
Its existing `trinity.accounts.mixed` value migrates into the typed preference envelope in place.
Preference writes are cold and finite, publish only after durable storage succeeds, and return
typed recovery when storage is unavailable. A failed write therefore leaves the prior effective
view visible instead of briefly publishing an unpersisted selection.

This completes the contract step of ADR-0007. Room-shell presentation and action lookup read one
selected generation, and page-level Account fan-out is gone. Visible Room and invitation rows carry
their exact Account identity; shared-row read, notification, favourite, and priority writes dedupe
and target every contributing Account. Async create, join, permalink, and confirmed-membership
flows retain the Account that began the action rather than re-reading Active Account on completion.
The three legacy mixed services and their public exports are removed. The source contract rejects
their files, symbols, exports, page fan-out, and direct active-projection reads from the Room-shell
view model. Shared SDK events attach once per selected Account, domain-specific invalidation is
coalesced, and unaffected projection slices retain their identity.

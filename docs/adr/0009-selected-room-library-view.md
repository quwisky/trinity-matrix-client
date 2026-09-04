---
status: accepted
---

# Room Library owns one selected-Account view

Room Library publishes one `SelectedRoomLibraryView` containing the effective Account set, its
active or mixed mode, and the Room, Space, and invitation rows derived for that set. Consumers read
that record instead of choosing between active and mixed projections. Local search and the complete
Room-shell list presentation are migrated consumers; action paths migrate in the next increment.

The active Account is always present. Persisted Account identifiers remain stored when their
accounts are temporarily absent, but only live Account identifiers contribute rows. A one-Account
selection reads the existing active projections directly, avoiding both duplicate listeners and
the intentionally empty mixed projection. More than one Account drives the existing mixed
projectors from one selection observer owned by the selected view.

Room identity is exact. A Room shared by selected Accounts renders once, prefers the active
Account as its action identity, retains every contributing Account, and carries the loudest unread
and highlight state. A shared Space likewise prefers the active Account and unions the joined
child Room identifiers from every contributing Account. Invitations are not deduplicated across
Accounts: membership is Account-specific, so every selected Account's pending invitation remains
visible with its exact owner.

The selected Account set is an installation-scoped, private, non-portable Room Library preference.
Its existing `trinity.accounts.mixed` value migrates into the typed preference envelope in place.
Preference writes are cold and finite, publish only after durable storage succeeds, and return
typed recovery when storage is unavailable. A failed write therefore leaves the prior effective
view visible instead of briefly publishing an unpersisted selection.

This follows the expand step of ADR-0007. Room-shell presentation now reads one selected generation,
and page-level Account fan-out is gone. Two action and shortcut files still import a legacy mixed
projector; a source contract freezes that reduced allowlist. The next increment moves those actions
to the selected view, and the contract step removes all three public mixed services.

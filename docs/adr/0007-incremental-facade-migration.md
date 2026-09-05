---
status: accepted
---

# Migrate through temporary facades instead of a rewrite

The architecture changes through continuously shippable expand-migrate-contract slices rather than a clean rewrite. A compatibility facade has a frozen caller allowlist, no new public exports, an owning removal issue, counters and parity tests; it is deleted when its callers reach zero, preserving user flows, routes, persisted Accounts, encrypted storage, and host bridges throughout the migration.

The Room-surface sequence is contracted. All callers, including test setup, use semantic
transitions; the lifecycle constructs surface records and keeps panel, return-origin, and jump
state private. Its public signals describe presentation only. Type contracts and structural
guards enforce zero compatibility callers and prevent generic state setters from returning.

---
status: accepted
---

# Keep the Matrix SDK authoritative for protocol state

The Matrix SDK remains the source of truth for Rooms, timelines, membership, local echoes, and encryption state. Trinity projects normalized, read-only views from SDK state instead of maintaining a parallel Redux-style store, avoiding reconciliation races and duplicated persistence while keeping SDK objects behind Matrix adapters.

## Current guidance

This decision records its accepted context. See the current developer guides for implemented boundaries.

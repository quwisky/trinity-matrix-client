---
name: project-trinity-matrix
description: Trinity Matrix client — Nx monorepo, Angular 20 standalone + Ionic 8, Matrix (matrix-js-sdk) chat client with E2EE
metadata:
  type: project
---

Trinity is a Matrix chat client (Discord-style UI) built as an Nx monorepo.

- **Stack:** Angular 20 (standalone components, signals, `ChangeDetectionStrategy.OnPush` everywhere), Ionic 8 standalone components, Capacitor for native, matrix-js-sdk with Rust crypto WASM for E2EE.
- **Layout:** `apps/trinity` is the shell; feature libs are `libs/feature-auth`, `libs/feature-rooms`, `libs/feature-crypto`; shared logic lives in `libs/core` (exported as `@trinity/core`).
- **Module boundary rule:** feature libs must NOT depend on each other — only on `@trinity/core`. (E.g. encryption-banner lives in feature-rooms, not feature-crypto, to respect this.)
- **Core services** (in `libs/core/src/lib/matrix/`): `AuthService`, `MatrixClientService`, `RoomsService`, `TimelineService`, `CryptoService`, `CryptoSpikeService`. RoomsService/CryptoService `connect()` are idempotent (guarded by a private `connected` flag).
- **Crypto bootstrap milestone** is recent active work (see git log ~2026-06): crypto status signals, setup (flow A) + recovery (flow B) flows.
- **Dev spike:** `/spike` route (home.page) is a dev-only E2EE harness, not production UI.

**Why:** Helps scope reviews — feature libs are the UI layer; correctness of data flow depends on core service contracts.
**How to apply:** When reviewing UI, verify against core service signatures rather than assuming. Respect the no-feature-to-feature dependency rule when suggesting refactors.

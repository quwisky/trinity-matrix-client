---
name: crypto-bootstrap-ui
description: Trust model & conventions of the Milestone 3 crypto bootstrap UI (feature-crypto) — recovery-key/password lifetime, authGuard scope
metadata:
  type: project
---

Milestone 3 "Crypto Bootstrap" UI lives in `libs/feature-crypto` (setup +
unlock pages, recovery-key-display component) and `libs/feature-rooms`
(encryption-banner). Audited 2026-06-27.

Conventions confirmed sound:
- Recovery key held only in a component `signal<string|null>` for the setup
  view; never persisted, never logged, never put in URL/router state.
- Error surfacing is `{{ error() }}` text interpolation only — no `innerHTML`,
  `[innerHTML]`, `bypassSecurityTrust*`, `eval`, or dynamic templates anywhere
  in these templates.
- UIA password prompt uses Ionic `AlertController` with `type:'password'`;
  static `message`/`header` strings (no interpolation of untrusted data).
  Cancel resolves `null` which aborts setup.
- Clipboard copy guards for absent `navigator.clipboard`. Download revokes the
  object URL synchronously after `anchor.click()`.

**authGuard** (`libs/core/.../guards/auth.guard.ts`) only checks that a Matrix
client is live / restorable — it is the SAME guard on /rooms, /encryption/setup
and /encryption/unlock. It does NOT gate on `CryptoService.status`, so the
crypto pages are reachable directly by URL in any crypto state. The actual
authorization is server-side (Matrix UIA + 4S), so this is acceptable; the
client guard is UX, not a security boundary.

**Why:** This is the trust model for E2EE onboarding; future crypto UI work
should preserve the transient-secret and text-only-error conventions.

**How to apply:** When reviewing changes to these pages, flag any new
persistence of the recovery key/password, any switch to innerHTML/sanitizer
bypass for errors, and any router-state passing of the key. See
[[secret-token-storage]].

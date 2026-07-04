# Codebase Review — 2026-07-04

A whole-codebase review of the Trinity Matrix client after the spartan-ng migration
and the media / threads / spaces / settings features — superseding the Milestone-3
review (in git history). Conducted across eight areas (core sync, core
timeline/media, core crypto/security, feature-rooms, feature-crypto/auth/settings,
shared UI, app-shell + Electron, and a cross-cutting tests/a11y/perf sweep) over
~16k LOC, excluding the vendored `libs/spartan/*` Helm code.

> Method: a multi-agent fan-out — one reviewer per area, then **adversarial
> per-finding verification** (each finding re-checked against source by a separate
> skeptic instructed to refute it). 27 raw findings → 5 refuted → **22 confirmed**.
> No critical or high-severity issue survived verification.
>
> Status snapshot, not a living spec. Line numbers are accurate as of commit
> `ea3ae14`; the items marked _(fixed)_ were addressed immediately after and have
> regression tests.

## Verdict

A disciplined, security-conscious codebase. Layering holds (no `matrix-js-sdk`
leakage past `@trinity/core`), the signals-on-services + cold-Observables +
`takeUntilDestroyed` pattern is applied consistently, secret handling is careful,
and no secrets are committed. The findings are mostly medium/low correctness and
accessibility polish, plus a few test-coverage gaps on critical paths.

## Strengths (don't regress these)

- **Crypto/secret handling.** The 4S recovery key is held in-memory only and zeroed
  on teardown (`SecretStorageKeyService.clear` fills the buffer, wired into every
  `MatrixClientService` reset/init path); the access token is routed to
  keychain/`safeStorage` while non-secret session fields go to Preferences.
- **Monotonic-generation guards** against stale async writes across
  `CryptoService.computeStatus`, `DevicesService.loadDevices`, and the client
  teardown/wipe race — a genuinely hard class of bug handled well.
- **SSO login CSRF** is handled properly: a `crypto.getRandomValues` nonce is
  round-tripped through TTL-boxed single-use Preferences state and strictly compared
  on the callback, with the `loginToken` stripped from history.
- **Untrusted federated `formatted_body`** is scrubbed in `message-view.ts` (tag +
  attribute allowlist, remote-`img` stripping) and covered by hostile-input tests;
  the notification path defers ciphertext to `MatrixEventEvent.Decrypted` and
  re-scores push rules on cleartext (no content-leak previews, no missed mentions).
- **Electron hardening.** `contextIsolation`/`sandbox` on, `nodeIntegration` off, a
  minimal `contextBridge` preload that never leaks `ipcRenderer`/Node, every IPC
  handler validates `event.sender`, a prefix-safe path-traversal guard on the custom
  file scheme, and locked-down `setWindowOpenHandler` / `will-navigate`.

---

## 🟡 Medium

**Correctness**

- [x] **Edit/reply target leaks across a room switch** _(fixed)_ —
      [message-list.component.ts](../libs/feature-rooms/src/lib/message-list/message-list.component.ts).
      The list instance is reused across rooms (it stays mounted under `@if activeRoom`),
      so `editingId`/`replyingToId`/`lastId` weren't reset. Replying in room A then
      switching to B and sending a plain message shipped it as an `m.in_reply_to` a
      cross-room event; the stale `lastId` also announced B's newest message to screen
      readers as if it were live. _Fixed_ via a `roomId` input + a reset effect (declared
      first so it runs before the anchoring effect).
- [x] **Composer keeps a stale draft when the edit target changes mid-edit** _(fixed)_
      — [message-composer.component.ts](../libs/feature-rooms/src/lib/message-composer/message-composer.component.ts).
      The prefill effect only fired on the false→true edge of `editing()`, so re-targeting
      Edit A → Edit B (without saving) left A's text in the field — Enter overwrote B with
      A's body. _Fixed_ so the effect re-fills when the target's `draft` changes.
- [x] **Authenticated-media probe is never invalidated across an account/homeserver
      switch** _(fixed)_ — [media.service.ts:398](../libs/core/src/lib/matrix/media.service.ts).
      `supportsAuthedMedia()` memoizes `isVersionSupported('v1.11')` on the root singleton;
      `releaseAll()` clears the blob cache but leaves it. Log out of a legacy homeserver
      → into an authed-media-only one, and every image/file/video/audio 401s for the whole
      session (no legacy→authed fallback). _Fix: reset `authedMedia` in `releaseAll()` and
      call `media.releaseAll()` on logout/login alongside `avatars.releaseAll()`._
- [x] **Timeline force-scrolls to the bottom on every incoming message** _(fixed)_ —
      [message-list.component.ts:185](../libs/feature-rooms/src/lib/message-list/message-list.component.ts).
      `stickToBottom` has no "is the user near the bottom?" gate, so a message arriving
      while the user reads scrollback yanks them down. _Fix: capture proximity to the
      bottom before the DOM update and only auto-stick when the user was already there._

**Accessibility**

- [x] **Three crypto/verification routed pages render two `<h1>`s** _(fixed)_ —
      `encryption-setup`, `encryption-unlock`, `device-verification`. Each rendered the
      `trn-page-header` `<h1>` plus a content `<h1 class="heading">`. _Fixed_ by demoting
      the content headings to `<h2>` (styled by class, so unchanged visually); the shared
      `#body` templates stay consistent in the modal branch too.
- [x] **Media lightbox has no keyboard/focus management** _(fixed)_ —
      [media-attachment.component.ts:44](../libs/feature-rooms/src/lib/media-attachment/media-attachment.component.ts).
      A hand-rolled `role="dialog" aria-modal="true"` closed only on backdrop click. _Fixed_
      with Escape-to-close, focus-into-dialog on open, and focus-restore to the trigger on
      close. (A full focus trap / CDK-Dialog migration remains a possible follow-up.)

**Test coverage**

- [x] **`AuthService` had zero unit tests** _(fixed)_ —
      [auth.service.ts](../libs/core/src/lib/matrix/auth.service.ts). Added
      `auth.service.spec.ts` covering discovery (base-url + trailing-slash strip, the
      `https://<domain>` fallback, MXID → domain extraction, failed-discovery throw) and
      SSO-URL building, mocking `AutoDiscovery`/`createClient`. Password/token login and
      logout still lean on the SDK and could grow further coverage.

## 🟢 Low / polish

**Security**

- [ ] **Access token can persist to plaintext with no user-visible signal** _(deferred —
      needs a UX call on where/how to surface the warning)_ —
      [secure-storage.service.ts:117](../libs/core/src/lib/storage/secure-storage.service.ts).
      `select()` falls back to the web backend (Preferences/localStorage, `isSecure:false`)
      on desktop too when `safeStorage`/keyring is unavailable; `isSecure()` is computed but
      never surfaced. _Fix: warn at login (or gate "remember me") when the resolved backend
      is insecure._
- [x] **`SecretStorageKeyService.set()` didn't zero the previous 4S buffer** _(fixed)_
      — [secret-storage-key.service.ts:23](../libs/core/src/lib/matrix/secret-storage-key.service.ts).
      `clear()` zeroes the key, but `set()` reassigns without wiping the buffer it replaces
      when the key is set more than once during bootstrap/recovery. _Fix: `this.privateKey?.fill(0)`
      before reassigning._

**Correctness**

- [x] **`registerAppProtocol` can throw a `URIError` outside its try/catch** _(fixed)_
      — [electron/src/scheme.ts:91](../electron/src/scheme.ts). `decodeURIComponent(pathname)`
      ran before the try; `trinity://app/%` rejected the handler. _Fixed_ by guarding the
      decode and returning a 400.
- [x] **`verification-host` could open two modals** _(fixed)_ —
      [verification-host.component.ts:42](../apps/trinity/src/app/verification-host.component.ts).
      `this.ref` (a plain field, not a signal) is set only after `await import(...)`, so two
      effect runs during the dynamic import can both enter `present()`. _Fix: set a
      synchronous in-flight guard before awaiting._

**Accessibility**

- [x] **Server rail: active space/Home not exposed to assistive tech** _(fixed)_ —
      [server-rail.component.ts:35](../libs/feature-rooms/src/lib/server-rail/server-rail.component.ts).
      Selection is conveyed only visually. _Fix: add `aria-current` to the active pill._
- [x] **Reaction toolbar lacked name + control association** _(fixed)_ —
      [message-toolbar.component.html:16](../libs/ui/src/lib/message-toolbar/message-toolbar.component.html).
      No `aria-label`, no `aria-controls`/focus management on the picker toggle.
- [x] **Inline `<audio>`/`<video>` had no accessible name** _(fixed)_ —
      [media-bubble.component.ts:57](../libs/ui/src/lib/media-bubble/media-bubble.component.ts).
      _Fix: `[attr.aria-label]="filename()"` on the media elements._

**Performance**

- [x] **`pendingDecryption` grew unbounded for permanent UTDs** _(fixed)_ —
      [notification.service.ts:84](../libs/core/src/lib/matrix/notification.service.ts).
      Events that never decrypt are never evicted. _Fix: cap/evict like `notified`._
- [ ] **No timeline virtualization** _(plausible; deferred — a substantial feature
      needing its own design + perf pass)_ —
      [message-list.component.html:10](../libs/feature-rooms/src/lib/message-list/message-list.component.html).
      Every loaded event stays in the DOM; long rooms + backfill accumulate hundreds of
      rows. _Fix: CDK Virtual Scroll with an auto/dynamic item-size strategy._

**Test coverage**

- [x] **`authGuard` had no unit test** _(fixed)_ —
      [auth.guard.ts](../libs/core/src/lib/guards/auth.guard.ts). Added `auth.guard.spec.ts`
      covering the already-initialized short-circuit, session-restore, no-session redirect,
      and init-failure→`/login` branches.
- [ ] **Security-critical Electron modules have no tests** _(deferred — Electron test
      harness is a separate setup)_ —
      `scheme.ts` (path-traversal), `window.ts` (nav hardening), `deep-link.ts` (scheme
      validation). Only `notification-payload` and `secure-store` have specs.

## Remaining (open)

Everything above except three items has been fixed (with tests where testable):

- **Access-token plaintext warning** — needs a UX decision on where/how to surface the
  insecure-backend signal at login.
- **Timeline virtualization** — a substantial feature; warrants its own design + perf pass.
- **Electron module tests** — worth adding, but the Electron test harness is separate setup.

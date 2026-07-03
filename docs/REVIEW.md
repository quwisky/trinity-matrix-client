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
- [ ] **Authenticated-media probe is never invalidated across an account/homeserver
      switch** — [media.service.ts:398](../libs/core/src/lib/matrix/media.service.ts).
      `supportsAuthedMedia()` memoizes `isVersionSupported('v1.11')` on the root singleton;
      `releaseAll()` clears the blob cache but leaves it. Log out of a legacy homeserver
      → into an authed-media-only one, and every image/file/video/audio 401s for the whole
      session (no legacy→authed fallback). _Fix: reset `authedMedia` in `releaseAll()` and
      call `media.releaseAll()` on logout/login alongside `avatars.releaseAll()`._
- [ ] **Timeline force-scrolls to the bottom on every incoming message** —
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
- [ ] **Media lightbox has no keyboard/focus management** —
      [media-attachment.component.ts:44](../libs/feature-rooms/src/lib/media-attachment/media-attachment.component.ts).
      A hand-rolled `role="dialog" aria-modal="true"` closes only on backdrop click — no
      Escape, no focus move/trap/restore. _Fix: add Escape + focus management, or present
      it through `TrnDialogService` (CDK Dialog gives all three for free)._

**Test coverage**

- [ ] **`AuthService` has zero unit tests** —
      [auth.service.ts](../libs/core/src/lib/matrix/auth.service.ts). Discovery (with
      fallback and slash-strip), MXID localpart extraction, password login, SSO
      URL/token exchange, and logout are only ever mocked. _Fix: add
      `auth.service.spec.ts` with a mocked `createClient`/`AutoDiscovery`._

## 🟢 Low / polish

**Security**

- [ ] **Access token can persist to plaintext with no user-visible signal** —
      [secure-storage.service.ts:117](../libs/core/src/lib/storage/secure-storage.service.ts).
      `select()` falls back to the web backend (Preferences/localStorage, `isSecure:false`)
      on desktop too when `safeStorage`/keyring is unavailable; `isSecure()` is computed but
      never surfaced. _Fix: warn at login (or gate "remember me") when the resolved backend
      is insecure._
- [ ] **`SecretStorageKeyService.set()` doesn't zero the previous 4S buffer** _(plausible)_
      — [secret-storage-key.service.ts:23](../libs/core/src/lib/matrix/secret-storage-key.service.ts).
      `clear()` zeroes the key, but `set()` reassigns without wiping the buffer it replaces
      when the key is set more than once during bootstrap/recovery. _Fix: `this.privateKey?.fill(0)`
      before reassigning._

**Correctness**

- [x] **`registerAppProtocol` can throw a `URIError` outside its try/catch** _(fixed)_
      — [electron/src/scheme.ts:91](../electron/src/scheme.ts). `decodeURIComponent(pathname)`
      ran before the try; `trinity://app/%` rejected the handler. _Fixed_ by guarding the
      decode and returning a 400.
- [ ] **`verification-host` can open two modals** _(plausible)_ —
      [verification-host.component.ts:42](../apps/trinity/src/app/verification-host.component.ts).
      `this.ref` (a plain field, not a signal) is set only after `await import(...)`, so two
      effect runs during the dynamic import can both enter `present()`. _Fix: set a
      synchronous in-flight guard before awaiting._

**Accessibility**

- [ ] **Server rail: active space/Home not exposed to assistive tech** —
      [server-rail.component.ts:35](../libs/feature-rooms/src/lib/server-rail/server-rail.component.ts).
      Selection is conveyed only visually. _Fix: add `aria-current` to the active pill._
- [ ] **Reaction toolbar lacks name + control association** —
      [message-toolbar.component.html:16](../libs/ui/src/lib/message-toolbar/message-toolbar.component.html).
      No `aria-label`, no `aria-controls`/focus management on the picker toggle.
- [ ] **Inline `<audio>`/`<video>` have no accessible name** —
      [media-bubble.component.ts:57](../libs/ui/src/lib/media-bubble/media-bubble.component.ts).
      _Fix: `[attr.aria-label]="filename()"` on the media elements._

**Performance**

- [ ] **`pendingDecryption` grows unbounded for permanent UTDs** —
      [notification.service.ts:84](../libs/core/src/lib/matrix/notification.service.ts).
      Events that never decrypt are never evicted. _Fix: cap/evict like `notified`._
- [ ] **No timeline virtualization** _(plausible)_ —
      [message-list.component.html:10](../libs/feature-rooms/src/lib/message-list/message-list.component.html).
      Every loaded event stays in the DOM; long rooms + backfill accumulate hundreds of
      rows. _Fix: CDK Virtual Scroll with an auto/dynamic item-size strategy._

**Test coverage**

- [ ] **`authGuard` has no unit test** —
      [auth.guard.ts](../libs/core/src/lib/guards/auth.guard.ts). The already-initialized
      short-circuit, session-restore, and init-failure→`/login` branches are untested.
- [ ] **Security-critical Electron modules have no tests** —
      `scheme.ts` (path-traversal), `window.ts` (nav hardening), `deep-link.ts` (scheme
      validation). Only `notification-payload` and `secure-store` have specs.

## Recommended order

1. **Authed-media reset** (Medium correctness) — one-line singleton reset + two call
   sites; unblocks all media on a homeserver switch.
2. **Timeline auto-scroll gating** (Medium correctness) — proximity check before
   force-scroll; high day-to-day annoyance.
3. **Media lightbox a11y** (Medium) — route it through `TrnDialogService`.
4. **`AuthService` + `authGuard` tests** (Medium/Low coverage) — critical, currently
   untested paths.
5. The remaining Low items as polish.

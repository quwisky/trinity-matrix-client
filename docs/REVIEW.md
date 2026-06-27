# Codebase Review — 2026-06-27

A whole-codebase review of the Trinity Matrix client at the close of Milestone 3
(crypto bootstrap). Conducted across five lenses — `libs/core` correctness, UI-layer
correctness, security, accessibility/UX, and architecture — over ~5,800 LOC.

> Status snapshot. Check items off as they're addressed; this is a point-in-time
> audit, not a living spec. Line numbers are accurate as of commit
> `d1ff1c7`.

## Verdict

A well-disciplined codebase, not a rescue job. Layering holds (no `matrix-js-sdk`
leakage past `@trinity/core`), the signals-on-services + cold-Observables pattern is
applied consistently, every subscription uses `takeUntilDestroyed`, recovery-key
handling is exemplary, the Nx module boundaries are coherent, and **no secrets are
committed**. The findings below are about where the discipline bends under growth,
plus a handful of concrete bugs.

The two 🔴 items and the timeline bugs in 🟠 #4 were **verified against source**; the
rest are reviewer findings worth confirming during the fix.

## Strengths (don't regress these)

- Clean SDK seam: view models (`RoomSummary`, `MessageView`) are plain interfaces; the
  SDK never leaks past the read layer.
- Consistent async discipline: cold Observables via `defer`/`from`, `takeUntilDestroyed`
  on every subscribe, the shared `withBusy()` busy/error helper.
- [recovery-key-display.component.ts](../libs/feature-crypto/src/lib/recovery-key-display/recovery-key-display.component.ts)
  is exemplary: live-region announcements, manual-copy fallback, object-URL teardown,
  deliberate non-labeling so the key text is read.
- [encryption-setup.page.ts](../libs/feature-crypto/src/lib/encryption-setup/encryption-setup.page.ts)
  focus management; `encryption-banner` scopes its live region to the message.
- No committed secrets; `authGuard` correctly treated as UX, not a security boundary.

---

## 🔴 Critical

- [x] **`connect()` goes permanently stale after logout→login** _(verified; fixed)_ —
      [rooms.service.ts:78](../libs/core/src/lib/matrix/rooms.service.ts#L78),
      [crypto.service.ts:72](../libs/core/src/lib/matrix/crypto.service.ts#L72). The
      `connected` flag lives on the root singleton and is never reset; listeners are
      attached with inline closures ([rooms.service.ts:80](../libs/core/src/lib/matrix/rooms.service.ts#L80))
      to a `MatrixClient` that `teardown()` discards on logout. After re-login `connect()`
      early-returns, the new client gets no listeners, and the sidebar/rooms/crypto-status
      signals freeze until a full reload. Latent today (the routed shell remounts) but
      activates the moment account-switching / token-refresh re-init / reconnect lands.
      **Fix:** move client-scoped wiring into `MatrixClientService.init/teardown` so the
      connection lifecycle follows the client; or add a `disconnect()` that `.off()`s and
      resets the flag — which requires stable handler refs, not inline closures.

- [ ] **Message-list backfill stall-guard is fragile** —
      [message-list.component.ts:92-148](../libs/feature-rooms/src/lib/message-list/message-list.component.ts#L92-L148).
      The scroll `effect()` reads and (via `loadOlder.emit()`) triggers writes to
      `messages`/`loadingOlder`; the only thing preventing an infinite `/messages` loop is
      a `length`-based guard that mis-fires when a backfill returns the same count but
      different content (redaction/dedup) — either spinning the homeserver or silently
      stopping pagination on a short room. **Fix:** track the oldest message id / a
      service-provided token instead of `length`; add a hard iteration cap and a spec for
      "same length, different content." Prefer `afterRenderEffect` for read-measure-write.

## 🟠 High

- [ ] **Inbound Matrix HTML: defended but only implicitly, and no CSP** —
      [timeline.service.ts:513](../libs/core/src/lib/matrix/timeline.service.ts#L513) →
      [message-list.component.html:50](../libs/feature-rooms/src/lib/message-list/message-list.component.html#L50).
      Federated `formatted_body` renders via `[innerHTML]`. **Not currently exploitable**
      (`row.html` is a plain string, never `bypassSecurityTrust*`, so Angular sanitizes at
      bind) — but the sole defense is one implicit framework behavior with no CSP behind
      it, and a comment claiming it's "sanitized." A future `bypassSecurityTrustHtml`
      silently makes it wormable stored-XSS. **Fix:** explicit DOMPurify with a Matrix
      allowlist in `renderBody()`; add a CSP `<meta>` in
      [index.html](../apps/trinity/src/index.html) (account for Ionic runtime styles, the
      user-chosen homeserver `connect-src`, and `wasm-unsafe-eval` for the crypto WASM);
      add a lint guard forbidding sanitizer bypass on message HTML.

- [x] **Two timeline reliability bugs** _(verified; fixed)_ —
      (a) [timeline.service.ts:150-159](../libs/core/src/lib/matrix/timeline.service.ts#L150-L159):
      `_loadingOlder` resets only on success, so one failed `scrollback` permanently
      disables pagination for that room — wrap in `finalize`.
      (b) [timeline.service.ts:127](../libs/core/src/lib/matrix/timeline.service.ts#L127):
      `void client.sendReadReceipt(last)` throws an unhandled rejection when the latest
      event is a pending local echo — skip pending events and add `.catch()`. Apply the
      same `.catch()` discipline to `resendEvent` in `retry()`.

- [ ] **Silent failure of edit / delete / react / reply** —
      [rooms.page.ts:161-187](../libs/feature-rooms/src/lib/rooms/rooms.page.ts#L161-L187).
      These `.subscribe()` with no error handler and (unlike `send`) no optimistic echo, so
      a failed delete/reaction looks like a no-op. **Fix:** surface errors (Ionic
      `ToastController` / inline).

- [ ] **Keyboard & touch accessibility largely absent app-wide** — no `:focus-visible`
      on any custom control (the `interactive-row` mixin defines only `:hover`;
      `.composer__input` does `outline: none`), and the message toolbar
      (reply/edit/delete/react) is hover-only with `pointer-events: none`
      ([message-list.component.scss:55-68](../libs/feature-rooms/src/lib/message-list/message-list.component.scss#L55-L68))
      → unreachable on touch (a stated mobile target) and keyboard. **Fix:** add a
      `:focus-visible` baseline (reuse `--trinity-accent`) to the mixin + standalone button
      classes, and a tap/long-press → action-sheet path for message actions.

## 🟡 Medium

- [ ] **feature-auth has zero tests** — the riskiest flow (discovery, SSO callback
      handshake, login→persist→init) is the only lib without a test target. Add the Vitest
      triad (`vite.config.ts` + `test-setup.ts` + `tsconfig.spec.json` + test target) and
      cover the discover→flows state machine and the SSO callback completion.
- [ ] **Dev `/spike` route + `CryptoSpikeService` ship in production** —
      [app.routes.ts:34](../apps/trinity/src/app/app.routes.ts#L34) (unguarded) and exported
      from the core barrel ([index.ts](../libs/core/src/index.ts)). Gate behind
      `environment.production` (the app already has fileReplacements) or remove now that
      crypto is real; drop the spike service + `crypto-wasm-loader` from the barrel.
- [ ] **Missing `type:ui` shared layer** — `EncryptionBannerComponent` is exiled into
      feature-rooms because feature→feature deps are banned; that's the canary. Before M7
      (device verification) and M8 (media) add more cross-feature UI, extract presentational
      pieces (avatar, emoji-picker, a dumb banner shell) into a `type:ui` lib and split
      container vs presentational components.
- [ ] **SSO `loginToken` left in the callback URL** —
      [sso-callback.page.ts:51](../libs/feature-auth/src/lib/sso-callback/sso-callback.page.ts#L51).
      Strip it on entry (covers the error path) and set a `no-referrer` policy. Separately:
      the native deep-link path (`eu.qwky.trinity://`) needs state/nonce + baseUrl
      verification and App/Universal Links before it's wired (latent login-CSRF/fixation).
- [ ] **Crypto IndexedDB store not cleared on logout** —
      [matrix-client.service.ts](../libs/core/src/lib/matrix/matrix-client.service.ts) /
      [auth.service.ts](../libs/core/src/lib/matrix/auth.service.ts). Prior account's key
      material persists on disk; clear it on `logout` (not plain `stop`).
- [ ] **`window.confirm` for delete** —
      [message-list.component.ts:208](../libs/feature-rooms/src/lib/message-list/message-list.component.ts#L208).
      Use Ionic `AlertController` for theme/consistency (the codebase already does elsewhere).
- [ ] **`encryption-setup` focus `effect()` fires on any dependency change** —
      [encryption-setup.page.ts:73-77](../libs/feature-crypto/src/lib/encryption-setup/encryption-setup.page.ts#L73-L77).
      Guard to a one-shot so it can't steal focus mid-interaction.
- [ ] **vite-tsconfig-paths drift** — core's
      [vite.config.ts](../libs/core/vite.config.ts) omits `projects: ['tsconfig.base.json']`
      (correct only by accident today). Make all three configs identical to prevent a silent
      future spec-resolution failure.
- [ ] **Access token in `localStorage` on web** —
      [session-storage.service.ts:19](../libs/core/src/lib/storage/session-storage.service.ts#L19).
      Inherent Capacitor tradeoff (native uses OS storage); contain via the CSP +
      sanitization above rather than re-architecting. Document, and consider refresh-token /
      at-rest encryption only if the threat model warrants.

## 🟢 Low / polish

- [ ] No `<h1>` / heading hierarchy on login and the active-chat view (crypto pages do
      it right).
- [ ] Busy/loading states not announced (`aria-live`); new incoming messages not
      announced.
- [ ] Decryption-failure & redacted messages need a clearer, labeled accessible
      treatment (reuse the `.warning` pattern); link decryption failures to
      `/encryption/unlock`.
- [ ] `escapeHtml` doesn't escape single quotes
      ([timeline.service.ts:569](../libs/core/src/lib/matrix/timeline.service.ts#L569)) —
      harmless today (double-quoted attrs) but add for robustness.
- [ ] Unlock recovery-key signal not cleared after success
      ([encryption-unlock.page.ts](../libs/feature-crypto/src/lib/encryption-unlock/encryption-unlock.page.ts)) —
      mirror the setup page.
- [ ] Reply-preview connector uses literal `gray`, not a token
      ([message-list.component.scss:121](../libs/feature-rooms/src/lib/message-list/message-list.component.scss#L121)).
- [ ] No `prefers-reduced-motion` handling (smooth-scroll + transitions).
- [ ] No composer send button (Enter-only) — poor mobile discoverability.
- [ ] `withBusy()` duplicated across login + both crypto pages — extract.
- [ ] Editable-message predicate duplicated 3× in message-list — extract `isEditable(m)`.
- [ ] No Nx caching on `test` targets (`nx:run-commands`, no inputs/outputs).
- [ ] Run `pnpm audit` (couldn't run in a read-only pass) to triage `matrix-js-sdk` /
      `marked` / transitive advisories.

## Needs human visual verification

- Contrast of `--trinity-text-muted` (#949ba4) at 10–12px, and white-on-blurple banner
  text/button.
- Mobile reflow of the encryption banner (icon + text + button) and the composer with a
  long room name.
- The member list is `display:none` below 1100px with **no alternate access on phones**.
- Toolbar position (`top:-16px`) clipping above the scroll container on the first
  message.

## Recommended order

1. `connect()` lifecycle fix (🔴 #1).
2. Timeline `finalize` + read-receipt `.catch` (🟠 #4).
3. Explicit HTML sanitization + CSP (🟠 #3).
4. Surface edit/delete/react errors (🟠 #5).
5. `:focus-visible` baseline + touch path for message actions (🟠 #6).
6. Gate/remove `/spike` (🟡).
7. feature-auth tests (🟡).

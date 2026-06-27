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

- [x] **Message-list backfill stall-guard is fragile** _(fixed)_ —
      [message-list.component.ts:92-148](../libs/feature-rooms/src/lib/message-list/message-list.component.ts#L92-L148).
      The scroll `effect()` reads and (via `loadOlder.emit()`) triggers writes to
      `messages`/`loadingOlder`; the only thing preventing an infinite `/messages` loop is
      a `length`-based guard that mis-fires when a backfill returns the same count but
      different content (redaction/dedup) — either spinning the homeserver or silently
      stopping pagination on a short room. **Fix:** track the oldest message id / a
      service-provided token instead of `length`; add a hard iteration cap and a spec for
      "same length, different content." Prefer `afterRenderEffect` for read-measure-write.

## 🟠 High

- [x] **Inbound Matrix HTML: defended but only implicitly, and no CSP** _(fixed)_ —
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

- [x] **Silent failure of edit / delete / react / reply** _(fixed)_ —
      [rooms.page.ts:161-187](../libs/feature-rooms/src/lib/rooms/rooms.page.ts#L161-L187).
      These `.subscribe()` with no error handler and (unlike `send`) no optimistic echo, so
      a failed delete/reaction looks like a no-op. **Fix:** surface errors (Ionic
      `ToastController` / inline).

- [x] **Keyboard & touch accessibility largely absent app-wide** _(fixed)_ — no `:focus-visible`
      on any custom control (the `interactive-row` mixin defines only `:hover`;
      `.composer__input` does `outline: none`), and the message toolbar
      (reply/edit/delete/react) is hover-only with `pointer-events: none`
      ([message-list.component.scss:55-68](../libs/feature-rooms/src/lib/message-list/message-list.component.scss#L55-L68))
      → unreachable on touch (a stated mobile target) and keyboard. **Fix:** add a
      `:focus-visible` baseline (reuse `--trinity-accent`) to the mixin + standalone button
      classes, and a tap/long-press → action-sheet path for message actions.

## 🟡 Medium

- [x] **feature-auth has zero tests** _(fixed: added the Vitest harness + login/sso-callback specs, 9 tests)_ — the riskiest flow (discovery, SSO callback
      handshake, login→persist→init) is the only lib without a test target. Add the Vitest
      triad (`vite.config.ts` + `test-setup.ts` + `tsconfig.spec.json` + test target) and
      cover the discover→flows state machine and the SSO callback completion.
- [x] **Dev `/spike` route + `CryptoSpikeService` ship in production** _(fixed: route gated to non-prod; spike/smoke scripts build `--configuration=development`; `crypto-wasm-loader` dropped from the barrel)_ —
      [app.routes.ts:34](../apps/trinity/src/app/app.routes.ts#L34) (unguarded) and exported
      from the core barrel ([index.ts](../libs/core/src/index.ts)). Gate behind
      `environment.production` (the app already has fileReplacements) or remove now that
      crypto is real; drop the spike service + `crypto-wasm-loader` from the barrel.
- [x] **Missing `type:ui` shared layer** _(fixed: added `@trinity/ui` (avatar, emoji-picker, message-toolbar) + boundary rules `feature→[core,ui]`, `ui→[ui]`; the encryption-banner stays a thin container in feature-rooms and can adopt a dumb `ui` shell when a second consumer appears)_ — `EncryptionBannerComponent` is exiled into
      feature-rooms because feature→feature deps are banned; that's the canary. Before M7
      (device verification) and M8 (media) add more cross-feature UI, extract presentational
      pieces (avatar, emoji-picker, a dumb banner shell) into a `type:ui` lib and split
      container vs presentational components.
- [x] **SSO `loginToken` left in the callback URL** _(fixed: stripped from the URL via Location.replaceState. The native deep-link callback is now wired (Capacitor `appUrlOpen` + system browser + iOS/Android scheme registration) and a single-use `sso_state` nonce is generated at `startSso` and verified on the callback — defending login CSRF / token injection on both web and native. Needs on-device validation for the native round-trip.)_ —
      [sso-callback.page.ts:51](../libs/feature-auth/src/lib/sso-callback/sso-callback.page.ts#L51).
      Strip it on entry (covers the error path) and set a `no-referrer` policy. Separately:
      the native deep-link path (`eu.qwky.trinity://`) needs state/nonce + baseUrl
      verification and App/Universal Links before it's wired (latent login-CSRF/fixation).
- [x] **Crypto IndexedDB store not cleared on logout** _(fixed: logout now calls a new MatrixClientService.reset() that clearStores() the sync + crypto IndexedDB; covered by the new matrix-client.service lifecycle spec)_ —
      [matrix-client.service.ts](../libs/core/src/lib/matrix/matrix-client.service.ts) /
      [auth.service.ts](../libs/core/src/lib/matrix/auth.service.ts). Prior account's key
      material persists on disk; clear it on `logout` (not plain `stop`).
- [x] **`window.confirm` for delete** _(fixed)_ —
      [message-list.component.ts:208](../libs/feature-rooms/src/lib/message-list/message-list.component.ts#L208).
      Use Ionic `AlertController` for theme/consistency (the codebase already does elsewhere).
- [x] **`encryption-setup` focus `effect()` fires on any dependency change** _(fixed)_ —
      [encryption-setup.page.ts:73-77](../libs/feature-crypto/src/lib/encryption-setup/encryption-setup.page.ts#L73-L77).
      Guard to a one-shot so it can't steal focus mid-interaction.
- [x] **vite-tsconfig-paths drift** _(fixed)_ — core's
      [vite.config.ts](../libs/core/vite.config.ts) omits `projects: ['tsconfig.base.json']`
      (correct only by accident today). Make all three configs identical to prevent a silent
      future spec-resolution failure.
- [x] **Access token in `localStorage` on web** _(accepted tradeoff, now contained)_ —
      [session-storage.service.ts:19](../libs/core/src/lib/storage/session-storage.service.ts#L19).
      Inherent Capacitor tradeoff (native uses OS storage). It's only reachable given a
      script-execution flaw, which the explicit message-HTML sanitization + CSP above now
      guard against. Refresh-token / at-rest encryption stay backlog options if the threat
      model warrants — not changed here.

## 🟢 Low / polish

- [x] No `<h1>` / heading hierarchy on login and the active-chat view _(fixed: sr-only
      h1 on login + sso-callback; the room name is a `role="heading"` level-1)_.
- [x] Busy/loading states not announced (`aria-live`) _(fixed: `role="status"` on
      login + crypto busy states, and the timeline announces new incoming messages
      via a polite live region)_.
- [x] Decryption-failure & redacted messages need a clearer, labeled accessible
      treatment _(fixed: bordered container with an accent rule; the text label
      already names the state. Per-message "verify this device" links were
      deliberately **not** added: the persistent `/rooms` encryption banner already
      surfaces that CTA exactly when it helps — `needs-recovery` — whereas a
      `ready`-status decryption failure means missing keys, not an untrusted device,
      so linking to unlock there would mislead.)_.
- [x] `escapeHtml` doesn't escape single quotes _(fixed)_
      ([timeline.service.ts:569](../libs/core/src/lib/matrix/timeline.service.ts#L569)) —
      harmless today (double-quoted attrs) but add for robustness.
- [x] Unlock recovery-key signal not cleared after success _(fixed)_
      ([encryption-unlock.page.ts](../libs/feature-crypto/src/lib/encryption-unlock/encryption-unlock.page.ts)) —
      mirror the setup page.
- [x] Reply-preview connector uses literal `gray`, not a token _(fixed)_
      ([message-list.component.scss:121](../libs/feature-rooms/src/lib/message-list/message-list.component.scss#L121)).
- [x] No `prefers-reduced-motion` handling (smooth-scroll + transitions). _(fixed)_
- [x] No composer send button (Enter-only) — poor mobile discoverability. _(fixed: touch-only send button)_
- [x] `withBusy()` duplicated across login + both crypto pages _(fixed: extracted
      `runWithBusy` into `@trinity/ui`; pages keep a one-line adapter)_.
- [x] Editable-message predicate duplicated in message-list — extracted `isEditable(m)`. _(fixed)_
- [x] ~~No Nx caching on `test` targets~~ _(non-issue: `nx.json` `targetDefaults`
      already caches `test`/`build`/`lint` with inputs — the per-project targets
      inherit it)_.
- [x] Run `pnpm audit` _(done: `pnpm audit --prod` reports no known vulnerabilities)_.

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
